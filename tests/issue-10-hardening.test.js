import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { io as connectSocket } from 'socket.io-client';
import { LEGACY_ROOM_ID } from '../src/room-contract.js';
import { createServer } from '../src/server.js';

const ENV = {
  ADMIN_NAME: 'Issue 10 Synthetic Admin',
  ADMIN_PIN: '4826',
  PIN_PEPPER: 'issue-10-synthetic-pepper',
};
const NOW = new Date('2026-11-16T00:00:00.000Z');
const LOAD_DATE = '2026-11-17';
const LATENCY_DATE = '2026-11-18';
const USER_COUNT = 30;

function cookieFrom(response) {
  return response.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
}

async function registerUser(baseUrl, index) {
  const displayName = `Issue 10 User ${String(index + 1).padStart(2, '0')}`;
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: baseUrl,
      // The fixture uses a distinct documentation-only synthetic source address
      // per user so the production registration limiter is not bypassed.
      'x-forwarded-for': `198.51.100.${index + 1}`,
    },
    body: JSON.stringify({ name: displayName, pin: '0042', pinConfirmation: '0042' }),
  });
  assert.equal(response.status, 201, `synthetic user ${displayName} registers`);
  const cookie = cookieFrom(response);
  assert.ok(cookie.startsWith('run_together_session='));
  const sessionResponse = await fetch(`${baseUrl}/api/session`, { headers: { cookie } });
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json();
  return { displayName, cookie, csrfToken: session.csrfToken };
}

function waitForConnect(socket) {
  if (socket.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for synthetic client connection.')), 5000);
    socket.once('connect', () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once('connect_error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function subscribeToRoom(socket) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out subscribing to the vote room.')), 5000);
    socket.emit('room:subscribe', { roomId: LEGACY_ROOM_ID }, (result) => {
      clearTimeout(timeout);
      if (!result?.ok || result.roomId !== LEGACY_ROOM_ID) {
        reject(new Error('Synthetic client could not subscribe to the vote room.'));
      } else {
        resolve();
      }
    });
  });
}

function putVote(baseUrl, user, date) {
  return fetch(`${baseUrl}/api/votes/${date}`, {
    method: 'PUT',
    headers: {
      cookie: user.cookie,
      origin: baseUrl,
      'content-type': 'application/json',
      'x-csrf-token': user.csrfToken,
    },
    body: JSON.stringify({ selected: true }),
  });
}

