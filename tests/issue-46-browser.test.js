import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { addVote, proposeRunEvent, setRunEventStatus } from '../src/domain.js';
import { createServer } from '../src/server.js';
import { addRoomMember, createRoom } from '../src/room-storage.js';
import { removeProfileWithRetry } from './helpers/chromium-profile-cleanup.js';
import { chromiumReadinessTimeoutMs, readDevToolsPort, spawnChromium, stopChromium } from './helpers/chromium-startup.js';

const chromePath = process.env.CHROME_BIN ?? [
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/opt/google/chrome/chrome',
  '/opt/data/tmp/chrome/opt/google/chrome/chrome',
].find((path) => existsSync(path));
if (!chromePath) throw new Error('Issue 46 browser coverage requires real Chromium; refusing to skip.');

const ENV = { ADMIN_NAME: 'Issue 46 Browser Admin', ADMIN_PIN: '4826', PIN_PEPPER: 'synthetic-pepper' };
const NOW = new Date('2026-11-01T00:00:00.000Z');

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
  const events = new Map();
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id) {
      (events.get(message.method) ?? []).forEach((listener) => listener(message.params));
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
    async send(method, params = {}) {
      await opened;
      const id = ++nextId;
      const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      socket.send(JSON.stringify({ id, method, params }));
      return result;
    },
    on(method, listener) {
      events.set(method, [...(events.get(method) ?? []), listener]);
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
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await evaluate(client, expression)) return true;
    await delay(50);
  }
  return false;
}

async function openPage(client, url) {
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Network.enable');
  await client.send('Page.navigate', { url });
}

function seedEvent(database, { roomId, userId, adminUserId = userId, date, status }) {
  const proposal = proposeRunEvent(database, { roomId, userId, eventDate: date, requestId: randomUUID(), now: () => NOW });
  if (status === 'proposed') return proposal.event;
  return setRunEventStatus(database, {
    roomId, adminUserId, eventDate: date, eventId: proposal.event.eventId,
    revision: proposal.event.revision, status, requestId: randomUUID(), now: () => NOW,
  }).event;
}

