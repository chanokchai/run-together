const message = document.querySelector('#offline-message');
const status = document.querySelector('#offline-status');
const savedWeek = document.querySelector('#saved-week');
const noSavedWeek = document.querySelector('#no-saved-week');
const roomDetails = document.querySelector('#saved-room-details');
const daysList = document.querySelector('#saved-days');
const eventsRegion = document.querySelector('#saved-events-region');
const eventsList = document.querySelector('#saved-events');
const returnLink = document.querySelector('#return-to-room');
const requestedRoom = new URLSearchParams(location.search).get('scope');
let nonRoomNavigationCleared = false;

function dateLabel(date) {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsed.valueOf())) return date;
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeZone: 'UTC' }).format(parsed);
}

function statusLabel(value) {
  return value === 'scheduled' ? 'Scheduled / กำหนดแล้ว' : 'Proposed / เสนอแล้ว';
}

function validSnapshot(value) {
  return Boolean(value && value.schemaVersion === 1
    && typeof value.savedAt === 'string'
    && value.room && typeof value.room.id === 'string'
    && Number.isSafeInteger(value.room.displayNumber)
    && typeof value.room.title === 'string'
    && typeof value.room.venue === 'string'
    && typeof value.room.time === 'string'
    && value.week && typeof value.week.monday === 'string'
    && typeof value.week.sunday === 'string'
    && Number.isSafeInteger(value.week.isoWeek)
    && Number.isSafeInteger(value.week.isoWeekYear)
    && Array.isArray(value.days) && value.days.length === 7
    && value.days.every((day) => day && typeof day.date === 'string'
      && Number.isSafeInteger(day.voteCount) && day.voteCount >= 0
      && Array.isArray(day.voterNames) && day.voterNames.every((name) => typeof name === 'string'))
    && Array.isArray(value.events) && value.events.every((event) => event
      && typeof event.date === 'string' && ['proposed', 'scheduled'].includes(event.status)));
}

function displaySnapshot(snapshot) {
  document.querySelector('#saved-week-heading').textContent = `Room ${String(snapshot.room.displayNumber).padStart(2, '0')}: ${snapshot.room.title} — Week ${snapshot.week.isoWeek} (${snapshot.week.isoWeekYear})`;
  const venue = snapshot.room.venue ? ` · ${snapshot.room.venue}` : '';
  const time = snapshot.room.time ? ` · ${snapshot.room.time}` : '';
  roomDetails.textContent = `${snapshot.week.monday} – ${snapshot.week.sunday}${venue}${time}`;
  daysList.replaceChildren();
  for (const day of snapshot.days) {
    const item = document.createElement('li');
    item.className = 'saved-day';
    const date = document.createElement('div');
    date.className = 'saved-day__date';
    date.textContent = dateLabel(day.date);
    const count = document.createElement('div');
    count.textContent = `${day.voteCount} votes / โหวต`;
    const voters = document.createElement('p');
    voters.className = 'saved-day__voters';
    voters.textContent = day.voterNames.length ? day.voterNames.join(', ') : 'No voters / ยังไม่มีผู้เลือก';
    item.append(date, count, voters);
    daysList.append(item);
  }
  eventsList.replaceChildren();
  for (const event of snapshot.events) {
    const item = document.createElement('li');
    item.textContent = `${dateLabel(event.date)} — ${statusLabel(event.status)}`;
    eventsList.append(item);
  }
  eventsRegion.hidden = snapshot.events.length === 0;
  savedWeek.hidden = false;
  noSavedWeek.hidden = true;
  returnLink.href = `/vote/${encodeURIComponent(snapshot.room.id)}`;
  returnLink.hidden = false;
  const saved = new Date(snapshot.savedAt);
  const savedLabel = Number.isFinite(saved.valueOf()) ? saved.toLocaleString() : snapshot.savedAt;
  const mode = navigator.onLine ? 'Saved offline view / มุมมองที่บันทึกไว้' : 'Offline / ออฟไลน์';
  status.textContent = `${mode} — read-only; saved ${savedLabel}, so data may be stale. / ดูได้อย่างเดียว บันทึกเมื่อ ${savedLabel} ข้อมูลอาจไม่เป็นปัจจุบัน`;
}

