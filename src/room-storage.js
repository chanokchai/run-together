import { randomInt, randomUUID } from 'node:crypto';
import {
  DEFAULT_ROOM_ICON,
  LEGACY_ROOM_ID,
  ROOM_COLOR_PALETTE,
  ROOM_ICONS,
} from './room-contract.js';
import { getBangkokDate } from './calendar.js';

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

function validateRoomVenue(value = '') {
  if (typeof value !== 'string') throw new TypeError('room venue must be a string');
  const venue = value.trim();
  if (Array.from(venue).length > 30) throw new RangeError('room venue must contain at most 30 characters');
  return venue;
}

function validateRoomTime(value = '') {
  if (typeof value !== 'string') throw new TypeError('room time must be a string');
  if (value !== '' && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new RangeError('room time must use valid 24-hour HH:mm format');
  }
  return value;
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
    venue: row.venue ?? '',
    time: row.time ?? '',
  };
}

export function createRoom(database, {
  creatorUserId,
  title,
  color = ROOM_COLOR_PALETTE[randomInt(ROOM_COLOR_PALETTE.length)],
  icon = DEFAULT_ROOM_ICON,
  venue = '',
  time = '',
  now = () => new Date(),
} = {}) {
  const roomTitle = validateRoomTitle(title);
  const roomColor = validateRoomColor(color);
  const roomIcon = validateRoomIcon(icon);
  const roomVenue = validateRoomVenue(venue);
  const roomTime = validateRoomTime(time);
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
      INSERT INTO rooms (id, display_number, title, color, icon, owner_user_id, created_at, venue, time)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(roomId, counter.next_display_number, roomTitle, roomColor, roomIcon, creatorUserId, createdAt, roomVenue, roomTime);
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

function summarizeRoomEvents(database, roomId, today) {
  const events = database.prepare(`
    SELECT event_date AS date, status
    FROM run_events
    WHERE room_id = ? AND event_date >= ?
    ORDER BY event_date ASC
  `).all(roomId, today);
  const scheduledDates = events.filter(({ status }) => status === 'scheduled').map(({ date }) => date);
  const proposedDates = events.filter(({ status }) => status === 'proposed').map(({ date }) => date);
  return {
    roomId,
    scheduledDates,
    proposedDates,
    earliestDate: events[0]?.date ?? null,
    hasUpcomingEvents: events.length > 0,
  };
}

export function getRoomSummary(database, { roomId, now = () => new Date() } = {}) {
  if (typeof roomId !== 'string' || roomId.length === 0) throw new TypeError('roomId is required');
  return summarizeRoomEvents(database, roomId, getBangkokDate(now));
}

export function listRooms(database, { now = () => new Date(), currentUserId } = {}) {
  const today = getBangkokDate(now);
  const hasViewer = Number.isSafeInteger(currentUserId) && currentUserId > 0;
  const viewerSelect = hasViewer
    ? ', EXISTS(SELECT 1 FROM votes AS viewer_votes WHERE viewer_votes.room_id = rooms.id AND viewer_votes.user_id = ? AND viewer_votes.vote_date >= ?) AS my_voted'
    : '';
  const parameters = hasViewer ? [today, currentUserId, today] : [today];
  return database.prepare(`
    SELECT rooms.*, owner.name AS owner_display_name,
      (SELECT COUNT(DISTINCT votes.user_id)
       FROM votes JOIN users ON users.id = votes.user_id
       WHERE votes.room_id = rooms.id AND votes.vote_date >= ?) AS voter_count
      ${viewerSelect}
    FROM rooms
    LEFT JOIN users AS owner ON owner.id = rooms.owner_user_id
    ORDER BY rooms.display_number, rooms.title, rooms.id
  `).all(...parameters)
    .map((row) => ({
      ...roomFromRow(row),
      ownerDisplayName: row.owner_display_name ?? '',
      voterCount: row.voter_count,
      ...(hasViewer ? { myVoted: Boolean(row.my_voted) } : {}),
      summary: summarizeRoomEvents(database, row.id, today),
    }))
    .sort((left, right) => (left.summary.earliestDate ?? '9999-12-31').localeCompare(right.summary.earliestDate ?? '9999-12-31')
      || left.displayNumber - right.displayNumber
      || left.title.localeCompare(right.title)
      || left.id.localeCompare(right.id));
}

export function updateRoomMetadata(database, { roomId, title, icon, venue, time } = {}) {
  if (typeof roomId !== 'string' || roomId.length === 0) throw new TypeError('roomId is required');
  if (title === undefined && icon === undefined && venue === undefined && time === undefined) {
    throw new TypeError('room title, icon, venue, or time is required');
  }
  const current = getRoom(database, { roomId });
  if (!current) return null;
  const roomTitle = title === undefined ? current.title : validateRoomTitle(title);
  const roomIcon = icon === undefined ? current.icon : validateRoomIcon(icon);
  const roomVenue = venue === undefined ? current.venue : validateRoomVenue(venue);
  const roomTime = time === undefined ? current.time : validateRoomTime(time);
  database.prepare('UPDATE rooms SET title = ?, icon = ?, venue = ?, time = ? WHERE id = ?')
    .run(roomTitle, roomIcon, roomVenue, roomTime, roomId);
  return getRoom(database, { roomId });
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

export { LEGACY_ROOM_ID, ROOM_COLOR_PALETTE, ROOM_ICONS, validateRoomTime, validateRoomVenue };
