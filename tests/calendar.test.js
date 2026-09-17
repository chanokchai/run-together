import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CANONICAL_TIME_ZONE,
  addDays,
  getBangkokDate,
  getCurrentWeekMonday,
  getIsoWeek,
  getWeekRange,
  isDateWritable,
  isMonday,
  isWeekNavigable,
  parseIsoDate,
} from '../src/calendar.js';

test('parses strict ISO dates and returns Monday-through-Sunday ranges', () => {
  assert.equal(CANONICAL_TIME_ZONE, 'Asia/Bangkok');
  assert.deepEqual(parseIsoDate('2024-02-29'), { year: 2024, month: 2, day: 29 });
  assert.throws(() => parseIsoDate('2024-2-29'), /ISO date/i);
  assert.throws(() => parseIsoDate('2023-02-29'), /ISO date/i);
  assert.deepEqual(getWeekRange('2024-02-26'), { monday: '2024-02-26', sunday: '2024-03-03' });
});

test('keeps ISO week year with week number including week 53', () => {
  assert.deepEqual(getIsoWeek('2020-12-28'), { weekYear: 2020, week: 53 });
  assert.deepEqual(getIsoWeek('2021-01-04'), { weekYear: 2021, week: 1 });
});

test('uses Bangkok date and Monday across UTC midnight boundaries', () => {
  const justBeforeBangkokMidnight = () => new Date('2026-09-13T16:59:59.999Z');
  const justAfterBangkokMidnight = () => new Date('2026-09-13T17:00:00.000Z');
  assert.equal(getBangkokDate(justBeforeBangkokMidnight), '2026-09-13');
  assert.equal(getBangkokDate(justAfterBangkokMidnight), '2026-09-14');
  assert.equal(getCurrentWeekMonday(justBeforeBangkokMidnight), '2026-09-07');
  assert.equal(getCurrentWeekMonday(() => new Date('2021-01-03T18:00:00.000Z')), '2021-01-04');
});

test('allows the current Bangkok day through midnight and limits future weeks', () => {
  const atBangkokDay = () => new Date('2024-02-29T04:00:00.000Z');
  const atNextBangkokDay = () => new Date('2024-02-29T17:00:00.000Z');
  assert.equal(isDateWritable('2024-02-29', atBangkokDay), true);
  assert.equal(isDateWritable('2024-02-28', atBangkokDay), false);
  assert.equal(isDateWritable('2024-03-17', atBangkokDay), true);
  assert.equal(isDateWritable('2024-03-18', atBangkokDay), false);
  assert.equal(isDateWritable('2024-02-29', atNextBangkokDay), false);
  assert.equal(isWeekNavigable('2024-02-26', atBangkokDay), true);
  assert.equal(isWeekNavigable('2024-03-11', atBangkokDay), true);
  assert.equal(isWeekNavigable('2024-03-18', atBangkokDay), false);
  assert.equal(isWeekNavigable('1900-01-01', atBangkokDay), true);
});

test('adds calendar days without host timezone parsing and identifies only canonical Mondays', () => {
  assert.equal(addDays('2020-12-28', 6), '2021-01-03');
  assert.equal(addDays('2021-01-04', -7), '2020-12-28');
  assert.equal(addDays('2024-02-26', 7), '2024-03-04');
  assert.equal(isMonday('2024-02-26'), true);
  assert.equal(isMonday('2024-02-28'), false);
  assert.equal(isMonday('2024-02-30'), false);
});
