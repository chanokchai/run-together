import { randomBytes, scryptSync } from 'node:crypto';
import { normalizeName } from './names.js';
import { LEGACY_ROOM_ID } from './room-contract.js';
import {
  addDays,
  getBangkokDate,
  getCurrentWeekMonday,
  getIsoWeek,
  getWeekRange,
  isDateWritable,
  isMonday,
  isWeekOpen,
  isWeekNavigable,
  parseIsoDate,
} from './calendar.js';

export class VoteError extends Error {
  constructor(status, code, message, { cause } = {}) {
    super(message, { cause });
    this.status = status;
    this.code = code;
  }
}

export class AdminActionError extends Error {
  constructor(status, code, message, { cause } = {}) {
    super(message, { cause });
    this.status = status;
    this.code = code;
  }
}

const VOTE_MESSAGES = {
  invalidDate: 'วันที่ไม่ถูกต้อง / The vote date is invalid.',
  closedDate: 'วันนี้ไม่เปิดให้เลือก / This date is not available for voting.',
  invalidBody: 'ข้อมูลการเลือกไม่ถูกต้อง / The vote selection is invalid.',
};

const RESET_MESSAGES = {
  invalidWeek: 'สัปดาห์ไม่ถูกต้อง / The reset week must be a Monday.',
  closedWeek: 'สัปดาห์นี้รีเซ็ตไม่ได้ / Only an open week can be reset.',
};

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

export function listUsers(database) {
  return database.prepare(`
    SELECT id, name AS displayName, role, created_at AS createdAt, updated_at AS updatedAt
    FROM users
    ORDER BY id ASC
  `).all();
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

export function addVote(database, {
  roomId = LEGACY_ROOM_ID,
  userId,
  voteDate,
  createdAt = new Date().toISOString(),
}) {
  const canonicalDate = formatParsedDate(parseIsoDate(voteDate));
  const result = database.prepare(`
    INSERT INTO votes (room_id, user_id, vote_date, created_at) VALUES (?, ?, ?, ?)
  `).run(roomId, userId, canonicalDate, createdAt);
  return database.prepare('SELECT * FROM votes WHERE id = ?').get(result.lastInsertRowid);
}

function canonicalVoteDate(voteDate) {
  try {
    return formatParsedDate(parseIsoDate(voteDate));
  } catch (error) {
    throw new VoteError(400, 'INVALID_VOTE_DATE', VOTE_MESSAGES.invalidDate, { cause: error });
  }
}

export function assertVoteBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== 1 || !Object.hasOwn(body, 'selected')
    || typeof body.selected !== 'boolean') {
    throw new VoteError(400, 'INVALID_VOTE_REQUEST', VOTE_MESSAGES.invalidBody);
  }
}

function getDayState(database, { roomId, date, currentUserId }) {
  const rows = database.prepare(`
    SELECT votes.user_id AS userId, users.name AS voterName
    FROM votes
    JOIN users ON users.id = votes.user_id
    WHERE votes.room_id = ? AND votes.vote_date = ?
    ORDER BY users.name_key ASC, users.name ASC, votes.user_id ASC
  `).all(roomId, date);
  const voterNames = rows.map(({ voterName }) => voterName);
  return {
    date,
    voteCount: voterNames.length,
    voterNames,
    selected: rows.some(({ userId }) => userId === currentUserId),
  };
}

export function setVote(database, {
  roomId = LEGACY_ROOM_ID,
  userId,
  voteDate,
  now = () => new Date(),
  body,
}) {
  assertVoteBody(body);
  const { selected } = body;
  const canonicalDate = canonicalVoteDate(voteDate);
  const transaction = database.transaction(() => {
    if (!isDateWritable(canonicalDate, now)) {
      throw new VoteError(400, 'VOTE_DATE_CLOSED', VOTE_MESSAGES.closedDate);
    }
    const result = selected
      ? database.prepare(`
        INSERT INTO votes (room_id, user_id, vote_date, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (room_id, user_id, vote_date) DO NOTHING
      `).run(roomId, userId, canonicalDate, timestamp(now))
      : database.prepare('DELETE FROM votes WHERE room_id = ? AND user_id = ? AND vote_date = ?')
        .run(roomId, userId, canonicalDate);
    if (!selected && result.changes > 0) deleteEmptyProposedEvent(database, canonicalDate, roomId);
    return {
      changed: result.changes > 0,
      patch: getDayState(database, { roomId, date: canonicalDate, currentUserId: userId }),
    };
  });
  return transaction();
}

