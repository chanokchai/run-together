import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { openDatabase, migrate, MIGRATIONS } from '../src/database.js';
import { initializeDatabase } from '../src/server.js';
import {
  addVote,
  createUser,
  getRunEventForDate,
  proposeRunEvent,
  setVote,
  withdrawRunEvent,
} from '../src/domain.js';
import { DEFAULT_ROOM_COLOR, DEFAULT_ROOM_ICON, ROOM_COLOR_PALETTE } from '../src/room-contract.js';
import { addRoomMember, createRoom } from '../src/room-storage.js';

function applyVersionFive(database) {
  database.exec(`CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const insert = database.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );
  for (const migration of MIGRATIONS.slice(0, 5)) {
    const apply = database.transaction(() => {
      for (const statement of migration.statements) database.exec(statement);
      insert.run(migration.version, migration.name, '2024-02-29T04:00:00.000Z');
    });
    apply();
  }
}

async function nextChildLine({ lines, stderr, exited }, description) {
  let timer;
  try {
    return await Promise.race([
      lines.next(),
      exited.then(([code, signal]) => {
        throw new Error(`${description} child exited ${code ?? signal}: ${stderr.join('')}`);
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${description} timed out: ${stderr.join('')}`)), 8000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('Issue 36 migrates a populated version-5 board into the permanent legacy room', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'run-together-issue-36-migration-'));
  const database = openDatabase(join(directory, 'fixture.sqlite'));
  try {
    applyVersionFive(database);
    const admin = database.prepare(`
      INSERT INTO users (name, name_key, pin_salt, pin_hash, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'admin', ?, ?)
    `).run(
      'Fixture Admin', 'fixture admin', Buffer.from([0, 1, 2]), Buffer.from([3, 4, 5]),
      '2024-02-29T04:00:00.000Z', '2024-02-29T04:00:00.000Z',
    );
    const member = database.prepare(`
      INSERT INTO users (name, name_key, pin_salt, pin_hash, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'user', ?, ?)
    `).run(
      'Fixture Member', 'fixture member', Buffer.from([6, 7]), Buffer.from([8, 9]),
      '2024-02-29T04:00:00.000Z', '2024-02-29T04:00:00.000Z',
    );
    const adminId = Number(admin.lastInsertRowid);
    const memberId = Number(member.lastInsertRowid);
    database.prepare(`
      INSERT INTO sessions (token_hash, user_id, csrf_secret, created_at, last_seen_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(Buffer.from([10, 11]), memberId, Buffer.from([12, 13]),
      '2024-02-29T04:00:00.000Z', '2024-02-29T04:01:00.000Z', '2024-03-01T04:00:00.000Z');
    database.prepare('INSERT INTO votes (id, user_id, vote_date, created_at) VALUES (?, ?, ?, ?)')
      .run(41, memberId, '2024-03-01', '2024-02-29T04:02:00.000Z');
    database.prepare(`
      INSERT INTO run_events (id, event_date, status, revision, proposed_by, proposed_at, scheduled_by, scheduled_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(73, '2024-03-01', 'scheduled', 4, memberId, '2024-02-29T04:03:00.000Z', adminId, '2024-02-29T04:04:00.000Z');
    database.prepare(`
      INSERT INTO run_event_requests
        (request_id, actor_user_id, action, event_date, event_id, expected_revision, requested_status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('00000000-0000-4000-8000-000000000036', adminId, 'schedule', '2024-03-01', 73, 3,
      'scheduled', '2024-02-29T04:04:00.000Z');

    migrate(database);

    const roomTables = database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table'
      AND name IN ('rooms', 'room_memberships', 'room_migration_ledger', 'room_identity_ledger') ORDER BY name
    `).all();
    assert.deepEqual(roomTables, [
      { name: 'room_identity_ledger' },
      { name: 'room_memberships' },
      { name: 'room_migration_ledger' },
      { name: 'rooms' },
    ]);
    const room = database.prepare('SELECT id, display_number, title, color, icon, owner_user_id FROM rooms').get();
    assert.deepEqual(room, {
      id: '00000000-0000-4000-8000-000000000036',
      display_number: 1,
      title: 'Run Together',
      color: DEFAULT_ROOM_COLOR,
      icon: DEFAULT_ROOM_ICON,
      owner_user_id: adminId,
    });
    assert.deepEqual(database.prepare('SELECT id, name, name_key, pin_salt, pin_hash, role FROM users ORDER BY id').all(), [
      {
        id: adminId,
        name: 'Fixture Admin',
        name_key: 'fixture admin',
        pin_salt: Buffer.from([0, 1, 2]),
        pin_hash: Buffer.from([3, 4, 5]),
        role: 'admin',
      },
      {
        id: memberId,
        name: 'Fixture Member',
        name_key: 'fixture member',
        pin_salt: Buffer.from([6, 7]),
        pin_hash: Buffer.from([8, 9]),
        role: 'user',
      },
    ]);
    assert.deepEqual(database.prepare('SELECT token_hash, user_id, csrf_secret, created_at, last_seen_at, expires_at FROM sessions').get(), {
      token_hash: Buffer.from([10, 11]),
      user_id: memberId,
      csrf_secret: Buffer.from([12, 13]),
      created_at: '2024-02-29T04:00:00.000Z',
      last_seen_at: '2024-02-29T04:01:00.000Z',
      expires_at: '2024-03-01T04:00:00.000Z',
    });
    assert.deepEqual(database.prepare('SELECT id, room_id, user_id, vote_date FROM votes').all(), [{
      id: 41, room_id: room.id, user_id: memberId, vote_date: '2024-03-01',
    }]);
    assert.deepEqual(database.prepare('SELECT id, room_id, event_date, status, revision, proposed_by, scheduled_by FROM run_events').all(), [{
      id: 73, room_id: room.id, event_date: '2024-03-01', status: 'scheduled', revision: 4,
      proposed_by: memberId, scheduled_by: adminId,
    }]);
    assert.deepEqual(database.prepare(`
      SELECT room_id, request_id, actor_user_id, action, event_date, event_id, expected_revision,
        requested_status, created_at FROM run_event_requests
    `).all(), [{
      room_id: room.id,
      request_id: '00000000-0000-4000-8000-000000000036',
      actor_user_id: adminId,
      action: 'schedule',
      event_date: '2024-03-01',
      event_id: 73,
      expected_revision: 3,
      requested_status: 'scheduled',
      created_at: '2024-02-29T04:04:00.000Z',
    }]);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM room_memberships').get().count, 2);
    assert.deepEqual(database.pragma('foreign_key_check'), []);
    assert.equal(database.pragma('integrity_check', { simple: true }), 'ok');
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('version-6 migration rolls back atomically when its ledger write fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'run-together-issue-36-rollback-'));
  const database = openDatabase(join(directory, 'fixture.sqlite'));
  try {
    applyVersionFive(database);
    const member = database.prepare(`
      INSERT INTO users (name, name_key, pin_salt, pin_hash, role, created_at, updated_at)
      VALUES ('Rollback Runner', 'rollback runner', X'01', X'02', 'user', '2024-02-29', '2024-02-29')
    `).run();
    database.prepare('INSERT INTO votes (user_id, vote_date, created_at) VALUES (?, ?, ?)')
      .run(Number(member.lastInsertRowid), '2024-03-01', '2024-02-29T04:00:00.000Z');
    database.exec(`
      CREATE TRIGGER reject_issue_36_migration
      BEFORE INSERT ON schema_migrations WHEN NEW.version = 6
      BEGIN SELECT RAISE(ABORT, 'forced issue 36 migration failure'); END;
    `);

    assert.throws(() => migrate(database), /forced issue 36 migration failure/);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'rooms'").get().count, 0);
    assert.equal(database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 5);
    assert.deepEqual(database.pragma('table_info(votes)').map(({ name }) => name), [
      'id', 'user_id', 'vote_date', 'created_at',
    ]);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM votes').get().count, 1);

    database.exec('DROP TRIGGER reject_issue_36_migration');
    migrate(database);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM rooms').get().count, 1);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('new-install bootstrap assigns the migrated room once and does not recreate it after deletion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'run-together-issue-36-bootstrap-'));
  const databasePath = join(directory, 'new-install.sqlite');
  const env = { ADMIN_NAME: 'Synthetic Bootstrap Admin', ADMIN_PIN: '4826', PIN_PEPPER: 'synthetic-pepper' };
  try {
    const firstDatabase = initializeDatabase({ databasePath, env });
    const firstRoom = firstDatabase.prepare('SELECT id, color, icon, owner_user_id FROM rooms').get();
    const admin = firstDatabase.prepare("SELECT id FROM users WHERE role = 'admin'").get();
    assert.equal(firstRoom.owner_user_id, admin.id);
    assert.equal(firstDatabase.prepare('SELECT COUNT(*) AS count FROM room_memberships WHERE room_id = ? AND user_id = ?')
      .get(firstRoom.id, admin.id).count, 1);
    assert.equal(firstDatabase.prepare('SELECT COUNT(*) AS count FROM room_migration_ledger').get().count, 1);
    firstDatabase.close();

    const restartedDatabase = initializeDatabase({ databasePath, env });
    const restartedRoom = restartedDatabase.prepare('SELECT id, color, icon, owner_user_id FROM rooms').get();
    assert.deepEqual(restartedRoom, firstRoom);
    restartedDatabase.prepare('DELETE FROM rooms WHERE id = ?').run(firstRoom.id);
    restartedDatabase.close();

    const afterDeletionDatabase = initializeDatabase({ databasePath, env });
    assert.equal(afterDeletionDatabase.prepare('SELECT COUNT(*) AS count FROM rooms').get().count, 0);
    assert.equal(afterDeletionDatabase.prepare('SELECT COUNT(*) AS count FROM room_migration_ledger').get().count, 1);
    afterDeletionDatabase.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('vote domain operations isolate the same user and date by explicit room identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'run-together-issue-36-votes-'));
  const database = openDatabase(join(directory, 'fixture.sqlite'));
  try {
    migrate(database);
    const admin = createUser(database, {
      name: 'Synthetic Admin', pinSalt: Buffer.from('salt'), pinHash: Buffer.from('hash'), role: 'admin',
    });
    const runner = createUser(database, {
      name: 'Synthetic Runner', pinSalt: Buffer.from('salt'), pinHash: Buffer.from('hash'),
    });
    const roomOne = createRoom(database, { creatorUserId: admin.id, title: 'Room One' });
    const roomTwo = createRoom(database, { creatorUserId: admin.id, title: 'Room Two' });
    addRoomMember(database, { roomId: roomOne.id, userId: runner.id });
    addRoomMember(database, { roomId: roomTwo.id, userId: runner.id });
    const now = () => new Date('2026-10-27T04:00:00.000Z');

    const first = setVote(database, {
      roomId: roomOne.id, userId: runner.id, voteDate: '2026-10-28', body: { selected: true }, now,
    });
    const second = setVote(database, {
      roomId: roomTwo.id, userId: runner.id, voteDate: '2026-10-28', body: { selected: true }, now,
    });

    assert.equal(first.patch.voteCount, 1);
    assert.equal(second.patch.voteCount, 1);
    const expectedRoomVotes = [roomOne.id, roomTwo.id].sort().map((roomId) => ({
      room_id: roomId,
      user_id: runner.id,
      vote_date: '2026-10-28',
    }));
    assert.deepEqual(database.prepare('SELECT room_id, user_id, vote_date FROM votes ORDER BY room_id').all(), [
      ...expectedRoomVotes,
    ]);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('event dates and retries remain isolated when two rooms reuse the same request ID', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'run-together-issue-36-events-'));
  const database = openDatabase(join(directory, 'fixture.sqlite'));
  try {
    migrate(database);
    const admin = createUser(database, {
      name: 'Synthetic Event Admin', pinSalt: Buffer.from('salt'), pinHash: Buffer.from('hash'), role: 'admin',
    });
    const runner = createUser(database, {
      name: 'Synthetic Event Runner', pinSalt: Buffer.from('salt'), pinHash: Buffer.from('hash'),
    });
    const roomOne = createRoom(database, { creatorUserId: admin.id, title: 'Event Room One' });
    const roomTwo = createRoom(database, { creatorUserId: admin.id, title: 'Event Room Two' });
    addRoomMember(database, { roomId: roomOne.id, userId: runner.id });
    addRoomMember(database, { roomId: roomTwo.id, userId: runner.id });
    const now = () => new Date('2026-10-27T04:00:00.000Z');
    const requestId = '00000000-0000-4000-8000-000000000036';
    for (const room of [roomOne, roomTwo]) {
      addVote(database, { roomId: room.id, userId: runner.id, voteDate: '2026-10-28' });
    }

    const first = proposeRunEvent(database, {
      roomId: roomOne.id, userId: runner.id, eventDate: '2026-10-28', requestId, now,
    });
    const second = proposeRunEvent(database, {
      roomId: roomTwo.id, userId: runner.id, eventDate: '2026-10-28', requestId, now,
    });
    assert.notEqual(first.event.eventId, second.event.eventId);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM run_events WHERE event_date = ?')
      .get('2026-10-28').count, 2);

    const withdrawn = withdrawRunEvent(database, {
      roomId: roomOne.id,
      userId: runner.id,
      eventDate: '2026-10-28',
      eventId: first.event.eventId,
      revision: first.event.revision,
      requestId: '00000000-0000-4000-8000-000000000037',
      now,
    });
    assert.equal(withdrawn.event, null);
    const delayedRetry = proposeRunEvent(database, {
      roomId: roomOne.id, userId: runner.id, eventDate: '2026-10-28', requestId, now,
    });
    assert.equal(delayedRetry.replayed, true);
    assert.equal(delayedRetry.event, null);
    assert.equal(getRunEventForDate(database, { roomId: roomOne.id, eventDate: '2026-10-28' }), null);
    assert.equal(getRunEventForDate(database, { roomId: roomTwo.id, eventDate: '2026-10-28' }).eventId, second.event.eventId);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('independent processes serialize concurrent room creation through SQLite allocation', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'run-together-issue-36-concurrency-'));
  const databasePath = join(directory, 'fixture.sqlite');
  const database = openDatabase(databasePath);
  const children = [];
  try {
    migrate(database);
    const admin = createUser(database, {
      name: 'Synthetic Concurrent Admin', pinSalt: Buffer.from('salt'), pinHash: Buffer.from('hash'), role: 'admin',
    });
    const workerPath = fileURLToPath(new URL('./helpers/issue-36-room-worker.js', import.meta.url));
    for (let index = 0; index < 8; index += 1) {
      const child = spawn(process.execPath, [workerPath], {
        env: {
          PATH: process.env.PATH ?? '',
          ISSUE36_DB_PATH: databasePath,
          ISSUE36_USER_ID: String(admin.id),
          ISSUE36_WORKER_ID: String(index),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
      const stderr = [];
      child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));
      children.push({ child, lines, stderr, exited: once(child, 'exit') });
    }

    for (const child of children) {
      const ready = await nextChildLine(child, 'ready');
      assert.equal(ready.value, 'READY');
    }
    children.forEach(({ child }) => child.stdin.end('go\n'));
    const rooms = [];
    for (const { child, lines, stderr, exited } of children) {
      const result = await nextChildLine({ lines, stderr, exited }, 'result');
      assert.equal(result.done, false, stderr.join(''));
      assert.match(result.value, /^RESULT /);
      rooms.push(JSON.parse(result.value.slice('RESULT '.length)));
      const [code, signal] = await exited;
      assert.equal(code, 0, `child exited ${code ?? signal}: ${stderr.join('')}`);
      lines.return?.();
    }

    assert.equal(new Set(rooms.map(({ pid }) => pid)).size, children.length);
    assert.equal(new Set(rooms.map(({ id }) => id)).size, children.length);
    assert.deepEqual(rooms.map(({ displayNumber }) => displayNumber).sort((a, b) => a - b),
      Array.from({ length: children.length }, (_, index) => index + 2));
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM rooms').get().count, children.length + 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM room_identity_ledger').get().count, children.length + 1);
  } finally {
    children.forEach(({ child }) => child.kill());
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('deleted room identities stay retired and display allocation survives deletions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'run-together-issue-36-identities-'));
  const database = openDatabase(join(directory, 'fixture.sqlite'));
  try {
    migrate(database);
    const admin = createUser(database, {
      name: 'Synthetic Identity Admin', pinSalt: Buffer.from('salt'), pinHash: Buffer.from('hash'), role: 'admin',
    });
    const first = createRoom(database, { creatorUserId: admin.id, title: 'Retired Room One' });
    const identityLedger = database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'room_identity_ledger'
    `).all();
    assert.deepEqual(identityLedger, [{ name: 'room_identity_ledger' }]);
    database.prepare('DELETE FROM rooms WHERE id = ?').run(first.id);
    const second = createRoom(database, { creatorUserId: admin.id, title: 'Retired Room Two' });
    assert.notEqual(second.id, first.id);
    assert.equal(second.displayNumber, first.displayNumber + 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM room_identity_ledger WHERE room_id IN (?, ?)')
      .get(first.id, second.id).count, 2);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('room creation allocates a permanent identity and atomically records creator ownership and membership', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'run-together-issue-36-create-'));
  const database = openDatabase(join(directory, 'fixture.sqlite'));
  try {
    migrate(database);
    const creator = createUser(database, {
      name: 'Synthetic Owner',
      pinSalt: Buffer.from('synthetic salt'),
      pinHash: Buffer.from('synthetic hash'),
      role: 'admin',
    });
    const room = createRoom(database, {
      creatorUserId: creator.id,
      title: 'Morning Run',
      color: ROOM_COLOR_PALETTE[2],
      icon: 'football',
      now: () => new Date('2026-10-27T04:00:00.000Z'),
    });
    assert.match(room.id, /^[0-9a-f-]{36}$/);
    assert.equal(room.displayNumber, 2);
    assert.equal(room.title, 'Morning Run');
    assert.equal(room.color, ROOM_COLOR_PALETTE[2]);
    assert.equal(room.icon, 'football');
    assert.equal(room.ownerUserId, creator.id);
    assert.deepEqual(database.prepare('SELECT room_id, user_id FROM room_memberships WHERE room_id = ?').all(room.id), [{
      room_id: room.id,
      user_id: creator.id,
    }]);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
