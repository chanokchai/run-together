import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { io as connectSocket } from 'socket.io-client';
import { addVote } from '../src/domain.js';
import { LEGACY_ROOM_ID } from '../src/room-contract.js';
import { hasRoomMember } from '../src/room-storage.js';
import { createServer } from '../src/server.js';

const ENV = { ADMIN_NAME: 'Issue 39 Synthetic Admin', ADMIN_PIN: '4826', PIN_PEPPER: 'issue-39-synthetic-pepper' };
const NOW = new Date('2026-10-27T04:00:00.000Z');
const WEEK = '2026-10-26';
const DATE = '2026-10-28';

async function listen(databasePath) {
  const server = createServer({ databasePath, env: ENV, now: () => NOW });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function stop(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  server.database.close();
}

async function withServer(callback) {
  const directory = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'run-together-issue-39-'));
  const { server, baseUrl } = await listen(join(directory, 'test.sqlite'));
  try {
    await callback(baseUrl, server);
  } finally {
    await stop(server);
    await rm(directory, { recursive: true, force: true });
  }
}

function cookieFrom(response) {
  return response.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
}

async function register(baseUrl, name) {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { origin: baseUrl, 'content-type': 'application/json' },
    body: JSON.stringify({ name, pin: '0042', pinConfirmation: '0042' }),
  });
  const cookie = cookieFrom(response);
  const session = response.ok
    ? await fetch(`${baseUrl}/api/session`, { headers: { cookie } }).then((result) => result.json())
    : {};
  return { response, cookie, csrfToken: session.csrfToken };
}

async function loginAdmin(baseUrl) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { origin: baseUrl, 'content-type': 'application/json' },
    body: JSON.stringify({ name: ENV.ADMIN_NAME, pin: ENV.ADMIN_PIN }),
  });
  const cookie = cookieFrom(response);
  const session = await fetch(`${baseUrl}/api/session`, { headers: { cookie } }).then((result) => result.json());
  return { response, cookie, csrfToken: session.csrfToken };
}

function headers(baseUrl, user, { origin = baseUrl, csrf = true } = {}) {
  return {
    origin,
    cookie: user?.cookie,
    ...(csrf ? { 'x-csrf-token': user?.csrfToken } : {}),
    'content-type': 'application/json',
  };
}

async function createRoom(baseUrl, user, title) {
  const response = await fetch(`${baseUrl}/api/rooms`, {
    method: 'POST', headers: headers(baseUrl, user), body: JSON.stringify({ title }),
  });
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()).room;
}

async function deleteRoom(baseUrl, user, roomId, body = { confirmation: true }, options = {}) {
  return fetch(`${baseUrl}/api/rooms/${encodeURIComponent(roomId)}`, {
    method: 'DELETE', headers: headers(baseUrl, user, options), body: JSON.stringify(body),
  });
}

async function enterRoom(baseUrl, user, roomId) {
  return fetch(`${baseUrl}/api/rooms/${encodeURIComponent(roomId)}/enter`, {
    method: 'POST', headers: headers(baseUrl, user), body: '{}',
  });
}

async function vote(baseUrl, user, roomId, date = DATE, selected = true) {
  return fetch(`${baseUrl}/api/rooms/${encodeURIComponent(roomId)}/votes/${date}`, {
    method: 'PUT', headers: headers(baseUrl, user), body: JSON.stringify({ selected }),
  });
}

function waitForSocket(socket, event = 'connect') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), 3000);
    socket.once(event, (...args) => { clearTimeout(timer); resolve(args); });
    socket.once('connect_error', (error) => { clearTimeout(timer); reject(error); });
  });
}

