import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_ROOM_COLOR, DEFAULT_ROOM_ICON, LEGACY_ROOM_ID } from '../src/room-contract.js';
import { addVote } from '../src/domain.js';
import { listRooms } from '../src/room-storage.js';
import { migrate, openDatabase } from '../src/database.js';
import { createServer } from '../src/server.js';

const ENV = { ADMIN_NAME: 'Issue 43 Admin', ADMIN_PIN: '4826', PIN_PEPPER: 'synthetic-pepper' };
const NOW = new Date('2026-10-27T04:00:00.000Z');

async function withServer(callback) {
  const directory = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'run-together-issue-43-'));
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

function cookieFrom(response) {
  return response.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
}

async function register(baseUrl, name) {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { origin: baseUrl, 'content-type': 'application/json' },
    body: JSON.stringify({ name, pin: '0042', pinConfirmation: '0042' }),
  });
  const cookie = cookieFrom(response);
  const session = await fetch(`${baseUrl}/api/session`, { headers: { cookie } }).then((result) => result.json());
  return { response, cookie, csrfToken: session.csrfToken };
}

function apiHeaders(baseUrl, user) {
  return { origin: baseUrl, cookie: user.cookie, 'x-csrf-token': user.csrfToken, 'content-type': 'application/json' };
}

async function createRoom(baseUrl, user, payload) {
  const response = await fetch(`${baseUrl}/api/rooms`, {
    method: 'POST', headers: apiHeaders(baseUrl, user), body: JSON.stringify(payload),
  });
  return { response, body: await response.json() };
}

async function updateRoom(baseUrl, user, roomId, payload) {
  const response = await fetch(`${baseUrl}/api/rooms/${roomId}`, {
    method: 'PUT', headers: apiHeaders(baseUrl, user), body: JSON.stringify(payload),
  });
  return { response, body: await response.json() };
}

