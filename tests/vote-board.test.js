import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { colorForDay, formatDisplayDate } from '../src/vote-board.js';

const appSource = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');

test('formats canonical ISO dates as timezone-safe D Mon labels', () => {
  assert.equal(formatDisplayDate('2024-02-29'), '29 Feb');
  assert.equal(formatDisplayDate('2021-01-01'), '1 Jan');
});

test('rejects impossible calendar dates instead of normalizing them', () => {
  assert.throws(() => formatDisplayDate('2024-02-30'), /invalid ISO date/);
  assert.throws(() => formatDisplayDate('2024-13-01'), /invalid ISO date/);
});

test('assigns deterministic proportional colors with a dark zero state', () => {
  const zeroWeek = colorForDay(0, 0);
  assert.equal(zeroWeek.background, '#0b3d2e');
  assert.equal(zeroWeek.foreground, '#ffffff');

  const populated = [colorForDay(0, 4), colorForDay(2, 4), colorForDay(4, 4)];
  assert.equal(populated[0].background, '#0b3d2e');
  assert.ok(populated[1].brightness > 0 && populated[1].brightness < populated[2].brightness);
  assert.equal(populated[2].brightness, 1);
  assert.equal(populated[2].background, colorForDay(4, 4).background);
  assert.equal(populated[2].foreground, '#ffffff');
});

test('keeps the board one-row, accessible, safe, and read-only', () => {
  assert.match(appSource, /grid-template-columns:\s*repeat\(7,\s*minmax\(0,\s*1fr\)/);
  assert.match(appSource, /aria-pressed/);
  assert.match(appSource, /aria-disabled/);
  assert.match(appSource, /pointerdown/);
  assert.match(appSource, /prefers-reduced-motion/);
  assert.match(appSource, /state\.days\.map/);
  assert.match(appSource, /import \{ colorForDay, formatDisplayDate \} from '\/vote-board\.js\?v=issue-5-1'/);
  assert.equal(appSource.includes('.innerHTML'), false);
  assert.equal(appSource.includes('insertAdjacentHTML'), false);
  assert.equal(appSource.includes("fetch('/api/votes"), false);
  assert.equal(appSource.includes("fetch('/api/vote"), false);
});

test('gives the vote page a wide shell and equal-height compact card layout', () => {
  assert.match(appSource, /mainClass:\s*'vote-page-main'/);
  assert.match(appSource, /\.vote-page-main\s*\{[^}]*max-width:\s*90rem/s);
  assert.match(appSource, /\.vote-day\s*\{[^}]*display:\s*flex/s);
  assert.match(appSource, /\.vote-card\s*\{[^}]*height:\s*100%/s);
  assert.match(appSource, /\.vote-card__weekday--compact/);
  assert.match(appSource, /\.vote-card__date--compact/);
  assert.match(appSource, /\.vote-card__eligibility-icon/);
  assert.match(appSource, /\.vote-board__legend/);
  assert.match(appSource, /\.vote-card__names-empty/);
});

test('keeps narrow card text legible and two-digit counts inside each card', () => {
  assert.match(appSource, /\.vote-card\s*\{[^}]*font-size:\s*clamp\(\.625rem,/s);
  assert.match(appSource, /\.vote-card__weekday--compact\s*\{[^}]*font-size:\s*clamp\(\.6875rem,/s);
  assert.match(appSource, /\.vote-card__date--compact\s*\{[^}]*font-size:\s*clamp\(\.6875rem,/s);
  assert.match(appSource, /\.vote-card__count\s*\{[^}]*font-size:\s*clamp\(1rem,/s);
  assert.match(appSource, /\.vote-card__count\s*\{[^}]*letter-spacing:\s*-\.04em/s);
});
