import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';

const ENV = {
  ADMIN_NAME: 'Synthetic Security Admin',
  ADMIN_PIN: '4826',
  PIN_PEPPER: 'issue-10-synthetic-security-pepper',
};

async function withServer(callback) {
  const directory = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'run-together-issue-10-security-'));
  const server = createServer({ databasePath: join(directory, 'issue-10-synthetic.sqlite'), env: ENV });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await callback(baseUrl, server);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function cookieFrom(response) {
  return response.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
}

async function postJson(baseUrl, path, body) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { origin: baseUrl, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('Issue 10 SQL-shaped identities stay literal and cannot authenticate or authorize as admin', async () => {
  await withServer(async (baseUrl, server) => {
    const sqlShapedName = "admin' OR 1=1 --";
    const registration = await postJson(baseUrl, '/api/auth/register', {
      name: sqlShapedName,
      pin: '0042',
      pinConfirmation: '0042',
    });
    assert.equal(registration.status, 201, 'the application stores SQL-shaped text as an ordinary synthetic member name');
    const memberCookie = cookieFrom(registration);
    const memberSessionResponse = await fetch(`${baseUrl}/api/session`, { headers: { cookie: memberCookie } });
    assert.equal(memberSessionResponse.status, 200);
    const memberSession = await memberSessionResponse.json();
    assert.equal(memberSession.displayName, sqlShapedName);
    assert.equal(memberSession.role, 'user', 'the SQL-shaped member retains the normal-user role');
    assert.equal((await fetch(`${baseUrl}/admin`, { headers: { cookie: memberCookie } })).status, 403,
      'an SQL-shaped member cannot open administrator pages');

    const sessionsBeforeAttack = server.database.prepare('SELECT COUNT(*) AS count FROM sessions').get().count;
    const injectionLogin = await postJson(baseUrl, '/api/auth/login', { name: "' OR 1=1 --", pin: ENV.ADMIN_PIN });
    assert.equal(injectionLogin.status, 401, 'SQL syntax in the identity field cannot turn a failed lookup into an admin login');
    assert.equal((await injectionLogin.json()).code, 'INVALID_CREDENTIALS');
    assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, sessionsBeforeAttack,
      'failed injection attempts create no authenticated session');

    const legitimateAdmin = await postJson(baseUrl, '/api/auth/login', { name: ENV.ADMIN_NAME, pin: ENV.ADMIN_PIN });
    assert.equal(legitimateAdmin.status, 200, 'parameterized lookup still permits the real synthetic admin to sign in');
    const adminSession = await fetch(`${baseUrl}/api/session`, { headers: { cookie: cookieFrom(legitimateAdmin) } }).then((response) => response.json());
    assert.equal(adminSession.role, 'admin');
  });
});
