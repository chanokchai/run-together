import assert from 'node:assert/strict';
import { createHash, randomInt } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { removeProfileWithRetry } from '../tests/helpers/chromium-profile-cleanup.js';
import { chromiumReadinessTimeoutMs, readDevToolsPort, spawnChromium, stopChromium } from '../tests/helpers/chromium-startup.js';

const baseUrl = 'https://run2.jjbtech.com';
const chromePath = process.env.CHROME_BIN ?? [
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/opt/google/chrome/chrome',
  '/opt/data/tmp/chrome/opt/google/chrome/chrome',
].find((path) => existsSync(path));
assert.ok(chromePath, 'real Chromium executable is required');

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function cookieFrom(response) {
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
  assert.ok(cookie.includes('='), 'registration must issue a session cookie');
  return cookie;
}

async function createTarget(port) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/json/new?about:blank', method: 'PUT' }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error(`Chrome target creation failed with HTTP ${response.statusCode}`));
        try { resolve(JSON.parse(text)); } catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function cdp(url) {
  const socket = new WebSocket(url);
  let nextId = 0;
  const pending = new Map();
  const events = [];
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id) { events.push(message); return; }
    const promise = pending.get(message.id);
    if (!promise) return;
    pending.delete(message.id);
    if (message.error) promise.reject(new Error(message.error.message));
    else promise.resolve(message.result);
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
      const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      socket.send(JSON.stringify({ id, method, params }));
      return response;
    },
    close() { socket.close(); },
  };
}

async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.result?.description ?? result.exceptionDetails.text);
  return result.result.value;
}

async function waitFor(client, expression, timeout = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await evaluate(client, expression)) return true;
    await delay(100);
  }
  return false;
}

async function openPage(client, url, cookie) {
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Debugger.enable');
  await client.send('Network.enable');
  const [name, value] = cookie.split('=', 2);
  await client.send('Network.setCookie', { url, name, value, path: '/', httpOnly: true });
  await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await client.send('Page.navigate', { url });
}

async function executedSource(client, fragment) {
  const started = Date.now();
  let parsed;
  while (Date.now() - started < 20000) {
    parsed = client.events.find(({ method, params }) => method === 'Debugger.scriptParsed' && params.url.includes(fragment));
    if (parsed) break;
    await delay(100);
  }
  assert.ok(parsed, `Chromium must parse and execute the ${fragment} module`);
  const { scriptSource } = await client.send('Debugger.getScriptSource', { scriptId: parsed.params.scriptId });
  assert.equal(typeof scriptSource, 'string');
  return { url: parsed.params.url, sha256: createHash('sha256').update(scriptSource).digest('hex') };
}

async function screenshot(client, filepath) {
  const result = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await mkdir(join(process.cwd(), 'outputs'), { recursive: true });
  await writeFile(filepath, Buffer.from(result.data, 'base64'), { flag: 'wx' });
}

