import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import test from 'node:test';
import { LEGACY_ROOM_ID } from '../src/room-contract.js';
import { createServer } from '../src/server.js';
import { removeProfileWithRetry } from './helpers/chromium-profile-cleanup.js';
import { chromiumReadinessTimeoutMs, readDevToolsPort, spawnChromium, stopChromium } from './helpers/chromium-startup.js';

const chromePath = process.env.CHROME_BIN ?? [
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/opt/google/chrome/chrome',
  '/opt/data/tmp/chrome/opt/google/chrome/chrome',
].find((path) => existsSync(path));
if (!chromePath) throw new Error('Issue 39 browser coverage requires real Chromium; refusing to skip.');

const ENV = { ADMIN_NAME: 'Issue 39 Browser Admin', ADMIN_PIN: '4826', PIN_PEPPER: 'issue-39-browser-synthetic-pepper' };
const NOW = new Date('2026-10-27T04:00:00.000Z');

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
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id) return;
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

async function openPage(client, url, cookie, { initScript } = {}) {
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Network.enable');
  if (initScript) await client.send('Page.addScriptToEvaluateOnNewDocument', { source: initScript });
  const [name, value] = cookie.split('=', 2);
  await client.send('Network.setCookie', { url, name, value, path: '/', httpOnly: true });
  await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await client.send('Page.navigate', { url });
}

async function createFixture() {
  const directory = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'run-together-issue-39-browser-'));
  const server = createServer({ databasePath: join(directory, 'preview.sqlite'), env: ENV, now: () => NOW });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    directory,
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function cookieFrom(response) { return response.headers.get('set-cookie')?.split(';', 1)[0] ?? ''; }

async function register(baseUrl, name) {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST', headers: { origin: baseUrl, 'content-type': 'application/json' },
    body: JSON.stringify({ name, pin: '0042', pinConfirmation: '0042' }),
  });
  assert.equal(response.status, 201);
  const cookie = cookieFrom(response);
  const session = await fetch(`${baseUrl}/api/session`, { headers: { cookie } }).then((result) => result.json());
  return { cookie, csrfToken: session.csrfToken };
}

async function loginAdmin(baseUrl) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { origin: baseUrl, 'content-type': 'application/json' },
    body: JSON.stringify({ name: ENV.ADMIN_NAME, pin: ENV.ADMIN_PIN }),
  });
  assert.equal(response.status, 200);
  const cookie = cookieFrom(response);
  const session = await fetch(`${baseUrl}/api/session`, { headers: { cookie } }).then((result) => result.json());
  return { cookie, csrfToken: session.csrfToken };
}

