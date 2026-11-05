import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { addVote } from '../src/domain.js';
import { migrate, openDatabase } from '../src/database.js';
import { createRoom } from '../src/room-storage.js';
import { createServer } from '../src/server.js';

const ENV = { ADMIN_NAME: 'Issue 46 Admin', ADMIN_PIN: '4826', PIN_PEPPER: 'synthetic-pepper' };
const NOW = new Date('2026-11-01T00:00:00.000Z');

function insertUser(database, name, role = 'user') {
  const now = '2026-11-01T00:00:00.000Z';
  return Number(database.prepare(`
    INSERT INTO users (name, name_key, pin_salt, pin_hash, role, created_at, updated_at)
    VALUES (?, ?, x'01', x'02', ?, ?, ?)
  `).run(name, name.toLowerCase(), role, now, now).lastInsertRowid);
}

test('Issue 46 migration preserves old room data without guessing creators and records new creator provenance', async () => {
  const directory = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'run-together-issue-46-migration-'));
  const database = openDatabase(join(directory, 'pre-migration.sqlite'));
  try {
    migrate(database, { throughVersion: 9 });
    const creatorId = insertUser(database, 'Original creator');
    const inheritedOwnerId = insertUser(database, 'Inherited owner');
    const roomId = randomUUID();
    database.prepare(`
      INSERT INTO rooms (id, display_number, title, color, icon, owner_user_id, created_at, venue, time)
      VALUES (?, 2, 'Existing owned room', '#1D4ED8', 'running', ?, '2026-10-01T00:00:00.000Z', 'Track', '07:30')
    `).run(roomId, inheritedOwnerId);
    database.prepare('INSERT INTO room_memberships (room_id, user_id, joined_at) VALUES (?, ?, ?)')
      .run(roomId, creatorId, '2026-10-01T00:00:00.000Z');
    addVote(database, { roomId, userId: creatorId, voteDate: '2026-11-03', now: () => new Date('2026-11-01T00:00:00.000Z') });
    database.prepare(`
      INSERT INTO run_events
        (room_id, event_date, status, revision, proposed_by, proposed_by_name, proposed_at,
          scheduled_by, scheduled_by_name, scheduled_at)
      VALUES (?, '2026-11-03', 'scheduled', 1, ?, 'Original creator', ?, ?, 'Inherited owner', ?)
    `).run(roomId, creatorId, '2026-11-01T00:00:00.000Z', inheritedOwnerId, '2026-11-01T00:00:00.000Z');
    const before = {
      room: database.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId),
      memberships: database.prepare('SELECT * FROM room_memberships WHERE room_id = ?').all(roomId),
      votes: database.prepare('SELECT * FROM votes WHERE room_id = ?').all(roomId),
      events: database.prepare('SELECT * FROM run_events WHERE room_id = ?').all(roomId),
    };

    migrate(database);

    assert.deepEqual(database.prepare(`
      SELECT id, display_number, title, color, icon, owner_user_id, created_at, venue, time
      FROM rooms WHERE id = ?
    `).get(roomId), before.room);
    assert.equal(database.prepare('SELECT creator_user_id FROM rooms WHERE id = ?').get(roomId).creator_user_id, null,
      'an existing owner or member must not be inferred as original creator');
    assert.deepEqual(database.prepare('SELECT * FROM room_memberships WHERE room_id = ?').all(roomId), before.memberships);
    assert.deepEqual(database.prepare('SELECT * FROM votes WHERE room_id = ?').all(roomId), before.votes);
    assert.deepEqual(database.prepare('SELECT * FROM run_events WHERE room_id = ?').all(roomId), before.events);

    const created = createRoom(database, { creatorUserId: creatorId, title: 'New provenance room' });
    const provenance = database.prepare('SELECT owner_user_id, creator_user_id FROM rooms WHERE id = ?').get(created.id);
    assert.deepEqual(provenance, { owner_user_id: creatorId, creator_user_id: creatorId });
    database.prepare('UPDATE rooms SET owner_user_id = ? WHERE id = ?').run(inheritedOwnerId, created.id);
    assert.deepEqual(database.prepare('SELECT owner_user_id, creator_user_id FROM rooms WHERE id = ?').get(created.id), {
      owner_user_id: inheritedOwnerId,
      creator_user_id: creatorId,
    }, 'later ownership changes must not rewrite creator provenance');
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Issue 46 room API scopes creator flags and exact scheduled-vote pairs to the signed-in viewer', async () => {
  const directory = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'run-together-issue-46-api-'));
  const server = createServer({ databasePath: join(directory, 'api.sqlite'), env: ENV, now: () => NOW });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    async function register(name) {
      const response = await fetch(`${baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { origin: baseUrl, 'content-type': 'application/json' },
        body: JSON.stringify({ name, pin: '0042', pinConfirmation: '0042' }),
      });
      return { response, cookie: response.headers.get('set-cookie')?.split(';', 1)[0] ?? '' };
    }
    const viewer = await register('Issue 46 Viewer');
    const other = await register('Issue 46 Other');
    const viewerId = server.database.prepare('SELECT id FROM users WHERE name = ?').get('Issue 46 Viewer').id;
    const otherId = server.database.prepare('SELECT id FROM users WHERE name = ?').get('Issue 46 Other').id;
    const viewerCreated = createRoom(server.database, { creatorUserId: viewerId, title: 'Viewer created' });
    const otherCreated = createRoom(server.database, { creatorUserId: otherId, title: 'Inherited ownership' });
    server.database.prepare('UPDATE rooms SET owner_user_id = ? WHERE id = ?').run(otherId, viewerCreated.id);
    server.database.prepare('UPDATE rooms SET owner_user_id = ? WHERE id = ?').run(viewerId, otherCreated.id);

    function scheduledVote(roomId, date, { status = 'scheduled', userId = viewerId } = {}) {
      addVote(server.database, { roomId, userId, voteDate: date, now: () => NOW });
      server.database.prepare(`
        INSERT INTO run_events
          (room_id, event_date, status, revision, proposed_by, proposed_by_name, proposed_at,
            scheduled_by, scheduled_by_name, scheduled_at)
        VALUES (?, ?, ?, 1, ?, 'Issue 46 actor', ?, ?, 'Issue 46 scheduler', ?)
      `).run(roomId, date, status, userId, NOW.toISOString(), status === 'scheduled' ? userId : null,
        status === 'scheduled' ? NOW.toISOString() : null);
    }
    scheduledVote(viewerCreated.id, '2026-11-02');
    scheduledVote(viewerCreated.id, '2026-11-04', { status: 'proposed' });
    scheduledVote(viewerCreated.id, '2026-11-05', { userId: otherId });
    scheduledVote(viewerCreated.id, '2026-10-31');
    scheduledVote(otherCreated.id, '2026-11-02');

    const viewerRooms = await fetch(`${baseUrl}/api/rooms`, { headers: { cookie: viewer.cookie } }).then((response) => response.json());
    const otherRooms = await fetch(`${baseUrl}/api/rooms`, { headers: { cookie: other.cookie } }).then((response) => response.json());
    const viewerRoomFlags = new Map(viewerRooms.rooms.map((room) => [room.id, room.myCreated]));
    const otherRoomFlags = new Map(otherRooms.rooms.map((room) => [room.id, room.myCreated]));
    assert.equal(viewerRoomFlags.get(viewerCreated.id), true);
    assert.equal(viewerRoomFlags.get(otherCreated.id), false, 'current ownership does not infer original creator');
    assert.equal(otherRoomFlags.get(viewerCreated.id), false);
    assert.equal(otherRoomFlags.get(otherCreated.id), true);
    assert.deepEqual(viewerRooms.upcomingSchedule.map(({ roomId, date }) => [roomId, date]), [
      [viewerCreated.id, '2026-11-02'],
      [otherCreated.id, '2026-11-02'],
    ], 'summary includes only scheduled dates with this viewer’s exact saved vote and stable room ties');
    assert.deepEqual(otherRooms.upcomingSchedule.map(({ roomId, date }) => [roomId, date]), [
      [viewerCreated.id, '2026-11-05'],
    ], 'the other viewer sees only the different exact room/date pair they voted for');
    assert.equal(Object.hasOwn(await fetch(`${baseUrl}/api/rooms`).then((response) => response.json()), 'upcomingSchedule'), false,
      'unauthenticated requests do not receive personal data');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Issue 46 scheduled-date room links validate a navigable target without changing room state', async () => {
  const directory = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'run-together-issue-46-deeplink-'));
  const server = createServer({ databasePath: join(directory, 'deeplink.sqlite'), env: ENV, now: () => NOW });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const login = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { origin: baseUrl, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Issue 46 Deep Link Member', pin: '0042', pinConfirmation: '0042' }),
    });
    const cookie = login.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
    const userId = server.database.prepare('SELECT id FROM users WHERE name = ?').get('Issue 46 Deep Link Member').id;
    const room = createRoom(server.database, { creatorUserId: userId, title: 'Deep Link Target' });
    const before = {
      votes: server.database.prepare('SELECT COUNT(*) AS count FROM votes WHERE room_id = ?').get(room.id).count,
      events: server.database.prepare('SELECT COUNT(*) AS count FROM run_events WHERE room_id = ?').get(room.id).count,
    };

    const response = await fetch(`${baseUrl}/vote/${room.id}?date=2026-11-04`, { headers: { cookie } });
    const page = await response.text();
    assert.equal(response.status, 200);
    assert.match(page, /const initialWeekMonday = '2026-11-02'/);
    assert.match(page, /const initialTargetDate = "2026-11-04"/);

    const malformed = await fetch(`${baseUrl}/vote/${room.id}?date=2026-02-30`, { headers: { cookie } }).then((result) => result.text());
    assert.match(malformed, /const initialTargetDate = null/);
    const tooFar = await fetch(`${baseUrl}/vote/${room.id}?date=2026-12-01`, { headers: { cookie } }).then((result) => result.text());
    assert.match(tooFar, /const initialTargetDate = null/);
    const missingRoom = await fetch(`${baseUrl}/vote/${randomUUID()}?date=2026-11-04`, { headers: { cookie } });
    assert.equal(missingRoom.status, 404, 'a stale room ID must never resolve to a different room');
    assert.deepEqual({
      votes: server.database.prepare('SELECT COUNT(*) AS count FROM votes WHERE room_id = ?').get(room.id).count,
      events: server.database.prepare('SELECT COUNT(*) AS count FROM run_events WHERE room_id = ?').get(room.id).count,
    }, before, 'opening a scheduled-date link does not write votes or events');
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
