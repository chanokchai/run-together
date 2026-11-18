import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { addVote } from '../src/domain.js';
import { createServer } from '../src/server.js';
import { addRoomMember, createRoom } from '../src/room-storage.js';
import { removeProfileWithRetry } from './helpers/chromium-profile-cleanup.js';
import { chromiumReadinessTimeoutMs, readDevToolsPort, spawnChromium, stopChromium } from './helpers/chromium-startup.js';

const chromePath = process.env.CHROME_BIN ?? [
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/opt/google/chrome/chrome',
  '/opt/data/tmp/chrome/opt/google/chrome/chrome',
].find((path) => existsSync(path));
if (!chromePath) throw new Error('Issue 10 browser visibility coverage requires real Chromium; refusing to skip.');

const ENV = { ADMIN_NAME: 'Issue 10 Synthetic Admin', ADMIN_PIN: '4826', PIN_PEPPER: 'issue-10-browser-synthetic-pepper' };
const NOW = new Date('2026-11-18T00:00:00.000Z');
const VOTE_DATE = '2026-11-19';

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
  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id) return;
    const state = pending.get(message.id);
    if (!state) return;
    pending.delete(message.id);
    if (message.error) state.reject(new Error(message.error.message));
    else state.resolve(message.result);
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

async function waitFor(client, expression, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(client, expression)) return true;
    await delay(50);
  }
  return false;
}

async function registerMember(baseUrl, server, name) {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ name, pin: '0042', pinConfirmation: '0042' }),
  });
  assert.equal(response.status, 201, `${name} registers in the isolated synthetic database`);
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
  const sessionResponse = await fetch(`${baseUrl}/api/session`, { headers: { cookie } });
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json();
  const userId = server.database.prepare('SELECT id FROM users WHERE name = ?').get(name).id;
  return { name, userId, cookie, csrfToken: session.csrfToken };
}

async function openAuthenticatedBrowser({ baseUrl, member, browsers, profiles, clients }) {
  const profile = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'run-together-issue-10-chrome-'));
  profiles.push(profile);
  const browser = spawnChromium(chromePath, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
    '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank',
  ]);
  browsers.push(browser);
  const port = await readDevToolsPort(profile, browser, { timeoutMs: chromiumReadinessTimeoutMs });
  const target = await createTarget(port);
  const client = createCdpClient(target.webSocketDebuggerUrl);
  clients.push(client);
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Network.enable');
  await client.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 844, deviceScaleFactor: 1, mobile: true });
  const [cookieName, cookieValue] = member.cookie.split('=', 2);
  await client.send('Network.setCookie', { url: baseUrl, name: cookieName, value: cookieValue, path: '/' });
  return client;
}

