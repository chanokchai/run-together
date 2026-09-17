const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function formatDisplayDate(value) {
  const match = ISO_DATE.exec(value);
  if (!match) throw new RangeError('invalid ISO date');
  const month = Number(match[2]);
  const day = Number(match[3]);
  const year = Number(match[1]);
  const daysInMonth = month === 2
    ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28)
    : [4, 6, 9, 11].includes(month) ? 30 : 31;
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) throw new RangeError('invalid ISO date');
  return `${day} ${MONTHS[month - 1]}`;
}

export function colorForDay(voteCount, weeklyMaximum) {
  const count = Number.isFinite(voteCount) ? Math.max(0, voteCount) : 0;
  const maximum = Number.isFinite(weeklyMaximum) ? Math.max(0, weeklyMaximum) : 0;
  if (count === 0 || maximum === 0) {
    return { background: '#0b3d2e', foreground: '#ffffff', brightness: 0 };
  }
  const brightness = Math.min(1, count / maximum);
  const lightness = Math.round(20 + brightness * 10);
  return {
    background: `hsl(152 63% ${lightness}%)`,
    foreground: '#ffffff',
    brightness,
  };
}
