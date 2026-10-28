import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { io as connectSocket } from 'socket.io-client';
import { openDatabase } from '../src/database.js';
import { createServer } from '../src/server.js';
import { ROOM_COLOR_PALETTE } from '../src/room-contract.js';

const ENV = { ADMIN_NAME: 'Issue 37 Admin', ADMIN_PIN: '4826', PIN_PEPPER: 'synthetic-pepper' };
const NOW = new Date('2026-10-27T04:00:00.000Z');

async function withServer(callback, now = () => NOW) {
  const directory = await mkdtemp(join(tmpdir(), 'run-together-issue-37-'));
  const server = createServer({ databasePath: join(directory, 'test.sqlite'), env: ENV, now });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await callback(`http://127.0.0.1:${server.address().port}`, server, directory);
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

async function register(baseUrl, name) {
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { origin: baseUrl, 'content-type': 'application/json' },
    body: JSON.stringify({ name, pin: '0042', pinConfirmation: '0042' }),
  });
  return { response, cookie: cookieFrom(response) };
}

async function roomRequest(baseUrl, path, { cookie, csrfToken, method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(method !== 'GET' ? { origin: baseUrl, 'x-csrf-token': csrfToken, 'content-type': 'application/json' } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const parsedBody = response.status === 204 ? null
    : response.headers.get('content-type')?.includes('application/json') ? await response.json()
      : await response.text();
  return { response, body: parsedBody };
}

async function csrfFor(baseUrl, cookie) {
  return fetch(`${baseUrl}/api/session`, { headers: { cookie } }).then((response) => response.json())
    .then(({ csrfToken }) => csrfToken);
}

async function loginAdmin(baseUrl) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { origin: baseUrl, 'content-type': 'application/json' },
    body: JSON.stringify({ name: ENV.ADMIN_NAME, pin: ENV.ADMIN_PIN }),
  });
  const cookie = cookieFrom(response);
  return { response, cookie, csrfToken: await csrfFor(baseUrl, cookie) };
}

async function connectAuthenticatedSocket(baseUrl, cookie, beforeConnect = () => {}) {
  const socket = connectSocket(baseUrl, {
    autoConnect: false,
    transports: ['websocket'],
    extraHeaders: { origin: baseUrl, cookie },
  });
  beforeConnect(socket);
  const connected = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket connection timed out')), 2000);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('connect_error', (error) => { clearTimeout(timer); reject(error); });
  });
  socket.connect();
  await connected;
  return socket;
}

function subscribeToRoom(socket, roomId) {
  return new Promise((resolve) => socket.emit('room:subscribe', { roomId }, resolve));
}

function refreshRoomSummaries(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('room summary refresh timed out')), 1000);
    socket.emit('rooms:refresh', (result) => { clearTimeout(timer); resolve(result); });
  });
}

test('Issue 37 room APIs create safe rooms, record idempotent entry, and limit metadata edits to the owner', async () => {
  await withServer(async (baseUrl, server, directory) => {
    const owner = await register(baseUrl, 'Issue 37 Room Owner');
    const member = await register(baseUrl, 'Issue 37 Room Member');
    const appAdmin = await loginAdmin(baseUrl);
    const ownerCsrf = await csrfFor(baseUrl, owner.cookie);
    const memberCsrf = await csrfFor(baseUrl, member.cookie);

    const created = await roomRequest(baseUrl, '/api/rooms', {
      cookie: owner.cookie, csrfToken: ownerCsrf, method: 'POST',
      body: { title: '  Morning Team  ', icon: 'football' },
    });
    assert.equal(created.response.status, 201);
    assert.match(created.body.room.id, /^[0-9a-f-]{36}$/);
    assert.equal(created.body.room.title, 'Morning Team');
    assert.equal(created.body.room.icon, 'football');
    assert.ok(ROOM_COLOR_PALETTE.includes(created.body.room.color));
    assert.equal(created.body.room.ownerUserId > 0, true);
    const roomId = created.body.room.id;

    const listed = await roomRequest(baseUrl, '/api/rooms', { cookie: member.cookie });
    assert.equal(listed.response.status, 200);
    assert.ok(listed.body.rooms.some(({ id }) => id === roomId));
    const detail = await roomRequest(baseUrl, `/api/rooms/${roomId}`, { cookie: member.cookie });
    assert.equal(detail.response.status, 200);
    assert.equal(detail.body.room.id, roomId);

    for (let index = 0; index < 2; index += 1) {
      const entered = await roomRequest(baseUrl, `/api/rooms/${roomId}/enter`, {
        cookie: member.cookie, csrfToken: memberCsrf, method: 'POST', body: {},
      });
      assert.equal(entered.response.status, 200);
    }
    const memberId = server.database.prepare('SELECT id FROM users WHERE name = ?').get('Issue 37 Room Member').id;
    assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM room_memberships WHERE room_id = ? AND user_id = ?')
      .get(roomId, memberId).count, 1);

    const edited = await roomRequest(baseUrl, `/api/rooms/${roomId}`, {
      cookie: owner.cookie, csrfToken: ownerCsrf, method: 'PUT', body: { title: 'Evening Team', icon: 'cycling' },
    });
    assert.equal(edited.response.status, 200);
    assert.equal(edited.body.room.title, 'Evening Team');
    assert.equal(edited.body.room.icon, 'cycling');
    assert.equal(edited.body.room.color, created.body.room.color);
    const reopenedDatabase = openDatabase(join(directory, 'test.sqlite'));
    try {
      const persisted = reopenedDatabase.prepare('SELECT title, icon, color FROM rooms WHERE id = ?').get(roomId);
      assert.deepEqual(persisted, { title: 'Evening Team', icon: 'cycling', color: created.body.room.color });
    } finally {
      reopenedDatabase.close();
    }

    const denied = await roomRequest(baseUrl, `/api/rooms/${roomId}`, {
      cookie: member.cookie, csrfToken: memberCsrf, method: 'PUT', body: { icon: 'swimming' },
    });
    assert.equal(denied.response.status, 403);
    const unsafeIcon = await roomRequest(baseUrl, `/api/rooms/${roomId}`, {
      cookie: owner.cookie, csrfToken: ownerCsrf, method: 'PUT', body: { icon: '<svg onload=alert(1)>' },
    });
    assert.equal(unsafeIcon.response.status, 400);
    const unrelatedAdminEdit = await roomRequest(baseUrl, `/api/rooms/${roomId}`, {
      cookie: appAdmin.cookie, csrfToken: appAdmin.csrfToken, method: 'PUT', body: { title: 'Admin Cannot Take Over' },
    });
    assert.equal(unrelatedAdminEdit.response.status, 403);
    const unsupported = await roomRequest(baseUrl, `/api/rooms/${roomId}`, {
      cookie: owner.cookie, csrfToken: ownerCsrf, method: 'PUT', body: { color: '#ffffff' },
    });
    assert.equal(unsupported.response.status, 400);
    assert.equal((await roomRequest(baseUrl, `/api/rooms/${roomId}`, { cookie: owner.cookie })).body.room.title, 'Evening Team');
  });
});

