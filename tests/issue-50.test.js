import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRoom } from '../src/room-storage.js';
import { createServer } from '../src/server.js';

const ENV = { ADMIN_NAME: 'admin', ADMIN_PIN: '4826', PIN_PEPPER: 'issue-50-test-pepper' };

async function startFixture() {
  const directory = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'run-together-issue-50-'));
  const server = createServer({ databasePath: join(directory, 'fixture.sqlite'), env: ENV });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    server,
    baseUrl,
    async login(name, pin = '4826') {
      const response = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { origin: baseUrl, 'content-type': 'application/json' },
        body: JSON.stringify({ name, pin }),
      });
      assert.equal(response.status, 200);
      return response.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
    },
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('Issue 50 serves the versioned shared profile-menu module', async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const response = await fetch(`${fixture.baseUrl}/profile-menu.js?v=issue-50-profile-menu-3`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /javascript/);
  assert.match(await response.text(), /export function mountProfileMenu/);
});

test('Issue 50 places one shared account menu on Rooms and preserves room-list actions', async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const cookie = await fixture.login('admin');
  const response = await fetch(`${fixture.baseUrl}/rooms`, { headers: { cookie } });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /id="rooms-profile-menu"[^>]+data-return-to="\/rooms"/);
  assert.match(html, /room-list\.js\?v=issue-50-profile-menu-3/);
  assert.doesNotMatch(html, /rooms-change-pin|rooms-manage-users|rooms-logout|rooms-display-name|rooms-toolbar__account/);
  assert.match(html, /id="rooms-heading"/);
  assert.match(html, /id="room-cards"/);
  assert.match(html, /id="create-room-form"/);
});

test('Issue 50 puts the shared profile menu after Back and keeps room and week content', async (t) => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const cookie = await fixture.login('admin');
  const adminId = fixture.server.database.prepare("SELECT id FROM users WHERE name = 'admin'").get().id;
  const room = createRoom(fixture.server.database, { creatorUserId: adminId, title: 'Issue 50 room' });
  const response = await fetch(`${fixture.baseUrl}/vote/${room.id}`, { headers: { cookie } });
  assert.equal(response.status, 200);
  const html = await response.text();
  const backIndex = html.indexOf('id="back-to-rooms"');
  const menuIndex = html.indexOf('id="vote-profile-menu"');
  assert.ok(backIndex >= 0 && menuIndex > backIndex, 'Back precedes the profile trigger in the header actions');
  assert.match(html, /id="vote-profile-menu"[^>]+data-return-to="\/vote\/[0-9a-f-]+"/);
  assert.match(html, /profile-menu\.js\?v=issue-50-profile-menu-3/);
  assert.doesNotMatch(html, /id="display-name"|id="manage-users-link"|id="manage-user"|vote-page-identity[^>]*>\s*<span>/);
  assert.match(html, /id="room-information-heading"/);
  assert.match(html, /id="room-information-details"/);
  assert.match(html, /id="vote-timeline"/);
  assert.match(html, /id="week-heading"/);
  assert.match(html, /id="week-days"/);
});
