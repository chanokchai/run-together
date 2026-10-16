import assert from 'node:assert/strict';
import test from 'node:test';

function makeElement({ visible = true } = {}) {
  const classes = new Set();
  const properties = new Map();
  const element = {
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    },
    style: {
      setProperty: (name, value) => properties.set(name, value),
      getPropertyValue: (name) => properties.get(name) ?? '',
      removeProperty: (name) => properties.delete(name),
    },
    ownerDocument: {
      defaultView: {
        innerWidth: 390,
        innerHeight: 844,
        getComputedStyle: () => ({ visibility: 'visible', overflowX: 'visible', overflowY: 'visible' }),
      },
    },
    getBoundingClientRect: () => visible
      ? { top: 10, bottom: 40, left: 10, right: 40 }
      : { top: 900, bottom: 930, left: 10, right: 40 },
    classes,
    properties,
    setVisible(value) { visible = value; },
  };
  return element;
}

function createHarness({ reducedMotion = false, now = 0 } = {}) {
  let notify;
  let preferenceListener;
  const observed = new Set();
  const preference = {
    matches: reducedMotion,
    addEventListener(_type, listener) { preferenceListener = listener; },
    removeEventListener(_type, listener) { if (preferenceListener === listener) preferenceListener = undefined; },
    change(value) { this.matches = value; preferenceListener?.({ matches: value }); },
  };
  return {
    observed,
    preference,
    controllerOptions: {
      now: () => now,
      createMotionQuery: () => preference,
      createObserver(callback) {
        notify = (element, isIntersecting) => callback([{ target: element, isIntersecting }]);
        return {
          observe: (element) => observed.add(element),
          unobserve: (element) => observed.delete(element),
          disconnect: () => observed.clear(),
        };
      },
    },
    notify: (...args) => notify(...args),
    setNow(value) { now = value; },
  };
}

function scheduled(key, element, targets = [element]) {
  return { key, element, targets, scheduled: true };
}

test('all visible scheduled representations share one continuous normalized 1.4-second phase', async () => {
  const { createScheduledEffectController } = await import('../src/vote-board.js');
  const harness = createHarness({ now: 525 });
  const controller = createScheduledEffectController(harness.controllerOptions);
  const banner = makeElement();
  const dateCard = makeElement();
  const graphDate = makeElement();
  const graphBar = makeElement();

  controller.sync('banner', [scheduled('2026-10-11', banner)]);
  controller.sync('date-card', [scheduled('2026-10-11', dateCard)]);
  controller.sync('timeline', [scheduled('2026-10-11', graphDate, [graphDate, graphBar])]);

  for (const element of [banner, dateCard, graphDate, graphBar]) {
    assert.equal(element.classList.contains('is-beam-running'), true, 'visible items run the decorative beam continuously');
  }
  assert.deepEqual(
    [banner, dateCard, graphDate, graphBar].map((element) => element.style.getPropertyValue('--beam-delay')),
    ['-525ms', '-525ms', '-525ms', '-525ms'],
    'different item perimeters use the same normalized page phase',
  );
  assert.equal(harness.observed.size, 3, 'the controller observes each representation anchor once');
  controller.dispose();
  assert.equal(harness.observed.size, 0, 'dispose disconnects viewport observation');
  for (const element of [banner, dateCard, graphDate, graphBar]) {
    assert.equal(element.classList.contains('is-beam-running'), false, 'dispose stops every tracked beam');
  }
});

test('viewport re-entry and replacement nodes join the current page phase without restarting a one-shot effect', async () => {
  const { createScheduledEffectController } = await import('../src/vote-board.js');
  const harness = createHarness({ now: 200 });
  const controller = createScheduledEffectController(harness.controllerOptions);
  const date = makeElement();
  controller.sync('timeline', [scheduled('2026-10-11', date)]);
  assert.equal(date.classList.contains('is-beam-running'), true);

  date.setVisible(false);
  harness.notify(date, false);
  assert.equal(date.classList.contains('is-beam-running'), false, 'offscreen beam pauses to avoid unnecessary work');
  harness.setNow(1735);
  date.setVisible(true);
  harness.notify(date, true);
  assert.equal(date.classList.contains('is-beam-running'), true);
  assert.equal(date.style.getPropertyValue('--beam-delay'), '-335ms', 're-entry resumes at current shared phase');

  harness.setNow(2110);
  const replacement = makeElement();
  controller.sync('timeline', [scheduled('2026-10-11', replacement)]);
  assert.equal(replacement.classList.contains('is-beam-running'), true, 'a replacement node becomes active immediately when visible');
  assert.equal(replacement.style.getPropertyValue('--beam-delay'), '-710ms', 'rerendered nodes join the same current phase');
  assert.equal(date.classList.contains('is-beam-running'), false, 'replaced nodes are cleaned up');
  controller.dispose();
});

test('a stale observer exit does not pause a beam whose current geometry is still visible', async () => {
  const { createScheduledEffectController } = await import('../src/vote-board.js');
  const harness = createHarness({ now: 900 });
  const controller = createScheduledEffectController(harness.controllerOptions);
  const date = makeElement();
  controller.sync('timeline', [scheduled('2026-10-11', date)]);

  harness.notify(date, false);

  assert.equal(date.classList.contains('is-beam-running'), true, 'current viewport geometry outranks a stale observer notification');
  controller.dispose();
});

test('reduced motion is static and a live preference change updates visible beams', async () => {
  const { createScheduledEffectController } = await import('../src/vote-board.js');
  const harness = createHarness({ reducedMotion: true, now: 810 });
  const controller = createScheduledEffectController(harness.controllerOptions);
  const banner = makeElement();
  controller.sync('banner', [scheduled('2026-10-11', banner)]);
  assert.equal(banner.classList.contains('is-beam-running'), false, 'reduced-motion visitors get a static scheduled indicator');

  harness.preference.change(false);
  assert.equal(banner.classList.contains('is-beam-running'), true, 'turning motion back on starts visible beam at shared phase');
  assert.equal(banner.style.getPropertyValue('--beam-delay'), '-810ms');
  harness.preference.change(true);
  assert.equal(banner.classList.contains('is-beam-running'), false, 'a live reduced-motion change stops animation immediately');
  assert.equal(harness.observed.has(banner), true, 'static scheduled state remains tracked');
  controller.dispose();
});

test('proposed, removed, and offscreen items do not keep scheduled beam effects', async () => {
  const { createScheduledEffectController } = await import('../src/vote-board.js');
  const harness = createHarness({ now: 100 });
  const controller = createScheduledEffectController(harness.controllerOptions);
  const scheduledDate = makeElement();
  const proposed = makeElement();
  const offscreen = makeElement({ visible: false });

  controller.sync('timeline', [scheduled('2026-10-11', scheduledDate), scheduled('2026-10-12', proposed, [])]);
  assert.equal(scheduledDate.classList.contains('is-beam-running'), true);
  controller.sync('banner', [scheduled('2026-10-13', offscreen)]);
  assert.equal(offscreen.classList.contains('is-beam-running'), false, 'offscreen items wait for visibility');
  controller.sync('timeline', []);
  assert.equal(scheduledDate.classList.contains('is-beam-running'), false, 'reversion/removal stops the beam immediately');
  assert.equal(harness.observed.has(scheduledDate), false, 'removed items stop being observed');
  controller.dispose();
});