function subscribeRoom(socket, roomId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out subscribing to room ${roomId}`)), 3000);
    socket.emit('room:subscribe', { roomId }, (result) => {
      clearTimeout(timer);
      if (!result?.ok || result.roomId !== roomId) reject(new Error(`Could not subscribe to room ${roomId}`));
      else resolve(result);
    });
  });
}

function seedRoomEvent(database, roomId, userId, { date = DATE, status = 'proposed' } = {}) {
  database.prepare(`
    INSERT INTO run_events
      (room_id, event_date, status, revision, proposed_by, proposed_by_name, proposed_at,
        scheduled_by, scheduled_by_name, scheduled_at)
    VALUES (?, ?, ?, 1, ?, NULL, ?, ?, NULL, ?)
  `).run(
    roomId, date, status, userId, NOW.toISOString(),
    status === 'scheduled' ? userId : null,
    status === 'scheduled' ? NOW.toISOString() : null,
  );
}

function seedEventRequest(database, roomId, userId, requestId) {
  database.prepare(`
    INSERT INTO run_event_requests
      (room_id, request_id, actor_user_id, action, event_date, event_id,
        expected_revision, requested_status, created_at)
    VALUES (?, ?, ?, 'propose', ?, NULL, NULL, 'proposed', ?)
  `).run(roomId, requestId, userId, DATE, NOW.toISOString());
}

test('Issue 39 DELETE requires same-origin CSRF, confirmation, and room owner or application admin', async () => {
  await withServer(async (baseUrl, server) => {
    const owner = await register(baseUrl, 'Issue 39 Delete Owner');
    const member = await register(baseUrl, 'Issue 39 Delete Member');
    const admin = await loginAdmin(baseUrl);
    assert.equal(owner.response.status, 201);
    assert.equal(member.response.status, 201);
    assert.equal(admin.response.status, 200);
    const owned = await createRoom(baseUrl, owner, 'Owner room');
    const adminTarget = await createRoom(baseUrl, owner, 'Admin room');
    const adminId = server.database.prepare("SELECT id FROM users WHERE role = 'admin'").get().id;
    assert.equal(hasRoomMember(server.database, { roomId: adminTarget.id, userId: adminId }), false,
      'the application admin can manage a room without joining it');

    const unauthenticated = await fetch(`${baseUrl}/api/rooms/${owned.id}`, {
      method: 'DELETE', headers: { origin: baseUrl, 'content-type': 'application/json' },
      body: JSON.stringify({ confirmation: true }),
    });
    assert.equal(unauthenticated.status, 401);

    const foreignOrigin = await deleteRoom(baseUrl, owner, owned.id, { confirmation: true }, { origin: 'https://evil.example' });
    assert.equal(foreignOrigin.status, 403);
    assert.equal((await foreignOrigin.json()).code, 'ORIGIN_MISMATCH');
    const missingCsrf = await deleteRoom(baseUrl, owner, owned.id, { confirmation: true }, { csrf: false });
    assert.equal(missingCsrf.status, 403);
    assert.equal((await missingCsrf.json()).code, 'CSRF_INVALID');

    const denied = await deleteRoom(baseUrl, member, owned.id);
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).code, 'ROOM_OWNER_REQUIRED');

    const cancelled = await deleteRoom(baseUrl, owner, owned.id, { confirmation: false });
    assert.equal(cancelled.status, 400);
    assert.equal((await cancelled.json()).code, 'ROOM_DELETE_CONFIRMATION_REQUIRED');
    assert.ok(server.database.prepare('SELECT id FROM rooms WHERE id = ?').get(owned.id));
    assert.ok(server.database.prepare('SELECT room_id FROM room_memberships WHERE room_id = ?').get(owned.id));

    const ownerDeleted = await deleteRoom(baseUrl, owner, owned.id);
    assert.equal(ownerDeleted.status, 200);
    assert.deepEqual(await ownerDeleted.json(), { deletedRoomId: owned.id });

    const adminDeleted = await deleteRoom(baseUrl, admin, adminTarget.id);
    assert.equal(adminDeleted.status, 200);
    assert.deepEqual(await adminDeleted.json(), { deletedRoomId: adminTarget.id });

    const retry = await deleteRoom(baseUrl, admin, adminTarget.id);
    assert.equal(retry.status, 404);
    assert.equal((await retry.json()).code, 'ROOM_NOT_FOUND');
    assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM rooms WHERE id IN (?, ?)').get(owned.id, adminTarget.id).count, 0);
  });
});

test('Issue 39 deletes exact internal identity and cascades only that room while preserving global state', async () => {
  await withServer(async (baseUrl, server) => {
    const owner = await register(baseUrl, 'Issue 39 Cascade Owner');
    const member = await register(baseUrl, 'Issue 39 Cascade Member');
    const admin = await loginAdmin(baseUrl);
    const target = await createRoom(baseUrl, owner, 'Room to delete');
    const other = await createRoom(baseUrl, owner, 'Room to keep');
    server.database.prepare('UPDATE rooms SET display_number = ? WHERE id = ?').run(target.displayNumber, other.id);
    const ownerId = server.database.prepare('SELECT id FROM users WHERE name_key = ?').get('issue 39 cascade owner').id;
    const memberId = server.database.prepare('SELECT id FROM users WHERE name_key = ?').get('issue 39 cascade member').id;
    const adminId = server.database.prepare("SELECT id FROM users WHERE role = 'admin'").get().id;
    await enterRoom(baseUrl, member, target.id);
    await enterRoom(baseUrl, member, other.id);
    addVote(server.database, { roomId: target.id, userId: ownerId, voteDate: DATE, createdAt: NOW.toISOString() });
    addVote(server.database, { roomId: target.id, userId: memberId, voteDate: DATE, createdAt: NOW.toISOString() });
    addVote(server.database, { roomId: other.id, userId: ownerId, voteDate: DATE, createdAt: NOW.toISOString() });
    seedRoomEvent(server.database, target.id, ownerId, { status: 'scheduled' });
    seedRoomEvent(server.database, other.id, ownerId, { status: 'proposed' });
    seedEventRequest(server.database, target.id, ownerId, 'issue39-cascade-target-request');
    seedEventRequest(server.database, other.id, ownerId, 'issue39-cascade-other-request');
    server.database.prepare(`
      INSERT INTO admin_action_audit
        (request_id, admin_user_id, target_user_id, target_name, action, deleted_vote_count, occurred_at)
      VALUES ('issue39-cascade-audit', ?, ?, 'Issue 39 Cascade Member', 'reset_votes', 0, ?)
    `).run(adminId, memberId, NOW.toISOString());

    const globalBefore = {
      users: server.database.prepare('SELECT * FROM users ORDER BY id').all(),
      sessions: server.database.prepare('SELECT * FROM sessions ORDER BY id').all(),
      audit: server.database.prepare('SELECT * FROM admin_action_audit ORDER BY id').all(),
      otherRoom: server.database.prepare('SELECT * FROM rooms WHERE id = ?').get(other.id),
      otherVotes: server.database.prepare('SELECT * FROM votes WHERE room_id = ? ORDER BY id').all(other.id),
      otherEvents: server.database.prepare('SELECT * FROM run_events WHERE room_id = ? ORDER BY id').all(other.id),
      otherMemberships: server.database.prepare('SELECT * FROM room_memberships WHERE room_id = ? ORDER BY user_id').all(other.id),
      otherRequests: server.database.prepare('SELECT * FROM run_event_requests WHERE room_id = ? ORDER BY request_id').all(other.id),
      identityLedger: server.database.prepare('SELECT * FROM room_identity_ledger ORDER BY room_id').all(),
      migrationLedger: server.database.prepare('SELECT * FROM room_migration_ledger ORDER BY migration_key').all(),
      displayCounter: server.database.prepare('SELECT * FROM room_display_counter').get(),
    };
    const deletion = await deleteRoom(baseUrl, owner, target.id);
    assert.equal(deletion.status, 200);
    assert.deepEqual(await deletion.json(), { deletedRoomId: target.id });

    assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM rooms WHERE id = ?').get(target.id).count, 0);
    for (const table of ['votes', 'run_events', 'room_memberships', 'run_event_requests']) {
      assert.equal(server.database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE room_id = ?`).get(target.id).count, 0, `${table} cascades for the deleted room`);
    }
    assert.deepEqual(server.database.prepare('SELECT * FROM rooms WHERE id = ?').get(other.id), globalBefore.otherRoom);
    assert.deepEqual(server.database.prepare('SELECT * FROM votes WHERE room_id = ? ORDER BY id').all(other.id), globalBefore.otherVotes);
    assert.deepEqual(server.database.prepare('SELECT * FROM run_events WHERE room_id = ? ORDER BY id').all(other.id), globalBefore.otherEvents);
    assert.deepEqual(server.database.prepare('SELECT * FROM room_memberships WHERE room_id = ? ORDER BY user_id').all(other.id), globalBefore.otherMemberships);
    assert.deepEqual(server.database.prepare('SELECT * FROM run_event_requests WHERE room_id = ? ORDER BY request_id').all(other.id), globalBefore.otherRequests);
    assert.deepEqual(server.database.prepare('SELECT * FROM users ORDER BY id').all(), globalBefore.users);
    assert.deepEqual(server.database.prepare('SELECT * FROM sessions ORDER BY id').all(), globalBefore.sessions);
    assert.deepEqual(server.database.prepare('SELECT * FROM admin_action_audit ORDER BY id').all(), globalBefore.audit);
    assert.deepEqual(server.database.prepare('SELECT * FROM room_identity_ledger ORDER BY room_id').all(), globalBefore.identityLedger,
      'the permanent identity ledger prevents reuse');
    assert.deepEqual(server.database.prepare('SELECT * FROM room_migration_ledger ORDER BY migration_key').all(), globalBefore.migrationLedger);
    assert.deepEqual(server.database.prepare('SELECT * FROM room_display_counter').get(), globalBefore.displayCounter);
    assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM rooms WHERE display_number = ?').get(target.displayNumber).count, 1,
      'a colliding display number does not select or delete the other internal room');

    const retry = await deleteRoom(baseUrl, owner, target.id);
    assert.equal(retry.status, 404);
    assert.equal((await retry.json()).code, 'ROOM_NOT_FOUND');
    assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM room_identity_ledger WHERE room_id = ?').get(target.id).count, 1);
  });
});

