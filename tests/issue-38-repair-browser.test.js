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
import { LEGACY_ROOM_ID, ROOM_COLOR_PALETTE } from '../src/room-contract.js';
import { proposeRunEvent, setRunEventStatus, setVote } from '../src/domain.js';
import { removeProfileWithRetry } from './helpers/chromium-profile-cleanup.js';
import { chromiumReadinessTimeoutMs, readDevToolsPort, spawnChromium, stopChromium } from './helpers/chromium-startup.js';

const chromePath = process.env.CHROME_BIN ?? [
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/opt/google/chrome/chrome',
  '/opt/data/tmp/chrome/opt/google/chrome/chrome',
].find((path) => existsSync(path));
if (!chromePath) throw new Error('Issue 38 repair browser coverage requires real Chromium; refusing to skip.');

const ENV = { ADMIN_NAME: 'Issue 38 Repair Admin', ADMIN_PIN: '4826', PIN_PEPPER: 'synthetic-pepper' };
const INITIAL_NOW = new Date('2026-10-27T04:00:00.000Z');

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
    socket,
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
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
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

async function makeClient(port, baseUrl, cookie, { width = 1280, height = 900, mobile = false, prelude = '' } = {}) {
  const target = await createTarget(port);
  const client = createCdpClient(target.webSocketDebuggerUrl);
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Network.enable');
  if (prelude) await client.send('Page.addScriptToEvaluateOnNewDocument', { source: prelude });
  const [name, value] = cookie.split('=', 2);
  await client.send('Network.setCookie', { url: baseUrl, name, value, path: '/' });
  await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  return client;
}

async function createFixture() {
  const directory = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'run-together-issue-38-repair-'));
  let currentNow = new Date(INITIAL_NOW);
  const now = () => new Date(currentNow);
  const server = createServer({ databasePath: join(directory, 'preview.sqlite'), env: ENV, now });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    directory,
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    now,
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
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ name, pin: '0042', pinConfirmation: '0042' }),
  });
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
  const session = response.ok
    ? await fetch(`${baseUrl}/api/session`, { headers: { cookie } }).then((result) => result.json())
    : {};
  return { response, cookie, csrfToken: session.csrfToken };
}

async function loginAdmin(baseUrl) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ name: ENV.ADMIN_NAME, pin: ENV.ADMIN_PIN }),
  });
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
  const session = response.ok
    ? await fetch(`${baseUrl}/api/session`, { headers: { cookie } }).then((result) => result.json())
    : {};
  return { response, cookie, csrfToken: session.csrfToken };
}

function apiHeaders(baseUrl, user) {
  return { origin: baseUrl, cookie: user.cookie, 'x-csrf-token': user.csrfToken, 'content-type': 'application/json' };
}

async function createRoom(baseUrl, user, title, icon = 'running') {
  const response = await fetch(`${baseUrl}/api/rooms`, {
    method: 'POST', headers: apiHeaders(baseUrl, user), body: JSON.stringify({ title, icon }),
  });
  assert.equal(response.status, 201);
  return (await response.json()).room;
}

function seedEvent(database, { roomId, userId, date, status = 'proposed', now }) {
  setVote(database, { roomId, userId, voteDate: date, body: { selected: true }, now });
  const proposal = proposeRunEvent(database, { roomId, userId, eventDate: date, requestId: randomUUID(), now });
  if (status === 'proposed') return proposal.event;
  return setRunEventStatus(database, {
    roomId, adminUserId: userId, eventDate: date, eventId: proposal.event.eventId,
    revision: proposal.event.revision, status, requestId: randomUUID(), now,
  }).event;
}

async function clickSelector(client, selector) {
  await evaluate(client, `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'center', inline: 'center' })`);
  const point = await evaluate(client, `(() => { const box = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return box ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : null; })()`);
  assert.ok(point, `control exists: ${selector}`);
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}

async function pressKey(client, key, code, virtualKeyCode) {
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, text: key === 'Enter' ? '\r' : undefined, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode });
}

const captureDayRollover = `(() => {
  const nativeSetTimeout = window.setTimeout.bind(window);
  let captured = false;
  window.setTimeout = (callback, milliseconds, ...args) => {
    if (!captured && Number(milliseconds) > 60_000) {
      captured = true;
      window.__fireRoomDayRollover = () => callback(...args);
    }
    return nativeSetTimeout(callback, milliseconds, ...args);
  };
})()`;

