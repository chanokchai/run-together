import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';
import { LEGACY_ROOM_ID } from '../src/room-contract.js';
import { removeProfileWithRetry } from './helpers/chromium-profile-cleanup.js';
import { chromiumReadinessTimeoutMs, readDevToolsPort, spawnChromium, stopChromium } from './helpers/chromium-startup.js';

const chromePath = process.env.CHROME_BIN ?? [
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/opt/google/chrome/chrome',
  '/opt/data/tmp/chrome/opt/google/chrome/chrome',
].find((path) => existsSync(path));
const ENV = { ADMIN_NAME: 'Issue 38 Browser Admin', ADMIN_PIN: '4826', PIN_PEPPER: 'synthetic-pepper' };
const NOW = new Date('2026-10-27T04:00:00.000Z');

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
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}

async function waitFor(client, expression, timeoutMs = 6000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await evaluate(client, expression)) return true;
    await delay(50);
  }
  return false;
}

async function registerMember(baseUrl) {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ name: 'Issue 38 Browser Owner', pin: '0042', pinConfirmation: '0042' }),
  });
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
  const session = await fetch(`${baseUrl}/api/session`, { headers: { cookie } }).then((result) => result.json());
  return { response, cookie, csrfToken: session.csrfToken };
}

test('Issue 38 room cards, editing, safe titles and explicit board navigation work in real Chromium', {
  skip: chromePath ? false : 'Chromium is unavailable; set CHROME_BIN to run Issue 38 browser coverage',
}, async (t) => {
  const directory = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'run-together-issue-38-browser-'));
  const server = createServer({ databasePath: join(directory, 'preview.sqlite'), env: ENV, now: () => NOW });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  let client;
  let client2;
  let client3;
  let browser;
  let profile;
  t.after(async () => {
    client?.close();
    client2?.close();
    client3?.close();
    try {
      if (browser) await stopChromium(browser);
    } finally {
      if (profile) await removeProfileWithRetry(profile);
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  const owner = await registerMember(baseUrl);
  assert.equal(owner.response.status, 201);
  profile = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'run-together-issue-38-chrome-'));
  browser = spawnChromium(chromePath, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ]);
  const port = await readDevToolsPort(profile, browser, { timeoutMs: chromiumReadinessTimeoutMs });
  const target = await createTarget(port);
  client = createCdpClient(target.webSocketDebuggerUrl);
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Network.enable');
  const [cookieName, cookieValue] = owner.cookie.split('=', 2);
  await client.send('Network.setCookie', { url: baseUrl, name: cookieName, value: cookieValue, path: '/' });
  await client.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 844, deviceScaleFactor: 1, mobile: true });
  await client.send('Page.navigate', { url: `${baseUrl}/rooms` });

  assert.equal(await waitFor(client, `Boolean(document.querySelector('#rooms-content') && !document.querySelector('#rooms-content').hidden && document.querySelector('#create-room-form'))`), true, 'authenticated room selection page loads and reveals room creation');
  const emptyView = await evaluate(client, `({
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    cards: document.querySelectorAll('.room-card').length,
    formVisible: !document.querySelector('#create-room-form').hidden,
    emptyMessage: document.querySelector('#rooms-empty').textContent,
    iconOptions: document.querySelectorAll('#create-icon-picker input[type="radio"]').length,
    selectedIcon: document.querySelector('#create-icon-picker input:checked')?.value,
  })`);
  assert.ok(emptyView.scrollWidth <= emptyView.width, 'keeps the room list layout inside a 320px viewport');
  assert.equal(emptyView.formVisible, true, 'keeps room creation available when the list has no user-created rooms');
  assert.equal(emptyView.selectedIcon, 'running', 'selects the running icon by default');
  assert.ok(emptyView.iconOptions >= 8, 'offers the curated sports and event icon choices');

  await evaluate(client, `(() => { const form = document.querySelector('#create-room-form'); form.elements.title.value = 'X'.repeat(31); form.requestSubmit(); })()`);
  assert.equal(await waitFor(client, `document.querySelector('#rooms-message').textContent.includes('30 characters or fewer')`), true, 'rejects an over-limit title in the client before creating a room');
  assert.equal(await evaluate(client, `document.querySelectorAll('.room-card').length`), 1, 'keeps the invalid title out of the shared room list');

  const maliciousTitle = '<img src=x onerror=alert(1)>';
  await evaluate(client, `(() => {
    const form = document.querySelector('#create-room-form');
    form.elements.title.value = ${JSON.stringify(maliciousTitle)};
    form.querySelector('input[name="icon"][value="football"]').checked = true;
    form.requestSubmit();
    return true;
  })()`);
  assert.equal(await waitFor(client, `document.querySelectorAll('.room-card').length === 2`), true, 'creates a room and refreshes the live room list');
  const createdCard = await evaluate(client, `(() => {
    const card = [...document.querySelectorAll('.room-card')].find((candidate) => candidate.querySelector('.room-card__title')?.textContent === ${JSON.stringify(maliciousTitle)});
    const box = card.getBoundingClientRect();
    return {
      id: card.dataset.roomId,
      title: card.querySelector('.room-card__title').textContent,
      hasInjectedImage: Boolean(card.querySelector('img')),
      iconLabel: card.querySelector('.room-card__icon').textContent,
      number: card.querySelector('.room-card__number').textContent,
      scheduled: card.querySelector('.room-card__dates--scheduled').textContent,
      proposed: card.querySelector('.room-card__dates--proposed').textContent,
      editVisible: !card.querySelector('.room-card__edit').hidden,
      color: card.style.getPropertyValue('--room-color'),
      width: box.width,
      height: box.height,
      href: card.querySelector('.room-card__entry').getAttribute('href'),
    };
  })()`);
  assert.match(createdCard.id, /^[0-9a-f-]{36}$/);
  assert.equal(createdCard.title, maliciousTitle, 'renders user-provided titles as text');
  assert.equal(createdCard.hasInjectedImage, false, 'does not interpret a room title as markup');
  assert.equal(createdCard.iconLabel, '⚽');
  assert.match(createdCard.number, /Room 0\d/);
  assert.match(createdCard.scheduled, /Scheduled: None/);
  assert.match(createdCard.proposed, /Proposed: None/);
  assert.equal(createdCard.editVisible, true, 'shows the edit control to the room owner');
  assert.ok(createdCard.color);
  assert.ok(Math.abs(createdCard.width - createdCard.height) <= 1, 'renders a square responsive card');
  assert.equal(createdCard.href, `/vote/${createdCard.id}`);

  await client.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  const desktopLayout = await evaluate(client, `({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, card: document.querySelector('.room-card[data-room-id="${createdCard.id}"]').getBoundingClientRect().toJSON() })`);
  assert.ok(desktopLayout.scrollWidth <= desktopLayout.width, 'keeps the desktop room page within the viewport width');
  assert.ok(Math.abs(desktopLayout.card.width - desktopLayout.card.height) <= 1, 'keeps room cards square at desktop widths');
  await client.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 844, deviceScaleFactor: 1, mobile: true });

  await evaluate(client, `(() => {
    const card = [...document.querySelectorAll('.room-card')].find((candidate) => candidate.dataset.roomId === ${JSON.stringify(createdCard.id)});
    card.querySelector('.room-card__edit').click();
    const dialog = document.querySelector('.room-edit-dialog');
    dialog.querySelector('input[name="title"]').value = 'Edited <b>Room</b>';
    dialog.querySelector('input[name="icon"][value="tennis"]').checked = true;
    dialog.querySelector('form').requestSubmit();
  })()`);
  assert.equal(await waitFor(client, `document.querySelector('.room-card[data-room-id="${createdCard.id}"] .room-card__title')?.textContent === 'Edited <b>Room</b>'`), true, 'updates the owned card after editing its title and icon');
  const editedCard = await evaluate(client, `(() => {
    const card = document.querySelector('.room-card[data-room-id="${createdCard.id}"]');
    return { icon: card.querySelector('.room-card__icon').textContent, color: card.style.getPropertyValue('--room-color'), title: card.querySelector('.room-card__title').textContent };
  })()`);
  assert.equal(editedCard.icon, '🎾');
  assert.equal(editedCard.color, createdCard.color, 'an icon edit preserves the stored room color');
  assert.equal(editedCard.title, 'Edited <b>Room</b>');

  const secondRoomResponse = await fetch(`${baseUrl}/api/rooms`, {
    method: 'POST',
    headers: { origin: baseUrl, cookie: owner.cookie, 'x-csrf-token': owner.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Second room', icon: 'swimming' }),
  });
  assert.equal(secondRoomResponse.status, 201);
  const secondRoom = (await secondRoomResponse.json()).room;
  assert.equal(await waitFor(client, `document.querySelectorAll('.room-card').length === 3 && document.querySelector('.room-card[data-room-id="${secondRoom.id}"]') !== null`), true, 'refreshes the room list after a second room is created');

  const voteForProposal = await fetch(`${baseUrl}/api/rooms/${createdCard.id}/votes/2026-10-28`, {
    method: 'PUT',
    headers: { origin: baseUrl, cookie: owner.cookie, 'x-csrf-token': owner.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ selected: true }),
  });
  assert.equal(voteForProposal.status, 200);
  const proposalResponse = await fetch(`${baseUrl}/api/rooms/${createdCard.id}/events/2026-10-28`, {
    method: 'POST',
    headers: { origin: baseUrl, cookie: owner.cookie, 'x-csrf-token': owner.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: randomUUID() }),
  });
  assert.equal(proposalResponse.status, 201);
  const proposal = (await proposalResponse.json()).event;
  assert.equal(await waitFor(client, `document.querySelector('.room-card[data-room-id="${createdCard.id}"] .room-card__dates--proposed')?.textContent.trim() === 'Proposed: 28-Oct'`), true, 'shows upcoming proposed dates on the shared card');
  assert.equal(await evaluate(client, `document.querySelector('.room-card[data-room-id="${createdCard.id}"]').classList.contains('is-scheduled')`), false, 'a proposal alone does not activate the scheduled-card effect');

  await evaluate(client, `window.roomCardBeforeSummary = document.querySelector('.room-card[data-room-id="${createdCard.id}"]')`);
  const scheduleResponse = await fetch(`${baseUrl}/api/rooms/${createdCard.id}/admin/events/2026-10-28`, {
    method: 'PUT',
    headers: { origin: baseUrl, cookie: owner.cookie, 'x-csrf-token': owner.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ eventId: proposal.eventId, revision: proposal.revision, requestId: randomUUID(), status: 'scheduled' }),
  });
  assert.equal(scheduleResponse.status, 200);
  const scheduled = (await scheduleResponse.json()).event;
  assert.equal(await waitFor(client, `document.querySelector('.room-card[data-room-id="${createdCard.id}"] .room-card__dates--scheduled')?.textContent.trim() === 'Scheduled: 28-Oct'`), true, 'refreshes the card summary after the live schedule update');
  await evaluate(client, `document.querySelector('.room-card[data-room-id="${createdCard.id}"]').scrollIntoView({ block: 'center' })`);
  assert.equal(await waitFor(client, `document.querySelector('.room-card[data-room-id="${createdCard.id}"]').classList.contains('is-beam-running')`), true, 'starts the shared border beam for an upcoming scheduled event');
  assert.equal(await evaluate(client, `document.querySelector('.room-card[data-room-id="${createdCard.id}"]') === window.roomCardBeforeSummary`), true, 'retains the keyed card node during live summary updates');
  assert.equal(await evaluate(client, `document.querySelector('.room-card[data-room-id="${createdCard.id}"] .room-card__dates--scheduled').textContent.trim()`), 'Scheduled: 28-Oct');

  await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  assert.equal(await waitFor(client, `!document.querySelector('.room-card[data-room-id="${createdCard.id}"]').classList.contains('is-beam-running')`), true, 'disables the card beam for reduced-motion users');
  await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  assert.equal(await waitFor(client, `document.querySelector('.room-card[data-room-id="${createdCard.id}"]').classList.contains('is-beam-running')`), true, 'restores the scheduled card effect when reduced motion is disabled');

  const deleteEvent = await fetch(`${baseUrl}/api/rooms/${createdCard.id}/admin/events/2026-10-28`, {
    method: 'DELETE',
    headers: { origin: baseUrl, cookie: owner.cookie, 'x-csrf-token': owner.csrfToken, 'content-type': 'application/json' },
    body: JSON.stringify({ eventId: scheduled.eventId, revision: scheduled.revision, requestId: randomUUID() }),
  });
  assert.equal(deleteEvent.status, 200);
  assert.equal(await waitFor(client, `!document.querySelector('.room-card[data-room-id="${createdCard.id}"]').classList.contains('is-scheduled') && !document.querySelector('.room-card[data-room-id="${createdCard.id}"]').classList.contains('is-beam-running')`), true, 'removes the scheduled effect after the event is deleted');
  assert.equal(await evaluate(client, `document.querySelector('.room-card[data-room-id="${createdCard.id}"] .room-card__dates--scheduled').textContent.trim()`), 'Scheduled: None');

  await evaluate(client, `document.querySelector('.room-card[data-room-id="${createdCard.id}"] .room-card__entry').click()`);
  assert.equal(await waitFor(client, `location.pathname === '/vote/${createdCard.id}' && document.querySelector('#room-heading')?.textContent === 'Edited <b>Room</b>'`), true, 'records room entry and opens its explicitly selected board');
  assert.equal(await waitFor(client, `/^Week \\d+ \\(\\d{4}\\)$/.test(document.querySelector('#week-heading')?.textContent ?? '')`), true, 'loads the selected room week before validating the compact identity line');
  const boardState = await evaluate(client, `({
    roomId: document.querySelector('#protected-content').dataset.roomId,
    title: document.querySelector('#room-heading').textContent,
    week: document.querySelector('#week-heading').textContent,
    hasWeekRange: Boolean(document.querySelector('#week-range')),
    hasGreeting: document.body.textContent.includes('Welcome,'),
    returnHref: document.querySelector('#back-to-rooms').getAttribute('href'),
  })`);
  assert.equal(boardState.roomId, createdCard.id);
  assert.equal(boardState.title, 'Edited <b>Room</b>');
  assert.match(boardState.week, /^Week \d+ \(\d{4}\)$/);
  assert.equal(boardState.hasWeekRange, false, 'removes the week date-range line');
  assert.equal(boardState.hasGreeting, false, 'removes the board greeting');
  assert.equal(boardState.returnHref, '/rooms');

  const secondTarget = await createTarget(port);
  client2 = createCdpClient(secondTarget.webSocketDebuggerUrl);
  await client2.send('Page.enable');
  await client2.send('Runtime.enable');
  await client2.send('Network.enable');
  await client2.send('Network.setCookie', { url: baseUrl, name: cookieName, value: cookieValue, path: '/' });
  await client2.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 844, deviceScaleFactor: 1, mobile: true });
  await client2.send('Page.navigate', { url: `${baseUrl}/vote/${secondRoom.id}` });
  assert.equal(await waitFor(client2, `document.querySelector('#protected-content')?.dataset.roomId === '${secondRoom.id}' && !document.querySelector('#protected-content').hidden && /^Week \\d+ \\(\\d{4}\\)$/.test(document.querySelector('#week-heading')?.textContent ?? '')`), true, 'opens a second tab in the same session with a different permanent room identity');
  assert.equal(await waitFor(client, `document.querySelector('.vote-card[data-date="2026-10-28"]')?.dataset.selected === 'true'`), true, 'keeps the first room’s vote selected after switching rooms in another tab');
  await evaluate(client2, `window.issue38Paths = []; const originalFetch = window.fetch.bind(window); window.fetch = (...args) => { window.issue38Paths.push(String(args[0])); return originalFetch(...args); };`);
  await evaluate(client2, `document.querySelector('.vote-card[data-date="2026-10-28"]').click()`);
  assert.equal(await waitFor(client2, `document.querySelector('.vote-card[data-date="2026-10-28"]')?.dataset.selected === 'true'`), true, 'records the same date independently in the second room');
  assert.equal(await waitFor(client2, `window.issue38Paths.includes('/api/rooms/${secondRoom.id}/votes/2026-10-28')`), true, 'sends an explicit scoped vote request from the second tab');
  const firstRoomWeek = await fetch(`${baseUrl}/api/rooms/${createdCard.id}/weeks/2026-10-26`, { headers: { cookie: owner.cookie } }).then((response) => response.json());
  const secondRoomWeek = await fetch(`${baseUrl}/api/rooms/${secondRoom.id}/weeks/2026-10-26`, { headers: { cookie: owner.cookie } }).then((response) => response.json());
  assert.equal(firstRoomWeek.days.find(({ date }) => date === '2026-10-28').voteCount, 1);
  assert.equal(secondRoomWeek.days.find(({ date }) => date === '2026-10-28').voteCount, 1);

  const thirdTarget = await createTarget(port);
  client3 = createCdpClient(thirdTarget.webSocketDebuggerUrl);
  await client3.send('Page.enable');
  await client3.send('Runtime.enable');
  await client3.send('Network.enable');
  await client3.send('Network.setCookie', { url: baseUrl, name: cookieName, value: cookieValue, path: '/' });
  await client3.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 844, deviceScaleFactor: 1, mobile: true });
  await client3.send('Page.navigate', { url: `${baseUrl}/vote/${LEGACY_ROOM_ID}` });
  assert.equal(await waitFor(client3, `document.querySelector('#protected-content')?.dataset.roomId === '${LEGACY_ROOM_ID}' && !document.querySelector('#protected-content').hidden && /^Week \\d+ \\(\\d{4}\\)$/.test(document.querySelector('#week-heading')?.textContent ?? '')`), true, 'opens the migrated shared room explicitly in a third same-session tab');
  await evaluate(client3, `window.issue38Paths = []; const originalFetch = window.fetch.bind(window); window.fetch = (...args) => { window.issue38Paths.push(String(args[0])); return originalFetch(...args); };`);
  await evaluate(client3, `document.querySelector('.vote-card[data-date="2026-10-28"]').click()`);
  assert.equal(await waitFor(client3, `document.querySelector('.vote-card[data-date="2026-10-28"]')?.dataset.selected === 'true'`), true, 'records the same date independently in the migrated shared room');
  assert.equal(await waitFor(client3, `window.issue38Paths.includes('/api/rooms/${LEGACY_ROOM_ID}/votes/2026-10-28')`), true, 'sends the legacy vote through its explicit room UUID');
  const legacyWeek = await fetch(`${baseUrl}/api/rooms/${LEGACY_ROOM_ID}/weeks/2026-10-26`, { headers: { cookie: owner.cookie } }).then((response) => response.json());
  assert.equal(legacyWeek.days.find(({ date }) => date === '2026-10-28').voteCount, 1);

  const liveEdit = await fetch(`${baseUrl}/api/rooms/${createdCard.id}`, {
    method: 'PUT',
    headers: { cookie: owner.cookie, origin: baseUrl, 'content-type': 'application/json', 'x-csrf-token': owner.csrfToken },
    body: JSON.stringify({ title: 'Live title update' }),
  });
  assert.equal(liveEdit.status, 200);
  assert.equal(await waitFor(client, `document.querySelector('#room-heading')?.textContent === 'Live title update'`), true, 'updates an open board heading from the live room summary feed');
  await delay(100);
  assert.equal(await evaluate(client2, `document.querySelector('#room-heading')?.textContent`), 'Second room', 'does not cross room titles between simultaneous same-session tabs');
  assert.equal(await evaluate(client3, `document.querySelector('#room-heading')?.textContent`), 'Run Together', 'does not cross the live title into the migrated shared room tab');
});