export function getDayPatch(database, { roomId = LEGACY_ROOM_ID, date, currentUserId }) {
  return getDayState(database, { roomId, date: canonicalVoteDate(date), currentUserId });
}

export function getEligiblePeriodVoteTotals(database, { roomId = LEGACY_ROOM_ID, now = () => new Date() } = {}) {
  const startDate = getBangkokDate(now);
  const endDate = addDays(getCurrentWeekMonday(now), 20);
  const counts = database.prepare(`
    SELECT vote_date AS date, COUNT(*) AS voteCount
    FROM votes
    WHERE room_id = ? AND vote_date >= ? AND vote_date <= ?
    GROUP BY vote_date
  `).all(roomId, startDate, endDate);
  const countByDate = new Map(counts.map(({ date, voteCount }) => [date, voteCount]));
  const days = [];
  for (let date = startDate; ; date = addDays(date, 1)) {
    days.push({ date, voteCount: countByDate.get(date) ?? 0 });
    if (date === endDate) break;
  }
  const scheduledDates = database.prepare(`
    SELECT event_date AS date
    FROM run_events
    WHERE room_id = ? AND status = 'scheduled' AND event_date >= ? AND event_date <= ?
    ORDER BY event_date ASC
  `).all(roomId, startDate, endDate).map(({ date }) => date);
  return { startDate, endDate, days, scheduledDates };
}

export function getWeekState(database, { roomId = LEGACY_ROOM_ID, monday, currentUserId, now = () => new Date() }) {
  const { sunday } = getWeekRange(monday);
  const rows = database.prepare(`
    SELECT votes.vote_date AS date, votes.user_id AS userId, users.name AS voterName
    FROM votes
    JOIN users ON users.id = votes.user_id
    WHERE votes.room_id = ? AND votes.vote_date >= ? AND votes.vote_date <= ?
    ORDER BY votes.vote_date ASC, users.name_key ASC, users.name ASC, votes.user_id ASC
  `).all(roomId, monday, sunday);
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
  const today = getBangkokDate(now);
  const events = database.prepare(`
    SELECT event_date AS date
    FROM run_events
    WHERE room_id = ? AND event_date >= ? AND event_date >= ? AND event_date <= ?
    ORDER BY event_date ASC
  `).all(roomId, monday, today, sunday)
    .map(({ date }) => getRunEventForDate(database, { roomId, eventDate: date }));
  const isoWeek = getIsoWeek(monday);
  const nextMonday = addDays(monday, 7);
  return {
    week: {
      monday,
      sunday,
      isoWeek: isoWeek.week,
      isoWeekYear: isoWeek.weekYear,
      resetEligible: isWeekOpen(monday, now),
    },
    navigation: {
      previousMonday: addDays(monday, -7),
      nextMonday: isWeekNavigable(nextMonday, now) ? nextMonday : null,
    },
    currentUserSelectedDates: [...new Set(currentUserSelectedDates)].sort(),
    days,
    events,
  };
}

export function resetWeek(database, { roomId = LEGACY_ROOM_ID, monday, now = () => new Date() }) {
  try {
    parseIsoDate(monday);
  } catch (error) {
    throw new VoteError(400, 'INVALID_RESET_WEEK', RESET_MESSAGES.invalidWeek, { cause: error });
  }
  if (!isMonday(monday)) {
    throw new VoteError(400, 'INVALID_RESET_WEEK', RESET_MESSAGES.invalidWeek);
  }
  if (!isWeekOpen(monday, now)) {
    throw new VoteError(400, 'RESET_WEEK_CLOSED', RESET_MESSAGES.closedWeek);
  }
  const { sunday } = getWeekRange(monday);
  const transaction = database.transaction(() => {
    const affectedDates = database.prepare(`
      SELECT DISTINCT vote_date AS date FROM votes
      WHERE room_id = ? AND vote_date >= ? AND vote_date <= ? ORDER BY vote_date ASC
    `).all(roomId, monday, sunday).map(({ date }) => date);
    const result = database.prepare('DELETE FROM votes WHERE room_id = ? AND vote_date >= ? AND vote_date <= ?')
      .run(roomId, monday, sunday);
    affectedDates.forEach((date) => deleteEmptyProposedEvent(database, date, roomId));
    return { monday, sunday, deletedCount: result.changes, affectedDates };
  });
  return transaction();
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
  return Boolean(deleteUserAndCollectAffectedDates(database, userId));
}