test('Issue 43 migration adds optional room venue and time without replacing existing records', async () => {
  const directory = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'run-together-issue-43-migration-'));
  const database = openDatabase(join(directory, 'pre-migration.sqlite'));
  try {
    migrate(database, { throughVersion: 7 });
    const admin = database.prepare("INSERT INTO users (name,name_key,pin_salt,pin_hash,role,created_at,updated_at) VALUES ('Migration Admin','migration admin',x'01',x'02','admin','2026-10-01','2026-10-01')").run();
    const userId = Number(admin.lastInsertRowid);
    const roomId = randomUUID();
    database.prepare(`INSERT INTO rooms (id, display_number, title, color, icon, owner_user_id, created_at)
      VALUES (?, 2, 'Existing room', '#1D4ED8', 'running', ?, '2026-10-01')`).run(roomId, userId);
    database.prepare('INSERT INTO room_memberships (room_id, user_id, joined_at) VALUES (?, ?, ?)')
      .run(roomId, userId, '2026-10-01');
    addVote(database, { roomId, userId, voteDate: '2026-10-28' });
    const before = {
      room: database.prepare('SELECT id, display_number, title, color, icon, owner_user_id, created_at FROM rooms WHERE id = ?').get(roomId),
      votes: database.prepare('SELECT id, room_id, user_id, vote_date, created_at FROM votes WHERE room_id = ?').all(roomId),
      memberships: database.prepare('SELECT room_id, user_id, joined_at FROM room_memberships WHERE room_id = ?').all(roomId),
      events: database.prepare('SELECT * FROM run_events WHERE room_id = ?').all(roomId),
    };

    migrate(database, { throughVersion: 8 });

    assert.deepEqual(database.prepare('SELECT id, display_number, title, color, icon, owner_user_id, created_at FROM rooms WHERE id = ?').get(roomId), before.room);
    assert.deepEqual(database.prepare('SELECT id, room_id, user_id, vote_date, created_at FROM votes WHERE room_id = ?').all(roomId), before.votes);
    assert.deepEqual(database.prepare('SELECT room_id, user_id, joined_at FROM room_memberships WHERE room_id = ?').all(roomId), before.memberships);
    assert.deepEqual(database.prepare('SELECT * FROM run_events WHERE room_id = ?').all(roomId), before.events);
    assert.deepEqual(database.prepare('SELECT venue, time FROM rooms WHERE id = ?').get(roomId), { venue: '', time: '' });
    assert.equal(database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 8);
    assert.notEqual(roomId, LEGACY_ROOM_ID);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Issue 43 icon migration expands an existing legacy room constraint without breaking room references', async () => {
  const directory = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'run-together-issue-43-icons-'));
  const database = openDatabase(join(directory, 'legacy-icons.sqlite'));
  let stage = 'prepare the historical schema';
  try {
    migrate(database, { throughVersion: 8 });
    const userId = Number(database.prepare(`
      INSERT INTO users (name, name_key, pin_salt, pin_hash, role, created_at, updated_at)
      VALUES ('Legacy Icon Owner', 'legacy icon owner', x'01', x'02', 'user', ?, ?)
    `).run(NOW.toISOString(), NOW.toISOString()).lastInsertRowid);
    const additionalRoom = { id: randomUUID() };
    database.prepare('INSERT INTO room_identity_ledger (room_id, allocated_at) VALUES (?, ?)')
      .run(additionalRoom.id, NOW.toISOString());
    database.prepare(`
      INSERT INTO rooms (id, display_number, title, color, icon, owner_user_id, created_at, venue, time)
      VALUES (?, 2, 'Existing icon room', ?, ?, ?, ?, 'Riverside', '07:30')
    `).run(additionalRoom.id, DEFAULT_ROOM_COLOR, DEFAULT_ROOM_ICON, userId, NOW.toISOString());
    database.prepare('INSERT INTO room_memberships (room_id, user_id, joined_at) VALUES (?, ?, ?)')
      .run(additionalRoom.id, userId, NOW.toISOString());
    database.prepare('UPDATE room_display_counter SET next_display_number = 3 WHERE singleton = 1').run();
    addVote(database, { roomId: LEGACY_ROOM_ID, userId, voteDate: '2026-10-28', now: () => NOW });
    addVote(database, { roomId: additionalRoom.id, userId, voteDate: '2026-10-29', now: () => NOW });
    database.prepare(`
      INSERT INTO run_events
        (room_id, event_date, status, revision, proposed_by, proposed_by_name, proposed_at,
          scheduled_by, scheduled_by_name, scheduled_at)
      VALUES (?, '2026-10-28', 'proposed', 1, ?, 'Legacy Icon Owner', ?, NULL, NULL, NULL)
    `).run(additionalRoom.id, userId, NOW.toISOString());
    database.prepare(`
      INSERT INTO run_event_requests
        (room_id, request_id, actor_user_id, action, event_date, event_id, expected_revision,
          requested_status, created_at)
      VALUES (?, ?, ?, 'propose', '2026-10-28', 1, 1, 'proposed', ?)
    `).run(additionalRoom.id, randomUUID(), userId, NOW.toISOString());
    const legacyRoom = database.prepare('SELECT * FROM rooms WHERE id = ?').get(LEGACY_ROOM_ID);
    const before = {
      rooms: database.prepare(`
        SELECT id, display_number, title, color, icon, owner_user_id, created_at, venue, time
        FROM rooms ORDER BY id
      `).all(),
      memberships: database.prepare('SELECT * FROM room_memberships ORDER BY room_id, user_id').all(),
      votes: database.prepare('SELECT * FROM votes ORDER BY room_id, user_id, vote_date').all(),
      events: database.prepare('SELECT * FROM run_events ORDER BY room_id, event_date').all(),
      requests: database.prepare('SELECT * FROM run_event_requests ORDER BY room_id, request_id').all(),
    };
    database.pragma('foreign_keys = OFF');
    stage = 'rebuild the old icon whitelist';
    database.exec(`
      BEGIN IMMEDIATE;
      DROP TRIGGER join_new_users_to_legacy_room;
      CREATE TABLE rooms_legacy_icons (
        id TEXT PRIMARY KEY,
        display_number INTEGER NOT NULL CHECK (display_number BETWEEN 1 AND 99),
        title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 30),
        color TEXT NOT NULL CHECK (color IN ('#1D4ED8','#047857','#B45309','#7E22CE','#BE123C','#0F766E','#4338CA','#4D7C0F')),
        icon TEXT NOT NULL CHECK (icon IN ('running','football','basketball','tennis','volleyball','badminton','cycling','swimming','hiking')),
        owner_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL,
        venue TEXT NOT NULL DEFAULT '' CHECK (length(trim(venue)) <= 30),
        time TEXT NOT NULL DEFAULT '' CHECK (time = '' OR (time GLOB '[0-2][0-9]:[0-5][0-9]' AND CAST(substr(time, 1, 2) AS INTEGER) BETWEEN 0 AND 23))
      );
      INSERT INTO rooms_legacy_icons SELECT * FROM rooms;
      DROP TABLE rooms;
      ALTER TABLE rooms_legacy_icons RENAME TO rooms;
      CREATE TRIGGER join_new_users_to_legacy_room
      AFTER INSERT ON users
      BEGIN
        UPDATE rooms SET owner_user_id = NEW.id
        WHERE id = '${LEGACY_ROOM_ID}' AND owner_user_id IS NULL AND NEW.role = 'admin';
        INSERT OR IGNORE INTO room_memberships (room_id, user_id, joined_at)
        SELECT id, NEW.id, NEW.created_at FROM rooms;
      END;
      COMMIT;
    `);
    database.pragma('foreign_keys = ON');

    stage = 'apply current migrations';
    migrate(database);

    stage = 'verify preserved room and foreign-key references';
    assert.deepEqual(database.prepare(`
      SELECT id, display_number, title, color, icon, owner_user_id, created_at, venue, time
      FROM rooms ORDER BY id
    `).all(), before.rooms);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM rooms WHERE creator_user_id IS NOT NULL').get().count, 0,
      'migration does not infer original creator from current room ownership');
    assert.deepEqual(database.prepare('SELECT * FROM room_memberships ORDER BY room_id, user_id').all(), before.memberships);
    assert.deepEqual(database.prepare('SELECT * FROM votes ORDER BY room_id, user_id, vote_date').all(), before.votes);
    assert.deepEqual(database.prepare('SELECT * FROM run_events ORDER BY room_id, event_date').all(), before.events);
    assert.deepEqual(database.prepare('SELECT * FROM run_event_requests ORDER BY room_id, request_id').all(), before.requests);
    assert.deepEqual(database.pragma('foreign_key_check'), []);
    stage = 'write a newly supported icon';
    assert.doesNotThrow(() => database.prepare('UPDATE rooms SET icon = ? WHERE id = ?').run('shopping', additionalRoom.id));
    assert.equal(legacyRoom.icon, 'running');
  } catch (error) {
    throw new Error(`Failed to ${stage}: ${error.message}`, { cause: error });
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Issue 43 venue and time persist independently, validate server-side, and retain owner-only edit rights', async () => {
  await withServer(async (baseUrl) => {
    const owner = await register(baseUrl, 'Issue 43 Metadata Owner');
    const member = await register(baseUrl, 'Issue 43 Metadata Member');
    const appAdmin = await (async () => {
      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST', headers: { origin: baseUrl, 'content-type': 'application/json' },
        body: JSON.stringify({ name: ENV.ADMIN_NAME, pin: ENV.ADMIN_PIN }),
      });
      const cookie = cookieFrom(response);
      const session = await fetch(`${baseUrl}/api/session`, { headers: { cookie } }).then((result) => result.json());
      return { response, cookie, csrfToken: session.csrfToken };
    })();
    assert.equal(owner.response.status, 201);
    assert.equal(member.response.status, 201);
    assert.equal(appAdmin.response.status, 200);

    const created = await createRoom(baseUrl, owner, { title: 'Track <b>Room</b>', venue: '  Riverside track  ', time: '07:05', icon: 'running' });
    assert.equal(created.response.status, 201);
    const room = created.body.room;
    assert.equal(room.venue, 'Riverside track');
    assert.equal(room.time, '07:05');
    assert.equal(room.title, 'Track <b>Room</b>');

    const memberEdit = await updateRoom(baseUrl, member, room.id, { venue: 'Not allowed' });
    assert.equal(memberEdit.response.status, 403);
    const adminEdit = await updateRoom(baseUrl, appAdmin, room.id, { time: '08:30' });
    assert.equal(adminEdit.response.status, 403, 'application-admin status alone does not grant metadata edit rights');

    for (const payload of [{ venue: 'x'.repeat(31) }, { time: '24:00' }, { time: '7:05' }, { time: '12:60' }, { venue: 5 }, { venue: null }]) {
      const invalid = await updateRoom(baseUrl, owner, room.id, payload);
      assert.equal(invalid.response.status, 400, JSON.stringify(payload));
    }
    const thirtyCodePoints = await updateRoom(baseUrl, owner, room.id, { venue: '🏃'.repeat(30) });
    assert.equal(thirtyCodePoints.response.status, 200);
    assert.equal(thirtyCodePoints.body.room.venue, '🏃'.repeat(30));

    const clearedVenue = await updateRoom(baseUrl, owner, room.id, { venue: '   ' });
    assert.equal(clearedVenue.response.status, 200);
    assert.equal(clearedVenue.body.room.venue, '');
    assert.equal(clearedVenue.body.room.time, '07:05');
    const clearedTime = await updateRoom(baseUrl, owner, room.id, { time: '' });
    assert.equal(clearedTime.response.status, 200);
    assert.equal(clearedTime.body.room.time, '');
    assert.equal(clearedTime.body.room.color, room.color);
    assert.equal(clearedTime.body.room.icon, room.icon);

    const persisted = await fetch(`${baseUrl}/api/rooms/${room.id}`, { headers: { cookie: owner.cookie } }).then((response) => response.json());
    assert.equal(persisted.room.venue, '');
    assert.equal(persisted.room.time, '');
  });
});