test('Issue 39 rolls back the full cascade and emits no deletion when a dependent delete fails', async () => {
  await withServer(async (baseUrl, server) => {
    const owner = await register(baseUrl, 'Issue 39 Rollback Owner');
    const member = await register(baseUrl, 'Issue 39 Rollback Member');
    const room = await createRoom(baseUrl, owner, 'Rollback room');
    const ownerId = server.database.prepare('SELECT id FROM users WHERE name_key = ?').get('issue 39 rollback owner').id;
    const memberId = server.database.prepare('SELECT id FROM users WHERE name_key = ?').get('issue 39 rollback member').id;
    await enterRoom(baseUrl, member, room.id);
    addVote(server.database, { roomId: room.id, userId: ownerId, voteDate: DATE, createdAt: NOW.toISOString() });
    seedRoomEvent(server.database, room.id, ownerId);
    seedEventRequest(server.database, room.id, ownerId, 'issue39-rollback-request');
    server.database.exec(`
      CREATE TRIGGER fail_issue39_room_membership_delete
      BEFORE DELETE ON room_memberships
      WHEN OLD.room_id = '${room.id}' AND OLD.user_id = ${memberId}
      BEGIN SELECT RAISE(ABORT, 'forced issue39 cascade rollback'); END
    `);
    const socket = connectSocket(baseUrl, { transports: ['websocket'], extraHeaders: { origin: baseUrl, cookie: owner.cookie } });
    await waitForSocket(socket);
    await subscribeRoom(socket, room.id);
    try {
      let deletedEvents = 0;
      socket.on('room:deleted', () => { deletedEvents += 1; });
      const before = {
        room: server.database.prepare('SELECT * FROM rooms WHERE id = ?').get(room.id),
        votes: server.database.prepare('SELECT * FROM votes WHERE room_id = ?').all(room.id),
        events: server.database.prepare('SELECT * FROM run_events WHERE room_id = ?').all(room.id),
        memberships: server.database.prepare('SELECT * FROM room_memberships WHERE room_id = ?').all(room.id),
        requests: server.database.prepare('SELECT * FROM run_event_requests WHERE room_id = ?').all(room.id),
      };
      const response = await deleteRoom(baseUrl, owner, room.id);
      assert.equal(response.status, 500);
      assert.equal((await response.json()).code, 'SERVER_ERROR');
      assert.deepEqual(server.database.prepare('SELECT * FROM rooms WHERE id = ?').get(room.id), before.room);
      assert.deepEqual(server.database.prepare('SELECT * FROM votes WHERE room_id = ?').all(room.id), before.votes);
      assert.deepEqual(server.database.prepare('SELECT * FROM run_events WHERE room_id = ?').all(room.id), before.events);
      assert.deepEqual(server.database.prepare('SELECT * FROM room_memberships WHERE room_id = ?').all(room.id), before.memberships);
      assert.deepEqual(server.database.prepare('SELECT * FROM run_event_requests WHERE room_id = ?').all(room.id), before.requests);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(deletedEvents, 0, 'the room-deleted notification is not emitted before a committed transaction');
    } finally {
      socket.close();
    }
  });
});

