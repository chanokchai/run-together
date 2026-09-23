import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  colorForDay,
  formatDisplayDate,
  marqueeDurationForDistance,
  VOTER_MARQUEE_PIXELS_PER_SECOND,
  createSocketRepairController,
  patchVoteDay,
} from '../src/vote-board.js';

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
  assert.match(appSource, /import \{ colorForDay, createSocketRepairController, formatDisplayDate, marqueeDurationForDistance, patchVoteDay \} from '\/vote-board\.js\?v=issue-6-1'/);
  assert.match(appSource, /aria-busy/);
  assert.match(appSource, /fetch\('\/api\/votes\//);
  assert.equal(appSource.includes('.innerHTML'), false);
  assert.equal(appSource.includes('insertAdjacentHTML'), false);
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
  assert.match(appSource, /\.vote-card\s*\{[^}]*font-size:\s*1rem/s);
  assert.match(appSource, /\.vote-card__weekday--compact\s*\{[^}]*font-size:\s*1rem/s);
  assert.match(appSource, /\.vote-card__date--compact\s*\{[^}]*font-size:\s*1rem/s);
  assert.match(appSource, /\.vote-card__count\s*\{[^}]*font-size:\s*2rem/s);
  assert.match(appSource, /\.vote-card__count\s*\{[^}]*letter-spacing:\s*-\.08em/s);
});

test('hides the decorative marquee copy and separator for reduced motion', () => {
  assert.match(appSource, /vote-card__names-copy--canonical/);
  assert.match(appSource, /vote-card__names-copy--duplicate/);
  assert.match(appSource, /vote-card__names-separator/);
  assert.match(appSource, /names-copy--duplicate[\s\S]*setAttribute\('aria-hidden', 'true'\)/);
  assert.match(appSource, /names-separator[\s\S]*setAttribute\('aria-hidden', 'true'\)/);
  assert.match(appSource, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.vote-card__names-copy--duplicate, \.vote-card__names-separator \{ display: none; \}/);
});

