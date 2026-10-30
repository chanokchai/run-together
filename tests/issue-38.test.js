import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LEGACY_ROOM_ID, ROOM_COLOR_PALETTE } from '../src/room-contract.js';
import { createServer } from '../src/server.js';

const ENV = { ADMIN_NAME: 'Issue 38 Admin', ADMIN_PIN: '4826', PIN_PEPPER: 'synthetic-pepper' };
const NOW = new Date('2026-10-27T04:00:00.000Z');

async function withServer(callback) {
  const directory = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'run-together-issue-38-'));
  const server = createServer({ databasePath: join(directory, 'test.sqlite'), env: ENV, now: () => NOW });
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
  const response = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { origin: baseUrl, 'content-type': 'application/json' },
    body: JSON.stringify({ name, pin: '0042', pinConfirmation: '0042' }),
  });
  const cookie = cookieFrom(response);
  const session = response.ok
    ? await fetch(`${baseUrl}/api/session`, { headers: { cookie } }).then((result) => result.json())
    : {};
  return { response, cookie, csrfToken: session.csrfToken };
}

async function loginAdmin(baseUrl) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { origin: baseUrl, 'content-type': 'application/json' },
    body: JSON.stringify({ name: ENV.ADMIN_NAME, pin: ENV.ADMIN_PIN }),
  });
  return { response, cookie: cookieFrom(response) };
}

function withCookie(cookie) {
  return { headers: { cookie }, redirect: 'manual' };
}

test('Issue 38 login and authenticated landing require room selection before voting', async () => {
  await withServer(async (baseUrl) => {
    const member = await register(baseUrl, 'Issue 38 Member');
    assert.equal(member.response.status, 201);

    const root = await fetch(`${baseUrl}/`, withCookie(member.cookie));
    assert.equal(root.status, 302);
    assert.equal(root.headers.get('location'), '/rooms');

    const roomList = await fetch(`${baseUrl}/rooms`, withCookie(member.cookie));
    assert.equal(roomList.status, 200);
    assert.match(await roomList.text(), /id="rooms-content"/);

    const bareVote = await fetch(`${baseUrl}/vote`, withCookie(member.cookie));
    assert.equal(bareVote.status, 302);
    assert.equal(bareVote.headers.get('location'), '/rooms');

    const login = await fetch(`${baseUrl}/`);
    const registration = await fetch(`${baseUrl}/register`);
    assert.match(await login.text(), /location\.href = '\/rooms'/);
    assert.match(await registration.text(), /location\.href = '\/rooms'/);
  });
});

test('Issue 38 board URL and every board API path explicitly include the legacy room UUID', async () => {
  await withServer(async (baseUrl) => {
    const member = await register(baseUrl, 'Issue 38 Legacy Member');
    const response = await fetch(`${baseUrl}/vote/${LEGACY_ROOM_ID}`, { headers: { cookie: member.cookie } });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, new RegExp(`data-room-id="${LEGACY_ROOM_ID}"`));
    assert.match(html, /<h1 id="room-heading">Run Together<\/h1>/);
    assert.match(html, /id="vote-page-identity"/);
    assert.match(html, /function roomApiPath\(_legacyPath, scopedPath\) \{ return roomApiPrefix \+ scopedPath; \}/);
    assert.match(html, new RegExp(`const roomApiPrefix = "/api/rooms/${LEGACY_ROOM_ID}"`));
    assert.match(html, /roomApiPath\('\/api\/vote-timeline', '\/vote-timeline'\)/);
    assert.match(html, /roomApiPath\('\/api\/weeks\/' \+ encodeURIComponent\(monday\), '\/weeks\/' \+ encodeURIComponent\(monday\)\)/);
    assert.match(html, /socket\.emit\('room:subscribe', \{ roomId \}/);
  });
});

test('Issue 38 room selection rejects unknown UUIDs without opening a global board', async () => {
  await withServer(async (baseUrl) => {
    const member = await register(baseUrl, 'Issue 38 Unknown Room Member');
    const response = await fetch(`${baseUrl}/vote/00000000-0000-4000-8000-000000000099`, {
      headers: { cookie: member.cookie },
    });
    assert.equal(response.status, 404);
  });
});

test('Issue 38 return navigation only accepts local room contexts', async () => {
  await withServer(async (baseUrl) => {
    const member = await register(baseUrl, 'Issue 38 Return Member');
    const escapedReturn = await fetch(`${baseUrl}/change-pin?returnTo=${encodeURIComponent('https://evil.example/path')}`, {
      headers: { cookie: member.cookie },
    });
    assert.equal(escapedReturn.status, 200);
    const escapedHtml = await escapedReturn.text();
    assert.match(escapedHtml, /id="return-to-vote"[^>]+href="\/rooms"/);
    assert.doesNotMatch(escapedHtml, /evil\.example/);

    const safeReturn = `/vote/${LEGACY_ROOM_ID}`;
    const safePage = await fetch(`${baseUrl}/change-pin?returnTo=${encodeURIComponent(safeReturn)}`, {
      headers: { cookie: member.cookie },
    });
    assert.match(await safePage.text(), new RegExp(`id="return-to-vote"[^>]+href="${safeReturn}"`));

    const admin = await loginAdmin(baseUrl);
    const adminPage = await fetch(`${baseUrl}/admin?returnTo=${encodeURIComponent(safeReturn)}`, {
      headers: { cookie: admin.cookie },
    });
    assert.equal(adminPage.status, 200);
    assert.match(await adminPage.text(), new RegExp(`href="${safeReturn}" class="button"`));
  });
});

