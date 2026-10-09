import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';
import { MIGRATIONS, migrate, openDatabase } from '../src/database.js';
import { addVote } from '../src/domain.js';

const ENV = { ADMIN_NAME: 'Issue 23 Coach', ADMIN_PIN: '4826', PIN_PEPPER: 'issue-23-pepper' };
const NOW = new Date('2024-02-29T04:00:00.000Z');
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';

async function withServer(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'run-together-issue-23-'));
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

async function login(baseUrl, name, pin) {
  return fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ name, pin }),
  });
}

async function adminSession(baseUrl) {
  const response = await login(baseUrl, ENV.ADMIN_NAME, ENV.ADMIN_PIN);
  const cookie = cookieFrom(response);
  const session = await fetch(`${baseUrl}/api/session`, { headers: { cookie } }).then((result) => result.json());
  return { cookie, csrfToken: session.csrfToken };
}

function adminHeaders(admin, baseUrl, requestId, extra = {}) {
  return {
    cookie: admin.cookie,
    origin: baseUrl,
    'x-csrf-token': admin.csrfToken,
    'content-type': 'application/json',
    ...extra,
  };
}

test('Issue #23 migration is repeatable and upgrades an existing version 3 database', () => {
  const database = openDatabase(':memory:');
  try {
    database.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    for (const migration of MIGRATIONS.filter(({ version }) => version <= 3)) {
      for (const statement of migration.statements) database.exec(statement);
      database.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(migration.version, migration.name, '2024-01-01T00:00:00.000Z');
    }
    migrate(database);
    migrate(database);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count, 4);
    assert.deepEqual(database.prepare('PRAGMA table_info(admin_action_audit)').all().map(({ name }) => name), [
      'id', 'request_id', 'admin_user_id', 'target_user_id', 'target_name', 'action', 'deleted_vote_count', 'occurred_at',
    ]);
  } finally {
    database.close();
  }
});

