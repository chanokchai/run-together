import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { once } from 'node:events';
import { io as connectSocket } from 'socket.io-client';
import { createServer } from '../src/server.js';
import { openDatabase, migrate } from '../src/database.js';
import { LEGACY_ROOM_ID } from '../src/room-contract.js';
import {
  addVote,
  createUser,
  deleteUser,
  deleteRunEvent,
  getRunEventForDate,
  getWeekState,
  proposeRunEvent,
  setRunEventStatus,
  withdrawRunEvent,
} from '../src/domain.js';
import { deleteUserWithAudit, resetUserVotes, resetWeek, setVote } from '../src/domain.js';

const NOW = new Date('2024-02-29T04:00:00.000Z');
const requestId = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const ENV = { ADMIN_NAME: 'Synthetic Coach', ADMIN_PIN: '4826', PIN_PEPPER: 'synthetic-pepper' };

async function withDatabase(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'run-together-issue-32-'));
  const database = openDatabase(join(directory, 'test.sqlite'));
  try {
    migrate(database);
    await callback(database);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function withHttpServer(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'run-together-issue-32-http-'));
  const databasePath = join(directory, 'test.sqlite');
  const server = createServer({ databasePath, env: ENV, now: () => NOW });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await callback(`http://127.0.0.1:${server.address().port}`, server, databasePath);
  } finally {
    server.close();
    await once(server, 'close');
    server.database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function cookieFrom(response) {
  return response.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
}

async function registerMember(baseUrl, name) {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ name, pin: '0042', pinConfirmation: '0042' }),
  });
  const cookie = cookieFrom(response);
  const session = await fetch(`${baseUrl}/api/session`, { headers: { cookie } }).then((result) => result.json());
  return { response, cookie, session };
}

async function adminSessionFor(baseUrl) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ name: ENV.ADMIN_NAME, pin: ENV.ADMIN_PIN }),
  });
  const cookie = cookieFrom(response);
  const session = await fetch(`${baseUrl}/api/session`, { headers: { cookie } }).then((result) => result.json());
  return { response, cookie, session };
}

