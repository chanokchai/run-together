import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { addVote } from '../src/domain.js';
import { migrate, openDatabase } from '../src/database.js';
import { getPersonalUpcomingSchedule, createRoom, addRoomMember, updateRoomMetadata } from '../src/room-storage.js';
import { createServer } from '../src/server.js';
import { formatBangkokRoomTime } from '../src/date-time.js';
import { roomTimeFromSegments } from '../src/room-list.js';

const NOW = new Date('2026-11-01T17:30:00.000Z');
const ENV = { ADMIN_NAME: 'Issue 47 Admin', ADMIN_PIN: '4826', PIN_PEPPER: 'synthetic-pepper' };

function insertUser(database, name) {
  return Number(database.prepare(`
    INSERT INTO users (name, name_key, pin_salt, pin_hash, role, created_at, updated_at)
    VALUES (?, ?, x'01', x'02', 'user', ?, ?)
  `).run(name, name.toLowerCase(), NOW.toISOString(), NOW.toISOString()).lastInsertRowid);
}

function insertEvent(database, { roomId, date, status, actorId }) {
  const scheduled = status === 'scheduled';
  database.prepare(`
    INSERT INTO run_events
      (room_id, event_date, status, revision, proposed_by, proposed_by_name, proposed_at,
       scheduled_by, scheduled_by_name, scheduled_at)
    VALUES (?, ?, ?, 1, ?, 'Issue 47 actor', ?, ?, ?, ?)
  `).run(roomId, date, status, actorId, NOW.toISOString(),
    scheduled ? actorId : null, scheduled ? 'Issue 47 scheduler' : null,
    scheduled ? NOW.toISOString() : null);
}

async function withDatabase(callback) {
  const directory = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'run-together-issue-47-'));
  const database = openDatabase(join(directory, 'fixture.sqlite'));
  try {
    migrate(database);
    await callback(database);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function register(baseUrl, name) {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { origin: baseUrl, 'content-type': 'application/json' },
    body: JSON.stringify({ name, pin: '0042', pinConfirmation: '0042' }),
  });
  assert.equal(response.status, 201);
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
  const session = await fetch(`${baseUrl}/api/session`, { headers: { cookie } }).then((result) => result.json());
  return { cookie, csrfToken: session.csrfToken };
}

test('Issue 47 Bangkok display and segmented time values preserve hour boundaries', () => {
  assert.equal(formatBangkokRoomTime('18:40'), '6:40PM');
  assert.equal(formatBangkokRoomTime('00:00'), '12:00AM');
  assert.equal(formatBangkokRoomTime('12:00'), '12:00PM');
  assert.equal(formatBangkokRoomTime('23:59'), '11:59PM');
  assert.equal(formatBangkokRoomTime('24:00'), '');
  assert.equal(roomTimeFromSegments('12', '00', 'AM'), '00:00');
  assert.equal(roomTimeFromSegments('12', '00', 'PM'), '12:00');
  assert.equal(roomTimeFromSegments('6', '40', 'PM'), '18:40');
  assert.equal(roomTimeFromSegments('', '', ''), '');
  assert.equal(roomTimeFromSegments('6', '', 'PM'), null, 'partial selections require completion or Clear');
});

