import assert from 'node:assert/strict';
import test from 'node:test';
import { projectOfflineSnapshot } from '../src/pwa-contract.js';

const room = {
  id: '00000000-0000-4000-8000-000000000009', displayNumber: 9,
  title: 'Morning run', venue: 'Park', time: '06:30', ownerUserId: 123,
  color: '#ffffff', icon: 'shoe', createdAt: 'private', canEdit: true,
};
const weekState = {
  roomId: room.id,
  week: { monday: '2026-11-16', sunday: '2026-11-22', isoWeek: 47, isoWeekYear: 2026, resetEligible: true },
  navigation: { previousMonday: '2026-11-09', nextMonday: '2026-11-23' },
  currentUserSelectedDates: ['2026-11-17'],
  days: Array.from({ length: 7 }, (_, index) => ({
    date: `2026-11-${String(16 + index).padStart(2, '0')}`,
    voteCount: index === 1 ? 1 : 0,
    voterNames: index === 1 ? ['<img src=x onerror=alert(1)>'] : [],
    eligible: true,
    currentUserSelected: true,
    userIds: [123],
  })),
  events: [{ date: '2026-11-17', status: 'scheduled', eventId: 44, revision: 8, ownerId: 123, voterNames: ['Secret'] }],
  csrfToken: 'must-not-persist',
};

test('Issue 9 offline snapshot is a strict, room-bound allowlist projection', () => {
  const savedAt = '2026-11-16T12:00:00.000Z';
  const snapshot = projectOfflineSnapshot({ room, weekState, savedAt });
  assert.deepEqual(Object.keys(snapshot).sort(), ['days', 'events', 'room', 'savedAt', 'schemaVersion', 'week']);
  assert.deepEqual(Object.keys(snapshot.room).sort(), ['displayNumber', 'id', 'time', 'title', 'venue']);
  assert.deepEqual(Object.keys(snapshot.week).sort(), ['isoWeek', 'isoWeekYear', 'monday', 'sunday']);
  assert.deepEqual(Object.keys(snapshot.days[0]).sort(), ['date', 'voteCount', 'voterNames']);
  assert.deepEqual(Object.keys(snapshot.events[0]).sort(), ['date', 'status']);
  assert.equal(snapshot.savedAt, savedAt);
  assert.deepEqual(snapshot.days[1].voterNames, ['<img src=x onerror=alert(1)>']);
  assert.equal(JSON.stringify(snapshot).includes('must-not-persist'), false);
  assert.equal(JSON.stringify(snapshot).includes('ownerUserId'), false);
  assert.equal(JSON.stringify(snapshot).includes('currentUserSelectedDates'), false);
});

test('Issue 9 refuses mismatched rooms and malformed private or display fields', () => {
  assert.throws(() => projectOfflineSnapshot({ room, weekState: { ...weekState, roomId: 'different-room' } }), /same room identity/);
  assert.throws(() => projectOfflineSnapshot({ room, weekState: { ...weekState, days: weekState.days.slice(1) } }), /seven days/);
  assert.throws(() => projectOfflineSnapshot({ room, weekState: { ...weekState, days: [{ ...weekState.days[0], voterNames: [123] }, ...weekState.days.slice(1)] } }), /invalid day/);
  const projectedEvent = projectOfflineSnapshot({ room, weekState: {
    ...weekState,
    events: [{ date: '2026-11-17', status: 'scheduled', private: true, eventId: 44 }],
  } }).events[0];
  assert.deepEqual(projectedEvent, { date: '2026-11-17', status: 'scheduled' });
});