test('Issue 39 broadcasts committed deletion to list and board clients and removes subscriptions', async () => {
  await withServer(async (baseUrl, server) => {
    const owner = await register(baseUrl, 'Issue 39 Realtime Owner');
    const listViewer = await register(baseUrl, 'Issue 39 Realtime List');
    const room = await createRoom(baseUrl, owner, 'Realtime deletion');
    const listSocket = connectSocket(baseUrl, { transports: ['websocket'], extraHeaders: { origin: baseUrl, cookie: listViewer.cookie } });
    const boardSocket = connectSocket(baseUrl, { transports: ['websocket'], extraHeaders: { origin: baseUrl, cookie: owner.cookie } });
    await Promise.all([waitForSocket(listSocket), waitForSocket(boardSocket)]);
    await subscribeRoom(boardSocket, room.id);
    try {
      const listDeleted = new Promise((resolve) => listSocket.once('room:deleted', resolve));
      const boardDeleted = new Promise((resolve) => boardSocket.once('room:deleted', resolve));
      const response = await deleteRoom(baseUrl, owner, room.id);
      assert.equal(response.status, 200);
      assert.deepEqual(await listDeleted, { roomId: room.id });
      assert.deepEqual(await boardDeleted, { roomId: room.id });
      await new Promise((resolve) => setTimeout(resolve, 100));
      const expectedBoardChannel = server.io.sockets.adapter.rooms.get(`board:${room.id}`);
      assert.equal(expectedBoardChannel?.size ?? 0, 0);
      for (const socket of server.io.sockets.sockets.values()) {
        assert.equal(socket.data.roomIds.has(room.id), false, 'the deleted room is removed from every socket room set');
      }
      const subscribedAgain = await new Promise((resolve) => boardSocket.emit('room:subscribe', { roomId: room.id }, resolve));
      assert.deepEqual(subscribedAgain, { ok: false, code: 'ROOM_NOT_FOUND' });
      assert.deepEqual((await fetch(`${baseUrl}/api/rooms`, { headers: { cookie: listViewer.cookie } }).then((result) => result.json())).rooms
        .some(({ id }) => id === room.id), false);
    } finally {
      listSocket.close();
      boardSocket.close();
    }
  });
});

