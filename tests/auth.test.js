import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';
import { validateCredentials } from '../src/auth.js';

const ENV = {
  ADMIN_NAME: 'Synthetic Coach',
  ADMIN_PIN: '4826',
  PIN_PEPPER: 'synthetic-pepper',
};

async function withServer(callback, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'run-together-auth-'));
  const server = createServer({ databasePath: join(directory, 'test.sqlite'), env: ENV, ...options });
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

async function register(baseUrl, name, pin, pinConfirmation = pin, headers = {}) {
  return fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ name, pin, pinConfirmation }),
  });
}

async function login(baseUrl, name, pin, cookie = '', headers = {}) {
  return fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
    body: JSON.stringify({ name, pin }),
  });
}

test('registration validates Unicode code points and exact string PIN rules', async () => {
  await withServer(async (baseUrl) => {
    assert.equal((await register(baseUrl, 'a'.repeat(41), '0001')).status, 400);
    assert.equal((await register(baseUrl, 'runner', 42, '42')).status, 400);
    assert.equal((await register(baseUrl, 'runner', '1234', '1235')).status, 400);
    assert.equal((await register(baseUrl, '😀', '0001')).status, 201);
    assert.equal((await register(baseUrl, 'นักวิ่ง', '0042')).status, 201);
  });
});

test('registration requires PIN confirmation and does not consume quota when omitted', async () => {
  await withServer(async (baseUrl, server) => {
    const response = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Missing Confirmation', pin: '0042' }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'PIN_MISMATCH');
    assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM users WHERE name_key = ?').get('missing confirmation').count, 0);
    const nonString = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Non-string Confirmation', pin: '0042', pinConfirmation: 42 }),
    });
    assert.equal(nonString.status, 400);
    assert.equal((await nonString.json()).code, 'PIN_MISMATCH');
    assert.equal((await register(baseUrl, 'Missing Confirmation', '0042', '0042')).status, 201);
  });
});

test('credential validation normalizes names and enforces 1–40 Unicode code points', () => {
  assert.equal(validateCredentials({ name: '  Ａlice  ', pin: '0042', pinConfirmation: '0042' }).name, 'Alice');
  assert.equal(validateCredentials({ name: 'x'.repeat(40), pin: '0042', pinConfirmation: '0042' }).name.length, 40);
  assert.equal(validateCredentials({ name: '😀'.repeat(40), pin: '0042', pinConfirmation: '0042' }).name.length, 80);
  assert.throws(() => validateCredentials({ name: '', pin: '0042', pinConfirmation: '0042' }), /name/i);
  assert.throws(() => validateCredentials({ name: 'x'.repeat(41), pin: '0042', pinConfirmation: '0042' }), /name/i);
});

test('registration immediately authenticates and session response is safe', async () => {
  await withServer(async (baseUrl, server) => {
    const response = await register(baseUrl, '  Runner One  ', '0042');
    assert.equal(response.status, 201);
    const cookie = cookieFrom(response);
    assert.match(cookie, /^run_together_session=/);
    assert.match(response.headers.get('set-cookie'), /HttpOnly/i);
    assert.match(response.headers.get('set-cookie'), /Secure/i);
    assert.match(response.headers.get('set-cookie'), /SameSite=Lax/i);
    assert.match(response.headers.get('set-cookie'), /Max-Age=2592000/);
    const storedUser = server.database.prepare('SELECT name, pin_salt, pin_hash FROM users WHERE name_key = ?').get('runner one');
    assert.equal(storedUser.name, 'Runner One');
    assert.equal(storedUser.pin_hash.includes(Buffer.from('0042')), false);
    assert.equal(server.database.prepare('SELECT token_hash FROM sessions').get().token_hash.toString('base64url') === cookie.split('=', 2)[1], false);
    const sessionResponse = await fetch(`${baseUrl}/api/session`, { headers: { cookie } });
    assert.equal(sessionResponse.status, 200);
    const session = await sessionResponse.json();
    assert.equal(session.displayName, 'Runner One');
    assert.equal(session.role, 'user');
    assert.ok(session.csrfToken);
    assert.ok(session.expiresAt);
    assert.equal('id' in session, false);
    assert.equal('tokenHash' in session, false);
    assert.equal('rawToken' in session, false);
    const votePage = await fetch(`${baseUrl}/vote`, { headers: { cookie } });
    assert.equal(votePage.status, 200);
    assert.match(await votePage.text(), /Runner One/);
  });
});

