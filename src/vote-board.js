const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
export const VOTER_MARQUEE_PIXELS_PER_SECOND = 7.1875;

function finiteNonNegative(value) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function formatDisplayDate(value) {
  const match = ISO_DATE.exec(value);
  if (!match) throw new RangeError('invalid ISO date');
  const month = Number(match[2]);
  const day = Number(match[3]);
  const year = Number(match[1]);
  const daysInMonth = month === 2
    ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28)
    : [4, 6, 9, 11].includes(month) ? 30 : 31;
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) throw new RangeError('invalid ISO date');
  return `${day} ${MONTHS[month - 1]}`;
}

export function colorForDay(voteCount, weeklyMaximum) {
  const count = Number.isFinite(voteCount) ? Math.max(0, voteCount) : 0;
  const maximum = Number.isFinite(weeklyMaximum) ? Math.max(0, weeklyMaximum) : 0;
  if (count === 0 || maximum === 0) {
    return { background: '#0b3d2e', foreground: '#ffffff', brightness: 0 };
  }
  const brightness = Math.min(1, count / maximum);
  const lightness = Math.round(20 + brightness * 10);
  return {
    background: `hsl(152 63% ${lightness}%)`,
    foreground: '#ffffff',
    brightness,
  };
}

export function getVoteCardPresentation({ selected = false, eligible = true } = {}) {
  const isSelected = Boolean(selected);
  const isEligible = Boolean(eligible);
  return {
    cardClassName: `vote-card${isSelected ? ' is-selected' : ''}${isEligible ? '' : ' is-read-only'}`,
    countClassName: `vote-card__count${isSelected ? ' vote-card__count--selected' : ''}`,
    ariaPressed: String(isSelected),
    ariaDisabled: String(!isEligible),
    disabled: !isEligible,
    accessibleState: isEligible ? 'Available to vote' : 'Read-only; voting unavailable',
    visibleStatusText: '',
  };
}

export function applyVoteCardPresentation(card, { selected = false, eligible = true, voteCount } = {}) {
  const presentation = getVoteCardPresentation({ selected, eligible });
  card.classList.add('vote-card');
  card.classList.toggle('is-selected', selected);
  card.classList.toggle('is-read-only', !eligible);
  card.dataset.selected = String(Boolean(selected));
  card.dataset.eligible = String(Boolean(eligible));
  card.setAttribute('aria-pressed', presentation.ariaPressed);
  card.setAttribute('aria-disabled', presentation.ariaDisabled);
  card.disabled = presentation.disabled;
  const count = card.querySelector('.vote-card__count');
  if (count) {
    count.classList.toggle('vote-card__count--selected', selected);
    if (voteCount !== undefined) count.textContent = String(voteCount);
  }
  return presentation;
}

export function marqueeDurationForDistance(loopDistance) {
  const distance = finiteNonNegative(loopDistance);
  return distance / VOTER_MARQUEE_PIXELS_PER_SECOND;
}

export function marqueeTravelDistance(containerWidth, textWidth) {
  return finiteNonNegative(containerWidth) + finiteNonNegative(textWidth);
}

export function marqueeDurationForDimensions(containerWidth, textWidth) {
  return marqueeDurationForDistance(marqueeTravelDistance(containerWidth, textWidth));
}

export function createVoterNamesRegion(document, names) {
  const voterNames = Array.isArray(names) ? names : [];
  const region = document.createElement('div');
  region.className = 'vote-card__names';
  region.setAttribute('aria-label', voterNames.length
    ? 'รายชื่อผู้เลือก / Voter names'
    : 'รายชื่อผู้เลือก / Voter names: ยังไม่มีผู้เลือก / No voters');
  region.setAttribute('data-has-voters', String(voterNames.length > 0));

  const track = document.createElement('div');
  track.className = 'vote-card__names-track';
  const canonical = document.createElement('span');
  canonical.className = 'vote-card__names-copy vote-card__names-copy--canonical';
  if (voterNames.length) {
    voterNames.forEach((name, index) => {
      if (index) canonical.append(document.createTextNode(', '));
      canonical.append(document.createTextNode(String(name)));
    });
  } else {
    const empty = document.createElement('span');
    empty.className = 'vote-card__names-empty';
    empty.textContent = '—';
    canonical.append(empty);
  }
  track.append(canonical);
  region.append(track);
  return region;
}