function eventRequest(baseUrl, path, { method, cookie, csrfToken, body } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(method ? { origin: baseUrl, 'content-type': 'application/json' } : {}),
      ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test('Issue 32 migration adds durable event and retry tables without changing existing rows', async () => {
  await withDatabase((database) => {
    const user = database.prepare(`
      INSERT INTO users (name, name_key, pin_salt, pin_hash, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('Migration Runner', 'migration runner', Buffer.from('salt'), Buffer.from('hash'), 'user', '2024-02-29T04:00:00.000Z', '2024-02-29T04:00:00.000Z');
    const userId = Number(user.lastInsertRowid);
    database.prepare('INSERT INTO votes (room_id, user_id, vote_date, created_at) VALUES (?, ?, ?, ?)')
      .run(LEGACY_ROOM_ID, userId, '2024-03-01', '2024-02-29T04:01:00.000Z');
    database.prepare(`
      INSERT INTO sessions (token_hash, user_id, csrf_secret, created_at, last_seen_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(Buffer.from('token-hash'), userId, Buffer.from('csrf'), '2024-02-29T04:00:00.000Z', '2024-02-29T04:00:00.000Z', '2024-03-01T04:00:00.000Z');

    migrate(database);

    const migration = database.prepare('SELECT version, name FROM schema_migrations ORDER BY version DESC LIMIT 1').get();
    assert.equal(migration.version, 6);
    assert.equal(migration.name, 'room_storage_and_legacy_board');
    assert.deepEqual(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('run_events', 'run_event_requests') ORDER BY name").all(), [
      { name: 'run_event_requests' },
      { name: 'run_events' },
    ]);
    assert.deepEqual(database.prepare('SELECT id, name FROM users WHERE id = ?').get(userId), { id: userId, name: 'Migration Runner' });
    assert.deepEqual(database.prepare('SELECT room_id, user_id, vote_date FROM votes WHERE user_id = ?').get(userId), {
      room_id: LEGACY_ROOM_ID, user_id: userId, vote_date: '2024-03-01',
    });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?').get(userId).count, 1);
    assert.equal(database.pragma('foreign_keys', { simple: true }), 1);
  });
});

test('current voters can propose multiple eligible dates in one week without replacing each other', async () => {
  await withDatabase((database) => {
    const runner = createUser(database, {
      name: 'Multi-date Runner', pinSalt: Buffer.from('salt'), pinHash: Buffer.from('hash'), now: () => NOW,
    });
    for (const date of ['2024-03-01', '2024-03-03']) {
      addVote(database, { userId: runner.id, voteDate: date });
      const result = proposeRunEvent(database, {
        userId: runner.id, eventDate: date, requestId: `00000000-0000-4000-8000-00000000000${date.endsWith('1') ? '1' : '3'}`, now: () => NOW,
      });
      assert.equal(result.changed, true);
      assert.equal(result.event.date, date);
      assert.equal(result.event.status, 'proposed');
    }

    const week = getWeekState(database, { monday: '2024-02-26', currentUserId: runner.id, now: () => NOW });
    assert.deepEqual(week.events.map(({ date }) => date), ['2024-03-01', '2024-03-03']);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM run_events').get().count, 2);
  });
});

test('proposal retries cannot resurrect a withdrawn event and new proposals get a fresh identity', async () => {
  await withDatabase((database) => {
    const runner = createUser(database, {
      name: 'Retry Runner', pinSalt: Buffer.from('salt'), pinHash: Buffer.from('hash'), now: () => NOW,
    });
    addVote(database, { userId: runner.id, voteDate: '2024-03-01' });
    const first = proposeRunEvent(database, {
      userId: runner.id, eventDate: '2024-03-01', requestId: requestId(1), now: () => NOW,
    });
    const removed = withdrawRunEvent(database, {
      userId: runner.id, eventDate: '2024-03-01', eventId: first.event.eventId,
      revision: first.event.revision, requestId: requestId(2), now: () => NOW,
    });
    assert.equal(removed.event, null);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM votes').get().count, 1);

    const delayedRetry = proposeRunEvent(database, {
      userId: runner.id, eventDate: '2024-03-01', requestId: requestId(1), now: () => NOW,
    });
    assert.equal(delayedRetry.replayed, true);
    assert.equal(delayedRetry.event, null);
    assert.equal(getRunEventForDate(database, { eventDate: '2024-03-01' }), null);

    const recreated = proposeRunEvent(database, {
      userId: runner.id, eventDate: '2024-03-01', requestId: requestId(3), now: () => NOW,
    });
    assert.ok(recreated.event.eventId > first.event.eventId);
    assert.equal(recreated.event.proposedBy, 'Retry Runner');
  });
});

test('admin status requests express desired state, clear schedule metadata on revert, and reject stale identities', async () => {
  await withDatabase((database) => {
    const runner = createUser(database, {
      name: 'Status Runner', pinSalt: Buffer.from('salt'), pinHash: Buffer.from('hash'), now: () => NOW,
    });
    const admin = createUser(database, {
      name: 'Status Admin', pinSalt: Buffer.from('salt'), pinHash: Buffer.from('hash'), role: 'admin', now: () => NOW,
    });
    addVote(database, { userId: runner.id, voteDate: '2024-03-01' });
    const proposal = proposeRunEvent(database, {
      userId: runner.id, eventDate: '2024-03-01', requestId: requestId(10), now: () => NOW,
    }).event;

    const scheduled = setRunEventStatus(database, {
      adminUserId: admin.id, eventDate: proposal.date, eventId: proposal.eventId,
      revision: proposal.revision, status: 'scheduled', requestId: requestId(11), now: () => NOW,
    });
    assert.equal(scheduled.event.status, 'scheduled');
    assert.equal(scheduled.event.revision, proposal.revision + 1);
    assert.equal(scheduled.event.scheduledBy, 'Status Admin');
    const repeat = setRunEventStatus(database, {
      adminUserId: admin.id, eventDate: proposal.date, eventId: proposal.eventId,
      revision: proposal.revision, status: 'scheduled', requestId: requestId(11), now: () => NOW,
    });
    assert.equal(repeat.replayed, true);
    assert.equal(repeat.event.status, 'scheduled');

    assert.throws(() => setRunEventStatus(database, {
      adminUserId: admin.id, eventDate: proposal.date, eventId: proposal.eventId,
      revision: proposal.revision, status: 'proposed', requestId: requestId(12), now: () => NOW,
    }), (error) => error.code === 'STALE_RUN_EVENT');
    const reverted = setRunEventStatus(database, {
      adminUserId: admin.id, eventDate: proposal.date, eventId: proposal.eventId,
      revision: scheduled.event.revision, status: 'proposed', requestId: requestId(13), now: () => NOW,
    });
    assert.equal(reverted.event.status, 'proposed');
    assert.equal(reverted.event.scheduledBy, null);
    assert.equal(reverted.event.scheduledAt, null);

    const deleted = deleteRunEvent(database, {
      adminUserId: admin.id, eventDate: proposal.date, eventId: proposal.eventId,
      revision: reverted.event.revision, requestId: requestId(14), now: () => NOW,
    });
    assert.equal(deleted.event, null);
    const recreated = proposeRunEvent(database, {
      userId: runner.id, eventDate: proposal.date, requestId: requestId(15), now: () => NOW,
    });
    assert.ok(recreated.event.eventId > proposal.eventId);
    assert.throws(() => deleteRunEvent(database, {
      adminUserId: admin.id, eventDate: proposal.date, eventId: proposal.eventId,
      revision: reverted.event.revision, requestId: requestId(16), now: () => NOW,
    }), (error) => error.code === 'STALE_RUN_EVENT');
    assert.equal(getRunEventForDate(database, { eventDate: proposal.date }).eventId, recreated.event.eventId);
  });
});

test('last-vote cleanup is atomic for vote withdrawal, user reset, deletion and week reset but retains scheduled events', async () => {
  await withDatabase((database) => {
    const admin = createUser(database, {
      name: 'Cleanup Admin', pinSalt: Buffer.from('salt'), pinHash: Buffer.from('hash'), role: 'admin', now: () => NOW,
    });
    const member = createUser(database, {
      name: 'Cleanup Member', pinSalt: Buffer.from('salt'), pinHash: Buffer.from('hash'), now: () => NOW,
    });
    const doomed = createUser(database, {
      name: 'Cleanup Deletion', pinSalt: Buffer.from('salt'), pinHash: Buffer.from('hash'), now: () => NOW,
    });
    const weekResetMember = createUser(database, {
      name: 'Cleanup Week Reset', pinSalt: Buffer.from('salt'), pinHash: Buffer.from('hash'), now: () => NOW,
    });
    const directDeleteMember = createUser(database, {
      name: 'Cleanup Direct Delete', pinSalt: Buffer.from('salt'), pinHash: Buffer.from('hash'), now: () => NOW,
    });
    const scheduledOwner = createUser(database, {
      name: 'Cleanup Scheduled Owner', pinSalt: Buffer.from('salt'), pinHash: Buffer.from('hash'), now: () => NOW,
    });
    const createProposal = (user, date, id) => {
      addVote(database, { userId: user.id, voteDate: date });
      return proposeRunEvent(database, { userId: user.id, eventDate: date, requestId: requestId(id), now: () => NOW }).event;
    };

    createProposal(member, '2024-03-01', 20);
    setVote(database, { userId: member.id, voteDate: '2024-03-01', body: { selected: false }, now: () => NOW });
    assert.equal(getRunEventForDate(database, { eventDate: '2024-03-01' }), null);

    createProposal(member, '2024-03-02', 21);
    resetUserVotes(database, { adminUserId: admin.id, targetUserId: member.id, requestId: requestId(22), now: () => NOW });
    assert.equal(getRunEventForDate(database, { eventDate: '2024-03-02' }), null);

    createProposal(doomed, '2024-03-03', 23);
    deleteUserWithAudit(database, { adminUserId: admin.id, targetUserId: doomed.id, requestId: requestId(24), now: () => NOW });
    assert.equal(getRunEventForDate(database, { eventDate: '2024-03-03' }), null);

    createProposal(directDeleteMember, '2024-03-04', 28);
    assert.equal(deleteUser(database, directDeleteMember.id), true);
    assert.equal(getRunEventForDate(database, { eventDate: '2024-03-04' }), null);

    const scheduledOwnerEvent = createProposal(scheduledOwner, '2024-03-05', 29);
    const scheduledForDeletedOwner = setRunEventStatus(database, {
      adminUserId: admin.id, eventDate: scheduledOwnerEvent.date, eventId: scheduledOwnerEvent.eventId,
      revision: scheduledOwnerEvent.revision, status: 'scheduled', requestId: requestId(30), now: () => NOW,
    }).event;
    deleteUserWithAudit(database, { adminUserId: admin.id, targetUserId: scheduledOwner.id, requestId: requestId(31), now: () => NOW });
    assert.equal(getRunEventForDate(database, { eventDate: scheduledOwnerEvent.date }).eventId, scheduledForDeletedOwner.eventId);
    assert.equal(getRunEventForDate(database, { eventDate: scheduledOwnerEvent.date }).status, 'scheduled');
    assert.equal(getRunEventForDate(database, { eventDate: scheduledOwnerEvent.date }).voteCount, 0);

    const scheduledProposal = createProposal(weekResetMember, '2024-03-02', 25);
    const scheduled = setRunEventStatus(database, {
      adminUserId: admin.id, eventDate: scheduledProposal.date, eventId: scheduledProposal.eventId,
      revision: scheduledProposal.revision, status: 'scheduled', requestId: requestId(26), now: () => NOW,
    }).event;
    const pendingProposal = createProposal(weekResetMember, '2024-03-03', 27);
    const weekReset = resetWeek(database, { monday: '2024-02-26', now: () => NOW });
    assert.ok(weekReset.affectedDates.includes('2024-03-02'));
    assert.ok(weekReset.affectedDates.includes('2024-03-03'));
    assert.equal(getRunEventForDate(database, { eventDate: pendingProposal.date }), null);
    assert.equal(getRunEventForDate(database, { eventDate: scheduled.date }).status, 'scheduled');
    assert.equal(getRunEventForDate(database, { eventDate: scheduled.date }).voteCount, 0);
    assert.deepEqual(getRunEventForDate(database, { eventDate: scheduled.date }).voterNames, []);
  });
});

test('event APIs enforce authentication, CSRF, current-voter and admin permissions without changing votes', async () => {
  await withHttpServer(async (baseUrl, server) => {
    const alice = await registerMember(baseUrl, 'API Alice');
    const bob = await registerMember(baseUrl, 'API Bob');
    const admin = await adminSessionFor(baseUrl);
    assert.equal(alice.response.status, 201);
    assert.equal(bob.response.status, 201);
    assert.equal(admin.response.status, 200);

    const unauthenticated = await eventRequest(baseUrl, '/api/events/2024-03-01', {
      method: 'POST', body: { requestId: requestId(40) },
    });
    assert.equal(unauthenticated.status, 401);
    const noCsrf = await eventRequest(baseUrl, '/api/events/2024-03-01', {
      method: 'POST', cookie: alice.cookie, body: { requestId: requestId(41) },
    });
    assert.equal(noCsrf.status, 403);
    const malformed = await eventRequest(baseUrl, '/api/events/2024-03-01', {
      method: 'POST', cookie: alice.cookie, csrfToken: alice.session.csrfToken, body: { requestId: 'bad' },
    });
    assert.equal(malformed.status, 400);

    const nonVoter = await eventRequest(baseUrl, '/api/events/2024-03-01', {
      method: 'POST', cookie: alice.cookie, csrfToken: alice.session.csrfToken, body: { requestId: requestId(42) },
    });
    assert.equal(nonVoter.status, 403);
    assert.equal((await nonVoter.json()).code, 'RUN_EVENT_VOTER_REQUIRED');
    assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM run_events').get().count, 0);

    const vote = await eventRequest(baseUrl, '/api/votes/2024-03-01', {
      method: 'PUT', cookie: alice.cookie, csrfToken: alice.session.csrfToken, body: { selected: true },
    });
    assert.equal(vote.status, 200);
    const proposalResponse = await eventRequest(baseUrl, '/api/events/2024-03-01', {
      method: 'POST', cookie: alice.cookie, csrfToken: alice.session.csrfToken, body: { requestId: requestId(43) },
    });
    assert.equal(proposalResponse.status, 201);
    const proposal = await proposalResponse.json();
    assert.equal(proposal.event.status, 'proposed');
    assert.equal(proposal.event.voteCount, 1);
    assert.equal(proposal.event.voterNames[0], 'API Alice');

    const week = await eventRequest(baseUrl, '/api/weeks/2024-02-26', { cookie: bob.cookie });
    assert.equal(week.status, 200);
    assert.deepEqual((await week.json()).events.map(({ date }) => date), ['2024-03-01']);
    const nonVoterWithdraw = await eventRequest(baseUrl, '/api/events/2024-03-01', {
      method: 'DELETE', cookie: bob.cookie, csrfToken: bob.session.csrfToken,
      body: { eventId: proposal.event.eventId, revision: proposal.event.revision, requestId: requestId(44) },
    });
    assert.equal(nonVoterWithdraw.status, 403);

    const bobVote = await eventRequest(baseUrl, '/api/votes/2024-03-01', {
      method: 'PUT', cookie: bob.cookie, csrfToken: bob.session.csrfToken, body: { selected: true },
    });
    assert.equal(bobVote.status, 200);
    const anotherVoterWithdraw = await eventRequest(baseUrl, '/api/events/2024-03-01', {
      method: 'DELETE', cookie: bob.cookie, csrfToken: bob.session.csrfToken,
      body: { eventId: proposal.event.eventId, revision: proposal.event.revision, requestId: requestId(45) },
    });
    assert.equal(anotherVoterWithdraw.status, 200);
    assert.equal((await anotherVoterWithdraw.json()).event, null);
    assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM votes WHERE vote_date = ?').get('2024-03-01').count, 2);

    const recreatedResponse = await eventRequest(baseUrl, '/api/events/2024-03-01', {
      method: 'POST', cookie: alice.cookie, csrfToken: alice.session.csrfToken, body: { requestId: requestId(46) },
    });
    assert.equal(recreatedResponse.status, 201);
    const recreated = await recreatedResponse.json();
    assert.ok(recreated.event.eventId > proposal.event.eventId);

    const memberAdminAction = await eventRequest(baseUrl, '/api/admin/events/2024-03-01', {
      method: 'PUT', cookie: alice.cookie, csrfToken: alice.session.csrfToken,
      body: { status: 'scheduled', eventId: recreated.event.eventId, revision: recreated.event.revision, requestId: requestId(47) },
    });
    assert.equal(memberAdminAction.status, 403);
    const scheduledResponse = await eventRequest(baseUrl, '/api/admin/events/2024-03-01', {
      method: 'PUT', cookie: admin.cookie, csrfToken: admin.session.csrfToken,
      body: { status: 'scheduled', eventId: recreated.event.eventId, revision: recreated.event.revision, requestId: requestId(48) },
    });
    assert.equal(scheduledResponse.status, 200);
    const scheduled = await scheduledResponse.json();
    assert.equal(scheduled.event.status, 'scheduled');

    const memberDelete = await eventRequest(baseUrl, '/api/admin/events/2024-03-01', {
      method: 'DELETE', cookie: alice.cookie, csrfToken: alice.session.csrfToken,
      body: { eventId: scheduled.event.eventId, revision: scheduled.event.revision, requestId: requestId(49) },
    });
    assert.equal(memberDelete.status, 403);
    const lockedWithdrawal = await eventRequest(baseUrl, '/api/events/2024-03-01', {
      method: 'DELETE', cookie: alice.cookie, csrfToken: alice.session.csrfToken,
      body: { eventId: scheduled.event.eventId, revision: scheduled.event.revision, requestId: requestId(50) },
    });
    assert.equal(lockedWithdrawal.status, 409);
    for (const member of [alice, bob]) {
      const removedVote = await eventRequest(baseUrl, '/api/votes/2024-03-01', {
        method: 'PUT', cookie: member.cookie, csrfToken: member.session.csrfToken, body: { selected: false },
      });
      assert.equal(removedVote.status, 200);
    }
    const zeroVoteWeek = await eventRequest(baseUrl, '/api/weeks/2024-02-26', { cookie: bob.cookie }).then((response) => response.json());
    assert.equal(zeroVoteWeek.events[0].status, 'scheduled');
    assert.equal(zeroVoteWeek.events[0].voteCount, 0);

    const reverted = await eventRequest(baseUrl, '/api/admin/events/2024-03-01', {
      method: 'PUT', cookie: admin.cookie, csrfToken: admin.session.csrfToken,
      body: { status: 'proposed', eventId: scheduled.event.eventId, revision: scheduled.event.revision, requestId: requestId(51) },
    });
    assert.equal(reverted.status, 200);
    assert.equal((await reverted.json()).event, null);
    assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM votes WHERE vote_date = ?').get('2024-03-01').count, 0);

    const ineligible = await eventRequest(baseUrl, '/api/events/2024-03-18', {
      method: 'POST', cookie: alice.cookie, csrfToken: alice.session.csrfToken, body: { requestId: requestId(52) },
    });
    assert.equal(ineligible.status, 400);
  });
});

test('connected clients receive committed shared event state and recover date-specific voter updates', async () => {
  await withHttpServer(async (baseUrl, server) => {
    const alice = await registerMember(baseUrl, 'Realtime Alice');
    const bob = await registerMember(baseUrl, 'Realtime Bob');
    const admin = await adminSessionFor(baseUrl);
    assert.equal(admin.response.status, 200);
    for (const member of [alice, bob]) {
      const vote = await eventRequest(baseUrl, '/api/votes/2024-03-01', {
        method: 'PUT', cookie: member.cookie, csrfToken: member.session.csrfToken, body: { selected: true },
      });
      assert.equal(vote.status, 200);
    }
    const sockets = [alice, bob].map((member) => connectSocket(baseUrl, {
      transports: ['websocket'], extraHeaders: { origin: baseUrl, cookie: member.cookie },
    }));
    const waitForConnect = (socket) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out connecting event test socket')), 2000);
      socket.once('connect', () => { clearTimeout(timer); resolve(); });
      socket.once('connect_error', (error) => { clearTimeout(timer); reject(error); });
    });
    try {
      await Promise.all(sockets.map(waitForConnect));
      const aliceProposal = new Promise((resolve) => sockets[0].once('event:changed', resolve));
      const bobProposal = new Promise((resolve) => sockets[1].once('event:changed', resolve));
      const competing = await Promise.all([alice, bob].map((member, index) => eventRequest(baseUrl, '/api/events/2024-03-01', {
        method: 'POST', cookie: member.cookie, csrfToken: member.session.csrfToken, body: { requestId: requestId(60 + index) },
      })));
      assert.deepEqual(competing.map(({ status }) => status).sort(), [201, 409]);
      const [aliceEvent, bobEvent] = await Promise.all([aliceProposal, bobProposal]);
      assert.equal(aliceEvent.event.eventId, bobEvent.event.eventId);
      assert.equal(aliceEvent.event.voteCount, 2);
      assert.deepEqual(aliceEvent.event.voterNames, ['Realtime Alice', 'Realtime Bob']);

      const scheduleMessages = sockets.map((socket) => new Promise((resolve) => socket.once('event:changed', resolve)));
      const schedule = await eventRequest(baseUrl, '/api/admin/events/2024-03-01', {
        method: 'PUT', cookie: admin.cookie, csrfToken: admin.session.csrfToken,
        body: { status: 'scheduled', eventId: aliceEvent.event.eventId, revision: aliceEvent.event.revision, requestId: requestId(62) },
      });
      assert.equal(schedule.status, 200);
      const scheduledEvent = (await schedule.json()).event;
      const [aliceScheduled, bobScheduled] = await Promise.all(scheduleMessages);
      assert.equal(aliceScheduled.event.status, 'scheduled');
      assert.equal(bobScheduled.event.status, 'scheduled');
      assert.equal(aliceScheduled.event.revision, scheduledEvent.revision);

      const revertMessages = sockets.map((socket) => new Promise((resolve) => socket.once('event:changed', resolve)));
      const revert = await eventRequest(baseUrl, '/api/admin/events/2024-03-01', {
        method: 'PUT', cookie: admin.cookie, csrfToken: admin.session.csrfToken,
        body: { status: 'proposed', eventId: scheduledEvent.eventId, revision: scheduledEvent.revision, requestId: requestId(63) },
      });
      assert.equal(revert.status, 200);
      const revertedEvent = (await revert.json()).event;
      const [aliceReverted, bobReverted] = await Promise.all(revertMessages);
      assert.equal(aliceReverted.event.status, 'proposed');
      assert.equal(bobReverted.event.status, 'proposed');
      assert.equal(bobReverted.event.revision, revertedEvent.revision);

      const bobVoteChanged = new Promise((resolve) => sockets[0].once('event:changed', resolve));
      const removeBob = await eventRequest(baseUrl, '/api/votes/2024-03-01', {
        method: 'PUT', cookie: bob.cookie, csrfToken: bob.session.csrfToken, body: { selected: false },
      });
      assert.equal(removeBob.status, 200);
      const oneVoterEvent = await bobVoteChanged;
      assert.equal(oneVoterEvent.event.voteCount, 1);
      assert.deepEqual(oneVoterEvent.event.voterNames, ['Realtime Alice']);

      const bobRemoval = new Promise((resolve) => sockets[1].once('event:changed', resolve));
      const removeAlice = await eventRequest(baseUrl, '/api/votes/2024-03-01', {
        method: 'PUT', cookie: alice.cookie, csrfToken: alice.session.csrfToken, body: { selected: false },
      });
      assert.equal(removeAlice.status, 200);
      const removedEvent = await bobRemoval;
      assert.equal(removedEvent.event, null);

      for (const member of [alice, bob]) {
        const addVote = await eventRequest(baseUrl, '/api/votes/2024-03-01', {
          method: 'PUT', cookie: member.cookie, csrfToken: member.session.csrfToken, body: { selected: true },
        });
        assert.equal(addVote.status, 200);
      }
      const recreatedMessages = sockets.map((socket) => new Promise((resolve) => socket.once('event:changed', resolve)));
      const recreatedResponse = await eventRequest(baseUrl, '/api/events/2024-03-01', {
        method: 'POST', cookie: alice.cookie, csrfToken: alice.session.csrfToken, body: { requestId: requestId(64) },
      });
      assert.equal(recreatedResponse.status, 201);
      const recreated = (await recreatedResponse.json()).event;
      const [aliceRecreated, bobRecreated] = await Promise.all(recreatedMessages);
      assert.equal(aliceRecreated.event.eventId, recreated.eventId);
      assert.equal(bobRecreated.event.eventId, recreated.eventId);

      const deleteMessages = sockets.map((socket) => new Promise((resolve) => socket.once('event:changed', resolve)));
      const deletion = await eventRequest(baseUrl, '/api/admin/events/2024-03-01', {
        method: 'DELETE', cookie: admin.cookie, csrfToken: admin.session.csrfToken,
        body: { eventId: recreated.eventId, revision: recreated.revision, requestId: requestId(65) },
      });
      assert.equal(deletion.status, 200);
      const [aliceDeleted, bobDeleted] = await Promise.all(deleteMessages);
      assert.equal(aliceDeleted.event, null);
      assert.equal(bobDeleted.event, null);
      assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM votes WHERE vote_date = ?').get('2024-03-01').count, 2);

      for (const member of [alice, bob]) {
        const addVote = await eventRequest(baseUrl, '/api/votes/2024-03-02', {
          method: 'PUT', cookie: member.cookie, csrfToken: member.session.csrfToken, body: { selected: true },
        });
        assert.equal(addVote.status, 200);
      }
      const createSharedEvent = async (member, date, id) => {
        const eventMessages = sockets.map((socket) => new Promise((resolve) => socket.once('event:changed', resolve)));
        const response = await eventRequest(baseUrl, `/api/events/${date}`, {
          method: 'POST', cookie: member.cookie, csrfToken: member.session.csrfToken, body: { requestId: requestId(id) },
        });
        assert.equal(response.status, 201);
        const event = (await response.json()).event;
        const [aliceEvent, bobEvent] = await Promise.all(eventMessages);
        assert.equal(aliceEvent.event.eventId, event.eventId);
        assert.equal(bobEvent.event.eventId, event.eventId);
        return event;
      };
      const sameWeekEvents = [
        await createSharedEvent(alice, '2024-03-01', 66),
        await createSharedEvent(bob, '2024-03-02', 67),
      ];
      for (const member of [alice, bob]) {
        const week = await eventRequest(baseUrl, '/api/weeks/2024-02-26', { cookie: member.cookie }).then((response) => response.json());
        assert.deepEqual(week.events.map(({ date }) => date), ['2024-03-01', '2024-03-02']);
      }
      for (const [index, event] of sameWeekEvents.entries()) {
        const scheduleMessages = sockets.map((socket) => new Promise((resolve) => socket.once('event:changed', resolve)));
        const schedule = await eventRequest(baseUrl, `/api/admin/events/${event.date}`, {
          method: 'PUT', cookie: admin.cookie, csrfToken: admin.session.csrfToken,
          body: { status: 'scheduled', eventId: event.eventId, revision: event.revision, requestId: requestId(68 + index) },
        });
        assert.equal(schedule.status, 200);
        const [aliceScheduled, bobScheduled] = await Promise.all(scheduleMessages);
        assert.equal(aliceScheduled.event.status, 'scheduled');
        assert.equal(bobScheduled.event.status, 'scheduled');
      }
    } finally {
      sockets.forEach((socket) => socket.close());
    }
  });
});

