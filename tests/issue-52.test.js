import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { addVote, proposeRunEvent, setRunEventStatus } from '../src/domain.js';
import { createServer } from '../src/server.js';
import { addRoomMember, createRoom } from '../src/room-storage.js';
import { formatScheduleDate } from '../src/room-list.js';

const ENV = { ADMIN_NAME: 'Issue 52 Admin', ADMIN_PIN: '4826', PIN_PEPPER: 'synthetic-pepper' };
const NOW = new Date('2026-12-30T00:00:00.000Z');

async function withServer(callback) {
  const directory = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'run-together-issue-52-'));
  const server = createServer({ databasePath: join(directory, 'test.sqlite'), env: ENV, now: () => NOW });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await callback(`http://127.0.0.1:${server.address().port}`, server);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function register(baseUrl, { name, pin = '0042' }) {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { origin: baseUrl, 'content-type': 'application/json' },
    body: JSON.stringify({ name, pin, pinConfirmation: pin }),
  });
  assert.equal(response.status, 201);
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
  return { cookie, user: await response.json() };
}

async function loginAdmin(baseUrl) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { origin: baseUrl, 'content-type': 'application/json' },
    body: JSON.stringify({ name: ENV.ADMIN_NAME, pin: ENV.ADMIN_PIN }),
  });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
}

function scheduleEvent(database, { roomId, userId, date }) {
  const proposal = proposeRunEvent(database, {
    roomId, userId, eventDate: date, requestId: randomUUID(), now: () => NOW,
  });
  return setRunEventStatus(database, {
    roomId,
    adminUserId: userId,
    eventDate: date,
    eventId: proposal.event.eventId,
    revision: proposal.event.revision,
    status: 'scheduled',
    requestId: randomUUID(),
    now: () => NOW,
  });
}

test('Issue 52 shared heading covers signed-out, member, room, PIN, and admin pages', async () => {
  await withServer(async (baseUrl, server) => {
    const viewer = await register(baseUrl, { name: 'Issue 52 Viewer' });
    const viewerId = server.database.prepare('SELECT id FROM users WHERE name = ?').get('Issue 52 Viewer').id;
    const room = createRoom(server.database, { creatorUserId: viewerId, title: 'Weekday running' });
    addRoomMember(server.database, { roomId: room.id, userId: viewerId, now: () => NOW });
    const adminCookie = await loginAdmin(baseUrl);
    const pages = [
      { path: '/', cookie: '', heading: null },
      { path: '/register', cookie: '', heading: 'Run Together' },
      { path: '/rooms', cookie: viewer.cookie, heading: null },
      { path: `/vote/${room.id}`, cookie: viewer.cookie, heading: 'Weekday running' },
      { path: '/change-pin', cookie: viewer.cookie, heading: 'Change PIN' },
      { path: '/admin', cookie: adminCookie, heading: 'Admin' },
    ];

    for (const { path, cookie, heading } of pages) {
      const response = await fetch(`${baseUrl}${path}`, { headers: cookie ? { cookie } : {} });
      assert.equal(response.status, 200, `${path} is available to the expected account`);
      const html = await response.text();
      assert.match(html, /VOTE&RUN!/, `${path} includes the shared brand`);
      assert.equal((html.match(/VOTE&RUN!/g) ?? []).length, 1, `${path} has one brand mark`);
      assert.equal((html.match(/<h1\b/g) ?? []).length, 1, `${path} retains a single primary heading`);
      if (path === '/rooms') {
        assert.match(html, /<h1 id="rooms-heading"[^>]*>VOTE&RUN!<\/h1>/,
          'the Rooms toolbar uses the brand as its primary heading');
        assert.doesNotMatch(html, /class="app-brand-header"/,
          'Rooms does not duplicate the brand in a second header');
        assert.match(html, /id="rooms-profile-menu"/);
      } else if (path === '/') {
        assert.match(html, /<h1 id="login-introduction" class="login-introduction">/,
          'the login introduction remains the page primary heading');
        assert.match(html, /Vote for the days you can run\./);
        assert.match(html, /See when others are free, then suggest a day to your group\./);
        assert.match(html, /This App make planning your next run easier\./);
        assert.doesNotMatch(html, /<h1>Run Together<\/h1>|<p>วิ่งไปด้วยกัน \/ Run together<\/p>/,
          'the legacy login heading and subtitle are removed');
      } else {
        assert.match(html, /class="app-brand-header(?:\s|")/,
          `${path} has the shared non-heading brand header`);
        assert.match(html, new RegExp(`<h1\\b[^>]*>[\\s\\S]*?${heading}[\\s\\S]*?<\\/h1>`),
          `${path} keeps its page-specific primary heading`);
      }
      if (path.startsWith('/vote/')) {
        assert.match(html, /id="room-number"/);
        assert.match(html, /id="vote-profile-menu"/);
        assert.match(html, /id="back-to-rooms"/);
      }
    }
  });
});