test('protected HTML and session responses are not cacheable', async () => {
  await withServer(async (baseUrl) => {
    const registration = await register(baseUrl, 'Cache Runner', '0042');
    const cookie = cookieFrom(registration);

    const sessionResponse = await fetch(`${baseUrl}/api/session`, { headers: { cookie } });
    const votePage = await fetch(`${baseUrl}/vote`, { headers: { cookie } });

    assert.equal(sessionResponse.headers.get('cache-control'), 'no-store');
    assert.equal(votePage.headers.get('cache-control'), 'no-store');
  });
});

test('protected page guards BFCache restoration with pageshow session revalidation', async () => {
  await withServer(async (baseUrl) => {
    const registration = await register(baseUrl, 'BFCache Runner', '0042');
    const votePage = await fetch(`${baseUrl}/vote`, { headers: { cookie: cookieFrom(registration) } });
    const body = await votePage.text();

    assert.match(body, /id="protected-content" hidden/);
    assert.match(body, /addEventListener\('pageshow', loadSession\)/);
    assert.match(body, /location\.replace\('\/'\)/);
  });
});

test('unknown and wrong PIN failures are generic and delayed without blocking another request', async () => {
  await withServer(async (baseUrl) => {
    const registration = await register(baseUrl, 'Timing Runner', '0042');
    assert.equal(registration.status, 201);
    const started = performance.now();
    const failed = login(baseUrl, 'Unknown Runner', '0042');
    const health = await fetch(`${baseUrl}/health`);
    const healthElapsed = performance.now() - started;
    const unknown = await failed;
    const unknownElapsed = performance.now() - started;
    const wrongStarted = performance.now();
    const wrong = await login(baseUrl, 'Timing Runner', '9999');
    const wrongElapsed = performance.now() - wrongStarted;
    assert.equal(health.status, 200);
    assert.ok(healthElapsed < 900, `health request blocked for ${healthElapsed}ms`);
    assert.equal(unknown.status, 401);
    assert.equal(wrong.status, 401);
    assert.deepEqual(await unknown.json(), await wrong.json());
    assert.ok(unknownElapsed >= 1000, `unknown login completed in ${unknownElapsed}ms`);
    assert.ok(wrongElapsed >= 1000, `wrong login completed in ${wrongElapsed}ms`);
  });
});

test('session restores, rolls expiry, and logout revokes and clears it', async () => {
  await withServer(async (baseUrl) => {
    const registration = await register(baseUrl, 'Session Runner', '0042');
    const cookie = cookieFrom(registration);
    const before = await fetch(`${baseUrl}/api/session`, { headers: { cookie } });
    const beforeData = await before.json();
    const after = await fetch(`${baseUrl}/api/session`, { headers: { cookie } });
    assert.equal(after.status, 200);
    assert.equal((await after.json()).displayName, 'Session Runner');
    assert.ok(new Date(after.headers.get('set-cookie').match(/Expires=([^;]+)/i)[1]).getTime() + 1000 >= new Date(beforeData.expiresAt).getTime());
    const sessionData = await fetch(`${baseUrl}/api/session`, { headers: { cookie } }).then((response) => response.json());
    const logout = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie, 'x-csrf-token': sessionData.csrfToken },
    });
    assert.equal(logout.status, 204);
    assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await fetch(`${baseUrl}/api/session`, { headers: { cookie } })).status, 401);
  });
});

test('expired sessions are rejected and cleaned up, while normalized duplicate names stay generic', async () => {
  let current = new Date('2026-09-12T00:00:00.000Z');
  await withServer(async (baseUrl, server) => {
    const registration = await register(baseUrl, '  Alice  ', '0042');
    assert.equal(registration.status, 201);
    const duplicate = await register(baseUrl, 'alice', '0042');
    assert.equal(duplicate.status, 409);
    assert.match((await duplicate.json()).message, /already|ใช้แล้ว/i);
    current = new Date(current.getTime() + 30 * 24 * 60 * 60 * 1000 + 1);
    assert.equal((await fetch(`${baseUrl}/api/session`, { headers: { cookie: cookieFrom(registration) } })).status, 401);
    assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
  }, { now: () => current });
});

