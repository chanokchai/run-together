import { DEFAULT_ROOM_ICON, ROOM_ICONS } from './room-contract.js?v=issue-43-icons-1';
import { configureVoterNamesMarquee, createScheduledEffectController, createVoterNamesRegion } from './vote-board.js?v=issue-47-schedule-names-1';
import { millisecondsUntilBangkokMidnight } from './run-events.js';
import { addDays, getBangkokDate, parseIsoDate } from './calendar.js?v=issue-43-calendar-1';

const ICONS = Object.freeze({
  running: { glyph: '🏃', label: 'Running' },
  football: { glyph: '⚽', label: 'Football' },
  basketball: { glyph: '🏀', label: 'Basketball' },
  tennis: { glyph: '🎾', label: 'Tennis' },
  volleyball: { glyph: '🏐', label: 'Volleyball' },
  badminton: { glyph: '🏸', label: 'Badminton' },
  cycling: { glyph: '🚴', label: 'Cycling' },
  swimming: { glyph: '🏊', label: 'Swimming' },
  hiking: { glyph: '🥾', label: 'Hiking' },
  dinner: { glyph: '🍽️', label: 'Dinner' },
  office: { glyph: '🏢', label: 'Office' },
  meeting: { glyph: '🤝', label: 'Meeting' },
  coffee: { glyph: '☕', label: 'Coffee' },
  birthday: { glyph: '🎂', label: 'Birthday' },
  study: { glyph: '📚', label: 'Study' },
  shopping: { glyph: '🛍️', label: 'Shopping' },
  travel: { glyph: '✈️', label: 'Travel' },
  cinema: { glyph: '🎬', label: 'Cinema' },
  music: { glyph: '🎵', label: 'Music' },
});
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function addText(parent, tag, value) {
  const element = document.createElement(tag);
  element.textContent = value;
  parent.append(element);
  return element;
}

function formatRoomDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return '';
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';
  return `${day}-${MONTHS[month - 1]}`;
}

function formatDates(values) {
  return Array.isArray(values) && values.length
    ? values.map(formatRoomDate).filter(Boolean).join(', ')
    : '';
}

function formatScheduleDate(value) {
  try {
    parseIsoDate(value);
  } catch {
    return null;
  }
  const [, , month, day] = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const fullDate = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(`${value}T00:00:00Z`));
  return { shortDate: `${day}-${month}`, fullDate };
}

function titleError(value) {
  const title = value.trim();
  const length = Array.from(title).length;
  if (length === 0) return 'Enter a room title. / กรุณาระบุชื่อห้อง';
  if (length > 30) return 'Room title must be 30 characters or fewer. / ชื่อห้องต้องไม่เกิน 30 ตัวอักษร';
  return '';
}

function venueError(value) {
  if (typeof value !== 'string') return 'Venue must be text. / สถานที่ต้องเป็นข้อความ';
  if (Array.from(value.trim()).length > 30) return 'Venue must be 30 characters or fewer. / สถานที่ต้องไม่เกิน 30 ตัวอักษร';
  return '';
}

function timeError(value) {
  if (typeof value !== 'string' || (value !== '' && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value))) {
    return 'Time must use valid 24-hour HH:mm format. / กรุณาระบุเวลาแบบ 24 ชั่วโมง HH:mm';
  }
  return '';
}

export function roomTimeFromSegments(hour, minute, period) {
  const values = [hour, minute, period];
  if (values.every((value) => value === '')) return '';
  if (values.some((value) => value === '')) return null;
  const hour12 = Number(hour);
  if (!Number.isInteger(hour12) || hour12 < 1 || hour12 > 12
    || !/^[0-5]\d$/.test(minute) || !['AM', 'PM'].includes(period)) return null;
  const hour24 = (hour12 % 12) + (period === 'PM' ? 12 : 0);
  return `${String(hour24).padStart(2, '0')}:${minute}`;
}

