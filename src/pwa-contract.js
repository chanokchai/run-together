const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const EVENT_STATUSES = new Set(['proposed', 'scheduled']);

function isDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function requireString(value, field) {
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`);
  return value;
}

export function projectOfflineSnapshot({ room, weekState, savedAt = new Date() } = {}) {
  if (!room || !weekState || typeof room !== 'object' || typeof weekState !== 'object') {
    throw new TypeError('room and weekState are required');
  }
  if (typeof room.id !== 'string' || room.id.length === 0 || weekState.roomId !== room.id) {
    throw new TypeError('room and week state must have the same room identity');
  }
  if (!Number.isSafeInteger(room.displayNumber) || room.displayNumber < 1) {
    throw new TypeError('room.displayNumber must be a positive safe integer');
  }
  const roomProjection = {
    id: room.id,
    displayNumber: room.displayNumber,
    title: requireString(room.title, 'room.title'),
    venue: requireString(room.venue ?? '', 'room.venue'),
    time: requireString(room.time ?? '', 'room.time'),
  };
  const week = weekState.week;
  if (!week || !isDate(week.monday) || !isDate(week.sunday)
    || !Number.isSafeInteger(week.isoWeek) || week.isoWeek < 1 || week.isoWeek > 53
    || !Number.isSafeInteger(week.isoWeekYear)) {
    throw new TypeError('weekState.week is invalid');
  }
  if (!Array.isArray(weekState.days) || weekState.days.length !== 7) {
    throw new TypeError('weekState.days must contain seven days');
  }
  const days = weekState.days.map((day) => {
    if (!day || !isDate(day.date) || !Number.isSafeInteger(day.voteCount) || day.voteCount < 0
      || !Array.isArray(day.voterNames) || !day.voterNames.every((name) => typeof name === 'string')) {
      throw new TypeError('weekState.days contains an invalid day');
    }
    return { date: day.date, voteCount: day.voteCount, voterNames: [...day.voterNames] };
  });
  if (!Array.isArray(weekState.events)) throw new TypeError('weekState.events must be an array');
  const events = weekState.events.map((event) => {
    if (!event || !isDate(event.date) || !EVENT_STATUSES.has(event.status)) {
      throw new TypeError('weekState.events contains an invalid event');
    }
    return { date: event.date, status: event.status };
  });
  const savedAtValue = savedAt instanceof Date ? savedAt.toISOString() : requireString(savedAt, 'savedAt');
  if (!Number.isFinite(Date.parse(savedAtValue))) throw new TypeError('savedAt must be a valid timestamp');
  return {
    schemaVersion: 1,
    savedAt: savedAtValue,
    room: roomProjection,
    week: {
      monday: week.monday,
      sunday: week.sunday,
      isoWeek: week.isoWeek,
      isoWeekYear: week.isoWeekYear,
    },
    days,
    events,
  };
}
