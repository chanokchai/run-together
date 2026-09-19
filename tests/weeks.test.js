import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';
import { addVote } from '../src/domain.js';

const ENV = {
  ADMIN_NAME: 'Synthetic Coach',
  ADMIN_PIN: '4826',
  PIN_PEPPER: 'synthetic-pepper',
};
const NOW = new Date('2024-02-29T04:00:00.000Z');

async function withServer(callback, clock = () => NOW) {
  const directory = await mkdtemp(join(tmpdir(), 'run-together-weeks-'));
  const server = createServer({
    databasePath: join(directory, 'test.sqlite'),
    env: ENV,
    now: clock,
  });
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
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, pin, pinConfirmation: pin }),
  });
}

test('authenticated week API returns bounded seven-day state and safe aggregates', async () => {
  await withServer(async (baseUrl, server) => {
    const runner = await register(baseUrl, 'Runner One');
    const runnerCookie = cookieFrom(runner);
    const alice = await register(baseUrl, '  alice  ');
    const aliceUser = server.database.prepare('SELECT id FROM users WHERE name_key = ?').get('alice');
    const zoe = await register(baseUrl, 'Zoe');
    const zoeUser = server.database.prepare('SELECT id FROM users WHERE name_key = ?').get('zoe');
    const runnerUser = server.database.prepare('SELECT id FROM users WHERE name_key = ?').get('runner one');
    assert.equal(alice.status, 201);
    assert.equal(zoe.status, 201);

    addVote(server.database, { userId: runnerUser.id, voteDate: '2024-02-26' });
    addVote(server.database, { userId: runnerUser.id, voteDate: '2024-02-28' });
    addVote(server.database, { userId: aliceUser.id, voteDate: '2024-02-26' });
    addVote(server.database, { userId: zoeUser.id, voteDate: '2024-02-26' });

    const response = await fetch(`${baseUrl}/api/weeks/2024-02-26`, { headers: { cookie: runnerCookie } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), {
      week: { monday: '2024-02-26', sunday: '2024-03-03', isoWeek: 9, isoWeekYear: 2024 },
      navigation: { previousMonday: '2024-02-19', nextMonday: '2024-03-04' },
      currentUserSelectedDates: ['2024-02-26', '2024-02-28'],
      days: [
        { date: '2024-02-26', eligible: false, voteCount: 3, voterNames: ['alice', 'Runner One', 'Zoe'] },
        { date: '2024-02-27', eligible: false, voteCount: 0, voterNames: [] },
        { date: '2024-02-28', eligible: false, voteCount: 1, voterNames: ['Runner One'] },
        { date: '2024-02-29', eligible: true, voteCount: 0, voterNames: [] },
        { date: '2024-03-01', eligible: true, voteCount: 0, voterNames: [] },
        { date: '2024-03-02', eligible: true, voteCount: 0, voterNames: [] },
        { date: '2024-03-03', eligible: true, voteCount: 0, voterNames: [] },
      ],
    });
  });
});

test('week API authenticates before returning any week data', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/weeks/2024-02-26`);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
      code: 'UNAUTHENTICATED',
      message: 'กรุณาเข้าสู่ระบบ / Please sign in.',
    });
  });
});

test('week API rejects malformed, non-Monday, and too-far requests safely', async () => {
  await withServer(async (baseUrl) => {
    const registration = await register(baseUrl, 'Validation Runner');
    const cookie = cookieFrom(registration);
    const cases = [
      ['2024-2-26', 'INVALID_WEEK_DATE'],
      ['2024-02-30', 'INVALID_WEEK_DATE'],
      ['2024-02-28', 'WEEK_NOT_MONDAY'],
      ['2024-03-18', 'WEEK_TOO_FAR'],
    ];
    for (const [date, code] of cases) {
      const response = await fetch(`${baseUrl}/api/weeks/${date}`, { headers: { cookie } });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.code, code);
      assert.equal(Object.keys(body).sort().join(','), 'code,message');
      assert.equal(JSON.stringify(body).includes(date), false);
    }
  });
});

test('vote page exposes the three-button one-row navigator bound to the injected current week', async () => {
  await withServer(async (baseUrl) => {
    const registration = await register(baseUrl, 'Navigator Runner');
    const response = await fetch(`${baseUrl}/vote`, { headers: { cookie: cookieFrom(registration) } });
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.match(body, /id="protected-content" hidden/);
    const previousIndex = body.indexOf('id="previous-week"');
    const currentIndex = body.indexOf('id="current-week"');
    const nextIndex = body.indexOf('id="next-week"');
    assert.ok(previousIndex >= 0 && previousIndex < currentIndex && currentIndex < nextIndex);
    assert.match(body, />Previous week<\/button>/);
    assert.match(body, />Now<\/button>/);
    assert.match(body, />Next week<\/button>/);
    assert.match(body, /class="week-navigation actions"/);
    assert.match(body, /\.week-navigation\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)/s);
    assert.match(body, /\.week-navigation button\s*\{[^}]*min-width:\s*0/);
    assert.match(body, /const currentWeekMonday = '2024-02-26'/);
    assert.match(body, /currentWeekButton\.addEventListener\('click',\s*\(\) => loadWeek\(currentWeekMonday\)\)/);
    assert.match(body, /currentWeekButton\.disabled\s*=\s*state\.week\.monday === currentWeekMonday/);
    assert.equal(body.includes('new Date('), false);
    assert.match(body, /id="week-heading"/);
    assert.match(body, /id="week-days"/);
    assert.match(body, /\/api\/weeks\//);
    assert.match(body, /\.textContent\s*=/);
    assert.equal(body.includes('.innerHTML'), false);
  });
});

test('week navigation permits unlimited history and exactly two future weeks', async () => {
  await withServer(async (baseUrl) => {
    const registration = await register(baseUrl, 'Boundary Runner');
    const cookie = cookieFrom(registration);
    const weeks = [
      ['2024-02-26', '2024-03-04', 4],
      ['2024-03-04', '2024-03-11', 7],
      ['2024-03-11', null, 7],
      ['1900-01-01', '1900-01-08', 0],
    ];
    for (const [monday, nextMonday, eligibleDays] of weeks) {
      const response = await fetch(`${baseUrl}/api/weeks/${monday}`, { headers: { cookie } });
      assert.equal(response.status, 200);
      const state = await response.json();
      assert.equal(state.navigation.nextMonday, nextMonday);
      assert.equal(state.days.length, 7);
      assert.equal(state.days.filter(({ eligible }) => eligible).length, eligibleDays);
      assert.equal(state.days[0].date, monday);
    }
  });
});

test('week API keeps ISO week-year and seven-day range across New Year week 53', async () => {
  await withServer(async (baseUrl) => {
    const registration = await register(baseUrl, 'New Year Runner');
    const response = await fetch(`${baseUrl}/api/weeks/2020-12-28`, { headers: { cookie: cookieFrom(registration) } });
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.deepEqual(state.week, {
      monday: '2020-12-28',
      sunday: '2021-01-03',
      isoWeek: 53,
      isoWeekYear: 2020,
    });
    assert.deepEqual(state.days.map(({ date }) => date), [
      '2020-12-28', '2020-12-29', '2020-12-30', '2020-12-31',
      '2021-01-01', '2021-01-02', '2021-01-03',
    ]);
  }, () => new Date('2020-12-31T04:00:00.000Z'));
});