function createRoomTimePicker(form) {
  const fieldset = form.querySelector('#create-room-time-picker');
  const hour = form.querySelector('#create-room-time-hour');
  const minute = form.querySelector('#create-room-time-minute');
  const period = form.querySelector('#create-room-time-period');
  const hiddenTime = form.elements.time;
  const clear = form.querySelector('#create-room-time-clear');
  const error = form.querySelector('#create-room-time-error');
  const controls = [hour, minute, period].filter(Boolean);
  if (!fieldset || !hour || !minute || !period || !hiddenTime || !clear || !error) {
    return { validate: () => true, focus() {}, reset() {}, showError() {} };
  }
  for (let hourValue = 1; hourValue <= 12; hourValue += 1) {
    const option = addText(hour, 'option', String(hourValue));
    option.value = String(hourValue);
  }
  for (let minuteValue = 0; minuteValue < 60; minuteValue += 1) {
    const formatted = String(minuteValue).padStart(2, '0');
    const option = addText(minute, 'option', formatted);
    option.value = formatted;
  }
  ['AM', 'PM'].forEach((periodValue) => {
    const option = addText(period, 'option', periodValue);
    option.value = periodValue;
  });

  function readSelection() {
    const values = [hour.value, minute.value, period.value];
    const value = roomTimeFromSegments(hour.value, minute.value, period.value);
    if (value === null) {
      const focusTarget = controls[values.findIndex((segment) => segment === '')] ?? hour;
      return { valid: false, value: '', focusTarget };
    }
    return { valid: true, value };
  }

  function clearError() {
    error.textContent = '';
    error.hidden = true;
    controls.forEach((control) => control.removeAttribute('aria-invalid'));
  }

  function sync() {
    const selection = readSelection();
    hiddenTime.value = selection.value;
    clear.disabled = selection.value === '' && selection.valid;
    clearError();
    return selection;
  }

  function showError(message) {
    error.textContent = message;
    error.hidden = false;
    controls.forEach((control) => control.setAttribute('aria-invalid', 'true'));
  }

  controls.forEach((control) => control.addEventListener('change', sync));
  clear.addEventListener('click', () => {
    controls.forEach((control) => { control.value = ''; });
    sync();
    hour.focus();
  });

  return {
    validate() {
      const selection = sync();
      if (selection.valid) return true;
      showError('Choose an hour, minute, and AM/PM, or clear the time.');
      selection.focusTarget?.focus();
      return false;
    },
    focus() { hour.focus(); },
    reset() {
      controls.forEach((control) => { control.value = ''; });
      sync();
    },
    showError,
  };
}

function createIconPicker(form, pickerId, selectedIcon) {
  const picker = document.createElement('fieldset');
  picker.className = 'room-icon-picker';
  picker.id = pickerId;
  addText(picker, 'legend', 'Choose a sports or event icon / เลือกไอคอนกีฬา');
  const label = document.createElement('label');
  label.className = 'room-icon-picker__label';
  label.htmlFor = `${pickerId}-select`;
  addText(label, 'span', 'Room icon / ไอคอนห้อง');
  const select = document.createElement('select');
  select.className = 'room-icon-picker__select';
  select.id = `${pickerId}-select`;
  select.name = 'icon';
  select.setAttribute('aria-label', 'Room icon / ไอคอนห้อง');
  ROOM_ICONS.forEach((icon) => {
    const option = ICONS[icon];
    if (!option) return;
    const choice = addText(select, 'option', `${option.glyph} ${option.label}`);
    choice.value = icon;
    choice.selected = icon === selectedIcon;
    choice.defaultSelected = icon === selectedIcon;
  });
  label.append(select);
  picker.append(label);
  form.querySelector('.room-icon-picker')?.replaceWith(picker);
  if (!form.querySelector('.room-icon-picker')) form.append(picker);
  return picker;
}

function selectedIcon(form) {
  return new FormData(form).get('icon') || DEFAULT_ROOM_ICON;
}

function appendMetadataInput(form, { id, name, labelText, time = false }) {
  const label = document.createElement('label');
  label.htmlFor = id;
  label.textContent = labelText;
  const input = document.createElement('input');
  input.id = id;
  input.name = name;
  input.type = 'text';
  input.autocomplete = 'off';
  input.maxLength = time ? 5 : 60;
  if (time) {
    input.inputMode = 'numeric';
    input.pattern = '(?:[01]\\d|2[0-3]):[0-5]\\d';
    input.placeholder = 'HH:mm';
    input.setAttribute('aria-describedby', `${id}-format`);
    const hint = document.createElement('span');
    hint.id = `${id}-format`;
    hint.className = 'visually-hidden';
    hint.textContent = 'Use a valid 24-hour time in HH:mm format.';
    form.append(hint);
  }
  label.append(input);
  form.append(label);
  return input;
}

function dateLine(parent, className, label) {
  const line = document.createElement('p');
  line.className = className;
  addText(line, 'strong', `${label}: `);
  const dateValues = document.createElement('span');
  dateValues.className = 'room-card__date-values';
  dateValues.tabIndex = 0;
  dateValues.setAttribute('role', 'region');
  line.append(dateValues);
  parent.append(line);
  return { line, dateValues, nodes: new Map(), label };
}

function updateDateLine(state, values, room, { today, tomorrow, glow = false } = {}) {
  const dates = (Array.isArray(values) ? values : []).filter((date) => formatRoomDate(date));
  state.line.hidden = dates.length === 0;
  const formattedDates = formatDates(dates);
  state.dateValues.setAttribute('aria-label', `${state.label} dates for Room ${String(room.displayNumber).padStart(2, '0')}: ${room.title}${formattedDates ? `: ${formattedDates}` : ''}`);
  const activeDates = new Set(dates);
  state.nodes.forEach((node, date) => {
    if (activeDates.has(date)) return;
    node.remove();
    state.nodes.delete(date);
  });
  const ordered = dates.map((date) => {
    let node = state.nodes.get(date);
    if (!node) {
      node = document.createElement('time');
      node.className = 'room-card__date-value';
      state.nodes.set(date, node);
    }
    node.dateTime = date;
    node.textContent = formatRoomDate(date);
    node.classList.toggle('is-proposed-date-glowing', glow && (date === today || date === tomorrow));
    return node;
  });
  ordered.forEach((node, index) => {
    if (state.dateValues.children[index] !== node) {
      state.dateValues.insertBefore(node, state.dateValues.children[index] ?? null);
    }
  });
  return ordered;
}

