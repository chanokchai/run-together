import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LEGACY_ROOM_ID } from '../src/room-contract.js';
import { addVote } from '../src/domain.js';
import { createServer } from '../src/server.js';
import { removeProfileWithRetry } from './helpers/chromium-profile-cleanup.js';
import { chromiumReadinessTimeoutMs, readDevToolsPort, spawnChromium, stopChromium } from './helpers/chromium-startup.js';

const chromePath = process.env.CHROME_BIN ?? [
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/opt/google/chrome/chrome',
  '/opt/data/tmp/chrome/opt/google/chrome/chrome',
].find((path) => existsSync(path));
if (!chromePath) throw new Error('Issue 9 browser coverage requires real Chromium; refusing to skip.');

const ENV = { ADMIN_NAME: 'Issue 9 Browser Admin', ADMIN_PIN: '4826', PIN_PEPPER: 'synthetic-pepper' };
const NOW = new Date('2026-11-16T00:00:00.000Z');

function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

function createTarget(port) {
  return new Promise((resolve, reject) => {
    const targetRequest = request({ host: '127.0.0.1', port, path: '/json/new?about:blank', method: 'PUT' }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error(`Chrome target creation returned HTTP ${response.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    targetRequest.on('error', reject);
    targetRequest.end();
  });
}

function createCdpClient(url) {
  const socket = new WebSocket(url);
  let nextId = 0;
  const pending = new Map();
  const events = new Map();
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id) {
      (events.get(message.method) ?? []).forEach((listener) => listener(message.params));
      return;
    }
    const state = pending.get(message.id);
    if (!state) return;
    pending.delete(message.id);
    if (message.error) state.reject(new Error(message.error.message));
    else state.resolve(message.result);
  });
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  return {
    async send(method, params = {}) {
      await opened;
      const id = ++nextId;
      const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      socket.send(JSON.stringify({ id, method, params }));
      return result;
    },
    on(method, listener) { events.set(method, [...(events.get(method) ?? []), listener]); },
    close() { socket.close(); },
  };
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.result?.description ?? result.exceptionDetails.text);
  return result.result.value;
}

async function storedSnapshot(client) {
  return evaluate(client, `new Promise((resolve, reject) => {
    const request = indexedDB.open('run-together-offline-v1', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('snapshots')) { database.close(); resolve(null); return; }
      const transaction = database.transaction('snapshots', 'readonly');
      const read = transaction.objectStore('snapshots').get('latest');
      transaction.oncomplete = () => { const snapshot = read.result ?? null; database.close(); resolve(snapshot); };
      transaction.onerror = () => { database.close(); reject(transaction.error); };
    };
  })`);
}

async function waitFor(client, expression, timeoutMs = 15_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      if (await evaluate(client, expression)) return true;
    } catch (error) {
      if (!/Inspected target navigated|execution context|Cannot find context/i.test(error.message)) throw error;
    }
    await delay(50);
  }
  return false;
}

async function connectPage(port) {
  const target = await createTarget(port);
  const client = createCdpClient(target.webSocketDebuggerUrl);
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Network.enable');
  await client.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    window.__nativeFetch = window.fetch.bind(window);
    window.__pwaClearedEvents = 0;
    window.__offlineBlocked = 0;
    window.addEventListener('run-together:snapshot-cleared', () => { window.__pwaClearedEvents += 1; });
    window.addEventListener('run-together:offline-write-blocked', () => { window.__offlineBlocked += 1; });
  })();` });
  return { target, client };
}

async function launchBrowser(profile) {
  const browser = spawnChromium(chromePath, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
    '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank',
  ]);
  const port = await readDevToolsPort(profile, browser, { timeoutMs: chromiumReadinessTimeoutMs });
  const { client } = await connectPage(port);
  return { browser, port, client };
}

async function stopBrowser(instance) {
  if (!instance) return;
  instance.client?.close();
  await stopChromium(instance.browser);
}

async function setOffline(client, offline) {
  await client.send('Network.emulateNetworkConditions', {
    offline,
    latency: 0,
    downloadThroughput: offline ? 0 : -1,
    uploadThroughput: offline ? 0 : -1,
  });
}

async function loginBrowserSession(baseUrl) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { origin: baseUrl, 'content-type': 'application/json' },
    body: JSON.stringify({ name: ENV.ADMIN_NAME, pin: ENV.ADMIN_PIN }),
  });
  assert.equal(response.status, 200, 'synthetic fixture admin login succeeds');
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
  assert.ok(cookie.includes('='), 'fixture login returns a session cookie');
  return cookie;
}

