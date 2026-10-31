import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createVoteTimelineController, getVoteTimelinePresentation } from '../src/vote-board.js';

const appSource = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');

function relativeLuminance(hexColor) {
  const channels = hexColor.slice(1).match(/.{2}/g).map((channel) => Number.parseInt(channel, 16) / 255);
  const linear = channels.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
}

function contrastRatio(first, second) {
  const values = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test('vote timeline highlights every positive maximum with an accessible name and equal scale', () => {
  const rows = getVoteTimelinePresentation([
    { date: '2026-10-11', voteCount: 2 },
    { date: '2026-10-12', voteCount: 4 },
    { date: '2026-10-13', voteCount: 1 },
    { date: '2026-10-14', voteCount: 4 },
  ]);
  assert.deepEqual(rows.map(({ isTopRanked }) => isTopRanked), [false, true, false, true]);
  assert.equal(rows[1].barHeightPercent, 100);
  assert.equal(rows[3].barHeightPercent, 100);
  assert.match(rows[1].accessibleLabel, /12 Oct, 4 votes, highest-vote date/);
  assert.match(rows[3].accessibleLabel, /14 Oct, 4 votes, highest-vote date/);
  assert.equal(rows[0].showTopCue, false);
});

test('vote timeline has no top-ranked state when every total is zero', () => {
  const rows = getVoteTimelinePresentation([
    { date: '2026-10-11', voteCount: 0 },
    { date: '2026-10-12', voteCount: 0 },
  ]);
  assert.deepEqual(rows.map(({ isTopRanked }) => isTopRanked), [false, false]);
  assert.deepEqual(rows.map(({ showTopCue }) => showTopCue), [false, false]);
  assert.deepEqual(rows.map(({ barHeightPercent }) => barHeightPercent), [0, 0]);
});

test('vote timeline text and bar colors meet WCAG AA contrast thresholds', () => {
  assert.ok(contrastRatio('#14213d', '#ffffff') >= 4.5);
  assert.ok(contrastRatio('#334155', '#ffffff') >= 4.5);
  assert.ok(contrastRatio('#0b3d2e', '#ffffff') >= 3);
  assert.ok(contrastRatio('#6b21a8', '#ffffff') >= 3);
  assert.ok(contrastRatio('#ffffff', '#6b21a8') >= 4.5);
});

test('vote timeline controller patches only included dates and recalculates ties after vote removal', async () => {
  const renders = [];
  const controller = createVoteTimelineController({ render: (rows) => renders.push(rows) });
  await controller.refresh(async () => ({
    startDate: '2026-10-11',
    endDate: '2026-10-12',
    days: [{ date: '2026-10-11', voteCount: 2 }, { date: '2026-10-12', voteCount: 1 }],
  }));
  assert.equal(controller.patch({ date: '2026-10-12', voteCount: 2 }), true);
  assert.deepEqual(renders.at(-1).map(({ isTopRanked }) => isTopRanked), [true, true]);
  assert.equal(controller.patch({ date: '2026-10-12', voteCount: 0 }), true);
  assert.deepEqual(renders.at(-1).map(({ isTopRanked }) => isTopRanked), [true, false]);
  assert.equal(controller.patch({ date: '2026-10-13', voteCount: 99 }), false);
  assert.deepEqual(renders.at(-1).map(({ voteCount }) => voteCount), [2, 0]);
});

test('vote timeline merges a newer vote patch into totals returned by an in-flight reload', async () => {
  const rendered = [];
  const controller = createVoteTimelineController({ render: (rows) => rendered.push(rows) });
  await controller.refresh(async () => ({
    startDate: '2026-10-11', endDate: '2026-10-11', days: [{ date: '2026-10-11', voteCount: 1 }],
  }));

  let resolveReload;
  const reload = controller.refresh(() => new Promise((resolve) => { resolveReload = resolve; }));
  controller.patch({ date: '2026-10-11', voteCount: 2 });
  resolveReload({
    startDate: '2026-10-11',
    endDate: '2026-10-12',
    days: [{ date: '2026-10-11', voteCount: 1 }, { date: '2026-10-12', voteCount: 3 }],
  });
  assert.equal(await reload, true);
  assert.deepEqual(rendered.at(-1).map(({ voteCount }) => voteCount), [2, 3]);
});

test('vote timeline replaces an already-patched total after an authoritative week-reset reload', async () => {
  const rendered = [];
  const controller = createVoteTimelineController({ render: (rows) => rendered.push(rows) });
  await controller.refresh(async () => ({
    startDate: '2026-10-11', endDate: '2026-10-11', days: [{ date: '2026-10-11', voteCount: 1 }],
  }));
  controller.patch({ date: '2026-10-11', voteCount: 2 });
  await controller.refresh(async () => ({
    startDate: '2026-10-11', endDate: '2026-10-11', days: [{ date: '2026-10-11', voteCount: 0 }],
  }));
  assert.equal(rendered.at(-1)[0].voteCount, 0);
});

test('vote page places a semantic compact timeline under its title and refreshes it on live events', () => {
  const pageStart = appSource.indexOf('content: `<section id="protected-content"');
  const pageEnd = appSource.indexOf('script: `import {', pageStart);
  const pageMarkup = appSource.slice(pageStart, pageEnd);
  const title = pageMarkup.indexOf('id="room-heading"');
  const timeline = pageMarkup.indexOf('<section id="vote-timeline"');
  const identity = pageMarkup.indexOf('id="vote-page-identity"');
  assert.ok(title >= 0 && timeline > title && identity > timeline);
  assert.match(pageMarkup, /id="week-heading"/);
  assert.doesNotMatch(pageMarkup, /id="week-range"|\bWelcome\b/);
  assert.match(pageMarkup, /id="vote-timeline-heading"/);
  assert.match(pageMarkup, /id="vote-timeline-days"/);
  const timelineStyle = appSource.match(/\.vote-timeline\s*\{([^}]*)\}/)?.[1] ?? '';
  const dayGridStyle = appSource.match(/\.vote-timeline__days\s*\{([^}]*)\}/)?.[1] ?? '';
  const dayStyle = appSource.match(/\.vote-timeline__day\s*\{([^}]*)\}/)?.[1] ?? '';
  const dateStyle = appSource.match(/\.vote-timeline__date\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(appSource, /row\.monthLabel/);
  assert.match(appSource, /\.vote-timeline__month/);
  assert.match(timelineStyle, /max-height:\s*180px/);
  assert.match(dayGridStyle, /width:\s*100%/);
  assert.match(dayStyle, /min-width:\s*0/);
  assert.match(dateStyle, /overflow:\s*hidden/);
  assert.match(appSource, /fetch\(roomApiPath\('\/api\/vote-timeline', '\/vote-timeline'\),\s*\{ cache: 'no-store' \}\)/);
  assert.match(appSource, /timelineController\.patch\(result\)/);
  assert.match(appSource, /socket\.on\('vote:changed',[\s\S]*?timelineController\.patch/);
  assert.match(appSource, /socket\.on\('week:reset',[\s\S]*?loadTimeline\(\)/);
  assert.match(appSource, /socket\.on\('connect',[\s\S]*?loadTimeline\(\)/);
  const resetStart = appSource.indexOf('async function resetSelectedWeek()');
  const resetEnd = appSource.indexOf('async function loadWeek(', resetStart);
  assert.match(appSource.slice(resetStart, resetEnd), /await loadWeek\(monday\);\s*await loadTimeline\(\)/);
  assert.equal(appSource.includes('.innerHTML'), false);
  assert.equal(appSource.includes('insertAdjacentHTML'), false);
});