test('bootstrap admin can sign in without exposing bootstrap material', async () => {
  await withServer(async (baseUrl) => {
    const response = await login(baseUrl, 'Synthetic Coach', '4826');
    assert.equal(response.status, 200);
    const cookie = cookieFrom(response);
    const session = await fetch(`${baseUrl}/api/session`, { headers: { cookie } }).then((result) => result.json());
    assert.equal(session.displayName, 'Synthetic Coach');
    assert.equal(session.role, 'admin');
    assert.equal(JSON.stringify(session).includes('synthetic-pepper'), false);
    assert.equal(JSON.stringify(session).includes('4826'), false);
  });
});

test('CSRF and origin checks protect PIN change, while valid change revokes other sessions', async () => {
  await withServer(async (baseUrl, server) => {
    const first = await register(baseUrl, 'PIN Runner', '0042');
    const firstCookie = cookieFrom(first);
    const second = await login(baseUrl, 'PIN Runner', '0042');
    const secondCookie = cookieFrom(second);
    const session = await fetch(`${baseUrl}/api/session`, { headers: { cookie: firstCookie } }).then((response) => response.json());
    const missing = await fetch(`${baseUrl}/api/account/pin`, {
      method: 'PUT', headers: { cookie: firstCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ currentPin: '0042', newPin: '5937', newPinConfirmation: '5937' }),
    });
    assert.equal(missing.status, 403);
    const foreign = await fetch(`${baseUrl}/api/account/pin`, {
      method: 'PUT', headers: { cookie: firstCookie, 'content-type': 'application/json', 'x-csrf-token': session.csrfToken, origin: 'https://evil.example' },
      body: JSON.stringify({ currentPin: '0042', newPin: '5937', newPinConfirmation: '5937' }),
    });
    assert.equal(foreign.status, 403);
    const beforeMaterial = server.database.prepare('SELECT pin_salt, pin_hash FROM users WHERE name_key = ?').get('pin runner');
    const changed = await fetch(`${baseUrl}/api/account/pin`, {
      method: 'PUT', headers: { cookie: firstCookie, 'content-type': 'application/json', 'x-csrf-token': session.csrfToken, origin: baseUrl },
      body: JSON.stringify({ currentPin: '0042', newPin: '5937', newPinConfirmation: '5937' }),
    });
    assert.equal(changed.status, 204);
    const afterMaterial = server.database.prepare('SELECT pin_salt, pin_hash FROM users WHERE name_key = ?').get('pin runner');
    assert.notDeepEqual(afterMaterial.pin_salt, beforeMaterial.pin_salt);
    assert.notDeepEqual(afterMaterial.pin_hash, beforeMaterial.pin_hash);
    assert.equal((await fetch(`${baseUrl}/api/session`, { headers: { cookie: firstCookie } })).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/session`, { headers: { cookie: secondCookie } })).status, 401);
    assert.equal((await login(baseUrl, 'PIN Runner', '0042')).status, 401);
    assert.equal((await login(baseUrl, 'PIN Runner', '5937')).status, 200);
  });
});

test('successful registration limit is ten per source window and invalid requests do not count', async () => {
  await withServer(async (baseUrl) => {
    const invalid = await register(baseUrl, '', '0042', '0042');
    assert.equal(invalid.status, 400);
    for (let index = 1; index <= 10; index += 1) {
      const response = await register(baseUrl, `Limited ${index}`, '0042');
      assert.equal(response.status, 201);
    }
    const limited = await register(baseUrl, 'Limited 11', '0042');
    assert.equal(limited.status, 429);
    assert.match((await limited.json()).message, /temporarily|ชั่วคราว/i);
    assert.equal((await login(baseUrl, 'Limited 1', '0042')).status, 200);
  });
});

test('registration quota expires after its injected rolling window', async () => {
  let current = new Date('2026-09-12T00:00:00.000Z');
  await withServer(async (baseUrl) => {
    for (let index = 1; index <= 10; index += 1) {
      assert.equal((await register(baseUrl, `Window ${index}`, '0042')).status, 201);
    }
    assert.equal((await register(baseUrl, 'Window Blocked', '0042')).status, 429);
    current = new Date(current.getTime() + 10 * 60 * 1000 + 1);
    assert.equal((await register(baseUrl, 'Window Reopened', '0042')).status, 201);
  }, { now: () => current });
});