test('Issue 38 rooms are shared, retain membership, and allow metadata edits only by their owner', async () => {
  await withServer(async (baseUrl, server) => {
    const owner = await register(baseUrl, 'Issue 38 Room Owner');
    const member = await register(baseUrl, 'Issue 38 Room Member');
    assert.equal(owner.response.status, 201);
    assert.equal(member.response.status, 201);

    const create = await fetch(`${baseUrl}/api/rooms`, {
      method: 'POST',
      headers: { origin: baseUrl, cookie: owner.cookie, 'x-csrf-token': owner.csrfToken, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Court <b>One</b>', icon: 'basketball' }),
    });
    assert.equal(create.status, 201);
    const room = (await create.json()).room;
    assert.match(room.id, /^[0-9a-f-]{36}$/);
    assert.equal(room.icon, 'basketball');
    assert.ok(ROOM_COLOR_PALETTE.includes(room.color));
    assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM room_memberships WHERE room_id = ? AND user_id = ?').get(room.id, room.ownerUserId).count, 1);

    const ownerRooms = await fetch(`${baseUrl}/api/rooms`, { headers: { cookie: owner.cookie } }).then((result) => result.json());
    const memberRooms = await fetch(`${baseUrl}/api/rooms`, { headers: { cookie: member.cookie } }).then((result) => result.json());
    assert.equal(ownerRooms.rooms.find(({ id }) => id === room.id).canEdit, true);
    assert.equal(memberRooms.rooms.find(({ id }) => id === room.id).canEdit, false);
    assert.equal(memberRooms.rooms.find(({ id }) => id === room.id).color, room.color);

    const denied = await fetch(`${baseUrl}/api/rooms/${room.id}`, {
      method: 'PUT',
      headers: { origin: baseUrl, cookie: member.cookie, 'x-csrf-token': member.csrfToken, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Not allowed' }),
    });
    assert.equal(denied.status, 403);

    for (const title of ['  ', '🏃'.repeat(31)]) {
      const invalid = await fetch(`${baseUrl}/api/rooms`, {
        method: 'POST',
        headers: { origin: baseUrl, cookie: owner.cookie, 'x-csrf-token': owner.csrfToken, 'content-type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      assert.equal(invalid.status, 400);
    }

    const iconUpdate = await fetch(`${baseUrl}/api/rooms/${room.id}`, {
      method: 'PUT',
      headers: { origin: baseUrl, cookie: owner.cookie, 'x-csrf-token': owner.csrfToken, 'content-type': 'application/json' },
      body: JSON.stringify({ icon: 'tennis' }),
    });
    assert.equal(iconUpdate.status, 200);
    const updated = (await iconUpdate.json()).room;
    assert.equal(updated.icon, 'tennis');
    assert.equal(updated.title, room.title);
    assert.equal(updated.color, room.color);

    const firstEnter = await fetch(`${baseUrl}/api/rooms/${room.id}/enter`, {
      method: 'POST', headers: { origin: baseUrl, cookie: member.cookie, 'x-csrf-token': member.csrfToken, 'content-type': 'application/json' }, body: '{}',
    }).then((result) => result.json());
    const secondEnter = await fetch(`${baseUrl}/api/rooms/${room.id}/enter`, {
      method: 'POST', headers: { origin: baseUrl, cookie: member.cookie, 'x-csrf-token': member.csrfToken, 'content-type': 'application/json' }, body: '{}',
    }).then((result) => result.json());
    assert.equal(firstEnter.membership.joinedAt, secondEnter.membership.joinedAt);
    assert.equal(server.database.prepare('SELECT COUNT(*) AS count FROM room_memberships WHERE room_id = ? AND user_id = ?').get(room.id, firstEnter.membership.userId).count, 1);
  });
});

function relativeLuminance(color) {
  const channels = color.match(/[0-9A-F]{2}/gi).map((channel) => Number.parseInt(channel, 16) / 255);
  const linear = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function contrastRatio(first, second) {
  const luminance = [relativeLuminance(first), relativeLuminance(second)].sort((left, right) => right - left);
  return (luminance[0] + 0.05) / (luminance[1] + 0.05);
}

test('Issue 38 room-card text and focus indicator contrast meet WCAG AA across the full palette', () => {
  for (const color of ROOM_COLOR_PALETTE) {
    assert.ok(contrastRatio('#FFFFFF', color) >= 4.5, `white text must meet 4.5:1 on ${color}`);
    assert.ok(contrastRatio('#F5C542', color) >= 3, `the focus indicator must meet 3:1 on ${color}`);
  }
});
