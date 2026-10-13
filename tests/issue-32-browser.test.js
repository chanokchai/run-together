import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { once } from 'node:events';
import test from 'node:test';
import { createServer } from '../src/server.js';
import { removeProfileWithRetry } from './helpers/chromium-profile-cleanup.js';
import { chromiumReadinessTimeoutMs, readDevToolsPort, spawnChromium, stopChromium } from './helpers/chromium-startup.js';

const chromePath = process.env.CHROME_BIN ?? [
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/opt/google/chrome/chrome',
  '/opt/data/tmp/chrome/opt/google/chrome/chrome',
].find((path) => existsSync(path));
const now = () => new Date('2024-02-29T04:00:00.000Z');
const env = { ADMIN_NAME: 'Synthetic Admin', ADMIN_PIN: '4826', PIN_PEPPER: 'synthetic-pepper' };

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

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
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id) return;
    const requestState = pending.get(message.id);
    if (!requestState) return;
    pending.delete(message.id);
    if (message.error) requestState.reject(new Error(message.error.message));
    else requestState.resolve(message.result);
  });
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  return {
    socket,
    async send(method, params = {}) {
      await opened;
      const id = ++nextId;
      const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      socket.send(JSON.stringify({ id, method, params }));
      return result;
    },
    close() { socket.close(); },
  };
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

async function registerMember(baseUrl, name) {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ name, pin: '0042', pinConfirmation: '0042' }),
  });
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
  const session = await fetch(`${baseUrl}/api/session`, { headers: { cookie } }).then((result) => result.json());
  return { response, cookie, csrfToken: session.csrfToken };
}

async function loginAdmin(baseUrl) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ name: env.ADMIN_NAME, pin: env.ADMIN_PIN }),
  });
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
  const session = await fetch(`${baseUrl}/api/session`, { headers: { cookie } }).then((result) => result.json());
  return { response, cookie, csrfToken: session.csrfToken };
}

async function setVote(baseUrl, member, date) {
  const response = await fetch(`${baseUrl}/api/votes/${date}`, {
    method: 'PUT',
    headers: { cookie: member.cookie, origin: baseUrl, 'content-type': 'application/json', 'x-csrf-token': member.csrfToken },
    body: JSON.stringify({ selected: true }),
  });
  assert.equal(response.status, 200);
}

