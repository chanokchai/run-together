import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';

const ENV = {
  ADMIN_NAME: 'Synthetic Coach',
  ADMIN_PIN: '4826',
  PIN_PEPPER: 'synthetic-pepper',
};

async function withServer(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'run-together-issue-21-'));
  const server = createServer({ databasePath: join(directory, 'test.sqlite'), env: ENV });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address();
    await callback(`http://127.0.0.1:${port}`);
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

async function login(baseUrl, name, pin) {
  return fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ name, pin }),
  });
}

test('Issue 21 moves PIN change behind a protected dedicated page', async () => {
  await withServer(async (baseUrl) => {
    const registration = await register(baseUrl, 'Issue 21 Member');
    const cookie = cookieFrom(registration);
    const votePage = await fetch(`${baseUrl}/vote`, { headers: { cookie } });
    assert.equal(votePage.status, 200);
    const voteBody = await votePage.text();
    assert.doesNotMatch(voteBody, /id="pin-form"/);
    assert.doesNotMatch(voteBody, /name="currentPin"/);
    assert.match(voteBody, /id="change-pin"[^>]+href="\/change-pin"/);

    const changePinPage = await fetch(`${baseUrl}/change-pin`, { headers: { cookie } });
    assert.equal(changePinPage.status, 200);
    const changePinBody = await changePinPage.text();
    assert.match(changePinBody, /id="pin-form"/);
    assert.match(changePinBody, /name="currentPin"/);
    assert.match(changePinBody, /name="newPin"/);
    assert.match(changePinBody, /name="newPinConfirmation"/);
    assert.match(changePinBody, /id="return-to-vote"[^>]+href="\/vote"/);
    assert.match(changePinBody, /\/api\/account\/pin/);
    assert.match(changePinBody, /pageshow/);

    const unauthenticated = await fetch(`${baseUrl}/change-pin`);
    assert.equal(unauthenticated.status, 401);
    assert.doesNotMatch(await unauthenticated.text(), /name="currentPin"/);
  });
});

test('Issue 21 gives administrators ordered blue reset and manage-user actions only', async () => {
  await withServer(async (baseUrl) => {
    const member = await register(baseUrl, 'Issue 21 Member');
    const memberPage = await fetch(`${baseUrl}/vote`, { headers: { cookie: cookieFrom(member) } });
    const memberBody = await memberPage.text();
    assert.doesNotMatch(memberBody, /id="manage-user"/);

    const admin = await login(baseUrl, ENV.ADMIN_NAME, ENV.ADMIN_PIN);
    const adminPage = await fetch(`${baseUrl}/vote`, { headers: { cookie: cookieFrom(admin) } });
    assert.equal(adminPage.status, 200);
    const adminBody = await adminPage.text();
    const resetIndex = adminBody.indexOf('id="reset-week"');
    const manageIndex = adminBody.indexOf('id="manage-user"');
    assert.doesNotMatch(adminBody, /id="pin-form"/);
    assert.doesNotMatch(adminBody, /name="currentPin"/);
    assert.ok(resetIndex >= 0);
    assert.ok(manageIndex > resetIndex);
    assert.match(adminBody, /<button id="manage-user"[^>]*>manage user<\/button>/);
    assert.match(adminBody, /id="manage-user"[^>]+class="admin-action"/);
    assert.match(adminBody, /id="reset-week"[^>]+class="admin-action"/);
    assert.match(adminBody, /\.admin-action\s*\{\s*background:\s*#1769aa;/);
    assert.match(adminBody, /manageUser\??\.addEventListener\('click'/);
    assert.match(adminBody, /location\.href = '\/admin'/);
  });
});
