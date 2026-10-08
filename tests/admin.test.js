import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { io as connectSocket } from 'socket.io-client';
import { createServer } from '../src/server.js';
import { addVote } from '../src/domain.js';

const appSource = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');

const ENV = {
  ADMIN_NAME: 'Synthetic Coach',
  ADMIN_PIN: '4826',
  PIN_PEPPER: 'synthetic-pepper',
};
const NOW = new Date('2024-02-29T04:00:00.000Z');

async function withServer(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'run-together-admin-'));
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

async function register(baseUrl, name, pin = '0042') {
  return fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ name, pin, pinConfirmation: pin }),
  });
}

async function login(baseUrl, name, pin, cookie = '') {
  return fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ name, pin }),
  });
}

async function sessionFor(baseUrl, cookie) {
  return fetch(`${baseUrl}/api/session`, { headers: { cookie } }).then((response) => response.json());
}

async function adminSession(baseUrl) {
  const response = await login(baseUrl, ENV.ADMIN_NAME, ENV.ADMIN_PIN);
  const cookie = cookieFrom(response);
  return { cookie, csrfToken: await sessionFor(baseUrl, cookie).then((session) => session.csrfToken) };
}

function waitForSocket(socket, event = 'connect') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), 2000);
    socket.once(event, (...args) => { clearTimeout(timer); resolve(args); });
    socket.once('connect_error', (error) => { clearTimeout(timer); reject(error); });
  });
}

test('admin page and APIs require an admin session and expose only safe user fields', async () => {
  await withServer(async (baseUrl) => {
    const member = await register(baseUrl, 'Normal Member');
    const memberCookie = cookieFrom(member);
    const unauthenticatedPage = await fetch(`${baseUrl}/admin`);
    assert.equal(unauthenticatedPage.status, 401);
    const memberPage = await fetch(`${baseUrl}/admin`, { headers: { cookie: memberCookie } });
    assert.equal(memberPage.status, 403);
    const denied = await fetch(`${baseUrl}/api/admin/users`, { headers: { cookie: memberCookie } });
    assert.equal(denied.status, 403);

    const admin = await adminSession(baseUrl);
    const page = await fetch(`${baseUrl}/admin`, { headers: { cookie: admin.cookie } });
    assert.equal(page.status, 200);
    const pageBody = await page.text();
    assert.match(pageBody, /ผู้ดูแลระบบ \/ Admin/);
    assert.match(pageBody, /รีเซ็ต PIN \/ Reset PIN/);
    assert.match(pageBody, /ลบผู้ใช้ \/ Delete user/);
    assert.match(pageBody, /<h1>ผู้ดูแลระบบ \/ Admin<\/h1>\s*<p>จัดการผู้ใช้ \/ Manage users<\/p>\s*<a href="\/vote" class="button">กลับไปหน้าโหวต \/ Back to vote<\/a>\s*<p id="admin-message"/s);

    const users = await fetch(`${baseUrl}/api/admin/users`, { headers: { cookie: admin.cookie } });
    assert.equal(users.status, 200);
    const body = await users.json();
    assert.equal(body.users.length, 2);
    assert.deepEqual(Object.keys(body.users[0]).sort(), ['createdAt', 'displayName', 'id', 'role', 'updatedAt']);
    assert.equal(JSON.stringify(body).includes('pin_hash'), false);
    assert.equal(JSON.stringify(body).includes('pin_salt'), false);
    assert.equal(JSON.stringify(body).includes('csrf'), false);
    assert.equal(JSON.stringify(body).includes('session'), false);
    assert.equal(JSON.stringify(body).includes('synthetic-pepper'), false);
  });
});