async function seedBrowserSession(baseUrl, server) {
  const cookie = await loginBrowserSession(baseUrl);
  const admin = server.database.prepare("SELECT id FROM users WHERE role = 'admin'").get();
  addVote(server.database, { roomId: LEGACY_ROOM_ID, userId: admin.id, voteDate: '2026-11-17', now: () => NOW });
  return cookie;
}

async function revokeBrowserSession(baseUrl, cookie) {
  const sessionResponse = await fetch(`${baseUrl}/api/session`, { headers: { cookie } });
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json();
  const logoutResponse = await fetch(`${baseUrl}/api/auth/logout`, {
    method: 'POST',
    headers: { cookie, origin: baseUrl, 'x-csrf-token': session.csrfToken },
  });
  assert.equal(logoutResponse.status, 204, 'fixture session is revoked through the supported server logout path');
}

const OFFLINE_MUTATIONS = [
  ['POST', '/api/auth/register'], ['POST', '/api/auth/login'], ['POST', '/api/auth/logout'],
  ['POST', '/api/rooms'], ['POST', `/api/rooms/${LEGACY_ROOM_ID}/enter`],
  ['PUT', `/api/rooms/${LEGACY_ROOM_ID}`], ['DELETE', `/api/rooms/${LEGACY_ROOM_ID}`],
  ['PUT', `/api/rooms/${LEGACY_ROOM_ID}/votes/2026-11-17`],
  ['POST', `/api/rooms/${LEGACY_ROOM_ID}/events/2026-11-18`],
  ['DELETE', `/api/rooms/${LEGACY_ROOM_ID}/events/2026-11-18`],
  ['PUT', `/api/rooms/${LEGACY_ROOM_ID}/admin/events/2026-11-18`],
  ['DELETE', `/api/rooms/${LEGACY_ROOM_ID}/admin/events/2026-11-18`],
  ['DELETE', `/api/rooms/${LEGACY_ROOM_ID}/admin/weeks/2026-11-16/votes`],
  ['PUT', '/api/admin/users/1/pin'], ['DELETE', '/api/admin/users/1/votes'], ['DELETE', '/api/admin/users/1'],
  ['DELETE', '/api/admin/weeks/2026-11-16/votes'], ['POST', '/api/events/2026-11-18'],
  ['DELETE', '/api/events/2026-11-18'], ['PUT', '/api/admin/events/2026-11-18'],
  ['DELETE', '/api/admin/events/2026-11-18'], ['PUT', '/api/votes/2026-11-17'],
  ['PUT', '/api/account/pin'],
];

