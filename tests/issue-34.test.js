import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';
import { LEGACY_ROOM_ID } from '../src/room-contract.js';
import { getVoteTimelinePresentation } from '../src/vote-board.js';
import { sortRunEventsForPresentation } from '../src/run-events.js';

const ENV = { ADMIN_NAME: 'Issue 34 Admin', ADMIN_PIN: '4826', PIN_PEPPER: 'synthetic-pepper' };
const NOW = new Date('2026-10-11T16:59:59.000Z');

async function withServer(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'run-together-issue-34-'));
  const databasePath = join(directory, 'test.sqlite');
  const server = createServer({ databasePath, env: ENV, now: () => NOW });
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

test('authenticated timeline returns only authoritative scheduled dates within its exact inclusive range', async () => {
  await withServer(async (baseUrl, server) => {
    const registration = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Range Reader', pin: '0042', pinConfirmation: '0042' }),
    });
    assert.equal(registration.status, 201);
    const admin = server.database.prepare("SELECT id FROM users WHERE role = 'admin'").get();
    const member = server.database.prepare("SELECT id FROM users WHERE role = 'user'").get();
    const insertEvent = server.database.prepare(`
      INSERT INTO run_events (room_id, event_date, status, revision, proposed_by, proposed_at, scheduled_by, scheduled_at)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?)
    `);
    for (const [date, status] of [
      ['2026-10-10', 'scheduled'],
      ['2026-10-11', 'scheduled'],
      ['2026-10-16', 'proposed'],
      ['2026-10-25', 'scheduled'],
      ['2026-10-26', 'scheduled'],
    ]) {
      insertEvent.run(LEGACY_ROOM_ID, date, status, member.id, NOW.toISOString(), status === 'scheduled' ? admin.id : null, status === 'scheduled' ? NOW.toISOString() : null);
    }

    const response = await fetch(`${baseUrl}/api/vote-timeline`, { headers: { cookie: cookieFrom(registration) } });
    assert.equal(response.status, 200);
    const timeline = await response.json();
    assert.equal(timeline.startDate, '2026-10-11');
    assert.equal(timeline.endDate, '2026-10-25');
    assert.deepEqual(timeline.scheduledDates, ['2026-10-11', '2026-10-25']);
    assert.equal(timeline.days.find(({ date }) => date === '2026-10-11').voteCount, 0);
  });
});

test('timeline presentation hides visual zero labels and announces scheduled zero dates accessibly', () => {
  const rows = getVoteTimelinePresentation([
    { date: '2026-10-11', voteCount: 0 },
    { date: '2026-10-12', voteCount: 3 },
  ], { scheduledDates: ['2026-10-11'] });
  assert.equal(rows[0].showCount, false);
  assert.equal(rows[0].isScheduled, true);
  assert.equal(rows[0].barHeightPercent, 0);
  assert.equal(rows[0].isTopRanked, false);
  assert.match(rows[0].accessibleLabel, /0 votes/);
  assert.match(rows[0].accessibleLabel, /scheduled/i);
  assert.equal(rows[1].showCount, true);
  assert.equal(rows[1].isScheduled, false);
  assert.equal(rows[1].barHeightPercent, 100);
  assert.match(rows[1].accessibleLabel, /highest-vote date/);
  const allZero = getVoteTimelinePresentation([
    { date: '2026-10-13', voteCount: 0 },
    { date: '2026-10-14', voteCount: 0 },
  ]);
  assert.deepEqual(allZero.map(({ showCount }) => showCount), [false, false]);
  assert.deepEqual(allZero.map(({ showTopCue }) => showTopCue), [false, false]);
  assert.deepEqual(allZero.map(({ barHeightPercent }) => barHeightPercent), [0, 0]);
});

test('vote page moves a single compact navigation row immediately after the complete card list', async () => {
  const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  const cards = app.indexOf('<ol id="week-days"');
  const navigation = app.indexOf('<nav class="week-navigation actions"');
  const resetControl = app.indexOf('${resetControl}', navigation);
  assert.ok(cards >= 0 && navigation > cards && resetControl > navigation);
  assert.equal((app.match(/class="week-navigation actions"/g) ?? []).length, 1);
  assert.match(app, /id="previous-week"[^>]*aria-label="Previous week"[^>]*>&lt;&lt;<\/button>/);
  assert.match(app, /id="current-week"[^>]*>Now<\/button>/);
  assert.match(app, /id="next-week"[^>]*aria-label="Next week"[^>]*>&gt;&gt;<\/button>/);
});

test('run-event presentation sorts scheduled first and dates ascending within each status without mutating API order', () => {
  const events = [
    { date: '2026-10-12', status: 'proposed', id: 'proposal-early' },
    { date: '2026-10-18', status: 'scheduled', id: 'scheduled-late' },
    { date: '2026-10-15', status: 'proposed', id: 'proposal-late' },
    { date: '2026-10-13', status: 'scheduled', id: 'scheduled-early' },
  ];

  const sorted = sortRunEventsForPresentation(events);

  assert.deepEqual(sorted.map(({ id }) => id), [
    'scheduled-early', 'scheduled-late', 'proposal-early', 'proposal-late',
  ]);
  assert.deepEqual(events.map(({ id }) => id), [
    'proposal-early', 'scheduled-late', 'proposal-late', 'scheduled-early',
  ], 'presentation sorting does not mutate the authoritative input list');
});
