import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  colorForDay,
  configureVoterNamesMarquee,
  createVoterNamesRegion,
  formatDisplayDate,
  marqueeDurationForDistance,
  marqueeDurationForDimensions,
  marqueeTravelDistance,
  VOTER_MARQUEE_PIXELS_PER_SECOND,
  createSocketRepairController,
  getVoteCardPresentation,
  patchVoteDay,
  applyVoteCardPresentation,
} from '../src/vote-board.js';

const appSource = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const voteBoardSource = readFileSync(new URL('../src/vote-board.js', import.meta.url), 'utf8');

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
  assert.match(voteBoardSource, /aria-pressed/);
  assert.match(voteBoardSource, /aria-disabled/);
  assert.match(appSource, /pointerdown/);
  assert.match(appSource, /prefers-reduced-motion/);
  assert.match(appSource, /state\.days\.map/);
  assert.match(appSource, /import \{ applyVoteCardPresentation, colorForDay, configureVoterNamesMarquee, createSocketRepairController, createVoterNamesRegion as buildVoterNamesRegion, formatDisplayDate, patchVoteDay \} from '\/vote-board\.js\?v=issue-6-4'/);
  assert.match(appSource, /aria-busy/);
  assert.match(appSource, /fetch\('\/api\/votes\//);
  assert.equal(appSource.includes('.innerHTML'), false);
  assert.equal(appSource.includes('insertAdjacentHTML'), false);
});

test('gives the vote page a wide shell and equal-height responsive card layout', () => {
  assert.match(appSource, /mainClass:\s*'vote-page-main'/);
  assert.match(appSource, /\.vote-page-main\s*\{[^}]*max-width:\s*90rem/s);
  assert.match(appSource, /\.vote-day\s*\{[^}]*display:\s*flex/s);
  assert.match(appSource, /\.vote-card\s*\{[^}]*height:\s*100%/s);
  assert.match(appSource, /\.vote-card__weekday--compact/);
  assert.match(appSource, /\.vote-card__date--compact/);
  assert.match(appSource, /\.vote-card__names-empty/);
});

test('keeps narrow card text legible and seven touch cards within a 375px viewport', () => {
  assert.match(appSource, /\.vote-card\s*\{[^}]*font-size:\s*1rem/s);
  const mobileCardRule = appSource.match(/@media \(max-width: 44rem\)[\s\S]*?\.vote-card\s*\{([^}]*)\}/)?.[1] ?? '';
  const cardHeightRem = Number.parseFloat(mobileCardRule.match(/min-height:\s*([\d.]+)rem/)?.[1]);
  const gapRem = Number.parseFloat(appSource.match(/\.vote-board\s*\{[^}]*gap:\s*([\d.]+)rem/s)?.[1]);
  assert.ok(Number.isFinite(cardHeightRem));
  assert.ok(Number.isFinite(gapRem));
  const cardHeight = cardHeightRem * 16;
  const gap = gapRem * 16;
  assert.ok(cardHeight >= 44, 'mobile cards remain usable touch targets');
  assert.ok((cardHeight * 7) + (gap * 6) <= 667, 'seven cards fit a normal 375px portrait viewport');
  assert.match(appSource, /\.vote-card__weekday--compact\s*\{[^}]*font-size:\s*1\.25rem/s);
  assert.match(appSource, /\.vote-card__weekday--full\s*\{[^}]*font-size:\s*1\.35rem/s);
  assert.match(appSource, /\.vote-card__date--compact\s*\{[^}]*font-size:\s*1rem/s);
  assert.match(appSource, /\.vote-card__count--selected/);

  const horizontalBreakpoint = appSource.match(/@media \(max-width: 44rem\)([\s\S]*?)(?=@media|$)/)?.[1] ?? '';
  assert.match(horizontalBreakpoint, /\.vote-card__weekday--compact\s*\{[^}]*font-size:\s*1\.25rem/s);
});

test('uses accessible semantic state while removing visible status icons and wording', () => {
  assert.doesNotMatch(appSource, /vote-card__state-icon/);
  assert.doesNotMatch(appSource, /vote-card__state-detail/);
  assert.doesNotMatch(appSource, /vote-card__eligibility-icon/);
  assert.doesNotMatch(appSource, /vote-card__eligibility-detail/);
  assert.doesNotMatch(appSource, /vote-board__legend/);
  const selected = getVoteCardPresentation({ selected: true, eligible: true });
  assert.equal(selected.ariaPressed, 'true');
  assert.equal(selected.ariaDisabled, 'false');
  assert.equal(selected.disabled, false);
  assert.equal(selected.visibleStatusText, '');
  assert.match(selected.countClassName, /vote-card__count--selected/);
  const readOnly = getVoteCardPresentation({ selected: false, eligible: false });
  assert.equal(readOnly.ariaPressed, 'false');
  assert.equal(readOnly.ariaDisabled, 'true');
  assert.equal(readOnly.disabled, true);
  assert.match(readOnly.cardClassName, /is-read-only/);
  assert.match(readOnly.accessibleState, /Read-only/);
});