test('Issue #22 back-to-vote action is admin-only, keyboard-visible, non-mutating, and 44px', async () => {
  assert.match(appSource, /a\.button\s*\{[^}]*min-height:\s*44px[^}]*background:\s*#1769aa/s);
  assert.match(appSource, /a\.button:focus-visible\s*\{[^}]*outline:\s*3px solid #f5c542[^}]*outline-offset:\s*2px/s);

  await withServer(async (baseUrl, server) => {
    const member = await register(baseUrl, 'Issue 22 Member');
    const memberCookie = cookieFrom(member);
    const unauthenticated = await fetch(`${baseUrl}/admin`);
    assert.equal(unauthenticated.status, 401);
    const memberPage = await fetch(`${baseUrl}/admin`, { headers: { cookie: memberCookie } });
    assert.equal(memberPage.status, 403);

    const admin = await adminSession(baseUrl);
    const beforeVotes = server.database.prepare('SELECT id, user_id, vote_date, created_at FROM votes ORDER BY id').all();
    const page = await fetch(`${baseUrl}/admin`, { headers: { cookie: admin.cookie } });
    assert.equal(page.status, 200);
    const pageBody = await page.text();
    assert.match(pageBody, /<a href="\/vote" class="button">กลับไปหน้าโหวต \/ Back to vote<\/a>/);
    const votePage = await fetch(`${baseUrl}/vote`, { headers: { cookie: admin.cookie } });
    assert.equal(votePage.status, 200);
    assert.deepEqual(
      server.database.prepare('SELECT id, user_id, vote_date, created_at FROM votes ORDER BY id').all(),
      beforeVotes,
      'visiting the link destination does not change votes',
    );
  });
});

test('admin PIN reset validates a new four-digit PIN and revokes every target session', async () => {
  await withServer(async (baseUrl, server) => {
    const first = await register(baseUrl, 'Reset Target');
    const firstCookie = cookieFrom(first);
    const second = await login(baseUrl, 'Reset Target', '0042');
    const secondCookie = cookieFrom(second);
    const target = server.database.prepare('SELECT id FROM users WHERE name_key = ?').get('reset target');
    const admin = await adminSession(baseUrl);

    const invalid = await fetch(`${baseUrl}/api/admin/users/${target.id}/pin`, {
      method: 'PUT',
      headers: { cookie: admin.cookie, origin: baseUrl, 'x-csrf-token': admin.csrfToken, 'content-type': 'application/json' },
      body: JSON.stringify({ newPin: '123', newPinConfirmation: '123' }),
    });
    assert.equal(invalid.status, 400);

    const reset = await fetch(`${baseUrl}/api/admin/users/${target.id}/pin`, {
      method: 'PUT',
      headers: { cookie: admin.cookie, origin: baseUrl, 'x-csrf-token': admin.csrfToken, 'content-type': 'application/json' },
      body: JSON.stringify({ newPin: '5937', newPinConfirmation: '5937' }),
    });
    assert.equal(reset.status, 204);
    assert.equal((await fetch(`${baseUrl}/api/session`, { headers: { cookie: firstCookie } })).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/session`, { headers: { cookie: secondCookie } })).status, 401);
    assert.equal((await login(baseUrl, 'Reset Target', '0042')).status, 401);
    assert.equal((await login(baseUrl, 'Reset Target', '5937')).status, 200);
    const material = server.database.prepare('SELECT pin_salt, pin_hash FROM users WHERE id = ?').get(target.id);
    assert.equal(material.pin_hash.includes(Buffer.from('5937')), false);
    assert.equal(material.pin_salt.includes(Buffer.from('5937')), false);

    const adminReset = await fetch(`${baseUrl}/api/admin/users/1/pin`, {
      method: 'PUT',
      headers: { cookie: admin.cookie, origin: baseUrl, 'x-csrf-token': admin.csrfToken, 'content-type': 'application/json' },
      body: JSON.stringify({ newPin: '1111', newPinConfirmation: '1111' }),
    });
    assert.equal(adminReset.status, 403);
  });
});

test('confirmed normal-user deletion atomically removes votes and sessions, broadcasts totals, and signs out sockets', async () => {
  await withServer(async (baseUrl, server) => {
    const targetRegistration = await register(baseUrl, 'Delete Target');
    const targetCookie = cookieFrom(targetRegistration);
    const targetSession = await sessionFor(baseUrl, targetCookie);
    const observerRegistration = await register(baseUrl, 'Delete Observer');
    const observerCookie = cookieFrom(observerRegistration);
    const observerSession = await sessionFor(baseUrl, observerCookie);
    const target = server.database.prepare('SELECT id FROM users WHERE name_key = ?').get('delete target');
    addVote(server.database, { userId: target.id, voteDate: '2024-03-01' });
    addVote(server.database, { userId: target.id, voteDate: '2024-03-02' });

    const targetSocket = connectSocket(baseUrl, { extraHeaders: { origin: baseUrl, cookie: targetCookie } });
    const observerSocket = connectSocket(baseUrl, { extraHeaders: { origin: baseUrl, cookie: observerCookie } });
    await Promise.all([waitForSocket(targetSocket), waitForSocket(observerSocket)]);
    try {
      const revoked = waitForSocket(targetSocket, 'disconnect').catch(() => []);
      const patches = [];
      observerSocket.on('vote:changed', (patch) => patches.push(patch));
      const admin = await adminSession(baseUrl);
      const wrongConfirmation = await fetch(`${baseUrl}/api/admin/users/${target.id}`, {
        method: 'DELETE',
        headers: { cookie: admin.cookie, origin: baseUrl, 'x-csrf-token': admin.csrfToken, 'content-type': 'application/json' },
        body: JSON.stringify({ confirmation: 'wrong' }),
      });
      assert.equal(wrongConfirmation.status, 400);
      assert.ok(server.database.prepare('SELECT id FROM users WHERE id = ?').get(target.id));

      const deleted = await fetch(`${baseUrl}/api/admin/users/${target.id}`, {
        method: 'DELETE',
        headers: { cookie: admin.cookie, origin: baseUrl, 'x-csrf-token': admin.csrfToken, 'content-type': 'application/json' },
        body: JSON.stringify({ confirmation: 'Delete Target' }),
      });
      assert.equal(deleted.status, 204);
      await revoked;
      assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM users WHERE id = ?').get(target.id).count, 0);
      assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM votes WHERE user_id = ?').get(target.id).count, 0);
      assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?').get(target.id).count, 0);
      assert.equal((await fetch(`${baseUrl}/api/session`, { headers: { cookie: targetCookie } })).status, 401);
      const observerWeek = await fetch(`${baseUrl}/api/weeks/2024-02-26`, { headers: { cookie: observerCookie } }).then((response) => response.json());
      assert.equal(observerWeek.days[4].voteCount, 0);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.deepEqual(patches.map(({ date }) => date).sort(), ['2024-03-01', '2024-03-02']);
      assert.ok(observerSession.csrfToken);
      assert.ok(targetSession.csrfToken);
    } finally {
      targetSocket.close();
      observerSocket.close();
    }
  });
});

test('database role trigger prevents admin role mutation and replacement', async () => {
  await withServer(async (baseUrl, server) => {
    const admin = server.database.prepare("SELECT id FROM users WHERE role = 'admin'").get();
    const member = await register(baseUrl, 'Role Target');
    assert.equal(member.status, 201);
    assert.throws(() => server.database.prepare('UPDATE users SET role = \'user\' WHERE id = ?').run(admin.id), /role|admin/i);
  });
});

test('admin can reset only the selected open week after explicit confirmation and broadcasts the committed reset', async () => {
  await withServer(async (baseUrl, server) => {
    const member = await register(baseUrl, 'Reset Observer');
    const memberCookie = cookieFrom(member);
    const memberSession = await sessionFor(baseUrl, memberCookie);
    const admin = await adminSession(baseUrl);
    const adminPage = await fetch(`${baseUrl}/vote`, { headers: { cookie: admin.cookie } });
    assert.equal(adminPage.status, 200);
    const adminPageBody = await adminPage.text();
    assert.match(adminPageBody, /id="reset-week"/);
    assert.match(adminPageBody, /ISO week .*through .*This deletes all seven days and cannot be undone/);
    assert.match(adminPageBody, /state\.week\.resetEligible/);
    const memberPage = await fetch(`${baseUrl}/vote`, { headers: { cookie: memberCookie } });
    assert.equal(memberPage.status, 200);
    assert.doesNotMatch(await memberPage.text(), /id="reset-week"/);

    const memberUser = server.database.prepare('SELECT id FROM users WHERE name_key = ?').get('reset observer');
    for (const date of ['2024-02-26', '2024-03-03', '2024-03-04', '2024-02-19']) {
      addVote(server.database, { userId: memberUser.id, voteDate: date });
    }

    const observerSocket = connectSocket(baseUrl, { extraHeaders: { origin: baseUrl, cookie: memberCookie } });
    await waitForSocket(observerSocket);
    try {
      const resetEvents = [];
      observerSocket.on('week:reset', (event) => resetEvents.push(event));
      const unauthenticated = await fetch(`${baseUrl}/api/admin/weeks/2024-02-26/votes`, {
        method: 'DELETE',
        headers: { origin: baseUrl, 'content-type': 'application/json' },
        body: JSON.stringify({ confirmation: true }),
      });
      assert.equal(unauthenticated.status, 401);
      const normalUser = await fetch(`${baseUrl}/api/admin/weeks/2024-02-26/votes`, {
        method: 'DELETE',
        headers: { cookie: memberCookie, origin: baseUrl, 'content-type': 'application/json', 'x-csrf-token': memberSession.csrfToken },
        body: JSON.stringify({ confirmation: true }),
      });
      assert.equal(normalUser.status, 403);

      for (const monday of ['2024-02-19', '2024-03-18']) {
        const outOfWindow = await fetch(`${baseUrl}/api/admin/weeks/${monday}/votes`, {
          method: 'DELETE',
          headers: { cookie: admin.cookie, origin: baseUrl, 'content-type': 'application/json', 'x-csrf-token': admin.csrfToken },
          body: JSON.stringify({ confirmation: true }),
        });
        assert.equal(outOfWindow.status, 400);
      }
      const cancelled = await fetch(`${baseUrl}/api/admin/weeks/2024-02-26/votes`, {
        method: 'DELETE',
        headers: { cookie: admin.cookie, origin: baseUrl, 'content-type': 'application/json', 'x-csrf-token': admin.csrfToken },
        body: JSON.stringify({ confirmation: false }),
      });
      assert.equal(cancelled.status, 400);
      assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM votes WHERE vote_date BETWEEN ? AND ?').get('2024-02-26', '2024-03-03').count, 2);
      assert.equal(resetEvents.length, 0);

      const reset = await fetch(`${baseUrl}/api/admin/weeks/2024-02-26/votes`, {
        method: 'DELETE',
        headers: { cookie: admin.cookie, origin: baseUrl, 'content-type': 'application/json', 'x-csrf-token': admin.csrfToken },
        body: JSON.stringify({ confirmation: true }),
      });
      assert.equal(reset.status, 204);
      assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM votes WHERE vote_date BETWEEN ? AND ?').get('2024-02-26', '2024-03-03').count, 0);
      assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM votes WHERE vote_date = ?').get('2024-03-04').count, 1);
      assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM votes WHERE vote_date = ?').get('2024-02-19').count, 1);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.deepEqual(resetEvents, [{ monday: '2024-02-26', sunday: '2024-03-03' }]);
    } finally {
      observerSocket.close();
    }
  });
});

test('week reset rolls back every deletion and emits no realtime event when the transaction fails', async () => {
  await withServer(async (baseUrl, server) => {
    const member = await register(baseUrl, 'Rollback Reset Observer');
    const memberCookie = cookieFrom(member);
    const admin = await adminSession(baseUrl);
    const memberUser = server.database.prepare('SELECT id FROM users WHERE name_key = ?').get('rollback reset observer');
    addVote(server.database, { userId: memberUser.id, voteDate: '2024-02-26' });
    addVote(server.database, { userId: memberUser.id, voteDate: '2024-02-27' });
    server.database.exec(`
      CREATE TRIGGER fail_week_reset AFTER DELETE ON votes
      BEGIN SELECT RAISE(ABORT, 'forced week reset rollback'); END
    `);
    const socket = connectSocket(baseUrl, { extraHeaders: { origin: baseUrl, cookie: memberCookie } });
    await waitForSocket(socket);
    try {
      let eventSeen = false;
      socket.on('week:reset', () => { eventSeen = true; });
      const response = await fetch(`${baseUrl}/api/admin/weeks/2024-02-26/votes`, {
        method: 'DELETE',
        headers: { cookie: admin.cookie, origin: baseUrl, 'content-type': 'application/json', 'x-csrf-token': admin.csrfToken },
        body: JSON.stringify({ confirmation: true }),
      });
      assert.equal(response.status, 500);
      assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM votes WHERE vote_date BETWEEN ? AND ?').get('2024-02-26', '2024-03-03').count, 2);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(eventSeen, false);
    } finally {
      socket.close();
    }
  });
});