test('Issue 39 serializes concurrent owner/admin deletions and emits one committed notification', async () => {
  await withServer(async (baseUrl, server) => {
    const owner = await register(baseUrl, 'Issue 39 Concurrent Owner');
    const admin = await loginAdmin(baseUrl);
    const room = await createRoom(baseUrl, owner, 'Concurrent deletion');
    const socket = connectSocket(baseUrl, { transports: ['websocket'], extraHeaders: { origin: baseUrl, cookie: owner.cookie } });
    await waitForSocket(socket);
    await subscribeRoom(socket, room.id);
    try {
      let deletedEvents = 0;
      socket.on('room:deleted', ({ roomId }) => {
        assert.equal(roomId, room.id);
        deletedEvents += 1;
      });
      const [ownerResponse, adminResponse] = await Promise.all([
        deleteRoom(baseUrl, owner, room.id),
        deleteRoom(baseUrl, admin, room.id),
      ]);
      const results = await Promise.all([ownerResponse, adminResponse].map(async (response) => ({
        status: response.status,
        body: await response.json(),
      })));
      assert.deepEqual(results.map(({ status }) => status).sort(), [200, 404]);
      assert.deepEqual(results.find(({ status }) => status === 200)?.body, { deletedRoomId: room.id });
      assert.deepEqual(results.find(({ status }) => status === 404)?.body.code, 'ROOM_NOT_FOUND');
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(deletedEvents, 1, 'only the transaction that deleted the room broadcasts its notification');
      assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM rooms WHERE id = ?').get(room.id).count, 0);
      assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM room_identity_ledger WHERE room_id = ?').get(room.id).count, 1);
    } finally {
      socket.close();
    }
  });
});

