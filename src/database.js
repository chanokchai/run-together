import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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
];

export function openDatabase(databasePath) {
  if (!databasePath) throw new Error('databasePath is required');
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new Database(databasePath);
  database.pragma('foreign_keys = ON');
  database.pragma('journal_mode = WAL');
  return database;
}

export function migrate(database) {
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
    if (appliedVersions.has(migration.version)) continue;
    const applyMigration = database.transaction(() => {
      for (const statement of migration.statements) database.exec(statement);
      insertMigration.run(migration.version, migration.name, new Date().toISOString());
    });
    applyMigration();
  }
  return database;
}

export { MIGRATIONS };
