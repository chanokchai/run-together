export const DATE_CARD_SWIPE_THRESHOLD = 64;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function isValidIsoDate(value) {
  const match = ISO_DATE.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (year < 1 || month < 1 || month > 12 || day < 1) return null;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = month === 2 ? (leap ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  return day <= monthDays ? { year, month, day } : null;
}

export function formatRunEventDate(value) {
  const parsed = isValidIsoDate(value);
  if (!parsed) throw new RangeError('invalid ISO date');
  const day = new Date(0);
  day.setUTCHours(0, 0, 0, 0);
  day.setUTCFullYear(parsed.year, parsed.month - 1, parsed.day);
  return `${WEEKDAYS[day.getUTCDay()]}, ${parsed.day} ${MONTHS[parsed.month - 1]}`;
}

export function millisecondsUntilBangkokMidnight(current = new Date()) {
  const parts = new Map(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(current).map(({ type, value }) => [type, Number(value)]));
  const localNowAsUtc = Date.UTC(
    parts.get('year'), parts.get('month') - 1, parts.get('day'),
    parts.get('hour') % 24, parts.get('minute'), parts.get('second'),
  );
  const utcOffset = localNowAsUtc - current.getTime();
  return Math.max(
    1000,
    Date.UTC(parts.get('year'), parts.get('month') - 1, parts.get('day') + 1) - utcOffset - current.getTime() + 75,
  );
}

function isHorizontalCommit(deltaX, deltaY, threshold = DATE_CARD_SWIPE_THRESHOLD) {
  return Math.abs(deltaX) >= threshold && Math.abs(deltaX) > Math.abs(deltaY);
}

export function getDateCardSwipeAction({ deltaX, deltaY, eligible, selected, status }) {
  if (!isHorizontalCommit(deltaX, deltaY)) return null;
  return getDateCardSwipePreview({ deltaX, deltaY, eligible, selected, status });
}

export function getDateCardSwipePreview({ deltaX, deltaY, eligible, selected, status }) {
  if (!eligible || !selected || Math.abs(deltaX) <= Math.abs(deltaY)) return null;
  if (deltaX > 0 && status === null) return 'propose';
  if (deltaX < 0 && status === 'proposed') return 'withdraw';
  return null;
}

export function getRunEventBannerSwipeAction({ deltaX, deltaY, isAdmin }) {
  if (!isHorizontalCommit(deltaX, deltaY)) return null;
  return getRunEventBannerSwipePreview({ deltaX, deltaY, isAdmin });
}

export function getRunEventBannerSwipePreview({ deltaX, deltaY, isAdmin }) {
  if (!isAdmin || Math.abs(deltaX) <= Math.abs(deltaY)) return null;
  return deltaX < 0 ? 'delete' : null;
}

export function attachHorizontalSwipe(element, {
  resolveAction,
  resolvePreview,
  onPreview = () => {},
  onCommit = () => {},
  threshold = DATE_CARD_SWIPE_THRESHOLD,
}) {
  let gesture = null;
  let lock = null;
  let completedSwipeAt = -Infinity;

  function resetPreview() {
    element.style.transform = '';
    element.removeAttribute('data-swipe-action');
    onPreview(null, 0, false);
  }

  function cancel() {
    gesture = null;
    lock = null;
    resetPreview();
  }

  function start(event) {
    if (event.isPrimary === false || (event.pointerType === 'mouse' && event.button !== 0)) return;
    const interactiveTarget = event.target?.closest?.('button, a, input, select, textarea');
    if (interactiveTarget && interactiveTarget !== element) return;
    gesture = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, deltaX: 0, deltaY: 0 };
    lock = null;
    try {
      element.setPointerCapture?.(event.pointerId);
    } catch {
      // Synthetic and already-cancelled pointers do not support capture.
    }
  }

  function move(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    gesture.deltaX = event.clientX - gesture.x;
    gesture.deltaY = event.clientY - gesture.y;
    const { deltaX, deltaY } = gesture;
    if (!lock && Math.max(Math.abs(deltaX), Math.abs(deltaY)) >= 10) {
      lock = Math.abs(deltaY) > Math.abs(deltaX) * 1.15 ? 'vertical' : 'horizontal';
    }
    if (lock !== 'horizontal') {
      if (lock === 'vertical') resetPreview();
      return;
    }
    if (event.cancelable) event.preventDefault();
    const action = resolveAction(deltaX, deltaY);
    const previewAction = resolvePreview ? resolvePreview(deltaX, deltaY) : action;
    element.style.transform = `translateX(${Math.max(-96, Math.min(96, deltaX))}px)`;
    if (previewAction) element.setAttribute('data-swipe-action', previewAction);
    else element.removeAttribute('data-swipe-action');
    onPreview(previewAction, deltaX, Boolean(action && isHorizontalCommit(deltaX, deltaY, threshold)));
  }

  function finish(event, allowCommit) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const { deltaX, deltaY } = gesture;
    const horizontalDrag = lock === 'horizontal' && Math.max(Math.abs(deltaX), Math.abs(deltaY)) >= 10;
    const action = lock === 'horizontal' && allowCommit && isHorizontalCommit(deltaX, deltaY, threshold)
      ? resolveAction(deltaX, deltaY)
      : null;
    gesture = null;
    lock = null;
    resetPreview();
    if (horizontalDrag) completedSwipeAt = event.timeStamp;
    if (!action) return;
    completedSwipeAt = event.timeStamp;
    onCommit(action);
  }

  function end(event) {
    finish(event, true);
  }

  function lostCapture(event) {
    if (gesture && event.pointerId !== gesture.pointerId) return;
    cancel();
  }

  function suppressSynthesizedClick(event) {
    if (event.detail > 0 && event.timeStamp - completedSwipeAt >= 0 && event.timeStamp - completedSwipeAt < 300) {
      completedSwipeAt = -Infinity;
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }

  element.addEventListener('pointerdown', start);
  element.addEventListener('pointermove', move, { passive: false });
  element.addEventListener('pointerup', end);
  element.addEventListener('pointercancel', cancel);
  element.addEventListener('lostpointercapture', lostCapture);
  element.addEventListener('click', suppressSynthesizedClick, true);
  return () => {
    cancel();
    element.removeEventListener('pointerdown', start);
    element.removeEventListener('pointermove', move);
    element.removeEventListener('pointerup', end);
    element.removeEventListener('pointercancel', cancel);
    element.removeEventListener('lostpointercapture', lostCapture);
    element.removeEventListener('click', suppressSynthesizedClick, true);
  };
}