test('Issue 37 same-date votes, week reads, timelines, and event retries stay in each permanent room identity', async () => {
  await withServer(async (baseUrl) => {
    const users = {};
    for (const name of ['A', 'B', 'C', 'D']) users[name] = await register(baseUrl, `Room Isolation ${name}`);
    const tokens = {};
    for (const name of Object.keys(users)) tokens[name] = await csrfFor(baseUrl, users[name].cookie);
    const createRoomFor = async (title) => {
      const { response, body } = await roomRequest(baseUrl, '/api/rooms', {
        cookie: users.A.cookie, csrfToken: tokens.A, method: 'POST', body: { title },
      });
      assert.equal(response.status, 201);
      return body.room.id;
    };
    const roomOne = await createRoomFor('A B C');
    const roomTwo = await createRoomFor('A C D');
    for (const name of ['B', 'C']) {
      assert.equal((await roomRequest(baseUrl, `/api/rooms/${roomOne}/enter`, {
        cookie: users[name].cookie, csrfToken: tokens[name], method: 'POST', body: {},
      })).response.status, 200);
    }
    for (const name of ['C', 'D']) {
      assert.equal((await roomRequest(baseUrl, `/api/rooms/${roomTwo}/enter`, {
        cookie: users[name].cookie, csrfToken: tokens[name], method: 'POST', body: {},
      })).response.status, 200);
    }

    for (const name of ['A', 'B', 'C']) {
      const vote = await roomRequest(baseUrl, `/api/rooms/${roomOne}/votes/2026-10-28`, {
        cookie: users[name].cookie, csrfToken: tokens[name], method: 'PUT', body: { selected: true },
      });
      assert.equal(vote.response.status, 200, JSON.stringify(vote.body));
      assert.equal(vote.body.roomId, roomOne);
    }
    for (const name of ['A', 'C', 'D']) {
      const vote = await roomRequest(baseUrl, `/api/rooms/${roomTwo}/votes/2026-10-28`, {
        cookie: users[name].cookie, csrfToken: tokens[name], method: 'PUT', body: { selected: true },
      });
      assert.equal(vote.response.status, 200);
      assert.equal(vote.body.roomId, roomTwo);
    }

    const weekOne = await roomRequest(baseUrl, `/api/rooms/${roomOne}/weeks/2026-10-26`, { cookie: users.A.cookie });
    const weekTwo = await roomRequest(baseUrl, `/api/rooms/${roomTwo}/weeks/2026-10-26`, { cookie: users.A.cookie });
    assert.equal(weekOne.body.days.find(({ date }) => date === '2026-10-28').voteCount, 3);
    assert.equal(weekTwo.body.days.find(({ date }) => date === '2026-10-28').voteCount, 3);
    assert.deepEqual(weekOne.body.days.find(({ date }) => date === '2026-10-28').voterNames,
      ['Room Isolation A', 'Room Isolation B', 'Room Isolation C']);
    assert.deepEqual(weekTwo.body.days.find(({ date }) => date === '2026-10-28').voterNames,
      ['Room Isolation A', 'Room Isolation C', 'Room Isolation D']);

    const proposalId = '13700000-0000-4000-8000-000000000001';
    const proposalOne = await roomRequest(baseUrl, `/api/rooms/${roomOne}/events/2026-10-28`, {
      cookie: users.C.cookie, csrfToken: tokens.C, method: 'POST', body: { requestId: proposalId },
    });
    const proposalTwo = await roomRequest(baseUrl, `/api/rooms/${roomTwo}/events/2026-10-28`, {
      cookie: users.C.cookie, csrfToken: tokens.C, method: 'POST', body: { requestId: proposalId },
    });
    assert.equal(proposalOne.response.status, 201);
    assert.equal(proposalTwo.response.status, 201);
    assert.notEqual(proposalOne.body.event.eventId, proposalTwo.body.event.eventId);
    const wrongRoomIdentity = await roomRequest(baseUrl, `/api/rooms/${roomTwo}/admin/events/2026-10-28`, {
      cookie: users.A.cookie, csrfToken: tokens.A, method: 'PUT',
      body: { eventId: proposalOne.body.event.eventId, revision: proposalOne.body.event.revision,
        status: 'scheduled', requestId: '13700000-0000-4000-8000-000000000002' },
    });
    assert.equal(wrongRoomIdentity.response.status, 409);
    const unchangedRoomTwo = await roomRequest(baseUrl, `/api/rooms/${roomTwo}/weeks/2026-10-26`, {
      cookie: users.A.cookie,
    });
    assert.equal(unchangedRoomTwo.body.events[0].eventId, proposalTwo.body.event.eventId);
    assert.equal(unchangedRoomTwo.body.events[0].status, 'proposed');
    assert.equal((await roomRequest(baseUrl, `/api/rooms/${roomOne}/events/2026-10-28`, {
      cookie: users.C.cookie, csrfToken: tokens.C, method: 'POST', body: { requestId: proposalId },
    })).body.replayed, true);
    assert.equal((await roomRequest(baseUrl, `/api/rooms/${roomOne}/weeks/2026-10-26`, { cookie: users.A.cookie }))
      .body.events[0].roomId, roomOne);
    assert.equal((await roomRequest(baseUrl, `/api/rooms/${roomTwo}/weeks/2026-10-26`, { cookie: users.A.cookie }))
      .body.events[0].roomId, roomTwo);
  });
});

