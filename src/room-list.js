import { DEFAULT_ROOM_ICON, ROOM_ICONS } from './room-contract.js';
import { createScheduledEffectController } from './vote-board.js';
import { millisecondsUntilBangkokMidnight } from './run-events.js';

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
    : 'None';
}

function titleError(value) {
  const title = value.trim();
  const length = Array.from(title).length;
  if (length === 0) return 'Enter a room title. / กรุณาระบุชื่อห้อง';
  if (length > 30) return 'Room title must be 30 characters or fewer. / ชื่อห้องต้องไม่เกิน 30 ตัวอักษร';
  return '';
}

function createIconPicker(form, pickerId, selectedIcon) {
  const picker = document.createElement('fieldset');
  picker.className = 'room-icon-picker';
  picker.id = pickerId;
  addText(picker, 'legend', 'Choose a sports or event icon / เลือกไอคอนกีฬา');
  ROOM_ICONS.forEach((icon) => {
    const option = ICONS[icon];
    if (!option) return;
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'icon';
    input.value = icon;
    input.checked = icon === selectedIcon;
    input.defaultChecked = icon === selectedIcon;
    label.append(input);
    const glyph = addText(label, 'span', option.glyph);
    glyph.setAttribute('aria-hidden', 'true');
    addText(label, 'span', option.label);
    picker.append(label);
  });
  form.querySelector('.room-icon-picker')?.replaceWith(picker);
  if (!form.querySelector('.room-icon-picker')) form.append(picker);
  return picker;
}

function selectedIcon(form) {
  return new FormData(form).get('icon') || DEFAULT_ROOM_ICON;
}

function dateLine(parent, className, label, values) {
  const line = document.createElement('p');
  line.className = className;
  addText(line, 'strong', `${label}: `);
  line.append(document.createTextNode(formatDates(values)));
  parent.append(line);
  return line;
}

function updateDateLine(line, label, values) {
  line.replaceChildren();
  addText(line, 'strong', `${label}: `);
  line.append(document.createTextNode(formatDates(values)));
}

async function responseBody(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

export function startRoomListPage() {
  const content = document.querySelector('#rooms-content');
  const cards = document.querySelector('#room-cards');
  const createForm = document.querySelector('#create-room-form');
  const message = document.querySelector('#rooms-message');
  const emptyState = document.querySelector('#rooms-empty');
  const displayName = document.querySelector('#rooms-display-name');
  const manageUsers = document.querySelector('#rooms-manage-users');
  const changePin = document.querySelector('#rooms-change-pin');
  const logout = document.querySelector('#rooms-logout');
  if (!content || !cards || !createForm || !message || !emptyState) return;

  createIconPicker(createForm, 'create-icon-picker', DEFAULT_ROOM_ICON);
  const cardNodes = new Map();
  const scheduledEffects = createScheduledEffectController();
  let csrfToken = '';
  let sessionCheck = 0;
  let refreshSequence = 0;
  let rolloverTimer = null;
  let isLoading = false;
  let editDialog;

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
    const identity = document.createElement('span');
    identity.className = 'room-card__identity';
    const icon = addText(identity, 'span', '');
    icon.className = 'room-card__icon';
    icon.setAttribute('aria-hidden', 'true');
    const iconLabel = addText(identity, 'span', '');
    iconLabel.className = 'visually-hidden';
    const title = addText(identity, 'span', '');
    title.className = 'room-card__title';
    entry.append(identity);
    const scheduledLine = document.createElement('p');
    scheduledLine.className = 'room-card__dates room-card__dates--scheduled';
    const proposedLine = document.createElement('p');
    proposedLine.className = 'room-card__dates room-card__dates--proposed';
    entry.append(scheduledLine, proposedLine);
    entry.addEventListener('click', (event) => {
      event.preventDefault();
      void enterRoom(room.id, entry);
    });
    article.append(entry);
    const actions = document.createElement('div');
    actions.className = 'room-card__actions';
    const edit = addText(actions, 'button', 'Edit');
    edit.type = 'button';
    edit.className = 'room-card__edit';
    let node;
    edit.addEventListener('click', () => showEditDialog(node.room));
    article.append(actions);
    node = { article, entry, number, icon, iconLabel, title, scheduledLine, proposedLine, edit, room };
    return node;
  }

  function updateCard(node, room) {
    const icon = ICONS[room.icon] ?? ICONS[DEFAULT_ROOM_ICON];
    node.room = room;
    node.article.style.setProperty('--room-color', room.color);
    node.article.classList.toggle('is-scheduled', Boolean(room.summary?.scheduledDates?.length));
    node.number.textContent = `Room ${String(room.displayNumber).padStart(2, '0')}`;
    node.icon.textContent = icon.glyph;
    node.iconLabel.textContent = `${icon.label} icon`;
    node.title.textContent = room.title;
    node.entry.setAttribute('aria-label', `Enter ${node.number.textContent}: ${room.title}`);
    updateDateLine(node.scheduledLine, 'Scheduled', room.summary?.scheduledDates);
    updateDateLine(node.proposedLine, 'Proposed', room.summary?.proposedDates);
    node.edit.hidden = !room.canEdit;
    node.edit.setAttribute('aria-label', `Edit ${room.title}`);
  }

  function renderRooms(rooms) {
    const liveIds = new Set(rooms.map(({ id }) => id));
    cardNodes.forEach((node, roomId) => {
      if (!liveIds.has(roomId)) {
        node.article.remove();
        cardNodes.delete(roomId);
      }
    });
    rooms.forEach((room, index) => {
      let node = cardNodes.get(room.id);
      if (!node) {
        node = createCard(room);
        cardNodes.set(room.id, node);
      }
      updateCard(node, room);
      const current = cards.children[index];
      if (current !== node.article) cards.insertBefore(node.article, current ?? null);
    });
    emptyState.hidden = rooms.length > 0;
    const scheduled = rooms.filter(({ summary }) => summary?.scheduledDates?.length)
      .map((room) => ({ key: room.id, element: cardNodes.get(room.id).article, scheduled: true }));
    scheduledEffects.sync('room-card', scheduled);
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
    form.elements.title.value = room.title;
    createIconPicker(form, 'edit-icon-picker', room.icon);
    editDialog.querySelector('#room-edit-error').textContent = '';
    editDialog.showModal();
    form.elements.title.focus();
    form.elements.title.select();
  }

  async function submitRoomEdit(form, dialog) {
    const title = form.elements.title.value;
    const error = titleError(title);
    const errorRegion = form.querySelector('#room-edit-error');
    if (error) {
      errorRegion.textContent = error;
      form.elements.title.focus();
      return;
    }
    const roomId = form.dataset.roomId;
    const body = { icon: selectedIcon(form) };
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
    const title = createForm.elements.title.value;
    const error = titleError(title);
    const titleInput = createForm.elements.title;
    if (error) {
      announce(error);
      titleInput.focus();
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
        body: JSON.stringify({ title, icon: selectedIcon(createForm) }),
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
  socket.on('connect', () => { void refreshRooms(); });
  socket.on('auth:revoked', redirectToLogin);
  socket.on('connect_error', (error) => { if (error.message === 'unauthenticated') redirectToLogin(); });
  window.addEventListener('pageshow', loadSession);
  window.addEventListener('pagehide', () => window.clearTimeout(rolloverTimer));
  loadSession();
}

export { formatDates, formatRoomDate, titleError };