export function deleteUserAndCollectAffectedDates(database, userId) {
  const transaction = database.transaction(() => {
    const user = database.prepare('SELECT id, name, role FROM users WHERE id = ?').get(userId);
    if (!user) return null;
    if (user.role === 'admin') throw new Error('seeded admin cannot be deleted');
    const affectedRoomDates = database.prepare(
      'SELECT DISTINCT room_id, vote_date AS date FROM votes WHERE user_id = ? ORDER BY room_id, vote_date',
    ).all(userId);
    database.prepare('DELETE FROM users WHERE id = ?').run(userId);
    affectedRoomDates.forEach(({ room_id: roomId, date }) => deleteEmptyProposedEvent(database, date, roomId));
    const affectedDates = [...new Set(affectedRoomDates.map(({ date }) => date))];
    return { user, affectedDates };
  });
  return transaction();
}

function formatParsedDate({ year, month, day }) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const ADMIN_ACTION_MESSAGES = {
  targetNotFound: 'ไม่พบผู้ใช้ / User not found.',
  adminProtected: 'ไม่อนุญาตให้แก้ไขผู้ดูแลระบบ / The administrator account cannot be changed.',
  conflict: 'รหัสคำขอถูกใช้กับการกระทำอื่น / The request ID was already used for another action.',
  legacyRoomOnly: 'การดำเนินการนี้รองรับเฉพาะห้องเดิม / This operation only supports the migrated room.',
};

function existingAdminAudit(database, requestId, { adminUserId, targetUserId, action }) {
  const audit = database.prepare('SELECT * FROM admin_action_audit WHERE request_id = ?').get(requestId);
  if (!audit) return null;
  if (audit.admin_user_id !== adminUserId || audit.target_user_id !== targetUserId || audit.action !== action) {
    throw new AdminActionError(409, 'REQUEST_ID_CONFLICT', ADMIN_ACTION_MESSAGES.conflict);
  }
  return {
    deletedVoteCount: audit.deleted_vote_count,
    requestId: audit.request_id,
    replayed: true,
    affectedDates: [],
  };
}

function requireNormalTarget(database, targetUserId) {
  const target = database.prepare('SELECT id, name, role FROM users WHERE id = ?').get(targetUserId);
  if (!target) throw new AdminActionError(404, 'USER_NOT_FOUND', ADMIN_ACTION_MESSAGES.targetNotFound);
  if (target.role === 'admin') throw new AdminActionError(403, 'ADMIN_PROTECTED', ADMIN_ACTION_MESSAGES.adminProtected);
  return target;
}

function affectedVotes(database, targetUserId, roomId = LEGACY_ROOM_ID) {
  return database.prepare(
    'SELECT DISTINCT vote_date AS date FROM votes WHERE room_id = ? AND user_id = ? ORDER BY vote_date ASC',
  ).all(roomId, targetUserId).map(({ date }) => date);
}

function affectedRoomVotes(database, targetUserId) {
  return database.prepare(
    'SELECT DISTINCT room_id AS roomId, vote_date AS date FROM votes WHERE user_id = ? ORDER BY room_id, vote_date',
  ).all(targetUserId);
}