test('Issue 37 room owners manage only their rooms while application admin retains global authority', async () => {
  await withServer(async (baseUrl, server) => {
    const ownerOne = await register(baseUrl, 'Issue 37 Owner One');
    const ownerTwo = await register(baseUrl, 'Issue 37 Owner Two');
    const member = await register(baseUrl, 'Issue 37 Ordinary Member');
    const ownerOneCsrf = await csrfFor(baseUrl, ownerOne.cookie);
    const ownerTwoCsrf = await csrfFor(baseUrl, ownerTwo.cookie);
    const memberCsrf = await csrfFor(baseUrl, member.cookie);
    const admin = await loginAdmin(baseUrl);
    assert.equal(admin.response.status, 200);

    const create = async (owner, csrfToken, title) => (await roomRequest(baseUrl, '/api/rooms', {
      cookie: owner.cookie, csrfToken, method: 'POST', body: { title },
    })).body.room.id;
    const roomOne = await create(ownerOne, ownerOneCsrf, 'Owner One Room');
    const roomTwo = await create(ownerTwo, ownerTwoCsrf, 'Owner Two Room');
    const enter = async (roomId, user, csrfToken) => roomRequest(baseUrl, `/api/rooms/${roomId}/enter`, {
      cookie: user.cookie, csrfToken, method: 'POST', body: {},
    });
    await enter(roomOne, ownerTwo, ownerTwoCsrf);
    await enter(roomTwo, ownerOne, ownerOneCsrf);
    await enter(roomOne, member, memberCsrf);
    await enter(roomTwo, member, memberCsrf);
    await enter(roomOne, admin, admin.csrfToken);
    await enter(roomTwo, admin, admin.csrfToken);

    const prepareEvent = async (roomId, user, csrfToken, requestNumber) => {
      const vote = await roomRequest(baseUrl, `/api/rooms/${roomId}/votes/2026-10-28`, {
        cookie: user.cookie, csrfToken, method: 'PUT', body: { selected: true },
      });
      assert.equal(vote.response.status, 200);
      const proposal = await roomRequest(baseUrl, `/api/rooms/${roomId}/events/2026-10-28`, {
        cookie: user.cookie, csrfToken, method: 'POST',
        body: { requestId: `13700000-0000-4000-8000-${String(requestNumber).padStart(12, '0')}` },
      });
      assert.equal(proposal.response.status, 201);
      return proposal.body.event;
    };
    const eventOne = await prepareEvent(roomOne, ownerOne, ownerOneCsrf, 101);
    const eventTwo = await prepareEvent(roomTwo, ownerTwo, ownerTwoCsrf, 102);
    const schedule = (roomId, event, user, csrfToken, requestNumber) => roomRequest(
      baseUrl, `/api/rooms/${roomId}/admin/events/2026-10-28`, {
        cookie: user.cookie, csrfToken, method: 'PUT',
        body: { eventId: event.eventId, revision: event.revision, status: 'scheduled',
          requestId: `13700000-0000-4000-8000-${String(requestNumber).padStart(12, '0')}` },
      },
    );

    const ownerSchedulesOwn = await schedule(roomOne, eventOne, ownerOne, ownerOneCsrf, 201);
    assert.equal(ownerSchedulesOwn.response.status, 200);
    assert.equal(ownerSchedulesOwn.body.event.status, 'scheduled');
    assert.equal(ownerSchedulesOwn.body.roomId, roomOne);
    assert.equal((await schedule(roomTwo, eventTwo, ownerOne, ownerOneCsrf, 202)).response.status, 403);
    assert.equal((await schedule(roomOne, eventOne, member, memberCsrf, 203)).response.status, 403);
    assert.equal((await schedule(roomOne, eventOne, member, memberCsrf, 201)).response.status, 403);
    assert.equal((await schedule(roomTwo, eventOne, admin, admin.csrfToken, 208)).response.status, 409);

    const adminSchedulesOther = await schedule(roomTwo, eventTwo, admin, admin.csrfToken, 204);
    assert.equal(adminSchedulesOther.response.status, 200);
    assert.equal(adminSchedulesOther.body.event.status, 'scheduled');

    const resetOwn = await roomRequest(baseUrl, `/api/rooms/${roomOne}/admin/weeks/2026-10-26/votes`, {
      cookie: ownerOne.cookie, csrfToken: ownerOneCsrf, method: 'DELETE', body: { confirmation: true },
    });
    assert.equal(resetOwn.response.status, 204);
    const resetOther = await roomRequest(baseUrl, `/api/rooms/${roomTwo}/admin/weeks/2026-10-26/votes`, {
      cookie: ownerOne.cookie, csrfToken: ownerOneCsrf, method: 'DELETE', body: { confirmation: true },
    });
    assert.equal(resetOther.response.status, 403);
    const memberReset = await roomRequest(baseUrl, `/api/rooms/${roomOne}/admin/weeks/2026-10-26/votes`, {
      cookie: member.cookie, csrfToken: memberCsrf, method: 'DELETE', body: { confirmation: true },
    });
    assert.equal(memberReset.response.status, 403);
    const adminReset = await roomRequest(baseUrl, `/api/rooms/${roomTwo}/admin/weeks/2026-10-26/votes`, {
      cookie: admin.cookie, csrfToken: admin.csrfToken, method: 'DELETE', body: { confirmation: true },
    });
    assert.equal(adminReset.response.status, 204);
    assert.equal((await roomRequest(baseUrl, `/api/rooms/${roomOne}/votes/2026-10-28`, {
      cookie: ownerOne.cookie, csrfToken: ownerOneCsrf, method: 'PUT', body: { selected: true },
    })).response.status, 200);

    const ownerRevertsOwn = await roomRequest(baseUrl, `/api/rooms/${roomOne}/admin/events/2026-10-28`, {
      cookie: ownerOne.cookie, csrfToken: ownerOneCsrf, method: 'PUT',
      body: { eventId: eventOne.eventId, revision: ownerSchedulesOwn.body.event.revision, status: 'proposed',
        requestId: '13700000-0000-4000-8000-000000000205' },
    });
    assert.equal(ownerRevertsOwn.response.status, 200);
    assert.equal(ownerRevertsOwn.body.event.status, 'proposed');
    const ownerDeletesOwn = await roomRequest(baseUrl, `/api/rooms/${roomOne}/admin/events/2026-10-28`, {
      cookie: ownerOne.cookie, csrfToken: ownerOneCsrf, method: 'DELETE',
      body: { eventId: eventOne.eventId, revision: ownerRevertsOwn.body.event.revision,
        requestId: '13700000-0000-4000-8000-000000000206' },
    });
    assert.equal(ownerDeletesOwn.response.status, 200);
    assert.equal(ownerDeletesOwn.body.event, null);

    const memberVotes = await roomRequest(baseUrl, `/api/rooms/${roomOne}/votes/2026-10-28`, {
      cookie: member.cookie, csrfToken: memberCsrf, method: 'PUT', body: { selected: false },
    });
    assert.equal(memberVotes.response.status, 200);
    const deniedUsers = await roomRequest(baseUrl, '/api/admin/users', { cookie: ownerOne.cookie });
    assert.equal(deniedUsers.response.status, 403);
    const deniedReset = await roomRequest(baseUrl, '/api/admin/users/2/votes', {
      cookie: ownerOne.cookie, csrfToken: ownerOneCsrf, method: 'DELETE',
      body: { confirmation: true, requestId: '13700000-0000-4000-8000-000000000205' },
    });
    assert.equal(deniedReset.response.status, 403);
    const ownerOneId = server.database.prepare('SELECT id FROM users WHERE name = ?').get('Issue 37 Owner One').id;
    const deniedPinReset = await roomRequest(baseUrl, `/api/admin/users/${ownerOneId}/pin`, {
      cookie: ownerOne.cookie, csrfToken: ownerOneCsrf, method: 'PUT', body: { pin: '1111', pinConfirmation: '1111' },
    });
    assert.equal(deniedPinReset.response.status, 403);
    const deniedDelete = await roomRequest(baseUrl, `/api/admin/users/${ownerOneId}`, {
      cookie: ownerOne.cookie, csrfToken: ownerOneCsrf, method: 'DELETE',
      body: { confirmation: true, requestId: '13700000-0000-4000-8000-000000000207' },
    });
    assert.equal(deniedDelete.response.status, 403);
  });
});