test('Issue 38 room-list cards stay readable, scrollable, editable, keyed, and synchronized in real Chromium', async (t) => {
  const fixture = await createFixture();
  const owner = await register(fixture.baseUrl, 'Issue 38 Repair Owner');
  assert.equal(owner.response.status, 201);
  const profile = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'run-together-issue-38-repair-chrome-'));
  const browser = spawnChromium(chromePath, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
    '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank',
  ]);
  let client;
  let memberClient;
  try {
    const port = await readDevToolsPort(profile, browser, { timeoutMs: chromiumReadinessTimeoutMs });
    client = await makeClient(port, fixture.baseUrl, owner.cookie, { width: 1280, height: 1000, prelude: captureDayRollover });
    await client.send('Page.navigate', { url: `${fixture.baseUrl}/rooms` });
    assert.equal(await waitFor(client, `Boolean(document.querySelector('#rooms-content') && !document.querySelector('#rooms-content').hidden)`), true, 'loads the authenticated room-list page');
    const manageVisibility = await evaluate(client, `(() => { const button = document.querySelector('#rooms-manage-users'); const box = button.getBoundingClientRect(); return { hidden: button.hidden, display: getComputedStyle(button).display, width: box.width, height: box.height }; })()`);
    assert.deepEqual(manageVisibility, { hidden: true, display: 'none', width: 0, height: 0 }, 'ordinary room owners do not see Manage users after CSS cascade');
    assert.equal((await fetch(`${fixture.baseUrl}/api/admin/users`, { headers: { cookie: owner.cookie } })).status, 403, 'a room owner still cannot use application-wide user management');

    const longTitle = '🏃'.repeat(30);
    await evaluate(client, `(() => { const form = document.querySelector('#create-room-form'); form.elements.title.value = ${JSON.stringify(longTitle)}; form.requestSubmit(); })()`);
    assert.equal(await waitFor(client, `[...document.querySelectorAll('.room-card__title')].some((title) => title.textContent === ${JSON.stringify(longTitle)})`), true, 'accepts and renders a 30-code-point room title');
    const stressCard = (await fetch(`${fixture.baseUrl}/api/rooms`, { headers: { cookie: owner.cookie } }).then((response) => response.json())).rooms.find((candidate) => candidate.title === longTitle);
    assert.ok(stressCard);
    assert.equal(stressCard.title, longTitle);

    const twoDates = await createRoom(fixture.baseUrl, owner, 'Two scheduled dates');
    const proposalOnly = await createRoom(fixture.baseUrl, owner, 'Proposed only');
    const pastOnly = await createRoom(fixture.baseUrl, owner, 'Past only');
    for (const title of ['Palette room 1', 'Palette room 2', 'Palette room 3']) await createRoom(fixture.baseUrl, owner, title);

    const ownerId = fixture.server.database.prepare("SELECT id FROM users WHERE role = 'user'").get().id;
    for (const [index, date] of [
      '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05',
      '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12',
    ].entries()) {
      seedEvent(fixture.server.database, {
        roomId: stressCard.id, userId: ownerId, date, status: index % 2 === 0 ? 'scheduled' : 'proposed', now: fixture.now,
      });
    }
    const removedFirst = seedEvent(fixture.server.database, { roomId: twoDates.id, userId: ownerId, date: '2026-10-28', status: 'scheduled', now: fixture.now });
    const retainedSecond = seedEvent(fixture.server.database, { roomId: twoDates.id, userId: ownerId, date: '2026-10-30', status: 'scheduled', now: fixture.now });
    seedEvent(fixture.server.database, { roomId: proposalOnly.id, userId: ownerId, date: '2026-10-29', now: fixture.now });
    seedEvent(fixture.server.database, { roomId: pastOnly.id, userId: ownerId, date: '2026-10-28', status: 'scheduled', now: fixture.now });
    await evaluate(client, "dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))");
    assert.equal(await waitFor(client, `document.querySelectorAll('.room-card').length === 8 && document.querySelector('.room-card[data-room-id="${stressCard.id}"] .room-card__dates--proposed .room-card__date-values')?.textContent.includes('12-Nov')`), true, 'renders all seven scheduled and seven proposed dates in the room-list page');
    await evaluate(client, 'window.scrollTo(0, 0)');

    const layout = await evaluate(client, `(() => {
      const card = document.querySelector('.room-card[data-room-id="${stressCard.id}"]');
      const rect = (selector) => card.querySelector(selector).getBoundingClientRect().toJSON();
      const scheduledValues = card.querySelector('.room-card__dates--scheduled .room-card__date-values');
      const proposedValues = card.querySelector('.room-card__dates--proposed .room-card__date-values');
      const actions = card.querySelector('.room-card__actions');
      const cardBox = card.getBoundingClientRect();
      const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      return {
        card: cardBox.toJSON(),
        number: rect('.room-card__number'), icon: rect('.room-card__icon'), title: rect('.room-card__title'),
        titleContent: { clientHeight: card.querySelector('.room-card__title').clientHeight, scrollHeight: card.querySelector('.room-card__title').scrollHeight },
        scheduledLine: rect('.room-card__dates--scheduled'), proposedLine: rect('.room-card__dates--proposed'),
        scheduledLabel: rect('.room-card__dates--scheduled strong'), proposedLabel: rect('.room-card__dates--proposed strong'),
        proposedLabelWeight: getComputedStyle(card.querySelector('.room-card__dates--proposed strong')).fontWeight,
        edit: rect('.room-card__edit'), actionPosition: getComputedStyle(actions).position,
        numberActionsOverlap: overlaps(rect('.room-card__number'), rect('.room-card__edit')),
        numberIconOverlap: overlaps(rect('.room-card__number'), rect('.room-card__icon')),
        iconTitleOverlap: overlaps(rect('.room-card__icon'), rect('.room-card__title')),
        titleDatesOverlap: overlaps(rect('.room-card__title'), rect('.room-card__dates--scheduled')) || overlaps(rect('.room-card__title'), rect('.room-card__dates--proposed')),
        dateLinesOverlap: overlaps(rect('.room-card__dates--scheduled'), rect('.room-card__dates--proposed')),
        scheduledDates: { text: scheduledValues.textContent, height: scheduledValues.clientHeight, scrollHeight: scheduledValues.scrollHeight, overflow: getComputedStyle(scheduledValues).overflowY, tabIndex: scheduledValues.tabIndex, role: scheduledValues.getAttribute('role'), label: scheduledValues.getAttribute('aria-label') },
        proposedDates: { text: proposedValues.textContent, height: proposedValues.clientHeight, scrollHeight: proposedValues.scrollHeight, overflow: getComputedStyle(proposedValues).overflowY, tabIndex: proposedValues.tabIndex, role: proposedValues.getAttribute('role'), label: proposedValues.getAttribute('aria-label') },
        datesOutsideEntry: !scheduledValues.closest('a') && !proposedValues.closest('a'),
      };
    })()`);
    if (layout.titleDatesOverlap) t.diagnostic(JSON.stringify(layout));
    assert.ok(Math.abs(layout.card.width - layout.card.height) <= 1, 'preserves square cards on desktop');
    assert.equal(layout.actionPosition, 'absolute', 'keeps the Edit action absolutely positioned');
    assert.equal(layout.numberActionsOverlap, false, 'separates the room number and Edit action');
    assert.equal(layout.numberIconOverlap, false, 'separates the room number and icon');
    assert.equal(layout.iconTitleOverlap, false, 'separates the icon and full title');
    assert.equal(layout.titleDatesOverlap, false, 'separates the title from both date regions');
    assert.equal(layout.titleContent.scrollHeight, layout.titleContent.clientHeight, 'keeps the full 30-code-point title visible without clipping');
    assert.equal(layout.dateLinesOverlap, false, 'separates Scheduled and Proposed date regions');
    assert.ok(Number(layout.proposedLabelWeight) >= 700, 'keeps the Proposed label prominent');
    assert.equal(layout.scheduledDates.role, 'region');
    assert.equal(layout.proposedDates.role, 'region');
    assert.equal(layout.scheduledDates.tabIndex, 0);
    assert.equal(layout.proposedDates.tabIndex, 0);
    assert.match(layout.scheduledDates.label, /Scheduled dates/);
    assert.match(layout.proposedDates.label, /Proposed dates/);
    assert.equal(layout.datesOutsideEntry, true, 'keeps keyboard/touch date scrollers outside the room-entry link');
    assert.ok(layout.scheduledDates.scrollHeight > layout.scheduledDates.height, 'scheduled values scroll instead of clipping');
    assert.ok(layout.proposedDates.scrollHeight > layout.proposedDates.height, 'proposed values scroll instead of clipping');
    assert.match(layout.scheduledDates.text, /11-Nov/);
    assert.match(layout.proposedDates.text, /12-Nov/);
    assert.equal(layout.scheduledLabel.height > 0 && layout.proposedLabel.height > 0, true, 'keeps both date labels visible');
    assert.ok(layout.number.top >= layout.card.top && layout.title.bottom <= layout.card.bottom
      && layout.scheduledLine.bottom <= layout.card.bottom && layout.proposedLine.bottom <= layout.card.bottom,
    'keeps identity and both date regions within the square card');

    const reachableDates = await evaluate(client, `(() => {
      return [
        ['.room-card__dates--scheduled .room-card__date-values', '11-Nov'],
        ['.room-card__dates--proposed .room-card__date-values', '12-Nov'],
      ].map(([selector, token]) => {
        const region = document.querySelector('.room-card[data-room-id="${stressCard.id}"] ' + selector);
        region.scrollTop = region.scrollHeight;
        const text = region.firstChild;
        const start = text.textContent.lastIndexOf(token);
        const range = document.createRange();
        range.setStart(text, start);
        range.setEnd(text, start + token.length);
        const value = range.getBoundingClientRect();
        const box = region.getBoundingClientRect();
        return { token, scrollTop: region.scrollTop, visible: value.top >= box.top && value.bottom <= box.bottom && value.left >= box.left && value.right <= box.right };
      });
    })()`);
    assert.ok(reachableDates.every(({ scrollTop, visible }) => scrollTop > 0 && visible), 'scrolling reaches the latest stored Scheduled and Proposed dates outside the current week');

    await clickSelector(client, `.room-card[data-room-id="${stressCard.id}"] .room-card__edit`);
    assert.equal(await waitFor(client, 'document.querySelector(\'.room-edit-dialog\')?.open'), true, 'an owner can open Edit with a real pointer while the scheduled effect runs');
    await evaluate(client, 'document.querySelector(\'.room-edit-dialog\').close()');
    await evaluate(client, `document.querySelector('.room-card[data-room-id="${stressCard.id}"] .room-card__edit').focus()`);
    await pressKey(client, 'Enter', 'Enter', 13);
    assert.equal(await waitFor(client, 'document.querySelector(\'.room-edit-dialog\')?.open'), true, 'an owner can activate Edit with the keyboard while the scheduled effect runs');
    await evaluate(client, 'document.querySelector(\'.room-edit-dialog\').close()');

    const paletteCheck = await evaluate(client, `(() => {
      const card = document.querySelector('.room-card[data-room-id="${stressCard.id}"]');
      const original = card.style.getPropertyValue('--room-color');
      const colors = ${JSON.stringify(ROOM_COLOR_PALETTE)};
      const rendered = colors.map((color) => { card.style.setProperty('--room-color', color); return { color: getComputedStyle(card).getPropertyValue('--room-color').trim(), square: Math.abs(card.getBoundingClientRect().width - card.getBoundingClientRect().height) <= 1 }; });
      card.style.setProperty('--room-color', original);
      return rendered;
    })()`);
    assert.deepEqual(paletteCheck.map(({ color }) => color), [...ROOM_COLOR_PALETTE], 'renders the repaired card against every supported palette color');
    assert.ok(paletteCheck.every(({ square }) => square), 'keeps square geometry for every palette color');

    await evaluate(client, `(() => { const values = document.querySelector('.room-card[data-room-id="${stressCard.id}"] .room-card__dates--proposed .room-card__date-values'); values.scrollTop = 0; values.focus(); })()`);
    await pressKey(client, 'ArrowDown', 'ArrowDown', 40);
    assert.equal(await waitFor(client, `document.querySelector('.room-card[data-room-id="${stressCard.id}"] .room-card__dates--proposed .room-card__date-values').scrollTop > 0`), true, 'keyboard users can scroll the full proposed-date value region');
    await client.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate(client, `(() => { const card = document.querySelector('.room-card[data-room-id="${stressCard.id}"]'); card.scrollIntoView({ block: 'center' }); const value = card.querySelector('.room-card__dates--scheduled .room-card__date-values'); value.style.height = '18px'; value.style.maxHeight = '18px'; value.scrollTop = 0; })()`);
    const mobileCard = await evaluate(client, `(() => { const card = document.querySelector('.room-card[data-room-id="${stressCard.id}"]'); const box = card.getBoundingClientRect(); const value = card.querySelector('.room-card__dates--scheduled .room-card__date-values'); const area = value.getBoundingClientRect(); const title = card.querySelector('.room-card__title'); const identity = card.querySelector('.room-card__identity').getBoundingClientRect(); const range = document.createRange(); range.selectNodeContents(title); const textRects = [...range.getClientRects()].map((rect) => rect.toJSON()); value.scrollTop = 0; return { width: innerWidth, card: box.toJSON(), area: area.toJSON(), pageWidth: document.documentElement.scrollWidth, identity: identity.toJSON(), textRects, titleContentVisible: textRects.length > 0 && textRects.every((rect) => rect.top >= identity.top && rect.bottom <= identity.bottom) }; })()`);
    if (!mobileCard.titleContentVisible) t.diagnostic(JSON.stringify(mobileCard));
    assert.ok(Math.abs(mobileCard.card.width - mobileCard.card.height) <= 1, 'preserves square cards at a 320px mobile viewport');
    assert.ok(mobileCard.pageWidth <= 320, 'prevents horizontal overflow at 320px');
    assert.equal(mobileCard.titleContentVisible, true, 'keeps every line of the full 30-code-point title visible at 320px');
    await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    const touch = { x: mobileCard.area.left + mobileCard.area.width / 2, y: mobileCard.area.top + mobileCard.area.height / 2 };
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...touch, id: 1 }] });
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: touch.x, y: touch.y - 12, id: 1 }] });
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: touch.x, y: touch.y - 34, id: 1 }] });
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: touch.x, y: touch.y - 64, id: 1 }] });
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.equal(await waitFor(client, `document.querySelector('.room-card[data-room-id="${stressCard.id}"] .room-card__dates--scheduled .room-card__date-values').scrollTop > 0`), true, 'touch users can scroll scheduled dates without activating room entry');
    assert.equal(await evaluate(client, 'location.pathname'), '/rooms', 'scrolling date values does not enter a room');
    await client.send('Emulation.setTouchEmulationEnabled', { enabled: false });

    await client.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
    await evaluate(client, `document.querySelector('.room-card[data-room-id="${stressCard.id}"]').scrollIntoView({ block: 'center' })`);
    const beamState = await evaluate(client, `(() => {
      const ids = ['${stressCard.id}', '${twoDates.id}'];
      return ids.map((id) => { const card = document.querySelector('.room-card[data-room-id="' + id + '"]'); const beam = getComputedStyle(card, '::before'); const actions = card.querySelector('.room-card__actions'); const box = card.getBoundingClientRect(); const edit = card.querySelector('.room-card__edit').getBoundingClientRect(); return { id, running: card.classList.contains('is-beam-running'), animation: beam.animationName, duration: beam.animationDuration, speed: getComputedStyle(card).getPropertyValue('--beam-speed').trim(), blur: getComputedStyle(card).getPropertyValue('--glow-blur').trim(), actionPosition: getComputedStyle(actions).position, editInside: edit.top >= box.top && edit.bottom <= box.bottom && edit.right <= box.right }; });
    })()`);
    assert.equal(await waitFor(client, `['${stressCard.id}', '${twoDates.id}'].every((id) => document.querySelector('.room-card[data-room-id="' + id + '"]').classList.contains('is-beam-running'))`), true, 'runs the shared scheduled-card effect on two visible cards');
    const activeBeamState = await evaluate(client, `(${JSON.stringify(beamState)}).map(({ id }) => { const card = document.querySelector('.room-card[data-room-id="' + id + '"]'); const style = getComputedStyle(card, '::before'); return { angle: parseFloat(style.getPropertyValue('--beam-angle')), duration: style.animationDuration, animation: style.animationName, speed: getComputedStyle(card).getPropertyValue('--beam-speed').trim(), blur: getComputedStyle(card).getPropertyValue('--glow-blur').trim(), actionPosition: getComputedStyle(card.querySelector('.room-card__actions')).position, editInside: (() => { const a=card.getBoundingClientRect(), b=card.querySelector('.room-card__edit').getBoundingClientRect(); return b.top>=a.top && b.bottom<=a.bottom && b.right<=a.right; })() }; })`);
    assert.ok(activeBeamState.every(({ animation, duration, speed, blur, actionPosition, editInside }) => animation === 'scheduled-border-beam' && duration === '1.4s' && speed === '1.4s' && blur === '24px' && actionPosition === 'absolute' && editInside), 'preserves exact shared beam timing/glow and visible Edit placement during animation');
    const angleDifference = Math.abs(activeBeamState[0].angle - activeBeamState[1].angle);
    assert.ok(Number.isFinite(angleDifference) && Math.min(angleDifference, 360 - angleDifference) < 10, 'keeps visible scheduled cards in the same animation phase');
    assert.equal(await evaluate(client, `!document.querySelector('.room-card[data-room-id="${proposalOnly.id}"]').classList.contains('is-scheduled') && !document.querySelector('.room-card[data-room-id="${proposalOnly.id}"]').classList.contains('is-beam-running')`), true, 'proposed-only rooms never get scheduled-card effects');
    await clickSelector(client, `.room-card[data-room-id="${stressCard.id}"] .room-card__edit`);
    assert.equal(await waitFor(client, 'document.querySelector(\'.room-edit-dialog\')?.open'), true, 'the owner can open Edit while the scheduled beam is visibly running');
    await evaluate(client, 'document.querySelector(\'.room-edit-dialog\').close()');
    await evaluate(client, `document.querySelector('.room-card[data-room-id="${stressCard.id}"] .room-card__edit').focus()`);
    await pressKey(client, 'Enter', 'Enter', 13);
    assert.equal(await waitFor(client, 'document.querySelector(\'.room-edit-dialog\')?.open'), true, 'keyboard Edit remains usable while the scheduled beam is visibly running');
    await evaluate(client, 'document.querySelector(\'.room-edit-dialog\').close()');

    await client.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate(client, 'window.scrollTo(0, document.documentElement.scrollHeight)');
    assert.equal(await waitFor(client, `['${stressCard.id}', '${twoDates.id}'].every((id) => !document.querySelector('.room-card[data-room-id="' + id + '"]').classList.contains('is-beam-running'))`), true, 'pauses room-list beams when their scheduled cards are offscreen');
    const offscreenCards = await evaluate(client, `['${stressCard.id}', '${twoDates.id}'].map((id) => { const box = document.querySelector('.room-card[data-room-id="' + id + '"]').getBoundingClientRect(); return box.bottom <= 0 || box.top >= innerHeight; })`);
    assert.ok(offscreenCards.every(Boolean), 'moves both scheduled cards outside the mobile viewport before checking pause behavior');
    await evaluate(client, `document.querySelector('.room-card[data-room-id="${stressCard.id}"]').scrollIntoView({ block: 'center' })`);
    assert.equal(await waitFor(client, `document.querySelector('.room-card[data-room-id="${stressCard.id}"]').classList.contains('is-beam-running')`), true, 'resumes the room-list effect when a scheduled card returns to view');
    await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    assert.equal(await waitFor(client, `!document.querySelector('.room-card[data-room-id="${stressCard.id}"]').classList.contains('is-beam-running')`), true, 'uses a static room-list effect for reduced-motion users');
    const reducedMotionEdit = await evaluate(client, `(() => { const card = document.querySelector('.room-card[data-room-id="${stressCard.id}"]'); const box = card.getBoundingClientRect(); const edit = card.querySelector('.room-card__edit'); const button = edit.getBoundingClientRect(); return { scheduled: card.classList.contains('is-scheduled'), running: card.classList.contains('is-beam-running'), actionPosition: getComputedStyle(card.querySelector('.room-card__actions')).position, inside: button.top >= box.top && button.bottom <= box.bottom && button.right <= box.right }; })()`);
    assert.deepEqual(reducedMotionEdit, { scheduled: true, running: false, actionPosition: 'absolute', inside: true }, 'keeps the owner Edit action visible in the static reduced-motion state');
    await clickSelector(client, `.room-card[data-room-id="${stressCard.id}"] .room-card__edit`);
    assert.equal(await waitFor(client, 'document.querySelector(\'.room-edit-dialog\')?.open'), true, 'pointer Edit remains usable with reduced motion enabled');
    await evaluate(client, 'document.querySelector(\'.room-edit-dialog\').close()');
    await evaluate(client, `document.querySelector('.room-card[data-room-id="${stressCard.id}"] .room-card__edit').focus()`);
    await pressKey(client, 'Enter', 'Enter', 13);
    assert.equal(await waitFor(client, 'document.querySelector(\'.room-edit-dialog\')?.open'), true, 'keyboard Edit remains usable with reduced motion enabled');
    await evaluate(client, 'document.querySelector(\'.room-edit-dialog\').close()');
    await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    assert.equal(await waitFor(client, `document.querySelector('.room-card[data-room-id="${stressCard.id}"]').classList.contains('is-beam-running')`), true, 'rejoins the shared animation phase when motion is enabled again');
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });

    const originalNodes = await evaluate(client, `(() => { window.__keyedCards = Object.fromEntries(['${stressCard.id}', '${twoDates.id}'].map((id) => [id, document.querySelector('.room-card[data-room-id="' + id + '"]')])); window.__keyedOrder = [...document.querySelectorAll('.room-card')].map((card) => card.dataset.roomId); return true; })()`);
    assert.equal(originalNodes, true);
    const deleteOne = await fetch(`${fixture.baseUrl}/api/rooms/${twoDates.id}/admin/events/2026-10-28`, {
      method: 'DELETE', headers: apiHeaders(fixture.baseUrl, owner), body: JSON.stringify({ eventId: removedFirst.eventId, revision: removedFirst.revision, requestId: randomUUID() }),
    });
    assert.equal(deleteOne.status, 200);
    assert.equal(await waitFor(client, `document.querySelector('.room-card[data-room-id="${twoDates.id}"]').classList.contains('is-scheduled') && document.querySelector('.room-card[data-room-id="${twoDates.id}"] .room-card__dates--scheduled .room-card__date-values').textContent === '30-Oct'`), true, 'keeps the scheduled state while a second scheduled date remains');
    const reorderedState = await evaluate(client, `({ order: [...document.querySelectorAll('.room-card')].map((card) => card.dataset.roomId), retained: ['${stressCard.id}', '${twoDates.id}'].every((id) => document.querySelector('.room-card[data-room-id="' + id + '"]') === window.__keyedCards[id]) })`);
    assert.notDeepEqual(reorderedState.order, await evaluate(client, 'window.__keyedOrder'), 'resorts rooms when their earliest scheduled date changes');
    assert.equal(reorderedState.retained, true, 'preserves UUID-keyed article nodes while room cards reorder');
    await evaluate(client, `(() => {
      const originalFetch = window.fetch.bind(window);
      window.__holdRoomLists = 2;
      window.__heldRoomLists = [];
      window.fetch = async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input.url, location.href);
        if (url.pathname !== '/api/rooms' || window.__holdRoomLists <= 0) return originalFetch(input, init);
        window.__holdRoomLists -= 1;
        const response = await originalFetch(input, init);
        const payload = await response.clone().json();
        return new Promise((resolve) => window.__heldRoomLists.push(() => resolve(new Response(JSON.stringify(payload), { status: response.status, headers: { 'content-type': 'application/json' } }))));
      };
    })()`);
    await evaluate(client, "dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))");
    assert.equal(await waitFor(client, 'window.__heldRoomLists.length === 1'), true, 'holds the first room-list response for an ordering test');
    const newerRoomTitle = 'Newer room response';
    const reorderedRoom = await fetch(`${fixture.baseUrl}/api/rooms/${stressCard.id}`, {
      method: 'PUT', headers: apiHeaders(fixture.baseUrl, owner), body: JSON.stringify({ title: newerRoomTitle }),
    });
    assert.equal(reorderedRoom.status, 200);
    assert.equal(await waitFor(client, 'window.__heldRoomLists.length === 2'), true, 'a newer realtime change starts a second overlapping room-list request');
    await evaluate(client, 'window.__heldRoomLists[1]()');
    assert.equal(await waitFor(client, `document.querySelector('.room-card[data-room-id="${stressCard.id}"] .room-card__title')?.textContent === ${JSON.stringify(newerRoomTitle)}`), true, 'applies the newest room-list response first');
    await evaluate(client, 'window.__heldRoomLists[0]()');
    await delay(120);
    const staleResponseGuard = await evaluate(client, `({ title: document.querySelector('.room-card[data-room-id="${stressCard.id}"] .room-card__title').textContent, retained: ['${stressCard.id}', '${twoDates.id}'].every((id) => document.querySelector('.room-card[data-room-id="' + id + '"]') === window.__keyedCards[id]), order: [...document.querySelectorAll('.room-card')].map((card) => card.dataset.roomId) })`);
    assert.equal(staleResponseGuard.title, newerRoomTitle, 'ignores a delayed stale room-list response');
    assert.equal(staleResponseGuard.retained, true, 'preserves UUID-keyed article nodes during out-of-order responses');
    assert.equal(staleResponseGuard.order.length, 8);
    await evaluate(client, 'window.fetch = window.fetch.bind(window); window.__holdRoomLists = 0;');

    await client.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    assert.equal(await waitFor(client, '!navigator.onLine'), true, 'disconnects the room-list browser before a title change');
    const offlineTitle = 'Offline list title';
    const offlineRename = await fetch(`${fixture.baseUrl}/api/rooms/${stressCard.id}`, {
      method: 'PUT', headers: apiHeaders(fixture.baseUrl, owner), body: JSON.stringify({ title: offlineTitle }),
    });
    assert.equal(offlineRename.status, 200);
    await client.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: 10_000_000, uploadThroughput: 10_000_000, connectionType: 'wifi' });
    assert.equal(await waitFor(client, `document.querySelector('.room-card[data-room-id="${stressCard.id}"] .room-card__title')?.textContent === ${JSON.stringify(offlineTitle)}`), true, 'room-list reconnect reloads a title change missed while offline');

    const deleteLast = await fetch(`${fixture.baseUrl}/api/rooms/${twoDates.id}/admin/events/2026-10-30`, {
      method: 'DELETE', headers: apiHeaders(fixture.baseUrl, owner), body: JSON.stringify({ eventId: retainedSecond.eventId, revision: retainedSecond.revision, requestId: randomUUID() }),
    });
    assert.equal(deleteLast.status, 200);
    assert.equal(await waitFor(client, `!document.querySelector('.room-card[data-room-id="${twoDates.id}"]').classList.contains('is-scheduled') && document.querySelector('.room-card[data-room-id="${stressCard.id}"]').classList.contains('is-scheduled')`), true, 'removes only the last schedule effect while another room remains scheduled');
    assert.equal(await evaluate(client, `!document.querySelector('.room-card[data-room-id="${proposalOnly.id}"]').classList.contains('is-scheduled')`), true, 'a proposed-only room never activates the scheduled effect');

    const member = await register(fixture.baseUrl, 'Issue 38 Repair Nonowner');
    assert.equal(member.response.status, 201);
    memberClient = await makeClient(port, fixture.baseUrl, member.cookie, { width: 1280, height: 900 });
    await memberClient.send('Page.navigate', { url: `${fixture.baseUrl}/rooms` });
    assert.equal(await waitFor(memberClient, `Boolean(document.querySelector('#rooms-content') && !document.querySelector('#rooms-content').hidden && document.querySelector('.room-card[data-room-id="${stressCard.id}"]'))`), true, 'loads the room list for a real nonowner member');
    const nonownerState = await evaluate(memberClient, `(() => { const card = document.querySelector('.room-card[data-room-id="${stressCard.id}"]'); const edit = card.querySelector('.room-card__edit'); const manage = document.querySelector('#rooms-manage-users'); return { editHidden: edit.hidden, editDisplay: getComputedStyle(edit).display, manageHidden: manage.hidden, manageDisplay: getComputedStyle(manage).display, manageRect: manage.getBoundingClientRect().toJSON() }; })()`);
    assert.equal(nonownerState.editHidden, true);
    assert.equal(nonownerState.editDisplay, 'none', 'hides room editing from a real nonowner in rendered CSS');
    assert.equal(nonownerState.manageHidden, true);
    assert.equal(nonownerState.manageDisplay, 'none', 'hides app-user-management from an ordinary member in rendered CSS');
    assert.equal(nonownerState.manageRect.width, 0);
    assert.equal((await fetch(`${fixture.baseUrl}/api/admin/users`, { headers: { cookie: member.cookie } })).status, 403, 'keeps server-side application-admin protection for a room nonowner');

    const pastSummaryBefore = await evaluate(client, `document.querySelector('.room-card[data-room-id="${pastOnly.id}"] .room-card__dates--scheduled .room-card__date-values').textContent`);
    assert.match(pastSummaryBefore, /28-Oct/);
    fixture.setNow('2026-10-29T05:00:00.000Z');
    assert.equal(await waitFor(client, 'typeof window.__fireRoomDayRollover === "function"'), true, 'installs a deterministic hook for the room-list Bangkok day rollover');
    await evaluate(client, 'window.__fireRoomDayRollover()');
    assert.equal(await waitFor(client, `document.querySelector('.room-card[data-room-id="${pastOnly.id}"] .room-card__dates--scheduled .room-card__date-values').textContent === 'None' && !document.querySelector('.room-card[data-room-id="${pastOnly.id}"]').classList.contains('is-scheduled')`), true, 'Bangkok day rollover refresh removes past-only scheduled dates and their effect');
    assert.equal(await evaluate(client, `!document.querySelector('.room-card[data-room-id="${pastOnly.id}"]').classList.contains('is-beam-running')`), true, 'past-only rooms do not retain scheduled animation effects after Bangkok midnight');
  } finally {
    memberClient?.close();
    client?.close();
    await stopChromium(browser);
    await removeProfileWithRetry(profile);
    await fixture.close();
  }
});

