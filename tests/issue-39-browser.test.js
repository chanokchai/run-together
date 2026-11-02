import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
  const eventListeners = new Map();
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.method) {
      eventListeners.get(message.method)?.forEach((listener) => listener(message.params));
      return;
    }
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
      let timer;
      try {
        return await Promise.race([result, new Promise((_, reject) => {
          timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`Timed out waiting for CDP command ${method}`));
          }, 12_000);
        })]);
      } finally {
        clearTimeout(timer);
      }
    },
    onEvent(method, listener) {
      const listeners = eventListeners.get(method) ?? new Set();
      listeners.add(listener);
      eventListeners.set(method, listeners);
    },
    offEvent(method, listener) {
      const listeners = eventListeners.get(method);
      listeners?.delete(listener);
      if (listeners?.size === 0) eventListeners.delete(method);
    },
    close() { socket.close(); },
  };
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.result?.description ?? result.exceptionDetails.text);
  return result.result.value;
}

async function clickSelector(client, selector) {
  const point = await evaluate(client, `(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    target.scrollIntoView({ block: 'center' });
    const box = target.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  })()`);
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
}

async function waitFor(client, expression, timeoutMs = 8000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await evaluate(client, expression)) return true;
    await delay(50);
  }
  return false;
}

function waitForCdpEvent(client, method, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.offEvent(method, listener);
      reject(new Error(`Timed out waiting for CDP event ${method}`));
    }, timeoutMs);
    const listener = (params) => {
      clearTimeout(timer);
      client.offEvent(method, listener);
      resolve(params);
    };
    client.onEvent(method, listener);
  });
}