test('Issue 10 persisted vote becomes visible in a second authenticated browser without refresh in under two seconds', async (t) => {
  const directory = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'run-together-issue-10-browser-'));
  const server = createServer({ databasePath: join(directory, 'issue-10-browser-synthetic.sqlite'), env: ENV, now: () => NOW });
  const browsers = [];
  const profiles = [];
  const clients = [];
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    clients.forEach((client) => client.close());
    for (const browser of browsers) await stopChromium(browser);
    for (const profile of profiles) await removeProfileWithRetry(profile);
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.database.close();
    await rm(directory, { recursive: true, force: true });
  });

  const observer = await registerMember(baseUrl, server, 'Issue 10 Browser Observer');
  const voter = await registerMember(baseUrl, server, 'Issue 10 Browser Voter');
  const room = createRoom(server.database, { creatorUserId: voter.userId, title: 'Issue 10 Synthetic Room' });
  addRoomMember(server.database, { roomId: room.id, userId: observer.userId, now: () => NOW });
  addVote(server.database, { roomId: room.id, userId: observer.userId, voteDate: VOTE_DATE, now: () => NOW });
  assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM votes WHERE room_id = ? AND vote_date = ?').get(room.id, VOTE_DATE).count, 1,
    'observer has one persisted synthetic vote before both browsers load');

  const observerClient = await openAuthenticatedBrowser({ baseUrl, member: observer, browsers, profiles, clients });
  const voterClient = await openAuthenticatedBrowser({ baseUrl, member: voter, browsers, profiles, clients });
  for (const client of [observerClient, voterClient]) {
    await client.send('Page.navigate', { url: `${baseUrl}/vote/${room.id}` });
    assert.equal(await waitFor(client, `Boolean(document.querySelector('#protected-content') && !document.querySelector('#protected-content').hidden && document.querySelector('.vote-card[data-date="${VOTE_DATE}"]') && document.querySelector('#week-heading')?.textContent)`), true,
      'an authenticated member loads the selected synthetic room and week');
  }
  assert.equal(await waitFor(observerClient, `Boolean(document.querySelector('.vote-card[data-date="${VOTE_DATE}"] .vote-card__count')?.textContent === '1' && document.querySelector('.vote-card[data-date="${VOTE_DATE}"]').getAttribute('aria-pressed') === 'true' && document.querySelector('.vote-card[data-date="${VOTE_DATE}"] .vote-card__names')?.textContent.includes(${JSON.stringify(observer.name)}))`), true,
    'observer initially sees one vote, the voter name, and their own pressed state');
  assert.equal(await waitFor(voterClient, `Boolean(document.querySelector('.vote-card[data-date="${VOTE_DATE}"] .vote-card__count')?.textContent === '1' && document.querySelector('.vote-card[data-date="${VOTE_DATE}"]').getAttribute('aria-pressed') === 'false')`), true,
    'second member initially sees the same vote as unselected for themselves');

  const subscribed = () => [...server.io.sockets.sockets.values()].filter((socket) => socket.data.roomIds?.has(room.id)).length === 2;
  const subscribeDeadline = Date.now() + 10000;
  while (!subscribed() && Date.now() < subscribeDeadline) await delay(25);
  assert.equal(subscribed(), true, 'both real browser sessions have subscribed to the same room realtime channel');

  await evaluate(voterClient, `(() => {
    const originalFetch = window.fetch.bind(window);
    window.__issue10RequestStartEpoch = null;
    window.fetch = (...args) => {
      const input = args[0];
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      const method = (args[1]?.method ?? input?.method ?? 'GET').toUpperCase();
      if (method === 'PUT' && url.pathname.endsWith('/votes/${VOTE_DATE}')) window.__issue10RequestStartEpoch = Date.now();
      return originalFetch(...args);
    };
  })()`);
  await evaluate(observerClient, `(() => {
    const date = ${JSON.stringify(VOTE_DATE)};
    const expectedName = ${JSON.stringify(voter.name)};
    window.__issue10VisibleAtEpoch = null;
    const matches = () => {
      const card = document.querySelector('.vote-card[data-date="' + date + '"]');
      const names = card?.querySelector('.vote-card__names')?.textContent ?? '';
      return card?.querySelector('.vote-card__count')?.textContent.trim() === '2'
        && names.includes(expectedName)
        && card.getAttribute('aria-pressed') === 'true'
        && card.dataset.selected === 'true';
    };
    window.__issue10Observer = new MutationObserver(() => {
      if (!matches()) return;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (matches()) window.__issue10VisibleAtEpoch = Date.now();
      }));
    });
    window.__issue10Observer.observe(document.querySelector('#week-days'), {
      subtree: true, childList: true, characterData: true, attributes: true,
    });
  })()`);

  const browserStartPath = await evaluate(observerClient, 'location.pathname');
  await evaluate(voterClient, `document.querySelector('.vote-card[data-date="${VOTE_DATE}"]').click()`);
  assert.equal(await waitFor(voterClient, `document.querySelector('.vote-card[data-date="${VOTE_DATE}"]')?.getAttribute('aria-pressed') === 'true'`), true,
    'voting member sees their own selected state update in the browser');
  const persistedRows = server.database.prepare(
    'SELECT user_id FROM votes WHERE room_id = ? AND vote_date = ? ORDER BY user_id',
  ).all(room.id, VOTE_DATE);
  assert.equal(persistedRows.length, 2, 'the new vote is committed to the isolated synthetic SQLite database');
  assert.deepEqual(persistedRows.map(({ user_id: userId }) => userId), [observer.userId, voter.userId].sort((a, b) => a - b),
    'the persisted rows are exactly the observer and voting member, with no duplicate');

  assert.equal(await waitFor(observerClient, `window.__issue10VisibleAtEpoch !== null && document.querySelector('.vote-card[data-date="${VOTE_DATE}"] .vote-card__count')?.textContent.trim() === '2' && document.querySelector('.vote-card[data-date="${VOTE_DATE}"] .vote-card__names')?.textContent.includes(${JSON.stringify(voter.name)}) && document.querySelector('.vote-card[data-date="${VOTE_DATE}"]').getAttribute('aria-pressed') === 'true'`, 5000), true,
    'without navigation or refresh, the observer renders the new count and voter name and retains its selected state');
  const browserEvidence = await evaluate(observerClient, `({
    path: location.pathname,
    count: document.querySelector('.vote-card[data-date="${VOTE_DATE}"] .vote-card__count').textContent.trim(),
    names: document.querySelector('.vote-card[data-date="${VOTE_DATE}"] .vote-card__names').textContent,
    selected: document.querySelector('.vote-card[data-date="${VOTE_DATE}"]').dataset.selected,
    ariaPressed: document.querySelector('.vote-card[data-date="${VOTE_DATE}"]').getAttribute('aria-pressed'),
    visibleAtEpoch: window.__issue10VisibleAtEpoch,
  })`);
  const requestStartEpoch = await evaluate(voterClient, 'window.__issue10RequestStartEpoch');
  assert.equal(browserEvidence.path, browserStartPath, 'the observer remains on the same page without navigation or refresh');
  assert.equal(browserEvidence.count, '2');
  assert.match(browserEvidence.names, /Issue 10 Browser Observer/);
  assert.match(browserEvidence.names, /Issue 10 Browser Voter/);
  assert.equal(browserEvidence.selected, 'true');
  assert.equal(browserEvidence.ariaPressed, 'true');
  assert.ok(Number.isFinite(requestStartEpoch), 'records the real browser vote-request start time');
  const persistedToVisibleMs = browserEvidence.visibleAtEpoch - requestStartEpoch;
  assert.ok(persistedToVisibleMs >= 0 && persistedToVisibleMs < 2000,
    `the observer rendered the persisted update within two seconds of browser request start (${persistedToVisibleMs}ms)`);
  t.diagnostic(`Real-browser visibility PASS: two authenticated clients in one synthetic room; two persisted votes; observer count 2, both names, aria-pressed=true without navigation/refresh; ${persistedToVisibleMs}ms from browser request start through two animation frames to visible DOM state.`);
});
