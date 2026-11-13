import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { addRoomMember, createRoom } from '../src/room-storage.js';
import { setVote } from '../src/domain.js';
import { createServer } from '../src/server.js';
import { removeProfileWithRetry } from './helpers/chromium-profile-cleanup.js';
import { chromiumReadinessTimeoutMs, readDevToolsPort, spawnChromium, stopChromium } from './helpers/chromium-startup.js';

const chromePath = process.env.CHROME_BIN ?? [
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/opt/google/chrome/chrome',
  '/opt/data/tmp/chrome/opt/google/chrome/chrome',
].find((path) => existsSync(path));
if (!chromePath) throw new Error('Issue 50 browser coverage requires real Chromium; refusing to skip.');

const ADMIN_PIN = String(randomInt(0, 10000)).padStart(4, '0');
const MEMBER_PIN = String(randomInt(0, 10000)).padStart(4, '0');
const MEMBER_NAME = 'ผู้ใช้ทดสอบ English Member'.padEnd(40, 'X');
const ENV = { ADMIN_NAME: 'admin', ADMIN_PIN, PIN_PEPPER: `issue-50-${randomInt(1, 1_000_000_000)}` };

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
  const events = [];
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id) {
      if (message.method) events.push(message);
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
    events,
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
  if (result.exceptionDetails) throw new Error(result.result?.description ?? result.exceptionDetails.text);
  return result.result.value;
}

async function waitFor(client, expression, timeoutMs = 8000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await evaluate(client, expression)) return true;
    await delay(50);
  }
  return false;
}

async function press(client, key, code = key, modifiers = 0, text = '') {
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers, text });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers });
}

async function createFixture() {
  const directory = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'run-together-issue-50-browser-'));
  const server = createServer({
    databasePath: join(directory, 'fixture.sqlite'),
    env: ENV,
    now: () => new Date('2026-11-13T08:00:00.000Z'),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    directory,
    server,
    baseUrl,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function register(baseUrl, name, pin) {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { origin: baseUrl, 'content-type': 'application/json' },
    body: JSON.stringify({ name, pin, pinConfirmation: pin }),
  });
  assert.equal(response.status, 201);
  return response.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
}

async function openPage(client, url) {
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Network.enable');
  await client.send('Page.navigate', { url });
}

async function loginThroughForm(client, { name, pin, baseUrl, expectedPath = '/rooms' }) {
  if (await evaluate(client, `location.pathname !== '/'`)) {
    await client.send('Page.navigate', { url: `${baseUrl}/` });
  }
  assert.equal(await waitFor(client, `Boolean(document.querySelector('#login-form'))`), true, 'shows the sign-in form');
  await evaluate(client, `(() => {
    const form = document.querySelector('#login-form');
    form.elements.name.value = ${JSON.stringify(name)};
    form.elements.pin.value = ${JSON.stringify(pin)};
    form.requestSubmit();
  })()`);
  assert.equal(await waitFor(client, `location.pathname === ${JSON.stringify(expectedPath)} && Boolean(document.querySelector('#rooms-content') && !document.querySelector('#rooms-content').hidden)`), true,
    'sign-in loads the authenticated room list');
}