function waitForCdpEvents(client, method, count, matches, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const events = [];
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      client.offEvent(method, listener);
    };
    const listener = (params) => {
      if (!matches(params)) return;
      events.push(params);
      if (events.length === count) {
        cleanup();
        resolve(events);
      }
    };
    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${count} matching CDP ${method} events; received ${events.length}`));
    }, timeoutMs);
    client.onEvent(method, listener);
  });
}

async function readPausedJson(client, event) {
  const result = await client.send('Fetch.getResponseBody', { requestId: event.requestId });
  const text = result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body;
  return JSON.parse(text);
}

function fetchGateScript() {
  return `(() => {
    const originalFetch = window.fetch.bind(window);
    const rules = [];
    window.__issue39Held = {};
    window.__issue39Releases = {};
    window.__issue39FetchLog = [];
    window.__issue39HoldNext = (key, method, path) => rules.push({ key, method: method.toUpperCase(), path });
    window.__issue39Release = (key) => { window.__issue39Releases[key]?.(); delete window.__issue39Releases[key]; };
    window.fetch = async (...args) => {
      const input = args[0];
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      const method = String(args[1]?.method ?? input.method ?? 'GET').toUpperCase();
      const response = await originalFetch(...args);
      window.__issue39FetchLog.push({ method, path: url.pathname, status: response.status });
      const index = rules.findIndex((rule) => rule.method === method && rule.path === url.pathname);
      if (index !== -1) {
        const [{ key }] = rules.splice(index, 1);
        let body = null;
        try { body = await response.clone().json(); } catch {}
        window.__issue39Held[key] = { method, path: url.pathname, status: response.status, body };
        await new Promise((resolve) => { window.__issue39Releases[key] = resolve; });
      }
      return response;
    };
  })();`;
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
  await enterRoom(fixture.baseUrl, owner, adminRoom.id);
  const seededVote = await fetch(`${fixture.baseUrl}/api/rooms/${ownerRoom.id}/votes/2026-10-28`, {
    method: 'PUT', headers: { origin: fixture.baseUrl, cookie: owner.cookie, 'x-csrf-token': owner.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ selected: true }),
  });
  assert.equal(seededVote.status, 200, 'the cancellation case starts with a real dependent vote');
  const seededEvent = await fetch(`${fixture.baseUrl}/api/rooms/${ownerRoom.id}/events/2026-10-28`, {
    method: 'POST', headers: { origin: fixture.baseUrl, cookie: owner.cookie, 'x-csrf-token': owner.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: randomUUID() }),
  });
  assert.equal(seededEvent.status, 201, 'the cancellation case starts with a real event and retry ledger row');
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
  let unrelatedBoard;
  let adminList;
  t.after(async () => {
    ownerList?.close();
    board?.close();
    unrelatedBoard?.close();
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
  const [ownerTarget, boardTarget, unrelatedBoardTarget, adminTarget] = await Promise.all([
    createTarget(ownerPort), createTarget(ownerPort), createTarget(ownerPort), createTarget(adminPort),
  ]);
  ownerList = createCdpClient(ownerTarget.webSocketDebuggerUrl);
  board = createCdpClient(boardTarget.webSocketDebuggerUrl);
  unrelatedBoard = createCdpClient(unrelatedBoardTarget.webSocketDebuggerUrl);
  adminList = createCdpClient(adminTarget.webSocketDebuggerUrl);
  await Promise.all([
    openPage(ownerList, `${fixture.baseUrl}/rooms`, owner.cookie, { initScript: fetchGateScript() }),
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
    openPage(unrelatedBoard, `${fixture.baseUrl}/vote/${adminRoom.id}`, owner.cookie, { initScript: `(() => {
      let factory;
      Object.defineProperty(window, 'io', { configurable: true, get: () => factory, set: (value) => {
        factory = (...args) => { const socket = value(...args); window.__issue39Socket = socket; return socket; };
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
  assert.equal(await waitFor(unrelatedBoard, `Boolean(document.querySelector('#protected-content') && !document.querySelector('#protected-content').hidden && document.querySelector('#room-heading')?.textContent === 'Admin-managed room' && window.__issue39Socket?.connected)`), true,
    'a second same-session tab is open and subscribed to an unrelated internal room');
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

  await evaluate(ownerList, `(() => { const button = document.querySelector('.room-card[data-room-id="${ownerRoom.id}"] .room-card__delete'); button.focus(); return document.activeElement === button; })()`);
  assert.equal(await evaluate(ownerList, `document.activeElement?.getAttribute('aria-label') === 'Delete Room deletion browser check'`), true,
    'the delete button receives keyboard focus');
  const dependentState = () => ({
    room: fixture.server.database.prepare('SELECT * FROM rooms WHERE id = ?').get(ownerRoom.id),
    votes: fixture.server.database.prepare('SELECT * FROM votes WHERE room_id = ? ORDER BY vote_date, user_id').all(ownerRoom.id),
    events: fixture.server.database.prepare('SELECT * FROM run_events WHERE room_id = ? ORDER BY event_date').all(ownerRoom.id),
    memberships: fixture.server.database.prepare('SELECT * FROM room_memberships WHERE room_id = ? ORDER BY user_id').all(ownerRoom.id),
    retries: fixture.server.database.prepare('SELECT * FROM run_event_requests WHERE room_id = ? ORDER BY request_id').all(ownerRoom.id),
  });
  const beforeCancel = dependentState();
  assert.ok(beforeCancel.votes.length && beforeCancel.events.length && beforeCancel.memberships.length && beforeCancel.retries.length,
    'the cancellation case includes seeded votes, events, memberships, and retry data');
  const deleteConfirmationMessage = 'Permanently delete “Room deletion browser check”? Its votes, proposals, schedules, and memberships will be permanently removed. This cannot be undone.';
  const cancelDialogPromise = waitForCdpEvent(ownerList, 'Page.javascriptDialogOpening');
  await ownerList.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', text: ' ', unmodifiedText: ' ', windowsVirtualKeyCode: 32 });
  const cancelKeyUp = ownerList.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
  const cancelDialog = await cancelDialogPromise;
  assert.equal(cancelDialog.type, 'confirm', 'Space opens the browser native confirmation dialog');
  assert.equal(cancelDialog.message, deleteConfirmationMessage);
  assert.match(cancelDialog.message, /votes, proposals, schedules, and memberships will be permanently removed/);
  await ownerList.send('Page.handleJavaScriptDialog', { accept: false });
  await cancelKeyUp;
  assert.equal(fixture.server.database.prepare('SELECT COUNT(*) AS count FROM rooms WHERE id = ?').get(ownerRoom.id).count, 1,
    'Cancel leaves the room present');
  assert.deepEqual(dependentState(), beforeCancel, 'Cancel preserves every seeded dependent row exactly');
  assert.equal(await evaluate(ownerList, `window.__issue39FetchLog.filter(({ method, path }) => method === 'DELETE' && path === '/api/rooms/${ownerRoom.id}').length`), 0,
    'native confirmation Cancel sends no room DELETE request');
  assert.equal(await evaluate(board, `location.pathname === '/vote/${ownerRoom.id}'`), true,
    'Cancel leaves the other tab on the selected room');

  await evaluate(ownerList, `(() => { window.__issue39HoldNext('delete-response', 'DELETE', '/api/rooms/${ownerRoom.id}'); window.__issue39DeleteButton = document.querySelector('.room-card[data-room-id="${ownerRoom.id}"] .room-card__delete'); })()`);
  const confirmDialogPromise = waitForCdpEvent(ownerList, 'Page.javascriptDialogOpening');
  const confirmClick = clickSelector(ownerList, `.room-card[data-room-id="${ownerRoom.id}"] .room-card__delete`);
  const confirmDialog = await confirmDialogPromise;
  assert.equal(confirmDialog.type, 'confirm', 'the second activation opens the browser native confirmation dialog');
  assert.equal(confirmDialog.message, deleteConfirmationMessage);
  await ownerList.send('Page.handleJavaScriptDialog', { accept: true });
  await confirmClick;
  assert.equal(await waitFor(ownerList, "Boolean(window.__issue39Held['delete-response'])"), true,
    'the delete request remains pending after the server commits it');
  assert.equal(await evaluate(ownerList, "window.__issue39Held['delete-response'].status"), 200);
  await evaluate(ownerList, "window.__issue39DeleteButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))");
  assert.equal(await evaluate(ownerList, `window.__issue39FetchLog.filter(({ method, path }) => method === 'DELETE' && path === '/api/rooms/${ownerRoom.id}').length`), 1,
    'duplicate activation while the first request is pending sends exactly one DELETE');
  assert.equal(await waitFor(ownerList, `!document.querySelector('.room-card[data-room-id="${ownerRoom.id}"]')`), true,
    'the connected room list removes the deleted card');
  assert.equal(await waitFor(board, `location.pathname === '/rooms'`), true,
    'the active board tab returns to the room list after the realtime deletion');
  assert.equal(await evaluate(unrelatedBoard, `location.pathname === '/vote/${adminRoom.id}' && !document.querySelector('#protected-content').hidden`), true,
    'deleting one room leaves the unrelated same-session room tab open');
  await evaluate(unrelatedBoard, `document.querySelector('.vote-card[data-date="2026-10-29"]').click()`);
  assert.equal(await waitFor(unrelatedBoard, `document.querySelector('.vote-card[data-date="2026-10-29"]')?.dataset.selected === 'true'`), true,
    'the unrelated tab can save a vote while the other room remains deleted');
  assert.equal(fixture.server.database.prepare('SELECT COUNT(*) AS count FROM votes WHERE room_id = ? AND user_id = ? AND vote_date = ?')
    .get(adminRoom.id, ownerId, '2026-10-29').count, 1, 'the vote is stored only under the unrelated internal room ID');
  await evaluate(unrelatedBoard, `document.querySelector('.run-event-day-action[data-date="2026-10-29"]').click()`);
  assert.equal(await waitFor(unrelatedBoard, `document.querySelector('.run-event-banner[data-date="2026-10-29"]')?.textContent.includes('Proposed')`), true,
    'the unrelated tab can create an event while the other room remains deleted');
  assert.equal(fixture.server.database.prepare('SELECT COUNT(*) AS count FROM run_events WHERE room_id = ? AND event_date = ?')
    .get(adminRoom.id, '2026-10-29').count, 1);
  assert.equal(fixture.server.database.prepare('SELECT COUNT(*) AS count FROM rooms WHERE id = ?').get(ownerRoom.id).count, 0);
  assert.equal(fixture.server.database.prepare('SELECT COUNT(*) AS count FROM room_identity_ledger WHERE room_id = ?').get(ownerRoom.id).count, 1);
  assert.equal(fixture.server.database.prepare('SELECT COUNT(*) AS count FROM votes WHERE room_id = ?').get(ownerRoom.id).count, 0);
  assert.equal(fixture.server.database.prepare('SELECT COUNT(*) AS count FROM run_events WHERE room_id = ?').get(ownerRoom.id).count, 0);
  await evaluate(ownerList, "window.__issue39Release('delete-response')");

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
  assert.equal(await waitFor(unrelatedBoard, `location.pathname === '/rooms'`), true,
    'the unrelated active board tab safely exits when its own room is deleted');
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

test('Issue 39 discards held successful entry and stale list responses after deletion', async (t) => {
  const fixture = await createFixture();
  const owner = await register(fixture.baseUrl, 'Issue 39 Late Entry Owner');
  const admin = await loginAdmin(fixture.baseUrl);
  const room = await createRoom(fixture.baseUrl, owner, 'Late entry after deletion');
  const profile = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'run-together-issue-39-late-entry-chrome-'));
  const browser = spawnChromium(chromePath, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
    '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0',
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
  client = createCdpClient((await createTarget(port)).webSocketDebuggerUrl);
  await openPage(client, `${fixture.baseUrl}/rooms`, owner.cookie, { initScript: fetchGateScript() });
  const card = `.room-card[data-room-id="${room.id}"]`;
  assert.equal(await waitFor(client, `Boolean(document.querySelector(${JSON.stringify(card + ' .room-card__entry')}))`), true,
    'the target room card is loaded before requests are held');

  await evaluate(client, `window.__issue39HoldNext('stale-list', 'GET', '/api/rooms')`);
  const update = await fetch(`${fixture.baseUrl}/api/rooms/${encodeURIComponent(room.id)}`, {
    method: 'PUT', headers: { origin: fixture.baseUrl, cookie: owner.cookie, 'x-csrf-token': owner.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ venue: 'Updated before deletion' }),
  });
  assert.equal(update.status, 200);
  assert.equal(await waitFor(client, "Boolean(window.__issue39Held['stale-list'])"), true,
    'a pre-deletion room-list response is held after the server returned its snapshot');

  await evaluate(client, `window.__issue39HoldNext('late-entry', 'POST', '/api/rooms/${room.id}/enter')`);
  await evaluate(client, `document.querySelector(${JSON.stringify(card + ' .room-card__entry')}).click()`);
  assert.equal(await waitFor(client, "Boolean(window.__issue39Held['late-entry'])"), true,
    'the genuine successful room-entry response is held before the page handles it');
  assert.equal(await evaluate(client, "window.__issue39Held['late-entry'].status"), 200);
  assert.equal(await evaluate(client, "window.__issue39Held['late-entry'].body.room.id"), room.id);

  const deletion = await fetch(`${fixture.baseUrl}/api/rooms/${encodeURIComponent(room.id)}`, {
    method: 'DELETE', headers: { origin: fixture.baseUrl, cookie: admin.cookie, 'x-csrf-token': admin.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ confirmation: true }),
  });
  assert.equal(deletion.status, 200);
  assert.equal(await waitFor(client, `!document.querySelector(${JSON.stringify(card)})`), true,
    'room:deleted removes the card while both old successful responses remain held');
  assert.equal(await evaluate(client, 'location.pathname'), '/rooms');

  await evaluate(client, "window.__issue39Release('stale-list')");
  await delay(100);
  assert.equal(await evaluate(client, `!document.querySelector(${JSON.stringify(card)})`), true,
    'the pre-deletion list response cannot restore the deleted room card');

  await evaluate(client, "window.__issue39Release('late-entry')");
  await delay(1000);
  const afterLateEntry = await evaluate(client, '({ path: location.pathname, body: document.body.innerText })');
  assert.equal(afterLateEntry.path, '/rooms', 'late successful entry cannot navigate into the deleted room');
  assert.doesNotMatch(afterLateEntry.body, /ROOM_NOT_FOUND|The room was not found/,
    'the room list does not show the raw deleted-room error response');
  assert.equal(await evaluate(client, `!document.querySelector(${JSON.stringify(card)})`), true);
  assert.equal(fixture.server.database.prepare('SELECT COUNT(*) AS count FROM rooms WHERE id = ?').get(room.id).count, 0);
});

test('Issue 39 holds late board reads and writes across deletion without affecting an unrelated room', async (t) => {
  const fixture = await createFixture();
  const owner = await register(fixture.baseUrl, 'Issue 39 Late Board Owner');
  const admin = await loginAdmin(fixture.baseUrl);
  const deletedRoom = await createRoom(fixture.baseUrl, owner, 'Held board responses');
  const unrelatedRoom = await createRoom(fixture.baseUrl, owner, 'Unaffected board');
  await enterRoom(fixture.baseUrl, owner, deletedRoom.id);
  await enterRoom(fixture.baseUrl, owner, unrelatedRoom.id);
  for (const [roomId, date] of [[deletedRoom.id, '2026-10-28'], [unrelatedRoom.id, '2026-10-29']]) {
    const vote = await fetch(`${fixture.baseUrl}/api/rooms/${roomId}/votes/${date}`, {
      method: 'PUT', headers: { origin: fixture.baseUrl, cookie: owner.cookie, 'x-csrf-token': owner.csrfToken, 'content-type': 'application/json' },
      body: JSON.stringify({ selected: true }),
    });
    assert.equal(vote.status, 200);
  }
  const unrelatedBefore = {
    votes: fixture.server.database.prepare('SELECT * FROM votes WHERE room_id = ? ORDER BY vote_date, user_id').all(unrelatedRoom.id),
    events: fixture.server.database.prepare('SELECT * FROM run_events WHERE room_id = ? ORDER BY event_date').all(unrelatedRoom.id),
  };

  const profile = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'run-together-issue-39-held-board-chrome-'));
  const browser = spawnChromium(chromePath, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
    '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank',
  ]);
  let deletedTab;
  let unrelatedTab;
  t.after(async () => {
    deletedTab?.close();
    unrelatedTab?.close();
    await stopChromium(browser);
    await removeProfileWithRetry(profile);
    await fixture.close();
  });
  const port = await readDevToolsPort(profile, browser, { timeoutMs: chromiumReadinessTimeoutMs });
  const [deletedTarget, unrelatedTarget] = await Promise.all([createTarget(port), createTarget(port)]);
  const boardInitScript = `(() => {
    let factory;
    Object.defineProperty(window, 'io', { configurable: true, get: () => factory, set: (value) => {
      factory = (...args) => { const socket = value(...args); window.__issue39Socket = socket; return socket; };
    } });
  })();`;
  deletedTab = createCdpClient(deletedTarget.webSocketDebuggerUrl);
  unrelatedTab = createCdpClient(unrelatedTarget.webSocketDebuggerUrl);
  await Promise.all([
    openPage(deletedTab, `${fixture.baseUrl}/vote/${deletedRoom.id}`, owner.cookie, { initScript: boardInitScript }),
    openPage(unrelatedTab, `${fixture.baseUrl}/vote/${unrelatedRoom.id}`, owner.cookie),
  ]);
  assert.equal(await waitFor(deletedTab, `Boolean(document.querySelector('#protected-content') && !document.querySelector('#protected-content').hidden && document.querySelector('#room-heading')?.textContent === 'Held board responses' && window.__issue39Socket?.connected)`), true);
  assert.equal(await waitFor(unrelatedTab, `Boolean(document.querySelector('#protected-content') && !document.querySelector('#protected-content').hidden && document.querySelector('#room-heading')?.textContent === 'Unaffected board')`), true);

  const weekPath = `/api/rooms/${deletedRoom.id}/weeks/2026-10-26`;
  const metadataPath = `/api/rooms/${deletedRoom.id}`;
  const timelinePath = `/api/rooms/${deletedRoom.id}/vote-timeline`;
  const votePath = `/api/rooms/${deletedRoom.id}/votes/2026-10-29`;
  const eventPath = `/api/rooms/${deletedRoom.id}/events/2026-10-28`;
  const expectedApiPaths = new Set([weekPath, metadataPath, timelinePath, votePath, eventPath]);
  await evaluate(deletedTab, `(() => {
    const originalFetch = window.fetch.bind(window);
    window.__issue39LateResponses = [];
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      const input = args[0];
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (${JSON.stringify([...expectedApiPaths])}.includes(url.pathname)) {
        window.__issue39LateResponses.push({ path: url.pathname, method: String(args[1]?.method ?? input.method ?? 'GET').toUpperCase(), status: response.status });
      }
      return response;
    };
  })()`);
  await deletedTab.send('Fetch.enable', { patterns: [
    { urlPattern: `${fixture.baseUrl}/api/rooms/${deletedRoom.id}*`, requestStage: 'Response' },
  ] });
  await evaluate(deletedTab, `(() => {
    window.__issue39Socket.disconnect();
  })()`);
  assert.equal(await waitFor(deletedTab, 'window.__issue39Socket?.connected === false'), true);
  const boardReadRepliesPromise = waitForCdpEvents(deletedTab, 'Fetch.requestPaused', 3,
    (event) => expectedApiPaths.has(new URL(event.request.url).pathname) && event.request.method === 'GET');
  await evaluate(deletedTab, '(() => { window.__issue39Socket.connect(); return true; })()');
  const boardReadReplies = await boardReadRepliesPromise;
  assert.deepEqual(boardReadReplies.map((event) => new URL(event.request.url).pathname).sort(), [weekPath, metadataPath, timelinePath].sort(),
    'the real successful week, metadata, and timeline responses are paused before their browser callbacks run');
  assert.ok(boardReadReplies.every((event) => event.responseStatusCode === 200), 'all paused board read replies are successful HTTP 200 responses');

  const voteReplyPromise = waitForCdpEvents(deletedTab, 'Fetch.requestPaused', 1,
    (event) => new URL(event.request.url).pathname === votePath && event.request.method === 'PUT');
  await evaluate(deletedTab, `(() => {
    document.querySelector('.vote-card[data-date="2026-10-29"]').click();
  })()`);
  const voteReply = (await voteReplyPromise)[0];
  assert.equal(voteReply.responseStatusCode, 200, 'the server accepted the vote before its browser callback is released');
  assert.equal((await readPausedJson(deletedTab, voteReply)).selected, true, 'the held vote reply contains the accepted selected state');
  const eventReplyPromise = waitForCdpEvents(deletedTab, 'Fetch.requestPaused', 1,
    (event) => new URL(event.request.url).pathname === eventPath && event.request.method === 'POST');
  await evaluate(deletedTab, `(() => {
    document.querySelector('.run-event-day-action[data-date="2026-10-28"]').click();
  })()`);
  const eventReply = (await eventReplyPromise)[0];
  assert.equal(eventReply.responseStatusCode, 201, 'the server accepted the event before its browser callback is released');
  assert.equal((await readPausedJson(deletedTab, eventReply)).event.roomId, deletedRoom.id, 'the held event reply identifies the deleted room');

  await evaluate(deletedTab, `(() => {
    window.__issue39BeforeUnload = (event) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', window.__issue39BeforeUnload);
  })()`);
  await clickSelector(deletedTab, '#room-heading');
  const navigationDialogPromise = waitForCdpEvent(deletedTab, 'Page.javascriptDialogOpening');
  const deletion = await fetch(`${fixture.baseUrl}/api/rooms/${encodeURIComponent(deletedRoom.id)}`, {
    method: 'DELETE', headers: { origin: fixture.baseUrl, cookie: admin.cookie, 'x-csrf-token': admin.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ confirmation: true }),
  });
  assert.equal(deletion.status, 200);
  const navigationDialog = await navigationDialogPromise;
  assert.equal(navigationDialog.type, 'beforeunload', 'the real deleted-room exit reaches a pending browser navigation dialog');
  await deletedTab.send('Page.handleJavaScriptDialog', { accept: false });
  assert.equal(await waitFor(deletedTab, `location.pathname === '/vote/${deletedRoom.id}'`), true,
    'cancelling the test-only beforeunload pause keeps the old document available for callback-guard verification');
  const guardedOldPage = await evaluate(deletedTab, `({ path: location.pathname, protectedHidden: document.querySelector('#protected-content').hidden, heading: document.querySelector('#room-heading').textContent, headingVisible: document.querySelector('#room-heading').getClientRects().length > 0, cardCount: document.querySelectorAll('#week-days .vote-card').length, bannerCount: document.querySelectorAll('.run-event-banner').length })`);
  assert.deepEqual(guardedOldPage, { path: `/vote/${deletedRoom.id}`, protectedHidden: true, heading: 'Held board responses', headingVisible: false, cardCount: 0, bannerCount: 0 },
    'the deleted-room guard hides protected state before the replacement document loads');
  const lateReplies = [...boardReadReplies, voteReply, eventReply];
  for (const reply of lateReplies) {
    const body = await readPausedJson(deletedTab, reply);
    assert.ok(body && typeof body === 'object', `the genuine ${new URL(reply.request.url).pathname} response body is valid JSON`);
    await deletedTab.send('Fetch.continueResponse', { requestId: reply.requestId });
  }
  assert.equal(await waitFor(deletedTab, `window.__issue39LateResponses.length === ${lateReplies.length}`), true,
    'all five genuine successful server replies resolve in the guarded deleted-room context after the test cancels the navigation prompt');
  const afterLateReplies = await evaluate(deletedTab, `({ path: location.pathname, protectedHidden: document.querySelector('#protected-content').hidden, heading: document.querySelector('#room-heading').textContent, headingVisible: document.querySelector('#room-heading').getClientRects().length > 0, cardCount: document.querySelectorAll('#week-days .vote-card').length, bannerCount: document.querySelectorAll('.run-event-banner').length, replies: window.__issue39LateResponses })`);
  assert.equal(afterLateReplies.path, `/vote/${deletedRoom.id}`);
  assert.equal(afterLateReplies.protectedHidden, true);
  assert.equal(afterLateReplies.heading, 'Held board responses');
  assert.equal(afterLateReplies.headingVisible, false);
  assert.equal(afterLateReplies.cardCount, 0);
  assert.equal(afterLateReplies.bannerCount, 0);
  assert.deepEqual(afterLateReplies.replies.map(({ path, method, status }) => ({ path, method, status })).sort((left, right) => left.path.localeCompare(right.path)), [
    { path: eventPath, method: 'POST', status: 201 },
    { path: metadataPath, method: 'GET', status: 200 },
    { path: timelinePath, method: 'GET', status: 200 },
    { path: votePath, method: 'PUT', status: 200 },
    { path: weekPath, method: 'GET', status: 200 },
  ].sort((left, right) => left.path.localeCompare(right.path)), 'only successful replies for the deleted room were released');
  await deletedTab.send('Fetch.disable');
  await evaluate(deletedTab, 'window.removeEventListener("beforeunload", window.__issue39BeforeUnload)');
  await deletedTab.send('Page.navigate', { url: `${fixture.baseUrl}/rooms` });
  assert.equal(await waitFor(deletedTab, `location.pathname === '/rooms' && !document.querySelector('#rooms-content').hidden && !document.querySelector('#room-cards').textContent.includes('Held board responses')`), true,
    'the browser completes its safe exit and loads the room list after late callbacks are discarded');
  assert.equal(await evaluate(unrelatedTab, `location.pathname === '/vote/${unrelatedRoom.id}' && !document.querySelector('#protected-content').hidden`), true,
    'the unrelated same-session tab remains on its explicit room');
  assert.deepEqual({
    votes: fixture.server.database.prepare('SELECT * FROM votes WHERE room_id = ? ORDER BY vote_date, user_id').all(unrelatedRoom.id),
    events: fixture.server.database.prepare('SELECT * FROM run_events WHERE room_id = ? ORDER BY event_date').all(unrelatedRoom.id),
  }, unrelatedBefore, 'late room-A replies and deletion do not overwrite any unrelated room-B data');
  for (const table of ['votes', 'run_events', 'room_memberships', 'run_event_requests']) {
    assert.equal(fixture.server.database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE room_id = ?`).get(deletedRoom.id).count, 0,
      `deletion leaves no ${table} rows for the deleted room`);
  }
});
