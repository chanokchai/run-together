import express from 'express';
import {
  CANONICAL_TIME_ZONE,
  getCurrentWeekMonday,
  isMonday,
  isWeekNavigable,
  parseIsoDate,
} from './calendar.js';
import { AuthError, createAuthService } from './auth.js';
import { getWeekState } from './domain.js';

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function page({ title, content, script = '' }) {
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
      section { background: white; border-radius: 1rem; padding: 1.5rem; box-shadow: 0 0.25rem 1rem #14213d18; }
      label { display: block; margin-top: 1rem; font-weight: 600; }
      input, button { box-sizing: border-box; width: 100%; min-height: 2.75rem; margin-top: .35rem; padding: .55rem .7rem; font: inherit; }
      button { cursor: pointer; background: #1769aa; color: white; border: 0; border-radius: .45rem; font-weight: 700; }
      a { color: #145da0; }
      .message { min-height: 1.5rem; margin-top: 1rem; }
      .actions { display: grid; gap: .75rem; margin-top: 1rem; }
      .week-navigation { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .4rem; }
      .week-navigation button { min-width: 0; padding-inline: .25rem; font-size: clamp(.65rem, 2.6vw, 1rem); line-height: 1.2; overflow-wrap: anywhere; }
      .secondary { background: #52606d; }
    </style>
  </head>
  <body><main>${content}</main>${script ? `<script>${script}</script>` : ''}</body>
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
          <ol id="week-days"></ol>
          <form id="pin-form"><h2>เปลี่ยน PIN / Change PIN</h2><label>PIN ปัจจุบัน / Current PIN <input name="currentPin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" required></label><label>PIN ใหม่ / New PIN <input name="newPin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" required></label><label>ยืนยัน PIN ใหม่ / Confirm new PIN <input name="newPinConfirmation" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" required></label><button>เปลี่ยน PIN / Change PIN</button></form>
          <div class="actions"><button id="logout" type="button" class="secondary">ออกจากระบบ / Logout</button></div>
        </section>`,
        script: `let csrfToken = '';
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
          function renderWeek(state) {
            weekMonday = state.week.monday;
            weekHeading.textContent = 'สัปดาห์ที่ ' + state.week.isoWeek + ' / ISO week ' + state.week.isoWeek + ' (' + state.week.isoWeekYear + ')';
            weekRange.textContent = state.week.monday + ' – ' + state.week.sunday;
            previousWeek.disabled = false;
            previousWeek.dataset.monday = state.navigation.previousMonday;
            currentWeekButton.disabled = state.week.monday === currentWeekMonday;
            nextWeek.disabled = !state.navigation.nextMonday;
            nextWeek.dataset.monday = state.navigation.nextMonday || '';
            const rows = state.days.map((day) => {
              const row = document.createElement('li');
              addText(row, 'strong', day.date);
              addText(row, 'span', day.eligible ? ' พร้อมเลือก / Eligible' : ' อ่านอย่างเดียว / Read-only');
              addText(row, 'span', ' จำนวน ' + day.voteCount + ' / Count ' + day.voteCount);
              addText(row, 'span', day.voterNames.length ? ' ผู้เลือก: ' + day.voterNames.join(', ') : ' ยังไม่มีผู้เลือก / No voters');
              addText(row, 'span', state.currentUserSelectedDates.includes(day.date) ? ' เลือกโดยคุณ / Selected by you' : ' ยังไม่ได้เลือก / Not selected');
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
