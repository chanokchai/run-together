import { randomInt, randomUUID } from 'node:crypto';
import {
  DEFAULT_ROOM_ICON,
  LEGACY_ROOM_ID,
  ROOM_COLOR_PALETTE,
  ROOM_ICONS,
} from './room-contract.js';

function timestamp(now) {
  const value = now instanceof Date || typeof now === 'string' ? now : now();
  return new Date(value).toISOString();
}

function validateRoomTitle(value) {
  if (typeof value !== 'string') throw new TypeError('room title must be a string');
  const title = value.trim();
  const length = Array.from(title).length;
  if (length < 1 || length > 30) throw new RangeError('room title must contain 1 to 30 characters');
  return title;
}

function validateRoomColor(color) {
  if (!ROOM_COLOR_PALETTE.includes(color)) throw new RangeError('invalid room color');
  return color;
}

function validateRoomIcon(icon) {
  if (!ROOM_ICONS.includes(icon)) throw new RangeError('invalid room icon');
  return icon;
}

function roomFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    displayNumber: row.display_number,
    title: row.title,
    color: row.color,
    icon: row.icon,
    ownerUserId: row.owner_user_id,
    createdAt: row.created_at,
  };
}

export function createRoom(database, {
  creatorUserId,
  title,
  color = ROOM_COLOR_PALETTE[randomInt(ROOM_COLOR_PALETTE.length)],
  icon = DEFAULT_ROOM_ICON,
  now = () => new Date(),
} = {}) {
  const roomTitle = validateRoomTitle(title);
  const roomColor = validateRoomColor(color);
  const roomIcon = validateRoomIcon(icon);
  if (!Number.isSafeInteger(creatorUserId) || creatorUserId < 1) {
    throw new TypeError('creatorUserId must be a positive safe integer');
  }
  const createdAt = timestamp(now);
  const create = database.transaction(() => {
    const counter = database.prepare(
      'SELECT next_display_number FROM room_display_counter WHERE singleton = 1',
    ).get();
    if (!counter) throw new Error('room display counter is not initialized');
    let roomId;
    while (!roomId) {
      const candidate = randomUUID();
      try {
        database.prepare('INSERT INTO room_identity_ledger (room_id, allocated_at) VALUES (?, ?)')
          .run(candidate, createdAt);
        roomId = candidate;
      } catch (error) {
        if (error.code !== 'SQLITE_CONSTRAINT_PRIMARYKEY' && error.code !== 'SQLITE_CONSTRAINT_UNIQUE') throw error;
      }
    }
    database.prepare(`
      INSERT INTO rooms (id, display_number, title, color, icon, owner_user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(roomId, counter.next_display_number, roomTitle, roomColor, roomIcon, creatorUserId, createdAt);
    database.prepare(`
      INSERT INTO room_memberships (room_id, user_id, joined_at)
      VALUES (?, ?, ?)
    `).run(roomId, creatorUserId, createdAt);
    database.prepare(`
      UPDATE room_display_counter
      SET next_display_number = CASE WHEN next_display_number = 99 THEN 1 ELSE next_display_number + 1 END
      WHERE singleton = 1
    `).run();
    return getRoom(database, { roomId });
  });
  return create.immediate();
}

export function getRoom(database, { roomId } = {}) {
  if (typeof roomId !== 'string' || roomId.length === 0) throw new TypeError('roomId is required');
  return roomFromRow(database.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId));
}

export function addRoomMember(database, { roomId, userId, now = () => new Date() } = {}) {
  if (typeof roomId !== 'string' || roomId.length === 0) throw new TypeError('roomId is required');
  if (!Number.isSafeInteger(userId) || userId < 1) throw new TypeError('userId must be a positive safe integer');
  const joinedAt = timestamp(now);
  const join = database.transaction(() => {
    database.prepare(`
      INSERT INTO room_memberships (room_id, user_id, joined_at)
      VALUES (?, ?, ?)
      ON CONFLICT (room_id, user_id) DO NOTHING
    `).run(roomId, userId, joinedAt);
    return database.prepare(`
      SELECT room_id AS roomId, user_id AS userId, joined_at AS joinedAt
      FROM room_memberships WHERE room_id = ? AND user_id = ?
    `).get(roomId, userId) ?? null;
  });
  return join.immediate();
}

export function listRoomMembers(database, { roomId } = {}) {
  if (typeof roomId !== 'string' || roomId.length === 0) throw new TypeError('roomId is required');
  return database.prepare(`
    SELECT room_id AS roomId, user_id AS userId, joined_at AS joinedAt
    FROM room_memberships WHERE room_id = ? ORDER BY user_id
  `).all(roomId);
}

export function hasRoomMember(database, { roomId, userId } = {}) {
  if (typeof roomId !== 'string' || roomId.length === 0) throw new TypeError('roomId is required');
  if (!Number.isSafeInteger(userId) || userId < 1) throw new TypeError('userId must be a positive safe integer');
  return Boolean(database.prepare(
    'SELECT 1 FROM room_memberships WHERE room_id = ? AND user_id = ?',
  ).get(roomId, userId));
}

export function validateRoomMetadata({ color, icon }) {
  return { color: validateRoomColor(color), icon: validateRoomIcon(icon) };
}

export { LEGACY_ROOM_ID, ROOM_COLOR_PALETTE, ROOM_ICONS };
