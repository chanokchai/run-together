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
  createSession,
  createUser,
  getRunEventForDate,
  proposeRunEvent,
  resetUserVotes,
  setRunEventStatus,
  setVote,
  withdrawRunEvent,
} from '../src/domain.js';
import { DEFAULT_ROOM_COLOR, DEFAULT_ROOM_ICON, LEGACY_ROOM_ID, ROOM_COLOR_PALETTE } from '../src/room-contract.js';
import { addRoomMember, createRoom, hasRoomMember } from '../src/room-storage.js';

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
      INSERT INTO sessions (id, token_hash, user_id, csrf_secret, created_at, last_seen_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(27, Buffer.from([10, 11]), memberId, Buffer.from([12, 13]),
      '2024-02-29T04:00:00.000Z', '2024-02-29T04:01:00.000Z', '2024-03-01T04:00:00.000Z');
    database.prepare('INSERT INTO votes (id, user_id, vote_date, created_at) VALUES (?, ?, ?, ?)')
      .run(41, memberId, '2024-03-01', '2024-02-29T04:02:00.000Z');
    database.prepare('INSERT INTO votes (id, user_id, vote_date, created_at) VALUES (?, ?, ?, ?)')
      .run(42, memberId, '2024-03-02', '2024-02-29T04:02:30.000Z');
    const insertEvent = database.prepare(`
      INSERT INTO run_events (id, event_date, status, revision, proposed_by, proposed_at, scheduled_by, scheduled_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertEvent.run(73, '2024-03-01', 'scheduled', 4, memberId,
      '2024-02-29T04:03:00.000Z', adminId, '2024-02-29T04:04:00.000Z');
    insertEvent.run(74, '2024-03-02', 'proposed', 1, memberId, '2024-02-29T04:05:00.000Z', null, null);
    insertEvent.run(91, '2024-03-03', 'proposed', 1, memberId, '2024-02-29T04:06:00.000Z', null, null);
    database.prepare('DELETE FROM run_events WHERE id = ?').run(91);
    database.prepare(`
      INSERT INTO run_event_requests
        (request_id, actor_user_id, action, event_date, event_id, expected_revision, requested_status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('00000000-0000-4000-8000-000000000036', adminId, 'schedule', '2024-03-01', 73, 3,
      'scheduled', '2024-02-29T04:04:00.000Z');
    database.prepare(`
      INSERT INTO run_event_requests
        (request_id, actor_user_id, action, event_date, event_id, expected_revision, requested_status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('00000000-0000-4000-8000-000000000039', memberId, 'propose', '2024-03-02', null, null,
      'proposed', '2024-02-29T04:05:00.000Z');
    database.prepare(`
      INSERT INTO run_event_requests
        (request_id, actor_user_id, action, event_date, event_id, expected_revision, requested_status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('00000000-0000-4000-8000-000000000040', adminId, 'delete', '2024-03-03', 91, 1,
      null, '2024-02-29T04:06:00.000Z');

    const originalRows = {
      users: database.prepare('SELECT * FROM users ORDER BY id').all(),
      sessions: database.prepare('SELECT * FROM sessions ORDER BY id').all(),
      votes: database.prepare('SELECT id, user_id, vote_date, created_at FROM votes ORDER BY id').all(),
      events: database.prepare(`
        SELECT id, event_date, status, revision, proposed_by, proposed_at, scheduled_by, scheduled_at
        FROM run_events ORDER BY id
      `).all(),
      requests: database.prepare(`
        SELECT request_id, actor_user_id, action, event_date, event_id, expected_revision, requested_status, created_at
        FROM run_event_requests ORDER BY request_id
      `).all(),
    };

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
    assert.deepEqual(database.prepare('SELECT * FROM users ORDER BY id').all(), originalRows.users);
    assert.deepEqual(database.prepare('SELECT * FROM sessions ORDER BY id').all(), originalRows.sessions);
    assert.deepEqual(database.prepare(`
      SELECT id, room_id, user_id, vote_date, created_at FROM votes ORDER BY id
    `).all(), originalRows.votes.map((row) => ({ ...row, room_id: room.id })));
    assert.deepEqual(database.prepare(`
      SELECT id, room_id, event_date, status, revision, proposed_by, proposed_at, scheduled_by, scheduled_at
      FROM run_events ORDER BY id
    `).all(), originalRows.events.map((row) => ({ ...row, room_id: room.id })));
    assert.deepEqual(database.prepare(`
      SELECT room_id, request_id, actor_user_id, action, event_date, event_id, expected_revision, requested_status, created_at
      FROM run_event_requests ORDER BY request_id
    `).all(), originalRows.requests.map((row) => ({ room_id: room.id, ...row })));
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM room_memberships').get().count, 2);

    const clock = () => new Date('2024-02-29T04:00:00.000Z');
    const scheduledRetry = setRunEventStatus(database, {
      roomId: room.id,
      adminUserId: adminId,
      eventDate: '2024-03-01',
      eventId: 73,
      revision: 3,
      status: 'scheduled',
      requestId: '00000000-0000-4000-8000-000000000036',
      now: clock,
    });
    assert.equal(scheduledRetry.replayed, true);
    assert.equal(scheduledRetry.event.eventId, 73);
    assert.equal(scheduledRetry.event.status, 'scheduled');

    const withdrawn = withdrawRunEvent(database, {
      roomId: room.id,
      userId: memberId,
      eventDate: '2024-03-02',
      eventId: 74,
      revision: 1,
      requestId: '00000000-0000-4000-8000-000000000041',
      now: clock,
    });
    assert.equal(withdrawn.event, null);
    const delayedProposalRetry = proposeRunEvent(database, {
      roomId: room.id,
      userId: memberId,
      eventDate: '2024-03-02',
      requestId: '00000000-0000-4000-8000-000000000039',
      now: clock,
    });
    assert.equal(delayedProposalRetry.replayed, true);
    assert.equal(delayedProposalRetry.event, null);
    assert.equal(getRunEventForDate(database, { roomId: room.id, eventDate: '2024-03-02' }), null);
    assert.equal(database.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'run_events'").get().seq, 91);
    const nextEvent = database.prepare(`
      INSERT INTO run_events (room_id, event_date, status, revision, proposed_by, proposed_at)
      VALUES (?, ?, 'proposed', 1, ?, ?)
    `).run(room.id, '2024-03-04', memberId, '2024-02-29T04:07:00.000Z');
    assert.equal(Number(nextEvent.lastInsertRowid), 92);
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
    const selectedRoom = createRoom(firstDatabase, {
      creatorUserId: admin.id,
      title: 'Restart Metadata',
      color: ROOM_COLOR_PALETTE[2],
      icon: 'football',
    });
    const selectedRoomRecord = firstDatabase.prepare(`
      SELECT id, display_number, title, color, icon, owner_user_id
      FROM rooms WHERE id = ?
    `).get(selectedRoom.id);
    firstDatabase.close();

    const restartedDatabase = initializeDatabase({ databasePath, env });
    const restartedRoom = restartedDatabase.prepare('SELECT id, color, icon, owner_user_id FROM rooms').get();
    assert.deepEqual(restartedRoom, firstRoom);
    assert.deepEqual(restartedDatabase.prepare(`
      SELECT id, display_number, title, color, icon, owner_user_id
      FROM rooms WHERE id = ?
    `).get(selectedRoom.id), selectedRoomRecord);
    restartedDatabase.prepare('DELETE FROM rooms WHERE id = ?').run(selectedRoom.id);
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

test('legacy vote reset rejects another room before replaying a legacy audit request', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'run-together-issue-36-reset-scope-'));
  const database = openDatabase(join(directory, 'fixture.sqlite'));
  try {
    migrate(database);
    const admin = createUser(database, {
      name: 'Synthetic Reset Admin', pinSalt: Buffer.from('salt'), pinHash: Buffer.from('hash'), role: 'admin',
    });
    const runner = createUser(database, {
      name: 'Synthetic Reset Runner', pinSalt: Buffer.from('salt'), pinHash: Buffer.from('hash'),
    });
    const otherRoom = createRoom(database, { creatorUserId: admin.id, title: 'Reset Scope Room' });
    const requestId = '00000000-0000-4000-8000-000000000038';
    addVote(database, { userId: runner.id, voteDate: '2026-10-28' });
    addVote(database, { roomId: otherRoom.id, userId: runner.id, voteDate: '2026-10-28' });

    const legacyReset = resetUserVotes(database, {
      adminUserId: admin.id, targetUserId: runner.id, requestId,
    });
    assert.equal(legacyReset.deletedVoteCount, 1);
    assert.equal(legacyReset.replayed, false);

    assert.throws(() => resetUserVotes(database, {
      roomId: otherRoom.id,
      adminUserId: admin.id,
      targetUserId: runner.id,
      requestId,
    }), (error) => error.code === 'ROOM_SCOPE_UNSUPPORTED' && error.status === 400);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM votes WHERE room_id = ? AND user_id = ?')
      .get(otherRoom.id, runner.id).count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM admin_action_audit WHERE request_id = ?')
      .get(requestId).count, 1);
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
    database.prepare('UPDATE room_display_counter SET next_display_number = 98 WHERE singleton = 1').run();
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
      [1, 2, 3, 4, 5, 6, 98, 99]);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM rooms WHERE display_number = 1').get().count, 2);
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
    database.prepare('UPDATE room_display_counter SET next_display_number = 99 WHERE singleton = 1').run();
    const first = createRoom(database, { creatorUserId: admin.id, title: 'Retired Room One' });
    assert.equal(first.displayNumber, 99);
    const identityLedger = database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'room_identity_ledger'
    `).all();
    assert.deepEqual(identityLedger, [{ name: 'room_identity_ledger' }]);
    database.prepare('DELETE FROM rooms WHERE id = ?').run(first.id);
    const second = createRoom(database, { creatorUserId: admin.id, title: 'Retired Room Two' });
    assert.notEqual(second.id, first.id);
    assert.equal(second.displayNumber, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM rooms WHERE display_number = 1').get().count, 2);
    assert.equal(database.prepare('SELECT next_display_number FROM room_display_counter WHERE singleton = 1')
      .get().next_display_number, 2);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM room_identity_ledger WHERE room_id IN (?, ?)')
      .get(first.id, second.id).count, 2);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('room creation validates metadata and preserves ownership, membership, and rollback integrity', async () => {
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
    const member = createUser(database, {
      name: 'Synthetic Room Member',
      pinSalt: Buffer.from('member salt'),
      pinHash: Buffer.from('member hash'),
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
    const firstMembership = addRoomMember(database, {
      roomId: room.id, userId: member.id, now: () => new Date('2026-10-27T04:00:00.000Z'),
    });
    const duplicateMembership = addRoomMember(database, {
      roomId: room.id, userId: member.id, now: () => new Date('2026-10-28T04:00:00.000Z'),
    });
    assert.deepEqual(duplicateMembership, firstMembership);
    const session = createSession(database, {
      tokenHash: Buffer.from('synthetic-session-token'),
      userId: member.id,
      csrfSecret: Buffer.from('synthetic-session-csrf'),
      createdAt: '2026-10-27T04:00:00.000Z',
      lastSeenAt: '2026-10-27T04:00:00.000Z',
      expiresAt: '2026-10-28T04:00:00.000Z',
    });
    database.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM room_memberships WHERE room_id = ? AND user_id = ?')
      .get(room.id, member.id).count, 1);
    assert.equal(hasRoomMember(database, { roomId: room.id, userId: member.id }), true);

    const roomCountBeforeFailures = database.prepare('SELECT COUNT(*) AS count FROM rooms').get().count;
    const identityCountBeforeFailures = database.prepare('SELECT COUNT(*) AS count FROM room_identity_ledger').get().count;
    const counterBeforeFailures = database.prepare('SELECT next_display_number FROM room_display_counter WHERE singleton = 1')
      .get().next_display_number;
    assert.throws(() => createRoom(database, { creatorUserId: creator.id, title: '   ' }), /room title/);
    assert.throws(() => createRoom(database, { creatorUserId: creator.id, title: 'x'.repeat(31) }), /room title/);
    assert.throws(() => createRoom(database, {
      creatorUserId: creator.id, title: 'Invalid Color', color: '#fff',
    }), /invalid room color/);
    assert.throws(() => createRoom(database, {
      creatorUserId: creator.id, title: 'Invalid Icon', icon: 'custom-upload',
    }), /invalid room icon/);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM rooms').get().count, roomCountBeforeFailures);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM room_identity_ledger').get().count, identityCountBeforeFailures);
    assert.equal(database.prepare('SELECT next_display_number FROM room_display_counter WHERE singleton = 1')
      .get().next_display_number, counterBeforeFailures);
    assert.throws(() => createRoom(database, {
      creatorUserId: 999999, title: 'Missing Creator',
    }), (error) => error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM rooms').get().count, roomCountBeforeFailures);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM room_identity_ledger').get().count, identityCountBeforeFailures);
    assert.equal(database.prepare('SELECT next_display_number FROM room_display_counter WHERE singleton = 1')
      .get().next_display_number, counterBeforeFailures);

    database.exec(`
      CREATE TRIGGER reject_issue36_creator_membership
      BEFORE INSERT ON room_memberships
      WHEN NEW.room_id <> '${LEGACY_ROOM_ID}' AND NEW.user_id = ${creator.id}
      BEGIN SELECT RAISE(ABORT, 'forced issue 36 creator membership failure'); END
    `);
    assert.throws(() => createRoom(database, {
      creatorUserId: creator.id, title: 'Rollback Creator Membership',
    }), /forced issue 36 creator membership failure/);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM rooms').get().count, roomCountBeforeFailures);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM room_identity_ledger').get().count, identityCountBeforeFailures);
    assert.equal(database.prepare('SELECT next_display_number FROM room_display_counter WHERE singleton = 1')
      .get().next_display_number, counterBeforeFailures);
    database.exec('DROP TRIGGER reject_issue36_creator_membership');

    const membershipsBeforeInvalidReferences = database.prepare('SELECT COUNT(*) AS count FROM room_memberships').get().count;
    assert.throws(() => addRoomMember(database, {
      roomId: '00000000-0000-4000-8000-000000000099', userId: member.id,
    }), (error) => error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY');
    assert.throws(() => addRoomMember(database, {
      roomId: room.id, userId: 999999,
    }), (error) => error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY');
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM room_memberships').get().count,
      membershipsBeforeInvalidReferences);
    const ownedRoom = createRoom(database, { creatorUserId: member.id, title: 'Owner Restriction' });
    assert.throws(() => database.prepare('DELETE FROM users WHERE id = ?').run(member.id),
      (error) => /FOREIGN KEY constraint failed/.test(error.message));
    assert.equal(database.prepare('SELECT owner_user_id FROM rooms WHERE id = ?').get(ownedRoom.id).owner_user_id,
      member.id);
    assert.deepEqual(database.pragma('foreign_key_check'), []);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