test('Issue 52 schedule dates expose separate short lines and full year text', () => {
  assert.equal(formatScheduleDate('2027-01-01').weekday, 'FRI');
  assert.equal(formatScheduleDate('2027-01-01').dayMonth, '1 JAN');
  assert.equal(formatScheduleDate('2027-01-01').fullDate, '1 January 2027');
  assert.equal(formatScheduleDate('2026-12-31').dayMonth, '31 DEC');
  assert.equal(formatScheduleDate('2027-02-30'), null);
});

test('Issue 52 upcoming schedule reads optional Bangkok room time by permanent room ID', async () => {
  await withServer(async (baseUrl, server) => {
    const viewer = await register(baseUrl, { name: 'Issue 52 Schedule Viewer' });
    const viewerId = server.database.prepare('SELECT id FROM users WHERE name = ?').get('Issue 52 Schedule Viewer').id;
    const timedRoom = createRoom(server.database, {
      creatorUserId: viewerId, title: 'Morning run', time: '06:05',
    });
    const untimedRoom = createRoom(server.database, {
      creatorUserId: viewerId, title: 'Easy run', time: '',
    });
    for (const room of [timedRoom, untimedRoom]) {
      addRoomMember(server.database, { roomId: room.id, userId: viewerId, now: () => NOW });
      addVote(server.database, { roomId: room.id, userId: viewerId, voteDate: '2027-01-01', now: () => NOW });
      scheduleEvent(server.database, { roomId: room.id, userId: viewerId, date: '2027-01-01' });
    }

    async function getSchedule() {
      const response = await fetch(`${baseUrl}/api/rooms`, { headers: { cookie: viewer.cookie } });
      assert.equal(response.status, 200);
      return (await response.json()).upcomingSchedule;
    }

    let schedule = await getSchedule();
    const timedItem = schedule.find(({ roomId }) => roomId === timedRoom.id);
    const untimedItem = schedule.find(({ roomId }) => roomId === untimedRoom.id);
    assert.equal(timedItem.time, '06:05');
    assert.equal(untimedItem.time, '');
    assert.equal(schedule.length, 2);

    const sessionResponse = await fetch(`${baseUrl}/api/session`, { headers: { cookie: viewer.cookie } });
    const { csrfToken } = await sessionResponse.json();
    const update = await fetch(`${baseUrl}/api/rooms/${encodeURIComponent(timedRoom.id)}`, {
      method: 'PUT',
      headers: { cookie: viewer.cookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ time: '07:30' }),
    });
    assert.equal(update.status, 200);
    schedule = await getSchedule();
    assert.equal(schedule.find(({ roomId }) => roomId === timedRoom.id).time, '07:30',
      'the normal authoritative rooms refresh includes the updated existing room time');
    assert.equal(schedule.find(({ roomId }) => roomId === untimedRoom.id).time, '',
      'a different room never inherits its neighbor time');
  });
});
