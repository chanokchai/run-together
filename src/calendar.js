export const CANONICAL_TIME_ZONE = 'Asia/Bangkok';
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

export function parseIsoDate(value) {
  if (typeof value !== 'string') throw new TypeError('ISO date must be a string');
  const match = ISO_DATE.exec(value);
  if (!match) throw new RangeError('invalid ISO date');
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new RangeError('invalid ISO date');
  }
  return { year, month, day };
}

export function formatIsoDate({ year, month, day }) {
  const candidate = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  parseIsoDate(candidate);
  return candidate;
}

export function getBangkokDate(clock = () => new Date()) {
  const instant = getInstant(clock);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: CANONICAL_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const values = Object.fromEntries(parts.filter(({ type }) => type !== 'literal').map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function getCurrentWeekMonday(clock = () => new Date()) {
  return getWeekMonday(getBangkokDate(clock));
}

export function getWeekMonday(date) {
  const parsed = parseIsoDate(date);
  const epochDay = toEpochDay(parsed);
  const weekday = new Date(epochDay * DAY_MS).getUTCDay();
  const offset = weekday === 0 ? 6 : weekday - 1;
  return fromEpochDay(epochDay - offset);
}

export function getWeekRange(mondayDate) {
  const monday = getWeekMonday(mondayDate);
  const sunday = fromEpochDay(toEpochDay(parseIsoDate(monday)) + 6);
  return { monday, sunday };
}

export function addDays(date, days) {
  if (!Number.isInteger(days)) throw new TypeError('days must be an integer');
  return fromEpochDay(toEpochDay(parseIsoDate(date)) + days);
}

export function isMonday(date) {
  try {
    return getWeekMonday(date) === date;
  } catch {
    return false;
  }
}

export function getIsoWeek(date) {
  const parsed = parseIsoDate(date);
  const epochDay = toEpochDay(parsed);
  const weekday = new Date(epochDay * DAY_MS).getUTCDay();
  const mondayEpoch = epochDay - (weekday === 0 ? 6 : weekday - 1);
  const thursdayEpoch = mondayEpoch + 3;
  const thursday = new Date(thursdayEpoch * DAY_MS);
  const weekYear = thursday.getUTCFullYear();
  const firstThursday = toEpochDay({ year: weekYear, month: 1, day: 4 });
  const firstMonday = firstThursday - (new Date(firstThursday * DAY_MS).getUTCDay() || 7) + 1;
  return { weekYear, week: Math.floor((mondayEpoch - firstMonday) / 7) + 1 };
}

export function isDateWritable(date, clock = () => new Date()) {
  const target = toEpochDay(parseIsoDate(date));
  const today = toEpochDay(parseIsoDate(getBangkokDate(clock)));
  const currentMonday = toEpochDay(parseIsoDate(getCurrentWeekMonday(clock)));
  return target >= today && target <= currentMonday + 20;
}

export function isWeekNavigable(mondayDate, clock = () => new Date()) {
  if (!isMonday(mondayDate)) return false;
  const monday = mondayDate;
  const currentMonday = getCurrentWeekMonday(clock);
  return toEpochDay(parseIsoDate(monday)) <= toEpochDay(parseIsoDate(currentMonday)) + 14;
}

function getInstant(clock) {
  const instant = clock instanceof Date ? clock : clock();
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) throw new TypeError('clock must provide a valid Date');
  return instant;
}

function daysInMonth(year, month) {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function toEpochDay({ year, month, day }) {
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return Math.floor(date.getTime() / DAY_MS);
}

function fromEpochDay(epochDay) {
  const date = new Date(epochDay * DAY_MS);
  return formatIsoDate({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() });
}