test('concurrent schedule/delete and last-vote races serialize without leaving invalid event states', async () => {
  await withHttpServer(async (baseUrl, server) => {
    const runner = await registerMember(baseUrl, 'Race Runner');
    const secondVoter = await registerMember(baseUrl, 'Race Second');
    const admin = await adminSessionFor(baseUrl);
    assert.equal(runner.response.status, 201);
    assert.equal(secondVoter.response.status, 201);
    assert.equal(admin.response.status, 200);

    for (const date of ['2024-03-01', '2024-03-02', '2024-03-03', '2024-03-04']) {
      const vote = await eventRequest(baseUrl, `/api/votes/${date}`, {
        method: 'PUT', cookie: runner.cookie, csrfToken: runner.session.csrfToken, body: { selected: true },
      });
      assert.equal(vote.status, 200);
    }
    const secondVote = await eventRequest(baseUrl, '/api/votes/2024-03-01', {
      method: 'PUT', cookie: secondVoter.cookie, csrfToken: secondVoter.session.csrfToken, body: { selected: true },
    });
    assert.equal(secondVote.status, 200);

    const createProposal = async (date, id) => {
      const response = await eventRequest(baseUrl, `/api/events/${date}`, {
        method: 'POST', cookie: runner.cookie, csrfToken: runner.session.csrfToken, body: { requestId: requestId(id) },
      });
      assert.equal(response.status, 201);
      return (await response.json()).event;
    };

    const scheduleDeleteEvent = await createProposal('2024-03-01', 70);
    const scheduleDeleteRace = await Promise.all([
      eventRequest(baseUrl, '/api/admin/events/2024-03-01', {
        method: 'PUT', cookie: admin.cookie, csrfToken: admin.session.csrfToken,
        body: { eventId: scheduleDeleteEvent.eventId, revision: scheduleDeleteEvent.revision, requestId: requestId(71), status: 'scheduled' },
      }),
      eventRequest(baseUrl, '/api/admin/events/2024-03-01', {
        method: 'DELETE', cookie: admin.cookie, csrfToken: admin.session.csrfToken,
        body: { eventId: scheduleDeleteEvent.eventId, revision: scheduleDeleteEvent.revision, requestId: requestId(72) },
      }),
    ]);
    assert.deepEqual(scheduleDeleteRace.map(({ status }) => status).sort(), [200, 409]);
    const scheduleDeleteState = getRunEventForDate(server.database, { eventDate: '2024-03-01' });
    assert.ok(scheduleDeleteState === null || scheduleDeleteState.status === 'scheduled');
    assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM votes WHERE vote_date = ?').get('2024-03-01').count, 2);

    const lastVoteEvent = await createProposal('2024-03-02', 73);
    const lastVoteRace = await Promise.all([
      eventRequest(baseUrl, '/api/votes/2024-03-02', {
        method: 'PUT', cookie: runner.cookie, csrfToken: runner.session.csrfToken, body: { selected: false },
      }),
      eventRequest(baseUrl, '/api/admin/events/2024-03-02', {
        method: 'PUT', cookie: admin.cookie, csrfToken: admin.session.csrfToken,
        body: { eventId: lastVoteEvent.eventId, revision: lastVoteEvent.revision, requestId: requestId(74), status: 'scheduled' },
      }),
    ]);
    assert.equal(lastVoteRace[0].status, 200);
    assert.ok([200, 409].includes(lastVoteRace[1].status));
    const lastVoteState = getRunEventForDate(server.database, { eventDate: '2024-03-02' });
    assert.ok(lastVoteState === null || lastVoteState.status === 'scheduled');
    assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM votes WHERE vote_date = ?').get('2024-03-02').count, 0);

    const toggleRaceEvent = await createProposal('2024-03-03', 75);
    const scheduledToggle = await eventRequest(baseUrl, '/api/admin/events/2024-03-03', {
      method: 'PUT', cookie: admin.cookie, csrfToken: admin.session.csrfToken,
      body: { eventId: toggleRaceEvent.eventId, revision: toggleRaceEvent.revision, requestId: requestId(76), status: 'scheduled' },
    });
    assert.equal(scheduledToggle.status, 200);
    const scheduledToggleState = (await scheduledToggle.json()).event;
    const revertDeleteRace = await Promise.all([
      eventRequest(baseUrl, '/api/admin/events/2024-03-03', {
        method: 'PUT', cookie: admin.cookie, csrfToken: admin.session.csrfToken,
        body: { eventId: scheduledToggleState.eventId, revision: scheduledToggleState.revision, requestId: requestId(77), status: 'proposed' },
      }),
      eventRequest(baseUrl, '/api/admin/events/2024-03-03', {
        method: 'DELETE', cookie: admin.cookie, csrfToken: admin.session.csrfToken,
        body: { eventId: scheduledToggleState.eventId, revision: scheduledToggleState.revision, requestId: requestId(78) },
      }),
    ]);
    assert.deepEqual(revertDeleteRace.map(({ status }) => status).sort(), [200, 409]);
    const revertDeleteState = getRunEventForDate(server.database, { eventDate: '2024-03-03' });
    assert.ok(revertDeleteState === null || revertDeleteState.status === 'proposed');

    for (const member of [runner, secondVoter]) {
      const vote = await eventRequest(baseUrl, '/api/votes/2024-03-05', {
        method: 'PUT', cookie: member.cookie, csrfToken: member.session.csrfToken, body: { selected: true },
      });
      assert.equal(vote.status, 200);
    }
    const competingProposals = await Promise.all([
      eventRequest(baseUrl, '/api/events/2024-03-05', {
        method: 'POST', cookie: runner.cookie, csrfToken: runner.session.csrfToken, body: { requestId: requestId(83) },
      }),
      eventRequest(baseUrl, '/api/events/2024-03-05', {
        method: 'POST', cookie: secondVoter.cookie, csrfToken: secondVoter.session.csrfToken, body: { requestId: requestId(84) },
      }),
    ]);
    assert.deepEqual(competingProposals.map(({ status }) => status).sort(), [201, 409]);
    const createdProposalResponse = competingProposals.find(({ status }) => status === 201);
    const createdProposal = (await createdProposalResponse.json()).event;
    assert.equal(getRunEventForDate(server.database, { eventDate: '2024-03-05' }).eventId, createdProposal.eventId);
    assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM run_events WHERE event_date = ?').get('2024-03-05').count, 1);

    const proposalWithdrawRace = await Promise.all([
      eventRequest(baseUrl, '/api/events/2024-03-04', {
        method: 'POST', cookie: runner.cookie, csrfToken: runner.session.csrfToken, body: { requestId: requestId(79) },
      }),
      eventRequest(baseUrl, '/api/votes/2024-03-04', {
        method: 'PUT', cookie: runner.cookie, csrfToken: runner.session.csrfToken, body: { selected: false },
      }),
    ]);
    assert.ok([201, 403].includes(proposalWithdrawRace[0].status));
    assert.equal(proposalWithdrawRace[1].status, 200);
    assert.equal(getRunEventForDate(server.database, { eventDate: '2024-03-04' }), null);
    assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM votes WHERE vote_date = ?').get('2024-03-04').count, 0);
  });
});

