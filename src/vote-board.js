const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
export const VOTER_MARQUEE_PIXELS_PER_SECOND = 7.1875;

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
  const distance = Number.isFinite(loopDistance) ? Math.max(0, loopDistance) : 0;
  return distance / VOTER_MARQUEE_PIXELS_PER_SECOND;
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

export function patchVoteDay({ weekDays, patch, createVoterNamesRegion }) {
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
  card.querySelector('.vote-card__names').replaceWith(createVoterNamesRegion(patch.voterNames));
  const track = card.querySelector('.vote-card__names-track');
  if (track?.querySelector('.vote-card__names-copy--duplicate')) {
    track.style.setProperty('--vote-marquee-duration', marqueeDurationForDistance(track.scrollWidth / 2) + 's');
  }
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
