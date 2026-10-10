import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';
import { DISPLAY_TIME_ZONE, formatDateTime } from '../src/date-time.js';

const appSource = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const dateTimeSource = readFileSync(new URL('../src/date-time.js', import.meta.url), 'utf8');
const ENV = {
  ADMIN_NAME: 'Synthetic Coach',
  ADMIN_PIN: '4826',
  PIN_PEPPER: 'synthetic-pepper',
};
const NOW = new Date('2026-10-10T00:00:00.000Z');

async function withServer(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'run-together-issue-27-'));
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

async function adminSession(baseUrl) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: baseUrl },
    body: JSON.stringify({ name: ENV.ADMIN_NAME, pin: ENV.ADMIN_PIN }),
  });
  const cookie = cookieFrom(response);
  const session = await fetch(`${baseUrl}/api/session`, { headers: { cookie } }).then((result) => result.json());
  return { cookie, csrfToken: session.csrfToken };
}

test('formats admin instants in Bangkok with exact padded second precision', () => {
  assert.equal(DISPLAY_TIME_ZONE, 'Asia/Bangkok');
  assert.equal(formatDateTime('2026-10-10T00:00:00.000Z'), '2026-10-10 07:00:00');
  assert.equal(formatDateTime('2026-10-09T20:05:06.789Z'), '2026-10-10 03:05:06');
  assert.equal(formatDateTime('2026-01-02T03:04:05.999Z'), '2026-01-02 10:04:05');
  assert.doesNotMatch(formatDateTime('2026-10-10T00:00:00.000Z'), /(?:\.\d+|Z|[+-]\d\d:?\d\d)$/);
});

test('returns Unavailable instead of exposing missing or invalid date-time input', () => {
  assert.equal(formatDateTime(undefined), 'Unavailable');
  assert.equal(formatDateTime(null), 'Unavailable');
  assert.equal(formatDateTime(''), 'Unavailable');
  assert.equal(formatDateTime('not-a-date'), 'Unavailable');
});

test('uses one browser-safe Intl formatter with explicit Bangkok options', () => {
  assert.match(dateTimeSource, /new Intl\.DateTimeFormat\('en-US',\s*\{[\s\S]*timeZone:\s*DISPLAY_TIME_ZONE/);
  assert.match(dateTimeSource, /month:\s*'2-digit'/);
  assert.match(dateTimeSource, /day:\s*'2-digit'/);
  assert.match(dateTimeSource, /hour:\s*'2-digit'/);
  assert.match(dateTimeSource, /minute:\s*'2-digit'/);
  assert.match(dateTimeSource, /second:\s*'2-digit'/);
  assert.match(dateTimeSource, /hourCycle:\s*'h23'/);
  assert.match(dateTimeSource, /formatToParts\(/);
  assert.equal((dateTimeSource.match(/export function formatDateTime/g) ?? []).length, 1);
});

test('serves the shared formatter and renders both admin date-time fields semantically', async () => {
  await withServer(async (baseUrl) => {
    const admin = await adminSession(baseUrl);
    const script = await fetch(`${baseUrl}/date-time.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type') ?? '', /javascript/);
    assert.equal(await script.text(), dateTimeSource);

    const page = await fetch(`${baseUrl}/admin`, { headers: { cookie: admin.cookie } });
    assert.equal(page.status, 200);
    const pageBody = await page.text();
    assert.match(pageBody, /Time zone: Asia\/Bangkok/);
    assert.match(pageBody, /import \{ formatDateTime \} from '\/date-time\.js\?v=issue-27'/);
    assert.equal((pageBody.match(/formatDateTime\(user\.createdAt\)/g) ?? []).length, 1);
    assert.equal((pageBody.match(/formatDateTime\(user\.updatedAt\)/g) ?? []).length, 1);
    assert.match(pageBody, /createElement\('dl'\)/);
    assert.match(pageBody, /addText\(created, 'dt', 'Created'\)/);
    assert.match(pageBody, /addText\(updated, 'dt', 'Updated'\)/);
    assert.doesNotMatch(pageBody, /สร้างเมื่อ \/ Created/);
    assert.doesNotMatch(pageBody, /แก้ไขเมื่อ \/ Updated/);

    assert.match(appSource, /\.admin-user-metadata\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap/s);
    assert.match(appSource, /\.admin-user-metadata\s*\{[^}]*gap:\s*[^;}]+[^}]*min-width:\s*0/s);
    assert.match(appSource, /\.admin-user-metadata-item\s*\{[^}]*min-width:\s*0[^}]*overflow-wrap:\s*anywhere/s);
    assert.doesNotMatch(appSource, /admin-user-metadata[^}]*overflow-x\s*:\s*(?:auto|scroll)/s);
  });
});

test('keeps API and database timestamp values unchanged while the page formats only the display', async () => {
  await withServer(async (baseUrl, server) => {
    const admin = await adminSession(baseUrl);
    const stored = server.database.prepare(
      'SELECT id, name AS displayName, role, created_at AS createdAt, updated_at AS updatedAt FROM users ORDER BY id',
    ).all();
    const response = await fetch(`${baseUrl}/api/admin/users`, { headers: { cookie: admin.cookie } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.users, stored);
    assert.equal(stored[0].createdAt, NOW.toISOString());
    assert.equal(stored[0].updatedAt, NOW.toISOString());
    assert.match(appSource, /response\.json\(\{ users: listUsers\(database\) \}\)/);
  });
});