async function render() {
  savedWeek.hidden = true;
  returnLink.hidden = true;
  const pathRoom = /^\/vote\/([0-9a-f-]+)$/i.exec(location.pathname)?.[1] ?? null;
  const offlineFallback = document.documentElement.dataset.offlineShell === 'true';
  const routeAllowsSnapshot = offlineFallback || location.pathname === '/offline' || location.pathname === '/' || Boolean(pathRoom);
  if (!routeAllowsSnapshot && !nonRoomNavigationCleared) {
    nonRoomNavigationCleared = true;
    await window.runTogetherPwa?.clearSnapshot('non-room-offline-navigation');
  }
  const snapshot = await window.runTogetherPwa?.getLatestSnapshot();
  const requiredRoom = requestedRoom === 'none' ? null : requestedRoom || pathRoom;
  const matching = validSnapshot(snapshot) && routeAllowsSnapshot
    && (!requestedRoom || (requestedRoom !== 'none' && snapshot.room.id === requestedRoom))
    && (!pathRoom || snapshot.room.id === pathRoom)
    ? snapshot
    : null;
  if (matching) displaySnapshot(matching);
  else {
    noSavedWeek.hidden = false;
    status.textContent = navigator.onLine
      ? 'Saved view unavailable / ไม่มีข้อมูลที่บันทึกไว้ — read-only. / ดูได้อย่างเดียว'
      : 'Offline / ออฟไลน์ — no matching saved week is available; read-only. / ไม่มีสัปดาห์ที่ตรงกันซึ่งบันทึกไว้ ดูได้อย่างเดียว';
  }
  if (requestedRoom === 'none' || (requiredRoom && !matching)) returnLink.hidden = true;
}

window.addEventListener('online', () => { void render(); });
window.addEventListener('offline', () => { void render(); });
window.addEventListener('run-together:snapshot-cleared', () => { void render(); });
document.querySelector('#clear-offline-data').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const clearSnapshot = window.runTogetherPwa?.clearSnapshot;
    if (typeof clearSnapshot !== 'function') throw new Error('Offline data clearing is unavailable.');
    await clearSnapshot('offline-local-clear');
    message.textContent = 'Saved offline data was cleared from this device. This did not sign you out or revoke a server session. / ล้างข้อมูลออฟไลน์จากอุปกรณ์นี้แล้ว การดำเนินการนี้ไม่ได้ออกจากระบบหรือเพิกถอนเซสชันบนเซิร์ฟเวอร์';
    await render();
  } catch {
    message.textContent = 'Could not confirm that offline data was cleared. Reconnect and try again. Server sign-out was not sent. / ยืนยันการล้างข้อมูลออฟไลน์ไม่ได้ กรุณาเชื่อมต่อแล้วลองอีกครั้ง ไม่มีการส่งคำขอออกจากระบบไปยังเซิร์ฟเวอร์';
  } finally {
    button.disabled = false;
  }
});

if (new URLSearchParams(location.search).has('cleared')) {
  message.textContent = 'Saved offline data was cleared from this device. Server sign-out was not sent; this does not revoke a server session. / ล้างข้อมูลออฟไลน์จากอุปกรณ์นี้แล้ว ไม่มีการส่งคำขอออกจากระบบไปยังเซิร์ฟเวอร์ และไม่ได้เพิกถอนเซสชันบนเซิร์ฟเวอร์';
}
if (new URLSearchParams(location.search).has('clearFailed')) {
  message.textContent = 'The offline data could not be confirmed cleared. Reconnect before relying on local privacy controls. Server sign-out was not sent. / ไม่สามารถยืนยันว่าล้างข้อมูลออฟไลน์แล้ว กรุณาเชื่อมต่อก่อนใช้การควบคุมข้อมูลในอุปกรณ์ ไม่มีการส่งคำขอออกจากระบบไปยังเซิร์ฟเวอร์';
}
await render();