test('Issue 37 deletion transfers owned rooms and preserves events scheduled by the deleted owner', async () => {
  await withServer(async (baseUrl, server) => {
    const owner = await register(baseUrl, 'Issue 37 Deleted Scheduler');
    const ownerCsrf = await csrfFor(baseUrl, owner.cookie);
    const admin = await loginAdmin(baseUrl);
    const adminSocket = await connectAuthenticatedSocket(baseUrl, admin.cookie);
    const summaries = [];
    adminSocket.on('rooms:summary-changed', (update) => summaries.push(update));
    const created = await roomRequest(baseUrl, '/api/rooms', {
      cookie: owner.cookie, csrfToken: ownerCsrf, method: 'POST', body: { title: 'Retained Room' },
    });
    assert.equal(created.response.status, 201);
    const roomId = created.body.room.id;
    const emptyRoom = await roomRequest(baseUrl, '/api/rooms', {
      cookie: owner.cookie, csrfToken: ownerCsrf, method: 'POST', body: { title: 'No Vote Owner Transfer' },
    });
    assert.equal(emptyRoom.response.status, 201);
    const vote = await roomRequest(baseUrl, `/api/rooms/${roomId}/votes/2026-10-28`, {
      cookie: owner.cookie, csrfToken: ownerCsrf, method: 'PUT', body: { selected: true },
    });
    assert.equal(vote.response.status, 200);
    const proposal = await roomRequest(baseUrl, `/api/rooms/${roomId}/events/2026-10-28`, {
      cookie: owner.cookie, csrfToken: ownerCsrf, method: 'POST',
      body: { requestId: '13700000-0000-4000-8000-000000000301' },
    });
    assert.equal(proposal.response.status, 201);
    const scheduled = await roomRequest(baseUrl, `/api/rooms/${roomId}/admin/events/2026-10-28`, {
      cookie: owner.cookie, csrfToken: ownerCsrf, method: 'PUT',
      body: { eventId: proposal.body.event.eventId, revision: proposal.body.event.revision,
        status: 'scheduled', requestId: '13700000-0000-4000-8000-000000000302' },
    });
    assert.equal(scheduled.response.status, 200);
    const ownerId = server.database.prepare('SELECT id FROM users WHERE name = ?').get('Issue 37 Deleted Scheduler').id;
    const adminId = server.database.prepare("SELECT id FROM users WHERE role = 'admin'").get().id;

    const deletion = await roomRequest(baseUrl, `/api/admin/users/${ownerId}`, {
      cookie: admin.cookie, csrfToken: admin.csrfToken, method: 'DELETE',
      body: { confirmation: true, requestId: '13700000-0000-4000-8000-000000000303' },
    });
    assert.equal(deletion.response.status, 200, JSON.stringify(deletion.body));
    assert.equal(server.database.prepare('SELECT owner_user_id FROM rooms WHERE id = ?').get(roomId).owner_user_id, adminId);
    assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM room_memberships WHERE room_id = ? AND user_id = ?')
      .get(roomId, adminId).count, 1);
    assert.equal(server.database.prepare('SELECT owner_user_id FROM rooms WHERE id = ?').get(emptyRoom.body.room.id).owner_user_id, adminId);
    const inheritedRoomEdit = await roomRequest(baseUrl, `/api/rooms/${roomId}`, {
      cookie: admin.cookie, csrfToken: admin.csrfToken, method: 'PUT', body: { title: 'Inherited Room', icon: 'swimming' },
    });
    assert.equal(inheritedRoomEdit.response.status, 200);
    assert.equal(inheritedRoomEdit.body.room.ownerUserId, adminId);
    assert.equal(inheritedRoomEdit.body.room.title, 'Inherited Room');
    assert.equal(inheritedRoomEdit.body.room.icon, 'swimming');
    assert.equal(inheritedRoomEdit.body.room.color, created.body.room.color);
    await new Promise((resolve) => setTimeout(resolve, 100));
    adminSocket.close();
    assert.ok(summaries.some(({ roomId: changedRoomId, room }) => changedRoomId === emptyRoom.body.room.id && room.ownerUserId === adminId));
    const surviving = await roomRequest(baseUrl, `/api/rooms/${roomId}/weeks/2026-10-26`, { cookie: admin.cookie });
    assert.equal(surviving.response.status, 200);
    assert.equal(surviving.body.events[0].status, 'scheduled');
    assert.equal(surviving.body.events[0].scheduledBy, 'Issue 37 Deleted Scheduler');
    assert.equal(surviving.body.events[0].voteCount, 0);
    assert.deepEqual(server.database.pragma('foreign_key_check'), []);
  });
});