test('Issue 39 blocks stale room reads, writes, metadata, entry, reset, retry, and subscriptions', async () => {
  await withServer(async (baseUrl, server) => {
    const owner = await register(baseUrl, 'Issue 39 Stale Owner');
    const admin = await loginAdmin(baseUrl);
    const room = await createRoom(baseUrl, owner, 'Stale room');
    const other = await createRoom(baseUrl, owner, 'Unrelated room');
    const deleted = await deleteRoom(baseUrl, owner, room.id);
    assert.equal(deleted.status, 200);
    const routes = [
      ['GET', `/api/rooms/${room.id}`, null, owner],
      ['POST', `/api/rooms/${room.id}/enter`, {}, owner],
      ['PUT', `/api/rooms/${room.id}`, { title: 'Resurrected' }, owner],
      ['GET', `/api/rooms/${room.id}/weeks/${WEEK}`, null, owner],
      ['GET', `/api/rooms/${room.id}/vote-timeline`, null, owner],
      ['PUT', `/api/rooms/${room.id}/votes/${DATE}`, { selected: true }, owner],
      ['POST', `/api/rooms/${room.id}/events/${DATE}`, { requestId: 'issue39-stale-proposal' }, owner],
      ['DELETE', `/api/rooms/${room.id}/events/${DATE}`, { eventId: 1, revision: 1, requestId: 'issue39-stale-withdraw' }, owner],
      ['PUT', `/api/rooms/${room.id}/admin/events/${DATE}`, { eventId: 1, revision: 1, requestId: 'issue39-stale-schedule', status: 'scheduled' }, admin],
      ['DELETE', `/api/rooms/${room.id}/admin/events/${DATE}`, { eventId: 1, revision: 1, requestId: 'issue39-stale-delete-event' }, admin],
      ['DELETE', `/api/rooms/${room.id}/admin/weeks/${WEEK}/votes`, { confirmation: true }, admin],
    ];
    for (const [method, path, body, user] of routes) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: headers(baseUrl, user),
        ...(body === null ? {} : { body: JSON.stringify(body) }),
      });
      assert.equal(response.status, 404, `${method} ${path} must not recreate or mutate a deleted room`);
      assert.equal((await response.json()).code, 'ROOM_NOT_FOUND');
    }
    const stalePage = await fetch(`${baseUrl}/vote/${room.id}`, { headers: { cookie: owner.cookie } });
    assert.equal(stalePage.status, 404);
    const retry = await deleteRoom(baseUrl, owner, room.id);
    assert.equal(retry.status, 404);
    assert.equal((await retry.json()).code, 'ROOM_NOT_FOUND');
    assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM rooms WHERE id = ?').get(room.id).count, 0);
    assert.ok(server.database.prepare('SELECT id FROM rooms WHERE id = ?').get(other.id));
    assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM votes WHERE room_id = ?').get(other.id).count, 0);
    assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM run_events WHERE room_id = ?').get(other.id).count, 0);

    const staleSocket = connectSocket(baseUrl, { transports: ['websocket'], extraHeaders: { origin: baseUrl, cookie: owner.cookie } });
    await waitForSocket(staleSocket);
    try {
      const result = await new Promise((resolve) => staleSocket.emit('room:subscribe', { roomId: room.id }, resolve));
      assert.deepEqual(result, { ok: false, code: 'ROOM_NOT_FOUND' });
    } finally {
      staleSocket.close();
    }
  });
});