async function createRoom(baseUrl, user, title) {
  const response = await fetch(`${baseUrl}/api/rooms`, {
    method: 'POST',
    headers: { origin: baseUrl, cookie: user.cookie, 'x-csrf-token': user.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  });
  assert.equal(response.status, 201);
  return (await response.json()).room;
}

async function enterRoom(baseUrl, user, roomId) {
  const response = await fetch(`${baseUrl}/api/rooms/${encodeURIComponent(roomId)}/enter`, {
    method: 'POST',
    headers: { origin: baseUrl, cookie: user.cookie, 'x-csrf-token': user.csrfToken, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).room.id, roomId);
}

async function saveScreenshot(client, path) {
  const image = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.from(image.data, 'base64'), { flag: 'wx' });
  return path;
}

test('Issue 39 real Chromium deletion controls are accessible, cancel safely, update tabs, and leave Create room', async (t) => {
  const fixture = await createFixture();
  const owner = await register(fixture.baseUrl, 'Issue 39 Browser Owner');
  const admin = await loginAdmin(fixture.baseUrl);
  const ownerRoom = await createRoom(fixture.baseUrl, owner, 'Room deletion browser check');
  const adminRoom = await createRoom(fixture.baseUrl, owner, 'Admin-managed room');
  await enterRoom(fixture.baseUrl, owner, ownerRoom.id);
  const ownerId = fixture.server.database.prepare('SELECT id FROM users WHERE name_key = ?').get('issue 39 browser owner').id;
  assert.equal(fixture.server.database.prepare('SELECT COUNT(*) AS count FROM room_memberships WHERE room_id = ? AND user_id = ?')
    .get(ownerRoom.id, ownerId).count, 1, 'the test owner has entered the board room');
  const directBoard = await fetch(`${fixture.baseUrl}/vote/${ownerRoom.id}`, { headers: { cookie: owner.cookie } });
  assert.equal(directBoard.status, 200, await directBoard.clone().text());
  const adminId = fixture.server.database.prepare("SELECT id FROM users WHERE role = 'admin'").get().id;
  assert.equal(fixture.server.database.prepare('SELECT COUNT(*) AS count FROM room_memberships WHERE room_id = ? AND user_id = ?')
    .get(adminRoom.id, adminId).count, 0, 'the application admin has not entered the owner room');

  const ownerProfile = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'run-together-issue-39-owner-chrome-'));
  const adminProfile = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'run-together-issue-39-admin-chrome-'));
  const screenshotBase = join(process.cwd(), 'outputs', `issue-39-browser-${Date.now()}`);
  const startupStartedAt = performance.now();
  const chromiumArgs = [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
    '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0',
  ];
  const ownerBrowser = spawnChromium(chromePath, [...chromiumArgs, `--user-data-dir=${ownerProfile}`, 'about:blank']);
  const adminBrowser = spawnChromium(chromePath, [...chromiumArgs, `--user-data-dir=${adminProfile}`, 'about:blank']);
  let ownerList;
  let board;
  let adminList;
  t.after(async () => {
    ownerList?.close();
    board?.close();
    adminList?.close();
    await stopChromium(ownerBrowser);
    await stopChromium(adminBrowser);
    await removeProfileWithRetry(ownerProfile);
    await removeProfileWithRetry(adminProfile);
    await fixture.close();
  });
  const [ownerPort, adminPort] = await Promise.all([
    readDevToolsPort(ownerProfile, ownerBrowser, { timeoutMs: chromiumReadinessTimeoutMs }),
    readDevToolsPort(adminProfile, adminBrowser, { timeoutMs: chromiumReadinessTimeoutMs }),
  ]);
  t.diagnostic(`Isolated Chromium profiles launch-to-DevTools readiness ${(performance.now() - startupStartedAt).toFixed(1)}ms each; executable: ${ownerBrowser.spawnfile}.`);
  const [ownerTarget, boardTarget, adminTarget] = await Promise.all([
    createTarget(ownerPort), createTarget(ownerPort), createTarget(adminPort),
  ]);
  ownerList = createCdpClient(ownerTarget.webSocketDebuggerUrl);
  board = createCdpClient(boardTarget.webSocketDebuggerUrl);
  adminList = createCdpClient(adminTarget.webSocketDebuggerUrl);
  await Promise.all([
    openPage(ownerList, `${fixture.baseUrl}/rooms`, owner.cookie),
    openPage(board, `${fixture.baseUrl}/vote/${ownerRoom.id}`, owner.cookie, { initScript: `(() => {
      let factory;
      Object.defineProperty(window, 'io', { configurable: true, get: () => factory, set: (value) => {
        factory = (...args) => {
          const socket = value(...args);
          window.__issue39Socket = socket;
          return socket;
        };
      } });
    })();` }),
    openPage(adminList, `${fixture.baseUrl}/rooms`, admin.cookie),
  ]);
  assert.equal(await waitFor(ownerList, `Boolean(document.querySelector('#rooms-content') && !document.querySelector('#rooms-content').hidden && document.querySelectorAll('.room-card').length === 3)`), true,
    'the owner sees the legacy room and both created rooms');
  const boardLoaded = await waitFor(board, `Boolean(document.querySelector('#protected-content') && !document.querySelector('#protected-content').hidden && document.querySelector('#room-heading')?.textContent === 'Room deletion browser check')`);
  if (!boardLoaded) t.diagnostic(`Board state: ${JSON.stringify(await evaluate(board, `(() => ({ url: location.href, heading: document.querySelector('#room-heading')?.textContent, hidden: document.querySelector('#protected-content')?.hidden, body: document.body.innerText.slice(0, 400) }))()`))}`);
  assert.equal(boardLoaded, true,
    'the second tab has loaded and subscribed to the selected internal room');
  assert.equal(await waitFor(adminList, `Boolean(document.querySelector('#rooms-content') && !document.querySelector('#rooms-content').hidden && document.querySelectorAll('.room-card').length === 3)`), true,
    'the application-admin list has loaded');

  const ownerControls = await evaluate(ownerList, `(() => {
    const card = document.querySelector('.room-card[data-room-id="${ownerRoom.id}"]');
    const remove = card.querySelector('.room-card__delete');
    const edit = card.querySelector('.room-card__edit');
    const actions = card.querySelector('.room-card__actions');
    const removeRect = remove.getBoundingClientRect();
    const textNodes = [...card.querySelectorAll('.room-card__number,.room-card__owner,.room-card__title,.room-card__venue,.room-card__time,.room-card__voter-count,.room-card__dates:not([hidden]) strong,.room-card__date-value')];
    const collisions = textNodes.flatMap((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0 && rect.left < removeRect.right && rect.right > removeRect.left && rect.top < removeRect.bottom && rect.bottom > removeRect.top).map((rect) => element.textContent);
    });
    return { deleteName: remove.getAttribute('aria-label'), deleteVisible: !remove.hidden && getComputedStyle(remove).display !== 'none', deleteTarget: [removeRect.width, removeRect.height], editVisible: !edit.hidden && getComputedStyle(edit).display !== 'none', actionPosition: getComputedStyle(actions).position, collisions };
  })()`);
  assert.deepEqual({ ...ownerControls, deleteTarget: undefined }, {
    deleteName: 'Delete Room deletion browser check', deleteVisible: true,
    deleteTarget: undefined, editVisible: true, actionPosition: 'static', collisions: [],
  }, 'owner sees accessible controls in normal flow without overlapping card text');
  assert.ok(ownerControls.deleteTarget[0] >= 44 && ownerControls.deleteTarget[1] >= 44,
    'the owner delete control meets the 44px minimum target size');
  await ownerList.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 844, deviceScaleFactor: 2, mobile: true });
  const narrow = await evaluate(ownerList, `(() => ({ viewport: innerWidth, page: document.documentElement.scrollWidth, button: (() => { const r = document.querySelector('.room-card[data-room-id="${ownerRoom.id}"] .room-card__delete').getBoundingClientRect(); return [r.width, r.height]; })() }))()`);
  assert.ok(narrow.page <= narrow.viewport, 'the delete affordance fits a 320px viewport without page overflow');
  assert.ok(narrow.button[0] >= 44 && narrow.button[1] >= 44);
  await evaluate(ownerList, `document.querySelector('.room-card[data-room-id="${ownerRoom.id}"]').scrollIntoView({ block: 'center' })`);
  const ownerScreenshot = await saveScreenshot(ownerList, `${screenshotBase}-owner-list.png`);
  t.diagnostic(`Owner room-list screenshot: ${ownerScreenshot}`);

  await evaluate(ownerList, `(() => { window.__issue39ConfirmMessages = []; window.confirm = (message) => { window.__issue39ConfirmMessages.push(message); return false; }; const button = document.querySelector('.room-card[data-room-id="${ownerRoom.id}"] .room-card__delete'); button.focus(); return document.activeElement === button; })()`);
  assert.equal(await evaluate(ownerList, `document.activeElement?.getAttribute('aria-label') === 'Delete Room deletion browser check'`), true,
    'the delete button receives keyboard focus');
  await ownerList.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', text: ' ', unmodifiedText: ' ', windowsVirtualKeyCode: 32 });
  await ownerList.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
  assert.equal(await waitFor(ownerList, 'window.__issue39ConfirmMessages.length === 1'), true, 'Space activates the delete button and the named confirmation');
  const confirmationText = await evaluate(ownerList, 'window.__issue39ConfirmMessages[0]');
  assert.equal(confirmationText, 'Permanently delete “Room deletion browser check”? Its votes, proposals, schedules, and memberships will be permanently removed. This cannot be undone.');
  assert.match(confirmationText, /votes, proposals, schedules, and memberships will be permanently removed/);
  assert.equal(fixture.server.database.prepare('SELECT COUNT(*) AS count FROM rooms WHERE id = ?').get(ownerRoom.id).count, 1,
    'Cancel leaves the room and its data unchanged');
  assert.equal(await evaluate(board, `location.pathname === '/vote/${ownerRoom.id}'`), true,
    'Cancel leaves the other tab on the selected room');

  await evaluate(ownerList, `(() => { window.confirm = () => true; document.querySelector('.room-card[data-room-id="${ownerRoom.id}"] .room-card__delete').click(); })()`);
  assert.equal(await waitFor(ownerList, `!document.querySelector('.room-card[data-room-id="${ownerRoom.id}"]')`), true,
    'the connected room list removes the deleted card');
  assert.equal(await waitFor(board, `location.pathname === '/rooms'`), true,
    'the active board tab returns to the room list after the realtime deletion');
  assert.equal(fixture.server.database.prepare('SELECT COUNT(*) AS count FROM rooms WHERE id = ?').get(ownerRoom.id).count, 0);
  assert.equal(fixture.server.database.prepare('SELECT COUNT(*) AS count FROM room_identity_ledger WHERE room_id = ?').get(ownerRoom.id).count, 1);

  const reconnectRoom = await createRoom(fixture.baseUrl, owner, 'Reconnect after deletion');
  await enterRoom(fixture.baseUrl, owner, reconnectRoom.id);
  await board.send('Page.navigate', { url: `${fixture.baseUrl}/vote/${reconnectRoom.id}` });
  assert.equal(await waitFor(board, `Boolean(document.querySelector('#protected-content') && !document.querySelector('#protected-content').hidden && document.querySelector('#room-heading')?.textContent === 'Reconnect after deletion' && window.__issue39Socket?.connected)`), true,
    'the owner can enter a different room and its board socket connects');
  await board.send('Network.emulateNetworkConditions', {
    offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0, connectionType: 'none',
  });
  assert.equal(await waitFor(board, 'window.__issue39Socket?.connected === false', 10000), true,
    'the active board socket disconnects when the browser network is taken offline');
  const offlineDelete = await fetch(`${fixture.baseUrl}/api/rooms/${encodeURIComponent(reconnectRoom.id)}`, {
    method: 'DELETE',
    headers: { origin: fixture.baseUrl, cookie: admin.cookie, 'x-csrf-token': admin.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ confirmation: true }),
  });
  assert.equal(offlineDelete.status, 200, 'the application admin deletes the room while the board tab is disconnected');
  assert.deepEqual(await offlineDelete.json(), { deletedRoomId: reconnectRoom.id });
  await board.send('Network.emulateNetworkConditions', {
    offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1, connectionType: 'wifi',
  });
  assert.equal(await waitFor(board, `location.pathname === '/rooms'`, 15000), true,
    'on reconnect, the stale board subscription receives ROOM_NOT_FOUND and safely returns to rooms');

  const adminControls = await evaluate(adminList, `(() => {
    const card = document.querySelector('.room-card[data-room-id="${adminRoom.id}"]');
    return { deleteName: card.querySelector('.room-card__delete').getAttribute('aria-label'), deleteHidden: card.querySelector('.room-card__delete').hidden, editHidden: card.querySelector('.room-card__edit').hidden, editDisplay: getComputedStyle(card.querySelector('.room-card__edit')).display };
  })()`);
  assert.deepEqual(adminControls, {
    deleteName: 'Delete Admin-managed room', deleteHidden: false, editHidden: true, editDisplay: 'none',
  }, 'application admin sees Delete on another owner room without gaining Edit');
  await evaluate(adminList, `document.querySelector('.room-card[data-room-id="${adminRoom.id}"]').scrollIntoView({ block: 'center' })`);
  assert.equal(await saveScreenshot(adminList, `${screenshotBase}-admin-list.png`), `${screenshotBase}-admin-list.png`);

  await evaluate(adminList, `(() => { window.confirm = () => true; document.querySelector('.room-card[data-room-id="${adminRoom.id}"] .room-card__delete').click(); })()`);
  assert.equal(await waitFor(adminList, `!document.querySelector('.room-card[data-room-id="${adminRoom.id}"]')`), true,
    'application admin can delete a room without joining it');
  await evaluate(adminList, `(() => { window.confirm = () => true; document.querySelector('.room-card[data-room-id="${LEGACY_ROOM_ID}"] .room-card__delete').click(); })()`);
  assert.equal(await waitFor(adminList, `!document.querySelector('.room-card[data-room-id="${LEGACY_ROOM_ID}"]')`), true,
    'application admin can delete the final legacy room');
  assert.equal(await waitFor(ownerList, '!document.querySelector("#rooms-empty").hidden'), true,
    'the owner list receives deletions and renders the empty state');
  assert.equal(await evaluate(ownerList, `(() => ({ createVisible: !document.querySelector('#create-room-form button[type=submit]').disabled, emptyVisible: !document.querySelector('#rooms-empty').hidden, cards: document.querySelectorAll('.room-card').length }))()`)
    .then((state) => state.createVisible && state.emptyVisible && state.cards === 0), true,
  'Create room remains available when no rooms remain');
  await evaluate(ownerList, `document.querySelector('#rooms-empty').scrollIntoView({ block: 'center' })`);
  const emptyScreenshot = await saveScreenshot(ownerList, `${screenshotBase}-empty-list.png`);
  t.diagnostic(`Admin room-list screenshot: ${screenshotBase}-admin-list.png`);
  t.diagnostic(`Empty room-list screenshot: ${emptyScreenshot}`);
  assert.equal(fixture.server.database.prepare('SELECT COUNT(*) AS count FROM rooms').get().count, 0);
});