test('Issue 37 room summaries include all Bangkok-upcoming dates and order rooms by earliest event', async () => {
  let clock = new Date('2026-10-27T16:59:59.000Z');
  await withServer(async (baseUrl, server) => {
    const owner = await register(baseUrl, 'Issue 37 Summary Owner');
    const ownerCsrf = await csrfFor(baseUrl, owner.cookie);
    const names = ['Later', 'First Tie', 'Second Tie', 'No Dates', 'Rollover'];
    const roomIds = {};
    for (const title of names) {
      const created = await roomRequest(baseUrl, '/api/rooms', {
        cookie: owner.cookie, csrfToken: ownerCsrf, method: 'POST', body: { title },
      });
      assert.equal(created.response.status, 201);
      roomIds[title] = created.body.room.id;
    }
    const ownerId = server.database.prepare('SELECT id FROM users WHERE name = ?').get('Issue 37 Summary Owner').id;
    const adminId = server.database.prepare("SELECT id FROM users WHERE role = 'admin'").get().id;
    const insertEvent = server.database.prepare(`
      INSERT INTO run_events
        (room_id, event_date, status, revision, proposed_by, proposed_at, scheduled_by, scheduled_at)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?)
    `);
    const addEvent = (room, date, status) => insertEvent.run(
      roomIds[room], date, status, ownerId, NOW.toISOString(),
      status === 'scheduled' ? adminId : null, status === 'scheduled' ? NOW.toISOString() : null,
    );
    addEvent('Later', '2026-10-30', 'proposed');
    addEvent('Later', '2026-11-01', 'scheduled');
    addEvent('Later', '2026-10-26', 'scheduled');
    addEvent('First Tie', '2026-10-28', 'proposed');
    addEvent('First Tie', '2026-11-03', 'scheduled');
    addEvent('Second Tie', '2026-10-28', 'scheduled');
    addEvent('Second Tie', '2026-11-10', 'proposed');
    addEvent('Rollover', '2026-10-27', 'scheduled');

    const listed = await roomRequest(baseUrl, '/api/rooms', { cookie: owner.cookie });
    assert.equal(listed.response.status, 200);
    const rooms = listed.body.rooms.filter(({ id }) => Object.values(roomIds).includes(id));
    assert.deepEqual(rooms.map(({ title }) => title), ['Rollover', 'First Tie', 'Second Tie', 'Later', 'No Dates']);
    assert.deepEqual(rooms[0].summary.scheduledDates, ['2026-10-27']);
    assert.deepEqual(rooms[1].summary, {
      roomId: roomIds['First Tie'],
      scheduledDates: ['2026-11-03'],
      proposedDates: ['2026-10-28'],
      earliestDate: '2026-10-28',
      hasUpcomingEvents: true,
    });
    assert.deepEqual(rooms[2].summary.scheduledDates, ['2026-10-28']);
    assert.deepEqual(rooms[2].summary.proposedDates, ['2026-11-10']);
    assert.deepEqual(rooms[3].summary.scheduledDates, ['2026-11-01']);
    assert.deepEqual(rooms[3].summary.proposedDates, ['2026-10-30']);
    assert.deepEqual(rooms[4].summary.scheduledDates, []);
    assert.deepEqual(rooms[4].summary.proposedDates, []);
    assert.equal(rooms[4].summary.earliestDate, null);
    assert.equal(rooms[4].summary.hasUpcomingEvents, false);

    clock = new Date('2026-10-27T17:00:00.000Z');
    const afterBangkokMidnight = await roomRequest(baseUrl, '/api/rooms', { cookie: owner.cookie });
    const rolloverRoom = afterBangkokMidnight.body.rooms.find(({ id }) => id === roomIds.Rollover);
    assert.deepEqual(rolloverRoom.summary.scheduledDates, []);
    assert.equal(rolloverRoom.summary.hasUpcomingEvents, false);
  }, () => clock);
});