test('Issue 39 runs the A/B/C versus A/C/D lifecycle without cross-room effects or elevated user privileges', async () => {
  await withServer(async (baseUrl, server) => {
    const [a, b, c, d] = await Promise.all([
      register(baseUrl, 'Issue 39 Runner A'),
      register(baseUrl, 'Issue 39 Runner B'),
      register(baseUrl, 'Issue 39 Runner C'),
      register(baseUrl, 'Issue 39 Runner D'),
    ]);
    const admin = await loginAdmin(baseUrl);
    const roomOne = await createRoom(baseUrl, a, 'A B C room');
    const roomTwo = await createRoom(baseUrl, a, 'A C D room');
    for (const [user, roomId] of [[b, roomOne.id], [c, roomOne.id], [c, roomTwo.id], [d, roomTwo.id]]) {
      assert.equal((await enterRoom(baseUrl, user, roomId)).status, 200);
    }
    const roster = [
      [a, roomOne.id], [b, roomOne.id], [c, roomOne.id],
      [a, roomTwo.id], [c, roomTwo.id], [d, roomTwo.id],
    ];
    for (const [user, roomId] of roster) assert.equal((await vote(baseUrl, user, roomId)).status, 200);
    const counts = () => Object.fromEntries([roomOne.id, roomTwo.id].map((roomId) => [
      roomId, server.database.prepare('SELECT COUNT(*) AS count FROM votes WHERE room_id = ? AND vote_date = ?').get(roomId, DATE).count,
    ]));
    assert.deepEqual(counts(), { [roomOne.id]: 3, [roomTwo.id]: 3 }, 'both rooms can vote on the same date independently');

    const proposalOne = await fetch(`${baseUrl}/api/rooms/${roomOne.id}/events/${DATE}`, {
      method: 'POST', headers: headers(baseUrl, a), body: JSON.stringify({ requestId: randomUUID() }),
    });
    assert.equal(proposalOne.status, 201);
    let eventOne = (await proposalOne.json()).event;
    for (const status of ['scheduled', 'proposed', 'scheduled']) {
      const changed = await fetch(`${baseUrl}/api/rooms/${roomOne.id}/admin/events/${DATE}`, {
        method: 'PUT', headers: headers(baseUrl, a),
        body: JSON.stringify({ eventId: eventOne.eventId, revision: eventOne.revision, requestId: randomUUID(), status }),
      });
      assert.equal(changed.status, 200);
      eventOne = (await changed.json()).event;
      assert.equal(eventOne.status, status);
    }
    const eventDeleted = await fetch(`${baseUrl}/api/rooms/${roomOne.id}/admin/events/${DATE}`, {
      method: 'DELETE', headers: headers(baseUrl, a),
      body: JSON.stringify({ eventId: eventOne.eventId, revision: eventOne.revision, requestId: randomUUID() }),
    });
    assert.equal(eventDeleted.status, 200);
    assert.equal((await eventDeleted.json()).event, null);
    const proposalTwo = await fetch(`${baseUrl}/api/rooms/${roomTwo.id}/events/${DATE}`, {
      method: 'POST', headers: headers(baseUrl, c), body: JSON.stringify({ requestId: randomUUID() }),
    });
    assert.equal(proposalTwo.status, 201);
    assert.equal(server.database.prepare('SELECT status FROM run_events WHERE room_id = ? AND event_date = ?').get(roomTwo.id, DATE).status, 'proposed');
    assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM run_events WHERE room_id = ?').get(roomOne.id).count, 0,
      'scheduling, reverting, and deleting a room-one event does not mutate room two');

    const resetOne = await fetch(`${baseUrl}/api/rooms/${roomOne.id}/admin/weeks/${WEEK}/votes`, {
      method: 'DELETE', headers: headers(baseUrl, a), body: JSON.stringify({ confirmation: true }),
    });
    assert.equal(resetOne.status, 204);
    assert.deepEqual(counts(), { [roomOne.id]: 0, [roomTwo.id]: 3 }, 'the week reset is limited to its explicit room');
    assert.equal(server.database.prepare('SELECT status FROM run_events WHERE room_id = ? AND event_date = ?').get(roomTwo.id, DATE).status, 'proposed');

    const userCId = server.database.prepare('SELECT id FROM users WHERE name_key = ?').get('issue 39 runner c').id;
    for (const roomId of [roomOne.id, roomTwo.id]) assert.equal((await vote(baseUrl, c, roomId)).status, 200);
    const ownerCannotResetGlobalVotes = await fetch(`${baseUrl}/api/admin/users/${userCId}/votes`, {
      method: 'DELETE', headers: headers(baseUrl, a), body: JSON.stringify({ requestId: randomUUID() }),
    });
    assert.equal(ownerCannotResetGlobalVotes.status, 403);
    const ownerCannotResetGlobalPin = await fetch(`${baseUrl}/api/admin/users/${userCId}/pin`, {
      method: 'PUT', headers: headers(baseUrl, a), body: JSON.stringify({ newPin: '5937', newPinConfirmation: '5937' }),
    });
    assert.equal(ownerCannotResetGlobalPin.status, 403);
    const ownerCannotDeleteAccount = await fetch(`${baseUrl}/api/admin/users/${userCId}`, {
      method: 'DELETE', headers: headers(baseUrl, a), body: JSON.stringify({ requestId: randomUUID() }),
    });
    assert.equal(ownerCannotDeleteAccount.status, 403);

    const resetC = await fetch(`${baseUrl}/api/admin/users/${userCId}/votes`, {
      method: 'DELETE', headers: headers(baseUrl, admin), body: JSON.stringify({ confirmation: true, requestId: randomUUID() }),
    });
    assert.equal(resetC.status, 200);
    assert.equal((await resetC.json()).deletedVoteCount, 2, 'application-wide vote cleanup spans both rooms');
    assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM votes WHERE user_id = ?').get(userCId).count, 0);

    const resetPin = await fetch(`${baseUrl}/api/admin/users/${userCId}/pin`, {
      method: 'PUT', headers: headers(baseUrl, admin),
      body: JSON.stringify({ newPin: '5937', newPinConfirmation: '5937' }),
    });
    assert.equal(resetPin.status, 204);
    assert.equal((await fetch(`${baseUrl}/api/session`, { headers: { cookie: c.cookie } })).status, 401,
      'application-wide PIN reset continues to revoke sessions');

    assert.equal((await vote(baseUrl, a, roomOne.id)).status, 200);
    const userAId = server.database.prepare('SELECT id FROM users WHERE name_key = ?').get('issue 39 runner a').id;
    const deleteA = await fetch(`${baseUrl}/api/admin/users/${userAId}`, {
      method: 'DELETE', headers: headers(baseUrl, admin), body: JSON.stringify({ confirmation: true, requestId: randomUUID() }),
    });
    assert.equal(deleteA.status, 200);
    assert.equal((await fetch(`${baseUrl}/api/session`, { headers: { cookie: a.cookie } })).status, 401);
    assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM votes WHERE user_id = ?').get(userAId).count, 0);
    for (const roomId of [roomOne.id, roomTwo.id]) {
      const retained = server.database.prepare('SELECT id, owner_user_id FROM rooms WHERE id = ?').get(roomId);
      assert.ok(retained, 'deleting the creator account retains its rooms');
      assert.equal(retained.owner_user_id, server.database.prepare("SELECT id FROM users WHERE role = 'admin'").get().id);
      assert.equal(hasRoomMember(server.database, { roomId, userId: retained.owner_user_id }), true,
        'application admin receives membership when ownership transfers');
    }
    for (const roomId of [roomOne.id, roomTwo.id]) {
      const deletion = await deleteRoom(baseUrl, admin, roomId);
      assert.equal(deletion.status, 200, 'the application admin can delete a transferred room');
      assert.deepEqual(await deletion.json(), { deletedRoomId: roomId });
    }
  });
});

