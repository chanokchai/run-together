import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { once } from 'node:events';
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
if (!chromePath) throw new Error('Issue 52 browser coverage requires real Chromium; refusing to skip.');

const ENV = { ADMIN_NAME: 'Issue 52 Browser Admin', ADMIN_PIN: '4826', PIN_PEPPER: 'synthetic-pepper' };
const NOW = new Date('2026-12-30T00:00:00.000Z');

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
    on(method, listener) { events.set(method, [...(events.get(method) ?? []), listener]); },
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

function scheduledEvent(database, { roomId, userId, date }) {
  const proposal = proposeRunEvent(database, {
    roomId, userId, eventDate: date, requestId: randomUUID(), now: () => NOW,
  });
  return setRunEventStatus(database, {
    roomId, adminUserId: userId, eventDate: date, eventId: proposal.event.eventId,
    revision: proposal.event.revision, status: 'scheduled', requestId: randomUUID(), now: () => NOW,
  });
}

test('Issue 52 brand and upcoming rows meet responsive, date/time, motion, navigation, and refresh contracts', async (t) => {
  const directory = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'run-together-issue-52-browser-'));
  const server = createServer({ databasePath: join(directory, 'preview.sqlite'), env: ENV, now: () => NOW });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const registration = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { origin: baseUrl, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Issue 52 Browser Viewer', pin: '0042', pinConfirmation: '0042' }),
  });
  assert.equal(registration.status, 201);
  const memberCookie = registration.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
  const viewerId = server.database.prepare('SELECT id FROM users WHERE name = ?').get('Issue 52 Browser Viewer').id;
  const otherId = Number(server.database.prepare(`
    INSERT INTO users (name, name_key, pin_salt, pin_hash, role, created_at, updated_at)
    VALUES ('Issue 52 Other Voter', 'issue 52 other voter', x'01', x'02', 'user', ?, ?)
  `).run(NOW.toISOString(), NOW.toISOString()).lastInsertRowid);
  const timedRoom = createRoom(server.database, {
    creatorUserId: viewerId, title: 'Morning long-distance run', time: '06:05',
  });
  const untimedRoom = createRoom(server.database, {
    creatorUserId: viewerId, title: 'วิ่งเช้าริมแม่น้ำแบบสบายใจ', time: '',
  });
  for (const room of [timedRoom, untimedRoom]) addRoomMember(server.database, { roomId: room.id, userId: otherId, now: () => NOW });
  for (const [room, date] of [[timedRoom, '2026-12-31'], [untimedRoom, '2027-01-01']]) {
    addVote(server.database, { roomId: room.id, userId: viewerId, voteDate: date, now: () => NOW });
    if (room === timedRoom) addVote(server.database, { roomId: room.id, userId: otherId, voteDate: date, now: () => NOW });
    scheduledEvent(server.database, { roomId: room.id, userId: viewerId, date });
  }

  const profile = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'run-together-issue-52-chrome-'));
  const browser = spawnChromium(chromePath, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
    '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank',
  ]);
  let client;
  const runtimeExceptions = [];
  t.after(async () => {
    client?.close();
    await stopChromium(browser);
    await removeProfileWithRetry(profile);
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.database.close();
    await rm(directory, { recursive: true, force: true });
  });
  const port = await readDevToolsPort(profile, browser, { timeoutMs: chromiumReadinessTimeoutMs });
  const target = await createTarget(port);
  client = createCdpClient(target.webSocketDebuggerUrl);
  client.on('Runtime.exceptionThrown', ({ exceptionDetails }) => runtimeExceptions.push(exceptionDetails?.text ?? 'browser exception'));
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Network.enable');
  await client.send('Page.navigate', { url: `${baseUrl}/` });
  assert.equal(await waitFor(client, `document.querySelector('.app-brand')?.textContent === 'VOTE&RUN!'`), true,
    'signed-out sign-in page loads the shared brand');
  let brand = await evaluate(client, `(() => {
    const mark = document.querySelector('.app-brand');
    const style = getComputedStyle(mark);
    return { text: mark.textContent, fontSize: style.fontSize, fontWeight: style.fontWeight,
      letterSpacing: style.letterSpacing, textTransform: style.textTransform,
      fontFamily: style.fontFamily, backgroundImage: style.backgroundImage,
      linked: Boolean(mark.closest('a')), pageHeading: document.querySelector('main h1')?.textContent };
  })()`);
  assert.deepEqual({
    text: brand.text, fontSize: brand.fontSize, fontWeight: brand.fontWeight,
    letterSpacing: brand.letterSpacing, textTransform: brand.textTransform,
    linked: brand.linked, pageHeading: brand.pageHeading,
  }, {
    text: 'VOTE&RUN!', fontSize: '24px', fontWeight: '800', letterSpacing: '-0.48px',
    textTransform: 'uppercase', linked: false, pageHeading: 'Run Together',
  });
  assert.match(brand.fontFamily, /Inter.*system-ui.*-apple-system.*sans-serif/);
  assert.match(brand.backgroundImage, /linear-gradient\(90deg/);
  assert.match(brand.backgroundImage, /240, 147, 251/);
  assert.match(brand.backgroundImage, /245, 87, 108/);
  const solidFallback = await evaluate(client, `(() => {
    const sheet = document.querySelector('style').sheet;
    for (let index = sheet.cssRules.length - 1; index >= 0; index -= 1) {
      const rule = sheet.cssRules[index];
      if (rule.cssText.includes('linear-gradient(90deg')) sheet.deleteRule(index);
    }
    const style = getComputedStyle(document.querySelector('.app-brand'));
    return { color: style.color, backgroundImage: style.backgroundImage,
      textFill: style.webkitTextFillColor };
  })()`);
  assert.deepEqual(solidFallback, {
    color: 'rgb(180, 35, 90)', backgroundImage: 'none', textFill: 'rgb(180, 35, 90)',
  }, 'the brand keeps readable solid text when gradient-clipping rules are unavailable');
  await client.send('Page.navigate', { url: `${baseUrl}/register` });
  assert.equal(await waitFor(client, `document.querySelector('.app-brand')?.textContent === 'VOTE&RUN!' && document.querySelector('main h1')?.textContent === 'Run Together'`), true,
    'signed-out registration keeps its page heading and shared brand');

  const [cookieName, cookieValue] = memberCookie.split('=', 2);
  await client.send('Network.setCookie', { url: baseUrl, name: cookieName, value: cookieValue, path: '/' });
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await client.send('Page.navigate', { url: `${baseUrl}/rooms` });
  assert.equal(await waitFor(client, `Boolean(document.querySelector('#rooms-content') && !document.querySelector('#rooms-content').hidden && document.querySelectorAll('.upcoming-schedule__row').length === 2)`), true,
    'member Rooms view loads both date-specific schedule rows');

  const roomBrand = await evaluate(client, `(() => {
    const mark = document.querySelector('#rooms-heading');
    const style = getComputedStyle(mark);
    const profile = document.querySelector('.profile-menu__trigger').getBoundingClientRect();
    return { text: mark.textContent, fontSize: style.fontSize, fontWeight: style.fontWeight,
      letterSpacing: style.letterSpacing, textTransform: style.textTransform,
      backgroundImage: style.backgroundImage, linked: Boolean(mark.closest('a')),
      h1Count: document.querySelectorAll('h1').length,
      profileWidth: profile.width, profileHeight: profile.height };
  })()`);
  assert.deepEqual({
    text: roomBrand.text, fontSize: roomBrand.fontSize, fontWeight: roomBrand.fontWeight,
    letterSpacing: roomBrand.letterSpacing, textTransform: roomBrand.textTransform,
    linked: roomBrand.linked, h1Count: roomBrand.h1Count,
  }, {
    text: 'VOTE&RUN!', fontSize: '24px', fontWeight: '800', letterSpacing: '-0.48px',
    textTransform: 'uppercase', linked: false, h1Count: 1,
  });
  assert.match(roomBrand.backgroundImage, /linear-gradient\(90deg/);
  assert.ok(roomBrand.profileWidth >= 44 && roomBrand.profileHeight >= 44, 'the member profile control remains a 44px touch target');

  const initialRows = await evaluate(client, `(() => [...document.querySelectorAll('.upcoming-schedule__row')].map((link) => {
    const box = link.querySelector('.upcoming-schedule__date-box');
    const date = box.querySelector('time');
    const details = link.querySelector('.upcoming-schedule__details');
    const number = details.querySelector('.upcoming-schedule__room-number');
    const title = details.querySelector('.upcoming-schedule__title');
    const voters = link.querySelector('.upcoming-schedule__voters');
    const boxRect = box.getBoundingClientRect();
    const detailsRect = details.getBoundingClientRect();
    const votersRect = voters.getBoundingClientRect();
    const rowRect = link.getBoundingClientRect();
    const style = getComputedStyle(box);
    const track = voters.querySelector('.vote-card__names-track');
    return { href: link.getAttribute('href'), label: link.getAttribute('aria-label'),
      datetime: date.dateTime, fullDate: date.getAttribute('aria-label'),
      weekday: date.querySelector('.upcoming-schedule__weekday')?.textContent,
      dayMonth: date.querySelector('.upcoming-schedule__day-month')?.textContent,
      time: date.querySelector('.upcoming-schedule__time')?.textContent ?? null,
      boxColor: style.backgroundColor, boxRadius: style.borderRadius, boxPadding: style.padding,
      boxWidth: boxRect.width, boxLeft: boxRect.left, detailsLeft: detailsRect.left,
      detailsTop: detailsRect.top, boxTop: boxRect.top, boxBottom: boxRect.bottom,
      votersTop: votersRect.top, votersLeft: votersRect.left, votersWidth: votersRect.width,
      rowLeft: rowRect.left, rowWidth: rowRect.width, rowHeight: rowRect.height,
      number: number.textContent, title: title.textContent, titleHeight: title.getBoundingClientRect().height,
      trackAnimation: getComputedStyle(track).animationName,
      trackDuration: getComputedStyle(track).animationDuration,
      currentUserHighlight: Boolean(voters.querySelector('.vote-card__voter-name.is-current-user')),
      copies: track.querySelectorAll('.vote-card__names-copy').length,
      speed: (voters.clientWidth + track.scrollWidth) / parseFloat(getComputedStyle(track).animationDuration) };
  }))()`);
  assert.deepEqual(initialRows.map(({ datetime, weekday, dayMonth, time, number }) => [datetime, weekday, dayMonth, time, number]), [
    ['2026-12-31', 'THU', '31 DEC', '06:05', `Room ${String(timedRoom.displayNumber).padStart(2, '0')}`],
    ['2027-01-01', 'FRI', '1 JAN', null, `Room ${String(untimedRoom.displayNumber).padStart(2, '0')}`],
  ], 'date lines handle month/year boundaries and optional existing room times');
  assert.deepEqual(initialRows.map(({ fullDate }) => fullDate), ['31 December 2026', '1 January 2027']);
  assert.ok(initialRows.every(({ boxColor, boxRadius, boxPadding, boxWidth, boxLeft, detailsLeft,
    detailsTop, boxTop, boxBottom, votersTop, votersLeft, votersWidth, rowLeft, rowWidth, rowHeight,
    label, trackAnimation, trackDuration, currentUserHighlight, copies }) => (
    boxColor === 'rgb(211, 214, 107)' && boxRadius === '8px' && boxPadding === '8px 6px'
    && boxWidth >= 60 && boxLeft < detailsLeft && Math.abs(boxTop - detailsTop) < 1
    && votersTop >= boxBottom - 1 && votersLeft >= rowLeft && votersWidth > boxWidth
    && rowHeight >= 44 && rowWidth >= 44 && (label.includes('2026') || label.includes('2027'))
  )), 'date/time box, adjacent room details, and distinct full-width voter row render');
  assert.ok(initialRows.every(({ trackAnimation, trackDuration, currentUserHighlight, copies, speed }) => (
    trackAnimation === 'voter-name-loop' && parseFloat(trackDuration) > 0
    && currentUserHighlight && copies === 1 && Math.abs(speed - 9.34375) < 0.25
  )), `normal motion retains the slow constant-speed marquee and current-user highlight: ${JSON.stringify(initialRows)}`);
  assert.notEqual(initialRows[0].trackDuration, initialRows[1].trackDuration,
    'different voter-name lengths change duration while preserving the same pixel speed');
  assert.ok(initialRows.every(({ href }) => href.startsWith('/vote/')));
  assert.ok(initialRows.some(({ titleHeight }) => titleHeight > 20), 'long room titles wrap within the available title column');

  for (const width of [320, 375, 390, 1280]) {
    await client.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 600 });
    const viewport = await evaluate(client, `(() => {
      const rows = [...document.querySelectorAll('.upcoming-schedule__row')].map((row) => ({
        right: row.getBoundingClientRect().right,
        titleRight: row.querySelector('.upcoming-schedule__title').getBoundingClientRect().right,
        titleHeight: row.querySelector('.upcoming-schedule__title').getBoundingClientRect().height,
        linkHeight: row.getBoundingClientRect().height,
      }));
      return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
        brandRight: document.querySelector('#rooms-heading').getBoundingClientRect().right, rows };
    })()`);
    assert.equal(viewport.width, width);
    assert.ok(viewport.scrollWidth <= width, `no horizontal page scrolling at ${width}px`);
    assert.ok(viewport.brandRight <= width, `brand stays inside ${width}px viewport`);
    assert.ok(viewport.rows.every(({ right, titleRight, linkHeight }) => right <= width && titleRight <= width && linkHeight >= 44),
      `schedule content and 44px links fit at ${width}px`);
    if (width === 320) assert.ok(viewport.rows.some(({ titleHeight }) => titleHeight > 20),
      'long English or Thai schedule title wraps at 320px');
  }
  await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await client.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
  const zoom = await evaluate(client, `({ scale: visualViewport.scale, scrollWidth: document.documentElement.scrollWidth, width: innerWidth })`);
  assert.ok(zoom.scale >= 1.9, 'browser is at actual 200% page zoom');
  assert.ok(zoom.scrollWidth <= zoom.width, 'the Rooms page has no horizontal overflow at 200% zoom');
  await client.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

  await client.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const reducedMotion = await evaluate(client, `(() => [...document.querySelectorAll('.upcoming-schedule__voters')].map((region) => {
    const track = region.querySelector('.vote-card__names-track');
    return { animation: getComputedStyle(track).animationName,
      display: getComputedStyle(track).display, whiteSpace: getComputedStyle(track).whiteSpace,
      copyCount: track.querySelectorAll('.vote-card__names-copy').length,
      height: region.getBoundingClientRect().height,
      text: region.innerText };
  }))()`);
  assert.ok(reducedMotion.every(({ animation, display, whiteSpace, copyCount, height, text }) => (
    animation === 'none' && display === 'block' && whiteSpace === 'normal' && copyCount === 1 && height > 0 && text.length > 0
  )), 'reduced motion shows one static readable voter copy');
  await client.send('Emulation.setEmulatedMedia', { features: [] });

  await evaluate(client, `(() => {
    const edit = document.querySelector('.room-card[data-room-id="${timedRoom.id}"] .room-card__edit');
    edit.click();
    const form = document.querySelector('#room-edit-form');
    form.elements.time.value = '07:30';
    form.requestSubmit();
  })()`);
  assert.equal(await waitFor(client, `document.querySelector('.upcoming-schedule__row[href*="${timedRoom.id}"] .upcoming-schedule__time')?.textContent === '07:30'`), true,
    'editing room metadata triggers the normal authoritative refresh and updates schedule time');
  await evaluate(client, `(() => {
    const edit = document.querySelector('.room-card[data-room-id="${timedRoom.id}"] .room-card__edit');
    edit.click();
    const form = document.querySelector('#room-edit-form');
    form.elements.time.value = '';
    form.requestSubmit();
  })()`);
  assert.equal(await waitFor(client, `!document.querySelector('.upcoming-schedule__row[href*="${timedRoom.id}"] .upcoming-schedule__time')`), true,
    'clearing the optional room time removes the time line instead of showing a placeholder');

  await evaluate(client, `document.querySelector('.upcoming-schedule__row[href*="2027-01-01"]').focus()`);
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, modifiers: 8 });
  const row = await evaluate(client, `(() => {
    const target = document.querySelector('.upcoming-schedule__row[href*="2027-01-01"]');
    return { href: target.getAttribute('href'), outline: getComputedStyle(target).outlineStyle,
      keyboardFocus: target.matches(':focus-visible'), rowName: target.getAttribute('aria-label') };
  })()`);
  assert.equal(row.href, `/vote/${untimedRoom.id}?date=2027-01-01`);
  assert.equal(row.keyboardFocus, true);
  assert.match(row.outline, /solid/);
  assert.match(row.rowName, /1 January 2027/);
  assert.ok(row.rowName.includes(`Room ${String(untimedRoom.displayNumber).padStart(2, '0')}`));
  const voteCountBeforeNavigation = server.database.prepare('SELECT COUNT(*) AS count FROM votes').get().count;
  await evaluate(client, `document.querySelector('.upcoming-schedule__row[href*="2027-01-01"]').click()`);
  assert.equal(await waitFor(client, `location.pathname === '/vote/${untimedRoom.id}' && Boolean(document.querySelector('#protected-content') && !document.querySelector('#protected-content').hidden && document.activeElement?.dataset?.date === '2027-01-01')`), true,
    'the whole row navigates to the permanent room ID and exact scheduled date without changing a vote');
  assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM votes').get().count, voteCountBeforeNavigation);
  assert.equal(await evaluate(client, `document.querySelector('#room-heading')?.textContent`), untimedRoom.title,
    'the vote page keeps its room identity alongside the shared brand');
  assert.equal(await evaluate(client, `document.querySelectorAll('h1').length`), 1);
  assert.equal(await evaluate(client, `Boolean(document.querySelector('#back-to-rooms') && document.querySelector('#vote-profile-menu'))`), true);
  assert.deepEqual(runtimeExceptions, [], 'the browser reports no uncaught JavaScript exceptions');
});
