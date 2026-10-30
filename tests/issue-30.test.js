import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { io as connectSocket } from 'socket.io-client';
import { createServer } from '../src/server.js';
import { addDays } from '../src/calendar.js';
import { addVote } from '../src/domain.js';

const ENV = { ADMIN_NAME: 'Synthetic Coach', ADMIN_PIN: '4826', PIN_PEPPER: 'synthetic-pepper' };
const SUNDAY_NOW = new Date('2026-10-11T16:59:59.000Z');

async function withServer(callback, now = () => SUNDAY_NOW) {
  const directory = await mkdtemp(join(tmpdir(), 'run-together-issue-30-'));
  const server = createServer({ databasePath: join(directory, 'test.sqlite'), env: ENV, now });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await callback(`http://127.0.0.1:${server.address().port}`, server);
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
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, pin: '0042', pinConfirmation: '0042' }),
  });
}

async function timeline(baseUrl, cookie) {
  return fetch(`${baseUrl}/api/vote-timeline`, { headers: cookie ? { cookie } : {} });
}

async function session(baseUrl, cookie) {
  return fetch(`${baseUrl}/api/session`, { headers: { cookie } }).then((response) => response.json());
}

function waitForSocket(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for Socket.IO connection')), 2000);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('connect_error', (error) => { clearTimeout(timer); reject(error); });
  });
}

async function putVote(baseUrl, cookie, csrfToken, date, selected) {
  return fetch(`${baseUrl}/api/votes/${date}`, {
    method: 'PUT',
    headers: { cookie, origin: baseUrl, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
    body: JSON.stringify({ selected }),
  });
}

test('vote timeline is authenticated and returned with no-store caching', async () => {
  await withServer(async (baseUrl) => {
    const anonymous = await timeline(baseUrl);
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.headers.get('cache-control'), 'no-store');

    const registration = await register(baseUrl, 'Timeline Runner');
    const response = await timeline(baseUrl, cookieFrom(registration));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });
});

test('vote timeline returns every inclusive eligible date and aggregate counts only', async () => {
  await withServer(async (baseUrl, server) => {
    const registrations = await Promise.all([
      register(baseUrl, 'Timeline Alice'),
      register(baseUrl, 'Timeline Bob'),
      register(baseUrl, 'Timeline Carol'),
    ]);
    const cookie = cookieFrom(registrations[0]);
    const users = server.database.prepare("SELECT id, name FROM users WHERE role = 'user' ORDER BY id").all();
    const votes = [
      [users[0].id, '2026-10-10'],
      [users[0].id, '2026-10-11'],
      [users[1].id, '2026-10-11'],
      [users[2].id, '2026-10-25'],
      [users[0].id, '2026-10-25'],
      [users[0].id, '2026-10-26'],
    ];
    votes.forEach(([userId, voteDate]) => addVote(server.database, { userId, voteDate }));

    const response = await timeline(baseUrl, cookie);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.startDate, '2026-10-11');
    assert.equal(result.endDate, '2026-10-25');
    assert.deepEqual(result.days.map(({ date }) => date), Array.from({ length: 15 }, (_, index) => addDays('2026-10-11', index)));
    assert.deepEqual(result.days.find(({ date }) => date === '2026-10-11'), { date: '2026-10-11', voteCount: 2 });
    assert.deepEqual(result.days.find(({ date }) => date === '2026-10-12'), { date: '2026-10-12', voteCount: 0 });
    assert.deepEqual(result.days.find(({ date }) => date === '2026-10-25'), { date: '2026-10-25', voteCount: 2 });
    assert.deepEqual(Object.keys(result).sort(), ['days', 'endDate', 'scheduledDates', 'startDate']);
    assert.ok(result.days.every((day) => Object.keys(day).sort().join(',') === 'date,voteCount'));
    const serialized = JSON.stringify(result);
    assert.equal(users.some(({ name }) => serialized.includes(name)), false);
  });
});

test('vote timeline advances its start date at Bangkok midnight and keeps the rolling end', async () => {
  await withServer(async (baseUrl, server) => {
    const registration = await register(baseUrl, 'Boundary Timeline Runner');
    const user = server.database.prepare("SELECT id FROM users WHERE role = 'user'").get();
    addVote(server.database, { userId: user.id, voteDate: '2026-10-12' });

    const response = await timeline(baseUrl, cookieFrom(registration));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.startDate, '2026-10-12');
    assert.equal(result.endDate, '2026-11-01');
    assert.equal(result.days.length, 21);
    assert.equal(result.days[0].voteCount, 1);
    assert.equal(result.days.at(-1).date, '2026-11-01');
  }, () => new Date('2026-10-11T17:00:00.000Z'));
});