test('event state is omitted at Bangkok day rollover without deleting persistent event data', async () => {
  await withDatabase((database) => {
    const runner = createUser(database, {
      name: 'Rollover Runner', pinSalt: Buffer.from('salt'), pinHash: Buffer.from('hash'), now: () => NOW,
    });
    addVote(database, { userId: runner.id, voteDate: '2024-03-01' });
    const event = proposeRunEvent(database, {
      userId: runner.id, eventDate: '2024-03-01', requestId: requestId(30), now: () => NOW,
    }).event;
    const beforeMidnight = getWeekState(database, { monday: '2024-02-26', currentUserId: runner.id, now: () => new Date('2024-03-01T16:59:59.000Z') });
    assert.deepEqual(beforeMidnight.events.map(({ date }) => date), ['2024-03-01']);
    const afterMidnight = getWeekState(database, { monday: '2024-02-26', currentUserId: runner.id, now: () => new Date('2024-03-01T17:00:00.000Z') });
    assert.deepEqual(afterMidnight.events, []);
    assert.equal(getRunEventForDate(database, { eventDate: event.date }).eventId, event.eventId);
  });
});

test('event identity, scheduled metadata and retry guards survive closing and reopening SQLite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'run-together-issue-32-restart-'));
  const databasePath = join(directory, 'restart.sqlite');
  let database = openDatabase(databasePath);
  try {
    migrate(database);
    const runner = createUser(database, {
      name: 'Restart Runner', pinSalt: Buffer.from('salt'), pinHash: Buffer.from('hash'), now: () => NOW,
    });
    const admin = createUser(database, {
      name: 'Restart Admin', pinSalt: Buffer.from('salt'), pinHash: Buffer.from('hash'), role: 'admin', now: () => NOW,
    });
    for (const date of ['2024-03-01', '2024-03-02']) addVote(database, { userId: runner.id, voteDate: date });
    const removedProposal = proposeRunEvent(database, {
      userId: runner.id, eventDate: '2024-03-01', requestId: requestId(80), now: () => NOW,
    });
    withdrawRunEvent(database, {
      userId: runner.id, eventDate: '2024-03-01', eventId: removedProposal.event.eventId,
      revision: removedProposal.event.revision, requestId: requestId(81), now: () => NOW,
    });
    const scheduledProposal = proposeRunEvent(database, {
      userId: runner.id, eventDate: '2024-03-02', requestId: requestId(82), now: () => NOW,
    }).event;
    setRunEventStatus(database, {
      adminUserId: admin.id, eventDate: scheduledProposal.date, eventId: scheduledProposal.eventId,
      revision: scheduledProposal.revision, status: 'scheduled', requestId: requestId(83), now: () => NOW,
    });
    database.close();

    database = openDatabase(databasePath);
    migrate(database);
    const delayedProposalRetry = proposeRunEvent(database, {
      userId: runner.id, eventDate: '2024-03-01', requestId: requestId(80), now: () => NOW,
    });
    assert.equal(delayedProposalRetry.replayed, true);
    assert.equal(delayedProposalRetry.event, null);
    const scheduled = getRunEventForDate(database, { eventDate: '2024-03-02' });
    assert.equal(scheduled.status, 'scheduled');
    assert.equal(scheduled.eventId, scheduledProposal.eventId);
    assert.equal(scheduled.scheduledBy, 'Restart Admin');
    assert.equal(scheduled.voteCount, 1);
    const repeatedSchedule = setRunEventStatus(database, {
      adminUserId: admin.id, eventDate: scheduled.date, eventId: scheduled.eventId,
      revision: scheduledProposal.revision, status: 'scheduled', requestId: requestId(83), now: () => NOW,
    });
    assert.equal(repeatedSchedule.replayed, true);
    assert.equal(repeatedSchedule.event.eventId, scheduled.eventId);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
