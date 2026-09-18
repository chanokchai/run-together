import express from 'express';
import { readFileSync } from 'node:fs';
import {
  CANONICAL_TIME_ZONE,
  getCurrentWeekMonday,
  isMonday,
  isWeekNavigable,
  parseIsoDate,
} from './calendar.js';
import { AuthError, createAuthService } from './auth.js';
import { getWeekState } from './domain.js';

const voteBoardScript = readFileSync(new URL('./vote-board.js', import.meta.url), 'utf8');

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function page({ title, content, script = '', mainClass = '' }) {
  return `<!doctype html>
<html lang="th">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
    <style>
      :root { color-scheme: light; font-family: system-ui, sans-serif; }
      body { margin: 0; background: #f3f6fa; color: #14213d; }
      main { max-width: 34rem; margin: 0 auto; padding: 2rem 1rem; }
      .vote-page-main { max-width: 90rem; padding-inline: clamp(1rem, 4vw, 3rem); }
      section { background: white; border-radius: 1rem; padding: 1.5rem; box-shadow: 0 0.25rem 1rem #14213d18; }
      .vote-page-main > section { padding: clamp(1rem, 3vw, 2rem); }
      label { display: block; margin-top: 1rem; font-weight: 600; }
      input, button { box-sizing: border-box; width: 100%; min-height: 2.75rem; margin-top: .35rem; padding: .55rem .7rem; font: inherit; }
      button { cursor: pointer; background: #1769aa; color: white; border: 0; border-radius: .45rem; font-weight: 700; }
      a { color: #145da0; }
      .message { min-height: 1.5rem; margin-top: 1rem; }
      .actions { display: grid; gap: .75rem; margin-top: 1rem; }
      .week-navigation { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .4rem; }
      .week-navigation button { min-width: 0; padding-inline: .25rem; font-size: clamp(.65rem, 2.6vw, 1rem); line-height: 1.2; overflow-wrap: anywhere; }
      .secondary { background: #52606d; }
      .vote-board { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); align-items: stretch; gap: .35rem; list-style: none; margin: 1rem 0; padding: 0; }
      .vote-board__legend { display: flex; flex-wrap: wrap; gap: .5rem 1rem; margin: .75rem 0 0; color: #334e68; font-size: .9rem; }
      .vote-day { display: flex; min-width: 0; }
      .vote-card { display: flex; flex: 1 1 auto; flex-direction: column; align-items: stretch; gap: .4rem; width: 100%; min-width: 0; min-height: 15rem; height: 100%; margin: 0; padding: .55rem .3rem; border: .2rem solid transparent; border-radius: .6rem; background: var(--day-bg); color: var(--day-fg); font-size: clamp(.68rem, 1.45vw, .95rem); text-align: center; overflow: hidden; }
      .vote-card:hover, .vote-card:focus-visible, .vote-card.is-selected { border-color: #f5c542; }
      .vote-card:focus-visible { outline: .2rem solid #14213d; outline-offset: .15rem; }
      .vote-card__header { display: flex; justify-content: space-between; align-items: flex-start; gap: .25rem; min-width: 0; font-weight: 700; }
      .vote-card__weekday, .vote-card__date { overflow-wrap: anywhere; }
      .vote-card__weekday--compact, .vote-card__date--compact, .vote-card__eligibility-icon, .vote-card__state-icon { display: none; }
      .vote-card__date { font-variant-numeric: tabular-nums; }
      .vote-card__count { margin: auto 0; font-size: clamp(1.15rem, 6vw, 2.1rem); line-height: 1; font-variant-numeric: tabular-nums; }
      .vote-card__state, .vote-card__eligibility { min-height: 1.2em; font-size: .78em; line-height: 1.2; }
      .vote-card__names { display: flex; min-width: 0; min-height: 1.3rem; align-items: center; overflow: hidden; text-align: left; }
      .vote-card__names-empty { display: block; width: 100%; text-align: center; }
      .vote-card__names-track { display: inline-flex; max-width: max-content; white-space: nowrap; animation: voter-name-loop 24s linear infinite; }
      .vote-card__names-track span { flex: 0 0 auto; }
      .vote-card.is-touch-paused .vote-card__names-track, .vote-card:hover .vote-card__names-track, .vote-card:focus-within .vote-card__names-track { animation-play-state: paused; }
      @keyframes voter-name-loop { from { transform: translateX(0); } to { transform: translateX(-50%); } }
      @media (prefers-reduced-motion: reduce) { .vote-card__names-track { animation: none; display: block; white-space: normal; overflow-wrap: anywhere; } }
      @media (max-width: 44rem) {
        .vote-page-main { padding-inline: .75rem; }
        .vote-page-main > section { padding: 1rem .75rem; }
        .vote-card { min-height: 14rem; padding-inline: .18rem; font-size: clamp(.625rem, 2.1vw, .75rem); }
        .vote-card__weekday--full, .vote-card__date--full, .vote-card__eligibility-detail, .vote-card__state-detail { display: none; }
        .vote-card__weekday--compact, .vote-card__date--compact, .vote-card__eligibility-icon, .vote-card__state-icon { display: block; }
        .vote-card__weekday--compact { font-size: clamp(.6875rem, 2.3vw, .75rem); line-height: 1.1; white-space: nowrap; }
        .vote-card__date--compact { font-size: clamp(.6875rem, 2.2vw, .75rem); line-height: 1; }
        .vote-card__date--compact span { display: block; }
        .vote-card__eligibility-icon, .vote-card__state-icon { min-height: 1rem; font-size: 1rem; line-height: 1; }
        .vote-card__count { width: 100%; min-width: 0; box-sizing: border-box; overflow: hidden; font-size: clamp(1rem, 5vw, 2.5rem); letter-spacing: -.08em; }
        .vote-card__names { min-height: 1.2rem; }
      }
      @media (max-width: 380px) { .vote-page-main { padding-inline: .5rem; } .vote-page-main > section { padding-inline: .5rem; } .vote-card { min-height: 13.5rem; } }
    </style>
  </head>
  <body><main${mainClass ? ` class="${mainClass}"` : ''}>${content}</main>${script ? `<script type="module">${script}</script>` : ''}</body>
</html>`;
}

