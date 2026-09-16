import { randomBytes, scryptSync } from 'node:crypto';
import { normalizeName } from './names.js';
import {
  addDays,
  getIsoWeek,
  getWeekRange,
  isDateWritable,
  isWeekNavigable,
  parseIsoDate,
} from './calendar.js';

function timestamp(now = () => new Date()) {
  const value = now instanceof Date || typeof now === 'string' ? now : now();
  return new Date(value).toISOString();
}

function requirePinMaterial(pinSalt, pinHash) {
  if (pinSalt === undefined || pinHash === undefined) {
    throw new Error('pinSalt and pinHash are required');
  }
}

export function createUser(database, {
  name,
  pinSalt,
  pinHash,
  role = 'user',
  now = () => new Date(),
}) {
  const displayName = String(name ?? '').trim().normalize('NFKC');
  const nameKey = normalizeName(displayName);
  if (!displayName || !nameKey) throw new Error('name is required');
  if (role !== 'admin' && role !== 'user') throw new Error('invalid user role');
  requirePinMaterial(pinSalt, pinHash);
  const createdAt = timestamp(now);
  try {
    const result = database.prepare(`
      INSERT INTO users (name, name_key, pin_salt, pin_hash, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(displayName, nameKey, pinSalt, pinHash, role, createdAt, createdAt);
    return database.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      throw new Error('name already exists', { cause: error });
    }
    throw error;
  }
}

export function listAdmins(database) {
  return database.prepare("SELECT * FROM users WHERE role = 'admin' ORDER BY id").all();
}

export function bootstrapAdmin(database, { env = process.env, now = () => new Date() } = {}) {
  const adminName = String(env.ADMIN_NAME ?? '').trim();
  const adminPin = String(env.ADMIN_PIN ?? '');
  const pepper = String(env.PIN_PEPPER ?? '');
  if (!adminName || !pepper) throw new Error('ADMIN_NAME and PIN_PEPPER are required');
  if (!/^\d{4}$/.test(adminPin)) throw new Error('ADMIN_PIN must be exactly four ASCII digits');
  const admins = listAdmins(database);
  if (admins.length > 1) throw new Error('conflicting multiple admin records');
  const requestedNameKey = normalizeName(adminName);
  if (admins.length === 1) {
    if (admins[0].name_key !== requestedNameKey) throw new Error('conflicting existing admin');
    return admins[0];
  }
  const salt = randomBytes(16);
  const hash = scryptSync(adminPin, Buffer.concat([Buffer.from(pepper, 'utf8'), salt]), 64);
  return createUser(database, {
    name: adminName,
    pinSalt: salt,
    pinHash: hash,
    role: 'admin',
    now,
  });
}

export function addVote(database, { userId, voteDate, createdAt = new Date().toISOString() }) {
  const canonicalDate = formatParsedDate(parseIsoDate(voteDate));
  const result = database.prepare(`
    INSERT INTO votes (user_id, vote_date, created_at) VALUES (?, ?, ?)
  `).run(userId, canonicalDate, createdAt);
  return database.prepare('SELECT * FROM votes WHERE id = ?').get(result.lastInsertRowid);
}

export function getWeekState(database, { monday, currentUserId, now = () => new Date() }) {
  const { sunday } = getWeekRange(monday);
  const rows = database.prepare(`
    SELECT votes.vote_date AS date, votes.user_id AS userId, users.name AS voterName
    FROM votes
    JOIN users ON users.id = votes.user_id
    WHERE votes.vote_date >= ? AND votes.vote_date <= ?
    ORDER BY votes.vote_date ASC, users.name_key ASC, users.name ASC, votes.user_id ASC
  `).all(monday, sunday);
  const byDate = new Map();
  const currentUserSelectedDates = [];
  for (const row of rows) {
    const names = byDate.get(row.date) ?? [];
    names.push(row.voterName);
    byDate.set(row.date, names);
    if (row.userId === currentUserId) currentUserSelectedDates.push(row.date);
  }
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = addDays(monday, index);
    const voterNames = byDate.get(date) ?? [];
    return {
      date,
      eligible: isDateWritable(date, now),
      voteCount: voterNames.length,
      voterNames,
    };
  });
  const isoWeek = getIsoWeek(monday);
  const nextMonday = addDays(monday, 7);
  return {
    week: { monday, sunday, isoWeek: isoWeek.week, isoWeekYear: isoWeek.weekYear },
    navigation: {
      previousMonday: addDays(monday, -7),
      nextMonday: isWeekNavigable(nextMonday, now) ? nextMonday : null,
    },
    currentUserSelectedDates: [...new Set(currentUserSelectedDates)].sort(),
    days,
  };
}

export function createSession(database, {
  tokenHash,
  userId,
  csrfSecret,
  createdAt,
  lastSeenAt,
  expiresAt,
}) {
  const result = database.prepare(`
    INSERT INTO sessions
      (token_hash, user_id, csrf_secret, created_at, last_seen_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(tokenHash, userId, csrfSecret, createdAt, lastSeenAt, expiresAt);
  return database.prepare('SELECT * FROM sessions WHERE id = ?').get(result.lastInsertRowid);
}

export function deleteUser(database, userId) {
  const user = database.prepare('SELECT role FROM users WHERE id = ?').get(userId);
  if (!user) return false;
  if (user.role === 'admin') throw new Error('seeded admin cannot be deleted');
  database.prepare('DELETE FROM users WHERE id = ?').run(userId);
  return true;
}

function formatParsedDate({ year, month, day }) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