test('vote additions and removals publish updated eligible totals to two signed-in clients', async () => {
  await withServer(async (baseUrl) => {
    const aliceCookie = cookieFrom(await register(baseUrl, 'Timeline Live Alice'));
    const bobCookie = cookieFrom(await register(baseUrl, 'Timeline Live Bob'));
    const aliceSession = await session(baseUrl, aliceCookie);
    const aliceSocket = connectSocket(baseUrl, { extraHeaders: { origin: baseUrl, cookie: aliceCookie } });
    const bobSocket = connectSocket(baseUrl, { extraHeaders: { origin: baseUrl, cookie: bobCookie } });
    await Promise.all([waitForSocket(aliceSocket), waitForSocket(bobSocket)]);
    try {
      const aliceAdded = new Promise((resolve) => aliceSocket.once('vote:changed', resolve));
      const bobAdded = new Promise((resolve) => bobSocket.once('vote:changed', resolve));
      const addition = await putVote(baseUrl, aliceCookie, aliceSession.csrfToken, '2026-10-11', true);
      assert.equal(addition.status, 200);
      assert.equal((await aliceAdded).voteCount, 1);
      assert.equal((await bobAdded).voteCount, 1);
      for (const cookie of [aliceCookie, bobCookie]) {
        const response = await timeline(baseUrl, cookie);
        assert.equal((await response.json()).days.find(({ date }) => date === '2026-10-11').voteCount, 1);
      }

      const aliceRemoved = new Promise((resolve) => aliceSocket.once('vote:changed', resolve));
      const bobRemoved = new Promise((resolve) => bobSocket.once('vote:changed', resolve));
      const removal = await putVote(baseUrl, aliceCookie, aliceSession.csrfToken, '2026-10-11', false);
      assert.equal(removal.status, 200);
      assert.equal((await aliceRemoved).voteCount, 0);
      assert.equal((await bobRemoved).voteCount, 0);
    } finally {
      aliceSocket.close();
      bobSocket.close();
    }
  });
});

test('week reset broadcasts and removes its counts from the full eligible-period aggregate', async () => {
  await withServer(async (baseUrl, server) => {
    const memberCookie = cookieFrom(await register(baseUrl, 'Timeline Reset Member'));
    const member = server.database.prepare("SELECT id FROM users WHERE role = 'user'").get();
    addVote(server.database, { userId: member.id, voteDate: '2026-10-11' });
    addVote(server.database, { userId: member.id, voteDate: '2026-10-12' });
    const adminLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { origin: baseUrl, 'content-type': 'application/json' },
      body: JSON.stringify({ name: ENV.ADMIN_NAME, pin: ENV.ADMIN_PIN }),
    });
    const adminCookie = cookieFrom(adminLogin);
    const adminSession = await session(baseUrl, adminCookie);
    const memberSocket = connectSocket(baseUrl, { extraHeaders: { origin: baseUrl, cookie: memberCookie } });
    await waitForSocket(memberSocket);
    try {
      const resetEvent = new Promise((resolve) => memberSocket.once('week:reset', resolve));
      const reset = await fetch(`${baseUrl}/api/admin/weeks/2026-10-05/votes`, {
        method: 'DELETE',
        headers: { cookie: adminCookie, origin: baseUrl, 'content-type': 'application/json', 'x-csrf-token': adminSession.csrfToken },
        body: JSON.stringify({ confirmation: true }),
      });
      assert.equal(reset.status, 204);
      assert.deepEqual(await resetEvent, {
        roomId: '00000000-0000-4000-8000-000000000036', monday: '2026-10-05', sunday: '2026-10-11',
      });
      const response = await timeline(baseUrl, memberCookie);
      const totals = await response.json();
      assert.equal(totals.days.find(({ date }) => date === '2026-10-11').voteCount, 0);
      assert.equal(totals.days.find(({ date }) => date === '2026-10-12').voteCount, 1);
    } finally {
      memberSocket.close();
    }
  });
});
