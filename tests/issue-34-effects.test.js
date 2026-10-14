import assert from 'node:assert/strict';
import test from 'node:test';

function createHarness({ reducedMotion = false } = {}) {
  let notify;
  const observed = new Set();
  const timers = new Map();
  let timerId = 0;
  let timerStarts = 0;
  const controllerOptions = {
    createObserver(callback) {
      notify = (element, isIntersecting) => callback([{ target: element, isIntersecting }]);
      return {
        observe: (element) => observed.add(element),
        unobserve: (element) => observed.delete(element),
        disconnect: () => observed.clear(),
      };
    },
    reducedMotion: () => reducedMotion,
    duration: 1500,
    setTimer(callback, duration) {
      const id = ++timerId;
      timerStarts += 1;
      timers.set(id, { callback, duration });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
  };
  return { controllerOptions, observed, timers, notify: (...args) => notify(...args), get timerStarts() { return timerStarts; } };
}

function item(key = '2026-10-11') {
  const classes = new Set();
  return {
    key,
    element: {
      classList: {
        add: (value) => classes.add(value),
        remove: (value) => classes.delete(value),
      },
    },
    targets: [],
    scheduled: true,
    classes,
  };
}

test('scheduled effect replays on real viewport re-entry but ignores same-state rerenders', async () => {
  const { createScheduledEffectController } = await import('../src/vote-board.js');
  assert.equal(typeof createScheduledEffectController, 'function');
  const harness = createHarness();
  const controller = createScheduledEffectController(harness.controllerOptions);
  const banner = item();
  const sync = () => controller.sync('banner', [banner]);

  sync();
  assert.equal(harness.observed.has(banner.element), true);
  harness.notify(banner.element, true);
  assert.equal(banner.classes.has('is-celebrating'), true);
  assert.deepEqual([...harness.timers.values()].map(({ duration }) => duration), [1500]);

  sync();
  harness.notify(banner.element, true);
  assert.equal(harness.timers.size, 1, 'same visible state and incidental data render do not restart the effect');
  harness.notify(banner.element, false);
  harness.notify(banner.element, true);
  assert.equal(harness.timers.size, 1, 're-entry replaces the active timer rather than overlapping it');
  assert.equal(banner.classes.has('is-celebrating'), true);
  [...harness.timers.values()][0].callback();
  assert.equal(banner.classes.has('is-celebrating'), false);
  harness.notify(banner.element, false);
  harness.notify(banner.element, true);
  assert.equal(banner.classes.has('is-celebrating'), true, 'a later real re-entry starts another brief effect');
  controller.dispose();
});

test('banner and graph effects keep same-date viewport visibility independent', async () => {
  const { createScheduledEffectController } = await import('../src/vote-board.js');
  const harness = createHarness();
  const controller = createScheduledEffectController(harness.controllerOptions);
  const banner = item('2026-10-11');
  const graphDate = item('2026-10-11');

  controller.sync('banner', [banner]);
  controller.sync('timeline', [graphDate]);
  harness.notify(banner.element, true);
  assert.equal(banner.classes.has('is-celebrating'), true);
  assert.equal(graphDate.classes.has('is-celebrating'), false);

  harness.notify(banner.element, false);
  harness.notify(graphDate.element, true);
  assert.equal(banner.classes.has('is-celebrating'), true, 'the banner effect may finish after its own viewport exit');
  assert.equal(graphDate.classes.has('is-celebrating'), true, 'the graph starts when its own date enters view');
  assert.equal(harness.timers.size, 2, 'same-date banner and graph animations use independent timers');
  controller.dispose();
});

test('stale observer exit does not replay an item that remains geometrically visible', async () => {
  const { createScheduledEffectController } = await import('../src/vote-board.js');
  const harness = createHarness();
  const controller = createScheduledEffectController(harness.controllerOptions);
  const visible = item();
  visible.element.ownerDocument = { defaultView: { innerWidth: 320, innerHeight: 240 } };
  visible.element.getBoundingClientRect = () => ({ top: 10, bottom: 40, left: 10, right: 40 });

  controller.sync('timeline', [visible]);
  assert.equal(harness.timerStarts, 1, 'the visible schedule starts one effect');
  harness.notify(visible.element, false);
  harness.notify(visible.element, true);

  assert.equal(harness.timerStarts, 1, 'an outdated observer exit cannot manufacture a viewport re-entry');
  controller.dispose();
});

test('offscreen schedule waits for visibility and reversion cancels timer and observation', async () => {
  const { createScheduledEffectController } = await import('../src/vote-board.js');
  assert.equal(typeof createScheduledEffectController, 'function');
  const harness = createHarness();
  const controller = createScheduledEffectController(harness.controllerOptions);
  const graphDate = item();
  controller.sync('timeline', [graphDate]);
  harness.notify(graphDate.element, false);
  assert.equal(graphDate.classes.has('is-celebrating'), false);
  harness.notify(graphDate.element, true);
  assert.equal(graphDate.classes.has('is-celebrating'), true);
  controller.sync('timeline', [{ ...graphDate, scheduled: false }]);
  assert.equal(graphDate.classes.has('is-celebrating'), false);
  assert.equal(harness.observed.has(graphDate.element), false);
  assert.equal(harness.timers.size, 0);
  controller.dispose();
});

test('reduced motion keeps static scheduled state without creating animation timers', async () => {
  const { createScheduledEffectController } = await import('../src/vote-board.js');
  assert.equal(typeof createScheduledEffectController, 'function');
  const harness = createHarness({ reducedMotion: true });
  const controller = createScheduledEffectController(harness.controllerOptions);
  const date = item();
  controller.sync('timeline', [date]);
  harness.notify(date.element, true);
  harness.notify(date.element, false);
  harness.notify(date.element, true);
  assert.equal(date.classes.has('is-celebrating'), false);
  assert.equal(harness.timers.size, 0);
  controller.dispose();
});