function insertAdminAudit(database, { requestId, adminUserId, targetUserId, targetName, action, deletedVoteCount, occurredAt }) {
  database.prepare(`
    INSERT INTO admin_action_audit
      (request_id, admin_user_id, target_user_id, target_name, action, deleted_vote_count, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(requestId, adminUserId, targetUserId, targetName, action, deletedVoteCount, occurredAt);
}

export function resetUserVotes(database, {
  roomId = LEGACY_ROOM_ID,
  adminUserId,
  targetUserId,
  requestId,
  now = () => new Date(),
}) {
  if (roomId !== LEGACY_ROOM_ID) {
    throw new AdminActionError(400, 'ROOM_SCOPE_UNSUPPORTED', ADMIN_ACTION_MESSAGES.legacyRoomOnly);
  }
  const transaction = database.transaction(() => {
    const replay = existingAdminAudit(database, requestId, { adminUserId, targetUserId, action: 'reset_votes' });
    if (replay) return replay;
    const target = requireNormalTarget(database, targetUserId);
    const affectedDates = affectedVotes(database, targetUserId, roomId);
    const deletedVoteCount = database.prepare('DELETE FROM votes WHERE room_id = ? AND user_id = ?')
      .run(roomId, targetUserId).changes;
    affectedDates.forEach((date) => deleteEmptyProposedEvent(database, date, roomId));
    insertAdminAudit(database, {
      requestId,
      adminUserId,
      targetUserId,
      targetName: target.name,
      action: 'reset_votes',
      deletedVoteCount,
      occurredAt: timestamp(now),
    });
    return { deletedVoteCount, requestId, replayed: false, affectedDates };
  });
  return transaction();
}

export function deleteUserWithAudit(database, { adminUserId, targetUserId, requestId, now = () => new Date() }) {
  const transaction = database.transaction(() => {
    const replay = existingAdminAudit(database, requestId, { adminUserId, targetUserId, action: 'delete_user' });
    if (replay) return replay;
    const target = requireNormalTarget(database, targetUserId);
    const affectedRoomDates = affectedRoomVotes(database, targetUserId);
    const deletedVoteCount = database.prepare('SELECT COUNT(*) AS count FROM votes WHERE user_id = ?').get(targetUserId).count;
    insertAdminAudit(database, {
      requestId,
      adminUserId,
      targetUserId,
      targetName: target.name,
      action: 'delete_user',
      deletedVoteCount,
      occurredAt: timestamp(now),
    });
    database.prepare('DELETE FROM users WHERE id = ?').run(targetUserId);
    affectedRoomDates.forEach(({ roomId, date }) => deleteEmptyProposedEvent(database, date, roomId));
    const affectedDates = [...new Set(affectedRoomDates.map(({ date }) => date))];
    return { deletedVoteCount, requestId, replayed: false, affectedDates };
  });
  return transaction();
}

const RUN_EVENT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class RunEventError extends Error {
  constructor(status, code, message, { cause } = {}) {
    super(message, { cause });
    this.status = status;
    this.code = code;
  }
}

const RUN_EVENT_MESSAGES = {
  invalidDate: 'วันที่กิจกรรมไม่ถูกต้อง / The event date is invalid.',
  closedDate: 'วันนี้ไม่เปิดให้เลือก / This event date is not available.',
  invalidRequest: 'คำขอกิจกรรมไม่ถูกต้อง / The event request is invalid.',
  notMember: 'ไม่พบสมาชิกปัจจุบัน / The current member is not available.',
  notVoter: 'ต้องเลือกวันที่นี้ก่อน / Vote for this date before changing its proposal.',
  adminRequired: 'ต้องเป็นผู้ดูแลระบบ / Administrator access is required.',
  eventExists: 'มีข้อเสนอสำหรับวันนี้แล้ว / An event already exists for this date.',
  staleEvent: 'กิจกรรมมีการเปลี่ยนแปลงแล้ว / This event has changed; reload and try again.',
  scheduledLocked: 'กิจกรรมที่กำหนดแล้วเปลี่ยนจากบัตรวันไม่ได้ / A scheduled event cannot be changed from the date card.',
  requestConflict: 'รหัสคำขอนี้ถูกใช้กับการกระทำอื่น / The request ID was already used for another action.',
};

function canonicalEventDate(value) {
  try {
    return formatParsedDate(parseIsoDate(value));
  } catch (error) {
    throw new RunEventError(400, 'INVALID_RUN_EVENT_DATE', RUN_EVENT_MESSAGES.invalidDate, { cause: error });
  }
}

function assertRunEventRequestId(requestId) {
  if (typeof requestId !== 'string' || !RUN_EVENT_UUID.test(requestId)) {
    throw new RunEventError(400, 'INVALID_RUN_EVENT_REQUEST', RUN_EVENT_MESSAGES.invalidRequest);
  }
}

function assertRunEventExpectation(eventId, revision) {
  if (!Number.isSafeInteger(eventId) || eventId < 1
    || !Number.isSafeInteger(revision) || revision < 1) {
    throw new RunEventError(400, 'INVALID_RUN_EVENT_REQUEST', RUN_EVENT_MESSAGES.invalidRequest);
  }
}

function assertWritableEventDate(eventDate, now) {
  if (!isDateWritable(eventDate, now)) {
    throw new RunEventError(400, 'RUN_EVENT_DATE_CLOSED', RUN_EVENT_MESSAGES.closedDate);
  }
}

function requireCurrentEventMember(database, userId, roomId, { admin = false } = {}) {
  const user = database.prepare('SELECT id, role FROM users WHERE id = ?').get(userId);
  if (!user) throw new RunEventError(403, 'RUN_EVENT_MEMBER_REQUIRED', RUN_EVENT_MESSAGES.notMember);
  const membership = database.prepare(
    'SELECT 1 FROM room_memberships WHERE room_id = ? AND user_id = ?',
  ).get(roomId, userId);
  if (!membership) throw new RunEventError(403, 'RUN_EVENT_MEMBER_REQUIRED', RUN_EVENT_MESSAGES.notMember);
  if (admin && user.role !== 'admin') {
    throw new RunEventError(403, 'RUN_EVENT_ADMIN_REQUIRED', RUN_EVENT_MESSAGES.adminRequired);
  }
  return user;
}

function runEventRequestSignature(request) {
  return {
    actorUserId: request.actorUserId,
    action: request.action,
    eventDate: request.eventDate,
    eventId: request.eventId ?? null,
    expectedRevision: request.expectedRevision ?? null,
    requestedStatus: request.requestedStatus ?? null,
  };
}

function replayRunEventRequest(database, request) {
  const existing = database.prepare(
    'SELECT * FROM run_event_requests WHERE room_id = ? AND request_id = ?',
  ).get(request.roomId, request.requestId);
  if (!existing) return null;
  const expected = runEventRequestSignature(request);
  if (existing.actor_user_id !== expected.actorUserId
    || existing.action !== expected.action
    || existing.event_date !== expected.eventDate
    || existing.event_id !== expected.eventId
    || existing.expected_revision !== expected.expectedRevision
    || existing.requested_status !== expected.requestedStatus) {
    throw new RunEventError(409, 'RUN_EVENT_REQUEST_ID_CONFLICT', RUN_EVENT_MESSAGES.requestConflict);
  }
  return {
    changed: false,
    replayed: true,
    event: getRunEventForDate(database, { roomId: request.roomId, eventDate: request.eventDate }),
  };
}

function recordRunEventRequest(database, request, { now = () => new Date() } = {}) {
  const signature = runEventRequestSignature(request);
  database.prepare(`
    INSERT INTO run_event_requests
      (room_id, request_id, actor_user_id, action, event_date, event_id, expected_revision, requested_status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    request.roomId,
    request.requestId,
    signature.actorUserId,
    signature.action,
    signature.eventDate,
    signature.eventId,
    signature.expectedRevision,
    signature.requestedStatus,
    timestamp(now),
  );
}

function requireCurrentDateVoter(database, userId, eventDate, roomId) {
  const vote = database.prepare(
    'SELECT 1 AS present FROM votes WHERE room_id = ? AND user_id = ? AND vote_date = ?',
  ).get(roomId, userId, eventDate);
  if (!vote) throw new RunEventError(403, 'RUN_EVENT_VOTER_REQUIRED', RUN_EVENT_MESSAGES.notVoter);
}

function deleteEmptyProposedEvent(database, eventDate, roomId = LEGACY_ROOM_ID) {
  const voteCount = database.prepare('SELECT COUNT(*) AS count FROM votes WHERE room_id = ? AND vote_date = ?')
    .get(roomId, eventDate).count;
  if (voteCount !== 0) return false;
  return database.prepare("DELETE FROM run_events WHERE room_id = ? AND event_date = ? AND status = 'proposed'")
    .run(roomId, eventDate).changes > 0;
}

function assertFreshRunEvent(event, { eventId, revision }) {
  if (!event || event.id !== eventId || event.revision !== revision) {
    throw new RunEventError(409, 'STALE_RUN_EVENT', RUN_EVENT_MESSAGES.staleEvent);
  }
}

export function getRunEventForDate(database, { roomId = LEGACY_ROOM_ID, eventDate }) {
  const canonicalDate = canonicalEventDate(eventDate);
  const event = database.prepare(`
    SELECT events.id, events.event_date, events.status, events.revision,
      events.proposed_at, proposer.name AS proposed_by,
      events.scheduled_at, scheduler.name AS scheduled_by
    FROM run_events AS events
    LEFT JOIN users AS proposer ON proposer.id = events.proposed_by
    LEFT JOIN users AS scheduler ON scheduler.id = events.scheduled_by
    WHERE events.room_id = ? AND events.event_date = ?
  `).get(roomId, canonicalDate);
  if (!event) return null;
  const voterNames = database.prepare(`
    SELECT users.name
    FROM votes JOIN users ON users.id = votes.user_id
    WHERE votes.room_id = ? AND votes.vote_date = ?
    ORDER BY users.name_key ASC, users.name ASC, users.id ASC
  `).all(roomId, canonicalDate).map(({ name }) => name);
  return {
    eventId: event.id,
    date: event.event_date,
    status: event.status,
    revision: event.revision,
    proposedAt: event.proposed_at,
    proposedBy: event.proposed_by,
    scheduledAt: event.scheduled_at,
    scheduledBy: event.scheduled_by,
    voteCount: voterNames.length,
    voterNames,
  };
}

export function proposeRunEvent(database, {
  roomId = LEGACY_ROOM_ID,
  userId,
  eventDate,
  requestId,
  now = () => new Date(),
}) {
  const canonicalDate = canonicalEventDate(eventDate);
  assertRunEventRequestId(requestId);
  const request = {
    roomId, requestId, actorUserId: userId, action: 'propose', eventDate: canonicalDate, requestedStatus: 'proposed',
  };
  const transaction = database.transaction(() => {
    requireCurrentEventMember(database, userId, roomId);
    const replay = replayRunEventRequest(database, request);
    if (replay) return replay;
    assertWritableEventDate(canonicalDate, now);
    requireCurrentDateVoter(database, userId, canonicalDate, roomId);
    if (database.prepare('SELECT id FROM run_events WHERE room_id = ? AND event_date = ?').get(roomId, canonicalDate)) {
      throw new RunEventError(409, 'RUN_EVENT_ALREADY_EXISTS', RUN_EVENT_MESSAGES.eventExists);
    }
    let eventId;
    try {
      const inserted = database.prepare(`
        INSERT INTO run_events (room_id, event_date, status, revision, proposed_by, proposed_at)
        VALUES (?, ?, 'proposed', 1, ?, ?)
      `).run(roomId, canonicalDate, userId, timestamp(now));
      eventId = Number(inserted.lastInsertRowid);
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new RunEventError(409, 'RUN_EVENT_ALREADY_EXISTS', RUN_EVENT_MESSAGES.eventExists, { cause: error });
      }
      throw error;
    }
    recordRunEventRequest(database, request, { now });
    return {
      changed: true,
      replayed: false,
      event: getRunEventForDate(database, { roomId, eventDate: canonicalDate }),
    };
  });
  return transaction();
}

