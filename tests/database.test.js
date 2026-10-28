import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDatabase, migrate } from '../src/database.js';

test('opens SQLite with foreign keys and WAL and applies repeatable migrations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'run-together-db-'));
  const databasePath = join(directory, 'test.sqlite');
  try {
    const database = openDatabase(databasePath);
    migrate(database);
    assert.equal(database.pragma('foreign_keys', { simple: true }), 1);
    assert.equal(database.pragma('journal_mode', { simple: true }).toLowerCase(), 'wal');
    assert.deepEqual(
      database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all(),
      [
        { name: 'admin_action_audit' },
        { name: 'room_display_counter' },
        { name: 'room_identity_ledger' },
        { name: 'room_memberships' },
        { name: 'room_migration_ledger' },
        { name: 'rooms' },
        { name: 'run_event_requests' },
        { name: 'run_events' },
        { name: 'schema_migrations' },
        { name: 'sessions' },
        { name: 'sqlite_sequence' },
        { name: 'users' },
        { name: 'votes' },
      ],
    );
    const firstTables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
    migrate(database);
    const secondTables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
    assert.deepEqual(secondTables, firstTables);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count, 6);
    database.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
