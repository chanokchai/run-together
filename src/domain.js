import { randomBytes, scryptSync } from 'node:crypto';
import { normalizeName } from './names.js';
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

export function addVote(database, { userId, voteDate, createdAt = new Date().toISOString() }) {
  const canonicalDate = formatParsedDate(parseIsoDate(voteDate));
  const result = database.prepare(`
    INSERT INTO votes (user_id, vote_date, created_at) VALUES (?, ?, ?)
  `).run(userId, canonicalDate, createdAt);
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

function getDayState(database, { date, currentUserId }) {
  const rows = database.prepare(`
    SELECT votes.user_id AS userId, users.name AS voterName
    FROM votes
    JOIN users ON users.id = votes.user_id
    WHERE votes.vote_date = ?
    ORDER BY users.name_key ASC, users.name ASC, votes.user_id ASC
  `).all(date);
  const voterNames = rows.map(({ voterName }) => voterName);
  return {
    date,
    voteCount: voterNames.length,
    voterNames,
    selected: rows.some(({ userId }) => userId === currentUserId),
  };
}

export function setVote(database, { userId, voteDate, now = () => new Date(), body }) {
  assertVoteBody(body);
  const { selected } = body;
  const canonicalDate = canonicalVoteDate(voteDate);
  const transaction = database.transaction(() => {
    if (!isDateWritable(canonicalDate, now)) {
      throw new VoteError(400, 'VOTE_DATE_CLOSED', VOTE_MESSAGES.closedDate);
    }
    const result = selected
      ? database.prepare(`
        INSERT INTO votes (user_id, vote_date, created_at)
        VALUES (?, ?, ?)
        ON CONFLICT (user_id, vote_date) DO NOTHING
      `).run(userId, canonicalDate, timestamp(now))
      : database.prepare('DELETE FROM votes WHERE user_id = ? AND vote_date = ?').run(userId, canonicalDate);
    if (!selected && result.changes > 0) deleteEmptyProposedEvent(database, canonicalDate);
    return {
      changed: result.changes > 0,
      patch: getDayState(database, { date: canonicalDate, currentUserId: userId }),
    };
  });
  return transaction();
}

export function getDayPatch(database, { date, currentUserId }) {
  return getDayState(database, { date: canonicalVoteDate(date), currentUserId });
}

export function getEligiblePeriodVoteTotals(database, { now = () => new Date() } = {}) {
  const startDate = getBangkokDate(now);
  const endDate = addDays(getCurrentWeekMonday(now), 20);
  const counts = database.prepare(`
    SELECT vote_date AS date, COUNT(*) AS voteCount
    FROM votes
    WHERE vote_date >= ? AND vote_date <= ?
    GROUP BY vote_date
  `).all(startDate, endDate);
  const countByDate = new Map(counts.map(({ date, voteCount }) => [date, voteCount]));
  const days = [];
  for (let date = startDate; ; date = addDays(date, 1)) {
    days.push({ date, voteCount: countByDate.get(date) ?? 0 });
    if (date === endDate) break;
  }
  return { startDate, endDate, days };
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
  const today = getBangkokDate(now);
  const events = database.prepare(`
    SELECT event_date AS date
    FROM run_events
    WHERE event_date >= ? AND event_date >= ? AND event_date <= ?
    ORDER BY event_date ASC
  `).all(monday, today, sunday).map(({ date }) => getRunEventForDate(database, { eventDate: date }));
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

export function resetWeek(database, { monday, now = () => new Date() }) {
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
      WHERE vote_date >= ? AND vote_date <= ? ORDER BY vote_date ASC
    `).all(monday, sunday).map(({ date }) => date);
    const result = database.prepare('DELETE FROM votes WHERE vote_date >= ? AND vote_date <= ?').run(monday, sunday);
    affectedDates.forEach((date) => deleteEmptyProposedEvent(database, date));
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
    const affectedDates = database.prepare(
      'SELECT DISTINCT vote_date AS date FROM votes WHERE user_id = ? ORDER BY vote_date ASC',
    ).all(userId).map(({ date }) => date);
    database.prepare('DELETE FROM users WHERE id = ?').run(userId);
    affectedDates.forEach((date) => deleteEmptyProposedEvent(database, date));
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

function affectedVotes(database, targetUserId) {
  return database.prepare(
    'SELECT DISTINCT vote_date AS date FROM votes WHERE user_id = ? ORDER BY vote_date ASC',
  ).all(targetUserId).map(({ date }) => date);
}

function insertAdminAudit(database, { requestId, adminUserId, targetUserId, targetName, action, deletedVoteCount, occurredAt }) {
  database.prepare(`
    INSERT INTO admin_action_audit
      (request_id, admin_user_id, target_user_id, target_name, action, deleted_vote_count, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(requestId, adminUserId, targetUserId, targetName, action, deletedVoteCount, occurredAt);
}

export function resetUserVotes(database, { adminUserId, targetUserId, requestId, now = () => new Date() }) {
  const transaction = database.transaction(() => {
    const replay = existingAdminAudit(database, requestId, { adminUserId, targetUserId, action: 'reset_votes' });
    if (replay) return replay;
    const target = requireNormalTarget(database, targetUserId);
    const affectedDates = affectedVotes(database, targetUserId);
    const deletedVoteCount = database.prepare('DELETE FROM votes WHERE user_id = ?').run(targetUserId).changes;
    affectedDates.forEach((date) => deleteEmptyProposedEvent(database, date));
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
    const affectedDates = affectedVotes(database, targetUserId);
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
    affectedDates.forEach((date) => deleteEmptyProposedEvent(database, date));
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

function requireCurrentEventMember(database, userId, { admin = false } = {}) {
  const user = database.prepare('SELECT id, role FROM users WHERE id = ?').get(userId);
  if (!user) throw new RunEventError(403, 'RUN_EVENT_MEMBER_REQUIRED', RUN_EVENT_MESSAGES.notMember);
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
  const existing = database.prepare('SELECT * FROM run_event_requests WHERE request_id = ?').get(request.requestId);
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
  return { changed: false, replayed: true, event: getRunEventForDate(database, { eventDate: request.eventDate }) };
}

function recordRunEventRequest(database, request, { now = () => new Date() } = {}) {
  const signature = runEventRequestSignature(request);
  database.prepare(`
    INSERT INTO run_event_requests
      (request_id, actor_user_id, action, event_date, event_id, expected_revision, requested_status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
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

function requireCurrentDateVoter(database, userId, eventDate) {
  const vote = database.prepare(
    'SELECT 1 AS present FROM votes WHERE user_id = ? AND vote_date = ?',
  ).get(userId, eventDate);
  if (!vote) throw new RunEventError(403, 'RUN_EVENT_VOTER_REQUIRED', RUN_EVENT_MESSAGES.notVoter);
}

function deleteEmptyProposedEvent(database, eventDate) {
  const voteCount = database.prepare('SELECT COUNT(*) AS count FROM votes WHERE vote_date = ?').get(eventDate).count;
  if (voteCount !== 0) return false;
  return database.prepare("DELETE FROM run_events WHERE event_date = ? AND status = 'proposed'").run(eventDate).changes > 0;
}

function assertFreshRunEvent(event, { eventId, revision }) {
  if (!event || event.id !== eventId || event.revision !== revision) {
    throw new RunEventError(409, 'STALE_RUN_EVENT', RUN_EVENT_MESSAGES.staleEvent);
  }
}

export function getRunEventForDate(database, { eventDate }) {
  const canonicalDate = canonicalEventDate(eventDate);
  const event = database.prepare(`
    SELECT events.id, events.event_date, events.status, events.revision,
      events.proposed_at, proposer.name AS proposed_by,
      events.scheduled_at, scheduler.name AS scheduled_by
    FROM run_events AS events
    LEFT JOIN users AS proposer ON proposer.id = events.proposed_by
    LEFT JOIN users AS scheduler ON scheduler.id = events.scheduled_by
    WHERE events.event_date = ?
  `).get(canonicalDate);
  if (!event) return null;
  const voterNames = database.prepare(`
    SELECT users.name
    FROM votes JOIN users ON users.id = votes.user_id
    WHERE votes.vote_date = ?
    ORDER BY users.name_key ASC, users.name ASC, users.id ASC
  `).all(canonicalDate).map(({ name }) => name);
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

export function proposeRunEvent(database, { userId, eventDate, requestId, now = () => new Date() }) {
  const canonicalDate = canonicalEventDate(eventDate);
  assertRunEventRequestId(requestId);
  const request = {
    requestId, actorUserId: userId, action: 'propose', eventDate: canonicalDate, requestedStatus: 'proposed',
  };
  const transaction = database.transaction(() => {
    requireCurrentEventMember(database, userId);
    const replay = replayRunEventRequest(database, request);
    if (replay) return replay;
    assertWritableEventDate(canonicalDate, now);
    requireCurrentDateVoter(database, userId, canonicalDate);
    if (database.prepare('SELECT id FROM run_events WHERE event_date = ?').get(canonicalDate)) {
      throw new RunEventError(409, 'RUN_EVENT_ALREADY_EXISTS', RUN_EVENT_MESSAGES.eventExists);
    }
    let eventId;
    try {
      const inserted = database.prepare(`
        INSERT INTO run_events (event_date, status, revision, proposed_by, proposed_at)
        VALUES (?, 'proposed', 1, ?, ?)
      `).run(canonicalDate, userId, timestamp(now));
      eventId = Number(inserted.lastInsertRowid);
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new RunEventError(409, 'RUN_EVENT_ALREADY_EXISTS', RUN_EVENT_MESSAGES.eventExists, { cause: error });
      }
      throw error;
    }
    recordRunEventRequest(database, request, { now });
    return { changed: true, replayed: false, event: getRunEventForDate(database, { eventDate: canonicalDate }) };
  });
  return transaction();
}

export function withdrawRunEvent(database, { userId, eventDate, eventId, revision, requestId, now = () => new Date() }) {
  const canonicalDate = canonicalEventDate(eventDate);
  assertRunEventRequestId(requestId);
  assertRunEventExpectation(eventId, revision);
  const request = { requestId, actorUserId: userId, action: 'withdraw', eventDate: canonicalDate, eventId, expectedRevision: revision };
  const transaction = database.transaction(() => {
    requireCurrentEventMember(database, userId);
    const replay = replayRunEventRequest(database, request);
    if (replay) return replay;
    assertWritableEventDate(canonicalDate, now);
    requireCurrentDateVoter(database, userId, canonicalDate);
    const current = database.prepare('SELECT id, status, revision FROM run_events WHERE event_date = ?').get(canonicalDate);
    assertFreshRunEvent(current, { eventId, revision });
    if (current.status !== 'proposed') {
      throw new RunEventError(409, 'RUN_EVENT_SCHEDULED', RUN_EVENT_MESSAGES.scheduledLocked);
    }
    database.prepare('DELETE FROM run_events WHERE id = ?').run(eventId);
    recordRunEventRequest(database, request, { now });
    return { changed: true, replayed: false, event: null };
  });
  return transaction();
}

export function setRunEventStatus(database, {
  adminUserId, eventDate, eventId, revision, status, requestId, now = () => new Date(),
}) {
  const canonicalDate = canonicalEventDate(eventDate);
  assertRunEventRequestId(requestId);
  assertRunEventExpectation(eventId, revision);
  if (status !== 'proposed' && status !== 'scheduled') {
    throw new RunEventError(400, 'INVALID_RUN_EVENT_REQUEST', RUN_EVENT_MESSAGES.invalidRequest);
  }
  const action = status === 'scheduled' ? 'schedule' : 'revert';
  const request = {
    requestId, actorUserId: adminUserId, action, eventDate: canonicalDate, eventId,
    expectedRevision: revision, requestedStatus: status,
  };
  const transaction = database.transaction(() => {
    requireCurrentEventMember(database, adminUserId, { admin: true });
    const replay = replayRunEventRequest(database, request);
    if (replay) return replay;
    assertWritableEventDate(canonicalDate, now);
    const current = database.prepare('SELECT id, status, revision FROM run_events WHERE event_date = ?').get(canonicalDate);
    assertFreshRunEvent(current, { eventId, revision });
    let changed = false;
    if (current.status !== status) {
      if (status === 'scheduled') {
        database.prepare(`
          UPDATE run_events
          SET status = 'scheduled', revision = revision + 1, scheduled_by = ?, scheduled_at = ?
          WHERE id = ? AND revision = ?
        `).run(adminUserId, timestamp(now), eventId, revision);
      } else {
        const votes = database.prepare('SELECT COUNT(*) AS count FROM votes WHERE vote_date = ?').get(canonicalDate).count;
        if (votes === 0) {
          database.prepare("DELETE FROM run_events WHERE id = ? AND revision = ? AND status = 'scheduled'").run(eventId, revision);
        } else {
          database.prepare(`
            UPDATE run_events
            SET status = 'proposed', revision = revision + 1, scheduled_by = NULL, scheduled_at = NULL
            WHERE id = ? AND revision = ?
          `).run(eventId, revision);
        }
      }
      changed = true;
    }
    recordRunEventRequest(database, request, { now });
    return { changed, replayed: false, event: getRunEventForDate(database, { eventDate: canonicalDate }) };
  });
  return transaction();
}

export function deleteRunEvent(database, { adminUserId, eventDate, eventId, revision, requestId, now = () => new Date() }) {
  const canonicalDate = canonicalEventDate(eventDate);
  assertRunEventRequestId(requestId);
  assertRunEventExpectation(eventId, revision);
  const request = { requestId, actorUserId: adminUserId, action: 'delete', eventDate: canonicalDate, eventId, expectedRevision: revision };
  const transaction = database.transaction(() => {
    requireCurrentEventMember(database, adminUserId, { admin: true });
    const replay = replayRunEventRequest(database, request);
    if (replay) return replay;
    assertWritableEventDate(canonicalDate, now);
    const current = database.prepare('SELECT id, status, revision FROM run_events WHERE event_date = ?').get(canonicalDate);
    assertFreshRunEvent(current, { eventId, revision });
    database.prepare('DELETE FROM run_events WHERE id = ? AND revision = ?').run(eventId, revision);
    recordRunEventRequest(database, request, { now });
    return { changed: true, replayed: false, event: null };
  });
  return transaction();
}