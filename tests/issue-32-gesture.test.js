import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attachHorizontalSwipe,
  DATE_CARD_SWIPE_THRESHOLD,
  formatRunEventDate,
  getDateCardSwipeAction,
  getDateCardSwipePreview,
  getRunEventBannerSwipeAction,
  getRunEventBannerSwipePreview,
  millisecondsUntilBangkokMidnight,
} from '../src/run-events.js';

class GestureElement extends EventTarget {
  style = {};
  attributes = new Map();

  setAttribute(name, value) { this.attributes.set(name, value); }
  removeAttribute(name) { this.attributes.delete(name); }
  setPointerCapture() {}
}

function pointerEvent(type, { pointerId = 1, x = 100, y = 100 } = {}) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    clientX: { value: x },
    clientY: { value: y },
  });
  return event;
}

function synthesizedClick() {
  const event = new Event('click', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'detail', { value: 1 });
  return event;
}

test('date-card swipes propose right and withdraw a proposal left only for an eligible current voter', () => {
  assert.equal(DATE_CARD_SWIPE_THRESHOLD, 64);
  assert.equal(getDateCardSwipeAction({ deltaX: 80, deltaY: 2, eligible: true, selected: true, status: null }), 'propose');
  assert.equal(getDateCardSwipeAction({ deltaX: -80, deltaY: 2, eligible: true, selected: true, status: 'proposed' }), 'withdraw');
  assert.equal(getDateCardSwipeAction({ deltaX: -80, deltaY: 2, eligible: true, selected: true, status: 'scheduled' }), null);
  assert.equal(getDateCardSwipeAction({ deltaX: 80, deltaY: 2, eligible: true, selected: false, status: null }), null);
  assert.equal(getDateCardSwipeAction({ deltaX: 80, deltaY: 2, eligible: false, selected: true, status: null }), null);
  assert.equal(getDateCardSwipeAction({ deltaX: 50, deltaY: 0, eligible: true, selected: true, status: null }), null);
  assert.equal(getDateCardSwipeAction({ deltaX: 80, deltaY: 100, eligible: true, selected: true, status: null }), null);
  assert.equal(getDateCardSwipePreview({ deltaX: 24, deltaY: 0, eligible: true, selected: true, status: null }), 'propose');
  assert.equal(getDateCardSwipePreview({ deltaX: -24, deltaY: 0, eligible: true, selected: true, status: 'proposed' }), 'withdraw');
  assert.equal(getDateCardSwipePreview({ deltaX: -24, deltaY: 0, eligible: true, selected: true, status: 'scheduled' }), null);
  assert.equal(getDateCardSwipePreview({ deltaX: 24, deltaY: 40, eligible: true, selected: true, status: null }), null);
});

test('admin banner deletes only on a deliberate left swipe and never on right or vertical drags', () => {
  assert.equal(getRunEventBannerSwipeAction({ deltaX: -70, deltaY: 0, isAdmin: true }), 'delete');
  assert.equal(getRunEventBannerSwipeAction({ deltaX: 80, deltaY: 0, isAdmin: true }), null);
  assert.equal(getRunEventBannerSwipeAction({ deltaX: -70, deltaY: 0, isAdmin: false }), null);
  assert.equal(getRunEventBannerSwipeAction({ deltaX: -70, deltaY: 90, isAdmin: true }), null);
  assert.equal(getRunEventBannerSwipeAction({ deltaX: -56, deltaY: 0, isAdmin: true }), null);
  assert.equal(getRunEventBannerSwipePreview({ deltaX: -24, deltaY: 0, isAdmin: true }), 'delete');
  assert.equal(getRunEventBannerSwipePreview({ deltaX: 24, deltaY: 0, isAdmin: true }), null);
  assert.equal(getRunEventBannerSwipePreview({ deltaX: -24, deltaY: 0, isAdmin: false }), null);
});

test('event banner dates include the correct English weekday in UTC-safe calendar formatting', () => {
  assert.equal(formatRunEventDate('2024-03-01'), 'Fri, 1 Mar');
  assert.equal(formatRunEventDate('2024-03-03'), 'Sun, 3 Mar');
  assert.throws(() => formatRunEventDate('2024-02-30'), /invalid ISO date/);
});

test('a horizontal drag below the event threshold cannot fall through as a date-card vote tap', () => {
  const card = new GestureElement();
  let voteTaps = 0;
  let eventActions = 0;
  attachHorizontalSwipe(card, { resolveAction: () => null, onCommit: () => { eventActions += 1; } });
  card.addEventListener('click', () => { voteTaps += 1; });
  card.dispatchEvent(pointerEvent('pointerdown'));
  card.dispatchEvent(pointerEvent('pointermove', { x: 130 }));
  card.dispatchEvent(pointerEvent('pointerup', { x: 130 }));
  card.dispatchEvent(synthesizedClick());
  assert.equal(eventActions, 0, 'does not commit a proposal below the deliberate swipe threshold');
  assert.equal(voteTaps, 0, 'does not accidentally toggle availability after a short horizontal drag');
});

test('horizontal gestures announce an available action before the commit distance', () => {
  const card = new GestureElement();
  const previews = [];
  attachHorizontalSwipe(card, {
    resolvePreview: (deltaX) => deltaX > 0 ? 'propose' : null,
    resolveAction: (deltaX) => deltaX >= DATE_CARD_SWIPE_THRESHOLD ? 'propose' : null,
    onPreview: (action, deltaX, ready) => previews.push({ action, deltaX, ready }),
  });
  card.dispatchEvent(pointerEvent('pointerdown'));
  card.dispatchEvent(pointerEvent('pointermove', { x: 124 }));
  assert.deepEqual(previews.at(-1), { action: 'propose', deltaX: 24, ready: false });
  card.dispatchEvent(pointerEvent('pointermove', { x: 170 }));
  assert.deepEqual(previews.at(-1), { action: 'propose', deltaX: 70, ready: true });
});

test('event visibility refresh delay targets the next Asia/Bangkok midnight across UTC boundaries', () => {
  assert.equal(millisecondsUntilBangkokMidnight(new Date('2024-02-29T16:59:59.000Z')), 1075);
  assert.equal(millisecondsUntilBangkokMidnight(new Date('2024-02-29T17:00:01.000Z')), 86_399_075);
});