async function responseBody(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function createProposedGlowController({ createObserver, createMotionQuery, now } = {}) {
  const states = new Map();
  const byElement = new Map();
  const scopeKeys = new Map();
  const view = globalThis.window;
  const cycleMs = 2800;
  const motion = (createMotionQuery ?? ((query) => globalThis.matchMedia?.(query)))('(prefers-reduced-motion: reduce)');
  const clock = now ?? (() => globalThis.document?.timeline?.currentTime ?? globalThis.performance?.now?.() ?? Date.now());

  function phaseDelay(timestamp = clock()) {
    const elapsed = ((timestamp % cycleMs) + cycleMs) % cycleMs;
    return `-${Math.floor(elapsed)}ms`;
  }

  function isVisible(element) {
    const bounds = element.getBoundingClientRect?.();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0 || !view) return false;
    const style = view.getComputedStyle?.(element);
    if (style?.visibility === 'hidden') return false;
    const intersection = {
      left: Math.max(bounds.left, 0),
      top: Math.max(bounds.top, 0),
      right: Math.min(bounds.right, view.innerWidth),
      bottom: Math.min(bounds.bottom, view.innerHeight),
    };
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const ancestorStyle = view.getComputedStyle?.(ancestor);
      if (!ancestorStyle) continue;
      const clipX = ['auto', 'clip', 'hidden', 'overlay', 'scroll'].includes(ancestorStyle.overflowX);
      const clipY = ['auto', 'clip', 'hidden', 'overlay', 'scroll'].includes(ancestorStyle.overflowY);
      if (!clipX && !clipY) continue;
      const ancestorBounds = ancestor.getBoundingClientRect();
      const left = ancestorBounds.left + ancestor.clientLeft;
      const top = ancestorBounds.top + ancestor.clientTop;
      if (clipX) {
        intersection.left = Math.max(intersection.left, left);
        intersection.right = Math.min(intersection.right, left + ancestor.clientWidth);
      }
      if (clipY) {
        intersection.top = Math.max(intersection.top, top);
        intersection.bottom = Math.min(intersection.bottom, top + ancestor.clientHeight);
      }
      if (intersection.right <= intersection.left || intersection.bottom <= intersection.top) return false;
    }
    return intersection.right > intersection.left && intersection.bottom > intersection.top;
  }

  function stop(element) {
    element.classList.remove('is-proposed-glow-running');
    element.style.removeProperty('--proposed-glow-delay');
  }

  function apply(state, timestamp = clock()) {
    if (!state.inViewport || motion?.matches) {
      stop(state.element);
      return;
    }
    if (!state.element.classList.contains('is-proposed-glow-running')) {
      state.element.style.setProperty('--proposed-glow-delay', phaseDelay(timestamp));
      state.element.classList.add('is-proposed-glow-running');
    }
  }

  function updateVisibility(element, timestamp = clock(), entry = null) {
    const state = byElement.get(element);
    if (!state) return;
    const intersection = entry?.intersectionRect;
    const observerVisible = !entry || Boolean(entry.isIntersecting
      && intersection?.width > 0 && intersection?.height > 0);
    state.inViewport = observerVisible && isVisible(element);
    apply(state, timestamp);
  }

  const observerCallback = (entries) => {
    const timestamp = clock();
    entries.forEach((entry) => updateVisibility(entry.target, timestamp, entry));
  };
  const Observer = globalThis.IntersectionObserver ?? view?.IntersectionObserver;
  const observer = createObserver ? createObserver(observerCallback)
    : Observer ? new Observer(observerCallback) : null;
  const refreshVisibility = () => {
    const timestamp = clock();
    states.forEach((state) => {
      state.inViewport = isVisible(state.element);
      apply(state, timestamp);
    });
  };
  const motionChanged = refreshVisibility;
  motion?.addEventListener?.('change', motionChanged);
  if (!motion?.addEventListener) motion?.addListener?.(motionChanged);
  view?.addEventListener?.('scroll', refreshVisibility, { passive: true, capture: true });
  view?.addEventListener?.('resize', refreshVisibility);

  function untrack(key, state) {
    stop(state.element);
    state.element.classList.remove('is-proposed-date-glowing');
    observer?.unobserve(state.element);
    byElement.delete(state.element);
    states.delete(key);
  }

  return {
    sync(scope, items) {
      const currentKeys = new Set();
      const timestamp = clock();
      (Array.isArray(items) ? items : []).forEach((item) => {
        if (!item?.element || item.key === undefined || item.key === null) return;
        const key = `${scope}:${item.key}`;
        currentKeys.add(key);
        let state = states.get(key);
        if (!state) {
          state = { element: item.element, inViewport: false };
          states.set(key, state);
          byElement.set(state.element, state);
          observer?.observe(state.element);
        } else if (state.element !== item.element) {
          stop(state.element);
          observer?.unobserve(state.element);
          byElement.delete(state.element);
          state.element = item.element;
          state.inViewport = false;
          byElement.set(state.element, state);
          observer?.observe(state.element);
        }
        state.inViewport = isVisible(state.element);
        apply(state, timestamp);
      });
      const previousKeys = scopeKeys.get(scope) ?? new Set();
      previousKeys.forEach((key) => {
        if (!currentKeys.has(key)) {
          const state = states.get(key);
          if (state) untrack(key, state);
        }
      });
      scopeKeys.set(scope, currentKeys);
    },
    dispose() {
      states.forEach((state, key) => untrack(key, state));
      scopeKeys.clear();
      observer?.disconnect();
      motion?.removeEventListener?.('change', motionChanged);
      if (!motion?.removeEventListener) motion?.removeListener?.(motionChanged);
      view?.removeEventListener?.('scroll', refreshVisibility, { capture: true });
      view?.removeEventListener?.('resize', refreshVisibility);
    },
  };
}