export function withdrawRunEvent(database, {
  roomId = LEGACY_ROOM_ID,
  userId,
  eventDate,
  eventId,
  revision,
  requestId,
  now = () => new Date(),
}) {
  const canonicalDate = canonicalEventDate(eventDate);
  assertRunEventRequestId(requestId);
  assertRunEventExpectation(eventId, revision);
  const request = {
    roomId, requestId, actorUserId: userId, action: 'withdraw',
    eventDate: canonicalDate, eventId, expectedRevision: revision,
  };
  const transaction = database.transaction(() => {
    requireCurrentEventMember(database, userId, roomId);
    const replay = replayRunEventRequest(database, request);
    if (replay) return replay;
    assertWritableEventDate(canonicalDate, now);
    requireCurrentDateVoter(database, userId, canonicalDate, roomId);
    const current = database.prepare(
      'SELECT id, status, revision FROM run_events WHERE room_id = ? AND event_date = ?',
    ).get(roomId, canonicalDate);
    assertFreshRunEvent(current, { eventId, revision });
    if (current.status !== 'proposed') {
      throw new RunEventError(409, 'RUN_EVENT_SCHEDULED', RUN_EVENT_MESSAGES.scheduledLocked);
    }
    database.prepare('DELETE FROM run_events WHERE room_id = ? AND id = ?').run(roomId, eventId);
    recordRunEventRequest(database, request, { now });
    return { changed: true, replayed: false, event: null };
  });
  return transaction();
}

