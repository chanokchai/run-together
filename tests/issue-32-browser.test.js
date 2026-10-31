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
import { setRunEventStatus } from '../src/domain.js';
import { LEGACY_ROOM_ID } from '../src/room-contract.js';
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

async function removeVote(baseUrl, member, date) {
  const response = await fetch(`${baseUrl}/api/votes/${date}`, {
    method: 'PUT',
    headers: { cookie: member.cookie, origin: baseUrl, 'content-type': 'application/json', 'x-csrf-token': member.csrfToken },
    body: JSON.stringify({ selected: false }),
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

async function sampleScheduledBeamPhase(client, date, { includeGraphBar = true } = {}) {
  return evaluate(client, `(async () => {
    for (let frame = 0; frame < 4; frame += 1) await new Promise(requestAnimationFrame);
    const selectors = [
      '.run-event-banner[data-date="${date}"]',
      '#week-days .vote-card[data-date="${date}"]',
      '.vote-timeline__date[datetime="${date}"]',
    ];
    if (${includeGraphBar}) selectors.push('.vote-timeline__bar[data-date="${date}"]');
    return selectors.map((selector) => {
      const element = document.querySelector(selector);
      const beam = element ? getComputedStyle(element, '::before') : null;
      const animation = element && document.getAnimations().find((current) => current.animationName === 'scheduled-border-beam'
        && current.effect?.pseudoElement === '::before' && current.effect?.target === element);
      return {
        found: Boolean(element),
        active: element?.classList.contains('is-beam-running') ?? false,
        animation: beam?.animationName ?? 'none',
        angle: Number.parseFloat(beam?.getPropertyValue('--beam-angle') ?? 'NaN'),
        progress: animation?.effect?.getComputedTiming().progress ?? Number.NaN,
      };
    });
  })()`);
}

function maxCircularDifference(values, circumference = 360) {
  const normalized = values.map((value) => ((value % circumference) + circumference) % circumference);
  return Math.max(0, ...normalized.flatMap((value, index) => normalized.slice(index + 1).map((other) => {
    const difference = Math.abs(value - other);
    return Math.min(difference, circumference - difference);
  })));
}

function assertSynchronizedBeamPhase(samples, context) {
  assert.ok(samples.every(({ found, active, animation, angle, progress }) => found && active && animation === 'scheduled-border-beam' && Number.isFinite(angle) && Number.isFinite(progress)), `${context}: all sampled scheduled representations expose running CSS animation progress: ${JSON.stringify(samples)}`);
  assert.ok(maxCircularDifference(samples.map(({ angle }) => angle)) < 10, `${context}: measured beam angles remain in the same normalized phase: ${JSON.stringify(samples)}`);
  assert.ok(maxCircularDifference(samples.map(({ progress }) => progress * 360)) < 10, `${context}: actual CSS animation progress remains in the same normalized phase: ${JSON.stringify(samples)}`);
}

async function pressEnter(client) {
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
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

async function verticalPageSwipe(client, deltaY) {
  const { innerHeight } = await evaluate(client, '({ innerHeight })');
  const x = 4;
  const startY = deltaY < 0 ? innerHeight - 20 : 20;
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 2, x, y: startY, radiusX: 1, radiusY: 1, force: 1 }] });
  await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 2, x, y: startY + deltaY, radiusX: 1, radiusY: 1, force: 1 }] });
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await delay(120);
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
  let client2;
  let browser;
  let profile;
  t.after(async () => {
    client?.close();
    client2?.close();
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
  const scheduledTieMembers = [];
  for (const name of ['ScheduledTieRunnerA', 'ScheduledTieRunnerB', 'ScheduledTieRunnerC']) {
    const member = await registerMember(baseUrl, name);
    assert.equal(member.response.status, 201);
    await setVote(baseUrl, member, '2024-03-03');
    scheduledTieMembers.push(member);
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
  await client.send('Page.navigate', { url: `${baseUrl}/vote/${LEGACY_ROOM_ID}` });

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

  await clickSelector(client, '.run-event-banner[data-date="2024-03-01"] .run-event-banner__summary');
  await delay(150);
  assert.equal(server.database.prepare('SELECT status FROM run_events WHERE event_date = ?').get('2024-03-01').status, 'proposed', 'an ordinary member tapping the banner body cannot change event status');

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
  assert.equal(await waitFor(client, `document.querySelector('#week-heading').textContent === 'Week 8 (2024)'`), true, 'week navigation loads the selected earlier week');
  assert.equal(await evaluate(client, `document.querySelectorAll('.run-event-banner').length`), 0, 'does not show events from another week');
  await evaluate(client, `document.querySelector('#current-week').click()`);
  assert.equal(await waitFor(client, `document.querySelector('#week-heading').textContent === 'Week 9 (2024)'`), true, 'returns to the current selected week');
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
  await client.send('Page.navigate', { url: `${baseUrl}/vote/${LEGACY_ROOM_ID}` });
  assert.equal(await waitFor(client, `document.querySelector('#protected-content') && !document.querySelector('#protected-content').hidden && document.querySelectorAll('#week-days .vote-card').length === 7`), true, 'loads the board as the authenticated administrator');
  assert.equal(await evaluate(client, `document.querySelectorAll('.run-event-actions').length`), 2, 'renders explicit banner controls for an administrator');
  await clickSelector(client, '.run-event-banner[data-date="2024-03-01"] .run-event-banner__summary');
  assert.equal(await waitFor(client, `document.querySelector('.run-event-banner[data-date="2024-03-01"] .run-event-banner__status')?.textContent === 'Scheduled'`), true, 'admin tap on the banner body schedules a proposed run');
  await clickSelector(client, '.run-event-banner[data-date="2024-03-01"] .run-event-banner__summary');
  assert.equal(await waitFor(client, `document.querySelector('.run-event-banner[data-date="2024-03-01"] .run-event-banner__status')?.textContent === 'Proposed'`), true, 'admin tap on the banner body reverts a scheduled run');
  await evaluate(client, `document.querySelector('.run-event-banner[data-date="2024-03-01"] button[data-run-event-status="proposed"]')?.focus()`);
  await pressEnter(client);
  assert.equal(await waitFor(client, `document.querySelector('.run-event-banner[data-date="2024-03-01"] .run-event-banner__status')?.textContent === 'Scheduled'`), true, 'admin keyboard action schedules a proposal');
  assert.equal(await evaluate(client, `document.activeElement?.closest('.run-event-banner')?.dataset.date === '2024-03-01' && document.activeElement.matches('.run-event-actions [data-run-event-status]')`), true, 'keyboard focus follows the status control when scheduling reorders its banner');
  await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  assert.equal(await evaluate(client, `getComputedStyle(document.querySelector('.run-event-banner[data-date="2024-03-01"]')).animationName`), 'none', 'scheduled emphasis is disabled for reduced-motion users');
  await evaluate(client, `document.querySelector('.run-event-banner[data-date="2024-03-01"] button[data-run-event-status="scheduled"]')?.focus()`);
  await pressEnter(client);
  assert.equal(await waitFor(client, `document.querySelector('.run-event-banner[data-date="2024-03-01"] .run-event-banner__status')?.textContent === 'Proposed'`), true, 'admin keyboard action reverts a scheduled event to proposed');
  await evaluate(client, `document.querySelector('.run-event-banner[data-date="2024-03-01"] button[data-run-event-status="proposed"]')?.focus()`);
  await pressEnter(client);
  assert.equal(await waitFor(client, `document.querySelector('.run-event-banner[data-date="2024-03-01"] .run-event-banner__status')?.textContent === 'Scheduled'`), true, 'admin can schedule the same event again after reverting');
  await beginSwipe(client, '.run-event-banner[data-date="2024-03-01"]', -24);
  await endSwipe(client);
  await delay(150);
  assert.equal(await evaluate(client, `document.querySelector('.run-event-banner[data-date="2024-03-01"] .run-event-banner__status')?.textContent`), 'Scheduled', 'a released below-threshold banner drag does not synthesize a tap status change');
  await delay(350);
  const staleEvent = server.database.prepare('SELECT id, revision FROM run_events WHERE event_date = ?').get('2024-03-01');
  const adminId = server.database.prepare("SELECT id FROM users WHERE role = 'admin'").get().id;
  setRunEventStatus(server.database, {
    adminUserId: adminId,
    eventDate: '2024-03-01',
    eventId: staleEvent.id,
    revision: staleEvent.revision,
    status: 'proposed',
    requestId: '00000000-0000-4000-8000-000000000091',
    now,
  });
  await evaluate(client, `window.issue32MutationResponses = []; window.issue32OriginalFetch = window.fetch; window.fetch = async (...args) => { const response = await window.issue32OriginalFetch(...args); if (String(args[0]).includes('/admin/events/')) window.issue32MutationResponses.push({ status: response.status, body: await response.clone().json() }); return response; };`);
  await clickSelector(client, '.run-event-banner[data-date="2024-03-01"] button[data-run-event-status="scheduled"]');
  const staleActionReloaded = await waitFor(client, `window.issue32MutationResponses.length === 1 && document.querySelector('.run-event-banner[data-date="2024-03-01"] .run-event-banner__status')?.textContent === 'Proposed'`);
  if (!staleActionReloaded) t.diagnostic(JSON.stringify(await evaluate(client, `({ responses: window.issue32MutationResponses, status: document.querySelector('.run-event-banner[data-date="2024-03-01"] .run-event-banner__status')?.textContent, message: document.querySelector('#message').textContent, banner: document.querySelector('.run-event-banner[data-date="2024-03-01"]')?.outerHTML })`)));
  assert.equal(staleActionReloaded, true, 'a stale status action reloads the authoritative event state');
  assert.equal(await evaluate(client, `window.issue32MutationResponses[0].status`), 409, 'the stale action receives a real HTTP conflict');
  assert.match(await evaluate(client, `document.querySelector('#message').textContent`), /This event has changed/, 'the stale-event error remains visible and announced after the authoritative reload');

  await evaluate(client, `window.fetch = async (input, init) => { if (String(input).includes('/admin/events/') && init?.method === 'PUT') throw new TypeError('controlled transport failure'); return window.issue32OriginalFetch(input, init); };`);
  await clickSelector(client, '.run-event-banner[data-date="2024-03-01"] button[data-run-event-status="proposed"]');
  assert.equal(await waitFor(client, `document.querySelector('.run-event-banner[data-date="2024-03-01"] .run-event-banner__status')?.textContent === 'Proposed' && document.querySelector('#message').textContent.includes('Could not update')`), true, 'a network failure leaves a visible accessible error after authoritative refresh without showing success');
  await evaluate(client, `window.fetch = window.issue32OriginalFetch;`);
  await clickSelector(client, '.run-event-banner[data-date="2024-03-01"] button[data-run-event-status="proposed"]');
  assert.equal(await waitFor(client, `document.querySelector('.run-event-banner[data-date="2024-03-01"] .run-event-banner__status')?.textContent === 'Scheduled'`), true, 'successful retry schedules the run after the transport error');
  await beginSwipe(client, '.run-event-banner[data-date="2024-03-01"]', -24);
  const deleteCueReady = await waitFor(client, `document.querySelector('.run-event-banner[data-date="2024-03-01"] .run-event-banner__swipe-cue')?.textContent === 'Swipe left to delete'`);
  if (!deleteCueReady) t.diagnostic(JSON.stringify(await evaluate(client, `({ status: document.querySelector('.run-event-banner[data-date="2024-03-01"] .run-event-banner__status')?.textContent, cue: document.querySelector('.run-event-banner[data-date="2024-03-01"] .run-event-banner__swipe-cue')?.outerHTML, touchAction: getComputedStyle(document.querySelector('.run-event-banner[data-date="2024-03-01"]')).touchAction, transform: document.querySelector('.run-event-banner[data-date="2024-03-01"]')?.style.transform })`)));
  assert.deepEqual(await evaluate(client, `(() => { const cue = document.querySelector('.run-event-banner[data-date="2024-03-01"] .run-event-banner__swipe-cue'); return { text: cue?.textContent, destructive: cue?.dataset.destructive }; })()`), { text: 'Swipe left to delete', destructive: 'true' }, 'announces the destructive admin action before it can commit');
  await cancelSwipe(client);
  assert.equal(await evaluate(client, `document.querySelector('.run-event-banner[data-date="2024-03-01"] .run-event-banner__status')?.textContent`), 'Scheduled', 'cancelling the deletion preview preserves the event');
  await evaluate(client, `window.issue32AdminMutations = []; window.fetch = (...args) => { if (String(args[0]).includes('/admin/events/')) window.issue32AdminMutations.push(args[1]?.method ?? 'GET'); return window.issue32OriginalFetch(...args); };`);
  await swipe(client, '.run-event-banner[data-date="2024-03-01"]', -84);
  assert.equal(await waitFor(client, `document.querySelector('.run-event-banner[data-date="2024-03-01"]') === null`), true, 'admin left swipe permanently deletes a scheduled event');
  assert.deepEqual(await evaluate(client, 'window.issue32AdminMutations'), ['DELETE'], 'a completed banner swipe does not also synthesize an admin tap action');
  assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM votes WHERE vote_date = ?').get('2024-03-01').count, 4, 'event deletion preserves all availability votes');
  await propose(baseUrl, runner, '2024-03-01', 3);

  let proposedEvent = server.database.prepare('SELECT id, revision, status FROM run_events WHERE event_date = ?').get('2024-03-03');
  if (proposedEvent.status === 'scheduled') {
    const revertResponse = await fetch(`${baseUrl}/api/admin/events/2024-03-03`, {
      method: 'PUT',
      headers: { cookie: admin.cookie, origin: baseUrl, 'content-type': 'application/json', 'x-csrf-token': admin.csrfToken },
      body: JSON.stringify({ eventId: proposedEvent.id, revision: proposedEvent.revision, status: 'proposed', requestId: '00000000-0000-4000-8000-000000000143' }),
    });
    assert.equal(revertResponse.status, 200);
    assert.equal(await waitFor(client, `document.querySelector('.run-event-banner[data-date="2024-03-03"] .run-event-banner__status')?.textContent === 'Proposed'`), true, 'the first client clears the prior scheduled state before replay');
    proposedEvent = server.database.prepare('SELECT id, revision, status FROM run_events WHERE event_date = ?').get('2024-03-03');
  }
  assert.equal(proposedEvent.status, 'proposed');

  const peerTarget = await createTarget(port);
  client2 = createCdpClient(peerTarget.webSocketDebuggerUrl);
  await client2.send('Page.enable');
  await client2.send('Runtime.enable');
  await client2.send('Network.enable');
  await client2.send('Network.setCookie', { url: baseUrl, name: cookieName, value: cookieValue, path: '/' });
  await client2.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await client2.send('Page.navigate', { url: `${baseUrl}/vote/${LEGACY_ROOM_ID}` });
  assert.equal(await waitFor(client2, `document.querySelector('#protected-content') && !document.querySelector('#protected-content').hidden && document.querySelector('.run-event-banner[data-date="2024-03-03"]')`), true, 'second authenticated client loads the proposed event');
  const watchScheduledEffects = `(() => {
    window.issue34Starts = { banner: 0, date: 0, card: 0, bar: 0 };
    const targets = {
      banner: document.querySelector('.run-event-banner[data-date="2024-03-03"]'),
      date: document.querySelector('.vote-timeline__date[datetime="2024-03-03"]'),
      card: document.querySelector('#week-days .vote-card[data-date="2024-03-03"]'),
      bar: document.querySelector('.vote-timeline__bar[data-date="2024-03-03"]'),
    };
    Object.entries(targets).forEach(([name, target]) => target?.addEventListener('animationstart', (event) => {
      if (event.animationName === 'scheduled-border-beam') window.issue34Starts[name] += 1;
    }));
  })()`;
  await evaluate(client, watchScheduledEffects);
  await evaluate(client2, watchScheduledEffects);
  const scheduleResponse = await fetch(`${baseUrl}/api/admin/events/2024-03-03`, {
    method: 'PUT',
    headers: { cookie: admin.cookie, origin: baseUrl, 'content-type': 'application/json', 'x-csrf-token': admin.csrfToken },
    body: JSON.stringify({ eventId: proposedEvent.id, revision: proposedEvent.revision, status: 'scheduled', requestId: '00000000-0000-4000-8000-000000000144' }),
  });
  assert.equal(scheduleResponse.status, 200, 'admin schedules the same proposal through the protected mutation API');
  for (const page of [client, client2]) {
    assert.equal(await waitFor(page, `document.querySelector('.run-event-banner[data-date="2024-03-03"] .run-event-banner__status')?.textContent === 'Scheduled'`), true, 'both connected clients receive the scheduled state');
  }
  const eventOrders = await Promise.all([client, client2].map((page) => evaluate(page, `[...document.querySelectorAll('.run-event-banner')].map((banner) => banner.dataset.date + ':' + banner.querySelector('.run-event-banner__status').textContent)`)));
  assert.deepEqual(eventOrders, [
    ['2024-03-03:Scheduled', '2024-03-01:Proposed'],
    ['2024-03-03:Scheduled', '2024-03-01:Proposed'],
  ], 'a later scheduled event precedes an earlier proposed event on both clients');
  const eventBeforeLiveRevert = server.database.prepare('SELECT id, revision FROM run_events WHERE event_date = ?').get('2024-03-03');
  const liveRevert = await fetch(`${baseUrl}/api/admin/events/2024-03-03`, {
    method: 'PUT',
    headers: { cookie: admin.cookie, origin: baseUrl, 'content-type': 'application/json', 'x-csrf-token': admin.csrfToken },
    body: JSON.stringify({ eventId: eventBeforeLiveRevert.id, revision: eventBeforeLiveRevert.revision, status: 'proposed', requestId: '00000000-0000-4000-8000-000000000146' }),
  });
  assert.equal(liveRevert.status, 200, 'admin reverts the event while both clients are connected');
  for (const page of [client, client2]) {
    assert.equal(await waitFor(page, `document.querySelector('.run-event-banner[data-date="2024-03-03"] .run-event-banner__status')?.textContent === 'Proposed'`), true, 'both clients remove the live scheduled status');
    assert.equal(await evaluate(page, `!document.querySelector('#week-days .vote-card[data-date="2024-03-03"]').classList.contains('is-scheduled') && !document.querySelector('.vote-timeline__bar[data-date="2024-03-03"]').classList.contains('is-scheduled')`), true, 'live reversion removes the card and gold graph styling');
  }
  const revertedOrder = await evaluate(client2, `[...document.querySelectorAll('.run-event-banner')].map((banner) => banner.dataset.date)`);
  assert.deepEqual(revertedOrder, ['2024-03-01', '2024-03-03'], 'proposed banners return to ascending date order');
  const earlierProposal = server.database.prepare('SELECT id, revision FROM run_events WHERE event_date = ?').get('2024-03-01');
  const deleteEarlierProposal = await fetch(`${baseUrl}/api/admin/events/2024-03-01`, {
    method: 'DELETE',
    headers: { cookie: admin.cookie, origin: baseUrl, 'content-type': 'application/json', 'x-csrf-token': admin.csrfToken },
    body: JSON.stringify({ eventId: earlierProposal.id, revision: earlierProposal.revision, requestId: '00000000-0000-4000-8000-000000000147' }),
  });
  assert.equal(deleteEarlierProposal.status, 200, 'admin deletes the earlier proposal while both clients are connected');
  for (const page of [client, client2]) {
    assert.equal(await waitFor(page, `!document.querySelector('.run-event-banner[data-date="2024-03-01"]')`), true, 'live deletion removes the proposal from both clients');
  }
  assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM votes WHERE vote_date = ?').get('2024-03-01').count, 4, 'deleting a proposal preserves its availability votes');
  const eventBeforeLiveSchedule = server.database.prepare('SELECT id, revision FROM run_events WHERE event_date = ?').get('2024-03-03');
  const liveSchedule = await fetch(`${baseUrl}/api/admin/events/2024-03-03`, {
    method: 'PUT',
    headers: { cookie: admin.cookie, origin: baseUrl, 'content-type': 'application/json', 'x-csrf-token': admin.csrfToken },
    body: JSON.stringify({ eventId: eventBeforeLiveSchedule.id, revision: eventBeforeLiveSchedule.revision, status: 'scheduled', requestId: '00000000-0000-4000-8000-000000000148' }),
  });
  assert.equal(liveSchedule.status, 200, 'admin reschedules the remaining event');
  for (const page of [client, client2]) {
    assert.equal(await waitFor(page, `document.querySelector('.run-event-banner[data-date="2024-03-03"] .run-event-banner__status')?.textContent === 'Scheduled'`), true, 'rescheduling restores the authoritative state on both clients');
  }
  assert.equal(await evaluate(client, `getComputedStyle(document.querySelector('.run-event-banner[data-date="2024-03-03"]'), '::before').animationName`), 'none', 'reduced-motion user receives a static scheduled indicator');
  assert.equal(await evaluate(client, `document.querySelector('#week-days .vote-card[data-date="2024-03-03"]').getAttribute('aria-label').includes('Scheduled run')`), true, 'the scheduled date card exposes its status accessibly');
  assert.equal(await evaluate(client, `document.querySelector('#week-days .vote-card[data-date="2024-03-03"]').classList.contains('is-selected')`), true, 'the scheduled card keeps its selected-vote state');
  assert.equal(await evaluate(client, `getComputedStyle(document.querySelector('#week-days .vote-card[data-date="2024-03-03"]')).borderTopColor`), 'rgb(245, 197, 66)', 'the selected-vote border remains distinguishable in reduced motion');
  assert.equal(await evaluate(client, `getComputedStyle(document.querySelector('#week-days .vote-card[data-date="2024-03-03"]')).boxShadow.includes('rgb(21, 128, 61)')`), true, 'reduced motion retains a static scheduled inset marker alongside the selected border');
  await client2.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 1600, deviceScaleFactor: 1, mobile: true });
  assert.equal(await waitFor(client2, `document.querySelector('#week-days .vote-card[data-date="2024-03-03"]')?.classList.contains('is-beam-running')`), true, 'the scheduled vote card begins its beam when visible');
  const beamState = await evaluate(client2, `(() => {
    const selectors = [
      '.run-event-banner[data-date="2024-03-03"]',
      '.vote-timeline__date[datetime="2024-03-03"]',
      '#week-days .vote-card[data-date="2024-03-03"]',
      '.vote-timeline__bar[data-date="2024-03-03"]',
    ];
    return selectors.map((selector) => {
      const element = document.querySelector(selector);
      const base = element ? getComputedStyle(element) : null;
      const beam = element ? getComputedStyle(element, '::before') : null;
      return {
        found: Boolean(element),
        scheduled: element?.classList.contains('is-scheduled') || element?.classList.contains('run-event-banner--scheduled'),
        speed: base?.getPropertyValue('--beam-speed').trim() ?? '',
        length: base?.getPropertyValue('--beam-length').trim() ?? '',
        border: base?.getPropertyValue('--border-width').trim() ?? '',
        blur: base?.getPropertyValue('--glow-blur').trim() ?? '',
        color: base?.getPropertyValue('--beam-color').trim() ?? '',
        running: element?.classList.contains('is-beam-running'),
        animation: beam?.animationName ?? 'none',
        duration: beam?.animationDuration ?? '',
        iterations: beam?.animationIterationCount ?? '',
        delay: base?.getPropertyValue('--beam-delay').trim() ?? '',
        angle: beam?.getPropertyValue('--beam-angle').trim() ?? '',
        clipPath: beam?.clipPath ?? 'none',
        pointerEvents: beam?.pointerEvents ?? '',
      };
    });
  })()`);
  assert.ok(beamState.every(({ found, scheduled }) => found && scheduled), 'banner, vote card, graph date, and graph bar expose scheduled state');
  assert.ok(beamState.every(({ speed, length, border, blur, color }) => speed === '1.4s' && length === '50%' && border === '5px' && blur === '24px' && color === '#22c55e'), 'all scheduled representations share the exact approved beam settings');
  assert.ok(beamState.every(({ running, animation, duration, iterations, pointerEvents }) => running && animation === 'scheduled-border-beam' && duration === '1.4s' && iterations === 'infinite' && pointerEvents === 'none'), 'all visible scheduled representations run a continuous non-interactive beam');
  assert.ok(beamState.every(({ clipPath }) => clipPath !== 'none'), 'the 24px glow remains clipped to each border instead of spilling across neighboring content');
  const beamAngles = beamState.map(({ angle }) => Number.parseFloat(angle));
  assert.ok(beamAngles.every(Number.isFinite) && Math.max(...beamAngles) - Math.min(...beamAngles) < 5, 'different perimeter sizes use one normalized page phase');
  const angleSelectors = ['.run-event-banner[data-date="2024-03-03"]', '.vote-timeline__date[datetime="2024-03-03"]', '#week-days .vote-card[data-date="2024-03-03"]', '.vote-timeline__bar[data-date="2024-03-03"]'];
  const initialAngles = await evaluate(client2, `(${JSON.stringify(angleSelectors)}).map((selector) => getComputedStyle(document.querySelector(selector), '::before').getPropertyValue('--beam-angle'))`);
  await delay(220);
  const movingAngles = await evaluate(client2, `(${JSON.stringify(angleSelectors)}).map((selector) => getComputedStyle(document.querySelector(selector), '::before').getPropertyValue('--beam-angle'))`);
  assert.ok(movingAngles.every((angle, index) => angle !== initialAngles[index]), 'the beam angle continues to move on every scheduled representation');
  const movingDegrees = movingAngles.map((angle) => Number.parseFloat(angle));
  assert.ok(movingDegrees.every(Number.isFinite) && Math.max(...movingDegrees) - Math.min(...movingDegrees) < 5, 'the different-sized borders remain in the same normalized animation phase');
  assert.equal(await evaluate(client2, `getComputedStyle(document.querySelector('.vote-timeline__bar[data-date="2024-03-03"]')).backgroundColor`), 'rgb(245, 197, 66)', 'scheduled graph bars retain their distinct gold fill');
  assert.equal(await evaluate(client2, `document.querySelector('.vote-timeline__bar[data-date="2024-03-03"]').classList.contains('is-top-ranked')`), true, 'a scheduled bar tied for the highest count keeps its rank cue');
  assert.equal(await evaluate(client2, `document.querySelector('.vote-timeline__day[data-date="2024-03-03"] .vote-timeline__top-cue').hidden`), false, 'the top-rank marker remains visible on a scheduled tie');
  assert.equal(await evaluate(client2, `document.querySelector('.vote-timeline__day[data-date="2024-03-03"]').getAttribute('aria-label').includes('scheduled run')`), true, 'graph indicator announces scheduled status independently of its color');
  await client2.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1500, deviceScaleFactor: 1, mobile: false });
  await evaluate(client2, 'window.scrollTo(0, 0)');
  for (let navigation = 0; navigation < 3; navigation += 1) {
    await evaluate(client2, "document.querySelector('#next-week').click()");
    assert.equal(await waitFor(client2, `document.querySelector('#week-heading').textContent === 'Week 10 (2024)'`), true, `Next week completes before synchronization sample ${navigation + 1}`);
    await delay(90 + navigation * 110);
    await evaluate(client2, "document.querySelector('#current-week').click()");
    assert.equal(await waitFor(client2, `document.querySelector('#week-heading').textContent === 'Week 9 (2024)'`), true, `Now completes before synchronization sample ${navigation + 1}`);
    assert.equal(await waitFor(client2, `[...document.querySelectorAll('.run-event-banner[data-date="2024-03-03"], #week-days .vote-card[data-date="2024-03-03"], .vote-timeline__date[datetime="2024-03-03"], .vote-timeline__bar[data-date="2024-03-03"]')].every((element) => element.classList.contains('is-beam-running'))`), true, `all scheduled targets are visible after mixed retained/replacement cycle ${navigation + 1}`);
    assertSynchronizedBeamPhase(await sampleScheduledBeamPhase(client2, '2024-03-03'), `week navigation cycle ${navigation + 1}`);
  }
  for (const member of scheduledTieMembers) await removeVote(baseUrl, member, '2024-03-03');
  await removeVote(baseUrl, runner, '2024-03-03');
  for (const page of [client, client2]) {
    assert.equal(await waitFor(page, `document.querySelector('.run-event-banner[data-date="2024-03-03"] .run-event-banner__count')?.textContent === '0 votes'`), true, 'the live vote removal updates its event count');
    assert.equal(await evaluate(page, `document.querySelector('.vote-timeline__day[data-date="2024-03-03"] .vote-timeline__count').getAttribute('aria-hidden')`), 'true', 'scheduled zero labels are hidden visually');
    assert.equal(await evaluate(page, `document.querySelector('.vote-timeline__day[data-date="2024-03-03"] .vote-timeline__bar').getBoundingClientRect().height`), 0, 'scheduled zero votes keep a zero-height bar');
    assert.equal(await evaluate(page, `document.querySelector('.vote-timeline__day[data-date="2024-03-03"]').getAttribute('aria-label').includes('0 votes, scheduled run')`), true, 'the graph retains the actual zero count and accessible scheduled state');
  }
  assert.equal(await evaluate(client2, `document.querySelector('.run-event-banner[data-date="2024-03-03"]').classList.contains('is-beam-running')`), true, 'a vote update does not interrupt the peer beam');
  assert.equal(await evaluate(client2, `document.querySelector('.vote-timeline__date[datetime="2024-03-03"]').classList.contains('is-beam-running')`), true, 'a vote update preserves the scheduled graph indicator');
  assert.equal(await evaluate(client2, `document.querySelector('.vote-timeline__bar[data-date="2024-03-03"]').classList.contains('is-scheduled')`), true, 'zero-vote scheduled dates keep their gold status without a positive-height bar');
  assertSynchronizedBeamPhase(await sampleScheduledBeamPhase(client2, '2024-03-03', { includeGraphBar: false }), 'ordinary vote update');
  await client2.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  assert.equal(await evaluate(client2, `getComputedStyle(document.querySelector('.run-event-banner[data-date="2024-03-03"]'), '::before').animationName`), 'none', 'a live reduced-motion preference change stops the beam');
  await client2.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  assert.equal(await waitFor(client2, `getComputedStyle(document.querySelector('.run-event-banner[data-date="2024-03-03"]'), '::before').animationName === 'scheduled-border-beam'`), true, 'restoring normal motion restarts the beam at the shared phase');
  await delay(1600);
  for (const page of [client, client2]) {
    if (page === client2) {
      assert.equal(await evaluate(page, `getComputedStyle(document.querySelector('.run-event-banner[data-date="2024-03-03"]'), '::before').animationName`), 'scheduled-border-beam', 'the beam continues beyond the former 1.5-second cutoff');
      assert.equal(await evaluate(page, `getComputedStyle(document.querySelector('.run-event-banner[data-date="2024-03-03"]'), '::before').animationIterationCount`), 'infinite', 'the beam has no one-shot timeout');
    } else {
      assert.equal(await evaluate(page, `getComputedStyle(document.querySelector('.run-event-banner[data-date="2024-03-03"]'), '::before').animationName`), 'none', 'reduced-motion remains static beyond the former cutoff');
    }
  }
  await client2.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 300, deviceScaleFactor: 1, mobile: true });
  await verticalPageSwipe(client2, -240);
  assert.equal(await waitFor(client2, `(() => { const box = document.querySelector('.vote-timeline__date[datetime="2024-03-03"]').getBoundingClientRect(); return box.bottom <= 0 || box.top >= innerHeight; })()`), true, 'a real vertical swipe moves the scheduled graph date fully offscreen');
  await verticalPageSwipe(client2, 240);
  assert.equal(await waitFor(client2, `document.querySelector('.vote-timeline__date[datetime="2024-03-03"]').classList.contains('is-beam-running')`), true, 'the scheduled graph beam resumes on viewport re-entry');
  const reentryPhase = await evaluate(client2, `(async () => {
    for (let frame = 0; frame < 4; frame += 1) await new Promise(requestAnimationFrame);
    const date = document.querySelector('.vote-timeline__date[datetime="2024-03-03"]');
    const angle = Number.parseFloat(getComputedStyle(date, '::before').getPropertyValue('--beam-angle'));
    const expected = (document.timeline.currentTime % 1400) / 1400 * 360;
    const rawDifference = Math.abs(angle - expected);
    return { difference: Math.min(rawDifference, 360 - rawDifference), active: date.classList.contains('is-beam-running') };
  })()`);
  assert.ok(reentryPhase.active && reentryPhase.difference < 10, 'independent viewport re-entry resumes at the current normalized page phase after multiple animation frames');
  await client2.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0, connectionType: 'none' });
  assert.equal(await waitFor(client2, '!navigator.onLine'), true, 'the peer browser goes offline before the authoritative change');
  const scheduledEvent = server.database.prepare('SELECT id, revision FROM run_events WHERE event_date = ?').get('2024-03-03');
  const revertResponse = await fetch(`${baseUrl}/api/admin/events/2024-03-03`, {
    method: 'PUT',
    headers: { cookie: admin.cookie, origin: baseUrl, 'content-type': 'application/json', 'x-csrf-token': admin.csrfToken },
    body: JSON.stringify({ eventId: scheduledEvent.id, revision: scheduledEvent.revision, status: 'proposed', requestId: '00000000-0000-4000-8000-000000000145' }),
  });
  assert.equal(revertResponse.status, 200, 'the admin reverts the zero-vote scheduled event while the peer is disconnected');
  assert.equal(await waitFor(client, `!document.querySelector('.run-event-banner[data-date="2024-03-03"]')`), true, 'the online client removes the reverted event immediately');
  assert.equal(await evaluate(client2, `document.querySelector('.run-event-banner[data-date="2024-03-03"] .run-event-banner__status')?.textContent`), 'Scheduled', 'the offline peer retains its stale view until reconnect');
  await client2.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1, connectionType: 'wifi' });
  assert.equal(await waitFor(client2, `!document.querySelector('.run-event-banner[data-date="2024-03-03"]')`), true, 'socket reconnect repairs the peer banner from authoritative state');
  assert.equal(await evaluate(client2, `document.querySelector('.vote-timeline__date[datetime="2024-03-03"]').classList.contains('is-scheduled')`), false, 'socket reconnect repairs the scheduled graph state');
  assert.equal(await evaluate(client2, `document.querySelector('.vote-timeline__date[datetime="2024-03-03"]').classList.contains('is-beam-running')`), false, 'reconnect cleanup stops any active stale beam');
  for (const width of [320, 390, 1280]) {
    await client2.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: width <= 390 });
    const layout = await evaluate(client2, `(() => {
      const rows = document.querySelectorAll('.week-navigation');
      const nav = rows[0];
      const navBox = nav.getBoundingClientRect();
      const lastCard = document.querySelector('#week-days > li:last-child .vote-card').getBoundingClientRect();
      const timelineDates = [...document.querySelectorAll('.vote-timeline__date')].map((date) => ({ top: date.getBoundingClientRect().top, transform: getComputedStyle(date).transform, text: date.textContent.trim() }));
      const buttons = [...nav.querySelectorAll('button')].map((button) => {
        const box = button.getBoundingClientRect();
        return { label: button.textContent.trim(), name: button.getAttribute('aria-label') || button.textContent.trim(), top: box.top };
      });
      return { count: rows.length, viewportWidth: innerWidth, pageWidth: document.documentElement.scrollWidth, navTop: navBox.top, navLeft: navBox.left, navRight: navBox.right, lastCardBottom: lastCard.bottom, buttons, timelineDates };
    })()`);
    assert.equal(layout.count, 1, `one navigation row at ${width}px`);
    assert.equal(layout.viewportWidth, width);
    assert.ok(layout.navTop >= layout.lastCardBottom, `navigation follows the final card at ${width}px`);
    assert.ok(layout.pageWidth <= width, `no horizontal overflow at ${width}px`);
    assert.ok(layout.navLeft >= 0 && layout.navRight <= width, `navigation stays in the viewport at ${width}px`);
    assert.deepEqual(layout.buttons.map(({ label }) => label), ['<<', 'Now', '>>']);
    assert.deepEqual(layout.buttons.map(({ name }) => name), ['Previous week', 'Now', 'Next week']);
    assert.ok(layout.buttons.every(({ top }) => Math.abs(top - layout.buttons[0].top) < 1), `navigation is one row at ${width}px`);
    assert.ok(layout.timelineDates.length > 0 && layout.timelineDates.every(({ text }) => text.length > 0), `all graph dates remain visible at ${width}px`);
    assert.ok(layout.timelineDates.every(({ top }) => Math.abs(top - layout.timelineDates[0].top) < 1), `graph date labels share one horizontal baseline at ${width}px`);
    assert.ok(layout.timelineDates.every(({ transform }) => transform === 'none'), `graph date labels do not use alternating offsets at ${width}px`);
  }
  server.database.transaction(() => {
    server.database.prepare('DELETE FROM run_events').run();
    server.database.prepare('DELETE FROM votes').run();
  })();
  await client2.send('Page.reload', { ignoreCache: true });
  assert.equal(await waitFor(client2, `document.querySelectorAll('.vote-timeline__day').length > 0 && document.querySelectorAll('.run-event-banner').length === 0`), true, 'reloads the presentation with a fresh all-zero graph');
  const allZeroGraph = await evaluate(client2, `(() => {
    const days = [...document.querySelectorAll('.vote-timeline__day')];
    return {
      days: days.length,
      datesVisible: days.every((day) => getComputedStyle(day.querySelector('.vote-timeline__date')).visibility !== 'hidden'),
      countsHidden: days.every((day) => day.querySelector('.vote-timeline__count').getAttribute('aria-hidden') === 'true' && getComputedStyle(day.querySelector('.vote-timeline__count')).visibility === 'hidden'),
      barsZeroHeight: days.every((day) => day.querySelector('.vote-timeline__bar').getBoundingClientRect().height === 0),
      topCuesAbsent: days.every((day) => day.querySelector('.vote-timeline__top-cue').hidden),
      accessibleCounts: days.every((day) => day.getAttribute('aria-label').includes('0 votes') && !day.getAttribute('aria-label').includes('highest-vote date')),
    };
  })()`);
  assert.ok(allZeroGraph.days > 0);
  assert.equal(allZeroGraph.datesVisible, true, 'all-zero graph retains dates');
  assert.equal(allZeroGraph.countsHidden, true, 'all-zero graph hides every zero count label');
  assert.equal(allZeroGraph.barsZeroHeight, true, 'all-zero graph does not invent positive bar heights');
  assert.equal(allZeroGraph.topCuesAbsent, true, 'all-zero graph has no false highest-vote cues');
  assert.equal(allZeroGraph.accessibleCounts, true, 'all-zero graph still announces true counts accessibly');
  await evaluate(client2, `document.querySelector('#previous-week').focus()`);
  await pressEnter(client2);
  assert.equal(await waitFor(client2, `document.querySelector('#week-heading').textContent === 'Week 8 (2024)'`), true, 'keyboard activation of Previous week retains its existing navigation behavior');
  await evaluate(client2, `document.querySelector('#current-week').focus()`);
  await pressEnter(client2);
  assert.equal(await waitFor(client2, `document.querySelector('#week-heading').textContent === 'Week 9 (2024)'`), true, 'keyboard activation of Now returns to the current week');
});
