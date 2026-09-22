import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { io as connectSocket } from 'socket.io-client';
import { createServer } from '../src/server.js';

const ENV = { ADMIN_NAME: 'Synthetic Coach', ADMIN_PIN: '4826', PIN_PEPPER: 'synthetic-pepper' };
const NOW = new Date('2024-02-29T04:00:00.000Z');

async function withServer(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'run-together-voting-'));
  const server = createServer({ databasePath: join(directory, 'test.sqlite'), env: ENV, now: () => NOW });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address();
    await callback(`http://127.0.0.1:${port}`, server);
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
  return fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ name, pin: '0042', pinConfirmation: '0042' }),
  });
}

async function sessionFor(baseUrl, cookie) {
  return fetch(`${baseUrl}/api/session`, { headers: { cookie } }).then((response) => response.json());
}

async function putVote(baseUrl, cookie, csrfToken, date, body) {
  return fetch(`${baseUrl}/api/votes/${date}`, {
    method: 'PUT',
    headers: { cookie, 'content-type': 'application/json', origin: baseUrl, 'x-csrf-token': csrfToken },
    body: JSON.stringify(body),
  });
}

function waitForSocket(socket, event = 'connect') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), 2000);
    socket.once(event, (...args) => { clearTimeout(timer); resolve(args); });
    socket.once('connect_error', (error) => { clearTimeout(timer); reject(error); });
  });
}

test('PUT /api/votes validates CSRF/body/date, is idempotent, and returns only a safe patch', async () => {
  await withServer(async (baseUrl, server) => {
    const registration = await register(baseUrl, 'Atomic Runner');
    const cookie = cookieFrom(registration);
    const session = await sessionFor(baseUrl, cookie);
    const invalidBodies = [{ selected: true, extra: 1 }, {}, { selected: 'true' }, []];
    for (const body of invalidBodies) {
      const response = await putVote(baseUrl, cookie, session.csrfToken, '2024-03-01', body);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, 'INVALID_VOTE_REQUEST');
    }
    const missingCsrf = await fetch(`${baseUrl}/api/votes/2024-03-01`, {
      method: 'PUT', headers: { cookie, 'content-type': 'application/json', origin: baseUrl }, body: JSON.stringify({ selected: true }),
    });
    assert.equal(missingCsrf.status, 403);
    const duplicateResults = await Promise.all([
      putVote(baseUrl, cookie, session.csrfToken, '2024-03-01', { selected: true }),
      putVote(baseUrl, cookie, session.csrfToken, '2024-03-01', { selected: true }),
    ]);
    assert.deepEqual(duplicateResults.map((response) => response.status), [200, 200]);
    assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM votes').get().count, 1);
    const patch = await duplicateResults[0].json();
    assert.deepEqual(Object.keys(patch).sort(), ['date', 'selected', 'voteCount', 'voterNames']);
    assert.deepEqual(patch, { date: '2024-03-01', voteCount: 1, voterNames: ['Atomic Runner'], selected: true });
    for (const date of ['2024-02-28', '2024-03-21', 'not-a-date']) {
      const response = await putVote(baseUrl, cookie, session.csrfToken, date, { selected: true });
      assert.equal(response.status, 400);
      assert.match((await response.json()).code, /VOTE_DATE/);
    }
  });
});

test('Socket.IO authenticates session cookies and emits recipient-specific patches after commit', async () => {
  await withServer(async (baseUrl) => {
    const aliceRegistration = await register(baseUrl, 'Socket Alice');
    const bobRegistration = await register(baseUrl, 'Socket Bob');
    const aliceCookie = cookieFrom(aliceRegistration);
    const bobCookie = cookieFrom(bobRegistration);
    const aliceSession = await sessionFor(baseUrl, aliceCookie);
    const bobSession = await sessionFor(baseUrl, bobCookie);
    const aliceSocket = connectSocket(baseUrl, { extraHeaders: { origin: baseUrl, cookie: aliceCookie } });
    const bobSocket = connectSocket(baseUrl, { extraHeaders: { origin: baseUrl, cookie: bobCookie } });
    await Promise.all([waitForSocket(aliceSocket), waitForSocket(bobSocket)]);
    try {
      const bobPatch = new Promise((resolve) => bobSocket.once('vote:changed', resolve));
      const alicePatch = new Promise((resolve) => aliceSocket.once('vote:changed', resolve));
      const response = await putVote(baseUrl, aliceCookie, aliceSession.csrfToken, '2024-03-01', { selected: true });
      assert.equal(response.status, 200);
      assert.deepEqual(await bobPatch, { date: '2024-03-01', voteCount: 1, voterNames: ['Socket Alice'], selected: false });
      assert.deepEqual(await alicePatch, { date: '2024-03-01', voteCount: 1, voterNames: ['Socket Alice'], selected: true });
      let repeatEvents = 0;
      bobSocket.on('vote:changed', () => { repeatEvents += 1; });
      const repeated = await putVote(baseUrl, aliceCookie, aliceSession.csrfToken, '2024-03-01', { selected: true });
      assert.equal(repeated.status, 200);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(repeatEvents, 0);
      const unauthenticated = connectSocket(baseUrl, { extraHeaders: { origin: baseUrl } });
      await assert.rejects(waitForSocket(unauthenticated), /unauthenticated/);
      unauthenticated.close();
      const foreignOrigin = connectSocket(baseUrl, { extraHeaders: { origin: 'https://evil.example', cookie: bobCookie } });
      await assert.rejects(waitForSocket(foreignOrigin), /origin mismatch|xhr poll error/);
      foreignOrigin.close();
      assert.ok(bobSession.csrfToken);
    } finally {
      aliceSocket.close();
      bobSocket.close();
    }
  });
});