function requestedWeek(value, now) {
  try {
    parseIsoDate(value);
  } catch (error) {
    throw new AuthError(400, 'INVALID_WEEK_DATE', 'สัปดาห์ไม่ถูกต้อง / The requested week date is invalid.', { cause: error });
  }
  if (!isMonday(value)) {
    throw new AuthError(400, 'WEEK_NOT_MONDAY', 'ต้องระบุวันจันทร์ / The requested date must be a Monday.');
  }
  if (!isWeekNavigable(value, now)) {
    throw new AuthError(400, 'WEEK_TOO_FAR', 'สัปดาห์นี้ยังไม่พร้อมให้ดู / This week is not available yet.');
  }
  return value;
}

const loginPage = () => page({
  title: 'Run Together | เข้าสู่ระบบ',
  content: `<section>
    <h1>Run Together</h1>
    <p>วิ่งไปด้วยกัน / Run together</p>
    <p>เข้าสู่ระบบ / Sign in</p>
    <form id="login-form">
      <label>ชื่อ / Name <input name="name" autocomplete="username" required maxlength="40"></label>
      <label>PIN 4 หลัก / 4-digit PIN <input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="current-password" required></label>
      <button>เข้าสู่ระบบ / Sign in</button>
    </form>
    <p id="message" class="message" role="status"></p>
    <a href="/register">สมัครสมาชิก / Register</a>
  </section>`,
  script: `document.querySelector('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: form.get('name'), pin: form.get('pin') }) });
    const result = await response.json();
    if (response.ok) location.href = '/vote';
    else document.querySelector('#message').textContent = result.message;
  });`,
});

const registerPage = () => page({
  title: 'Run Together | สมัครสมาชิก',
  content: `<section>
    <h1>Run Together</h1>
    <p>สมัครสมาชิก / Register</p>
    <form id="register-form">
      <label>ชื่อ / Name <input name="name" autocomplete="username" required maxlength="40"></label>
      <label>PIN 4 หลัก / 4-digit PIN <input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="new-password" required></label>
      <label>ยืนยัน PIN / Confirm PIN <input name="pinConfirmation" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="new-password" required></label>
      <button>สมัครและเข้าสู่ระบบ / Register and sign in</button>
    </form>
    <p id="message" class="message" role="status"></p>
    <a href="/">เข้าสู่ระบบ / Sign in</a>
  </section>`,
  script: `document.querySelector('#register-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const response = await fetch('/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: form.get('name'), pin: form.get('pin'), pinConfirmation: form.get('pinConfirmation') }) });
    const result = await response.json();
    if (response.ok) location.href = '/vote';
    else document.querySelector('#message').textContent = result.message;
  });`,
});