test('Issue 43 room list computes a viewer-specific My voted flag and distinct upcoming voter count', async () => {
  await withServer(async (baseUrl, server) => {
    const owner = await register(baseUrl, 'Issue 43 Vote Owner');
    const voter = await register(baseUrl, 'Issue 43 Voter');
    const memberOnly = await register(baseUrl, 'Issue 43 Member Only');
    const { response, body } = await createRoom(baseUrl, owner, { title: 'Votes' });
    assert.equal(response.status, 201);
    const roomId = body.room.id;
    const joined = await fetch(`${baseUrl}/api/rooms/${roomId}/enter`, {
      method: 'POST', headers: apiHeaders(baseUrl, voter), body: '{}',
    });
    assert.equal(joined.status, 200);
    const ids = Object.fromEntries(server.database.prepare('SELECT id, name FROM users').all().map(({ id, name }) => [name, id]));
    addVote(server.database, { roomId, userId: ids['Issue 43 Vote Owner'], voteDate: '2026-10-27' });
    addVote(server.database, { roomId, userId: ids['Issue 43 Vote Owner'], voteDate: '2026-10-28' });
    addVote(server.database, { roomId, userId: ids['Issue 43 Voter'], voteDate: '2026-10-29' });
    addVote(server.database, { roomId, userId: ids['Issue 43 Voter'], voteDate: '2026-10-26' });
    addVote(server.database, { roomId, userId: ids['Issue 43 Member Only'], voteDate: '2026-10-26' });

    const ownerRooms = await fetch(`${baseUrl}/api/rooms`, { headers: { cookie: owner.cookie } }).then((response) => response.json());
    const voterRooms = await fetch(`${baseUrl}/api/rooms`, { headers: { cookie: voter.cookie } }).then((response) => response.json());
    const memberRooms = await fetch(`${baseUrl}/api/rooms`, { headers: { cookie: memberOnly.cookie } }).then((response) => response.json());
    const unauthenticatedSummary = listRooms(server.database).find(({ id }) => id === roomId);
    assert.equal(ownerRooms.rooms.find(({ id }) => id === roomId).ownerDisplayName, 'Issue 43 Vote Owner');
    assert.equal(ownerRooms.rooms.find(({ id }) => id === roomId).voterCount, 2);
    assert.equal(ownerRooms.rooms.find(({ id }) => id === roomId).myVoted, true);
    assert.equal(voterRooms.rooms.find(({ id }) => id === roomId).myVoted, true);
    assert.equal(memberRooms.rooms.find(({ id }) => id === roomId).myVoted, false);
    assert.equal(Object.hasOwn(unauthenticatedSummary, 'myVoted'), false, 'shared summary rows carry no viewer-personal flag');

    const unvote = await fetch(`${baseUrl}/api/rooms/${roomId}/votes/2026-10-29`, {
      method: 'PUT', headers: apiHeaders(baseUrl, voter), body: JSON.stringify({ selected: false }),
    });
    assert.equal(unvote.status, 200);
    const afterLastVote = await fetch(`${baseUrl}/api/rooms`, { headers: { cookie: voter.cookie } }).then((response) => response.json());
    assert.equal(afterLastVote.rooms.find(({ id }) => id === roomId).voterCount, 1);
    assert.equal(afterLastVote.rooms.find(({ id }) => id === roomId).myVoted, false);
  });
});