const health = await fetch(`${baseUrl}/health`);
assert.equal(health.status, 200, 'public run2 preview health endpoint must be healthy');
const pin = String(randomInt(1000, 10000));
const userName = `Issue 39 Preview ${Date.now()}`;
const registration = await fetch(`${baseUrl}/api/auth/register`, {
  method: 'POST', headers: { origin: baseUrl, 'content-type': 'application/json' },
  body: JSON.stringify({ name: userName, pin, pinConfirmation: pin }),
});
assert.equal(registration.status, 201, await registration.clone().text());
const cookie = cookieFrom(registration);
const session = await fetch(`${baseUrl}/api/session`, { headers: { cookie } }).then((response) => response.json());
assert.equal(typeof session.csrfToken, 'string');
const roomTitle = `Issue39 public ${Date.now()}`;
const roomResponse = await fetch(`${baseUrl}/api/rooms`, {
  method: 'POST', headers: { origin: baseUrl, cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' },
  body: JSON.stringify({ title: roomTitle }),
});
assert.equal(roomResponse.status, 201, await roomResponse.clone().text());
const room = (await roomResponse.json()).room;
const entered = await fetch(`${baseUrl}/api/rooms/${encodeURIComponent(room.id)}/enter`, {
  method: 'POST', headers: { origin: baseUrl, cookie, 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' }, body: '{}',
});
assert.equal(entered.status, 200);

const profile = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'run-together-issue-39-public-'));
const screenshotPath = join(process.cwd(), 'outputs', `issue-39-public-${Date.now()}.png`);
const browser = spawnChromium(chromePath, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
  '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, 'about:blank',
]);
let list;
let board;
try {
  const port = await readDevToolsPort(profile, browser, { timeoutMs: chromiumReadinessTimeoutMs });
  const [listTarget, boardTarget] = await Promise.all([createTarget(port), createTarget(port)]);
  list = cdp(listTarget.webSocketDebuggerUrl);
  board = cdp(boardTarget.webSocketDebuggerUrl);
  await Promise.all([
    openPage(list, `${baseUrl}/rooms`, cookie),
    openPage(board, `${baseUrl}/vote/${encodeURIComponent(room.id)}`, cookie),
  ]);
  assert.equal(await waitFor(list, `Boolean(document.querySelector('#rooms-content') && !document.querySelector('#rooms-content').hidden && [...document.querySelectorAll('.room-card__title')].some((node) => node.textContent === ${JSON.stringify(roomTitle)}))`), true,
    'the public owner room list renders the created room');
  assert.equal(await waitFor(board, `Boolean(document.querySelector('#protected-content') && !document.querySelector('#protected-content').hidden && document.querySelector('#room-heading')?.textContent === ${JSON.stringify(roomTitle)})`), true,
    'the public board renders and runs normally for the room owner');
  assert.equal(await waitFor(board, 'Boolean(window.io && document.querySelector("#week-days"))'), true);
  const listModule = await executedSource(list, '/room-list.js');
  const boardModule = await executedSource(board, '/vote-board.js');
  const expectedList = createHash('sha256').update(readFileSync(join(process.cwd(), 'src/room-list.js'))).digest('hex');
  const expectedBoard = createHash('sha256').update(readFileSync(join(process.cwd(), 'src/vote-board.js'))).digest('hex');
  assert.equal(listModule.sha256, expectedList, 'the executed public room-list module matches the checked-out source byte-for-byte');
  assert.equal(boardModule.sha256, expectedBoard, 'the executed public vote-board module matches the checked-out source byte-for-byte');
  await evaluate(list, `document.querySelector('.room-card[data-room-id="${room.id}"]').scrollIntoView({ block: 'center' })`);
  await screenshot(list, screenshotPath);

  await evaluate(list, `(() => { window.confirm = (message) => { window.__issue39Confirmation = message; return true; }; document.querySelector('.room-card[data-room-id="${room.id}"] .room-card__delete').click(); })()`);
  assert.equal(await waitFor(list, `!document.querySelector('.room-card[data-room-id="${room.id}"]') && document.querySelector('#rooms-message')?.textContent.includes('permanently deleted')`), true,
    'the public owner deletion removes its card and displays the confirmation result');
  assert.equal(await waitFor(board, `location.pathname === '/rooms'`), true,
    'the connected public board tab returns to rooms after deletion');
  const confirmation = await evaluate(list, 'window.__issue39Confirmation');
  assert.equal(confirmation, `Permanently delete “${roomTitle}”? Its votes, proposals, schedules, and memberships will be permanently removed. This cannot be undone.`);
  assert.equal((await fetch(`${baseUrl}/api/rooms/${encodeURIComponent(room.id)}`, { headers: { cookie } })).status, 404,
    'the public API confirms the room no longer exists');

  console.log(JSON.stringify({
    preview: baseUrl,
    healthStatus: health.status,
    page: 'owner room list and active room board loaded in real mobile-emulated Chromium',
    deletion: 'owner confirmation removed the room card and the connected board navigated to /rooms',
    executedModules: {
      roomList: { ...listModule, expectedSha256: expectedList, match: listModule.sha256 === expectedList },
      voteBoard: { ...boardModule, expectedSha256: expectedBoard, match: boardModule.sha256 === expectedBoard },
    },
    screenshot: screenshotPath,
  }, null, 2));
} finally {
  list?.close();
  board?.close();
  await stopChromium(browser);
  await removeProfileWithRetry(profile);
}