export function createApp({ databaseReady = false, database, env = process.env, now = () => new Date() } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '10kb' }));
  const auth = database ? createAuthService({ database, env, now }) : null;

  const sendError = (response, error) => {
    const safe = error instanceof AuthError ? error : new AuthError(500, 'SERVER_ERROR', 'เกิดข้อผิดพลาด กรุณาลองใหม่ / Something went wrong; please try again.');
    if (!(error instanceof AuthError)) console.error('Request failed:', error);
    response.status(safe.status).json({ code: safe.code, message: safe.message });
  };

  app.get('/health', (_request, response) => {
    response.json({
      status: 'ok',
      database: databaseReady ? 'ready' : 'not_ready',
      timeZone: CANONICAL_TIME_ZONE,
    });
  });

  app.get('/', (_request, response) => {
    response.type('html').send(loginPage());
  });

  app.get('/register', (_request, response) => response.type('html').send(registerPage()));

  app.get('/vote-board.js', (_request, response) => response.type('application/javascript').send(voteBoardScript));

  if (auth) {
    app.post('/api/auth/register', async (request, response) => {
      try {
        auth.assertSameOrigin(request);
        const result = await auth.register({ ...request.body, sourceKey: auth.effectiveSourceKey(request) });
        response.status(201).setHeader('set-cookie', auth.sessionCookie(result.session.token, result.session.expiresAt));
        response.json({ user: result.user, sessionRestored: true });
      } catch (error) {
        sendError(response, error);
      }
    });

    app.post('/api/auth/login', async (request, response) => {
      try {
        auth.assertSameOrigin(request);
        const result = await auth.login(request.body);
        response.setHeader('set-cookie', auth.sessionCookie(result.session.token, result.session.expiresAt));
        response.json({ user: result.user, sessionRestored: true });
      } catch (error) {
        sendError(response, error);
      }
    });

    app.get('/api/session', (request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      const session = auth.requireSession(request, response);
      if (session) response.json(auth.sessionPayload(session));
    });

    app.get('/api/weeks/:monday', (request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      const session = auth.requireSession(request, response);
      if (!session) return;
      try {
        const monday = requestedWeek(request.params.monday, now);
        response.json(getWeekState(database, { monday, currentUserId: session.user_id, now }));
      } catch (error) {
        sendError(response, error);
      }
    });

    app.get('/vote', (request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      const session = auth.requireSession(request, response);
      if (!session) return;
      const displayName = escapeHtml(session.name);
      const currentWeek = getCurrentWeekMonday(now);
      response.type('html').send(page({
        title: 'Run Together | Vote',
        mainClass: 'vote-page-main',
        content: `<section id="protected-content" hidden>
          <h1>Run Together</h1>
          <p>ยินดีต้อนรับ / Welcome, <strong id="display-name">${displayName}</strong></p>
          <h2 id="week-heading">สัปดาห์ / Week</h2>
          <p id="week-range"></p>
          <nav class="week-navigation actions" aria-label="Week navigation">
            <button id="previous-week" type="button" class="secondary">สัปดาห์ก่อน / Previous week</button>
            <button id="current-week" type="button">สัปดาห์นี้ / Now</button>
            <button id="next-week" type="button">สัปดาห์ถัดไป / Next week</button>
          </nav>
          <p id="message" class="message" role="status"></p>
          <ol id="week-days" class="vote-board" aria-label="Seven-day voting board / กระดานเลือกวันทั้งเจ็ด"></ol>
          <p class="vote-board__legend" aria-label="Board key / คำอธิบายกระดาน"><span>● พร้อมเลือก / Eligible</span><span>◌ อ่านอย่างเดียว / Read-only</span><span>✓ เลือกโดยคุณ / Selected</span></p>
          <form id="pin-form"><h2>เปลี่ยน PIN / Change PIN</h2><label>PIN ปัจจุบัน / Current PIN <input name="currentPin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" required></label><label>PIN ใหม่ / New PIN <input name="newPin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" required></label><label>ยืนยัน PIN ใหม่ / Confirm new PIN <input name="newPinConfirmation" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" required></label><button>เปลี่ยน PIN / Change PIN</button></form>
          <div class="actions"><button id="logout" type="button" class="secondary">ออกจากระบบ / Logout</button></div>
        </section>`,
        script: `import { colorForDay, formatDisplayDate } from '/vote-board.js?v=issue-5-1';
          let csrfToken = '';
          let sessionCheck = 0;
          const currentWeekMonday = '${currentWeek}';
          let weekMonday = currentWeekMonday;
          const protectedContent = document.querySelector('#protected-content');
          const displayName = document.querySelector('#display-name');
          const weekHeading = document.querySelector('#week-heading');
          const weekRange = document.querySelector('#week-range');
          const weekDays = document.querySelector('#week-days');
          const previousWeek = document.querySelector('#previous-week');
          const currentWeekButton = document.querySelector('#current-week');
          const nextWeek = document.querySelector('#next-week');
          const pinForm = document.querySelector('#pin-form');
          const message = document.querySelector('#message');
          function guardProtectedContent() { protectedContent.hidden = true; csrfToken = ''; displayName.textContent = ''; weekDays.replaceChildren(); pinForm.reset(); message.textContent = ''; }
          function redirectToLogin() { guardProtectedContent(); location.replace('/'); }
          function addText(parent, tag, text) { const element = document.createElement(tag); element.textContent = text; parent.append(element); return element; }
          const weekdays = [
            { thai: 'จ.', english: 'Mon' }, { thai: 'อ.', english: 'Tue' }, { thai: 'พ.', english: 'Wed' },
            { thai: 'พฤ.', english: 'Thu' }, { thai: 'ศ.', english: 'Fri' }, { thai: 'ส.', english: 'Sat' }, { thai: 'อา.', english: 'Sun' },
          ];
          function appendVoterNames(parent, names) {
            const region = document.createElement('div');
            region.className = 'vote-card__names';
            region.setAttribute('aria-label', names.length ? 'รายชื่อผู้เลือก / Voter names' : 'รายชื่อผู้เลือก / Voter names: ยังไม่มีผู้เลือก / No voters');
            const track = document.createElement('div');
            track.className = 'vote-card__names-track';
            if (names.length) {
              names.forEach((name, index) => {
                if (index) track.append(document.createTextNode(', '));
                addText(track, 'span', name);
              });
              track.append(document.createTextNode(' • '));
              names.forEach((name, index) => {
                if (index) track.append(document.createTextNode(', '));
                addText(track, 'span', name);
              });
            } else {
              addText(track, 'span', '—').className = 'vote-card__names-empty';
            }
            region.append(track);
            parent.append(region);
          }
          function renderWeek(state) {
            weekMonday = state.week.monday;
            weekHeading.textContent = 'สัปดาห์ที่ ' + state.week.isoWeek + ' / ISO week ' + state.week.isoWeek + ' (' + state.week.isoWeekYear + ')';
            weekRange.textContent = state.week.monday + ' – ' + state.week.sunday;
            previousWeek.disabled = false;
            previousWeek.dataset.monday = state.navigation.previousMonday;
            currentWeekButton.disabled = state.week.monday === currentWeekMonday;
            nextWeek.disabled = !state.navigation.nextMonday;
            nextWeek.dataset.monday = state.navigation.nextMonday || '';
            const weeklyMaximum = Math.max(...state.days.map(({ voteCount }) => voteCount), 0);
            const rows = state.days.map((day, index) => {
              const selected = state.currentUserSelectedDates.includes(day.date);
              const weekday = weekdays[index];
              const colors = colorForDay(day.voteCount, weeklyMaximum);
              const displayDate = formatDisplayDate(day.date);
              const [dayNumber, monthName] = displayDate.split(' ');
              const row = document.createElement('li');
              row.className = 'vote-day';
              const card = document.createElement('button');
              card.type = 'button';
              card.className = selected ? 'vote-card is-selected' : 'vote-card';
              card.style.setProperty('--day-bg', colors.background);
              card.style.setProperty('--day-fg', colors.foreground);
              card.setAttribute('aria-pressed', String(selected));
              card.setAttribute('aria-disabled', String(!day.eligible));
              card.setAttribute('aria-label', weekday.english + ' ' + weekday.thai + ', ' + formatDisplayDate(day.date) + ', ' + day.voteCount + ' votes, ' + (day.eligible ? 'Eligible' : 'Read-only') + ', ' + (selected ? 'Selected' : 'Not selected'));
              const header = document.createElement('span');
              header.className = 'vote-card__header';
              addText(header, 'span', weekday.thai + ' / ' + weekday.english).className = 'vote-card__weekday--full';
              addText(header, 'span', weekday.thai + ' / ' + weekday.english[0]).className = 'vote-card__weekday--compact';
              addText(header, 'span', displayDate).className = 'vote-card__date--full';
              const compactDate = document.createElement('span');
              compactDate.className = 'vote-card__date--compact';
              addText(compactDate, 'span', dayNumber);
              addText(compactDate, 'span', monthName);
              header.append(compactDate);
              card.append(header);
              addText(card, 'span', String(day.voteCount)).className = 'vote-card__count';
              addText(card, 'span', day.eligible ? '●' : '◌').className = 'vote-card__eligibility-icon';
              addText(card, 'span', day.eligible ? 'พร้อมเลือก / Eligible' : 'อ่านอย่างเดียว / Read-only').className = 'vote-card__eligibility vote-card__eligibility-detail';
              appendVoterNames(card, day.voterNames);
              addText(card, 'span', selected ? '✓' : '○').className = 'vote-card__state-icon';
              addText(card, 'span', selected ? '✓ เลือกโดยคุณ / Selected' : 'ยังไม่ได้เลือก / Not selected').className = 'vote-card__state vote-card__state-detail';
              card.addEventListener('pointerdown', (event) => { if (event.pointerType === 'touch') card.classList.add('is-touch-paused'); });
              row.append(card);
              return row;
            });
            weekDays.replaceChildren(...rows);
          }
          async function loadWeek(monday) { message.textContent = ''; try { const response = await fetch('/api/weeks/' + encodeURIComponent(monday), { cache: 'no-store' }); const state = await response.json(); if (!response.ok) { message.textContent = state.message; return; } renderWeek(state); } catch { message.textContent = 'โหลดสัปดาห์ไม่สำเร็จ / Could not load this week.'; } }
          async function loadSession() { const currentCheck = ++sessionCheck; guardProtectedContent(); try { const response = await fetch('/api/session', { cache: 'no-store' }); if (currentCheck !== sessionCheck) return; if (!response.ok) { redirectToLogin(); return; } const session = await response.json(); if (currentCheck !== sessionCheck) return; csrfToken = session.csrfToken; displayName.textContent = session.displayName; protectedContent.hidden = false; await loadWeek(weekMonday); } catch { if (currentCheck === sessionCheck) redirectToLogin(); } }
          previousWeek.addEventListener('click', () => loadWeek(previousWeek.dataset.monday));
          currentWeekButton.addEventListener('click', () => loadWeek(currentWeekMonday));
          nextWeek.addEventListener('click', () => { if (!nextWeek.disabled) loadWeek(nextWeek.dataset.monday); });
          pinForm.addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const response = await fetch('/api/account/pin', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify(Object.fromEntries(form)) }); const result = response.status === 204 ? { message: 'เปลี่ยน PIN สำเร็จ / PIN changed successfully.' } : await response.json(); message.textContent = result.message; if (response.status === 401) redirectToLogin(); });
          document.querySelector('#logout').addEventListener('click', async () => { const response = await fetch('/api/auth/logout', { method: 'POST', headers: { 'x-csrf-token': csrfToken } }); if (response.ok) location.href = '/'; });
          window.addEventListener('pageshow', loadSession);
          loadSession();`,
      }));
    });

    app.put('/api/account/pin', async (request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      const session = auth.requireSession(request, response);
      if (!session) return;
      try {
        auth.assertCsrf(request, session);
        await auth.changePin(session, request.body);
        response.status(204).end();
      } catch (error) {
        sendError(response, error);
      }
    });

    app.post('/api/auth/logout', (request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      const session = auth.requireSession(request, response);
      if (!session) return;
      try {
        auth.assertCsrf(request, session);
        auth.logout(session, response);
        response.status(204).end();
      } catch (error) {
        sendError(response, error);
      }
    });
  }

  app.use((error, _request, response, _next) => {
    if (error?.type === 'entity.parse.failed' || error instanceof SyntaxError) {
      return response.status(400).json({ code: 'INVALID_REQUEST', message: 'ข้อมูลไม่ถูกต้อง / The submitted information is invalid.' });
    }
    return response.status(500).json({ code: 'SERVER_ERROR', message: 'เกิดข้อผิดพลาด กรุณาลองใหม่ / Something went wrong; please try again.' });
  });

  return app;
}

export default createApp();