test('Issue 9 protects private page caches, persists one sanitized week, and remains read-only offline', async (t) => {
  const directory = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'run-together-issue-9-browser-'));
  const profile = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'run-together-issue-9-chrome-'));
  const server = createServer({ databasePath: join(directory, 'preview.sqlite'), env: ENV, now: () => NOW });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const cookie = await seedBrowserSession(baseUrl, server);
  let instance;
  let secondPage;
  t.after(async () => {
    secondPage?.client.close();
    await stopBrowser(instance);
    await removeProfileWithRetry(profile);
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.database.close();
    await rm(directory, { recursive: true, force: true });
  });

  instance = await launchBrowser(profile);
  const { client } = instance;
  const [cookieName, ...cookieValue] = cookie.split('=');
  const cookieResult = await client.send('Network.setCookie', {
    url: baseUrl,
    name: cookieName,
    value: cookieValue.join('='),
    path: '/',
  });
  assert.equal(cookieResult.success, true, 'browser receives only the isolated test session');
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await client.send('Page.navigate', { url: `${baseUrl}/vote/${LEGACY_ROOM_ID}` });
  assert.equal(await waitFor(client, `Boolean(document.querySelector('#protected-content') && !document.querySelector('#protected-content').hidden && navigator.serviceWorker?.controller && window.runTogetherPwa)`), true,
    'authenticated page becomes visible only after session checks and the service worker controls it');
  assert.equal(await waitFor(client, `window.runTogetherPwa?.getLatestSnapshot().then(Boolean)`), true,
    'a sanitized latest-week snapshot is stored after authoritative room and week reads');

  const browserProof = await evaluate(client, `(async () => {
    const registration = await navigator.serviceWorker.ready;
    const snapshot = await window.runTogetherPwa.getLatestSnapshot();
    const names = await caches.keys();
    const keys = [];
    for (const name of names) for (const request of await (await caches.open(name)).keys()) keys.push(new URL(request.url).pathname + new URL(request.url).search);
    const databases = await indexedDB.databases();
    const cachedProtectedPage = keys.some((key) => key.startsWith('/vote/') || key.startsWith('/api/'));
    const stores = await new Promise((resolve, reject) => {
      const request = indexedDB.open('run-together-offline-v1', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction(['state', 'snapshots'], 'readonly');
        const stateRequest = transaction.objectStore('state').get('control');
        const snapshotRequest = transaction.objectStore('snapshots').get('latest');
        transaction.oncomplete = () => { const result = { state: stateRequest.result, snapshot: snapshotRequest.result, storeNames: [...database.objectStoreNames] }; database.close(); resolve(result); };
        transaction.onerror = () => reject(transaction.error);
      };
    });
    return {
      secureContext: isSecureContext,
      controller: Boolean(navigator.serviceWorker.controller),
      workerState: registration.active?.state,
      manifest: document.querySelector('link[rel=manifest]')?.href ?? null,
      snapshot,
      state: stores.state,
      storedSnapshot: stores.snapshot,
      stores: stores.storeNames,
      databases: databases.map((database) => database.name),
      cacheNames: names,
      cacheKeys: keys,
      cachedProtectedPage,
      localStorage: Object.keys(localStorage),
      sensitiveText: JSON.stringify(stores).includes('csrfToken') || JSON.stringify(stores).includes('pin_hash'),
    };
  })()`);
  assert.equal(browserProof.secureContext, true, 'loopback HTTPS-secure context policy is applied by Chromium');
  assert.equal(browserProof.workerState, 'activated');
  assert.match(browserProof.manifest, /\/manifest\.webmanifest$/);
  assert.equal(browserProof.snapshot.room.id, LEGACY_ROOM_ID);
  assert.equal(browserProof.snapshot.days.find((day) => day.date === '2026-11-17').voterNames[0], ENV.ADMIN_NAME);
  assert.deepEqual(Object.keys(browserProof.snapshot).sort(), ['days', 'events', 'room', 'savedAt', 'schemaVersion', 'week']);
  assert.deepEqual(Object.keys(browserProof.snapshot.room).sort(), ['displayNumber', 'id', 'time', 'title', 'venue']);
  assert.deepEqual(Object.keys(browserProof.snapshot.days[0]).sort(), ['date', 'voteCount', 'voterNames']);
  assert.deepEqual(browserProof.stores, ['snapshots', 'state']);
  assert.deepEqual(browserProof.localStorage, [], 'persistent application data is not duplicated in localStorage');
  assert.equal(browserProof.sensitiveText, false, 'the stored projection has no CSRF or PIN hash fields');
  assert.equal(browserProof.cachedProtectedPage, false, 'protected HTML and API responses are absent from CacheStorage');
  assert.deepEqual(browserProof.cacheKeys.sort(), [
    '/icons/run-together-192.png', '/icons/run-together-512.png', '/manifest.webmanifest',
    '/offline', '/offline.css?v=issue-9-pwa-2', '/offline.js?v=issue-9-pwa-2', '/pwa-client.js?v=issue-9-pwa-2',
  ].sort(), 'CacheStorage contains only the versioned, credential-free shell assets');

  secondPage = await connectPage(instance.port);
  await secondPage.client.send('Page.navigate', { url: `${baseUrl}/vote/${LEGACY_ROOM_ID}` });
  assert.equal(await waitFor(secondPage.client, `Boolean(document.querySelector('#protected-content') && !document.querySelector('#protected-content').hidden && navigator.serviceWorker?.controller)`), true,
    'a second authenticated tab shares the same sanitized room scope');
  const staleTabSnapshot = await evaluate(secondPage.client, 'window.runTogetherPwa.getLatestSnapshot()');
  const staleTabGeneration = await evaluate(secondPage.client, 'window.runTogetherPwa.generation()');
  await evaluate(client, `window.runTogetherPwa.clearSnapshot('cross-tab-race-test')`);
  assert.equal(await waitFor(secondPage.client, `window.runTogetherPwa?.getLatestSnapshot().then((snapshot) => snapshot === null)`), true,
    'cross-tab clearing invalidates the shared latest snapshot');
  assert.ok(await evaluate(secondPage.client, 'window.__pwaClearedEvents') > 0,
    'the other tab receives an invalidation notification');
  const staleTabSave = await evaluate(secondPage.client,
    `window.runTogetherPwa.saveSnapshot(${JSON.stringify(staleTabSnapshot)}, ${staleTabGeneration})`);
  assert.equal(staleTabSave, false, 'an old in-flight write cannot repopulate data after a cross-tab clear');
  await client.send('Page.navigate', { url: `${baseUrl}/vote/${LEGACY_ROOM_ID}` });
  assert.equal(await waitFor(client, `window.runTogetherPwa?.getLatestSnapshot().then(Boolean)`), true,
    'a newly authenticated authoritative load creates a fresh generation-bound snapshot');
  await evaluate(client, `document.querySelector('#back-to-rooms').click()`);
  assert.equal(await waitFor(client, `document.querySelector('#rooms-content') && !document.querySelector('#rooms-content').hidden && window.runTogetherPwa?.getLatestSnapshot().then((snapshot) => snapshot === null)`), true,
    'leaving the room clears the room-scoped snapshot before the rooms page is shown');
  await client.send('Page.navigate', { url: `${baseUrl}/vote/${LEGACY_ROOM_ID}` });
  assert.equal(await waitFor(client, `window.runTogetherPwa?.getLatestSnapshot().then(Boolean)`), true);
  await client.send('Page.navigate', { url: `${baseUrl}/register` });
  assert.equal(await waitFor(client, `document.querySelector('#register-form') && window.runTogetherPwa?.getLatestSnapshot().then((snapshot) => snapshot === null)`), true,
    'opening registration clears a prior account snapshot before identity changes');
  await client.send('Page.navigate', { url: `${baseUrl}/vote/${LEGACY_ROOM_ID}` });
  assert.equal(await waitFor(client, `window.runTogetherPwa?.getLatestSnapshot().then(Boolean)`), true);
  await setOffline(client, true);
  const savedBeforeInterruptedLaunch = await evaluate(client, 'window.runTogetherPwa.getLatestSnapshot()');
  await client.send('Page.navigate', { url: `${baseUrl}/rooms` });
  assert.equal(await waitFor(client, `document.documentElement?.dataset.offlineShell === 'true' && location.pathname === '/rooms' && document.querySelector('#saved-week') && !document.querySelector('#saved-week').hidden && document.querySelector('#no-saved-week').hidden`), true,
    'an offline fallback for the installed app route shows the saved same-device week');
  assert.deepEqual(await storedSnapshot(client), savedBeforeInterruptedLaunch,
    'an unscoped offline fallback preserves the existing same-device snapshot for a later room-scoped open');
  await client.send('Page.navigate', { url: `${baseUrl}/vote/${LEGACY_ROOM_ID}` });
  assert.equal(await waitFor(client, `document.documentElement?.dataset.offlineShell === 'true' && document.querySelector('#saved-week') && !document.querySelector('#saved-week').hidden`), true,
    'the preserved snapshot remains available from its matching room route after an interrupted app launch');
  await setOffline(client, false);
  assert.equal(await waitFor(client, 'navigator.onLine === true'), true);

  await secondPage.client.send('Page.navigate', { url: 'about:blank' });
  secondPage.client.close();
  secondPage = null;

  const manifest = await client.send('Page.getAppManifest');
  assert.equal(manifest.errors?.length ?? 0, 0, 'Chromium reports no web app manifest parse/installability errors');
  assert.equal(JSON.parse(manifest.data).display, 'standalone');
  assert.equal(await evaluate(client, `matchMedia('(display-mode: standalone)').matches`), false,
    'regular browser mode is distinguished from installed/standalone mode in this automated profile');

  await setOffline(client, true);
  assert.equal(await waitFor(client, `navigator.onLine === false`), true, 'Chromium enters actual offline network emulation');
  await client.send('Page.navigate', { url: `${baseUrl}/vote/${LEGACY_ROOM_ID}` });
  const offlineReady = await waitFor(client, `document.documentElement?.dataset.offlineShell === 'true' && document.querySelector('#saved-week') && !document.querySelector('#saved-week').hidden`, 2500);
  if (!offlineReady) t.diagnostic(`Offline navigation state: ${JSON.stringify(await evaluate(client, `(async () => ({url: location.href, path: location.pathname, search: location.search, online: navigator.onLine, controller: Boolean(navigator.serviceWorker?.controller), shell: document.documentElement?.dataset.offlineShell ?? null, snapshot: await window.runTogetherPwa?.getLatestSnapshot(), clearEvents: window.__pwaClearedEvents, savedHidden: document.querySelector('#saved-week')?.hidden, emptyHidden: document.querySelector('#no-saved-week')?.hidden, scripts: [...document.scripts].map((script) => script.src), text: document.body?.textContent?.slice(0, 500) ?? null}))()`))}`);
  assert.equal(offlineReady, true,
    'a regular offline reopen is served by the cached shell and shows only the matching saved room/week');
  const offlineView = await evaluate(client, `({
    text: document.body.textContent,
    title: document.querySelector('#saved-week-heading').textContent,
    status: document.querySelector('#offline-status').textContent,
    noAuthClaim: document.querySelector('#offline-identity-note').textContent,
    returnHref: document.querySelector('#return-to-room').getAttribute('href'),
  })`);
  assert.match(offlineView.status, /Offline.*read-only/i);
  assert.match(offlineView.status, /stale/i);
  assert.match(offlineView.noAuthClaim, /does not confirm/i);
  assert.match(offlineView.title, /Room 01/);
  assert.match(offlineView.text, new RegExp(ENV.ADMIN_NAME));
  assert.equal(offlineView.returnHref, `/vote/${LEGACY_ROOM_ID}`);

  const browserWritesBefore = server.database.prepare('SELECT COUNT(*) AS count FROM votes').get().count;
  const networkRequests = [];
  client.on('Network.requestWillBeSent', ({ request }) => {
    const parsed = new URL(request.url);
    if (parsed.pathname.startsWith('/api/')) networkRequests.push({ method: request.method, path: parsed.pathname });
  });
  const blockedMutations = await evaluate(client, `(async () => {
    const attempts = ${JSON.stringify(OFFLINE_MUTATIONS)};
    const results = await Promise.all(attempts.map(([method, path]) => window.fetch(path, {
      method,
      headers: { 'content-type': 'application/json', 'x-csrf-token': 'synthetic-test-only' },
      body: method === 'DELETE' ? undefined : JSON.stringify({ test: true }),
    }).then(() => ({ blocked: false }), (error) => ({ blocked: error.name === 'OfflineMutationBlockedError', name: error.name }))));
    return { results, blockedEvents: window.__offlineBlocked ?? 0 };
  })()`);
  assert.equal(blockedMutations.results.length, OFFLINE_MUTATIONS.length);
  assert.ok(blockedMutations.results.every((result) => result.blocked && result.name === 'OfflineMutationBlockedError'),
    'every auth, account, room, vote, event and admin API write is rejected by the browser guard');
  assert.equal(blockedMutations.blockedEvents, OFFLINE_MUTATIONS.length, 'the UI-visible offline blocker records each rejected write');
  assert.equal(networkRequests.length, 0, 'blocked writes produce zero API network requests');
  assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM votes').get().count, browserWritesBefore,
    'no offline write reaches the server database');

  const workerGuard = await evaluate(client, `(async () => {
    const response = await window.__nativeFetch('/api/votes/2026-11-18', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ test: true }),
    });
    return { status: response.status, body: await response.json() };
  })()`);
  assert.equal(workerGuard.status, 503, 'the service worker independently rejects a native-fetch mutation offline');
  assert.equal(workerGuard.body.code, 'OFFLINE_READ_ONLY');
  assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM votes').get().count, browserWritesBefore,
    'the service-worker rejection also leaves persistent application data unchanged');

  const beforeClearEvents = await evaluate(client, 'window.__pwaClearedEvents');
  await evaluate(client, `document.querySelector('#clear-offline-data').click()`);
  assert.equal(await waitFor(client, `window.runTogetherPwa?.getLatestSnapshot().then((snapshot) => snapshot === null)`), true,
    'the offline clear button removes the one current snapshot');
  await delay(350);
  const afterClearEvents = await evaluate(client, 'window.__pwaClearedEvents');
  assert.ok(afterClearEvents - beforeClearEvents < 20, 'cross-tab/worker invalidation messages do not echo indefinitely');
  assert.match(await evaluate(client, `document.querySelector('#offline-message').textContent`), /did not sign you out/i);

  await client.send('Page.navigate', { url: `${baseUrl}/offline?scope=none` });
  assert.equal(await waitFor(client, `document.documentElement?.dataset.offlineShell === 'true' && document.querySelector('#no-saved-week') && !document.querySelector('#no-saved-week').hidden`), true,
    'first offline launch without any saved snapshot shows a safe empty state');
  assert.equal(await evaluate(client, `document.querySelector('#return-to-room').hidden`), true,
    'the empty state cannot link into a room whose local snapshot was cleared');
  assert.equal(await evaluate(client, `navigator.serviceWorker.controller?.state === 'activated'`), true);

  await setOffline(client, false);
  assert.equal(await waitFor(client, `navigator.onLine === true`), true, 'Chromium returns to online state');
  await client.send('Page.navigate', { url: `${baseUrl}/vote/${LEGACY_ROOM_ID}` });
  const successfulReconnect = await waitFor(client, `document.querySelector('#protected-content') && !document.querySelector('#protected-content').hidden && window.runTogetherPwa?.getLatestSnapshot().then(Boolean)`);
  if (!successfulReconnect) t.diagnostic(`Successful reconnect state: ${JSON.stringify(await evaluate(client, `(async () => ({url: location.href, online: navigator.onLine, controller: Boolean(navigator.serviceWorker?.controller), shell: document.documentElement?.dataset.offlineShell ?? null, protectedVisible: Boolean(document.querySelector('#protected-content') && !document.querySelector('#protected-content').hidden), snapshot: await window.runTogetherPwa?.getLatestSnapshot(), text: document.body?.textContent?.slice(0, 500) ?? null}))()`))}`);
  assert.equal(successfulReconnect, true,
    'reconnection restores controls only after fresh session, room and week requests succeed');
  await client.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 760, deviceScaleFactor: 2, mobile: true });
  const mobileLayout = await evaluate(client, `({width: innerWidth, scrollWidth: document.documentElement.scrollWidth, standalone: matchMedia('(display-mode: standalone)').matches})`);
  assert.ok(mobileLayout.scrollWidth <= mobileLayout.width, 'the active Chromium mobile viewport has no horizontal overflow');
  assert.equal(mobileLayout.standalone, false, 'mobile viewport emulation is not misreported as an installed PWA');
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  await evaluate(client, `document.querySelector('#vote-profile-menu .profile-menu__trigger').click()`);
  await evaluate(client, `document.querySelector('#vote-profile-menu .profile-menu__logout').click()`);
  assert.equal(await waitFor(client, `location.pathname === '/' && document.querySelector('#login-form')`), true,
    'the normal logout action returns to the login form');
  assert.equal(await waitFor(client, `window.runTogetherPwa?.getLatestSnapshot().then((snapshot) => snapshot === null)`), true,
    'normal Logout clears the offline snapshot');
  const logoutStatus = await evaluate(client, `window.fetch('/api/session', {cache:'no-store'}).then((response) => response.status)`);
  assert.equal(logoutStatus, 401, 'normal Logout revokes the server session instead of only clearing local data');
  const navigation = await client.send('Page.getNavigationHistory');
  const priorRoomPage = navigation.entries.slice(0, navigation.currentIndex).reverse()
    .find((entry) => new URL(entry.url).pathname.startsWith('/vote/'));
  assert.ok(priorRoomPage, 'history contains a prior protected room route');
  await client.send('Page.navigateToHistoryEntry', { entryId: priorRoomPage.id });
  await delay(500);
  const backNavigationState = await evaluate(client, `(async () => ({path: location.pathname, protectedVisible: Boolean(document.querySelector('#protected-content') && !document.querySelector('#protected-content').hidden), snapshotPresent: Boolean(await window.runTogetherPwa?.getLatestSnapshot())}))()`);
  assert.equal(backNavigationState.protectedVisible, false, 'history/BFCache does not restore protected content after Logout');
  assert.equal(backNavigationState.snapshotPresent, false, 'history navigation does not restore a cleared local snapshot');

  const renewedCookie = await loginBrowserSession(baseUrl);
  const [renewedCookieName, ...renewedCookieValue] = renewedCookie.split('=');
  const renewedCookieResult = await client.send('Network.setCookie', {
    url: baseUrl,
    name: renewedCookieName,
    value: renewedCookieValue.join('='),
    path: '/',
  });
  assert.equal(renewedCookieResult.success, true);
  await client.send('Page.navigate', { url: `${baseUrl}/vote/${LEGACY_ROOM_ID}` });
  assert.equal(await waitFor(client, `document.querySelector('#protected-content') && !document.querySelector('#protected-content').hidden && window.runTogetherPwa?.getLatestSnapshot().then(Boolean)`), true,
    'a fresh test session stores a new authorized snapshot');
  await setOffline(client, true);
  await client.send('Page.navigate', { url: `${baseUrl}/vote/${LEGACY_ROOM_ID}` });
  assert.equal(await waitFor(client, `document.documentElement?.dataset.offlineShell === 'true' && document.querySelector('#saved-week') && !document.querySelector('#saved-week').hidden`), true,
    'the saved view is available again before reconnect authorization is revoked');
  await revokeBrowserSession(baseUrl, renewedCookie);
  await setOffline(client, false);
  assert.equal(await waitFor(client, `navigator.onLine === true`), true, 'Chromium returns to online state');
  await client.send('Page.navigate', { url: `${baseUrl}/vote/${LEGACY_ROOM_ID}` });
  const failedReconnect = await waitFor(client, `location.pathname === '/vote/${LEGACY_ROOM_ID}' && document.body?.textContent.includes('UNAUTHENTICATED')`);
  if (!failedReconnect) t.diagnostic(`Failed reconnect state: ${JSON.stringify(await evaluate(client, `(async () => ({url: location.href, online: navigator.onLine, controller: Boolean(navigator.serviceWorker?.controller), shell: document.documentElement?.dataset.offlineShell ?? null, protectedVisible: Boolean(document.querySelector('#protected-content') && !document.querySelector('#protected-content').hidden), snapshot: await window.runTogetherPwa?.getLatestSnapshot(), text: document.body?.textContent?.slice(0, 500) ?? null}))()`))}`);
  assert.equal(failedReconnect, true,
    'failed reauthorization returns an unauthorized response and never reveals the stale protected room');
  assert.equal(await storedSnapshot(client), null, 'authorization loss purges the saved snapshot');
  assert.equal(await evaluate(client, `Boolean(document.querySelector('#protected-content') && !document.querySelector('#protected-content').hidden)`), false,
    'the protected room remains hidden after failed reconnect');
  const unauthorizedStatus = await evaluate(client, `window.fetch('/api/session', {cache:'no-store'}).then((response) => response.status)`);
  assert.equal(unauthorizedStatus, 401, 'an online HTTP 401 is handled as authorization loss, not as a network failure');
  assert.equal(await storedSnapshot(client), null);

  const cacheUpgrade = await evaluate(client, `(async () => {
    const obsolete = await caches.open('run-together-pwa-shell-obsolete');
    await obsolete.put(new Request(location.origin + '/obsolete-shell'), new Response('old shell fixture'));
    await navigator.serviceWorker.register('/sw.js?upgrade=issue-9-test', { scope: '/', updateViaCache: 'none' });
    return true;
  })()`);
  assert.equal(cacheUpgrade, true);
  assert.equal(await waitFor(client, `navigator.serviceWorker.getRegistration().then(async (registration) => registration?.active?.scriptURL.includes('upgrade=issue-9-test') && registration.active.state === 'activated' && !(await caches.keys()).includes('run-together-pwa-shell-obsolete'))`), true,
    'a new service-worker script URL installs, activates and removes obsolete shell caches');
  const postUpgrade = await evaluate(client, `(async () => {
    const registration = await navigator.serviceWorker.ready;
    return {
      caches: await caches.keys(),
      controllerState: navigator.serviceWorker.controller?.state,
      queuedSyncTags: await (registration.sync?.getTags?.() ?? []),
    };
  })()`);
  assert.equal(postUpgrade.caches.includes('run-together-pwa-shell-obsolete'), false, 'worker activation removes obsolete shell caches');
  assert.equal(await storedSnapshot(client), null, 'worker upgrade does not resurrect a cleared snapshot');
  assert.deepEqual(await postUpgrade.queuedSyncTags, [], 'no background sync or queued mutation is registered');
});