test('Issue 38 board metadata repairs on reconnect/pageshow and both admin paths preserve safe room return', async (t) => {
  const fixture = await createFixture();
  const owner = await register(fixture.baseUrl, 'Issue 38 Board Owner');
  assert.equal(owner.response.status, 201);
  const room = await createRoom(fixture.baseUrl, owner, 'Before disconnect');
  const admin = await loginAdmin(fixture.baseUrl);
  assert.equal(admin.response.status, 200);
  const adminEnter = await fetch(`${fixture.baseUrl}/api/rooms/${room.id}/enter`, {
    method: 'POST', headers: apiHeaders(fixture.baseUrl, admin), body: '{}',
  });
  assert.equal(adminEnter.status, 200, 'adds the admin as a room member before opening its board');
  const profile = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'run-together-issue-38-board-chrome-'));
  const browser = spawnChromium(chromePath, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
    '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank',
  ]);
  let client;
  try {
    const port = await readDevToolsPort(profile, browser, { timeoutMs: chromiumReadinessTimeoutMs });
    client = await makeClient(port, fixture.baseUrl, admin.cookie, { width: 390, height: 844, mobile: true });
    await client.send('Page.navigate', { url: `${fixture.baseUrl}/vote/${room.id}` });
    assert.equal(await waitFor(client, `document.querySelector('#protected-content') && !document.querySelector('#protected-content').hidden && document.querySelector('#room-heading')?.textContent === 'Before disconnect'`), true, 'loads the selected room board for an application admin');

    await client.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    assert.equal(await waitFor(client, '!navigator.onLine'), true, 'disconnects the real browser before an offline title edit');
    const offlineEdit = await fetch(`${fixture.baseUrl}/api/rooms/${room.id}`, {
      method: 'PUT', headers: apiHeaders(fixture.baseUrl, owner), body: JSON.stringify({ title: 'Offline title changed' }),
    });
    assert.equal(offlineEdit.status, 200);
    await client.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: 10_000_000, uploadThroughput: 10_000_000, connectionType: 'wifi' });
    assert.equal(await waitFor(client, `document.querySelector('#room-heading')?.textContent === 'Offline title changed'`), true, 'repairs a missed room title from authoritative reconnect state');

    await evaluate(client, `(() => {
      const originalFetch = window.fetch.bind(window);
      const targetPath = '/api/rooms/${room.id}';
      window.__heldRoomMetadata = [];
      window.__holdRoomMetadata = true;
      window.__roomMetadataFetchCount = 0;
      window.fetch = async (...args) => {
        const response = await originalFetch(...args);
        const url = new URL(typeof args[0] === 'string' ? args[0] : args[0].url, location.href);
        if (url.pathname !== targetPath) return response;
        window.__roomMetadataFetchCount += 1;
        if (!window.__holdRoomMetadata) return response;
        const body = await response.clone().json();
        return new Promise((resolve) => window.__heldRoomMetadata.push(() => resolve(new Response(JSON.stringify(body), { status: response.status, headers: { 'content-type': 'application/json' } }))));
      };
    })()`);
    await evaluate(client, "dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))");
    assert.equal(await waitFor(client, 'window.__heldRoomMetadata.length === 1'), true, 'a pageshow repair fetches authoritative room metadata');
    const newerEdit = await fetch(`${fixture.baseUrl}/api/rooms/${room.id}`, {
      method: 'PUT', headers: apiHeaders(fixture.baseUrl, owner), body: JSON.stringify({ title: 'Newer live title' }),
    });
    assert.equal(newerEdit.status, 200);
    assert.equal(await waitFor(client, `document.querySelector('#room-heading')?.textContent === 'Newer live title'`), true, 'applies a newer live metadata change while an older response is delayed');
    await evaluate(client, 'window.__heldRoomMetadata[0]()');
    await delay(120);
    assert.equal(await evaluate(client, `document.querySelector('#room-heading').textContent`), 'Newer live title', 'does not let delayed old metadata overwrite the newer live title');
    await evaluate(client, 'window.__holdRoomMetadata = false');
    const fetchCountBeforeBfcache = await evaluate(client, 'window.__roomMetadataFetchCount');
    await evaluate(client, "dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))");
    assert.equal(await waitFor(client, `window.__roomMetadataFetchCount > ${fetchCountBeforeBfcache} && document.querySelector('#room-heading')?.textContent === 'Newer live title'`), true, 'refreshes metadata on a BFCache-style persisted pageshow');

    await clickSelector(client, '#manage-user');
    assert.equal(await waitFor(client, `location.pathname === '/admin' && document.querySelector('#admin-return')`), true, 'opens Manage users from the original board button');
    assert.equal(await evaluate(client, `document.querySelector('#admin-return').getAttribute('href')`), `/vote/${room.id}`, 'the primary manage user button returns to the selected room');
    await clickSelector(client, '#admin-return');
    assert.equal(await waitFor(client, `location.pathname === '/vote/${room.id}' && document.querySelector('#room-heading')`), true, 'returns from the primary Manage users route to the same room');
    assert.equal(await evaluate(client, `document.querySelector('#manage-users-link').getAttribute('href')`), `/admin?returnTo=${encodeURIComponent(`/vote/${room.id}`)}`, 'keeps the secondary link on the same safe room context');
    await evaluate(client, "document.querySelector('#manage-users-link').click()");
    const secondaryAdminReady = await waitFor(client, `location.pathname === '/admin' && document.querySelector('#admin-return')?.getAttribute('href') === '/vote/${room.id}'`);
    if (!secondaryAdminReady) t.diagnostic(JSON.stringify(await evaluate(client, `({ path: location.pathname, href: location.href, pageTitle: document.title, returnTo: document.querySelector('#admin-return')?.getAttribute('href'), boardLink: document.querySelector('#manage-users-link')?.getAttribute('href') })`)));
    assert.equal(secondaryAdminReady, true, 'the secondary Manage users link returns to the selected room too');

    await client.send('Page.navigate', { url: `${fixture.baseUrl}/rooms` });
    assert.equal(await waitFor(client, `document.querySelector('#rooms-content') && !document.querySelector('#rooms-content').hidden && document.querySelector('#rooms-manage-users')`), true, 'loads the admin room list without a selected-room context');
    const adminListControl = await evaluate(client, `(() => { const link = document.querySelector('#rooms-manage-users'); return { hidden: link.hidden, display: getComputedStyle(link).display, href: link.getAttribute('href') }; })()`);
    assert.deepEqual(adminListControl, { hidden: false, display: 'block', href: '/admin?returnTo=%2Frooms' }, 'shows the Manage users control to an application admin with the safe rooms fallback');
    await clickSelector(client, '#rooms-manage-users');
    assert.equal(await waitFor(client, `location.pathname === '/admin' && document.querySelector('#admin-return')?.getAttribute('href') === '/rooms'`), true, 'the no-room admin path returns to the rooms list');
  } finally {
    client?.close();
    await stopChromium(browser);
    await removeProfileWithRetry(profile);
    await fixture.close();
  }
});
