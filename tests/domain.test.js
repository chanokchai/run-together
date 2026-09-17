import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openDatabase, migrate } from '../src/database.js';
import {
  addVote,
  bootstrapAdmin,
  createSession,
  createUser,
  deleteUser,
  listAdmins,
} from '../src/domain.js';

async function withDatabase(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'run-together-domain-'));
  const database = openDatabase(join(directory, 'test.sqlite'));
  migrate(database);
  try {
    await callback(database);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const pinMaterial = () => ({ pinSalt: Buffer.from('synthetic-salt'), pinHash: Buffer.from('synthetic-hash') });

test('user names are trimmed, Unicode-normalized, and case-insensitively unique', async () => {
  await withDatabase((database) => {
    const user = createUser(database, { name: '  Ａlice  ', ...pinMaterial(), now: '2026-09-12T00:00:00.000Z' });
    assert.equal(user.name, 'Alice');
    assert.throws(
      () => createUser(database, { name: ' alice ', ...pinMaterial(), now: '2026-09-12T00:00:00.000Z' }),
      /name already exists/i,
    );
  });
});

test('votes and sessions cascade when a normal user is deleted', async () => {
  await withDatabase((database) => {
    const user = createUser(database, { name: 'Runner', ...pinMaterial() });
    addVote(database, { userId: user.id, voteDate: '2026-09-14', createdAt: '2026-09-12T00:00:00.000Z' });
    assert.throws(
      () => addVote(database, { userId: user.id, voteDate: '2026-09-14', createdAt: '2026-09-12T00:00:00.000Z' }),
      /unique|constraint/i,
    );
    createSession(database, {
      userId: user.id,
      tokenHash: Buffer.from('token-hash'),
      csrfSecret: Buffer.from('csrf-secret'),
      createdAt: '2026-09-12T00:00:00.000Z',
      lastSeenAt: '2026-09-12T00:00:00.000Z',
      expiresAt: '2026-09-13T00:00:00.000Z',
    });
    assert.equal(deleteUser(database, user.id), true);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM votes').get().count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
  });
});

test('admin bootstrap is idempotent and protects the single admin', async () => {
  await withDatabase((database) => {
    const env = { ADMIN_NAME: '  Coach  ', ADMIN_PIN: '4826', PIN_PEPPER: 'synthetic-pepper' };
    const first = bootstrapAdmin(database, { env, now: () => new Date('2026-09-12T00:00:00.000Z') });
    const second = bootstrapAdmin(database, { env, now: () => new Date('2026-09-13T00:00:00.000Z') });
    assert.equal(first.id, second.id);
    assert.equal(listAdmins(database).length, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM users').get().count, 1);
    assert.throws(() => deleteUser(database, first.id), /admin.*delete/i);
    assert.throws(
      () => database.prepare('DELETE FROM users WHERE id = ?').run(first.id),
      /admin.*delete/i,
    );
    assert.equal(database.prepare('SELECT pin_salt, pin_hash FROM users WHERE id = ?').get(first.id).pin_hash.includes('4826'), false);
  });
});

test('admin bootstrap fails closed for invalid configuration or conflicting admin', async () => {
  await withDatabase((database) => {
    assert.throws(() => bootstrapAdmin(database, { env: {} }), /ADMIN_NAME|ADMIN_PIN|PIN_PEPPER/);
    assert.throws(
      () => bootstrapAdmin(database, { env: { ADMIN_NAME: 'Coach', ADMIN_PIN: '123', PIN_PEPPER: 'synthetic' } }),
      /four ASCII digits/i,
    );
    const env = { ADMIN_NAME: 'Coach', ADMIN_PIN: '4826', PIN_PEPPER: 'synthetic' };
    bootstrapAdmin(database, { env });
    assert.throws(
      () => bootstrapAdmin(database, { env: { ...env, ADMIN_NAME: 'Other' } }),
      /conflict|admin/i,
    );
    const before = database.prepare('SELECT pin_hash FROM users WHERE role = \'admin\'').get().pin_hash;
    const sameAdmin = bootstrapAdmin(database, { env: { ...env, ADMIN_PIN: '5937' } });
    const after = database.prepare('SELECT pin_hash FROM users WHERE role = \'admin\'').get().pin_hash;
    assert.equal(sameAdmin.id, 1);
    assert.deepEqual(after, before);
  });
});
