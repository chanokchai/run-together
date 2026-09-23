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
  const travelDistance = marqueeTravelDistance(containerWidth, textWidth);
  track.style.setProperty('--vote-marquee-start', `${containerWidth}px`);
  track.style.setProperty('--vote-marquee-end', `${-travelDistance}px`);
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
  card.dataset.selected = String(patch.selected);
  card.classList.toggle('is-selected', patch.selected);
  card.setAttribute('aria-pressed', String(patch.selected));
  card.querySelector('.vote-card__count').textContent = String(patch.voteCount);
  card.querySelector('.vote-card__state-icon').textContent = patch.selected ? '✓' : '○';
  card.querySelector('.vote-card__state').textContent = patch.selected ? '✓ Selected' : 'Not selected';
  card.setAttribute('aria-label', card.getAttribute('aria-label')
    .replace(/, [0-9]+ votes,/, ', ' + patch.voteCount + ' votes,')
    .replace(/, (Selected|Not selected)$/, ', ' + (patch.selected ? 'Selected' : 'Not selected')));
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