export function setRunEventStatus(database, {
  roomId = LEGACY_ROOM_ID,
  adminUserId,
  eventDate,
  eventId,
  revision,
  status,
  requestId,
  now = () => new Date(),
}) {
  const canonicalDate = canonicalEventDate(eventDate);
  assertRunEventRequestId(requestId);
  assertRunEventExpectation(eventId, revision);
  if (status !== 'proposed' && status !== 'scheduled') {
    throw new RunEventError(400, 'INVALID_RUN_EVENT_REQUEST', RUN_EVENT_MESSAGES.invalidRequest);
  }
  const action = status === 'scheduled' ? 'schedule' : 'revert';
  const request = {
    roomId, requestId, actorUserId: adminUserId, action, eventDate: canonicalDate, eventId,
    expectedRevision: revision, requestedStatus: status,
  };
  const transaction = database.transaction(() => {
    requireCurrentEventMember(database, adminUserId, roomId, { admin: true });
    const replay = replayRunEventRequest(database, request);
    if (replay) return replay;
    assertWritableEventDate(canonicalDate, now);
    const current = database.prepare(
      'SELECT id, status, revision FROM run_events WHERE room_id = ? AND event_date = ?',
    ).get(roomId, canonicalDate);
    assertFreshRunEvent(current, { eventId, revision });
    let changed = false;
    if (current.status !== status) {
      if (status === 'scheduled') {
        database.prepare(`
          UPDATE run_events
          SET status = 'scheduled', revision = revision + 1, scheduled_by = ?, scheduled_at = ?
          WHERE room_id = ? AND id = ? AND revision = ?
        `).run(adminUserId, timestamp(now), roomId, eventId, revision);
      } else {
        const votes = database.prepare('SELECT COUNT(*) AS count FROM votes WHERE room_id = ? AND vote_date = ?')
          .get(roomId, canonicalDate).count;
        if (votes === 0) {
          database.prepare("DELETE FROM run_events WHERE room_id = ? AND id = ? AND revision = ? AND status = 'scheduled'")
            .run(roomId, eventId, revision);
        } else {
          database.prepare(`
            UPDATE run_events
            SET status = 'proposed', revision = revision + 1, scheduled_by = NULL, scheduled_at = NULL
            WHERE room_id = ? AND id = ? AND revision = ?
          `).run(roomId, eventId, revision);
        }
      }
      changed = true;
    }
    recordRunEventRequest(database, request, { now });
    return {
      changed,
      replayed: false,
      event: getRunEventForDate(database, { roomId, eventDate: canonicalDate }),
    };
  });
  return transaction();
}

export function deleteRunEvent(database, {
  roomId = LEGACY_ROOM_ID,
  adminUserId,
  eventDate,
  eventId,
  revision,
  requestId,
  now = () => new Date(),
}) {
  const canonicalDate = canonicalEventDate(eventDate);
  assertRunEventRequestId(requestId);
  assertRunEventExpectation(eventId, revision);
  const request = {
    roomId, requestId, actorUserId: adminUserId, action: 'delete',
    eventDate: canonicalDate, eventId, expectedRevision: revision,
  };
  const transaction = database.transaction(() => {
    requireCurrentEventMember(database, adminUserId, roomId, { admin: true });
    const replay = replayRunEventRequest(database, request);
    if (replay) return replay;
    assertWritableEventDate(canonicalDate, now);
    const current = database.prepare(
      'SELECT id, status, revision FROM run_events WHERE room_id = ? AND event_date = ?',
    ).get(roomId, canonicalDate);
    assertFreshRunEvent(current, { eventId, revision });
    database.prepare('DELETE FROM run_events WHERE room_id = ? AND id = ? AND revision = ?')
      .run(roomId, eventId, revision);
    recordRunEventRequest(database, request, { now });
    return { changed: true, replayed: false, event: null };
  });
  return transaction();
}