async function propose(baseUrl, member, date, index) {
  const response = await fetch(`${baseUrl}/api/events/${date}`, {
    method: 'POST',
    headers: { cookie: member.cookie, origin: baseUrl, 'content-type': 'application/json', 'x-csrf-token': member.csrfToken },
    body: JSON.stringify({ requestId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}` }),
  });
  assert.equal(response.status, 201);
}

async function waitFor(client, expression) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await evaluate(client, expression)) return true;
    await delay(50);
  }
  return false;
}

async function pressEnter(client) {
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
}

async function beginSwipe(client, selector, deltaX, deltaY = 0) {
  const point = await evaluate(client, `(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    target.scrollIntoView({ block: 'center' });
    const box = target.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  })()`);
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: point.x, y: point.y, radiusX: 1, radiusY: 1, force: 1 }] });
  await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, x: point.x + deltaX, y: point.y + deltaY, radiusX: 1, radiusY: 1, force: 1 }] });
}

async function endSwipe(client) {
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function cancelSwipe(client) {
  await client.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
}

async function swipe(client, selector, deltaX, deltaY = 0) {
  await beginSwipe(client, selector, deltaX, deltaY);
  await endSwipe(client);
}

test('Issue 32 vote page renders stacked event banners and remains keyboard/mobile usable', {
  skip: chromePath ? false : 'Chromium is unavailable; set CHROME_BIN to run Issue 32 browser coverage',
}, async (t) => {
  const directory = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'run-together-issue-32-browser-'));
  const server = createServer({ databasePath: join(directory, 'preview.sqlite'), env, now });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let client;
  let browser;
  let profile;
  t.after(async () => {
    client?.close();
    try {
      if (browser) await stopChromium(browser);
    } finally {
      if (profile) await removeProfileWithRetry(profile);
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  const runner = await registerMember(baseUrl, 'Issue 32 Browser Runner');
  assert.equal(runner.response.status, 201);
  for (const date of ['2024-02-29', '2024-03-01', '2024-03-03']) await setVote(baseUrl, runner, date);
  await propose(baseUrl, runner, '2024-03-01', 1);
  await propose(baseUrl, runner, '2024-03-03', 2);
  for (const name of [
    'LongRunnerAlpha98765432101234567890',
    'LongRunnerBravo98765432101234567890',
    'LongRunnerCharlie987654321012345678',
  ]) {
    const member = await registerMember(baseUrl, name);
    assert.equal(member.response.status, 201);
    await setVote(baseUrl, member, '2024-03-01');
  }
  const admin = await loginAdmin(baseUrl);
  assert.equal(admin.response.status, 200);

  profile = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'run-together-issue-32-chrome-'));
  const startedAt = performance.now();
  browser = spawnChromium(chromePath, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ]);

  const port = await readDevToolsPort(profile, browser, { timeoutMs: chromiumReadinessTimeoutMs });
  t.diagnostic(`Chromium startup ${(performance.now() - startedAt).toFixed(1)}ms; executable ${browser.spawnfile}; deadline ${chromiumReadinessTimeoutMs}ms.`);
  const target = await createTarget(port);
  client = createCdpClient(target.webSocketDebuggerUrl);
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Network.enable');
  const [cookieName, cookieValue] = runner.cookie.split('=', 2);
  await client.send('Network.setCookie', { url: baseUrl, name: cookieName, value: cookieValue, path: '/' });
  await client.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 844, deviceScaleFactor: 1, mobile: true });
  await client.send('Page.navigate', { url: `${baseUrl}/vote` });

  let pageReady = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    pageReady = await evaluate(client, `Boolean(document.querySelector('#protected-content') && !document.querySelector('#protected-content').hidden && document.querySelectorAll('#week-days .vote-card').length === 7)`);
    if (pageReady) break;
    await delay(50);
  }
  assert.equal(pageReady, true, 'opens the authenticated vote board and renders all seven dates');

  const narrow = await evaluate(client, `(() => ({
    viewportWidth: innerWidth,
    pageWidth: document.documentElement.scrollWidth,
    bannerList: Boolean(document.querySelector('#run-events')),
    dates: [...document.querySelectorAll('.run-event-banner')].map((banner) => banner.dataset.date),
    labels: [...document.querySelectorAll('.run-event-banner__status')].map((status) => status.textContent),
    proposalAction: document.querySelector('.run-event-day-action[aria-label*="29 Feb"]')?.getAttribute('aria-label') ?? null,
    voterLines: (() => { const names = document.querySelector('.run-event-banner[data-date="2024-03-01"] .run-event-banner__voters'); if (!names) return 0; const range = document.createRange(); range.selectNodeContents(names); return range.getClientRects().length; })(),
    eventText: document.querySelector('.run-event-banner[data-date="2024-03-01"]')?.textContent ?? '',
    adminActions: document.querySelectorAll('.run-event-actions').length,
  }))()`);
  assert.equal(narrow.bannerList, true, 'renders the event banner list above the date board');
  assert.deepEqual(narrow.dates, ['2024-03-01', '2024-03-03'], 'sorts current-week banners by date');
  assert.deepEqual(narrow.labels, ['Proposed', 'Proposed'], 'shows visible status text on each proposal');
  assert.match(narrow.proposalAction ?? '', /Propose run/i, 'offers a keyboard-accessible proposal action for a selected date');
  assert.ok(narrow.voterLines >= 2, 'wraps the long live voter list into readable lines');
  assert.match(narrow.eventText, /Fri, 1 Mar/);
  assert.match(narrow.eventText, /Proposed/);
  assert.match(narrow.eventText, /4 votes/);
  assert.match(narrow.eventText, /LongRunnerAlpha/);
  assert.equal(narrow.adminActions, 0, 'does not expose banner controls to ordinary members');
  assert.ok(narrow.pageWidth <= 320, 'keeps the stacked banner layout inside a 320px viewport');

  await beginSwipe(client, '.vote-card[data-date="2024-02-29"]', 24);
  assert.equal(await evaluate(client, `document.querySelector('.vote-card[data-date="2024-02-29"] .vote-card__swipe-cue')?.textContent`), 'Swipe right to propose', 'shows the proposal action while the drag is still below its commit distance');
  await cancelSwipe(client);
  assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM votes WHERE vote_date = ?').get('2024-02-29').count, 1, 'cancelling a below-threshold preview preserves the existing vote');
  assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM run_events WHERE event_date = ?').get('2024-02-29').count, 0, 'cancelling a below-threshold preview does not propose an event');

  await swipe(client, '.vote-card[data-date="2024-02-29"]', 0, -110);
  assert.equal(await evaluate(client, `getComputedStyle(document.querySelector('.vote-card[data-date="2024-02-29"]')).touchAction`), 'pan-y', 'leaves vertical touch gestures to native page scrolling');
  assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM votes WHERE vote_date = ?').get('2024-02-29').count, 1, 'vertical scrolling does not alter a date vote');

  await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  const regular = await evaluate(client, `({ viewportWidth: innerWidth, pageWidth: document.documentElement.scrollWidth, banners: [...document.querySelectorAll('.run-event-banner')].map((banner) => { const box = banner.getBoundingClientRect(); return { left: box.left, right: box.right, width: box.width }; }) })`);
  assert.ok(regular.pageWidth <= 390, 'keeps the stacked banner layout inside a 390px viewport');
  assert.ok(regular.banners.every(({ left, right }) => left >= 0 && right <= 390), 'keeps every event banner within the viewport');

  await evaluate(client, `document.querySelector('#previous-week').click()`);
  assert.equal(await waitFor(client, `document.querySelector('#week-range').textContent === '2024-02-19 – 2024-02-25'`), true, 'week navigation loads the selected earlier week');
  assert.equal(await evaluate(client, `document.querySelectorAll('.run-event-banner').length`), 0, 'does not show events from another week');
  await evaluate(client, `document.querySelector('#current-week').click()`);
  assert.equal(await waitFor(client, `document.querySelector('#week-range').textContent === '2024-02-26 – 2024-03-03'`), true, 'returns to the current selected week');
  assert.equal(await waitFor(client, `document.querySelectorAll('.run-event-banner').length === 2`), true, 'authoritatively restores the current week event banners');

  await client.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await delay(150);
  const disconnectedEvent = server.database.prepare('SELECT id, revision FROM run_events WHERE event_date = ?').get('2024-03-03');
  const disconnectedChange = await fetch(`${baseUrl}/api/admin/events/2024-03-03`, {
    method: 'PUT',
    headers: { cookie: admin.cookie, origin: baseUrl, 'content-type': 'application/json', 'x-csrf-token': admin.csrfToken },
    body: JSON.stringify({ eventId: disconnectedEvent.id, revision: disconnectedEvent.revision, requestId: '00000000-0000-4000-8000-000000000070', status: 'scheduled' }),
  });
  assert.equal(disconnectedChange.status, 200, 'commits an administrator change while the browser is disconnected');
  await client.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: 10_000_000, uploadThroughput: 10_000_000, connectionType: 'wifi' });
  assert.equal(await waitFor(client, `document.querySelector('.run-event-banner[data-date="2024-03-03"] .run-event-banner__status')?.textContent === 'Scheduled'`), true, 'socket reconnect recovers event state missed while disconnected');

  await client.send('Page.reload', { ignoreCache: true });
  assert.equal(await waitFor(client, `document.querySelector('#protected-content') && !document.querySelector('#protected-content').hidden && document.querySelectorAll('#week-days .vote-card').length === 7 && document.querySelectorAll('.run-event-banner').length === 2`), true, 'a full refresh reloads authoritative persisted event state');

  const focusedProposalAction = await evaluate(client, `(() => { const button = document.querySelector('.run-event-day-action[aria-label="Propose run on Thu, 29 Feb"]'); button?.focus(); return Boolean(button && document.activeElement === button); })()`);
  assert.equal(focusedProposalAction, true, 'the keyboard-only proposal control receives focus');
  await evaluate(client, `window.issue32Keys = []; document.activeElement.addEventListener('keydown', (event) => window.issue32Keys.push(event.key));`);
  await pressEnter(client);
  const keyboardProposalCreated = await waitFor(client, `document.querySelector('.run-event-banner[data-date="2024-02-29"]') !== null`);
  if (!keyboardProposalCreated) {
    t.diagnostic(JSON.stringify(await evaluate(client, `({ active: document.activeElement?.outerHTML, keys: window.issue32Keys, message: document.querySelector('#message')?.textContent, action: document.querySelector('.run-event-day-action[aria-label*="29 Feb"]')?.outerHTML, eventBanners: [...document.querySelectorAll('.run-event-banner')].map((banner) => banner.dataset.date) })`)));
    t.diagnostic(`proposal rows in SQLite: ${server.database.prepare('SELECT COUNT(*) AS count FROM run_events').get().count}`);
  }
  assert.equal(keyboardProposalCreated, true, 'keyboard Enter creates a shared proposal using the accessible date action');
  assert.equal(await evaluate(client, `document.querySelector('#message').textContent`), 'Run proposed.');

  const focusedWithdrawalAction = await evaluate(client, `(() => { const button = document.querySelector('.run-event-day-action[data-date="2024-02-29"]'); button?.focus(); return Boolean(button && document.activeElement === button); })()`);
  if (!focusedWithdrawalAction) t.diagnostic(JSON.stringify(await evaluate(client, `({ actions: [...document.querySelectorAll('.run-event-day-action')].map((button) => ({ label: button.getAttribute('aria-label'), date: button.dataset.date })), banners: [...document.querySelectorAll('.run-event-banner')].map((banner) => ({ date: banner.dataset.date, status: banner.querySelector('.run-event-banner__status')?.textContent })), selected: [...document.querySelectorAll('.vote-card.is-selected')].map((card) => card.dataset.date) })`)));
  assert.equal(focusedWithdrawalAction, true, 'the keyboard-only withdrawal control receives focus');
  await pressEnter(client);
  const keyboardWithdrawalCompleted = await waitFor(client, `document.querySelector('.run-event-banner[data-date="2024-02-29"]') === null`);
  if (!keyboardWithdrawalCompleted) {
    t.diagnostic(JSON.stringify(await evaluate(client, `({ active: document.activeElement?.outerHTML, message: document.querySelector('#message')?.textContent, action: document.querySelector('.run-event-day-action[aria-label*="29 Feb"]')?.outerHTML, eventBanners: [...document.querySelectorAll('.run-event-banner')].map((banner) => banner.dataset.date) })`)));
  }
  assert.equal(keyboardWithdrawalCompleted, true, 'keyboard Enter withdraws a proposal without changing its vote');
  assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM votes WHERE vote_date = ?').get('2024-02-29').count, 1);

  await swipe(client, '#week-days .vote-card[data-date="2024-02-29"]', 84);
  assert.equal(await waitFor(client, `document.querySelector('.run-event-banner[data-date="2024-02-29"]') !== null`), true, 'a right date-card swipe proposes the selected date');
  await swipe(client, '#week-days .vote-card[data-date="2024-02-29"]', -84);
  assert.equal(await waitFor(client, `document.querySelector('.run-event-banner[data-date="2024-02-29"]') === null`), true, 'a left date-card swipe withdraws only the proposal');
  assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM votes WHERE vote_date = ?').get('2024-02-29').count, 1, 'completed swipes never also toggle the availability vote');

  const [adminCookieName, adminCookieValue] = admin.cookie.split('=', 2);
  await client.send('Network.setCookie', { url: baseUrl, name: adminCookieName, value: adminCookieValue, path: '/' });
  await client.send('Page.navigate', { url: `${baseUrl}/vote` });
  assert.equal(await waitFor(client, `document.querySelector('#protected-content') && !document.querySelector('#protected-content').hidden && document.querySelectorAll('#week-days .vote-card').length === 7`), true, 'loads the board as the authenticated administrator');
  assert.equal(await evaluate(client, `document.querySelectorAll('.run-event-actions').length`), 2, 'renders explicit banner controls for an administrator');
  await evaluate(client, `document.querySelector('.run-event-banner[data-date="2024-03-01"] button[data-run-event-status="proposed"]')?.focus()`);
  await pressEnter(client);
  assert.equal(await waitFor(client, `document.querySelector('.run-event-banner[data-date="2024-03-01"] .run-event-banner__status')?.textContent === 'Scheduled'`), true, 'admin keyboard action schedules a proposal');
  await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  assert.equal(await evaluate(client, `getComputedStyle(document.querySelector('.run-event-banner[data-date="2024-03-01"]')).animationName`), 'none', 'scheduled emphasis is disabled for reduced-motion users');
  await evaluate(client, `document.querySelector('.run-event-banner[data-date="2024-03-01"] button[data-run-event-status="scheduled"]')?.focus()`);
  await pressEnter(client);
  assert.equal(await waitFor(client, `document.querySelector('.run-event-banner[data-date="2024-03-01"] .run-event-banner__status')?.textContent === 'Proposed'`), true, 'admin keyboard action reverts a scheduled event to proposed');
  await evaluate(client, `document.querySelector('.run-event-banner[data-date="2024-03-01"] button[data-run-event-status="proposed"]')?.focus()`);
  await pressEnter(client);
  assert.equal(await waitFor(client, `document.querySelector('.run-event-banner[data-date="2024-03-01"] .run-event-banner__status')?.textContent === 'Scheduled'`), true, 'admin can schedule the same event again after reverting');
  await beginSwipe(client, '.run-event-banner[data-date="2024-03-01"]', -24);
  assert.deepEqual(await evaluate(client, `(() => { const cue = document.querySelector('.run-event-banner[data-date="2024-03-01"] .run-event-banner__swipe-cue'); return { text: cue?.textContent, destructive: cue?.dataset.destructive }; })()`), { text: 'Swipe left to delete', destructive: 'true' }, 'announces the destructive admin action before it can commit');
  await cancelSwipe(client);
  assert.equal(await evaluate(client, `document.querySelector('.run-event-banner[data-date="2024-03-01"] .run-event-banner__status')?.textContent`), 'Scheduled', 'cancelling the deletion preview preserves the event');
  await swipe(client, '.run-event-banner[data-date="2024-03-01"]', -84);
  assert.equal(await waitFor(client, `document.querySelector('.run-event-banner[data-date="2024-03-01"]') === null`), true, 'admin left swipe permanently deletes a scheduled event');
  assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM votes WHERE vote_date = ?').get('2024-03-01').count, 4, 'event deletion preserves all availability votes');
});