test('Issue 39 keeps the final room deletion empty after restart and permits a new room', async () => {
  const directory = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'run-together-issue-39-restart-'));
  const databasePath = join(directory, 'issue-39-restart.sqlite');
  let running = await listen(databasePath);
  try {
    const owner = await register(running.baseUrl, 'Issue 39 Restart Owner');
    const admin = await loginAdmin(running.baseUrl);
    const lastRoom = await createRoom(running.baseUrl, owner, 'Last room');
    const oldIds = [LEGACY_ROOM_ID, lastRoom.id];
    assert.equal((await deleteRoom(running.baseUrl, admin, LEGACY_ROOM_ID)).status, 200);
    assert.equal((await deleteRoom(running.baseUrl, owner, lastRoom.id)).status, 200);
    const ledgerBefore = running.server.database.prepare('SELECT room_id FROM room_identity_ledger ORDER BY room_id').all();
    const displayCounterBefore = running.server.database.prepare('SELECT * FROM room_display_counter').get();
    assert.equal(running.server.database.prepare('SELECT COUNT(*) AS count FROM rooms').get().count, 0);
    await stop(running.server);

    running = await listen(databasePath);
    assert.equal(running.server.database.prepare('SELECT COUNT(*) AS count FROM rooms').get().count, 0,
      'restart does not re-create the legacy Room 01');
    assert.deepEqual(running.server.database.prepare('SELECT room_id FROM room_identity_ledger ORDER BY room_id').all(), ledgerBefore);
    assert.deepEqual(running.server.database.prepare('SELECT * FROM room_display_counter').get(), displayCounterBefore);
    const emptyList = await fetch(`${running.baseUrl}/api/rooms`, { headers: { cookie: owner.cookie } }).then((response) => response.json());
    assert.deepEqual(emptyList.rooms, []);
    const listPage = await fetch(`${running.baseUrl}/rooms`, { headers: { cookie: owner.cookie } });
    assert.equal(listPage.status, 200);
    assert.match(await listPage.text(), /Create room \/ สร้างห้อง/);
    const created = await createRoom(running.baseUrl, owner, 'Created after restart');
    assert.ok(created.id);
    assert.equal(oldIds.includes(created.id), false, 'deleted internal room IDs are never reused');
    assert.equal(created.displayNumber, displayCounterBefore.next_display_number);
  } finally {
    await stop(running.server);
    await rm(directory, { recursive: true, force: true });
  }
});
