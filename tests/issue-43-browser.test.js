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
import { proposeRunEvent, setRunEventStatus, setVote } from '../src/domain.js';
import { addRoomMember } from '../src/room-storage.js';
import { removeProfileWithRetry } from './helpers/chromium-profile-cleanup.js';
import { chromiumReadinessTimeoutMs, readDevToolsPort, spawnChromium, stopChromium } from './helpers/chromium-startup.js';

const chromePath = process.env.CHROME_BIN ?? [
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/opt/google/chrome/chrome',
  '/opt/data/tmp/chrome/opt/google/chrome/chrome',
].find((path) => existsSync(path));
if (!chromePath) throw new Error('Issue 43 browser coverage requires real Chromium; refusing to skip.');

const ENV = { ADMIN_NAME: 'Issue 43 Browser Admin', ADMIN_PIN: '4826', PIN_PEPPER: 'synthetic-pepper' };
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

async function createFixture() {
  const directory = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'run-together-issue-43-browser-'));
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

async function register(baseUrl, name) {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST', headers: { origin: baseUrl, 'content-type': 'application/json' },
    body: JSON.stringify({ name, pin: '0042', pinConfirmation: '0042' }),
  });
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
  const session = await fetch(`${baseUrl}/api/session`, { headers: { cookie } }).then((result) => result.json());
  return { response, cookie, csrfToken: session.csrfToken };
}

function headers(baseUrl, user) {
  return { origin: baseUrl, cookie: user.cookie, 'x-csrf-token': user.csrfToken, 'content-type': 'application/json' };
}

async function createRoom(baseUrl, user, payload) {
  const response = await fetch(`${baseUrl}/api/rooms`, { method: 'POST', headers: headers(baseUrl, user), body: JSON.stringify(payload) });
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()).room;
}

async function updateRoom(baseUrl, user, roomId, payload) {
  const response = await fetch(`${baseUrl}/api/rooms/${encodeURIComponent(roomId)}`, {
    method: 'PUT', headers: headers(baseUrl, user), body: JSON.stringify(payload),
  });
  return { response, body: await response.json() };
}

function seedEvent(database, { roomId, userId, date, status = 'proposed' }) {
  addRoomMember(database, { roomId, userId, now: () => NOW });
  setVote(database, { roomId, userId, voteDate: date, body: { selected: true }, now: () => NOW });
  const proposal = proposeRunEvent(database, { roomId, userId, eventDate: date, requestId: randomUUID(), now: () => NOW });
  if (status === 'proposed') return proposal.event;
  return setRunEventStatus(database, {
    roomId, adminUserId: userId, eventDate: date, eventId: proposal.event.eventId,
    revision: proposal.event.revision, status, requestId: randomUUID(), now: () => NOW,
  }).event;
}

async function openPage(client, url) {
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Network.enable');
  await client.send('Page.navigate', { url });
}

async function click(client, selector) {
  await evaluate(client, `document.querySelector(${JSON.stringify(selector)})?.click()`);
}

