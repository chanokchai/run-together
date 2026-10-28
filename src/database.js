import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_ROOM_COLOR, DEFAULT_ROOM_ICON, LEGACY_ROOM_ID, ROOM_COLOR_PALETTE, ROOM_ICONS } from './room-contract.js';

const MIGRATIONS = [
  {
    version: 1,
    name: 'initial_schema',
    statements: [
      `CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        name_key TEXT NOT NULL UNIQUE,
        pin_salt BLOB NOT NULL,
        pin_hash BLOB NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX users_single_admin ON users(role) WHERE role = 'admin'`,
      `CREATE TABLE votes (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        vote_date TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (user_id, vote_date)
      )`,
      `CREATE TABLE sessions (
        id INTEGER PRIMARY KEY,
        token_hash BLOB NOT NULL UNIQUE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf_secret BLOB NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      )`,
    ],
  },
  {
    version: 2,
    name: 'protect_admin_delete',
    statements: [
      `CREATE TRIGGER prevent_admin_delete
       BEFORE DELETE ON users
       WHEN OLD.role = 'admin'
       BEGIN
         SELECT RAISE(ABORT, 'seeded admin cannot be deleted');
       END`,
    ],
  },
  {
    version: 3,
    name: 'protect_user_roles',
    statements: [
      `CREATE TRIGGER prevent_user_role_change
       BEFORE UPDATE OF role ON users
       WHEN OLD.role <> NEW.role
       BEGIN
         SELECT RAISE(ABORT, 'user roles cannot be changed');
       END`,
    ],
  },
  {
    version: 4,
    name: 'admin_action_audit',
    statements: [
      `CREATE TABLE admin_action_audit (
        id INTEGER PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        admin_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        target_user_id INTEGER NOT NULL,
        target_name TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('reset_votes', 'delete_user')),
        deleted_vote_count INTEGER NOT NULL CHECK (deleted_vote_count >= 0),
        occurred_at TEXT NOT NULL
      )`,
    ],
  },
  {
    version: 5,
    name: 'proposed_scheduled_run_events',
    statements: [
      `CREATE TABLE run_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_date TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('proposed', 'scheduled')),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
        proposed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        proposed_at TEXT NOT NULL,
        scheduled_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        scheduled_at TEXT,
        CHECK (
          (status = 'proposed' AND scheduled_by IS NULL AND scheduled_at IS NULL)
          OR (status = 'scheduled' AND scheduled_by IS NOT NULL AND scheduled_at IS NOT NULL)
        )
      )`,
      'CREATE INDEX run_events_date ON run_events(event_date)',
      `CREATE TABLE run_event_requests (
        request_id TEXT PRIMARY KEY,
        actor_user_id INTEGER NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('propose', 'withdraw', 'schedule', 'revert', 'delete')),
        event_date TEXT NOT NULL,
        event_id INTEGER,
        expected_revision INTEGER,
        requested_status TEXT CHECK (requested_status IN ('proposed', 'scheduled') OR requested_status IS NULL),
        created_at TEXT NOT NULL
      )`,
    ],
  },
  {
    version: 6,
    name: 'room_storage_and_legacy_board',
    apply(database, appliedAt) {
      const colors = ROOM_COLOR_PALETTE.map((color) => `'${color}'`).join(', ');
      const icons = ROOM_ICONS.map((icon) => `'${icon}'`).join(', ');
      database.exec(`
        CREATE TABLE rooms (
          id TEXT PRIMARY KEY,
          display_number INTEGER NOT NULL CHECK (display_number BETWEEN 1 AND 99),
          title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 30),
          color TEXT NOT NULL CHECK (color IN (${colors})),
          icon TEXT NOT NULL CHECK (icon IN (${icons})),
          owner_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE room_memberships (
          room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          joined_at TEXT NOT NULL,
          PRIMARY KEY (room_id, user_id)
        );
        CREATE TABLE room_migration_ledger (
          migration_key TEXT PRIMARY KEY,
          room_id TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
        CREATE TABLE room_identity_ledger (
          room_id TEXT PRIMARY KEY,
          allocated_at TEXT NOT NULL
        );
        CREATE TABLE room_display_counter (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          next_display_number INTEGER NOT NULL CHECK (next_display_number BETWEEN 1 AND 99)
        );
      `);

      const admin = database.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
      database.prepare(`
        INSERT INTO rooms (id, display_number, title, color, icon, owner_user_id, created_at)
        VALUES (?, 1, 'Run Together', ?, ?, ?, ?)
      `).run(LEGACY_ROOM_ID, DEFAULT_ROOM_COLOR, DEFAULT_ROOM_ICON, admin?.id ?? null, appliedAt);
      database.prepare(`
        INSERT INTO room_migration_ledger (migration_key, room_id, applied_at)
        VALUES ('legacy_shared_board_v5', ?, ?)
      `).run(LEGACY_ROOM_ID, appliedAt);
      database.prepare('INSERT INTO room_identity_ledger (room_id, allocated_at) VALUES (?, ?)')
        .run(LEGACY_ROOM_ID, appliedAt);
      database.prepare('INSERT INTO room_display_counter (singleton, next_display_number) VALUES (1, 2)').run();

      database.exec(`
        CREATE TABLE votes_room_migration (
          id INTEGER PRIMARY KEY,
          room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          vote_date TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE (room_id, user_id, vote_date)
        );
        INSERT INTO votes_room_migration (id, room_id, user_id, vote_date, created_at)
          SELECT id, '${LEGACY_ROOM_ID}', user_id, vote_date, created_at FROM votes;
        DROP TABLE votes;
        ALTER TABLE votes_room_migration RENAME TO votes;

        CREATE TABLE run_events_room_migration (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
          event_date TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('proposed', 'scheduled')),
          revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
          proposed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          proposed_at TEXT NOT NULL,
          scheduled_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          scheduled_at TEXT,
          CHECK (
            (status = 'proposed' AND scheduled_by IS NULL AND scheduled_at IS NULL)
            OR (status = 'scheduled' AND scheduled_by IS NOT NULL AND scheduled_at IS NOT NULL)
          ),
          UNIQUE (room_id, event_date)
        );
      `);
      const previousEventSequence = database.prepare(
        "SELECT seq FROM sqlite_sequence WHERE name = 'run_events'",
      ).get()?.seq ?? 0;
      database.exec(`
        INSERT INTO run_events_room_migration
          (id, room_id, event_date, status, revision, proposed_by, proposed_at, scheduled_by, scheduled_at)
          SELECT id, '${LEGACY_ROOM_ID}', event_date, status, revision, proposed_by, proposed_at, scheduled_by, scheduled_at
          FROM run_events;
        DROP TABLE run_events;
        ALTER TABLE run_events_room_migration RENAME TO run_events;

        CREATE TABLE run_event_requests_room_migration (
          room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
          request_id TEXT NOT NULL,
          actor_user_id INTEGER NOT NULL,
          action TEXT NOT NULL CHECK (action IN ('propose', 'withdraw', 'schedule', 'revert', 'delete')),
          event_date TEXT NOT NULL,
          event_id INTEGER,
          expected_revision INTEGER,
          requested_status TEXT CHECK (requested_status IN ('proposed', 'scheduled') OR requested_status IS NULL),
          created_at TEXT NOT NULL,
          PRIMARY KEY (room_id, request_id)
        );
        INSERT INTO run_event_requests_room_migration
          (room_id, request_id, actor_user_id, action, event_date, event_id, expected_revision, requested_status, created_at)
          SELECT '${LEGACY_ROOM_ID}', request_id, actor_user_id, action, event_date, event_id, expected_revision, requested_status, created_at
          FROM run_event_requests;
        DROP TABLE run_event_requests;
        ALTER TABLE run_event_requests_room_migration RENAME TO run_event_requests;
        CREATE INDEX run_events_date ON run_events(room_id, event_date);
      `);
      const maxEventId = database.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM run_events').get().id;
      const eventSequence = Math.max(previousEventSequence, maxEventId);
      database.prepare("DELETE FROM sqlite_sequence WHERE name = 'run_events'").run();
      if (eventSequence > 0) {
        database.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').run('run_events', eventSequence);
      }

      database.prepare(`
        INSERT INTO room_memberships (room_id, user_id, joined_at)
        SELECT ?, id, created_at FROM users
      `).run(LEGACY_ROOM_ID);
      database.exec(`
        CREATE TRIGGER join_new_users_to_legacy_room
        AFTER INSERT ON users
        BEGIN
          UPDATE rooms SET owner_user_id = NEW.id
          WHERE id = '${LEGACY_ROOM_ID}' AND owner_user_id IS NULL AND NEW.role = 'admin';
          INSERT OR IGNORE INTO room_memberships (room_id, user_id, joined_at)
          SELECT id, NEW.id, NEW.created_at FROM rooms WHERE id = '${LEGACY_ROOM_ID}';
        END;
      `);
    },
  },
  {
    version: 7,
    name: 'preserve_event_attribution_after_user_deletion',
    apply(database) {
      const previousSequence = database.prepare(
        "SELECT seq FROM sqlite_sequence WHERE name = 'run_events'",
      ).get()?.seq ?? 0;
      database.exec(`
        CREATE TABLE run_events_v7 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
          event_date TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('proposed', 'scheduled')),
          revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
          proposed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          proposed_by_name TEXT,
          proposed_at TEXT NOT NULL,
          scheduled_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          scheduled_by_name TEXT,
          scheduled_at TEXT,
          CHECK (
            (status = 'proposed' AND scheduled_by IS NULL AND scheduled_at IS NULL)
            OR (status = 'scheduled' AND scheduled_at IS NOT NULL
              AND (scheduled_by IS NOT NULL OR scheduled_by_name IS NOT NULL))
          ),
          UNIQUE (room_id, event_date)
        );
        INSERT INTO run_events_v7
          (id, room_id, event_date, status, revision, proposed_by, proposed_by_name, proposed_at,
            scheduled_by, scheduled_by_name, scheduled_at)
          SELECT events.id, events.room_id, events.event_date, events.status, events.revision,
            events.proposed_by, proposer.name, events.proposed_at,
            events.scheduled_by, scheduler.name, events.scheduled_at
          FROM run_events AS events
          LEFT JOIN users AS proposer ON proposer.id = events.proposed_by
          LEFT JOIN users AS scheduler ON scheduler.id = events.scheduled_by;
        DROP TABLE run_events;
        ALTER TABLE run_events_v7 RENAME TO run_events;
        CREATE INDEX run_events_date ON run_events(room_id, event_date);
      `);
      const maxId = database.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM run_events').get().id;
      database.prepare("DELETE FROM sqlite_sequence WHERE name IN ('run_events', 'run_events_v7')").run();
      const sequence = Math.max(previousSequence, maxId);
      if (sequence > 0) {
        database.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').run('run_events', sequence);
      }
    },
  },
];

export function openDatabase(databasePath) {
  if (!databasePath) throw new Error('databasePath is required');
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new Database(databasePath);
  database.pragma('foreign_keys = ON');
  database.pragma('journal_mode = WAL');
  return database;
}

export function migrate(database, { throughVersion = Infinity } = {}) {
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const applied = database.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
  const appliedVersions = new Set(applied.map(({ version }) => version));
  const insertMigration = database.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
  );
  for (const migration of MIGRATIONS) {
    if (migration.version > throughVersion) continue;
    if (appliedVersions.has(migration.version)) continue;
    const appliedAt = new Date().toISOString();
    const applyMigration = database.transaction(() => {
      if (migration.apply) migration.apply(database, appliedAt);
      else for (const statement of migration.statements) database.exec(statement);
      insertMigration.run(migration.version, migration.name, appliedAt);
    });
    applyMigration();
  }
  return database;
}

export { MIGRATIONS };
