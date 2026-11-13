const ICONS = Object.freeze({
  person: 'M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z',
  lock: 'M5 10h14v11H5zM8 10V7a4 4 0 0 1 8 0v3m-4 4v3',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m7-10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm6-7a4 4 0 0 1 0 8m3 3h2a4 4 0 0 1 3 2.65V21',
  logout: 'M10 17l5-5-5-5m5 5H3m9-9h6a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3h-6',
  chevron: 'm7 10 5 5 5-5',
});

function addIcon(parent, kind) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICONS[kind]);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  path.setAttribute('stroke-width', '1.8');
  svg.append(path);
  parent.append(svg);
  return svg;
}

function initialFor(displayName) {
  const name = typeof displayName === 'string' ? displayName.trim() : '';
  if (!name) return '';
  let initial;
  if (typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    initial = segmenter.segment(name)[Symbol.iterator]().next().value?.segment ?? '';
  } else {
    initial = Array.from(name)[0] ?? '';
  }
  return /[\p{L}\p{N}]/u.test(initial) ? initial.toLocaleUpperCase() : '';
}

function visibleFocusables(excludedRoot) {
  return [...document.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter((element) => !excludedRoot.contains(element)
      && !element.closest('[hidden]')
      && element.getClientRects().length > 0
      && getComputedStyle(element).visibility !== 'hidden');
}

export function mountProfileMenu(root, { displayName, role, returnTo }) {
  if (!root) return { destroy() {} };
  const name = typeof displayName === 'string' ? displayName : '';
  const roleLabel = role === 'admin' ? 'Admin' : 'Member';
  const destination = typeof returnTo === 'string' && (returnTo === '/rooms' || /^\/vote\/[0-9a-f-]+$/.test(returnTo))
    ? returnTo
    : '/rooms';
  const menuId = `${root.id || 'profile-menu'}-panel`;
  root.replaceChildren();
  root.classList.add('profile-menu');

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'profile-menu__trigger';
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', menuId);
  trigger.setAttribute('aria-label', `Profile menu for ${name}`);
  const avatar = document.createElement('span');
  avatar.className = 'profile-menu__avatar';
  avatar.setAttribute('aria-hidden', 'true');
  const initial = initialFor(name);
  if (initial) avatar.textContent = initial;
  else addIcon(avatar, 'person');
  const triggerName = document.createElement('span');
  triggerName.className = 'profile-menu__trigger-name';
  triggerName.textContent = name;
  const chevron = document.createElement('span');
  chevron.className = 'profile-menu__chevron';
  chevron.setAttribute('aria-hidden', 'true');
  addIcon(chevron, 'chevron');
  trigger.append(avatar, triggerName, chevron);

  const panel = document.createElement('div');
  panel.id = menuId;
  panel.className = 'profile-menu__panel';
  panel.setAttribute('role', 'menu');
  panel.setAttribute('aria-label', 'Profile actions');
  panel.setAttribute('aria-orientation', 'vertical');
  panel.hidden = true;

  const identity = document.createElement('div');
  identity.className = 'profile-menu__identity';
  identity.setAttribute('role', 'group');
  identity.setAttribute('aria-label', `Signed in as ${name}, ${roleLabel}`);
  const identityLabel = document.createElement('span');
  identityLabel.className = 'profile-menu__identity-label';
  identityLabel.textContent = 'Signed in as';
  const identityName = document.createElement('strong');
  identityName.className = 'profile-menu__identity-name';
  identityName.textContent = name;
  const identityRole = document.createElement('span');
  identityRole.className = 'profile-menu__identity-role';
  identityRole.textContent = roleLabel;
  identity.append(identityLabel, identityName, identityRole);
  panel.append(identity, separator());

  const changePin = createLink('Change PIN', 'lock', `/change-pin?returnTo=${encodeURIComponent(destination)}`);
  panel.append(changePin);
  if (role === 'admin') {
    panel.append(createLink('Manage users', 'users', `/admin?returnTo=${encodeURIComponent(destination)}`));
  }
  panel.append(separator());

  const logout = document.createElement('button');
  logout.type = 'button';
  logout.className = 'profile-menu__action profile-menu__logout';
  logout.setAttribute('role', 'menuitem');
  addIcon(logout, 'logout');
  const logoutLabel = document.createElement('span');
  logoutLabel.textContent = 'Logout';
  logout.append(logoutLabel);
  panel.append(logout);

  const statusGroup = document.createElement('div');
  statusGroup.className = 'profile-menu__status-group';
  statusGroup.setAttribute('role', 'group');
  statusGroup.setAttribute('aria-label', 'Logout status');
  statusGroup.hidden = true;
  const status = document.createElement('p');
  status.className = 'profile-menu__status';
  status.setAttribute('role', 'alert');
  statusGroup.append(status);
  panel.append(statusGroup);
  root.append(trigger, panel);

  let isOpen = false;
  let destroyed = false;
  let csrfToken = '';
  const menuItems = () => [...panel.querySelectorAll('[role="menuitem"]')].filter((item) => !item.disabled);
  const updatePanelConstraint = () => {
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const availableHeight = Math.max(0, Math.floor(viewportHeight - trigger.getBoundingClientRect().bottom - 26));
    panel.style.maxHeight = `${Math.min(512, availableHeight)}px`;
  };
  const setOpen = (open, focus = false) => {
    if (destroyed) return;
    if (open) updatePanelConstraint();
    isOpen = open;
    panel.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
    if (open && focus) (menuItems()[0] ?? trigger).focus();
  };
  const close = (returnFocus = false) => {
    setOpen(false);
    if (returnFocus) trigger.focus();
  };
  const openTo = (index = 0) => {
    setOpen(true);
    const items = menuItems();
    items[Math.max(0, Math.min(index, items.length - 1))]?.focus();
  };
  const onTriggerClick = () => {
    if (isOpen) close();
    else openTo(0);
  };
  const onTriggerKeydown = (event) => {
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      if (isOpen) close();
      else openTo(0);
    } else if (event.key === 'ArrowDown' || event.key === 'Home') {
      event.preventDefault();
      openTo(0);
    } else if (event.key === 'ArrowUp' || event.key === 'End') {
      event.preventDefault();
      openTo(menuItems().length - 1);
    } else if (event.key === 'Escape' && isOpen) {
      event.preventDefault();
      close(true);
    }
  };
  const onMenuKeydown = (event) => {
    const items = menuItems();
    const currentIndex = items.indexOf(document.activeElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      items[(currentIndex + step + items.length) % items.length]?.focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      items.at(-1)?.focus();
    } else if (event.key === 'Tab') {
      const next = visibleFocusables(root);
      const from = trigger.compareDocumentPosition(root) & Node.DOCUMENT_POSITION_FOLLOWING ? trigger : root;
      const following = next.find((element) => from.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING);
      const previous = next.filter((element) => element.compareDocumentPosition(trigger) & Node.DOCUMENT_POSITION_FOLLOWING).at(-1);
      const target = event.shiftKey ? previous : following;
      close();
      if (target) {
        event.preventDefault();
        target.focus();
      }
    }
  };
  const onDocumentPointerDown = (event) => {
    if (!root.contains(event.target)) close();
  };
  const onViewportChange = () => { if (isOpen) updatePanelConstraint(); };
  const onLogout = async () => {
    logout.disabled = true;
    status.textContent = '';
    statusGroup.hidden = true;
    try {
      const response = await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'x-csrf-token': csrfToken },
      });
      if (response.ok || response.status === 401) {
        location.replace('/');
        return;
      }
      status.textContent = 'Could not log out. Please retry.';
      statusGroup.hidden = false;
    } catch {
      status.textContent = 'Could not log out. Please retry.';
      statusGroup.hidden = false;
    } finally {
      logout.disabled = false;
    }
  };

  trigger.addEventListener('click', onTriggerClick);
  trigger.addEventListener('keydown', onTriggerKeydown);
  panel.addEventListener('keydown', onMenuKeydown);
  logout.addEventListener('click', onLogout);
  document.addEventListener('pointerdown', onDocumentPointerDown);
  window.addEventListener('resize', onViewportChange);
  window.addEventListener('scroll', onViewportChange, true);

  return {
    setCsrfToken(token) { csrfToken = typeof token === 'string' ? token : ''; },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      csrfToken = '';
      document.removeEventListener('pointerdown', onDocumentPointerDown);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
      trigger.removeEventListener('click', onTriggerClick);
      trigger.removeEventListener('keydown', onTriggerKeydown);
      panel.removeEventListener('keydown', onMenuKeydown);
      logout.removeEventListener('click', onLogout);
      root.replaceChildren();
      root.classList.remove('profile-menu');
    },
  };
}

function createLink(label, iconName, href) {
  const link = document.createElement('a');
  link.className = 'profile-menu__action';
  link.href = href;
  link.setAttribute('role', 'menuitem');
  addIcon(link, iconName);
  const text = document.createElement('span');
  text.textContent = label;
  link.append(text);
  return link;
}

function separator() {
  const element = document.createElement('div');
  element.className = 'profile-menu__separator';
  element.setAttribute('role', 'separator');
  return element;
}