test('reset votes is admin-only, same-origin protected, idempotent, isolated, and preserves account state', async () => {
  await withServer(async (baseUrl, server) => {
    const registration = await register(baseUrl, 'Reset Issue 23 Target', '5937');
    const targetCookie = cookieFrom(registration);
    const target = server.database.prepare('SELECT * FROM users WHERE name_key = ?').get('reset issue 23 target');
    const targetSession = server.database.prepare('SELECT * FROM sessions WHERE user_id = ?').get(target.id);
    const otherRegistration = await register(baseUrl, 'Reset Issue 23 Other');
    const admin = await adminSession(baseUrl);
    addVote(server.database, { userId: target.id, voteDate: '2024-02-26' });
    addVote(server.database, { userId: target.id, voteDate: '2024-02-27' });
    addVote(server.database, { userId: target.id, voteDate: '2024-03-04' });
    const before = server.database.prepare('SELECT pin_salt, pin_hash, role FROM users WHERE id = ?').get(target.id);

    const missingCsrf = await fetch(`${baseUrl}/api/admin/users/${target.id}/votes`, {
      method: 'DELETE', headers: { cookie: admin.cookie, origin: baseUrl, 'content-type': 'application/json' },
      body: JSON.stringify({ confirmation: true, requestId: REQUEST_ID }),
    });
    assert.equal(missingCsrf.status, 403);
    const wrongOrigin = await fetch(`${baseUrl}/api/admin/users/${target.id}/votes`, {
      method: 'DELETE', headers: adminHeaders(admin, baseUrl, REQUEST_ID, { origin: 'https://evil.example' }),
      body: JSON.stringify({ confirmation: true, requestId: REQUEST_ID }),
    });
    assert.equal(wrongOrigin.status, 403);
    const notConfirmed = await fetch(`${baseUrl}/api/admin/users/${target.id}/votes`, {
      method: 'DELETE', headers: adminHeaders(admin, baseUrl, REQUEST_ID),
      body: JSON.stringify({ confirmation: false, requestId: REQUEST_ID }),
    });
    assert.equal(notConfirmed.status, 400);

    const reset = await fetch(`${baseUrl}/api/admin/users/${target.id}/votes`, {
      method: 'DELETE', headers: adminHeaders(admin, baseUrl, REQUEST_ID),
      body: JSON.stringify({ confirmation: true, requestId: REQUEST_ID }),
    });
    assert.equal(reset.status, 200);
    assert.deepEqual(await reset.json(), { deletedVoteCount: 3, requestId: REQUEST_ID, replayed: false });
    assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM votes WHERE user_id = ?').get(target.id).count, 0);
    assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM votes WHERE vote_date = ?').get('2024-03-04').count, 0);
    assert.deepEqual(server.database.prepare('SELECT pin_salt, pin_hash, role FROM users WHERE id = ?').get(target.id), before);
    assert.deepEqual(server.database.prepare('SELECT id FROM sessions WHERE user_id = ?').all(target.id), [{ id: targetSession.id }]);
    assert.equal((await fetch(`${baseUrl}/api/session`, { headers: { cookie: targetCookie } })).status, 200);
    assert.equal((await login(baseUrl, 'Reset Issue 23 Target', '5937')).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/session`, { headers: { cookie: cookieFrom(otherRegistration) } })).status, 200);

    const replay = await fetch(`${baseUrl}/api/admin/users/${target.id}/votes`, {
      method: 'DELETE', headers: adminHeaders(admin, baseUrl, REQUEST_ID),
      body: JSON.stringify({ confirmation: true, requestId: REQUEST_ID }),
    });
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), { deletedVoteCount: 3, requestId: REQUEST_ID, replayed: true });
    assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM admin_action_audit WHERE request_id = ?').get(REQUEST_ID).count, 1);

    const conflict = await fetch(`${baseUrl}/api/admin/users/${target.id}/votes`, {
      method: 'DELETE', headers: adminHeaders(admin, baseUrl, REQUEST_ID),
      body: JSON.stringify({ confirmation: true, requestId: '22222222-2222-4222-8222-222222222222' }),
    });
    assert.equal(conflict.status, 200);
    const wrongAction = await fetch(`${baseUrl}/api/admin/users/${target.id}`, {
      method: 'DELETE', headers: adminHeaders(admin, baseUrl, REQUEST_ID),
      body: JSON.stringify({ confirmation: true, requestId: REQUEST_ID }),
    });
    assert.equal(wrongAction.status, 409);
  });
});

test('deletion requires boolean confirmation and UUID, audits before cascade, and exact replay emits no second action', async () => {
  await withServer(async (baseUrl, server) => {
    const targetRegistration = await register(baseUrl, 'Delete Issue 23 Target');
    const targetCookie = cookieFrom(targetRegistration);
    const target = server.database.prepare('SELECT id FROM users WHERE name_key = ?').get('delete issue 23 target');
    const admin = await adminSession(baseUrl);
    addVote(server.database, { userId: target.id, voteDate: '2024-02-28' });
    const payload = { confirmation: true, requestId: '33333333-3333-4333-8333-333333333333' };
    const invalid = await fetch(`${baseUrl}/api/admin/users/${target.id}`, {
      method: 'DELETE', headers: adminHeaders(admin, baseUrl, payload.requestId),
      body: JSON.stringify({ confirmation: 'Delete Issue 23 Target', requestId: 'not-a-uuid' }),
    });
    assert.equal(invalid.status, 400);
    const deleted = await fetch(`${baseUrl}/api/admin/users/${target.id}`, {
      method: 'DELETE', headers: adminHeaders(admin, baseUrl, payload.requestId), body: JSON.stringify(payload),
    });
    assert.equal(deleted.status, 200);
    assert.deepEqual(await deleted.json(), { deletedVoteCount: 1, requestId: payload.requestId, replayed: false });
    assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM users WHERE id = ?').get(target.id).count, 0);
    assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM votes WHERE user_id = ?').get(target.id).count, 0);
    assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?').get(target.id).count, 0);
    assert.equal((await fetch(`${baseUrl}/api/session`, { headers: { cookie: targetCookie } })).status, 401);
    const audit = server.database.prepare('SELECT request_id, admin_user_id, target_user_id, target_name, action, deleted_vote_count FROM admin_action_audit WHERE request_id = ?').get(payload.requestId);
    assert.deepEqual(Object.keys(audit).sort(), ['action', 'admin_user_id', 'deleted_vote_count', 'request_id', 'target_name', 'target_user_id']);
    assert.equal(audit.target_name, 'Delete Issue 23 Target');
    assert.equal(JSON.stringify(audit).includes('5937'), false);
    const replay = await fetch(`${baseUrl}/api/admin/users/${target.id}`, {
      method: 'DELETE', headers: adminHeaders(admin, baseUrl, payload.requestId), body: JSON.stringify(payload),
    });
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), { deletedVoteCount: 1, requestId: payload.requestId, replayed: true });
    assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM admin_action_audit WHERE request_id = ?').get(payload.requestId).count, 1);
  });
});

test('admin action rollback and stale targets leave data, audit, and side effects unchanged', async () => {
  await withServer(async (baseUrl, server) => {
    const targetRegistration = await register(baseUrl, 'Rollback Issue 23 Target');
    const target = server.database.prepare('SELECT id FROM users WHERE name_key = ?').get('rollback issue 23 target');
    const admin = await adminSession(baseUrl);
    const missing = await fetch(`${baseUrl}/api/admin/users/99999/votes`, {
      method: 'DELETE', headers: adminHeaders(admin, baseUrl, '66666666-6666-4666-8666-666666666666'),
      body: JSON.stringify({ confirmation: true, requestId: '66666666-6666-4666-8666-666666666666' }),
    });
    assert.equal(missing.status, 404);
    assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM admin_action_audit').get().count, 0);

    addVote(server.database, { userId: target.id, voteDate: '2024-02-28' });
    server.database.exec("CREATE TRIGGER fail_issue_23_reset AFTER DELETE ON votes BEGIN SELECT RAISE(ABORT, 'forced issue 23 reset rollback'); END");
    const reset = await fetch(`${baseUrl}/api/admin/users/${target.id}/votes`, {
      method: 'DELETE', headers: adminHeaders(admin, baseUrl, '77777777-7777-4777-8777-777777777777'),
      body: JSON.stringify({ confirmation: true, requestId: '77777777-7777-4777-8777-777777777777' }),
    });
    assert.equal(reset.status, 500);
    assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM votes WHERE user_id = ?').get(target.id).count, 1);
    assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM admin_action_audit').get().count, 0);
    server.database.exec('DROP TRIGGER fail_issue_23_reset');

    server.database.exec("CREATE TRIGGER fail_issue_23_delete BEFORE DELETE ON users WHEN OLD.role = 'user' BEGIN SELECT RAISE(ABORT, 'forced issue 23 delete rollback'); END");
    const deletion = await fetch(`${baseUrl}/api/admin/users/${target.id}`, {
      method: 'DELETE', headers: adminHeaders(admin, baseUrl, '88888888-8888-4888-8888-888888888888'),
      body: JSON.stringify({ confirmation: true, requestId: '88888888-8888-4888-8888-888888888888' }),
    });
    assert.equal(deletion.status, 500);
    assert.ok(server.database.prepare('SELECT id FROM users WHERE id = ?').get(target.id));
    assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM admin_action_audit').get().count, 0);
    assert.equal((await fetch(`${baseUrl}/api/session`, { headers: { cookie: cookieFrom(targetRegistration) } })).status, 200);
  });
});
test('admin page uses native dialogs, accessible labels, safe text nodes, and no name re-entry', async () => {
  await withServer(async (baseUrl) => {
    const admin = await adminSession(baseUrl);
    const page = await fetch(`${baseUrl}/admin`, { headers: { cookie: admin.cookie } });
    assert.equal(page.status, 200);
    const body = await page.text();
    assert.match(body, /document\.createElement\('dialog'\)/);
    assert.match(body, /Yes, reset votes/);
    assert.match(body, /No, cancel/);
    assert.match(body, /Yes, delete user/);
    assert.match(body, /Delete ' \+ user\.displayName/);
    assert.match(body, /crypto\.randomUUID\(\)/);
    assert.match(body, /textContent/);
    assert.doesNotMatch(body, /Type name to confirm/);
    assert.match(body, /min-width:\s*44px/);
  });
});