test('Issue 47 personal schedule qualifies rooms by any present/future vote and lists exact-date voters', async () => {
  await withDatabase(async (database) => {
    const viewerId = insertUser(database, 'Issue 47 Viewer');
    const otherId = insertUser(database, 'Issue 47 Other');
    const qualify = createRoom(database, { creatorUserId: viewerId, title: 'Qualifying room' });
    const historical = createRoom(database, { creatorUserId: viewerId, title: 'Historical only' });
    const membershipOnly = createRoom(database, { creatorUserId: otherId, title: 'Membership only' });
    const proposedOnly = createRoom(database, { creatorUserId: viewerId, title: 'Proposed only' });
    const unrelated = createRoom(database, { creatorUserId: otherId, title: 'Unrelated room' });
    addRoomMember(database, { roomId: membershipOnly.id, userId: viewerId, now: () => NOW });

    addVote(database, { roomId: qualify.id, userId: viewerId, voteDate: '2026-11-02', createdAt: NOW.toISOString() });
    addVote(database, { roomId: qualify.id, userId: otherId, voteDate: '2026-11-02', createdAt: NOW.toISOString() });
    addVote(database, { roomId: qualify.id, userId: otherId, voteDate: '2026-11-04', createdAt: NOW.toISOString() });
    addVote(database, { roomId: historical.id, userId: viewerId, voteDate: '2026-10-31', createdAt: NOW.toISOString() });
    addVote(database, { roomId: proposedOnly.id, userId: viewerId, voteDate: '2026-11-02', createdAt: NOW.toISOString() });
    addVote(database, { roomId: unrelated.id, userId: otherId, voteDate: '2026-11-02', createdAt: NOW.toISOString() });

    insertEvent(database, { roomId: qualify.id, date: '2026-11-01', status: 'scheduled', actorId: otherId });
    insertEvent(database, { roomId: qualify.id, date: '2026-11-02', status: 'scheduled', actorId: otherId });
    insertEvent(database, { roomId: qualify.id, date: '2026-11-04', status: 'scheduled', actorId: otherId });
    insertEvent(database, { roomId: qualify.id, date: '2026-11-06', status: 'scheduled', actorId: otherId });
    insertEvent(database, { roomId: historical.id, date: '2026-11-02', status: 'scheduled', actorId: otherId });
    insertEvent(database, { roomId: membershipOnly.id, date: '2026-11-02', status: 'scheduled', actorId: otherId });
    insertEvent(database, { roomId: proposedOnly.id, date: '2026-11-02', status: 'proposed', actorId: viewerId });
    insertEvent(database, { roomId: unrelated.id, date: '2026-11-02', status: 'scheduled', actorId: otherId });

    const rows = getPersonalUpcomingSchedule(database, { currentUserId: viewerId, now: () => NOW });
    assert.deepEqual(rows.map(({ roomId, date }) => [roomId, date]), [
      [qualify.id, '2026-11-02'],
      [qualify.id, '2026-11-04'],
      [qualify.id, '2026-11-06'],
    ], 'Bangkok today qualifies the room; every upcoming scheduled date appears once, including unvoted dates');
    assert.deepEqual(rows[0].voters, [
      { name: 'Issue 47 Other', isCurrentUser: false },
      { name: 'Issue 47 Viewer', isCurrentUser: true },
    ], 'voter identity is stable and self highlighting is computed for this authenticated viewer');
    assert.deepEqual(rows[1].voters, [
      { name: 'Issue 47 Other', isCurrentUser: false },
    ], 'each event includes only its own date voters and does not add the viewer');
    assert.deepEqual(rows[2].voters, [], 'a scheduled date with no voters remains visible without a fake name');
    assert.deepEqual(getPersonalUpcomingSchedule(database, { currentUserId: 0, now: () => NOW }), []);
    assert.deepEqual(getPersonalUpcomingSchedule(database, { currentUserId: otherId, now: () => NOW })
      .map(({ roomId, date }) => [roomId, date]), [
      [qualify.id, '2026-11-02'],
      [unrelated.id, '2026-11-02'],
      [qualify.id, '2026-11-04'],
      [qualify.id, '2026-11-06'],
    ], 'eligibility is recalculated for the requested user, not reused from another viewer');
    assert.deepEqual(getPersonalUpcomingSchedule(database, {
      currentUserId: viewerId, now: () => new Date('2026-11-02T17:00:00.000Z'),
    }).filter(({ roomId }) => roomId === qualify.id), [], 'a room stops qualifying when its last vote becomes historical in Bangkok');

    const membershipRestricted = createRoom(database, { creatorUserId: otherId, title: 'Membership restricted' });
    addVote(database, { roomId: membershipRestricted.id, userId: viewerId, voteDate: '2026-11-02', createdAt: NOW.toISOString() });
    addVote(database, { roomId: membershipRestricted.id, userId: otherId, voteDate: '2026-11-04', createdAt: NOW.toISOString() });
    insertEvent(database, { roomId: membershipRestricted.id, date: '2026-11-04', status: 'scheduled', actorId: otherId });
    const restrictedRow = getPersonalUpcomingSchedule(database, { currentUserId: viewerId, now: () => NOW })
      .find(({ roomId }) => roomId === membershipRestricted.id);
    assert.deepEqual(restrictedRow.voters, [], 'a vote without existing room visibility does not expose another member’s name');
  });
});

test('Issue 47 vote header, Back/account controls, and room-create time picker are accessible', async (t) => {
  const directory = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'run-together-issue-47-page-'));
  const server = createServer({ databasePath: join(directory, 'page.sqlite'), env: ENV, now: () => NOW });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.database.close();
    await rm(directory, { recursive: true, force: true });
  });

  const viewer = await register(baseUrl, 'Issue 47 Page Viewer');
  const viewerId = server.database.prepare('SELECT id FROM users WHERE name = ?').get('Issue 47 Page Viewer').id;
  const room = createRoom(server.database, {
    creatorUserId: viewerId, title: '<script>alert(1)</script>', venue: '', time: '', now: () => NOW,
  });
  const roomUrl = `${baseUrl}/vote/${encodeURIComponent(room.id)}`;
  let page = await fetch(roomUrl, { headers: { cookie: viewer.cookie } }).then((response) => response.text());
  assert.match(page, /id="room-information"/, 'the vote page has a single logical room-information block');
  assert.match(page, /<span id="room-number">Room 02 : <\/span><span id="room-heading">&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/span>/,
    'room display number and title are included safely in the heading');
  assert.doesNotMatch(page, /room-venue-line|room-time-line|Venue \/ สถานที่:|Time \/ เวลา:/,
    'missing metadata produces no labels or empty detail lines');
  assert.match(page, /id="back-to-rooms"[^>]*aria-label="[^"]*Back[^"]*"/, 'Back is included in the accessible name');
  assert.match(page, />Back<\/span>/, 'Back text appears before the existing exit icon');
  assert.doesNotMatch(page, /id="change-pin"|id="logout"/, 'account controls are absent from the vote page');

  updateRoomMetadata(server.database, { roomId: room.id, venue: 'Riverside', time: '18:40' });
  page = await fetch(roomUrl, { headers: { cookie: viewer.cookie } }).then((response) => response.text());
  assert.match(page, /at Riverside on 6:40PM/, 'venue and time use the compact 12-hour Bangkok display');

  const roomsPage = await fetch(`${baseUrl}/rooms`, { headers: { cookie: viewer.cookie } }).then((response) => response.text());
  assert.match(roomsPage, /id="rooms-change-pin"/, 'Change PIN remains available on the room page');
  assert.match(roomsPage, /id="rooms-logout"/, 'Logout remains available on the room page');
  assert.match(roomsPage, /id="create-room-time-hour"/, 'Create room has a non-typing hour picker');
  assert.match(roomsPage, /id="create-room-time-minute"/, 'Create room has a non-typing minute picker');
  assert.match(roomsPage, /id="create-room-time-period"/, 'Create room has a non-typing AM/PM picker');
  assert.match(roomsPage, /id="create-room-time-clear"/, 'the optional time selection has an explicit clear action');
  assert.doesNotMatch(roomsPage, /id="create-room-time" name="time" type="text"/,
    'the Create room time is not a free-text input');
});