test('Issue 37 sockets receive only subscribed board patches and public summary-only updates', async () => {
  let clock = new Date('2026-10-27T04:00:00.000Z');
  await withServer(async (baseUrl, server) => {
    const owner = await register(baseUrl, 'Issue 37 Socket Owner');
    const actor = await register(baseUrl, 'Issue 37 Socket Actor');
    const stranger = await register(baseUrl, 'Issue 37 Socket Stranger');
    const ownerCsrf = await csrfFor(baseUrl, owner.cookie);
    const actorCsrf = await csrfFor(baseUrl, actor.cookie);
    const createRoom = async (title) => (await roomRequest(baseUrl, '/api/rooms', {
      cookie: owner.cookie, csrfToken: ownerCsrf, method: 'POST', body: { title },
    })).body.room.id;
    const roomOne = await createRoom('Socket Room One');
    const roomTwo = await createRoom('Socket Room Two');
    const enter = (roomId, user, csrfToken) => roomRequest(baseUrl, `/api/rooms/${roomId}/enter`, {
      cookie: user.cookie, csrfToken, method: 'POST', body: {},
    });
    await enter(roomOne, actor, actorCsrf);
    await enter(roomTwo, actor, actorCsrf);
    await enter(roomOne, owner, ownerCsrf);
    await enter(roomTwo, owner, ownerCsrf);

    let initialState;
    const firstSocket = await connectAuthenticatedSocket(baseUrl, owner.cookie, (socket) => {
      initialState = new Promise((resolve) => socket.once('rooms:summary-state', resolve));
    });
    const secondSocket = await connectAuthenticatedSocket(baseUrl, actor.cookie);
    const deniedSocket = await connectAuthenticatedSocket(baseUrl, stranger.cookie);
    try {
      assert.deepEqual(await subscribeToRoom(firstSocket, roomOne), { ok: true, roomId: roomOne });
      assert.deepEqual(await subscribeToRoom(secondSocket, roomTwo), { ok: true, roomId: roomTwo });
      assert.deepEqual(await subscribeToRoom(deniedSocket, roomOne), { ok: false, code: 'ROOM_MEMBERSHIP_REQUIRED' });
      const connectedState = await initialState;
      assert.deepEqual(connectedState.rooms.map(({ id }) => id).sort(), [
        '00000000-0000-4000-8000-000000000036', roomOne, roomTwo,
      ].sort());
      const initialSummaries = await refreshRoomSummaries(firstSocket);
      assert.deepEqual(initialSummaries.rooms.map(({ id }) => id).sort(), [
        '00000000-0000-4000-8000-000000000036', roomOne, roomTwo,
      ].sort());
      const patchesOne = [];
      const patchesTwo = [];
      const eventsOne = [];
      const eventsTwo = [];
      const resetsOne = [];
      const resetsTwo = [];
      const summaries = [];
      firstSocket.on('vote:changed', (patch) => patchesOne.push(patch));
      secondSocket.on('vote:changed', (patch) => patchesTwo.push(patch));
      firstSocket.on('event:changed', (event) => eventsOne.push(event));
      secondSocket.on('event:changed', (event) => eventsTwo.push(event));
      firstSocket.on('week:reset', (event) => resetsOne.push(event));
      secondSocket.on('week:reset', (event) => resetsTwo.push(event));
      firstSocket.on('rooms:summary-changed', (update) => summaries.push(update));
      secondSocket.on('rooms:summary-changed', (update) => summaries.push(update));

      for (const roomId of [roomOne, roomTwo]) {
        const vote = await roomRequest(baseUrl, `/api/rooms/${roomId}/votes/2026-10-28`, {
          cookie: actor.cookie, csrfToken: actorCsrf, method: 'PUT', body: { selected: true },
        });
        assert.equal(vote.response.status, 200);
      }
      const updated = await roomRequest(baseUrl, `/api/rooms/${roomOne}`, {
        cookie: owner.cookie, csrfToken: ownerCsrf, method: 'PUT', body: { icon: 'swimming' },
      });
      assert.equal(updated.response.status, 200);
      const proposed = await roomRequest(baseUrl, `/api/rooms/${roomOne}/events/2026-10-28`, {
        cookie: actor.cookie, csrfToken: actorCsrf, method: 'POST',
        body: { requestId: '13700000-0000-4000-8000-000000000451' },
      });
      assert.equal(proposed.response.status, 201);
      const scheduled = await roomRequest(baseUrl, `/api/rooms/${roomOne}/admin/events/2026-10-28`, {
        cookie: owner.cookie, csrfToken: ownerCsrf, method: 'PUT',
        body: { eventId: proposed.body.event.eventId, revision: proposed.body.event.revision, status: 'scheduled',
          requestId: '13700000-0000-4000-8000-000000000452' },
      });
      assert.equal(scheduled.response.status, 200);
      await new Promise((resolve) => setTimeout(resolve, 100));

      assert.deepEqual(patchesOne.map(({ roomId, date }) => ({ roomId, date })), [
        { roomId: roomOne, date: '2026-10-28' },
      ]);
      assert.deepEqual(patchesTwo.map(({ roomId, date }) => ({ roomId, date })), [
        { roomId: roomTwo, date: '2026-10-28' },
      ]);
      assert.deepEqual(eventsOne.filter(({ event }) => event !== null)
        .map(({ roomId: changedRoomId, date }) => ({ roomId: changedRoomId, date })), [
        { roomId: roomOne, date: '2026-10-28' },
        { roomId: roomOne, date: '2026-10-28' },
      ]);
      assert.deepEqual(eventsTwo.filter(({ event }) => event !== null), []);
      const roomOneSummary = (await refreshRoomSummaries(firstSocket)).rooms.find(({ id }) => id === roomOne).summary;
      assert.deepEqual(roomOneSummary.scheduledDates, ['2026-10-28']);
      assert.deepEqual(roomOneSummary.proposedDates, []);
      assert.ok(summaries.some(({ roomId: changedRoom, room }) => changedRoom === roomOne && room.icon === 'swimming'));
      assert.equal((await refreshRoomSummaries(firstSocket)).rooms.find(({ id }) => id === roomOne).icon, 'swimming');
      for (const { room, ...update } of summaries) {
        assert.equal(typeof update.roomId, 'string');
        assert.deepEqual(Object.keys(room.summary).sort(), [
          'earliestDate', 'hasUpcomingEvents', 'proposedDates', 'roomId', 'scheduledDates',
        ]);
        assert.equal(JSON.stringify(room).includes('voterNames'), false);
        assert.equal(JSON.stringify(room).includes('voteCount'), false);
      }

      const roomReset = await roomRequest(baseUrl, `/api/rooms/${roomOne}/admin/weeks/2026-10-26/votes`, {
        cookie: owner.cookie, csrfToken: ownerCsrf, method: 'DELETE', body: { confirmation: true },
      });
      assert.equal(roomReset.response.status, 204);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.deepEqual(resetsOne, [{ roomId: roomOne, monday: '2026-10-26', sunday: '2026-11-01' }]);
      assert.deepEqual(resetsTwo, []);
      assert.equal((await roomRequest(baseUrl, `/api/rooms/${roomOne}/votes/2026-10-28`, {
        cookie: actor.cookie, csrfToken: actorCsrf, method: 'PUT', body: { selected: true },
      })).response.status, 200);

      patchesOne.length = 0;
      patchesTwo.length = 0;
      const admin = await loginAdmin(baseUrl);
      const actorId = server.database.prepare('SELECT id FROM users WHERE name = ?').get('Issue 37 Socket Actor').id;
      const reset = await roomRequest(baseUrl, `/api/admin/users/${actorId}/votes`, {
        cookie: admin.cookie,
        csrfToken: admin.csrfToken,
        method: 'DELETE',
        body: { confirmation: true, requestId: '13700000-0000-4000-8000-000000000455' },
      });
      assert.equal(reset.response.status, 200);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.deepEqual(patchesOne.map(({ roomId, date, voteCount }) => ({ roomId, date, voteCount })), [
        { roomId: roomOne, date: '2026-10-28', voteCount: 0 },
      ]);
      assert.deepEqual(patchesTwo.map(({ roomId, date, voteCount }) => ({ roomId, date, voteCount })), [
        { roomId: roomTwo, date: '2026-10-28', voteCount: 0 },
      ]);
      clock = new Date('2026-10-29T17:00:00.000Z');
      const rolledOver = await refreshRoomSummaries(firstSocket);
      const rolledOverSummary = rolledOver.rooms.find(({ id }) => id === roomOne).summary;
      assert.deepEqual(rolledOverSummary.scheduledDates, []);
      assert.deepEqual(rolledOverSummary.proposedDates, []);
      assert.equal(rolledOverSummary.earliestDate, null);
    } finally {
      firstSocket.close();
      secondSocket.close();
      deniedSocket.close();
    }
  }, () => clock);
});