test('Issue 43 room filters, metadata, icon menus, responsive cards, and board return work in real Chromium', async (t) => {
  const fixture = await createFixture();
  const owner = await register(fixture.baseUrl, 'Issue 43 Browser Owner');
  assert.equal(owner.response.status, 201);
  const ownerId = fixture.server.database.prepare('SELECT id FROM users WHERE name = ?').get('Issue 43 Browser Owner').id;
  const adminId = fixture.server.database.prepare("SELECT id FROM users WHERE role = 'admin'").get().id;
  const mixed = await createRoom(fixture.baseUrl, owner, { title: 'Mixed room', icon: 'running' });
  const scheduled = await createRoom(fixture.baseUrl, owner, { title: 'Scheduled room' });
  const proposed = await createRoom(fixture.baseUrl, owner, { title: 'Proposed room' });
  const votedOnly = await createRoom(fixture.baseUrl, owner, { title: 'Vote only room' });
  const noDates = await createRoom(fixture.baseUrl, owner, { title: 'No dates room' });
  seedEvent(fixture.server.database, { roomId: mixed.id, userId: adminId, date: '2026-10-28', status: 'scheduled' });
  seedEvent(fixture.server.database, { roomId: mixed.id, userId: adminId, date: '2026-10-29', status: 'proposed' });
  seedEvent(fixture.server.database, { roomId: scheduled.id, userId: adminId, date: '2026-10-30', status: 'scheduled' });
  seedEvent(fixture.server.database, { roomId: proposed.id, userId: ownerId, date: '2026-10-27', status: 'proposed' });
  setVote(fixture.server.database, { roomId: votedOnly.id, userId: ownerId, voteDate: '2026-10-31', body: { selected: true }, now: () => NOW });

  const profile = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'run-together-issue-43-chrome-'));
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
  const target = await createTarget(port);
  client = createCdpClient(target.webSocketDebuggerUrl);
  await openPage(client, `${fixture.baseUrl}/rooms`);
  await client.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { const NativeDate = Date; const fixedNow = ${NOW.getTime()}; class FixtureDate extends NativeDate { constructor(...args) { super(...(args.length ? args : [fixedNow])); } static now() { return fixedNow; } } window.Date = FixtureDate; })();` });
  const [cookieName, cookieValue] = owner.cookie.split('=', 2);
  await client.send('Network.setCookie', { url: fixture.baseUrl, name: cookieName, value: cookieValue, path: '/' });
  await client.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 844, deviceScaleFactor: 2, mobile: true });
  await client.send('Page.navigate', { url: `${fixture.baseUrl}/rooms` });
  assert.equal(await waitFor(client, `Boolean(document.querySelector('#rooms-content') && !document.querySelector('#rooms-content').hidden && document.querySelectorAll('.room-card').length === 6)`), true, 'loads authenticated room controls and all initial cards');

  const initial = await evaluate(client, `(() => ({
    filters: [...document.querySelectorAll('#room-filters input[type=checkbox]')].map((input) => ({ label: input.parentElement.textContent.trim(), checked: input.checked })),
    choices: [...document.querySelectorAll('#create-room-form .room-icon-picker option')].map((option) => option.value),
    defaultIcon: document.querySelector('#create-room-form .room-icon-picker select')?.value,
    visibleCards: [...document.querySelectorAll('.room-card')].filter((card) => !card.hidden).length,
    statuses: ['.room-card__dates--scheduled', '.room-card__dates--proposed'].map((selector) => document.querySelector('.room-card[data-room-id="${noDates.id}"] ' + selector)?.hidden),
    emptyDateLinesHidden: ['.room-card__dates--scheduled', '.room-card__dates--proposed'].map((selector) => {
      const line = document.querySelector('.room-card[data-room-id="${noDates.id}"] ' + selector);
      return { hidden: line.hidden, display: getComputedStyle(line).display, width: line.getBoundingClientRect().width };
    }),
  }))()`);
  assert.deepEqual(initial.filters.map(({ label, checked }) => [label, checked]), [['My voted', false], ['Scheduled', false], ['Proposed', false]]);
  assert.ok(initial.choices.includes('running') && initial.choices.includes('dinner') && initial.choices.includes('music'));
  assert.equal(initial.choices.length, 19, 'retains all nine sports and adds ten event icons');
  assert.equal(initial.defaultIcon, 'running');
  assert.equal(initial.visibleCards, 6, 'includes the pre-existing legacy room alongside five created rooms');
  assert.deepEqual(initial.statuses, [true, true]);
  assert.equal(initial.emptyDateLinesHidden.every((line) => line.hidden && line.display === 'none' && line.width === 0), true, 'empty scheduled and proposed date lines are not rendered');

  const roomCardState = await evaluate(client, `(() => {
    const card = document.querySelector('.room-card[data-room-id="${mixed.id}"]');
    const number = card.querySelector('.room-card__number');
    const owner = card.querySelector('.room-card__owner');
    const scheduled = document.querySelector('.room-card[data-room-id="${scheduled.id}"]');
    const proposed = document.querySelector('.room-card[data-room-id="${proposed.id}"]');
    const colorProbe = document.createElement('span');
    colorProbe.style.color = getComputedStyle(card).getPropertyValue('--room-color');
    document.body.append(colorProbe);
    const savedColor = getComputedStyle(colorProbe).color;
    colorProbe.remove();
    return {
      text: card.textContent,
      owner: owner.textContent,
      ownerBelowNumber: owner.getBoundingClientRect().top >= number.getBoundingClientRect().bottom,
      count: card.querySelector('.room-card__voter-count')?.textContent.trim(),
      countLabel: card.querySelector('.room-card__voter-count')?.getAttribute('aria-label'),
      bg: getComputedStyle(card).backgroundColor,
      borderColor: getComputedStyle(card).borderTopColor,
      storedColor: card.style.getPropertyValue('--room-color'),
      savedColor,
      titleFont: parseFloat(getComputedStyle(card.querySelector('.room-card__title')).fontSize),
      numberFont: parseFloat(getComputedStyle(number).fontSize),
      scheduledBorder: getComputedStyle(scheduled).borderTopWidth,
      scheduledClass: scheduled.className,
      scheduledBorderDeclaration: [...document.styleSheets].flatMap((sheet) => { try { return [...sheet.cssRules]; } catch { return []; } }).find((rule) => rule.selectorText === '.room-card.is-scheduled')?.style.borderWidth,
      scheduledBeamWidth: getComputedStyle(scheduled).getPropertyValue('--border-width'),
      ordinaryBorder: getComputedStyle(card).borderTopWidth,
      todayProposedGlows: proposed.querySelector('.room-card__date-value')?.classList.contains('is-proposed-date-glowing'),
      laterProposedDoesNotGlow: !card.querySelector('.room-card__dates--proposed .room-card__date-value')?.classList.contains('is-proposed-date-glowing'),
      scheduledDateDoesNotGlow: !scheduled.querySelector('.room-card__dates--scheduled .room-card__date-value')?.classList.contains('is-proposed-date-glowing'),
      width: card.getBoundingClientRect().width,
      height: card.getBoundingClientRect().height,
      pageWidth: document.documentElement.scrollWidth,
    };
  })()`);
  assert.equal(roomCardState.owner, 'Issue 43 Browser Owner');
  assert.equal(roomCardState.ownerBelowNumber, true);
  assert.equal(roomCardState.count, '1 voter');
  assert.match(roomCardState.countLabel, /1 distinct voter/);
  assert.equal(roomCardState.bg, 'rgba(0, 0, 0, 0)');
  assert.equal(roomCardState.borderColor, roomCardState.savedColor, 'the saved room color appears on its border');
  assert.ok(roomCardState.numberFont >= roomCardState.titleFont * 1.19, 'Room No. is at least 20% larger than the enlarged title');
  assert.equal(roomCardState.ordinaryBorder, '5px');
  assert.equal(roomCardState.scheduledBorderDeclaration, '5.5px', 'the scheduled border is declared 10% thicker than the ordinary 5px border');
  assert.equal(roomCardState.scheduledBeamWidth, '5.5px', 'the shared scheduled effect follows the thicker room-card border');
  assert.equal(roomCardState.todayProposedGlows, true, 'the upcoming Bangkok-today proposal glows');
  assert.equal(roomCardState.laterProposedDoesNotGlow, true, 'a proposal beyond tomorrow does not glow');
  assert.equal(roomCardState.scheduledDateDoesNotGlow, true, 'scheduled dates never use the proposed-date glow');
  assert.ok(roomCardState.width <= 320 && roomCardState.pageWidth <= 320);
  assert.ok(roomCardState.height >= 180);

  const visibleIds = async () => evaluate(client, `[...document.querySelectorAll('.room-card')].filter((card) => !card.hidden).map((card) => card.dataset.roomId)`);
  await click(client, '#filter-scheduled');
  assert.deepEqual(new Set(await visibleIds()), new Set([mixed.id, scheduled.id]));
  assert.equal(await evaluate(client, `[...document.querySelectorAll('.room-card[hidden]')].every((card) => getComputedStyle(card).display === 'none' && card.getBoundingClientRect().width === 0)`), true, 'filtered cards are not rendered or visible');
  await click(client, '#filter-proposed');
  assert.deepEqual(new Set(await visibleIds()), new Set([mixed.id, scheduled.id, proposed.id]));
  await click(client, '#filter-scheduled');
  assert.deepEqual(new Set(await visibleIds()), new Set([mixed.id, proposed.id]));
  await click(client, '#filter-my-voted');
  assert.deepEqual(new Set(await visibleIds()), new Set([proposed.id]));
  await click(client, '#filter-proposed');
  assert.deepEqual(new Set(await visibleIds()), new Set([proposed.id, votedOnly.id]));
  await click(client, '#filter-scheduled');
  assert.deepEqual(await visibleIds(), []);
  const noMatch = await evaluate(client, `({ message: document.querySelector('#rooms-no-matches')?.hidden, filters: !document.querySelector('#room-filters').hidden, create: !document.querySelector('#create-room-form button[type=submit]').disabled, empty: document.querySelector('#rooms-empty').hidden })`);
  assert.deepEqual(noMatch, { message: false, filters: true, create: true, empty: true });
  await click(client, '#filter-my-voted');
  await click(client, '#filter-scheduled');
  assert.equal((await visibleIds()).length, 6, 'clearing the filters restores every room');
  await click(client, '#filter-my-voted');
  assert.deepEqual(new Set(await visibleIds()), new Set([proposed.id, votedOnly.id]));
  const filteredRoomUpdate = await updateRoom(fixture.baseUrl, owner, votedOnly.id, { venue: 'Filter refresh' });
  assert.equal(filteredRoomUpdate.response.status, 200);
  assert.equal(await waitFor(client, `document.querySelector('.room-card[data-room-id="${votedOnly.id}"] .room-card__venue')?.textContent === 'Filter refresh'`), true, 'refreshes a room card after realtime summary changes');
  assert.equal(await evaluate(client, `document.querySelector('#filter-my-voted').checked`), true, 'a live room refresh preserves the viewer filter');
  assert.deepEqual(new Set(await visibleIds()), new Set([proposed.id, votedOnly.id]));
  await click(client, '#filter-my-voted');

  await evaluate(client, `(() => {
    const form = document.querySelector('#create-room-form');
    form.elements.title.value = 'Rejected Venue';
    form.elements.venue.value = 'x'.repeat(31);
    form.requestSubmit();
  })()`);
  assert.equal(await waitFor(client, `document.querySelector('#rooms-message')?.textContent.includes('Venue must be 30 characters or fewer')`), true, 'the form gives a visible validation error for an overlong venue');
  assert.equal(await evaluate(client, `document.querySelectorAll('.room-card').length`), 6, 'invalid metadata does not create a room');

  await evaluate(client, `(() => {
    const form = document.querySelector('#create-room-form');
    form.elements.title.value = 'Cafe <img src=x>';
    form.elements.venue.value = '  Harbor <b>Hall</b>  ';
    form.elements.time.value = '07:05';
    form.querySelector('select[name=icon]').value = 'coffee';
    form.requestSubmit();
  })()`);
  const created = await waitFor(client, `document.querySelector('.room-card__title')?.textContent === 'Cafe <img src=x>' || [...document.querySelectorAll('.room-card__title')].some((title) => title.textContent === 'Cafe <img src=x>')`);
  assert.equal(created, true);
  const createdMetadata = await evaluate(client, `(() => {
    const card = [...document.querySelectorAll('.room-card')].find((item) => item.querySelector('.room-card__title')?.textContent === 'Cafe <img src=x>');
    return { venue: card.querySelector('.room-card__venue')?.textContent, time: card.querySelector('.room-card__time')?.textContent, icon: card.querySelector('.room-card__icon')?.textContent, injected: Boolean(card.querySelector('img,b')), venueHtml: card.querySelector('.room-card__venue')?.innerHTML };
  })()`);
  assert.equal(createdMetadata.venue, 'Harbor <b>Hall</b>');
  assert.equal(createdMetadata.time, '07:05');
  assert.equal(createdMetadata.icon, '☕');
  assert.equal(createdMetadata.injected, false);
  assert.match(createdMetadata.venueHtml, /&lt;b&gt;Hall&lt;\/b&gt;/);

  await click(client, `.room-card[data-room-id="${mixed.id}"] .room-card__edit`);
  const editState = await evaluate(client, `(() => ({
    open: document.querySelector('.room-edit-dialog')?.open,
    venue: document.querySelector('#room-edit-form input[name=venue]')?.value,
    time: document.querySelector('#room-edit-form input[name=time]')?.value,
    picker: document.querySelector('#room-edit-form select[name=icon]')?.value,
  }))()`);
  assert.equal(editState.open, true);
  assert.equal(editState.picker, 'running');
  assert.equal(editState.venue, '');
  assert.equal(editState.time, '');
  await evaluate(client, `(() => {
    const form = document.querySelector('#room-edit-form');
    form.elements.venue.value = 'Updated place';
    form.elements.time.value = '18:45';
    form.querySelector('select[name=icon]').value = 'dinner';
    form.requestSubmit();
  })()`);
  assert.equal(await waitFor(client, `document.querySelector('.room-card[data-room-id="${mixed.id}"] .room-card__time')?.textContent === '18:45'`), true);
  const colorAndIcon = await evaluate(client, `(() => { const card = document.querySelector('.room-card[data-room-id="${mixed.id}"]'); return { color: card.style.getPropertyValue('--room-color'), icon: card.querySelector('.room-card__icon').textContent, selected: card.querySelector('.room-card__icon-label')?.textContent }; })()`);
  assert.equal(colorAndIcon.icon, '🍽️');
  assert.equal(colorAndIcon.color, roomCardState.storedColor, 'changing an icon preserves the saved room color');

  await client.send('Emulation.setDeviceMetricsOverride', { width: 160, height: 844, deviceScaleFactor: 1, mobile: true });
  const zoomLayout = await evaluate(client, `(() => ({ width: innerWidth, pageWidth: document.documentElement.scrollWidth, cards: [...document.querySelectorAll('.room-card')].filter((card) => !card.hidden).map((card) => card.getBoundingClientRect().width) }))()`);
  assert.ok(zoomLayout.pageWidth <= zoomLayout.width, '200% zoom-sized viewport has no page-level horizontal overflow');
  assert.ok(zoomLayout.cards.every((width) => width > 0));

  const todayProposal = `.room-card[data-room-id="${proposed.id}"] .room-card__date-value`;
  await evaluate(client, `document.querySelector(${JSON.stringify(todayProposal)}).scrollIntoView({ block: 'center' })`);
  assert.equal(await waitFor(client, `document.querySelector(${JSON.stringify(todayProposal)}).classList.contains('is-proposed-glow-running')`), true, 'starts the shared pulse when an upcoming proposal enters view');
  await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  assert.equal(await waitFor(client, `!document.querySelector(${JSON.stringify(todayProposal)}).classList.contains('is-proposed-glow-running')`), true, 'stops the proposed-date pulse for reduced motion');
  const reducedGlow = await evaluate(client, `(() => { const date = document.querySelector(${JSON.stringify(todayProposal)}); const style = getComputedStyle(date); return { animation: style.animationName, shadow: style.textShadow }; })()`);
  assert.equal(reducedGlow.animation, 'none');
  assert.notEqual(reducedGlow.shadow, 'none', 'reduced motion keeps the static readable highlight');
  await client.send('Emulation.setEmulatedMedia', { features: [] });
  assert.equal(await waitFor(client, `document.querySelector(${JSON.stringify(todayProposal)}).classList.contains('is-proposed-glow-running')`), true, 'restores the pulse when motion is allowed again');

  await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await client.send('Page.navigate', { url: `${fixture.baseUrl}/vote/${mixed.id}` });
  assert.equal(await waitFor(client, `Boolean(document.querySelector('#protected-content') && !document.querySelector('#protected-content').hidden && document.querySelector('#room-heading'))`), true);
  const boardHeader = await evaluate(client, `(() => {
    const link = document.querySelector('#back-to-rooms');
    const title = document.querySelector('#room-heading');
    const venue = document.querySelector('#room-venue');
    const time = document.querySelector('#room-time');
    const box = link.getBoundingClientRect();
    const headingBox = title.getBoundingClientRect();
    const overlap = box.left < headingBox.right && box.right > headingBox.left && box.top < headingBox.bottom && box.bottom > headingBox.top;
    return { accessibleName: link.getAttribute('aria-label'), width: box.width, height: box.height, href: link.getAttribute('href'), overlap, venue: venue?.textContent, time: time?.textContent, returnLinks: [...document.querySelectorAll('#protected-content a[aria-label="Return to rooms"]')].length,
 inHeader: Boolean(link.closest('#room-page-header')) };
  })()`);
  assert.equal(boardHeader.accessibleName, 'Return to rooms');
  assert.ok(boardHeader.width >= 44 && boardHeader.height >= 44);
  assert.equal(boardHeader.href, '/rooms');
  assert.equal(boardHeader.overlap, false);
  assert.equal(boardHeader.venue, 'Updated place');
  assert.equal(boardHeader.time, '18:45');
  assert.equal(boardHeader.returnLinks, 1);
  assert.equal(boardHeader.inHeader, true);
  const liveMetadata = await updateRoom(fixture.baseUrl, owner, mixed.id, { venue: 'Live <img>' });
  assert.equal(liveMetadata.response.status, 200);
  assert.equal(await waitFor(client, `document.querySelector('#room-venue')?.textContent === 'Live <img>'`), true, 'room headers refresh metadata after an owner edit in another context');
  const safeLiveVenue = await evaluate(client, `(() => ({ injected: Boolean(document.querySelector('#room-venue img')), html: document.querySelector('#room-venue').innerHTML, time: document.querySelector('#room-time').textContent }))()`);
  assert.equal(safeLiveVenue.injected, false);
  assert.match(safeLiveVenue.html, /&lt;img&gt;/);
  assert.equal(safeLiveVenue.time, '18:45', 'a venue-only edit retains the existing room time');
  const clearedTime = await updateRoom(fixture.baseUrl, owner, mixed.id, { time: '' });
  assert.equal(clearedTime.response.status, 200);
  assert.equal(await waitFor(client, `document.querySelector('#room-time-line').hidden`), true, 'a cleared time hides only its own board header line');
  assert.equal(await evaluate(client, `document.querySelector('#room-venue-line').hidden`), false);
  const clearedVenue = await updateRoom(fixture.baseUrl, owner, mixed.id, { venue: '' });
  assert.equal(clearedVenue.response.status, 200);
  assert.equal(await waitFor(client, `document.querySelector('#room-venue-line').hidden`), true, 'a cleared venue hides its board header line');
  await click(client, '#back-to-rooms');
  assert.equal(await waitFor(client, `location.pathname === '/rooms'`), true, 'the header exit returns to the room list');
});