test('stacks full-width day rows only on narrow screens while preserving the desktop seven-column grid', () => {
  assert.match(appSource, /\.vote-board\s*\{[^}]*grid-template-columns:\s*repeat\(7,\s*minmax\(0,\s*1fr\)/s);
  assert.match(appSource, /@media \(max-width: 44rem\)[\s\S]*\.vote-board\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
  assert.match(appSource, /@media \(max-width: 44rem\)[\s\S]*\.vote-day\s*\{[^}]*width:\s*100%/s);
  assert.match(appSource, /@media \(max-width: 44rem\)[\s\S]*\.vote-card\s*\{[^}]*font-size:\s*1rem/s);
});

test('keeps vote-page buttons English-only while login and registration remain bilingual', () => {
  const protectedContent = appSource.slice(
    appSource.indexOf('content: `<section id="protected-content"'),
    appSource.indexOf('script: `import { colorForDay', appSource.indexOf('content: `<section id="protected-content"')),
  );
  assert.doesNotMatch(protectedContent, /<button[^>]*>[^<]*[ก-๙]/s);
  assert.doesNotMatch(appSource.slice(appSource.indexOf('card.setAttribute(\'aria-label\''), appSource.indexOf('const header =', appSource.indexOf('card.setAttribute(\'aria-label\''))), /weekday\.thai/);
  assert.match(appSource, /<button>เข้าสู่ระบบ \/ Sign in<\/button>/);
  assert.match(appSource, /<button>สมัครและเข้าสู่ระบบ \/ Register and sign in<\/button>/);
});

test('derives marquee duration from loop distance at a calibrated fixed speed', () => {
  assert.equal(VOTER_MARQUEE_PIXELS_PER_SECOND, 7.1875);
  assert.equal(marqueeDurationForDistance(172.5), 24);
  assert.ok(marqueeDurationForDistance(517.5) > marqueeDurationForDistance(172.5));
  assert.match(appSource, /animation:\s*voter-name-loop\s*var\(--vote-marquee-duration,\s*0s\)/);
  assert.match(appSource, /marqueeDurationForDistance\(track\.scrollWidth\s*\/\s*2\)/);
  assert.match(appSource, /setProperty\('--vote-marquee-duration'/);
  assert.match(appSource, /weekDays\.replaceChildren\(\.\.\.rows\);[\s\S]*weekDays\.querySelectorAll\('\.vote-card__names-track'\)/);
});

class FakeClassList {
  constructor(value = '') { this.values = new Set(value.split(/\s+/).filter(Boolean)); }
  toggle(name, force) {
    const shouldHave = force === undefined ? !this.values.has(name) : force;
    if (shouldHave) this.values.add(name); else this.values.delete(name);
    return shouldHave;
  }
  contains(name) { return this.values.has(name); }
}

class FakeStyle {
  constructor() { this.values = new Map(); }
  setProperty(name, value) { this.values.set(name, value); }
  getPropertyValue(name) { return this.values.get(name) ?? ''; }
}

class FakeRegion {
  constructor() { this.track = { querySelector: () => null, style: new FakeStyle() }; }
  querySelector(selector) { return selector === '.vote-card__names-track' ? this.track : null; }
}

class FakeCard {
  constructor(date, count, selected = false) {
    this.dataset = { date, selected: String(selected) };
    this.classList = new FakeClassList(selected ? 'vote-card is-selected' : 'vote-card');
    this.attributes = new Map([[
      'aria-label', `Mon, 1 Mar, ${count} votes, Eligible, ${selected ? 'Selected' : 'Not selected'}`,
    ]]);
    this.parts = {
      '.vote-card__count': { textContent: String(count) },
      '.vote-card__state-icon': { textContent: selected ? '✓' : '○' },
      '.vote-card__state': { textContent: selected ? '✓ Selected' : 'Not selected' },
      '.vote-card__names': { replaceWith: (replacement) => { this.parts['.vote-card__names'] = replacement; } },
    };
    this.style = new FakeStyle();
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  querySelector(selector) {
    if (selector === '.vote-card__names-track') return this.parts['.vote-card__names'].querySelector(selector);
    return this.parts[selector] ?? null;
  }
}

class FakeBoard {
  constructor(cards) { this.cards = cards; }
  querySelector(selector) {
    const match = /^\.vote-card\[data-date="(.+)"\]$/.exec(selector);
    return match ? this.cards.find((card) => card.dataset.date === match[1]) ?? null : null;
  }
  querySelectorAll(selector) { return selector === '.vote-card' ? this.cards : []; }
}

test('patchVoteDay updates only the affected DOM card and recalculates weekly colors', () => {
  const first = new FakeCard('2024-03-01', 1, true);
  const second = new FakeCard('2024-03-02', 4, false);
  const board = new FakeBoard([first, second]);
  const originalCards = board.cards;
  const replacement = new FakeRegion();
  const patched = patchVoteDay({
    weekDays: board,
    patch: { date: '2024-03-01', voteCount: 5, voterNames: ['A', 'B'], selected: false },
    createVoterNamesRegion: () => replacement,
  });
  assert.equal(patched, true);
  assert.strictEqual(board.cards, originalCards);
  assert.equal(first.parts['.vote-card__count'].textContent, '5');
  assert.equal(first.parts['.vote-card__names'], replacement);
  assert.equal(first.dataset.selected, 'false');
  assert.equal(first.classList.contains('is-selected'), false);
  assert.equal(first.getAttribute('aria-pressed'), 'false');
  assert.match(first.getAttribute('aria-label'), /, 5 votes,/);
  assert.match(first.getAttribute('aria-label'), /, Not selected$/);
  assert.notEqual(first.style.getPropertyValue('--day-bg'), second.style.getPropertyValue('--day-bg'));
});

test('socket reconnect controller fetches authoritative state before applying queued patches', async () => {
  let resolveFetch;
  let fetched = false;
  const applied = [];
  const controller = createSocketRepairController({
    loadWeek: () => new Promise((resolve) => { resolveFetch = () => { fetched = true; resolve(); }; }),
    patchDay: (patch) => applied.push({ patch, fetched }),
  });
  const reconnect = controller.handleConnect();
  controller.handlePatch({ date: '2024-03-01', voteCount: 2 });
  assert.deepEqual(applied, []);
  resolveFetch();
  await reconnect;
  assert.deepEqual(applied, [{ patch: { date: '2024-03-01', voteCount: 2 }, fetched: true }]);
});