async function waitForEveryClient(eventsByClient, date, minimumCount, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (eventsByClient.every((events) => events.filter(({ patch }) => patch.date === date).length >= minimumCount)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const counts = eventsByClient.map((events) => events.filter(({ patch }) => patch.date === date).length);
  throw new Error(`Only received ${Math.min(...counts)}/${minimumCount} ${date} vote patches at one or more clients.`);
}

test('Issue 10 simultaneous vote bursts stay durable, unique, consistent, and visible for 30 generated users', async (t) => {
  const directory = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'run-together-issue-10-load-'));
  const server = createServer({ databasePath: join(directory, 'issue-10-synthetic.sqlite'), env: ENV, now: () => NOW });
  const sockets = [];
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const users = [];
    for (let index = 0; index < USER_COUNT; index += 1) users.push(await registerUser(baseUrl, index));

    const eventsByClient = users.map(() => []);
    await Promise.all(users.map(async (user, index) => {
      const socket = connectSocket(baseUrl, { extraHeaders: { origin: baseUrl, cookie: user.cookie } });
      sockets.push(socket);
      socket.on('vote:changed', (patch) => eventsByClient[index].push({ patch, visibleAt: performance.now() }));
      await waitForConnect(socket);
      await subscribeToRoom(socket);
    }));

    const latencyStartedAt = performance.now();
    const latencyResponse = await putVote(baseUrl, users[0], LATENCY_DATE);
    assert.equal(latencyResponse.status, 200);
    await latencyResponse.json();
    assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM votes WHERE vote_date = ?').get(LATENCY_DATE).count, 1,
      'the latency probe is persisted in its isolated synthetic database');
    await waitForEveryClient(eventsByClient, LATENCY_DATE, 1);
    const clientLatencyMs = eventsByClient.reduce((latest, events) => {
      const sample = events.find(({ patch }) => patch.date === LATENCY_DATE);
      return Math.max(latest, sample.visibleAt - latencyStartedAt);
    }, 0);
    assert.ok(clientLatencyMs < 2000, `persisted vote reached all subscribed clients within two seconds (request-start upper bound ${clientLatencyMs.toFixed(1)}ms)`);

    const burstStartedAt = performance.now();
    const burstRequests = users.flatMap((user) => [
      putVote(baseUrl, user, LOAD_DATE),
      putVote(baseUrl, user, LOAD_DATE),
      putVote(baseUrl, user, LOAD_DATE),
    ]);
    const responses = await Promise.all(burstRequests);
    assert.equal(responses.length, USER_COUNT * 3);
    assert.ok(responses.every((response) => response.status === 200), 'all first and duplicate concurrent requests succeed');
    await Promise.all(responses.map((response) => response.json()));
    await waitForEveryClient(eventsByClient, LOAD_DATE, USER_COUNT);

    const persistedRows = server.database.prepare(
      'SELECT user_id FROM votes WHERE room_id = ? AND vote_date = ? ORDER BY user_id',
    ).all(LEGACY_ROOM_ID, LOAD_DATE);
    assert.equal(persistedRows.length, USER_COUNT, 'one vote per generated user is committed');
    assert.equal(new Set(persistedRows.map(({ user_id: userId }) => userId)).size, USER_COUNT,
      'no duplicate user/date vote exists after three simultaneous requests per user');
    assert.equal(server.database.prepare(
      'SELECT COUNT(*) AS count FROM (SELECT user_id FROM votes WHERE room_id = ? AND vote_date = ? GROUP BY user_id HAVING COUNT(*) > 1)',
    ).get(LEGACY_ROOM_ID, LOAD_DATE).count, 0, 'the uniqueness constraint prevents duplicate vote rows');

    const expectedNames = users.map(({ displayName }) => displayName).sort((left, right) => left.localeCompare(right));
    const clientFinalPatches = [];
    for (const events of eventsByClient) {
      const patches = events.filter(({ patch }) => patch.date === LOAD_DATE).map(({ patch }) => patch);
      assert.equal(patches.length, USER_COUNT, 'each client receives exactly one broadcast per committed vote');
      assert.deepEqual(patches.map(({ voteCount }) => voteCount).sort((left, right) => left - right),
        Array.from({ length: USER_COUNT }, (_, index) => index + 1), 'each client observes every committed aggregate without gaps or duplicate broadcasts');
      const finalPatch = patches.at(-1);
      assert.equal(finalPatch.voteCount, USER_COUNT);
      assert.deepEqual(finalPatch.voterNames, expectedNames, 'every client converges on the same complete voter list');
      assert.equal(finalPatch.selected, true, 'every generated user sees their own committed vote as selected');
      clientFinalPatches.push(finalPatch);
    }
    assert.ok(clientFinalPatches.every((patch) => JSON.stringify(patch.voterNames) === JSON.stringify(expectedNames)),
      'all 30 connected clients have the same final view');

    const burstVisibleMs = eventsByClient.reduce((latest, events) => {
      const finalVisible = events.filter(({ patch }) => patch.date === LOAD_DATE).at(-1).visibleAt;
      return Math.max(latest, finalVisible - burstStartedAt);
    }, 0);
    assert.ok(burstVisibleMs < 2000, `the simultaneous burst converged on all clients within two seconds (request-start upper bound ${burstVisibleMs.toFixed(1)}ms)`);
    t.diagnostic(`Synthetic load PASS: ${USER_COUNT} users, ${responses.length} simultaneous PUTs, ${USER_COUNT} durable unique votes, ${USER_COUNT} broadcasts per client; latency probe ${clientLatencyMs.toFixed(1)}ms and burst convergence ${burstVisibleMs.toFixed(1)}ms (request-start upper bounds).`);
  } finally {
    for (const socket of sockets) socket.disconnect();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