test('uses one canonical voter-name copy and no decorative separator or duplicate', () => {
  assert.match(appSource, /vote-card__names-copy--canonical/);
  assert.doesNotMatch(appSource, /vote-card__names-copy--duplicate/);
  assert.doesNotMatch(appSource, /vote-card__names-separator/);
  assert.match(appSource, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.vote-card__names-track \{ animation: none/s);
});

test('stacks full-width day rows only on narrow screens while preserving the desktop seven-column grid', () => {
  assert.match(appSource, /\.vote-board\s*\{[^}]*grid-template-columns:\s*repeat\(7,\s*minmax\(0,\s*1fr\)/s);
  assert.match(appSource, /@media \(max-width: 44rem\)[\s\S]*\.vote-board\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
  assert.match(appSource, /@media \(max-width: 44rem\)[\s\S]*\.vote-day\s*\{[^}]*width:\s*100%/s);
  assert.match(appSource, /@media \(max-width: 44rem\)[\s\S]*\.vote-card\s*\{[^}]*font-size:\s*1rem/s);
});

test('keeps vote-page buttons English-only while login and registration remain bilingual', () => {
  const protectedContentStart = appSource.indexOf('content: `<section id="protected-content"');
  const protectedContentEnd = appSource.indexOf('script: `import { colorForDay', protectedContentStart);
  const protectedContent = appSource.slice(protectedContentStart, protectedContentEnd);

  assert.doesNotMatch(protectedContent, /<button[^>]*>[^<]*[ก-๙]/s);
  const cardRenderingStart = appSource.indexOf("card.setAttribute('aria-label'");
  const cardRenderingEnd = appSource.indexOf('const header =', cardRenderingStart);
  assert.doesNotMatch(appSource.slice(cardRenderingStart, cardRenderingEnd), /weekday\.thai/);
  assert.match(appSource, /<button>เข้าสู่ระบบ \/ Sign in<\/button>/);
  assert.match(appSource, /<button>สมัครและเข้าสู่ระบบ \/ Register and sign in<\/button>/);
});

test('derives single-pass marquee geometry and duration at a calibrated fixed speed', () => {
  assert.equal(VOTER_MARQUEE_PIXELS_PER_SECOND, 7.1875);
  assert.equal(marqueeDurationForDistance(172.5), 24);
  assert.equal(marqueeTravelDistance(100, 72.5), 172.5);
  assert.equal(marqueeDurationForDimensions(100, 72.5), 24);
  assert.match(appSource, /animation:\s*voter-name-loop\s*var\(--vote-marquee-duration,\s*0s\)/);
  assert.match(voteBoardSource, /setProperty\('--vote-marquee-start'/);
  assert.match(voteBoardSource, /setProperty\('--vote-marquee-end'/);
  assert.match(voteBoardSource, /marqueeDurationForDimensions\(containerWidth, textWidth\)/);
  assert.match(appSource, /weekDays\.replaceChildren\(\.\.\.rows\);[\s\S]*configureVoterNamesMarquee\(weekDays\)/);
});

const Node = typeof window !== 'undefined' ? window.Node : {
  ELEMENT_NODE: 1,
  ATTRIBUTE_NODE: 2,
  TEXT_NODE: 3,
  CDATA_SECTION_NODE: 4,
  ENTITY_REFERENCE_NODE: 5,
  ENTITY_NODE: 6,
  PROCESSING_INSTRUCTION_NODE: 7,
  COMMENT_NODE: 8,
  DOCUMENT_NODE: 9,
  DOCUMENT_TYPE_NODE: 10,
  DOCUMENT_FRAGMENT_NODE: 11,
  NOTATION_NODE: 12,
};

class FakeClassList {
  constructor(value = '') { this.values = new Set(value.split(/\s+/).filter(Boolean)); }
  toggle(name, force) {
    const shouldHave = force === undefined ? !this.values.has(name) : force;
    if (shouldHave) this.values.add(name); else this.values.delete(name);
    return shouldHave;
  }
  contains(name) { return this.values.has(name); }
  add(name) { this.values.add(name); }
  remove(name) { this.values.delete(name); }
}

class FakeStyle {
  constructor() { this.values = new Map(); }
  setProperty(name, value) { this.values.set(name, value); }
  getPropertyValue(name) { return this.values.get(name) ?? ''; }
}

class FakeNode {
  constructor(nodeType, tagName = '', textContent = '') {
    this.nodeType = nodeType;
    this.tagName = tagName.toUpperCase();
    this._textContent = textContent;
    this.children = [];
    this.attributes = new Map();
    this.classList = new FakeClassList();
    this.style = new FakeStyle();
    this.dataset = {};
    this.parentNode = null;
  }

  get textContent() {
    if (this.nodeType === Node.TEXT_NODE) {
      return this._textContent;
    }
    return this.children.map(child => child.textContent).join('');
  }

  set textContent(value) {
    if (this.nodeType === Node.TEXT_NODE) {
      this._textContent = value;
    }
    else if (this.nodeType === Node.ELEMENT_NODE) {
      this.children.forEach(child => child.parentNode = null);
      this.children = [];
      const newTextNode = new FakeTextNode(value);
      this.append(newTextNode);
    }
  }

  append(...nodes) {
    nodes.forEach(node => {
      this.children.push(node);
      node.parentNode = this;
    });
  }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }

  querySelectorAll(selector) {
    const matches = [];
    const selectorWithoutDot = selector.startsWith('.') ? selector.slice(1) : selector;

    if (this.nodeType === Node.ELEMENT_NODE) {
      if (selector.startsWith('.') && this.classList.contains(selectorWithoutDot)) {
        matches.push(this);
      } else if (this.tagName === selector.toUpperCase()) {
        matches.push(this);
      }
    }

    this.children.forEach(child => {
      matches.push(...child.querySelectorAll(selector));
    });
    return matches;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  replaceWith(newElement) {
    if (this.parentNode) {
      const index = this.parentNode.children.indexOf(this);
      if (index !== -1) {
        this.parentNode.children.splice(index, 1, newElement);
        newElement.parentNode = this.parentNode;
        this.parentNode = null;
      }
    }
  }
}

class FakeTextNode extends FakeNode {
  constructor(textContent = '') {
    super(Node.TEXT_NODE, '', textContent);
  }
}

class FakeElement extends FakeNode {
  constructor(tagName) {
    super(Node.ELEMENT_NODE, tagName);
    this.clientWidth = 0; // Public property
    this.scrollWidth = 0; // Public property
  }

  get className() {
    return [...this.classList.values].join(' ');
  }

  set className(value) {
    this.classList = new FakeClassList(value);
  }
}

class FakeDocument extends FakeNode {
  constructor() {
    super(Node.DOCUMENT_NODE, '#document');
  }
  createElement(tagName) { return new FakeElement(tagName); }
  createTextNode(text) { return new FakeTextNode(text); }
}

class FakeRegion extends FakeElement {
  constructor() {
    super('div');
    this.setAttribute('data-has-voters', 'true');
    this.clientWidth = 100;
  }
}

class FakeCard extends FakeElement {
  constructor(date, count, selected = false, initialClassList = 'vote-card') {
    super('button');
    this.dataset = { date, selected: String(selected) };
    this.classList = new FakeClassList(initialClassList + (selected ? ' is-selected' : ''));
    this.setAttribute('aria-label', `MON, 1 Mar, ${count} votes, Available to vote`);

    this.parts = {
      countElement: new FakeElement('span'),
      namesRegion: new FakeRegion(),
    };

    this.parts.countElement.textContent = String(count);
    this.parts.countElement.classList.add('vote-card__count');
    if (selected) {
      this.parts.countElement.classList.add('vote-card__count--selected');
    }
    this.parts.namesRegion.classList.add('vote-card__names');

    this.append(this.parts.countElement);
    this.append(this.parts.namesRegion);
  }

  querySelector(selector) {
    if (selector === '.vote-card__count') return this.parts.countElement;
    if (selector === '.vote-card__names') return this.parts.namesRegion;
    return super.querySelector(selector);
  }

  querySelectorAll(selector) {
    return super.querySelectorAll(selector);
  }
}

class FakeBoard extends FakeNode {
  constructor(cards) {
    super(Node.ELEMENT_NODE, 'OL');
    this.cards = cards;
    this.children.push(...cards);
  }
  querySelector(selector) {
    const match = /^\.vote-card\[data-date="(.+)"\]$/.exec(selector);
    if (match) {
      return this.cards.find((card) => card.dataset.date === match[1]) ?? null;
    }
    return super.querySelector(selector);
  }
  querySelectorAll(selector) {
    if (selector === '.vote-card') {
      return this.cards;
    }
    return super.querySelectorAll(selector);
  }
}

test('renders one exact canonical DOM copy for one or many real voter names', () => {
  const one = createVoterNamesRegion(new FakeDocument(), ['bank3']);
  assert.equal(one.textContent, 'bank3');
  assert.equal(one.querySelectorAll('.vote-card__names-copy--canonical').length, 1);
  assert.equal(one.querySelectorAll('.vote-card__names-copy--duplicate').length, 0);
  assert.equal(one.querySelectorAll('.vote-card__names-separator').length, 0);

  const many = createVoterNamesRegion(new FakeDocument(), ['bank3', 'runner4']);
  assert.equal(many.textContent, 'bank3, runner4');
  assert.equal(many.querySelectorAll('.vote-card__names-copy--canonical').length, 1);
  assert.equal(many.querySelectorAll('.vote-card__names-copy--duplicate').length, 0);
  assert.equal(many.querySelectorAll('.vote-card__names-separator').length, 0);
});

test('configures a single pass from the right edge fully past the left edge', () => {
  const region = createVoterNamesRegion(new FakeDocument(), ['bank3']);
  const track = region.querySelector('.vote-card__names-track');
  region.clientWidth = 100;
  track.scrollWidth = 200;
  configureVoterNamesMarquee(region, { reducedMotion: false });
  const start = Number.parseFloat(track.style.getPropertyValue('--vote-marquee-start'));
  const end = Number.parseFloat(track.style.getPropertyValue('--vote-marquee-end'));
  assert.equal(start, 100);
  assert.equal(end, -200);
  assert.equal(start - end, marqueeTravelDistance(region.clientWidth, track.scrollWidth));
  assert.equal(track.style.getPropertyValue('--vote-marquee-duration'), `${marqueeDurationForDimensions(region.clientWidth, track.scrollWidth)}s`);
});

test('reduced motion keeps one canonical voter copy static', () => {
  const region = createVoterNamesRegion(new FakeDocument(), ['bank3']);
  const trackElement = region.querySelector('.vote-card__names-track');

  configureVoterNamesMarquee(region, { reducedMotion: true });
  assert.equal(trackElement.style.getPropertyValue('animation'), 'none');
  assert.equal(region.textContent, 'bank3');
  assert.equal(region.querySelectorAll('.vote-card__names-copy--canonical').length, 1);
  assert.equal(region.querySelectorAll('.vote-card__names-copy--duplicate').length, 0);
});

test('patchVoteDay updates only the affected DOM card and recalculates weekly colors', () => {
  const first = new FakeCard('2024-03-01', 1, true);
  const second = new FakeCard('2024-03-02', 4, false);
  const board = new FakeBoard([first, second]);
  const originalCards = board.cards;

  const replacement = createVoterNamesRegion(new FakeDocument(), ['A', 'B']);
  replacement.clientWidth = 100;
  replacement.querySelector('.vote-card__names-track').scrollWidth = 72.5;

  let configuredRegion;
  const patched = patchVoteDay({
    weekDays: board,
    patch: { date: '2024-03-01', voteCount: 5, voterNames: ['A', 'B'], selected: false },
    createVoterNamesRegion: () => replacement,
    configureVoterNamesMarquee: (region) => {
      configuredRegion = region;
      configureVoterNamesMarquee(region, { reducedMotion: false });
    },
  });
  assert.equal(patched, true);
  assert.strictEqual(board.cards, originalCards);
  assert.equal(first.querySelector('.vote-card__count').textContent, '5');
  assert.strictEqual(configuredRegion, replacement);
  const patchedStart = Number.parseFloat(replacement.querySelector('.vote-card__names-track').style.getPropertyValue('--vote-marquee-start'));
  const patchedEnd = Number.parseFloat(replacement.querySelector('.vote-card__names-track').style.getPropertyValue('--vote-marquee-end'));
  assert.equal(patchedStart, 100);
  assert.equal(patchedEnd, -72.5);
  assert.equal(patchedStart - patchedEnd, marqueeTravelDistance(100, 72.5));
  assert.equal(replacement.querySelector('.vote-card__names-track').style.getPropertyValue('--vote-marquee-duration'), `${marqueeDurationForDimensions(100, 72.5)}s`);
  assert.equal(first.dataset.selected, 'false');
  assert.doesNotMatch(first.className, /is-selected/);
  assert.equal(first.getAttribute('aria-pressed'), 'false');
  assert.match(first.getAttribute('aria-label'), /, 5 votes,/);
  assert.match(first.getAttribute('aria-label'), /, Available to vote$/);
  assert.notEqual(first.style.getPropertyValue('--day-bg'), second.style.getPropertyValue('--day-bg'));
});

test('applyVoteCardPresentation preserves touch pause across selected live patches', () => {
  for (const selected of [true, false]) {
    const card = new FakeCard('2024-03-01', 1, !selected, 'is-touch-paused');

    applyVoteCardPresentation(card, { selected, eligible: true, voteCount: 2 });

    assert.equal(card.classList.contains('is-touch-paused'), true);
    assert.equal(card.classList.contains('vote-card'), true);
    assert.equal(card.classList.contains('is-selected'), selected);
    assert.equal(card.dataset.selected, String(selected));
  }
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