export function startRoomListPage() {
  const content = document.querySelector('#rooms-content');
  const cards = document.querySelector('#room-cards');
  const createForm = document.querySelector('#create-room-form');
  const createNavigation = document.querySelector('#create-room-navigation');
  const scheduleSection = document.querySelector('#upcoming-schedule');
  const scheduleRows = document.querySelector('#upcoming-schedule-rows');
  const message = document.querySelector('#rooms-message');
  const emptyState = document.querySelector('#rooms-empty');
  const noMatches = document.querySelector('#rooms-no-matches');
  const filters = [...document.querySelectorAll('#room-filters input[type="checkbox"]')];
  const displayName = document.querySelector('#rooms-display-name');
  const manageUsers = document.querySelector('#rooms-manage-users');
  const changePin = document.querySelector('#rooms-change-pin');
  const logout = document.querySelector('#rooms-logout');
  if (!content || !cards || !createForm || !message || !emptyState) return;

  createIconPicker(createForm, 'create-icon-picker', DEFAULT_ROOM_ICON);
  const cardNodes = new Map();
  const scheduleNodes = new Map();
  const scheduledEffects = createScheduledEffectController();
  const proposedGlow = createProposedGlowController();
  let currentRooms = [];
  const deletedRoomIds = new Set();
  let csrfToken = '';
  let sessionCheck = 0;
  let refreshSequence = 0;
  let rolloverTimer = null;
  let isLoading = false;
  let editDialog;
  const timePicker = createRoomTimePicker(createForm);

  function announce(text) {
    message.textContent = text;
  }

  function redirectToLogin() {
    sessionCheck += 1;
    window.clearTimeout(rolloverTimer);
    content.hidden = true;
    csrfToken = '';
    cards.replaceChildren();
    cardNodes.clear();
    scheduledEffects.sync('room-card', []);
    proposedGlow.sync('room-list', []);
    announce('');
    location.replace('/');
  }

  function createCard(room) {
    const article = document.createElement('article');
    article.className = 'room-card';
    article.dataset.roomId = room.id;
    const entry = document.createElement('a');
    entry.className = 'room-card__entry';
    entry.href = `/vote/${encodeURIComponent(room.id)}`;
    const number = addText(entry, 'span', `Room ${String(room.displayNumber).padStart(2, '0')}`);
    number.className = 'room-card__number';
    const owner = addText(entry, 'span', '');
    owner.className = 'room-card__owner';
    const identity = document.createElement('span');
    identity.className = 'room-card__identity';
    const icon = addText(identity, 'span', '');
    icon.className = 'room-card__icon';
    icon.setAttribute('aria-hidden', 'true');
    const iconLabel = addText(identity, 'span', '');
    iconLabel.className = 'room-card__icon-label visually-hidden';
    const title = addText(identity, 'span', '');
    title.className = 'room-card__title';
    identity.append(iconLabel, icon, title);
    const venue = addText(entry, 'span', '');
    venue.className = 'room-card__venue';
    const time = addText(entry, 'span', '');
    time.className = 'room-card__time';
    entry.append(identity, venue, time);
    article.append(entry);
    const scheduledLine = dateLine(article, 'room-card__dates room-card__dates--scheduled', 'Scheduled');
    const proposedLine = dateLine(article, 'room-card__dates room-card__dates--proposed', 'Proposed');
    entry.addEventListener('click', (event) => {
      event.preventDefault();
      void enterRoom(room.id, entry);
    });
    const summary = document.createElement('div');
    summary.className = 'room-card__summary';
    const voterCount = addText(summary, 'span', '0 voters');
    voterCount.className = 'room-card__voter-count';
    const actions = document.createElement('div');
    actions.className = 'room-card__actions';
    const edit = addText(actions, 'button', 'Edit');
    edit.type = 'button';
    edit.className = 'room-card__edit';
    const remove = addText(actions, 'button', '');
    remove.type = 'button';
    remove.className = 'room-card__delete';
    const trash = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    trash.setAttribute('viewBox', '0 0 24 24');
    trash.setAttribute('aria-hidden', 'true');
    trash.setAttribute('focusable', 'false');
    const trashPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    trashPath.setAttribute('d', 'M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5');
    trashPath.setAttribute('fill', 'none');
    trashPath.setAttribute('stroke', 'currentColor');
    trashPath.setAttribute('stroke-linecap', 'round');
    trashPath.setAttribute('stroke-linejoin', 'round');
    trashPath.setAttribute('stroke-width', '2');
    trash.append(trashPath);
    remove.append(trash);
    let node;
    edit.addEventListener('click', () => showEditDialog(node.room));
    remove.addEventListener('click', () => { void submitRoomDelete(node.room, remove); });
    summary.append(voterCount, actions);
    article.append(summary);
    node = {
      article, entry, number, owner, icon, iconLabel, title, venue, time, voterCount,
      scheduledLine, proposedLine, edit, remove, room,
    };
    return node;
  }

  function updateCard(node, room) {
    const icon = ICONS[room.icon] ?? ICONS[DEFAULT_ROOM_ICON];
    const today = getBangkokDate();
    const tomorrow = addDays(today, 1);
    node.room = room;
    node.article.style.setProperty('--room-color', room.color);
    node.article.classList.toggle('is-scheduled', Boolean(room.summary?.scheduledDates?.length));
    node.number.textContent = `Room ${String(room.displayNumber).padStart(2, '0')}`;
    node.owner.textContent = room.ownerDisplayName || 'Room owner';
    node.icon.textContent = icon.glyph;
    node.iconLabel.textContent = `${icon.label} icon`;
    node.title.textContent = room.title;
    node.venue.textContent = room.venue ?? '';
    node.venue.hidden = !room.venue;
    node.time.textContent = room.time ?? '';
    node.time.hidden = !room.time;
    const count = Number.isSafeInteger(room.voterCount) && room.voterCount >= 0 ? room.voterCount : 0;
    node.voterCount.textContent = `${count} ${count === 1 ? 'voter' : 'voters'}`;
    node.voterCount.setAttribute('aria-label', `${count} distinct voters with saved votes today or later in ${node.number.textContent}: ${room.title}`);
    node.entry.setAttribute('aria-label', `Enter ${node.number.textContent}: ${room.title}`);
    updateDateLine(node.scheduledLine, room.summary?.scheduledDates, room);
    updateDateLine(node.proposedLine, room.summary?.proposedDates, room, { today, tomorrow, glow: true });
    node.edit.hidden = !room.canEdit;
    node.edit.setAttribute('aria-label', `Edit ${room.title}`);
    node.remove.hidden = !room.canDelete;
    node.remove.setAttribute('aria-label', `Delete ${room.title}`);
  }

  function renderRooms(rooms) {
    const visibleRooms = rooms.filter(({ id }) => !deletedRoomIds.has(id));
    currentRooms = visibleRooms;
    const liveIds = new Set(visibleRooms.map(({ id }) => id));
    cardNodes.forEach((node, roomId) => {
      if (!liveIds.has(roomId)) {
        node.article.remove();
        cardNodes.delete(roomId);
      }
    });
    const myOnly = document.querySelector('#filter-my-voted')?.checked ?? false;
    const createdOnly = document.querySelector('#filter-my-created')?.checked ?? false;
    const scheduledOnly = document.querySelector('#filter-scheduled')?.checked ?? false;
    const proposedOnly = document.querySelector('#filter-proposed')?.checked ?? false;
    const hasStatusFilter = scheduledOnly || proposedOnly;
    let visibleCount = 0;
    const scheduled = [];
    const glowDates = [];
    visibleRooms.forEach((room, index) => {
      let node = cardNodes.get(room.id);
      if (!node) {
        node = createCard(room);
        cardNodes.set(room.id, node);
      }
      updateCard(node, room);
      const matchesPersonal = (!myOnly || room.myVoted === true)
        && (!createdOnly || room.myCreated === true);
      const matchesStatus = !hasStatusFilter
        || (scheduledOnly && Boolean(room.summary?.scheduledDates?.length))
        || (proposedOnly && Boolean(room.summary?.proposedDates?.length));
      node.article.hidden = !(matchesPersonal && matchesStatus);
      if (!node.article.hidden) visibleCount += 1;
      const current = cards.children[index];
      if (current !== node.article) cards.insertBefore(node.article, current ?? null);
      if (room.summary?.scheduledDates?.length) {
        scheduled.push({ key: room.id, element: node.article, scheduled: true });
      }
      node.proposedLine.nodes.forEach((element, date) => {
        if (element.classList.contains('is-proposed-date-glowing')) {
          glowDates.push({ key: `${room.id}:${date}`, element });
        }
      });
    });
    emptyState.hidden = visibleRooms.length > 0;
    if (noMatches) noMatches.hidden = visibleRooms.length === 0 || visibleCount > 0;
    scheduledEffects.sync('room-card', scheduled);
    proposedGlow.sync('room-list', glowDates);
  }

  function renderUpcomingSchedule(items) {
    if (!scheduleSection || !scheduleRows) return;
    const validItems = (Array.isArray(items) ? items : []).filter((item) => (
      item && typeof item.roomId === 'string' && item.roomId.length > 0
      && Number.isSafeInteger(item.displayNumber) && item.displayNumber > 0
      && typeof item.title === 'string' && formatScheduleDate(item.date)
    )).sort((left, right) => left.date.localeCompare(right.date)
      || left.displayNumber - right.displayNumber
      || left.title.localeCompare(right.title)
      || left.roomId.localeCompare(right.roomId));
    const activeKeys = new Set(validItems.map(({ roomId, date }) => `${roomId}:${date}`));
    scheduleNodes.forEach((node, key) => {
      if (activeKeys.has(key)) return;
      node.remove();
      scheduleNodes.delete(key);
    });
    const ordered = validItems.map((item) => {
      const key = `${item.roomId}:${item.date}`;
      const formatted = formatScheduleDate(item.date);
      let row = scheduleNodes.get(key);
      if (!row) {
        row = document.createElement('li');
        const link = document.createElement('a');
        link.className = 'upcoming-schedule__row';
        const identity = document.createElement('span');
        identity.className = 'upcoming-schedule__identity';
        const title = document.createElement('span');
        title.className = 'upcoming-schedule__title';
        const voters = createVoterNamesRegion(document, [], { emptyText: '' });
        voters.classList.add('upcoming-schedule__voters');
        identity.append(title, voters);
        const date = document.createElement('time');
        date.className = 'upcoming-schedule__date';
        link.append(identity, date);
        row.append(link);
        scheduleNodes.set(key, row);
      }
      const link = row.firstElementChild;
      const [identity, date] = link.children;
      const [title, previousVoters] = identity.children;
      link.href = `/vote/${encodeURIComponent(item.roomId)}?date=${encodeURIComponent(item.date)}`;
      const voters = Array.isArray(item.voters) ? item.voters : [];
      const voterNames = voters.map(({ name }) => String(name ?? '')).filter(Boolean);
      link.setAttribute('aria-label', `Room ${String(item.displayNumber).padStart(2, '0')}: ${item.title}; ${voterNames.length ? `Voters: ${voterNames.join(', ')}` : 'No voters'}; ${formatted.fullDate}`);
      title.textContent = `Room ${String(item.displayNumber).padStart(2, '0')}: ${item.title}`;
      const voterRegion = createVoterNamesRegion(document, voters, { emptyText: '' });
      voterRegion.classList.add('upcoming-schedule__voters');
      voterRegion.setAttribute('aria-label', voterNames.length ? `Voters: ${voterNames.join(', ')}` : 'No voters for this event');
      previousVoters.replaceWith(voterRegion);
      date.dateTime = item.date;
      date.setAttribute('aria-label', formatted.fullDate);
      date.textContent = formatted.shortDate;
      return row;
    });
    ordered.forEach((row, index) => {
      if (scheduleRows.children[index] !== row) scheduleRows.insertBefore(row, scheduleRows.children[index] ?? null);
    });
    scheduleSection.hidden = ordered.length === 0;
    if (ordered.length) configureVoterNamesMarquee(scheduleRows);
  }

  filters.forEach((filter) => filter.addEventListener('change', () => renderRooms(currentRooms)));

  createNavigation?.addEventListener('click', () => {
    const firstInput = createForm.querySelector('input[name="title"]');
    if (!firstInput) return;
    const behavior = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    createForm.scrollIntoView({ behavior, block: 'center' });
    firstInput.focus({ preventScroll: true });
  });

  function forgetDeletedRoom(roomId) {
    if (typeof roomId !== 'string' || roomId.length === 0) return;
    deletedRoomIds.add(roomId);
    refreshSequence += 1;
    renderRooms(currentRooms.filter(({ id }) => id !== roomId));
  }

  async function refreshRooms() {
    const sequence = ++refreshSequence;
    try {
      const response = await fetch('/api/rooms', { cache: 'no-store' });
      if (response.status === 401) {
        redirectToLogin();
        return false;
      }
      const result = await responseBody(response);
      if (!response.ok) throw new Error(result.message || 'Could not load rooms.');
      if (sequence !== refreshSequence) return false;
      if (!Array.isArray(result.rooms)) throw new Error('Room list response is invalid.');
      renderRooms(result.rooms);
      renderUpcomingSchedule(result.upcomingSchedule);
      return true;
    } catch {
      if (sequence === refreshSequence) announce('Could not load rooms. Please retry. / โหลดรายชื่อห้องไม่สำเร็จ');
      return false;
    }
  }

  async function enterRoom(roomId, entry) {
    if (entry.dataset.entering === 'true') return;
    entry.dataset.entering = 'true';
    entry.setAttribute('aria-busy', 'true');
    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/enter`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: '{}',
      });
      if (response.status === 401) {
        redirectToLogin();
        return;
      }
      const result = await responseBody(response);
      if (deletedRoomIds.has(roomId)) return;
      if (result.code === 'ROOM_NOT_FOUND') {
        forgetDeletedRoom(roomId);
        announce('This room is no longer available. / ห้องนี้ไม่มีแล้ว');
        void refreshRooms();
        return;
      }
      if (!response.ok || result.room?.id !== roomId) {
        announce(result.message || 'Could not enter this room. / ไม่สามารถเข้าห้องนี้ได้');
        return;
      }
      location.assign(`/vote/${encodeURIComponent(roomId)}`);
    } catch {
      announce('Could not enter this room. Please retry. / ไม่สามารถเข้าห้องนี้ได้ กรุณาลองอีกครั้ง');
    } finally {
      delete entry.dataset.entering;
      entry.removeAttribute('aria-busy');
    }
  }

  async function submitRoomDelete(room, button) {
    if (button.disabled) return false;
    const warning = `Permanently delete “${room.title}”? Its votes, proposals, schedules, and memberships will be permanently removed. This cannot be undone.`;
    if (!window.confirm(warning)) return false;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    announce('');
    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(room.id)}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({ confirmation: true }),
      });
      if (response.status === 401) {
        redirectToLogin();
        return false;
      }
      const result = await responseBody(response);
      if (result.code === 'ROOM_NOT_FOUND') {
        forgetDeletedRoom(room.id);
        announce('This room is no longer available. / ห้องนี้ไม่มีแล้ว');
        void refreshRooms();
        return false;
      }
      if (!response.ok) {
        announce(result.message || 'Could not delete this room. / ไม่สามารถลบห้องนี้ได้');
        return false;
      }
      if (result.deletedRoomId !== room.id) {
        announce('Could not verify the deleted room. Please refresh. / ตรวจสอบห้องที่ลบไม่สำเร็จ กรุณารีเฟรช');
        return false;
      }
      forgetDeletedRoom(room.id);
      announce(`Room “${room.title}” permanently deleted. / ลบห้อง “${room.title}” ถาวรแล้ว`);
      await refreshRooms();
      return true;
    } catch {
      announce('Could not delete this room. Please retry. / ไม่สามารถลบห้องนี้ได้ กรุณาลองอีกครั้ง');
      return false;
    } finally {
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  }

  async function loadSession() {
    const currentCheck = ++sessionCheck;
    content.hidden = true;
    csrfToken = '';
    try {
      const response = await fetch('/api/session', { cache: 'no-store' });
      if (currentCheck !== sessionCheck) return;
      if (!response.ok) {
        redirectToLogin();
        return;
      }
      const session = await response.json();
      if (currentCheck !== sessionCheck) return;
      csrfToken = session.csrfToken;
      displayName.textContent = session.displayName;
      manageUsers.hidden = session.role !== 'admin';
      content.hidden = false;
      await refreshRooms();
      scheduleBangkokDayRefresh();
    } catch {
      if (currentCheck === sessionCheck) redirectToLogin();
    }
  }

  function scheduleBangkokDayRefresh() {
    window.clearTimeout(rolloverTimer);
    rolloverTimer = window.setTimeout(async () => {
      await refreshRooms();
      scheduleBangkokDayRefresh();
    }, millisecondsUntilBangkokMidnight());
  }

  function showEditDialog(room) {
    if (!editDialog) {
      editDialog = document.createElement('dialog');
      editDialog.className = 'room-edit-dialog';
      editDialog.setAttribute('aria-labelledby', 'room-edit-heading');
      const form = document.createElement('form');
      form.id = 'room-edit-form';
      const heading = addText(form, 'h2', 'Edit room');
      heading.id = 'room-edit-heading';
      const label = document.createElement('label');
      label.htmlFor = 'room-edit-title';
      label.textContent = 'Room title / ชื่อห้อง';
      const input = document.createElement('input');
      input.id = 'room-edit-title';
      input.name = 'title';
      input.type = 'text';
      input.required = true;
      input.maxLength = 60;
      input.autocomplete = 'off';
      label.append(input);
      form.append(label);
      appendMetadataInput(form, {
        id: 'room-edit-venue', name: 'venue', labelText: 'Venue / สถานที่ (optional)',
      });
      appendMetadataInput(form, {
        id: 'room-edit-time', name: 'time', labelText: 'Time in Bangkok / เวลา (HH:mm)', time: true,
      });
      const picker = document.createElement('fieldset');
      picker.className = 'room-icon-picker';
      form.append(picker);
      const error = addText(form, 'p', '');
      error.id = 'room-edit-error';
      error.className = 'message';
      error.setAttribute('role', 'alert');
      const actions = document.createElement('div');
      actions.className = 'dialog-actions';
      const save = addText(actions, 'button', 'Save changes');
      save.type = 'submit';
      const cancel = addText(actions, 'button', 'Cancel');
      cancel.type = 'button';
      cancel.className = 'secondary';
      cancel.addEventListener('click', () => editDialog.close());
      form.append(actions);
      editDialog.append(form);
      document.body.append(editDialog);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        void submitRoomEdit(form, editDialog);
      });
      editDialog.addEventListener('cancel', () => editDialog.close());
    }
    const form = editDialog.querySelector('#room-edit-form');
    form.dataset.roomId = room.id;
    form.dataset.originalTitle = room.title;
    form.dataset.originalVenue = room.venue ?? '';
    form.dataset.originalTime = room.time ?? '';
    form.elements.title.value = room.title;
    form.elements.venue.value = room.venue ?? '';
    form.elements.time.value = room.time ?? '';
    createIconPicker(form, 'edit-icon-picker', room.icon);
    editDialog.querySelector('#room-edit-error').textContent = '';
    editDialog.showModal();
    form.elements.title.focus();
    form.elements.title.select();
  }

  async function submitRoomEdit(form, dialog) {
    const title = form.elements.title.value;
    const errorRegion = form.querySelector('#room-edit-error');
    const validations = [
      [form.elements.title, titleError(title)],
      [form.elements.venue, venueError(form.elements.venue.value)],
      [form.elements.time, timeError(form.elements.time.value)],
    ];
    const invalid = validations.find(([, error]) => error);
    if (invalid) {
      errorRegion.textContent = invalid[1];
      invalid[0].focus();
      return;
    }
    const roomId = form.dataset.roomId;
    const body = { icon: selectedIcon(form), venue: form.elements.venue.value, time: form.elements.time.value };
    if (title.trim() !== form.dataset.originalTitle) body.title = title;
    const save = form.querySelector('button[type="submit"]');
    save.disabled = true;
    try {
      const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify(body),
      });
      if (response.status === 401) {
        redirectToLogin();
        return;
      }
      const result = await responseBody(response);
      if (!response.ok) {
        errorRegion.textContent = result.message || 'Could not update this room. / ไม่สามารถแก้ไขห้องนี้ได้';
        return;
      }
      dialog.close();
      announce('Room updated. / อัปเดตห้องแล้ว');
      await refreshRooms();
    } catch {
      errorRegion.textContent = 'Could not update this room. Please retry. / ไม่สามารถแก้ไขห้องนี้ได้ กรุณาลองอีกครั้ง';
    } finally {
      save.disabled = false;
    }
  }

  createForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!timePicker.validate()) return;
    const title = createForm.elements.title.value;
    const validations = [
      [createForm.elements.title, titleError(title)],
      [createForm.elements.venue, venueError(createForm.elements.venue.value)],
      [createForm.elements.time, timeError(createForm.elements.time.value)],
    ];
    const invalid = validations.find(([, error]) => error);
    if (invalid) {
      if (invalid[0] === createForm.elements.time) {
        timePicker.showError(invalid[1]);
        timePicker.focus();
      } else {
        announce(invalid[1]);
        invalid[0].focus();
      }
      return;
    }
    const submit = createForm.querySelector('button[type="submit"]');
    if (isLoading) return;
    isLoading = true;
    submit.disabled = true;
    createForm.setAttribute('aria-busy', 'true');
    announce('');
    try {
      const response = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
        body: JSON.stringify({
          title,
          icon: selectedIcon(createForm),
          venue: createForm.elements.venue.value,
          time: createForm.elements.time.value,
        }),
      });
      if (response.status === 401) {
        redirectToLogin();
        return;
      }
      const result = await responseBody(response);
      if (!response.ok) {
        announce(result.message || 'Could not create room. / ไม่สามารถสร้างห้องได้');
        return;
      }
      createForm.reset();
      timePicker.reset();
      announce(`Room ${String(result.room.displayNumber).padStart(2, '0')} created. / สร้างห้องแล้ว`);
      await refreshRooms();
    } catch {
      announce('Could not create room. Please retry. / ไม่สามารถสร้างห้องได้ กรุณาลองอีกครั้ง');
    } finally {
      isLoading = false;
      submit.disabled = false;
      createForm.removeAttribute('aria-busy');
    }
  });

  logout?.addEventListener('click', async () => {
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST', headers: { 'x-csrf-token': csrfToken } });
      if (response.ok) location.replace('/');
      else announce('Could not log out. / ออกจากระบบไม่สำเร็จ');
    } catch {
      announce('Could not log out. / ออกจากระบบไม่สำเร็จ');
    }
  });
  const socket = window.io({ transports: ['websocket'] });
  socket.on('rooms:summary-changed', () => { void refreshRooms(); });
  socket.on('rooms:summary-state', () => { void refreshRooms(); });
  socket.on('room:deleted', ({ roomId }) => {
    forgetDeletedRoom(roomId);
    void refreshRooms();
  });
  socket.on('connect', () => { void refreshRooms(); });
  socket.on('auth:revoked', redirectToLogin);
  socket.on('connect_error', (error) => { if (error.message === 'unauthenticated') redirectToLogin(); });
  window.addEventListener('pageshow', loadSession);
  window.addEventListener('pagehide', () => window.clearTimeout(rolloverTimer));
  loadSession();
}

export { formatDates, formatRoomDate, titleError };