test('Issue 46 room page, switches, personal schedule and deep link work at mobile size in real Chromium', async (t) => {
  const directory = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'run-together-issue-46-browser-'));
  const server = createServer({ databasePath: join(directory, 'preview.sqlite'), env: ENV, now: () => NOW });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const registered = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { origin: baseUrl, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Issue 46 Browser Viewer', pin: '0042', pinConfirmation: '0042' }),
  });
  assert.equal(registered.status, 201);
  const cookie = registered.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
  const viewerId = server.database.prepare('SELECT id FROM users WHERE name = ?').get('Issue 46 Browser Viewer').id;
  const adminId = server.database.prepare("SELECT id FROM users WHERE role = 'admin'").get().id;
  const otherId = Number(server.database.prepare(`
    INSERT INTO users (name, name_key, pin_salt, pin_hash, role, created_at, updated_at)
    VALUES ('Issue 46 Browser Other', 'issue 46 browser other', x'01', x'02', 'user', ?, ?)
  `).run(NOW.toISOString(), NOW.toISOString()).lastInsertRowid);

  const createdRoom = createRoom(server.database, { creatorUserId: viewerId, title: 'Created by viewer' });
  const inheritedRoom = createRoom(server.database, { creatorUserId: otherId, title: 'Inherited owner' });
  const votedRoom = createRoom(server.database, { creatorUserId: otherId, title: 'A long room title that wraps' });
  server.database.prepare('UPDATE rooms SET owner_user_id = ? WHERE id = ?').run(viewerId, inheritedRoom.id);
  addRoomMember(server.database, { roomId: votedRoom.id, userId: viewerId, now: () => NOW });

  addVote(server.database, { roomId: createdRoom.id, userId: viewerId, voteDate: '2026-11-03', now: () => NOW });
  seedEvent(server.database, { roomId: createdRoom.id, userId: viewerId, date: '2026-11-03', status: 'proposed' });
  addVote(server.database, { roomId: inheritedRoom.id, userId: otherId, voteDate: '2026-11-02', now: () => NOW });
  seedEvent(server.database, { roomId: inheritedRoom.id, userId: otherId, adminUserId: adminId, date: '2026-11-02', status: 'scheduled' });
  for (const date of ['2026-11-02', '2026-11-04']) {
    addVote(server.database, { roomId: votedRoom.id, userId: viewerId, voteDate: date, now: () => NOW });
    seedEvent(server.database, { roomId: votedRoom.id, userId: viewerId, adminUserId: adminId, date, status: 'scheduled' });
  }
  addVote(server.database, { roomId: votedRoom.id, userId: viewerId, voteDate: '2026-11-05', now: () => NOW });
  seedEvent(server.database, { roomId: votedRoom.id, userId: viewerId, date: '2026-11-05', status: 'proposed' });

  const roomResponse = await fetch(`${baseUrl}/api/rooms`, { headers: { cookie } });
  const roomPayload = await roomResponse.json();
  const roomById = new Map(roomPayload.rooms.map((room) => [room.id, room]));
  const baselineOrder = roomPayload.rooms.map(({ id }) => id);
  const scheduleBefore = server.database.prepare('SELECT COUNT(*) AS count FROM run_events').get().count;
  const voteCountBefore = server.database.prepare('SELECT COUNT(*) AS count FROM votes').get().count;
  const profile = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'run-together-issue-46-chrome-'));
  const startupStartedAt = performance.now();
  const browser = spawnChromium(chromePath, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
    '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank',
  ]);
  let client;
  let runtimeExceptions = [];
  t.after(async () => {
    client?.close();
    await stopChromium(browser);
    await removeProfileWithRetry(profile);
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.database.close();
    await rm(directory, { recursive: true, force: true });
  });
  const port = await readDevToolsPort(profile, browser, { timeoutMs: chromiumReadinessTimeoutMs });
  t.diagnostic(`Chromium launch-to-DevTools readiness ${(performance.now() - startupStartedAt).toFixed(1)}ms; executable: ${browser.spawnfile}; state: ${browser.exitCode === null && browser.signalCode === null ? 'running' : 'exited'}.`);
  const target = await createTarget(port);
  client = createCdpClient(target.webSocketDebuggerUrl);
  client.on('Runtime.exceptionThrown', ({ exceptionDetails }) => runtimeExceptions.push(exceptionDetails?.text ?? 'browser exception'));
  await openPage(client, `${baseUrl}/rooms`);
  await client.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const nativeScrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (options) {
      window.__issue46ScrollBehavior = typeof options === 'object' ? options.behavior : undefined;
      return nativeScrollIntoView.call(this, options);
    };
  })();` });
  const [cookieName, cookieValue] = cookie.split('=', 2);
  await client.send('Network.setCookie', { url: baseUrl, name: cookieName, value: cookieValue, path: '/' });
  await client.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 844, deviceScaleFactor: 2, mobile: true });
  await client.send('Page.navigate', { url: `${baseUrl}/rooms` });
  assert.equal(await waitFor(client, `Boolean(document.querySelector('#rooms-content') && !document.querySelector('#rooms-content').hidden && document.querySelectorAll('.room-card').length === ${baselineOrder.length})`), true,
    'loads the real authenticated room page and seeded room cards');

  const initial = await evaluate(client, `(() => ({
    filters: [...document.querySelectorAll('#room-filters input[type=checkbox]')].map((input) => ({ label: input.parentElement.textContent.trim(), checked: input.checked, role: input.getAttribute('role') })),
    disclosure: (() => {
      const fieldset = document.querySelector('#room-filters');
      const details = fieldset.querySelector('details.filter-collapsible');
      const summary = details.querySelector('summary');
      const bounds = summary.getBoundingClientRect();
      return {
        immediateSibling: document.querySelector('#create-room-navigation').nextElementSibling === fieldset,
        ariaLabel: fieldset.getAttribute('aria-label'),
        legends: fieldset.querySelectorAll('legend').length,
        detailsCount: fieldset.querySelectorAll('details.filter-collapsible').length,
        closed: !details.open,
        summaryText: summary.textContent.trim(),
        summaryAccessibleName: summary.getAttribute('aria-label') ?? summary.textContent.trim(),
        summaryFirstChild: details.firstElementChild === summary,
        iconCount: summary.querySelectorAll('.filter-collapsible__icon').length,
        iconHidden: summary.querySelector('.filter-collapsible__icon')?.getAttribute('aria-hidden'),
        iconTag: summary.querySelector('.filter-collapsible__icon')?.tagName,
        iconTransform: summary.querySelector('.filter-collapsible__icon') ? getComputedStyle(summary.querySelector('.filter-collapsible__icon')).transform : null,
        iconTransition: summary.querySelector('.filter-collapsible__icon') ? getComputedStyle(summary.querySelector('.filter-collapsible__icon')).transitionProperty : null,
        markerContent: getComputedStyle(summary, '::marker').content,
        markerListStyle: getComputedStyle(summary).listStyleType,
        boundary: (() => { const style = getComputedStyle(details); return { borderWidth: style.borderTopWidth, borderColor: style.borderTopColor, radius: style.borderTopLeftRadius, boxSizing: style.boxSizing, padding: style.padding }; })(),
        content: details.querySelectorAll(':scope > .filter-content').length,
        contentLabels: details.querySelectorAll('.filter-content > label.room-filter').length,
        summaryHeight: bounds.height,
        summaryCursor: getComputedStyle(summary).cursor,
        summaryWeight: getComputedStyle(summary).fontWeight,
        contentDisplay: getComputedStyle(details.querySelector('.filter-content')).display,
        contentFlexWrap: getComputedStyle(details.querySelector('.filter-content')).flexWrap,
        contentGap: getComputedStyle(details.querySelector('.filter-content')).gap,
        buttonDisplay: getComputedStyle(document.querySelector('#create-room-navigation')).display,
        filterDisplay: getComputedStyle(fieldset).display,
        buttonVerticalAlign: getComputedStyle(document.querySelector('#create-room-navigation')).verticalAlign,
        filterVerticalAlign: getComputedStyle(fieldset).verticalAlign,
        buttonBounds: (() => { const rect = document.querySelector('#create-room-navigation').getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }; })(),
        filterBounds: (() => { const rect = fieldset.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }; })(),
      };
    })(),
    sectionOrder: ['.rooms-toolbar', '#upcoming-schedule', '#create-room-navigation', '#room-filters', '#room-cards', '#rooms-empty', '#rooms-no-matches', '#create-room-heading'].map((selector) => {
      const selected = document.querySelector(selector);
      const node = selector === '#create-room-heading' ? selected?.parentElement : selected;
      return node ? [...node.parentElement.children].indexOf(node) : -1;
    }),
  }))()`);
  assert.deepEqual(initial.filters.map(({ label, checked, role }) => [label, checked, role]), [
    ['My voted', false, 'switch'], ['My created room', false, 'switch'], ['Scheduled', false, 'switch'], ['Proposed', false, 'switch'],
  ], 'four independent, initially-off native switches expose their on/off state');
  assert.deepEqual(initial.disclosure, {
    immediateSibling: true, ariaLabel: 'Filter rooms / กรองห้อง', legends: 0,
    detailsCount: 1, closed: true, summaryText: 'Filter rooms', summaryAccessibleName: 'Filter rooms', summaryFirstChild: true,
    iconCount: 1, iconHidden: 'true', iconTag: 'svg', iconTransform: 'matrix(1, 0, 0, 1, 0, 0)', iconTransition: 'transform',
    markerContent: '""', markerListStyle: 'none',
    boundary: { borderWidth: '1px', borderColor: 'rgb(148, 163, 184)', radius: '6.4px', boxSizing: 'content-box', padding: '4px' },
    content: 1, contentLabels: 4, summaryHeight: 44, summaryCursor: 'pointer', summaryWeight: '700',
    contentDisplay: 'flex', contentFlexWrap: 'wrap', contentGap: '8px',
    buttonDisplay: 'inline-block', filterDisplay: 'inline-block', buttonVerticalAlign: 'middle', filterVerticalAlign: 'middle',
    buttonBounds: initial.disclosure.buttonBounds, filterBounds: initial.disclosure.filterBounds,
  }, 'the filter fieldset contains one closed, native, accessible disclosure beside the create-room control');
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 844, deviceScaleFactor: 1, mobile: false });
  const wideControls = await evaluate(client, `(() => {
    const button = document.querySelector('#create-room-navigation').getBoundingClientRect();
    const filters = document.querySelector('#room-filters').getBoundingClientRect();
    const details = document.querySelector('#room-filters .filter-collapsible').getBoundingClientRect();
    return { buttonTop: button.top, filterTop: filters.top, buttonRight: button.right, filterLeft: filters.left,
      buttonCenter: (button.top + button.bottom) / 2, detailsCenter: (details.top + details.bottom) / 2,
      detailsLeft: details.left, detailsRight: details.right, filterRight: filters.right,
      pageWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth };
  })()`);
  assert.ok(wideControls.buttonRight <= wideControls.filterLeft,
    'the create-room and filter controls display side by side when space allows');
  assert.ok(Math.abs(wideControls.buttonCenter - wideControls.detailsCenter) <= 1,
    'the bordered expandable component remains vertically centered with the create-room control');
  assert.ok(wideControls.detailsLeft >= wideControls.filterLeft && wideControls.detailsRight <= wideControls.filterRight,
    'the visual boundary stays inside the compact filter fieldset');
  assert.ok(wideControls.pageWidth <= wideControls.viewportWidth, 'the wide room page has no horizontal overflow');
  await client.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 844, deviceScaleFactor: 2, mobile: true });
  assert.equal(initial.sectionOrder.every((index) => index >= 0), true, 'all required page sections exist');
  assert.deepEqual(initial.sectionOrder, [...initial.sectionOrder].sort((left, right) => left - right), 'the page follows the requested account/schedule/navigation/filter/cards/form order');
  assert.deepEqual(await evaluate(client, `[...document.querySelectorAll('.room-card')].map((card) => card.dataset.roomId)`), baselineOrder,
    'all off displays rooms in their existing sorted order');

  await evaluate(client, `document.querySelector('#room-filters summary').click()`);
  assert.equal(await evaluate(client, `document.querySelector('#room-filters details').open`), true,
    'a pointer click opens the native details disclosure and reveals all switches');
  assert.equal(await evaluate(client, `document.querySelectorAll('#room-filters .filter-content .room-filter').length`), 4);
  await delay(220);
  assert.equal(await evaluate(client, `getComputedStyle(document.querySelector('#room-filters .filter-collapsible__icon')).transform`), 'matrix(-1, 0, 0, -1, 0, 0)',
    'the custom arrow points up only while the native details element is open');
  await evaluate(client, `document.querySelector('#room-filters summary').click()`);
  await delay(220);
  assert.equal(await evaluate(client, `document.querySelector('#room-filters details').open`), false,
    'a second pointer click closes the native disclosure');
  assert.equal(await evaluate(client, `getComputedStyle(document.querySelector('#room-filters .filter-collapsible__icon')).transform`), 'matrix(1, 0, 0, 1, 0, 0)',
    'the custom arrow points down when the disclosure is closed');
  assert.equal(await evaluate(client, `getComputedStyle(document.querySelector('#room-filters .filter-collapsible__icon')).transitionProperty`), 'transform',
    'arrow rotation transitions when reduced motion is not requested');
  await evaluate(client, `document.querySelector('#create-room-navigation').focus()`);
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab' });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab' });
  assert.equal(await evaluate(client, `document.activeElement === document.querySelector('#room-filters summary')`), true,
    'the summary is reachable by keyboard navigation');
  const summaryFocus = await evaluate(client, `(() => ({ outline: getComputedStyle(document.querySelector('#room-filters summary')).outlineStyle, outlineWidth: getComputedStyle(document.querySelector('#room-filters summary')).outlineWidth }))()`);
  assert.equal(summaryFocus.outline, 'solid', 'the summary has a visible focus indicator');
  assert.equal(summaryFocus.outlineWidth, '3px');
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  assert.equal(await evaluate(client, `document.querySelector('#room-filters details').open`), true,
    'Enter toggles the native disclosure from the keyboard');
  await client.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
  assert.equal(await evaluate(client, `document.querySelector('#room-filters details').open`), false,
    'Space toggles the native disclosure from the keyboard');
  await evaluate(client, `document.querySelector('#room-filters summary').click()`);
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
  const switchFocus = await evaluate(client, `(() => ({
    focused: document.activeElement?.id,
    outline: getComputedStyle(document.activeElement?.nextElementSibling).outlineStyle,
    outlineWidth: getComputedStyle(document.activeElement?.nextElementSibling).outlineWidth,
  }))()`);
  assert.deepEqual(switchFocus, { focused: 'filter-my-voted', outline: 'solid', outlineWidth: '3px' },
    'the visible switch has a keyboard focus indicator');

  const scheduleState = await evaluate(client, `(() => {
    const section = document.querySelector('#upcoming-schedule');
    const rows = [...document.querySelectorAll('.upcoming-schedule__row')];
    const switchLabels = [...document.querySelectorAll('#room-filters .room-filter')].map((label) => {
      const bounds = label.getBoundingClientRect();
      return { width: bounds.width, height: bounds.height };
    });
    const scheduled = document.querySelector('.room-card[data-room-id="${votedRoom.id}"] .room-card__dates--scheduled');
    const card = document.querySelector('.room-card[data-room-id="${votedRoom.id}"]');
    return {
      heading: section.querySelector('h2')?.textContent,
      hidden: section.hidden,
      rows: rows.map((row) => ({
        text: row.textContent.trim(), href: row.getAttribute('href'),
        dateTime: row.querySelector('time')?.dateTime,
        dateLabel: row.querySelector('time')?.getAttribute('aria-label'),
        label: row.getAttribute('aria-label'),
        height: row.getBoundingClientRect().height,
      })),
      switchLabels,
      scheduledStyle: {
        fontSize: parseFloat(getComputedStyle(scheduled).fontSize),
        textColor: getComputedStyle(scheduled).color,
        backgroundColor: getComputedStyle(scheduled).backgroundColor,
        cardBackground: getComputedStyle(card).backgroundColor,
      },
      pageWidth: document.documentElement.scrollWidth,
      viewportWidth: innerWidth,
    };
  })()`);
  assert.equal(scheduleState.heading, 'Your upcoming schedule');
  assert.equal(scheduleState.hidden, false);
  assert.deepEqual(scheduleState.rows.map(({ dateTime }) => dateTime), ['2026-11-02', '2026-11-04'],
    'each qualifying date in one room gets its own nearest-first row; unvoted/proposed dates are omitted');
  assert.ok(scheduleState.rows.every(({ text, height, dateLabel, label }) => (
    text.includes('A long room title that wraps') && height >= 44 && dateLabel.includes('2026') && label.includes('2026')
  )));
  assert.ok(scheduleState.switchLabels.every(({ height }) => height >= 44), 'each switch label target is at least 44 CSS pixels high');
  assert.ok(scheduleState.scheduledStyle.fontSize >= 16, 'scheduled label and date text are larger than the baseline');
  assert.equal(scheduleState.scheduledStyle.backgroundColor, 'rgb(254, 243, 199)');
  assert.equal(scheduleState.scheduledStyle.textColor, 'rgb(63, 45, 0)');
  assert.equal(scheduleState.scheduledStyle.cardBackground, 'rgba(0, 0, 0, 0)', 'only the scheduled text area receives a fill');
  assert.ok(scheduleState.pageWidth <= scheduleState.viewportWidth, 'the page does not scroll horizontally at 320 CSS pixels');
  const narrowDisclosure = await evaluate(client, `(() => {
    const details = document.querySelector('#room-filters .filter-collapsible').getBoundingClientRect();
    const summary = document.querySelector('#room-filters summary').getBoundingClientRect();
    return { detailsLeft: details.left, detailsRight: details.right, summaryHeight: summary.height,
      pageWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth };
  })()`);
  assert.equal(narrowDisclosure.summaryHeight, 44, 'the summary remains a 44 CSS pixel target at 320 CSS pixels');
  assert.ok(narrowDisclosure.detailsLeft >= 0 && narrowDisclosure.detailsRight <= narrowDisclosure.viewportWidth,
    'the filter boundary fits the 320 CSS pixel viewport');
  assert.ok(narrowDisclosure.pageWidth <= narrowDisclosure.viewportWidth, 'the 320 CSS pixel page has no horizontal overflow');
  await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }).then(async ({ data }) => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(process.cwd(), 'outputs/issue-46-room-page-320.png'), Buffer.from(data, 'base64'));
  });

  for (let mask = 0; mask < 16; mask += 1) {
    const enabled = [0, 1, 2, 3].map((bit) => Boolean(mask & (1 << bit)));
    const ids = await evaluate(client, `(() => {
      const inputs = [...document.querySelectorAll('#room-filters input[type=checkbox]')];
      const states = ${JSON.stringify(enabled)};
      inputs.forEach((input, index) => { input.checked = states[index]; input.dispatchEvent(new Event('change', { bubbles: true })); });
      return [...document.querySelectorAll('.room-card:not([hidden])')].map((card) => card.dataset.roomId);
    })()`);
    const personalIds = roomPayload.rooms.filter((room) => (
      (!enabled[0] || room.myVoted === true) && (!enabled[1] || room.myCreated === true)
    ));
    const expected = personalIds.filter((room) => {
      const hasSelectedStatus = enabled[2] || enabled[3];
      return !hasSelectedStatus
        || (enabled[2] && room.summary.scheduledDates.length > 0)
        || (enabled[3] && room.summary.proposedDates.length > 0);
    }).map(({ id }) => id);
    assert.deepEqual(ids, expected, `all four switch combination mask ${mask} applies personal AND/status OR semantics`);
  }
  const noMatch = await evaluate(client, `(() => {
    const created = document.querySelector('#filter-my-created');
    const scheduled = document.querySelector('#filter-scheduled');
    [...document.querySelectorAll('#room-filters input[type=checkbox]')].forEach((input) => { input.checked = false; });
    created.checked = true;
    scheduled.checked = true;
    created.dispatchEvent(new Event('change', { bubbles: true }));
    scheduled.dispatchEvent(new Event('change', { bubbles: true }));
    return {
      hidden: document.querySelector('#rooms-no-matches').hidden,
      empty: document.querySelector('#rooms-empty').hidden,
      createEnabled: !document.querySelector('#create-room-form button[type=submit]').disabled,
    };
  })()`);
  assert.deepEqual(noMatch, { hidden: false, empty: true, createEnabled: true }, 'no-match differs from no rooms and creation remains available');
  const filteredBeforeDisclosure = await evaluate(client, `JSON.stringify({
    filters: [...document.querySelectorAll('#room-filters input[type=checkbox]')].map((input) => input.checked),
    visibleRooms: [...document.querySelectorAll('.room-card:not([hidden])')].map((card) => card.dataset.roomId),
    noMatchesHidden: document.querySelector('#rooms-no-matches').hidden,
  })`);
  await evaluate(client, `document.querySelector('#room-filters summary').click()`);
  assert.equal(await evaluate(client, `document.querySelector('#room-filters details').open`), false);
  await evaluate(client, `document.querySelector('#room-filters summary').click()`);
  assert.equal(await evaluate(client, `document.querySelector('#room-filters details').open`), true);
  assert.equal(await evaluate(client, `JSON.stringify({
    filters: [...document.querySelectorAll('#room-filters input[type=checkbox]')].map((input) => input.checked),
    visibleRooms: [...document.querySelectorAll('.room-card:not([hidden])')].map((card) => card.dataset.roomId),
    noMatchesHidden: document.querySelector('#rooms-no-matches').hidden,
  })`), filteredBeforeDisclosure, 'closing and reopening preserves selected filters, matching rooms, and no-match state');
  assert.equal(await evaluate(client, `document.querySelector('#upcoming-schedule').hidden`), false,
    'room filters do not change the personal schedule section');

  await evaluate(client, `(() => {
    const input = document.querySelector('#create-room-title');
    input.value = 'Keep this draft';
    document.querySelector('#create-room-navigation').click();
  })()`);
  const createNavigation = await evaluate(client, `({
    focused: document.activeElement?.id,
    title: document.querySelector('#create-room-title').value,
    behavior: window.__issue46ScrollBehavior,
    rooms: document.querySelectorAll('.room-card').length,
    buttonText: document.querySelector('#create-room-navigation').textContent.trim(),
    buttonAnimation: getComputedStyle(document.querySelector('#create-room-navigation')).animationName,
    buttonHeight: document.querySelector('#create-room-navigation').getBoundingClientRect().height,
  })`);
  assert.deepEqual(createNavigation, {
    focused: 'create-room-title', title: 'Keep this draft', behavior: 'smooth', rooms: baselineOrder.length,
    buttonText: 'to create room', buttonAnimation: 'none', buttonHeight: 44,
  }, 'the restrained navigation button scrolls/focuses without submit or reset');
  await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  assert.equal(await evaluate(client, `getComputedStyle(document.querySelector('#room-filters .filter-collapsible__icon')).transitionDuration`), '0s',
    'reduced-motion mode disables the arrow transition');
  await evaluate(client, `document.querySelector('#room-filters details').open = false`);
  await evaluate(client, `document.querySelector('#room-filters summary').click()`);
  assert.equal(await evaluate(client, `getComputedStyle(document.querySelector('#room-filters .filter-collapsible__icon')).transform`), 'matrix(-1, 0, 0, -1, 0, 0)',
    'reduced-motion mode still shows the correct open arrow direction');
  await evaluate(client, `document.querySelector('#room-filters summary').click()`);
  await evaluate(client, `document.querySelector('#room-filters summary').click()`);
  await evaluate(client, `document.querySelector('#create-room-navigation').click()`);
  assert.equal(await evaluate(client, 'window.__issue46ScrollBehavior'), 'auto', 'creation navigation respects reduced motion');

  const accessibility = await client.send('Accessibility.getFullAXTree');
  const switches = accessibility.nodes.filter((node) => node.role?.value === 'switch');
  assert.equal(switches.length, 4, 'Chromium exposes all four controls as switches');
  assert.deepEqual(switches.map((node) => node.name?.value).sort(), ['My created room', 'My voted', 'Proposed', 'Scheduled']);
  assert.equal(accessibility.nodes.some((node) => node.name?.value === 'Filter rooms'), true,
    'Chromium exposes the summary with the exact accessible name Filter rooms');

  await client.send('Emulation.setEmulatedMedia', { features: [] });
  await client.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
  const zoomed = await evaluate(client, `({ scale: visualViewport.scale, pageWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth })`);
  assert.ok(zoomed.scale >= 1.9);
  assert.ok(zoomed.pageWidth <= zoomed.viewportWidth, 'the page remains usable at 200% page zoom');
  assert.equal(await evaluate(client, `document.querySelector('#room-filters summary').getBoundingClientRect().height`), 44,
    'the summary retains its 44 CSS pixel target at 200% page zoom');
  await client.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });

  const rowBeforeNavigation = scheduleState.rows.find(({ dateTime }) => dateTime === '2026-11-04');
  const votesBeforeNavigation = server.database.prepare('SELECT COUNT(*) AS count FROM votes').get().count;
  const eventsBeforeNavigation = server.database.prepare('SELECT COUNT(*) AS count FROM run_events').get().count;
  await evaluate(client, `document.querySelector('.upcoming-schedule__row[ href*="2026-11-04"]')?.click()`);
  assert.equal(await waitFor(client, `location.pathname === '/vote/${votedRoom.id}' && document.querySelector('#protected-content') && !document.querySelector('#protected-content').hidden && document.querySelector('.vote-day[data-date="2026-11-04"] .vote-card')?.classList.contains('is-deep-link-target')`), true,
    'the row opens its permanent room ID and focuses the exact date in its week');
  const destination = await evaluate(client, `(() => {
    const card = document.activeElement;
    const bounds = card.getBoundingClientRect();
    return {
      href: location.pathname + location.search,
      date: card.dataset.date,
      focused: card.matches('.vote-card'),
      outline: getComputedStyle(card).outlineStyle,
      visible: bounds.top >= 0 && bounds.bottom <= innerHeight,
      monday: [...document.querySelectorAll('#week-days .vote-day')].map((day) => day.dataset.date)[0],
    };
  })()`);
  assert.equal(destination.href, `/vote/${votedRoom.id}?date=2026-11-04`);
  assert.equal(destination.date, '2026-11-04', JSON.stringify(destination));
  assert.equal(destination.focused, true);
  assert.equal(destination.outline, 'solid');
  assert.equal(destination.visible, true);
  assert.equal(destination.monday, '2026-11-02');
  await client.send('Page.reload');
  assert.equal(await waitFor(client, `document.activeElement?.dataset?.date === '2026-11-04' && document.querySelector('#week-heading')?.textContent.includes('Week')`), true,
    'refreshing the destination restores the same room, week and focused date');
  assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM votes').get().count, votesBeforeNavigation,
    'date navigation and refresh do not toggle votes');
  assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM run_events').get().count, eventsBeforeNavigation,
    'date navigation and refresh do not create or change events');
  assert.equal(rowBeforeNavigation.href, `/vote/${votedRoom.id}?date=2026-11-04`);
  assert.deepEqual(runtimeExceptions, [], 'the browser reports no uncaught JavaScript exceptions');
});