test('Issue 9 restores the saved week after a browser restart at the install start URL when the server is unreachable', async (t) => {
  const directory = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'run-together-issue-9-restart-'));
  const profile = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'run-together-issue-9-restart-chrome-'));
  const server = createServer({ databasePath: join(directory, 'preview.sqlite'), env: ENV, now: () => NOW });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const cookie = await seedBrowserSession(baseUrl, server);
  let instance;
  t.after(async () => {
    await stopBrowser(instance);
    await removeProfileWithRetry(profile);
    if (server.listening) {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    server.database.close();
    await rm(directory, { recursive: true, force: true });
  });

  instance = await launchBrowser(profile);
  const firstClient = instance.client;
  const [cookieName, ...cookieValue] = cookie.split('=');
  const cookieResult = await firstClient.send('Network.setCookie', {
    url: baseUrl,
    name: cookieName,
    value: cookieValue.join('='),
    path: '/',
  });
  assert.equal(cookieResult.success, true);
  await firstClient.send('Page.navigate', { url: `${baseUrl}/vote/${LEGACY_ROOM_ID}` });
  assert.equal(await waitFor(firstClient, `Boolean(document.querySelector('#protected-content') && !document.querySelector('#protected-content').hidden && navigator.serviceWorker?.controller && window.runTogetherPwa)`), true,
    'the authenticated room is loaded under the active service worker');
  assert.equal(await waitFor(firstClient, 'window.runTogetherPwa?.getLatestSnapshot().then(Boolean)'), true,
    'the same-room sanitized week has been saved before closing the browser');
  const savedBeforeRestart = await evaluate(firstClient, 'window.runTogetherPwa.getLatestSnapshot()');
  assert.equal(savedBeforeRestart.room.id, LEGACY_ROOM_ID);

  await stopBrowser(instance);
  instance = null;
  await rm(join(profile, 'DevToolsActivePort'), { force: true });
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

  instance = await launchBrowser(profile);
  const reopenedClient = instance.client;
  await reopenedClient.send('Page.navigate', { url: `${baseUrl}/` });
  assert.equal(await waitFor(reopenedClient, 'navigator.onLine === true'), true,
    'the browser reports online even though this app server is unavailable');
  assert.equal(await waitFor(reopenedClient, `document.documentElement?.dataset.offlineShell === 'true' && location.pathname === '/' && document.querySelector('#saved-week') && !document.querySelector('#saved-week').hidden`), true,
    'the manifest start URL falls back to the cached read-only shell after a normal browser restart');
  const reopenedSnapshot = await evaluate(reopenedClient, `(async () => ({
    snapshot: await window.runTogetherPwa.getLatestSnapshot(),
    title: document.querySelector('#saved-week-heading').textContent,
    status: document.querySelector('#offline-status').textContent,
    noAuthClaim: document.querySelector('#offline-identity-note').textContent,
  }))()`);
  assert.deepEqual(reopenedSnapshot.snapshot, savedBeforeRestart,
    'the same sanitized room/week persists in IndexedDB across browser process restart');
  assert.match(reopenedSnapshot.title, /Room 01/);
  assert.match(reopenedSnapshot.status, /read-only/);
  assert.match(reopenedSnapshot.noAuthClaim, /does not confirm/i);
  await reopenedClient.send('Page.navigate', { url: `${baseUrl}/rooms` });
  assert.equal(await waitFor(reopenedClient, `document.documentElement?.dataset.offlineShell === 'true' && location.pathname === '/rooms' && document.querySelector('#saved-week') && !document.querySelector('#saved-week').hidden`), true,
    'a failed protected-route fetch also shows the saved week while navigator.onLine remains true');
  assert.equal(await evaluate(reopenedClient, 'navigator.onLine'), true,
    'the app-server network failure does not change the browser online flag');
  assert.deepEqual(await storedSnapshot(reopenedClient), savedBeforeRestart,
    'the same scoped week remains stored after the unscoped route fallback');
  await reopenedClient.send('Page.navigate', { url: `${baseUrl}/vote/00000000-0000-4000-8000-000000000010` });
  assert.equal(await waitFor(reopenedClient, `document.documentElement?.dataset.offlineShell === 'true' && document.querySelector('#no-saved-week') && !document.querySelector('#no-saved-week').hidden && document.querySelector('#saved-week').hidden`), true,
    'the offline fallback does not show Room 01 data for a different room route');
  assert.deepEqual(await storedSnapshot(reopenedClient), savedBeforeRestart,
    'a mismatched room fallback hides but does not erase the Room 01 snapshot');
});
