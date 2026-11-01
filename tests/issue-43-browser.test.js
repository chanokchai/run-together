import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
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
  let currentNow = NOW;
  const server = createServer({ databasePath: join(directory, 'preview.sqlite'), env: ENV, now: () => currentNow });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    directory,
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    setNow(value) { currentNow = new Date(value); },
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
  const startupStartedAt = performance.now();
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
  const readinessMs = performance.now() - startupStartedAt;
  t.diagnostic(`Chromium launch-to-DevTools readiness ${readinessMs.toFixed(1)}ms; executable: ${browser.spawnfile}; state: ${browser.exitCode === null && browser.signalCode === null ? 'running' : 'exited'}; exitCode: ${browser.exitCode}; signalCode: ${browser.signalCode}; deadline: ${chromiumReadinessTimeoutMs}ms.`);
  const target = await createTarget(port);
  client = createCdpClient(target.webSocketDebuggerUrl);
  await openPage(client, `${fixture.baseUrl}/rooms`);
  await client.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const NativeDate = Date;
    let fixedNow = ${NOW.getTime()};
    class FixtureDate extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [fixedNow])); }
      static now() { return fixedNow; }
    }
    window.Date = FixtureDate;
    window.__setIssue43Now = (value) => { fixedNow = value; };
    const nativeSetTimeout = window.setTimeout.bind(window);
    let captured = false;
    window.setTimeout = (callback, milliseconds, ...args) => {
      if (!captured && Number(milliseconds) > 60000) {
        captured = true;
        window.__fireRoomDayRollover = () => callback(...args);
      }
      return nativeSetTimeout(callback, milliseconds, ...args);
    };
  })();` });
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
  await click(client, '#filter-proposed');
  assert.deepEqual(new Set(await visibleIds()), new Set([proposed.id]), 'all three filters require My voted and either selected status');
  assert.equal(await evaluate(client, 'document.querySelector("#rooms-no-matches").hidden'), true, 'hides the no-match message when all three selected filters match');
  await click(client, '#filter-proposed');
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

  let tomorrowProposalEvent;
  for (const date of ['2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']) {
    const event = seedEvent(fixture.server.database, { roomId: proposed.id, userId: ownerId, date });
    if (date === '2026-10-28') tomorrowProposalEvent = event;
  }
  const longRoom = await updateRoom(fixture.baseUrl, owner, proposed.id, {
    title: 'W'.repeat(30), venue: 'W'.repeat(30), time: '18:45',
  });
  assert.equal(longRoom.response.status, 200);
  assert.equal(await waitFor(client, `document.querySelector('.room-card[data-room-id="${proposed.id}"] .room-card__venue')?.textContent === '${'W'.repeat(30)}'`), true);
  await evaluate(client, `(() => {
    const card = document.querySelector('.room-card[data-room-id="${proposed.id}"]');
    window.__issue43KeyedCard = card;
    window.__issue43KeyedDates = new Map([...card.querySelectorAll('.room-card__dates--proposed time')].map((date) => [date.dateTime, date]));
    window.__issue43InitialOrder = [...document.querySelectorAll('.room-card')].map((item) => item.dataset.roomId);
  })()`);
  const unrelatedUpdate = await updateRoom(fixture.baseUrl, owner, proposed.id, { venue: 'V'.repeat(30) });
  assert.equal(unrelatedUpdate.response.status, 200);
  assert.equal(await waitFor(client, `document.querySelector('.room-card[data-room-id="${proposed.id}"] .room-card__venue')?.textContent === '${'V'.repeat(30)}'`), true);
  assert.equal(await evaluate(client, `(() => {
    const card = document.querySelector('.room-card[data-room-id="${proposed.id}"]');
    return card === window.__issue43KeyedCard && [...window.__issue43KeyedDates].every(([date, node]) => card.querySelector('time[datetime="' + date + '"]') === node);
  })()`), true, 'unrelated metadata refresh preserves the room card and date-value nodes');

  for (const [roomId, kind] of [[proposed.id, 'proposed-only'], [mixed.id, 'mixed'], [scheduled.id, 'scheduled-only']]) {
    const card = `.room-card[data-room-id="${roomId}"]`;
    await evaluate(client, `document.querySelector(${JSON.stringify(card)}).scrollIntoView({ block: 'center' })`);
    const layout = await evaluate(client, `(() => {
      const card = document.querySelector(${JSON.stringify(card)});
      const button = card.querySelector('.room-card__edit');
      const buttonRect = button.getBoundingClientRect();
      const textNodes = [...card.querySelectorAll('.room-card__number,.room-card__owner,.room-card__title,.room-card__venue,.room-card__time,.room-card__voter-count,.room-card__dates:not([hidden]) strong,.room-card__date-value')];
      const collisions = [];
      const buttonHits = [];
      for (const element of textNodes) {
        const range = document.createRange();
        range.selectNodeContents(element);
        for (const rect of range.getClientRects()) {
          if (!rect.width || !rect.height) continue;
          const overlaps = rect.left < buttonRect.right && rect.right > buttonRect.left && rect.top < buttonRect.bottom && rect.bottom > buttonRect.top;
          if (overlaps) collisions.push({ text: element.textContent, className: element.className, rect: rect.toJSON() });
          const x = Math.max(rect.left + 0.5, Math.min(rect.right - 0.5, (rect.left + rect.right) / 2));
          const y = Math.max(rect.top + 0.5, Math.min(rect.bottom - 0.5, (rect.top + rect.bottom) / 2));
          if (document.elementFromPoint(x, y)?.closest('.room-card__edit')) buttonHits.push({ text: element.textContent, x, y });
        }
      }
      return {
        kind: ${JSON.stringify(kind)},
        collisions,
        buttonHits,
        actionPosition: getComputedStyle(card.querySelector('.room-card__actions')).position,
        edit: buttonRect.toJSON(),
        card: card.getBoundingClientRect().toJSON(),
      };
    })()`);
    assert.deepEqual(layout.collisions, [], `${kind} Edit must not geometrically cover any rendered text`);
    assert.deepEqual(layout.buttonHits, [], `${kind} text hit tests must not resolve to Edit`);
    assert.equal(layout.actionPosition, 'static', `${kind} owner actions reserve normal layout space`);
    assert.ok(layout.edit.width >= 44 && layout.edit.height >= 44, `${kind} Edit keeps a 44px touch target`);
  }

  await evaluate(client, `document.querySelector('.room-card[data-room-id="${proposed.id}"]').scrollIntoView({ block: 'center' })`);
  await writeFile(join(fixture.directory, 'issue-43-corrected-long-card-320.png'), Buffer.from((await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data, 'base64'));

  await client.send('Emulation.setDeviceMetricsOverride', { width: 160, height: 844, deviceScaleFactor: 1, mobile: true });
  const zoomLayout = await evaluate(client, `(() => ({ width: innerWidth, pageWidth: document.documentElement.scrollWidth, cards: [...document.querySelectorAll('.room-card')].filter((card) => !card.hidden).map((card) => card.getBoundingClientRect().width) }))()`);
  assert.ok(zoomLayout.pageWidth <= zoomLayout.width, '200% zoom-sized viewport has no page-level horizontal overflow');
  assert.ok(zoomLayout.cards.every((width) => width > 0));
  const zoomCardLayout = await evaluate(client, `(() => {
    const card = document.querySelector('.room-card[data-room-id="${proposed.id}"]');
    const button = card.querySelector('.room-card__edit').getBoundingClientRect();
    const range = document.createRange();
    const collisions = [...card.querySelectorAll('.room-card__title,.room-card__owner,.room-card__venue,.room-card__time,.room-card__date-value')].flatMap((element) => {
      range.selectNodeContents(element);
      return [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0 && rect.left < button.right && rect.right > button.left && rect.top < button.bottom && rect.bottom > button.top).map((rect) => ({ text: element.textContent, rect: rect.toJSON() }));
    });
    return { width: innerWidth, pageWidth: document.documentElement.scrollWidth, collisions, edit: button.toJSON() };
  })()`);
  assert.deepEqual(zoomCardLayout.collisions, [], 'long proposed-only text does not overlap Edit at the 200%-zoom-sized viewport');
  assert.ok(zoomCardLayout.edit.width >= 44 && zoomCardLayout.edit.height >= 44);
  await writeFile(join(fixture.directory, 'issue-43-corrected-long-card-160px.png'), Buffer.from((await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data, 'base64'));

  await client.send('Emulation.setDeviceMetricsOverride', { width: 640, height: 844, deviceScaleFactor: 1, mobile: false });
  await evaluate(client, `document.querySelector('.room-card[data-room-id="${proposed.id}"]').scrollIntoView({ block: 'center' })`);
  const desktopZoomLayout = await evaluate(client, `(() => {
    const card = document.querySelector('.room-card[data-room-id="${proposed.id}"]');
    const button = card.querySelector('.room-card__edit').getBoundingClientRect();
    const range = document.createRange();
    const collisions = [...card.querySelectorAll('.room-card__title,.room-card__owner,.room-card__venue,.room-card__time,.room-card__date-value')].flatMap((element) => {
      range.selectNodeContents(element);
      return [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0 && rect.left < button.right && rect.right > button.left && rect.top < button.bottom && rect.bottom > button.top).map((rect) => ({ text: element.textContent, rect: rect.toJSON() }));
    });
    return { width: innerWidth, pageWidth: document.documentElement.scrollWidth, collisions, edit: button.toJSON() };
  })()`);
  assert.equal(desktopZoomLayout.width, 640, 'models a 1280 CSS-pixel desktop viewport at 200% browser zoom');
  assert.ok(desktopZoomLayout.pageWidth <= desktopZoomLayout.width);
  assert.deepEqual(desktopZoomLayout.collisions, [], 'long proposed-only text does not overlap Edit at 200% zoom');
  assert.ok(desktopZoomLayout.edit.width >= 44 && desktopZoomLayout.edit.height >= 44);
  await writeFile(join(fixture.directory, 'issue-43-corrected-long-card-200-percent.png'), Buffer.from((await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data, 'base64'));

  await client.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 844, deviceScaleFactor: 2, mobile: true });
  const todayProposal = `.room-card[data-room-id="${proposed.id}"] .room-card__date-value`;
  await evaluate(client, `(() => { const date = document.querySelector(${JSON.stringify(todayProposal)}); date.parentElement.scrollTop = 0; date.closest('.room-card').scrollIntoView({ block: 'center' }); date.scrollIntoView({ block: 'nearest', inline: 'nearest' }); })()`);
  const startsGlow = await waitFor(client, `document.querySelector(${JSON.stringify(todayProposal)}).classList.contains('is-proposed-glow-running')`);
  assert.equal(startsGlow, true, `starts the shared pulse when an upcoming proposal enters view: ${JSON.stringify(await evaluate(client, `(() => { const date = document.querySelector(${JSON.stringify(todayProposal)}); const region = date.parentElement; return { date: date.getBoundingClientRect().toJSON(), region: region.getBoundingClientRect().toJSON(), scrollTop: region.scrollTop, running: date.classList.contains('is-proposed-glow-running'), visibility: getComputedStyle(date).visibility, overflowX: getComputedStyle(region).overflowX, overflowY: getComputedStyle(region).overflowY }; })()`))}`);
  await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  assert.equal(await waitFor(client, `!document.querySelector(${JSON.stringify(todayProposal)}).classList.contains('is-proposed-glow-running')`), true, 'stops the proposed-date pulse for reduced motion');
  const reducedGlow = await evaluate(client, `(() => { const date = document.querySelector(${JSON.stringify(todayProposal)}); const style = getComputedStyle(date); return { animation: style.animationName, shadow: style.textShadow }; })()`);
  assert.equal(reducedGlow.animation, 'none');
  assert.notEqual(reducedGlow.shadow, 'none', 'reduced motion keeps the static readable highlight');
  const reducedMotionLayout = await evaluate(client, `(() => {
    const card = document.querySelector('.room-card[data-room-id="${proposed.id}"]');
    const button = card.querySelector('.room-card__edit');
    const box = button.getBoundingClientRect();
    const range = document.createRange();
    const collisions = [...card.querySelectorAll('.room-card__title,.room-card__owner,.room-card__venue,.room-card__time,.room-card__date-value')].flatMap((element) => {
      range.selectNodeContents(element);
      return [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0 && rect.left < box.right && rect.right > box.left && rect.top < box.bottom && rect.bottom > box.top).map((rect) => ({ text: element.textContent, rect: rect.toJSON() }));
    });
    return { collisions, actionPosition: getComputedStyle(card.querySelector('.room-card__actions')).position, editHeight: box.height };
  })()`);
  assert.deepEqual(reducedMotionLayout.collisions, [], 'reduced-motion proposed-only card text does not overlap Edit');
  assert.equal(reducedMotionLayout.actionPosition, 'static');
  assert.ok(reducedMotionLayout.editHeight >= 44);
  await client.send('Emulation.setEmulatedMedia', { features: [] });
  assert.equal(await waitFor(client, `document.querySelector(${JSON.stringify(todayProposal)}).classList.contains('is-proposed-glow-running')`), true, 'restores the pulse when motion is allowed again');

  const clippedGlow = await evaluate(client, `(() => {
    const today = document.querySelector('.room-card[data-room-id="${proposed.id}"] time[datetime="2026-10-27"]');
    const region = today.parentElement;
    region.scrollTop = region.scrollHeight;
    region.dispatchEvent(new Event('scroll'));
    const dateRect = today.getBoundingClientRect();
    const regionRect = region.getBoundingClientRect();
    return { scrollTop: region.scrollTop, clipped: dateRect.bottom <= regionRect.top || dateRect.top >= regionRect.bottom, running: today.classList.contains('is-proposed-glow-running') };
  })()`);
  assert.equal(clippedGlow.clipped, true, 'the qualifying date is fully outside its own scrollable region');
  assert.equal(await waitFor(client, `!document.querySelector('.room-card[data-room-id="${proposed.id}"] time[datetime="2026-10-27"]').classList.contains('is-proposed-glow-running')`), true, 'pauses the pulse when ancestor clipping hides the qualifying date');
  const resumedGlow = await evaluate(client, `(() => {
    const today = document.querySelector('.room-card[data-room-id="${proposed.id}"] time[datetime="2026-10-27"]');
    const tomorrow = document.querySelector('.room-card[data-room-id="${proposed.id}"] time[datetime="2026-10-28"]');
    const region = today.parentElement;
    region.scrollTop = 0;
    region.dispatchEvent(new Event('scroll'));
    const delay = today.style.getPropertyValue('--proposed-glow-delay');
    const tomorrowDelay = tomorrow.style.getPropertyValue('--proposed-glow-delay');
    const expected = -Math.floor(((document.timeline.currentTime % 2800) + 2800) % 2800);
    return { running: today.classList.contains('is-proposed-glow-running'), tomorrowRunning: tomorrow.classList.contains('is-proposed-glow-running'), delay, tomorrowDelay, expected };
  })()`);
  assert.equal(resumedGlow.running, true, 'restarts the date pulse when it returns to the visible region');
  assert.equal(resumedGlow.tomorrowRunning, true, 'today and tomorrow dates resume together');
  assert.equal(resumedGlow.delay, resumedGlow.tomorrowDelay, 're-entry retains the shared page-wide pulse phase');
  assert.ok(Math.abs(Number.parseFloat(resumedGlow.delay) - resumedGlow.expected) < 100, 're-entry aligns with the current shared animation phase');

  fixture.setNow('2026-10-27T17:00:00.000Z');
  await evaluate(client, `window.__setIssue43Now(Date.parse('2026-10-27T17:00:00.000Z'))`);
  assert.equal(await evaluate(client, 'typeof window.__fireRoomDayRollover === "function"'), true, 'captures the scheduled Bangkok-midnight refresh');
  await evaluate(client, 'window.__fireRoomDayRollover()');
  assert.equal(await waitFor(client, `!document.querySelector('.room-card[data-room-id="${proposed.id}"] time[datetime="2026-10-27"]')`), true, 'removes yesterday from the upcoming proposed dates at Bangkok midnight');
  const midnightState = await evaluate(client, `(() => {
    const card = document.querySelector('.room-card[data-room-id="${proposed.id}"]');
    const tomorrow = card.querySelector('.room-card__dates--proposed time[datetime="2026-10-28"]');
    const order = [...document.querySelectorAll('.room-card')].map((item) => item.dataset.roomId);
    return {
      cardRetained: card === window.__issue43KeyedCard,
      yesterdayDetached: !window.__issue43KeyedDates.get('2026-10-27').isConnected,
      todayRetained: tomorrow === window.__issue43KeyedDates.get('2026-10-28'),
      todayGlows: tomorrow?.classList.contains('is-proposed-date-glowing'),
      orderChanged: JSON.stringify(order) !== JSON.stringify(window.__issue43InitialOrder),
      movedBehindMixed: order.indexOf('${proposed.id}') > order.indexOf('${mixed.id}'),
    };
  })()`);
  assert.equal(midnightState.cardRetained, true, 'keeps the keyed card during date rollover and resort');
  assert.equal(midnightState.yesterdayDetached, true, 'drops the expired date node at Bangkok midnight');
  assert.equal(midnightState.todayRetained, true, 'preserves the existing keyed node for tomorrow as it becomes today');
  assert.equal(midnightState.todayGlows, true, 'the date that becomes today remains highlighted and pulsing');
  assert.equal(midnightState.orderChanged, true, 'resorts cards when their earliest upcoming date changes');
  assert.equal(midnightState.movedBehindMixed, true, 'keeps date order after the room list is reordered');

  const scheduleTomorrow = await fetch(`${fixture.baseUrl}/api/rooms/${proposed.id}/admin/events/2026-10-28`, {
    method: 'PUT', headers: headers(fixture.baseUrl, owner),
    body: JSON.stringify({ eventId: tomorrowProposalEvent.eventId, revision: tomorrowProposalEvent.revision, status: 'scheduled', requestId: randomUUID() }),
  });
  assert.equal(scheduleTomorrow.status, 200);
  const scheduledTomorrow = await scheduleTomorrow.json();
  assert.equal(await waitFor(client, `Boolean(document.querySelector('.room-card[data-room-id="${proposed.id}"] .room-card__dates--scheduled time[datetime="2026-10-28"]') && !document.querySelector('.room-card[data-room-id="${proposed.id}"] .room-card__dates--proposed time[datetime="2026-10-28"]'))`), true, 'moves a scheduled value out of Proposed');
  assert.equal(await evaluate(client, `!window.__issue43KeyedDates.get('2026-10-28').classList.contains('is-proposed-date-glowing') && !document.querySelector('.room-card[data-room-id="${proposed.id}"] .room-card__dates--scheduled time[datetime="2026-10-28"]').classList.contains('is-proposed-date-glowing')`), true, 'stops the proposed glow when the event is scheduled');

  const deleteTomorrow = await fetch(`${fixture.baseUrl}/api/rooms/${proposed.id}/admin/events/2026-10-28`, {
    method: 'DELETE', headers: headers(fixture.baseUrl, owner),
    body: JSON.stringify({ eventId: scheduledTomorrow.event.eventId, revision: scheduledTomorrow.event.revision, requestId: randomUUID() }),
  });
  assert.equal(deleteTomorrow.status, 200);
  assert.equal(await waitFor(client, `!document.querySelector('.room-card[data-room-id="${proposed.id}"] .room-card__dates--scheduled time[datetime="2026-10-28"]') && !document.querySelector('.room-card[data-room-id="${proposed.id}"]').classList.contains('is-scheduled')`), true, 'removes the scheduled date and its card status after deletion');

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