function prefersReducedMotion(region, reducedMotion) {
  if (reducedMotion !== undefined) return reducedMotion;
  const view = region.ownerDocument?.defaultView;
  return Boolean(view?.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

function configureVoterNamesRegion(region, options = {}) {
  const track = region.querySelector('.vote-card__names-track');
  if (!track || region.getAttribute('data-has-voters') !== 'true') return;
  if (prefersReducedMotion(region, options.reducedMotion)) {
    track.style.setProperty('animation', 'none');
    return;
  }
  const containerWidth = region.clientWidth;
  const textWidth = track.scrollWidth;
  track.style.setProperty('--vote-marquee-start', `${containerWidth}px`);
  track.style.setProperty('--vote-marquee-end', `${-textWidth}px`);
  track.style.setProperty('--vote-marquee-duration', `${marqueeDurationForDimensions(containerWidth, textWidth)}s`);
}

export function configureVoterNamesMarquee(root, options = {}) {
  const regions = root.matches?.('.vote-card__names') || root.getAttribute?.('data-has-voters') !== null
    ? [root]
    : [...root.querySelectorAll('.vote-card__names')];
  regions.forEach((region) => configureVoterNamesRegion(region, options));
}

export function recalculateVoteColors(weekDays) {
  const cards = [...weekDays.querySelectorAll('.vote-card')];
  const weeklyMaximum = Math.max(...cards.map((card) => Number(card.querySelector('.vote-card__count')?.textContent) || 0), 0);
  cards.forEach((card) => {
    const count = Number(card.querySelector('.vote-card__count')?.textContent) || 0;
    const colors = colorForDay(count, weeklyMaximum);
    card.style.setProperty('--day-bg', colors.background);
    card.style.setProperty('--day-fg', colors.foreground);
  });
}

export function patchVoteDay({ weekDays, patch, createVoterNamesRegion, configureVoterNamesMarquee: configureMarquee }) {
  const card = weekDays.querySelector('.vote-card[data-date="' + patch.date + '"]');
  if (!card) return false;
  const eligible = card.dataset.eligible !== 'false';
  const presentation = applyVoteCardPresentation(card, {
    selected: patch.selected,
    eligible,
    voteCount: patch.voteCount,
  });
  card.setAttribute('aria-label', (card.getAttribute('aria-label') ?? '')
    .replace(/, [0-9]+ votes,.*$/, ', ' + patch.voteCount + ' votes, ' + presentation.accessibleState));
  const namesRegion = createVoterNamesRegion(patch.voterNames);
  card.querySelector('.vote-card__names').replaceWith(namesRegion);
  configureMarquee?.(namesRegion);
  recalculateVoteColors(weekDays);
  return true;
}

export function createSocketRepairController({ loadWeek, patchDay }) {
  let repairing = false;
  const queuedPatches = [];
  return {
    handlePatch(patch) {
      if (repairing) queuedPatches.push(patch);
      else patchDay(patch);
    },
    async handleConnect() {
      repairing = true;
      try {
        await loadWeek();
      } finally {
        repairing = false;
        queuedPatches.splice(0).forEach(patchDay);
      }
    },
  };
}

export function getVoteTimelinePresentation(days, { scheduledDates = [] } = {}) {
  const normalized = (Array.isArray(days) ? days : []).map(({ date, voteCount }) => ({
    date,
    voteCount: Number.isSafeInteger(voteCount) && voteCount >= 0 ? voteCount : 0,
  }));
  const scheduled = new Set(Array.isArray(scheduledDates) ? scheduledDates : []);
  const maximum = Math.max(0, ...normalized.map(({ voteCount }) => voteCount));
  return normalized.map(({ date, voteCount }) => {
    const displayDate = formatDisplayDate(date);
    const [dayLabel, monthLabel] = displayDate.split(' ');
    const isTopRanked = maximum > 0 && voteCount === maximum;
    const isScheduled = scheduled.has(date);
    return {
      date,
      dayLabel,
      monthLabel,
      voteCount,
      barHeightPercent: maximum > 0 ? (voteCount / maximum) * 100 : 0,
      isTopRanked,
      showTopCue: isTopRanked,
      showCount: voteCount > 0,
      isScheduled,
      accessibleLabel: `${displayDate}, ${voteCount} ${voteCount === 1 ? 'vote' : 'votes'}${isTopRanked ? ', highest-vote date' : ''}${isScheduled ? ', scheduled run' : ''}`,
    };
  });
}

export function createScheduledEffectController({
  createObserver,
  createMotionQuery = (query) => globalThis.matchMedia?.(query),
  now = () => globalThis.performance?.now?.() ?? Date.now(),
} = {}) {
  const states = new Map();
  const statesByElement = new Map();
  const scopeKeys = new Map();
  const fallbackView = globalThis.window;
  const cycleMs = 1400;
  const motionQuery = createMotionQuery('(prefers-reduced-motion: reduce)');

  function currentDelay(timestamp = now()) {
    const elapsed = ((timestamp % cycleMs) + cycleMs) % cycleMs;
    return `-${Math.floor(elapsed)}ms`;
  }

  function stopTargets(targets) {
    targets.forEach((target) => {
      target.classList.remove('is-beam-running');
      target.style?.removeProperty('--beam-delay');
    });
  }

  function applyState(state, delay = currentDelay()) {
    const active = state.inViewport && !motionQuery?.matches;
    state.targets.forEach((target) => {
      if (active) {
        target.style?.setProperty('--beam-delay', delay);
        target.classList.add('is-beam-running');
      } else {
        target.classList.remove('is-beam-running');
        target.style?.removeProperty('--beam-delay');
      }
    });
  }

  function isElementVisible(element) {
    const view = element.ownerDocument?.defaultView ?? fallbackView;
    const bounds = element.getBoundingClientRect?.();
    if (!bounds || !view) return false;
    let left = Math.max(0, bounds.left);
    let right = Math.min(view.innerWidth, bounds.right);
    let top = Math.max(0, bounds.top);
    let bottom = Math.min(view.innerHeight, bounds.bottom);
    for (let ancestor = element.parentElement; ancestor && (right > left && bottom > top); ancestor = ancestor.parentElement) {
      const style = view.getComputedStyle?.(ancestor);
      if (!style) continue;
      const clipX = ['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowX);
      const clipY = ['hidden', 'clip', 'auto', 'scroll'].includes(style.overflowY);
      if (!clipX && !clipY) continue;
      const clip = ancestor.getBoundingClientRect();
      if (clipX) {
        left = Math.max(left, clip.left);
        right = Math.min(right, clip.right);
      }
      if (clipY) {
        top = Math.max(top, clip.top);
        bottom = Math.min(bottom, clip.bottom);
      }
    }
    const elementStyle = view.getComputedStyle?.(element);
    return right > left && bottom > top && elementStyle?.visibility !== 'hidden';
  }

  function updateVisibility(element, isIntersecting, delay = currentDelay()) {
    const state = statesByElement.get(element);
    if (!state) return;
    const visible = typeof element.getBoundingClientRect === 'function' ? isElementVisible(element) : isIntersecting;
    if (state.inViewport === visible) return;
    state.inViewport = visible;
    applyState(state, delay);
  }

  const observerCallback = (entries) => {
    const delay = currentDelay();
    entries.forEach(({ target, isIntersecting }) => updateVisibility(target, isIntersecting, delay));
  };
  const Observer = globalThis.IntersectionObserver ?? fallbackView?.IntersectionObserver;
  const observer = createObserver
    ? createObserver(observerCallback)
    : Observer ? new Observer(observerCallback) : null;

  function fallbackVisibility() {
    if (!fallbackView) return;
    const width = fallbackView.innerWidth;
    const height = fallbackView.innerHeight;
    const delay = currentDelay();
    statesByElement.forEach((state, element) => {
      const bounds = element.getBoundingClientRect?.();
      if (!bounds) return;
      updateVisibility(element, bounds.bottom > 0 && bounds.right > 0 && bounds.top < height && bounds.left < width, delay);
    });
  }

  function handleMotionChange() {
    const delay = currentDelay();
    states.forEach((state) => applyState(state, delay));
  }

  motionQuery?.addEventListener?.('change', handleMotionChange);
  if (!motionQuery?.addEventListener) motionQuery?.addListener?.(handleMotionChange);
  if (fallbackView?.addEventListener) {
    fallbackView.addEventListener('scroll', fallbackVisibility, { passive: true, capture: true });
    fallbackView.addEventListener('resize', fallbackVisibility);
  }
  fallbackView?.document?.addEventListener('scroll', fallbackVisibility, { passive: true, capture: true });
  fallbackView?.visualViewport?.addEventListener('scroll', fallbackVisibility, { passive: true });

  function untrack(key, state) {
    stopTargets(state.targets);
    observer?.unobserve(state.element);
    statesByElement.delete(state.element);
    states.delete(key);
  }

  return {
    sync(scope, items) {
      const currentKeys = new Set();
      const delay = currentDelay();
      (Array.isArray(items) ? items : []).forEach((item) => {
        if (!item?.scheduled || !item.element || item.key === undefined || item.key === null) return;
        const key = `${scope}:${item.key}`;
        currentKeys.add(key);
        const targets = Array.isArray(item.targets) && item.targets.length ? item.targets : [item.element];
        let state = states.get(key);
        if (!state) {
          state = { element: item.element, targets, inViewport: false };
          states.set(key, state);
          statesByElement.set(state.element, state);
          observer?.observe(state.element);
        } else {
          if (state.element !== item.element) {
            stopTargets(state.targets);
            observer?.unobserve(state.element);
            statesByElement.delete(state.element);
            state.element = item.element;
            state.inViewport = false;
            statesByElement.set(state.element, state);
            observer?.observe(state.element);
          }
          state.targets.forEach((target) => {
            if (!targets.includes(target)) stopTargets([target]);
          });
          state.targets = targets;
        }
        state.inViewport = isElementVisible(state.element);
        applyState(state, delay);
      });
      const previousKeys = scopeKeys.get(scope) ?? new Set();
      previousKeys.forEach((key) => {
        if (!currentKeys.has(key)) {
          const state = states.get(key);
          if (state) untrack(key, state);
        }
      });
      scopeKeys.set(scope, currentKeys);
      states.forEach((state) => applyState(state, delay));
      fallbackVisibility();
    },
    dispose() {
      states.forEach((state, key) => untrack(key, state));
      scopeKeys.clear();
      observer?.disconnect();
      motionQuery?.removeEventListener?.('change', handleMotionChange);
      if (!motionQuery?.removeEventListener) motionQuery?.removeListener?.(handleMotionChange);
      if (fallbackView?.removeEventListener) {
        fallbackView.removeEventListener('scroll', fallbackVisibility, { capture: true });
        fallbackView.removeEventListener('resize', fallbackVisibility);
      }
      fallbackView?.document?.removeEventListener('scroll', fallbackVisibility, { capture: true });
      fallbackView?.visualViewport?.removeEventListener('scroll', fallbackVisibility);
    },
  };
}

export function createVoteTimelineController({ render }) {
  let daysByDate = new Map();
  let scheduledDates = [];
  let refreshSequence = 0;
  let patchSequence = 0;
  let activeRefreshSequence = 0;
  const pendingPatches = new Map();

  function renderCurrent() {
    render(getVoteTimelinePresentation([...daysByDate.values()], { scheduledDates }));
  }

  return {
    async refresh(loadTotals) {
      const sequence = ++refreshSequence;
      const patchSequenceAtStart = patchSequence;
      pendingPatches.forEach((patch, date) => {
        if (patch.sequence <= patchSequenceAtStart) pendingPatches.delete(date);
      });
      activeRefreshSequence = sequence;
      let totals;
      try {
        totals = await loadTotals();
      } finally {
        if (activeRefreshSequence === sequence) activeRefreshSequence = 0;
      }
      if (sequence !== refreshSequence) return false;
      daysByDate = new Map((Array.isArray(totals?.days) ? totals.days : []).map(({ date, voteCount }) => [date, { date, voteCount }]));
      scheduledDates = Array.isArray(totals?.scheduledDates) ? [...totals.scheduledDates] : [];
      pendingPatches.forEach(({ voteCount, sequence: patchVersion }, date) => {
        if (patchVersion > patchSequenceAtStart && daysByDate.has(date)) daysByDate.set(date, { date, voteCount });
      });
      pendingPatches.clear();
      renderCurrent();
      return true;
    },
    patch({ date, voteCount }) {
      const count = Number.isSafeInteger(voteCount) && voteCount >= 0 ? voteCount : 0;
      const sequence = ++patchSequence;
      if (activeRefreshSequence) pendingPatches.set(date, { voteCount: count, sequence });
      const current = daysByDate.get(date);
      if (!current) return false;
      if (current.voteCount === count) return true;
      daysByDate.set(date, { date, voteCount: count });
      renderCurrent();
      return true;
    },
  };
}