test('Issue 50 profile menu works for admin and member in real Chromium', async (t) => {
  const fixture = await createFixture();
  const memberCookie = await register(fixture.baseUrl, MEMBER_NAME, MEMBER_PIN);
  const adminId = fixture.server.database.prepare("SELECT id FROM users WHERE name = 'admin'").get().id;
  const memberId = fixture.server.database.prepare('SELECT id FROM users WHERE name = ?').get(MEMBER_NAME).id;
  const room = createRoom(fixture.server.database, { creatorUserId: adminId, title: 'Profile menu room', venue: 'Track', time: '18:30' });
  addRoomMember(fixture.server.database, { roomId: room.id, userId: adminId });
  addRoomMember(fixture.server.database, { roomId: room.id, userId: memberId, now: () => new Date('2026-11-13T08:00:00.000Z') });
  setVote(fixture.server.database, {
    roomId: room.id, userId: memberId, voteDate: '2026-11-14', body: { selected: true },
    now: () => new Date('2026-11-13T08:00:00.000Z'),
  });
  const profile = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'run-together-issue-50-chrome-'));
  const browser = spawnChromium(chromePath, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
    '--no-default-browser-check', '--disable-background-networking', '--window-size=1280,480', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank',
  ]);
  let client;
  t.after(async () => {
    client?.close();
    await stopChromium(browser);
    await removeProfileWithRetry(profile);
    await fixture.close();
  });
  const port = await readDevToolsPort(profile, browser, { timeoutMs: chromiumReadinessTimeoutMs });
  const target = await createTarget(port);
  client = createCdpClient(target.webSocketDebuggerUrl);
  await openPage(client, `${fixture.baseUrl}/`);
  await loginThroughForm(client, { baseUrl: fixture.baseUrl, name: 'admin', pin: ADMIN_PIN });
  await client.send('Page.reload', { ignoreCache: true });
  assert.equal(await waitFor(client, `location.pathname === '/rooms' && Boolean(document.querySelector('#rooms-content') && !document.querySelector('#rooms-content').hidden)`), true,
    'refresh restores the live authenticated session');
  assert.equal(await evaluate(client, `document.querySelector('#rooms-profile-menu [role=menu]').hidden`), true,
    'refresh restores the profile menu in its closed default state');
  const sessionDelayScript = await client.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const originalFetch = window.fetch.bind(window);
    window.__issue50SessionPending = false;
    window.__issue50SessionRelease = null;
    window.fetch = async (...args) => {
      if (String(args[0]) === '/api/session') {
        window.__issue50SessionPending = true;
        await new Promise((resolve) => { window.__issue50SessionRelease = resolve; });
      }
      return originalFetch(...args);
    };
  })();` });
  await client.send('Page.navigate', { url: `${fixture.baseUrl}/vote/${room.id}` });
  assert.equal(await waitFor(client, `Boolean(document.querySelector('#vote-profile-menu') && window.__issue50SessionPending)`), true,
    'the vote page stays in its pre-authentication state while the role lookup is pending');
  const preAuthMenu = await evaluate(client, `(() => ({
    protectedHidden: document.querySelector('#protected-content').hidden,
    menuChildren: document.querySelector('#vote-profile-menu').children.length,
    visibleAdminAction: Boolean(document.querySelector('#vote-profile-menu a[href^="/admin"]')),
  }))()`);
  assert.deepEqual(preAuthMenu, { protectedHidden: true, menuChildren: 0, visibleAdminAction: false },
    'no protected identity or admin action flashes before the authenticated role is known');
  await evaluate(client, 'window.__issue50SessionRelease()');
  assert.equal(await waitFor(client, `Boolean(document.querySelector('#protected-content') && !document.querySelector('#protected-content').hidden)`), true,
    'the page reveals protected content only after the authenticated session arrives');
  await client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: sessionDelayScript.identifier });
  await client.send('Page.navigate', { url: `${fixture.baseUrl}/rooms` });
  assert.equal(await waitFor(client, `location.pathname === '/rooms' && Boolean(document.querySelector('#rooms-content') && !document.querySelector('#rooms-content').hidden)`), true);

  const initialRooms = await evaluate(client, `(() => {
    const root = document.querySelector('#rooms-profile-menu');
    const trigger = root.querySelector('.profile-menu__trigger');
    return {
      closed: root.querySelector('[role=menu]').hidden,
      label: trigger.getAttribute('aria-label'),
      expanded: trigger.getAttribute('aria-expanded'),
      displayName: trigger.querySelector('.profile-menu__trigger-name')?.textContent,
      desktopNameDisplay: getComputedStyle(trigger.querySelector('.profile-menu__trigger-name')).display,
      roomHeading: document.querySelector('#rooms-heading')?.textContent,
      oldControls: Boolean(document.querySelector('#rooms-change-pin, #rooms-logout, #rooms-manage-users, .rooms-toolbar__account')),
    };
  })()`);
  assert.deepEqual(initialRooms, {
    closed: true,
    label: 'Profile menu for admin',
    expanded: 'false',
    displayName: 'admin',
    desktopNameDisplay: 'block',
    roomHeading: 'Choose a room / เลือกห้อง',
    oldControls: false,
  });

  await evaluate(client, "document.querySelector('#rooms-profile-menu .profile-menu__trigger').click()");
  assert.equal(await waitFor(client, `!document.querySelector('#rooms-profile-menu [role=menu]').hidden`), true);
  let adminMenu = await evaluate(client, `(() => {
    const root = document.querySelector('#rooms-profile-menu');
    const trigger = root.querySelector('.profile-menu__trigger');
    const panel = root.querySelector('[role=menu]');
    return {
      expanded: trigger.getAttribute('aria-expanded'),
      controls: trigger.getAttribute('aria-controls'),
      panelId: panel.id,
      identity: root.querySelector('.profile-menu__identity').textContent.replace(/\\s+/g, ' ').trim(),
      actions: [...panel.querySelectorAll('[role=menuitem]')].map((item) => item.textContent.trim()),
      pinHref: panel.querySelector('a[href^="/change-pin"]')?.getAttribute('href'),
      adminHref: panel.querySelector('a[href^="/admin"]')?.getAttribute('href'),
      iconsHidden: [...panel.querySelectorAll('svg')].every((icon) => icon.getAttribute('aria-hidden') === 'true'),
      actionHeights: [...panel.querySelectorAll('[role=menuitem]')].map((item) => item.getBoundingClientRect().height),
    };
  })()`);
  assert.deepEqual(adminMenu.actions, ['Change PIN', 'Manage users', 'Logout']);
  assert.equal(adminMenu.identity, 'Signed in asadminAdmin');
  assert.equal(adminMenu.expanded, 'true');
  assert.equal(adminMenu.controls, adminMenu.panelId);
  assert.equal(adminMenu.pinHref, '/change-pin?returnTo=%2Frooms');
  assert.equal(adminMenu.adminHref, '/admin?returnTo=%2Frooms');
  assert.equal(adminMenu.iconsHidden, true);
  assert.equal(adminMenu.actionHeights.every((height) => height >= 48), true);

  await press(client, 'Escape');
  assert.equal(await evaluate(client, `document.querySelector('#rooms-profile-menu [role=menu]').hidden && document.activeElement.matches('.profile-menu__trigger')`), true,
    'Escape closes the menu and restores focus to its trigger');
  await press(client, ' ', 'Space', 0, ' ');
  assert.equal(await waitFor(client, `!document.querySelector('#rooms-profile-menu [role=menu]').hidden && document.activeElement.textContent.trim() === 'Change PIN'`), true,
    'Space opens the menu and focuses the first action');
  await press(client, 'Escape');
  assert.equal(await evaluate(client, `document.querySelector('#rooms-profile-menu [role=menu]').hidden && document.activeElement.matches('.profile-menu__trigger')`), true);
  await press(client, 'Enter');
  assert.equal(await waitFor(client, `document.activeElement.textContent.trim() === 'Change PIN'`), true, 'Enter opens and focuses the first action');
  await press(client, 'ArrowDown');
  assert.equal(await evaluate(client, `document.activeElement.textContent.trim() === 'Manage users'`), true, 'ArrowDown advances to the next action');
  await press(client, 'ArrowUp');
  assert.equal(await evaluate(client, `document.activeElement.textContent.trim() === 'Change PIN'`), true, 'ArrowUp returns to the previous action');
  await press(client, 'End');
  assert.equal(await evaluate(client, `document.activeElement.textContent.trim() === 'Logout'`), true, 'End focuses the last action');
  await press(client, 'Home');
  assert.equal(await evaluate(client, `document.activeElement.textContent.trim() === 'Change PIN'`), true, 'Home focuses the first action');
  await press(client, 'Tab');
  assert.equal(await evaluate(client, `document.querySelector('#rooms-profile-menu [role=menu]').hidden && document.activeElement.id === 'create-room-navigation'`), true,
    'Tab closes the menu and continues to the next page control without trapping focus');
  await evaluate(client, "document.querySelector('#rooms-profile-menu .profile-menu__trigger').click()");
  await evaluate(client, "document.querySelector('#rooms-heading').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))");
  assert.equal(await evaluate(client, `document.querySelector('#rooms-profile-menu [role=menu]').hidden`), true, 'an outside pointer closes the menu');
  await evaluate(client, "document.querySelector('#rooms-profile-menu .profile-menu__trigger').click()");
  await evaluate(client, "document.querySelector('#rooms-profile-menu .profile-menu__trigger').click()");
  assert.equal(await evaluate(client, `document.querySelector('#rooms-profile-menu [role=menu]').hidden`), true, 'clicking the trigger again closes the menu');

  await evaluate(client, "document.querySelector('#rooms-profile-menu .profile-menu__trigger').click()");
  await evaluate(client, "document.querySelector('#rooms-profile-menu a[href^=\"/change-pin\"]').click()");
  assert.equal(await waitFor(client, `location.pathname === '/change-pin' && document.querySelector('#return-to-vote')?.getAttribute('href') === '/rooms'`), true,
    'Change PIN opens the protected page with a validated Rooms return');
  await evaluate(client, "document.querySelector('#return-to-vote').click()");
  assert.equal(await waitFor(client, `location.pathname === '/rooms' && Boolean(document.querySelector('#rooms-content') && !document.querySelector('#rooms-content').hidden)`), true);
  await evaluate(client, "document.querySelector('#rooms-profile-menu .profile-menu__trigger').click()");
  await evaluate(client, "document.querySelector('#rooms-profile-menu a[href^=\"/admin\"]').click()");
  assert.equal(await waitFor(client, `location.pathname === '/admin' && document.querySelector('#admin-return')?.getAttribute('href') === '/rooms'`), true,
    'Manage users opens the protected admin page with a validated Rooms return');
  await evaluate(client, "document.querySelector('#admin-return').click()");
  assert.equal(await waitFor(client, `location.pathname === '/rooms' && Boolean(document.querySelector('#rooms-content') && !document.querySelector('#rooms-content').hidden)`), true);

  await evaluate(client, `document.querySelector('.room-card[data-room-id="${room.id}"] .room-card__entry').click()`);
  assert.equal(await waitFor(client, `location.pathname === '/vote/${room.id}' && Boolean(document.querySelector('#protected-content') && !document.querySelector('#protected-content').hidden)`), true,
    'a real room-card action enters the voting page');
  const voteMenu = await evaluate(client, `(() => {
    const root = document.querySelector('#vote-profile-menu');
    const trigger = root.querySelector('.profile-menu__trigger');
    const header = document.querySelector('#room-page-header');
    const back = document.querySelector('#back-to-rooms').getBoundingClientRect();
    const profileBox = root.getBoundingClientRect();
    return {
      closed: root.querySelector('[role=menu]').hidden,
      label: trigger.getAttribute('aria-label'),
      backBeforeMenu: back.right <= profileBox.left,
      heading: document.querySelector('#room-information-heading').textContent,
      details: document.querySelector('#room-information-details').textContent,
      hasTimeline: Boolean(document.querySelector('#vote-timeline')),
      weekText: document.querySelector('#week-heading').textContent,
      duplicateIdentity: Boolean(document.querySelector('#display-name')),
      standaloneManage: Boolean(document.querySelector('#manage-user, #manage-users-link')),
      headerVisible: Boolean(header.getBoundingClientRect().width),
    };
  })()`);
  assert.equal(voteMenu.closed, true);
  assert.equal(voteMenu.label, 'Profile menu for admin');
  assert.equal(voteMenu.backBeforeMenu, true, 'Back remains to the left of the profile trigger');
  assert.match(voteMenu.heading, /Profile menu room/);
  assert.equal(voteMenu.details, 'at Track on 6:30PM');
  assert.equal(voteMenu.hasTimeline, true);
  assert.match(voteMenu.weekText, /Week/);
  assert.equal(voteMenu.duplicateIdentity, false);
  assert.equal(voteMenu.standaloneManage, false);
  assert.equal(voteMenu.headerVisible, true);

  await evaluate(client, "document.querySelector('#vote-profile-menu .profile-menu__trigger').click()");
  adminMenu = await evaluate(client, `(() => {
    const root = document.querySelector('#vote-profile-menu');
    const panel = root.querySelector('[role=menu]');
    return {
      actions: [...panel.querySelectorAll('[role=menuitem]')].map((item) => item.textContent.trim()),
      pinHref: panel.querySelector('a[href^="/change-pin"]')?.getAttribute('href'),
      adminHref: panel.querySelector('a[href^="/admin"]')?.getAttribute('href'),
    };
  })()`);
  assert.deepEqual(adminMenu.actions, ['Change PIN', 'Manage users', 'Logout']);
  assert.equal(adminMenu.pinHref, `/change-pin?returnTo=${encodeURIComponent(`/vote/${room.id}`)}`);
  assert.equal(adminMenu.adminHref, `/admin?returnTo=${encodeURIComponent(`/vote/${room.id}`)}`);
  await evaluate(client, "document.querySelector('#vote-profile-menu a[href^=\"/change-pin\"]').click()");
  assert.equal(await waitFor(client, `location.pathname === '/change-pin' && document.querySelector('#return-to-vote')?.getAttribute('href') === '/vote/${room.id}'`), true,
    'Change PIN returns to the originating voting page');
  await evaluate(client, "document.querySelector('#return-to-vote').click()");
  const voteReturnReady = await waitFor(client, `location.pathname === '/vote/${room.id}' && Boolean(document.querySelector('#protected-content') && !document.querySelector('#protected-content').hidden)`);
  if (!voteReturnReady) t.diagnostic(JSON.stringify(await evaluate(client, `({ path: location.pathname, title: document.title, body: document.body.innerText.slice(0, 240), protected: Boolean(document.querySelector('#protected-content')) })`)));
  assert.equal(voteReturnReady, true);
  await evaluate(client, "document.querySelector('#vote-profile-menu .profile-menu__trigger').click()");
  await evaluate(client, "document.querySelector('#vote-profile-menu a[href^=\"/admin\"]').click()");
  assert.equal(await waitFor(client, `location.pathname === '/admin' && document.querySelector('#admin-return')?.getAttribute('href') === '/vote/${room.id}'`), true,
    'Manage users returns to the originating voting page');
  await evaluate(client, "document.querySelector('#admin-return').click()");
  assert.equal(await waitFor(client, `location.pathname === '/vote/${room.id}' && Boolean(document.querySelector('#protected-content') && !document.querySelector('#protected-content').hidden)`), true);

  await client.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 844, deviceScaleFactor: 1, mobile: true });
  const narrowTrigger = await evaluate(client, `(() => {
    const root = document.querySelector('#vote-profile-menu');
    const trigger = root.querySelector('.profile-menu__trigger');
    const name = trigger.querySelector('.profile-menu__trigger-name');
    const rect = trigger.getBoundingClientRect();
    return {
      viewport: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      width: rect.width,
      height: rect.height,
      nameDisplay: getComputedStyle(name).display,
      avatar: root.querySelector('.profile-menu__avatar').textContent,
      backWidth: document.querySelector('#back-to-rooms').getBoundingClientRect().width,
    };
  })()`);
  assert.equal(narrowTrigger.viewport, 320);
  assert.equal(narrowTrigger.scrollWidth <= 320, true, 'the narrow voting page has no horizontal page scroll');
  assert.equal(narrowTrigger.nameDisplay, 'none', 'the trigger is avatar-only at 320 CSS pixels');
  assert.ok(narrowTrigger.width >= 44 && narrowTrigger.height >= 44);
  assert.ok(narrowTrigger.backWidth >= 44);
  await evaluate(client, "document.querySelector('#vote-profile-menu .profile-menu__trigger').click()");
  const narrowPanel = await evaluate(client, `(() => {
    const panel = document.querySelector('#vote-profile-menu [role=menu]');
    const box = panel.getBoundingClientRect();
    const items = [...panel.querySelectorAll('[role=menuitem]')].map((item) => ({ height: item.getBoundingClientRect().height, bottom: item.getBoundingClientRect().bottom }));
    return { left: box.left, right: box.right, top: box.top, maxBottom: Math.max(...items.map((item) => item.bottom)), items };
  })()`);
  assert.ok(narrowPanel.left >= 0 && narrowPanel.right <= 320, 'the panel stays within the narrow viewport');
  assert.ok(narrowPanel.top > 0);
  assert.equal(narrowPanel.items.every((item) => item.height >= 48), true);
  assert.equal(narrowPanel.maxBottom <= 844, true, 'all menu actions remain reachable in the narrow viewport');

  await evaluate(client, `window.__originalFetch = window.fetch.bind(window); window.__failIssue50Logout = true; window.fetch = (input, init) => {
    if (String(input) === '/api/auth/logout' && window.__failIssue50Logout) {
      window.__failIssue50Logout = false;
      return Promise.resolve(new Response('', { status: 503 }));
    }
    return window.__originalFetch(input, init);
  };`);
  await evaluate(client, "document.querySelector('#vote-profile-menu .profile-menu__logout').click()");
  assert.equal(await waitFor(client, `document.querySelector('#vote-profile-menu .profile-menu__status')?.textContent === 'Could not log out. Please retry.'`), true,
    'a failed logout shows a readable retry message');
  assert.equal(await evaluate(client, `document.querySelector('#vote-profile-menu [role=menu]').hidden === false && !document.querySelector('#vote-profile-menu .profile-menu__logout').disabled`), true,
    'the menu remains open and Logout can be retried');
  assert.equal(await evaluate(client, `fetch('/api/session', { cache: 'no-store' }).then((response) => response.status === 200)`), true,
    'a failed logout does not falsely end the server session');
  await evaluate(client, 'window.fetch = window.__originalFetch');
  await client.send('Page.navigate', { url: `${fixture.baseUrl}/rooms` });
  assert.equal(await waitFor(client, `location.pathname === '/rooms' && Boolean(document.querySelector('#rooms-content') && !document.querySelector('#rooms-content').hidden)`), true);
  await evaluate(client, `document.querySelector('.room-card[data-room-id="${room.id}"] .room-card__entry').click()`);
  assert.equal(await waitFor(client, `location.pathname === '/vote/${room.id}' && Boolean(document.querySelector('#protected-content') && !document.querySelector('#protected-content').hidden)`), true);
  await evaluate(client, "document.querySelector('#vote-profile-menu .profile-menu__trigger').click()");
  await evaluate(client, "document.querySelector('#vote-profile-menu .profile-menu__logout').click()");
  assert.equal(await waitFor(client, `location.pathname === '/' && Boolean(document.querySelector('#login-form'))`), true,
    'a successful retry returns to sign-in');
  assert.equal(await evaluate(client, `fetch('/api/session', { cache: 'no-store' }).then((response) => response.status === 401)`), true,
    'successful Logout revokes the server session');
  const history = await client.send('Page.getNavigationHistory');
  const previousEntry = history.entries[history.currentIndex - 1];
  assert.match(previousEntry.url, /\/rooms$/);
  await client.send('Page.navigateToHistoryEntry', { entryId: previousEntry.id });
  assert.equal(await waitFor(client, `location.pathname === '/' || !document.querySelector('#protected-content') || document.querySelector('#protected-content').hidden`, 5000), true,
    'browser Back does not retain visible protected content');
  await delay(250);
  const backState = await evaluate(client, `({ path: location.pathname, protectedVisible: Boolean(document.querySelector('#protected-content') && !document.querySelector('#protected-content').hidden), staleProfile: [...document.querySelectorAll('.profile-menu__trigger')].some((trigger) => trigger.getAttribute('aria-label')?.includes('admin')) })`);
  assert.equal(backState.protectedVisible, false, 'browser Back cannot restore protected room identity or content');
  assert.equal(backState.staleProfile, false, 'browser Back clears the revoked profile identity');
  const anonymousVote = await fetch(`${fixture.baseUrl}/vote/${room.id}`);
  assert.equal(anonymousVote.status, 401, 'direct protected voting URLs remain unauthorized after Logout');
  await client.send('Page.navigate', { url: `${fixture.baseUrl}/vote/${room.id}` });
  assert.equal(await waitFor(client, `!document.querySelector('#protected-content')`), true, 'direct navigation does not recreate authenticated vote controls');

  await client.send('Page.navigate', { url: `${fixture.baseUrl}/` });
  await loginThroughForm(client, { baseUrl: fixture.baseUrl, name: 'admin', pin: ADMIN_PIN });
  await evaluate(client, "document.querySelector('#rooms-profile-menu .profile-menu__trigger').click()");
  await evaluate(client, "document.querySelector('#rooms-profile-menu .profile-menu__logout').click()");
  assert.equal(await waitFor(client, `location.pathname === '/' && Boolean(document.querySelector('#login-form'))`), true);
  await loginThroughForm(client, { baseUrl: fixture.baseUrl, name: MEMBER_NAME, pin: MEMBER_PIN });
  const memberProfile = await evaluate(client, `(() => {
    const root = document.querySelector('#rooms-profile-menu');
    const trigger = root.querySelector('.profile-menu__trigger');
    return { label: trigger.getAttribute('aria-label'), initial: root.querySelector('.profile-menu__avatar').textContent, closed: root.querySelector('[role=menu]').hidden };
  })()`);
  assert.equal(memberProfile.label, `Profile menu for ${MEMBER_NAME}`);
  assert.equal(memberProfile.initial, 'ผู้', 'Thai display names generate a grapheme-safe initial');
  assert.equal(memberProfile.closed, true, 'the member menu starts closed after sign-in');
  await evaluate(client, "document.querySelector('#rooms-profile-menu .profile-menu__trigger').click()");
  const memberMenu = await evaluate(client, `(() => {
    const root = document.querySelector('#rooms-profile-menu');
    const panel = root.querySelector('[role=menu]');
    return {
      identity: root.querySelector('.profile-menu__identity').textContent.replace(/\\s+/g, ' ').trim(),
      actions: [...panel.querySelectorAll('[role=menuitem]')].map((item) => item.textContent.trim()),
      hasManageRow: Boolean([...panel.querySelectorAll('[role=menuitem]')].find((item) => item.textContent.trim() === 'Manage users')),
    };
  })()`);
  assert.equal(memberMenu.identity, `Signed in as${MEMBER_NAME}Member`);
  assert.deepEqual(memberMenu.actions, ['Change PIN', 'Logout']);
  assert.equal(memberMenu.hasManageRow, false, 'members do not receive a disabled or empty Manage users row');
  await evaluate(client, "document.querySelector('#rooms-profile-menu .profile-menu__trigger').click()");

  await client.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 960, deviceScaleFactor: 1, mobile: false });
  const longNameLayout = await evaluate(client, `(() => {
    const root = document.querySelector('#rooms-profile-menu');
    const triggerName = root.querySelector('.profile-menu__trigger-name');
    const triggerStyle = getComputedStyle(triggerName);
    const trigger = root.querySelector('.profile-menu__trigger').getBoundingClientRect();
    return {
      viewport: innerWidth,
      pageWidth: document.documentElement.scrollWidth,
      triggerName: { text: triggerName.textContent, width: triggerName.clientWidth, scrollWidth: triggerName.scrollWidth, overflow: triggerStyle.overflow, textOverflow: triggerStyle.textOverflow },
      trigger: { left: trigger.left, right: trigger.right, width: trigger.width },
    };
  })()`);
  assert.equal(longNameLayout.viewport, 1280);
  assert.ok(longNameLayout.pageWidth <= longNameLayout.viewport, 'a long Thai and English name does not create page overflow');
  assert.equal(longNameLayout.triggerName.text, MEMBER_NAME);
  assert.equal(longNameLayout.triggerName.overflow, 'hidden');
  assert.equal(longNameLayout.triggerName.textOverflow, 'ellipsis');
  assert.ok(longNameLayout.triggerName.scrollWidth > longNameLayout.triggerName.width, 'the desktop trigger truncates a long display name');
  assert.ok(longNameLayout.trigger.left >= 0 && longNameLayout.trigger.right <= 1280);
  await evaluate(client, "document.querySelector('#rooms-profile-menu .profile-menu__trigger').click()");
  const longMenuName = await evaluate(client, `(() => {
    const name = document.querySelector('#rooms-profile-menu .profile-menu__identity-name');
    const rect = name.getBoundingClientRect();
    return { text: name.textContent, width: name.clientWidth, scrollWidth: name.scrollWidth, height: rect.height };
  })()`);
  assert.equal(longMenuName.text, MEMBER_NAME);
  assert.equal(longMenuName.scrollWidth, longMenuName.width, 'the menu identity wraps instead of clipping the full name');
  assert.ok(longMenuName.height >= 32, 'the long menu identity occupies multiple readable lines');
  await evaluate(client, "document.querySelector('#rooms-profile-menu .profile-menu__trigger').click()");

  await evaluate(client, `document.querySelector('.room-card[data-room-id="${room.id}"] .room-card__entry').click()`);
  assert.equal(await waitFor(client, `location.pathname === '/vote/${room.id}' && Boolean(document.querySelector('#protected-content') && !document.querySelector('#protected-content').hidden)`), true);
  await evaluate(client, "document.querySelector('#vote-profile-menu .profile-menu__trigger').click()");
  const memberVoteMenu = await evaluate(client, `(() => ({
    identity: document.querySelector('#vote-profile-menu .profile-menu__identity').textContent.replace(/\\s+/g, ' ').trim(),
    actions: [...document.querySelectorAll('#vote-profile-menu [role=menuitem]')].map((item) => item.textContent.trim()),
    week: document.querySelector('#week-heading').textContent,
    voterNames: [...document.querySelectorAll('.vote-card__voter-name')].map((name) => name.textContent),
  }))()`);
  assert.equal(memberVoteMenu.identity, `Signed in as${MEMBER_NAME}Member`);
  assert.deepEqual(memberVoteMenu.actions, ['Change PIN', 'Logout']);
  assert.match(memberVoteMenu.week, /Week/);
  assert.ok(memberVoteMenu.voterNames.includes(MEMBER_NAME), 'the viewer name remains visible in voting content');
  await evaluate(client, "document.querySelector('#vote-profile-menu .profile-menu__trigger').click()");

  await client.send('Page.navigate', { url: `${fixture.baseUrl}/admin?returnTo=${encodeURIComponent(`/vote/${room.id}`)}` });
  assert.equal(await waitFor(client, `location.pathname === '/admin'`), true);
  await delay(150);
  assert.equal(await evaluate(client, `!document.querySelector('#admin-content')`), true, 'direct unauthorized admin access stays blocked for members');
  const memberSession = await fetch(`${fixture.baseUrl}/api/session`, { headers: { cookie: memberCookie } });
  assert.equal(memberSession.status, 200, 'the independent fixture member remains authenticated');
  assert.deepEqual(client.events.filter((event) => event.method === 'Runtime.exceptionThrown'), [], 'the real browser reports no uncaught script exceptions');
});

test('Issue 50 profile menu remains usable at actual 200% Chromium browser zoom', async (t) => {
  const fixture = await createFixture();
  await register(fixture.baseUrl, MEMBER_NAME, MEMBER_PIN);
  const adminId = fixture.server.database.prepare("SELECT id FROM users WHERE name = 'admin'").get().id;
  const memberId = fixture.server.database.prepare('SELECT id FROM users WHERE name = ?').get(MEMBER_NAME).id;
  const room = createRoom(fixture.server.database, { creatorUserId: adminId, title: 'Zoom profile menu room', venue: 'Park', time: '07:30' });
  addRoomMember(fixture.server.database, { roomId: room.id, userId: memberId });
  const profile = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'run-together-issue-50-zoom-chrome-'));
  await mkdir(join(profile, 'Default'), { recursive: true });
  await writeFile(join(profile, 'Default', 'Preferences'), JSON.stringify({
    partition: { default_zoom_level: { x: 3.8017840169239308 } },
  }), { mode: 0o600 });
  const browser = spawnChromium(chromePath, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
    '--no-default-browser-check', '--disable-background-networking', '--window-size=1280,480', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank',
  ]);
  let client;
  t.after(async () => {
    client?.close();
    await stopChromium(browser);
    await removeProfileWithRetry(profile);
    await fixture.close();
  });
  const port = await readDevToolsPort(profile, browser, { timeoutMs: chromiumReadinessTimeoutMs });
  const target = await createTarget(port);
  client = createCdpClient(target.webSocketDebuggerUrl);
  await openPage(client, `${fixture.baseUrl}/`);
  await loginThroughForm(client, { baseUrl: fixture.baseUrl, name: MEMBER_NAME, pin: MEMBER_PIN });

  const roomsLayout = await evaluate(client, `(() => {
    const trigger = document.querySelector('#rooms-profile-menu .profile-menu__trigger').getBoundingClientRect();
    return {
      width: innerWidth,
      dpr: devicePixelRatio,
      visualScale: visualViewport.scale,
      pageWidth: document.documentElement.scrollWidth,
      bodyZoom: getComputedStyle(document.body).zoom,
      trigger: { left: trigger.left, right: trigger.right, width: trigger.width, height: trigger.height },
      nameDisplay: getComputedStyle(document.querySelector('#rooms-profile-menu .profile-menu__trigger-name')).display,
    };
  })()`);
  assert.ok(roomsLayout.dpr >= 1.9 && roomsLayout.width <= 640,
    `the isolated Chromium profile applies 200% browser zoom: ${JSON.stringify(roomsLayout)}`);
  assert.equal(roomsLayout.visualScale, 1, 'actual browser zoom is not pinch/page-scale magnification');
  assert.equal(roomsLayout.bodyZoom, '1', 'the page does not simulate browser zoom with CSS');
  assert.equal(roomsLayout.nameDisplay, 'none', 'avatar-only trigger applies at the zoomed CSS viewport');
  assert.ok(roomsLayout.pageWidth <= roomsLayout.width, 'Rooms has no page-level horizontal overflow at 200% zoom');
  assert.ok(roomsLayout.trigger.width >= 44 && roomsLayout.trigger.height >= 44);
  await evaluate(client, "document.querySelector('#rooms-profile-menu .profile-menu__trigger').click()");
  const roomsPanel = await evaluate(client, `(() => {
    const panel = document.querySelector('#rooms-profile-menu [role=menu]');
    const box = panel.getBoundingClientRect();
    const actions = [...panel.querySelectorAll('[role=menuitem]')].map((item) => item.getBoundingClientRect());
    return { left: box.left, right: box.right, top: box.top, bottom: Math.max(...actions.map((item) => item.bottom)), width: innerWidth, height: innerHeight, actions: actions.map((item) => item.height) };
  })()`);
  assert.ok(roomsPanel.left >= 0 && roomsPanel.right <= roomsPanel.width, 'the Rooms menu stays within the zoomed viewport');
  assert.ok(roomsPanel.top >= 0, 'the menu begins within the zoomed viewport');
  assert.equal(roomsPanel.actions.every((height) => height >= 48), true);
  const constrainedPanel = await evaluate(client, `(() => {
    const panel = document.querySelector('#rooms-profile-menu [role=menu]');
    const box = panel.getBoundingClientRect();
    return { viewportHeight: innerHeight, top: box.top, bottom: box.bottom, height: box.height, clientHeight: panel.clientHeight, scrollHeight: panel.scrollHeight, overflowY: getComputedStyle(panel).overflowY };
  })()`);
  assert.ok(constrainedPanel.bottom <= constrainedPanel.viewportHeight, 'the constrained panel stays inside a short zoomed viewport');
  assert.ok(constrainedPanel.scrollHeight > constrainedPanel.clientHeight, 'long menu contents scroll inside the constrained panel');
  assert.equal(constrainedPanel.overflowY, 'auto');
  await press(client, 'End');
  const focusedLogout = await evaluate(client, `(() => {
    const panel = document.querySelector('#rooms-profile-menu [role=menu]');
    const logout = panel.querySelector('.profile-menu__logout').getBoundingClientRect();
    const box = panel.getBoundingClientRect();
    return { label: document.activeElement.textContent.trim(), visible: logout.top >= box.top && logout.bottom <= box.bottom };
  })()`);
  assert.deepEqual(focusedLogout, { label: 'Logout', visible: true }, 'keyboard navigation scrolls the final action into view');

  await client.send('Page.navigate', { url: `${fixture.baseUrl}/vote/${room.id}` });
  assert.equal(await waitFor(client, `location.pathname === '/vote/${room.id}' && Boolean(document.querySelector('#protected-content') && !document.querySelector('#protected-content').hidden)`), true,
    'the voting page remains reachable at actual browser zoom');
  const voteLayout = await evaluate(client, `(() => {
    const back = document.querySelector('#back-to-rooms').getBoundingClientRect();
    const trigger = document.querySelector('#vote-profile-menu .profile-menu__trigger').getBoundingClientRect();
    return { width: innerWidth, pageWidth: document.documentElement.scrollWidth, back: { right: back.right, width: back.width, height: back.height }, trigger: { left: trigger.left, right: trigger.right, width: trigger.width, height: trigger.height }, nameDisplay: getComputedStyle(document.querySelector('#vote-profile-menu .profile-menu__trigger-name')).display };
  })()`);
  assert.equal(voteLayout.width, roomsLayout.width);
  assert.ok(voteLayout.pageWidth <= voteLayout.width, 'the voting page has no page-level horizontal overflow at 200% zoom');
  assert.ok(voteLayout.back.right <= voteLayout.trigger.left, 'Back stays to the left of the profile trigger');
  assert.ok(voteLayout.back.width >= 44 && voteLayout.back.height >= 44);
  assert.ok(voteLayout.trigger.width >= 44 && voteLayout.trigger.height >= 44);
  assert.equal(voteLayout.nameDisplay, 'none');
  await evaluate(client, "document.querySelector('#vote-profile-menu .profile-menu__trigger').click()");
  const votePanel = await evaluate(client, `(() => {
    const panel = document.querySelector('#vote-profile-menu [role=menu]');
    const box = panel.getBoundingClientRect();
    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: innerWidth, height: innerHeight, scrollHeight: panel.scrollHeight, clientHeight: panel.clientHeight };
  })()`);
  assert.ok(votePanel.left >= 0 && votePanel.right <= votePanel.width, 'the voting menu stays within the zoomed viewport');
  assert.ok(votePanel.top >= 0 && votePanel.bottom <= votePanel.height, 'the voting menu panel stays within the short viewport');
  assert.ok(votePanel.scrollHeight > votePanel.clientHeight, 'the voting menu scrolls when the viewport is too short');
  await press(client, 'End');
  const zoomedVoteLogout = await evaluate(client, `(() => {
    const panel = document.querySelector('#vote-profile-menu [role=menu]');
    const logout = panel.querySelector('.profile-menu__logout').getBoundingClientRect();
    const box = panel.getBoundingClientRect();
    return { label: document.activeElement.textContent.trim(), visible: logout.top >= box.top && logout.bottom <= box.bottom };
  })()`);
  assert.deepEqual(zoomedVoteLogout, { label: 'Logout', visible: true }, 'the final voting-menu action is reachable by keyboard scroll');
  t.diagnostic(`Actual Chromium 200% zoom layout: ${JSON.stringify({ rooms: roomsLayout, roomsPanel, vote: voteLayout, votePanel })}`);
  assert.deepEqual(client.events.filter((event) => event.method === 'Runtime.exceptionThrown'), [], 'the zoomed browser reports no uncaught script exceptions');
});
