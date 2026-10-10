export const DISPLAY_TIME_ZONE = 'Asia/Bangkok';

const dateTimeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: DISPLAY_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

export function formatDateTime(value) {
  if (value === null || value === undefined || value === '') return 'Unavailable';

  let instant;
  try {
    instant = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  } catch {
    return 'Unavailable';
  }
  if (Number.isNaN(instant.getTime())) return 'Unavailable';

  const parts = dateTimeFormatter.formatToParts(instant);
  const values = Object.fromEntries(
    parts
      .filter(({ type }) => type !== 'literal')
      .map(({ type, value: partValue }) => [type, partValue]),
  );
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}