test('Issue 37 page routes bind a board tab to its room and reject non-member access', async () => {
  await withServer(async (baseUrl) => {
    const owner = await register(baseUrl, 'Issue 37 Page Owner');
    const member = await register(baseUrl, 'Issue 37 Page Member');
    const ownerCsrf = await csrfFor(baseUrl, owner.cookie);
    const memberCsrf = await csrfFor(baseUrl, member.cookie);
    const created = await roomRequest(baseUrl, '/api/rooms', {
      cookie: owner.cookie, csrfToken: ownerCsrf, method: 'POST', body: { title: 'Tab Room' },
    });
    const roomId = created.body.room.id;

    assert.equal((await fetch(`${baseUrl}/vote/${roomId}`, { headers: { cookie: member.cookie } })).status, 403);
    const entered = await roomRequest(baseUrl, `/api/rooms/${roomId}/enter`, {
      cookie: member.cookie, csrfToken: memberCsrf, method: 'POST', body: {},
    });
    assert.equal(entered.response.status, 200);
    const pageResponse = await fetch(`${baseUrl}/vote/${roomId}`, { headers: { cookie: member.cookie } });
    assert.equal(pageResponse.status, 200);
    const page = await pageResponse.text();
    assert.match(page, new RegExp(`data-room-id="${roomId}"`));
    assert.match(page, new RegExp(`const roomId = '${roomId}'`));
    assert.match(page, /\/api\/rooms\//);
    assert.equal((await fetch(`${baseUrl}/vote`, { headers: { cookie: member.cookie } })).status, 200);
  });
});
