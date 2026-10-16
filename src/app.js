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
import {
  AdminActionError,
  deleteRunEvent,
  deleteUserWithAudit,
  getEligiblePeriodVoteTotals,
  getWeekState,
  assertVoteBody,
  listUsers,
  proposeRunEvent,
  resetUserVotes,
  resetWeek,
  setRunEventStatus,
  setVote,
  VoteError,
  RunEventError,
  withdrawRunEvent,
} from './domain.js';

const voteBoardScript = readFileSync(new URL('./vote-board.js', import.meta.url), 'utf8');
const dateTimeScript = readFileSync(new URL('./date-time.js', import.meta.url), 'utf8');
const runEventsScript = readFileSync(new URL('./run-events.js', import.meta.url), 'utf8');

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function page({ title, content, script = '', mainClass = '', scriptSrc = '' }) {
  return `<!doctype html>
<html lang="th">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
    <style>
      :root { color-scheme: light; font-family: system-ui, sans-serif; }
      @property --beam-angle { syntax: "<angle>"; inherits: false; initial-value: 0deg; }
      body { margin: 0; background: #f3f6fa; color: #14213d; }
      main { max-width: 34rem; margin: 0 auto; padding: 2rem 1rem; }
      .vote-page-main { max-width: 90rem; padding-inline: clamp(1rem, 4vw, 3rem); }
      section { background: white; border-radius: 1rem; padding: 1.5rem; box-shadow: 0 0.25rem 1rem #14213d18; }
      .vote-page-main > section { padding: clamp(1rem, 3vw, 2rem); }
      label { display: block; margin-top: 1rem; font-weight: 600; }
      input, button { box-sizing: border-box; width: 100%; min-height: 2.75rem; margin-top: .35rem; padding: .55rem .7rem; font: inherit; }
      button { cursor: pointer; background: #1769aa; color: white; border: 0; border-radius: .45rem; font-weight: 700; }
      a { color: #145da0; }
      a.button { display: block; box-sizing: border-box; width: 100%; min-height: 44px; padding: .55rem .7rem; border-radius: .45rem; background: #1769aa; color: white; font-weight: 700; text-align: center; text-decoration: none; }
      a.button:focus-visible { outline: 3px solid #f5c542; outline-offset: 2px; }
      .message { min-height: 1.5rem; margin-top: 1rem; }
      .actions { display: grid; gap: .75rem; margin-top: 1rem; }
      .admin-action { background: #1769aa; }
      .admin-user { margin-top: 1rem; padding-top: 1rem; border-top: 1px solid #d9e2ec; }
      .admin-user-heading { display: flex; align-items: center; gap: .5rem; }
      .admin-user-heading h2 { flex: 1 1 auto; margin: 0; }
      .admin-user-metadata { display: flex; flex-wrap: wrap; gap: .35rem .75rem; min-width: 0; margin: 1rem 0 0; }
      .admin-user-metadata-item { display: flex; flex: 1 1 12rem; gap: .3rem; min-width: 0; max-width: 100%; overflow-wrap: anywhere; }
      .admin-user-metadata-item dt { flex: 0 1 auto; font-weight: 600; }
      .admin-user-metadata-item dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
      .admin-reset-toggle { display: flex; align-items: center; gap: .5rem; }
      .admin-reset-toggle input { width: 1.25rem; min-width: 1.25rem; min-height: 1.25rem; margin: 0; }
      .delete-user { display: inline-flex; width: 44px; min-width: 44px; min-height: 44px; align-items: center; justify-content: center; margin: 0; padding: .55rem; }
      .delete-user svg { width: 1.35rem; height: 1.35rem; }
      dialog { max-width: min(30rem, calc(100vw - 2rem)); border: 0; border-radius: .75rem; box-shadow: 0 .5rem 2rem #14213d44; color: #14213d; }
      dialog::backdrop { background: #14213d88; }
      .dialog-actions { display: grid; gap: .5rem; }
      .dialog-close { background: transparent; color: #145da0; }
      .week-navigation { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .4rem; }
      .week-navigation button { min-width: 0; padding-inline: .25rem; font-size: clamp(.65rem, 2.6vw, 1rem); line-height: 1.2; overflow-wrap: anywhere; }
      .secondary { background: #52606d; }
      .vote-board { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); align-items: stretch; gap: .35rem; list-style: none; margin: 1rem 0; padding: 0; }
      .vote-timeline { max-height: 180px; margin: .35rem 0 .55rem; padding: .45rem .5rem; border: 1px solid #d9e2ec; box-shadow: none; }
      .vote-timeline > h2 { margin: .1rem 0 .2rem; font-size: .95rem; }
      .vote-timeline__range { margin: 0 0 .25rem; color: #334155; font-size: .68rem; line-height: 1.2; }
      .vote-timeline__days { display: grid; align-items: end; gap: 1px; width: 100%; margin: .15rem 0 0; padding: 0; list-style: none; }
      .vote-timeline__day { display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(30px, max-content) 52px 32px; min-width: 0; text-align: center; }
      .vote-timeline__count { justify-self: center; width: max-content; color: #14213d; font-size: clamp(.62rem, 2.8vw, .72rem); line-height: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
      .vote-timeline__day:nth-child(even) .vote-timeline__count { transform: translateY(15px); }
      .vote-timeline__track { position: relative; display: flex; min-width: 0; align-items: flex-end; justify-content: center; border-bottom: 1px solid #52606d; }
      .vote-timeline__bar { display: block; width: min(100%, .8rem); min-height: 0; border-radius: .15rem .15rem 0 0; background: #0b3d2e; }
      .vote-timeline__bar.is-top-ranked { border: 1px dashed #4c1d95; border-bottom: 0; background: #6b21a8; }
      .vote-timeline__bar.is-scheduled { background: #f5c542; }
      .vote-timeline__top-cue { position: absolute; top: 0; left: 50%; z-index: 1; color: #fff; font-size: .62rem; line-height: 1; transform: translateX(-50%); }
      .vote-timeline__date { display: flex; flex-direction: column; align-items: center; min-width: 0; width: 100%; box-sizing: border-box; overflow: hidden; color: #14213d; font-size: clamp(.54rem, 2.75vw, .62rem); line-height: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
      .vote-timeline__count.is-zero { visibility: hidden; }
      .vote-timeline__date.is-scheduled { position: relative; border-radius: .25rem; outline: 1px solid #15803d; background: #dcfce7; color: #14532d; font-weight: 700; }
      :is(.vote-timeline__date.is-scheduled, .vote-timeline__bar.is-scheduled, .vote-card.is-scheduled, .run-event-banner--scheduled) { --beam-speed: 1.4s; --beam-length: 50%; --border-width: 5px; --glow-blur: 24px; --beam-color: #22c55e; }
      :is(.vote-timeline__date.is-scheduled, .vote-timeline__bar.is-scheduled, .vote-card.is-scheduled, .run-event-banner--scheduled).is-beam-running { position: relative; isolation: isolate; }
      :is(.vote-timeline__date.is-scheduled, .vote-timeline__bar.is-scheduled, .vote-card.is-scheduled, .run-event-banner--scheduled).is-beam-running::before { content: ""; position: absolute; z-index: 0; inset: 0; box-sizing: border-box; padding: var(--border-width); border-radius: inherit; background: conic-gradient(from var(--beam-angle), transparent 0 25%, var(--beam-color) 38%, #f0fdf4 var(--beam-length), var(--beam-color) 62%, transparent 75% 100%); -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0); -webkit-mask-composite: xor; mask-composite: exclude; filter: drop-shadow(0 0 var(--glow-blur) var(--beam-color)); clip-path: inset(0); pointer-events: none; animation: scheduled-border-beam var(--beam-speed) linear infinite; animation-delay: var(--beam-delay, 0ms); }
      :is(.vote-timeline__date, .vote-timeline__bar, .vote-card, .run-event-banner).is-beam-running > * { position: relative; z-index: 1; }
      @keyframes scheduled-border-beam { to { --beam-angle: 360deg; } }
      .vote-timeline__month { font-size: .42rem; line-height: 8px; }
      .vote-day { display: flex; min-width: 0; }
      .vote-card { display: flex; flex: 1 1 auto; flex-direction: column; align-items: stretch; gap: .4rem; width: 100%; min-width: 0; min-height: 8rem; height: 100%; margin: 0; padding: .55rem .3rem; border: .2rem solid transparent; border-radius: .6rem; background: var(--day-bg); color: var(--day-fg); font-size: clamp(.68rem, 1.45vw, .95rem); text-align: center; overflow: hidden; }
      .vote-day { position: relative; }
      .vote-card:hover, .vote-card:focus-visible, .vote-card.is-selected { border-color: #f5c542; }
      .vote-card.is-scheduled:not(:hover):not(:focus-visible):not(.is-selected) { border-color: #15803d; box-shadow: inset 0 0 0 1px #dcfce7; }
      .vote-card.is-scheduled:hover, .vote-card.is-scheduled:focus-visible, .vote-card.is-scheduled.is-selected { border-color: #f5c542; box-shadow: inset 0 0 0 1px #15803d; }
      .vote-card:focus-visible { outline: .2rem solid #14213d; outline-offset: .15rem; }
      .vote-card { position: relative; touch-action: pan-y; transition: transform .12s ease-out; }
      .vote-card[data-swipe-action="withdraw"] { border-color: #b91c1c; }
      .vote-card__swipe-cue { position: absolute; inset: auto .25rem .2rem; padding: .15rem .25rem; border-radius: .25rem; background: #14213d; color: #fff; font-size: .75rem; font-weight: 700; }
      .vote-card__swipe-cue[data-destructive="true"] { background: #991b1b; }
      .vote-card__swipe-cue:empty { display: none; }
      .run-event-list { display: grid; gap: .45rem; margin: .35rem 0 .55rem; padding: 0; list-style: none; }
      .run-event-list:empty { display: none; }
      .run-event-banner { position: relative; min-width: 0; padding: .55rem .7rem; border: 2px solid; border-radius: .65rem; overflow-wrap: anywhere; touch-action: pan-y; transition: transform .12s ease-out; }
      .run-event-banner--proposed { border-color: #c2410c; background: #fff7ed; color: #7c2d12; }
      .run-event-banner--scheduled { border-color: #15803d; background: #f0fdf4; color: #14532d; }
      .run-event-banner[data-swipe-action="delete"] { border-color: #b91c1c; background: #fef2f2; }
      .run-event-banner__summary { display: flex; flex-wrap: wrap; align-items: baseline; gap: .2rem .6rem; min-width: 0; font-weight: 700; }
      .run-event-banner__date, .run-event-banner__status, .run-event-banner__count { min-width: 0; overflow-wrap: anywhere; }
      .run-event-banner__status { padding: .05rem .35rem; border-radius: .25rem; background: #ffedd5; color: #7c2d12; }
      .run-event-banner--scheduled .run-event-banner__status { background: #dcfce7; color: #14532d; }
      .run-event-banner__voters { display: flex; flex-wrap: wrap; gap: .05rem .3rem; min-width: 0; margin-top: .2rem; overflow-wrap: anywhere; }
      .run-event-banner__voter { min-width: 0; overflow-wrap: anywhere; }
      .run-event-actions { display: flex; flex-wrap: wrap; gap: .4rem; margin-top: .35rem; }
      .run-event-actions button { width: auto; min-width: 7rem; min-height: 2.75rem; margin: 0; }
      .run-event-actions .run-event-delete { background: #991b1b; }
      .run-event-banner__swipe-cue { display: block; min-height: 1.3rem; margin-top: .2rem; font-weight: 700; }
      .run-event-banner__swipe-cue[data-destructive="true"] { color: #991b1b; }
      .run-event-banner__swipe-cue:empty { display: none; }
      .run-event-day-action { position: absolute; z-index: 2; top: 50%; right: .15rem; width: 1px; height: 1px; min-height: 1px; margin: 0; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
      .run-event-day-action:focus-visible { width: auto; height: auto; min-height: 2.75rem; padding: .3rem .45rem; clip-path: none; }
      @media (prefers-reduced-motion: reduce) { .vote-card, .run-event-banner { transition: none; } .is-beam-running::before { animation: none !important; } }
      .vote-card.is-read-only, .vote-card.is-read-only:hover { --day-bg: #68717a !important; --day-fg: #d9dde1 !important; filter: grayscale(1); opacity: .62; cursor: not-allowed; border-color: transparent; }
      .vote-card.is-read-only.is-scheduled, .vote-card.is-read-only.is-scheduled:hover { border-color: #15803d; }
      .vote-card:disabled { cursor: not-allowed; }
      .vote-card__header { display: flex; justify-content: space-between; align-items: flex-start; gap: .25rem; min-width: 0; font-weight: 700; }
      .vote-card__weekday, .vote-card__date { overflow-wrap: anywhere; }
      .vote-card__weekday--full { font-size: 1.35rem; line-height: 1.1; }
      .vote-card__weekday--compact, .vote-card__date--compact { display: none; }
      .vote-card__date { font-variant-numeric: tabular-nums; }
      .vote-card__count { display: inline-flex; align-items: center; justify-content: center; align-self: center; width: 3.35rem; height: 3.35rem; margin: auto 0; border-radius: 50%; font-size: clamp(1.15rem, 6vw, 2.1rem); line-height: 1; font-variant-numeric: tabular-nums; }
      .vote-card__count--selected { background: #fff; color: #0b3d2e; box-shadow: 0 0 0 .16rem #fff; }
      .vote-card__names { display: flex; min-width: 0; min-height: 1.3rem; align-items: center; overflow: hidden; text-align: left; }
      .vote-card__names-empty { display: block; width: 100%; text-align: center; }
      .vote-card__names-track { display: inline-flex; max-width: max-content; white-space: nowrap; animation: voter-name-loop var(--vote-marquee-duration, 0s) linear infinite; }
      .vote-card__names-copy { display: inline-flex; flex: 0 0 auto; }
      .vote-card__names-track span { flex: 0 0 auto; }
      .vote-card.is-touch-paused .vote-card__names-track, .vote-card:hover .vote-card__names-track, .vote-card:focus-within .vote-card__names-track { animation-play-state: paused; }
      @keyframes voter-name-loop { from { transform: translateX(var(--vote-marquee-start, 100%)); } to { transform: translateX(var(--vote-marquee-end, -100%)); } }
      @media (prefers-reduced-motion: reduce) { .vote-card__names-track { animation: none; display: block; white-space: normal; overflow-wrap: anywhere; } .vote-card__names-copy--canonical { display: block; } }
      @media (max-width: 44rem) {
        .vote-page-main { padding-inline: .75rem; }
        .vote-page-main > section { padding: .55rem .75rem; }
        .vote-page-main h1 { margin: .2rem 0; font-size: 1.35rem; }
        .vote-page-main h2 { margin: .35rem 0; font-size: 1rem; }
        .vote-page-main .vote-timeline > h2 { margin: .1rem 0 .2rem; font-size: .95rem; }
        .vote-page-main > section > p { margin: .25rem 0; }
        .vote-board { grid-template-columns: minmax(0, 1fr); width: 100%; gap: .15rem; margin-block: .35rem; }
        .vote-day { width: 100%; }
        .vote-card { min-height: 2.75rem; height: 2.75rem; flex-direction: row; align-items: center; gap: .5rem; padding: .2rem .55rem; font-size: 1rem; }
        .vote-card__weekday--full, .vote-card__date--full { display: none; }
        .vote-card__weekday--compact, .vote-card__date--compact { display: block; }
        .vote-card__weekday--compact { font-size: 1.25rem; line-height: 1.1; white-space: nowrap; text-transform: uppercase; letter-spacing: .03em; }
        .vote-card__date--compact { font-size: 1rem; line-height: 1; }
        .vote-card__date--compact span { display: block; }
        .vote-card__header { flex: 0 0 4.75rem; align-items: center; }
        .vote-card__date--compact { font-size: .8rem; }
        .vote-card__count { flex: 0 0 2.35rem; width: 2.35rem; height: 2.35rem; min-width: 2.35rem; margin: 0; font-size: 1.4rem; }
        .vote-card__names { flex: 1 1 auto; min-height: 1.2rem; }
        .week-navigation { margin-top: .25rem; gap: .25rem; }
        .week-navigation button { min-height: 2.35rem; margin-top: 0; }
        .run-event-banner { padding: .45rem .55rem; }
        .run-event-actions button { flex: 1 1 8rem; }
      }
      @media (max-width: 380px) { .vote-page-main { padding-inline: .5rem; } .vote-page-main > section { padding-inline: .5rem; } }
    </style>
  </head>
  <body><main${mainClass ? ` class="${mainClass}"` : ''}>${content}</main>${scriptSrc ? `<script src="${scriptSrc}"></script>` : ''}${script ? `<script type="module">${script}</script>` : ''}</body>
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

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function adminActionBody(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== 2 || body.confirmation !== true
    || typeof body.requestId !== 'string' || !CANONICAL_UUID.test(body.requestId)) {
    throw new AdminActionError(400, 'INVALID_ADMIN_ACTION_REQUEST', 'ข้อมูลการกระทำไม่ถูกต้อง / The administrator action request is invalid.');
  }
  return body;
}

function runEventActionBody(body, { proposal = false, status = false } = {}) {
  const keys = proposal ? ['requestId'] : status
    ? ['eventId', 'requestId', 'revision', 'status']
    : ['eventId', 'requestId', 'revision'];
  if (body === null || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== keys.length || !keys.every((key) => Object.hasOwn(body, key))
    || typeof body.requestId !== 'string' || !CANONICAL_UUID.test(body.requestId)) {
    throw new RunEventError(400, 'INVALID_RUN_EVENT_REQUEST', 'คำขอกิจกรรมไม่ถูกต้อง / The event request is invalid.');
  }
  if (!proposal && (!Number.isSafeInteger(body.eventId) || body.eventId < 1
    || !Number.isSafeInteger(body.revision) || body.revision < 1)) {
    throw new RunEventError(400, 'INVALID_RUN_EVENT_REQUEST', 'คำขอกิจกรรมไม่ถูกต้อง / The event request is invalid.');
  }
  if (status && body.status !== 'proposed' && body.status !== 'scheduled') {
    throw new RunEventError(400, 'INVALID_RUN_EVENT_REQUEST', 'คำขอกิจกรรมไม่ถูกต้อง / The event request is invalid.');
  }
  return body;
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

const changePinPage = () => page({
  title: 'Run Together | เปลี่ยน PIN / Change PIN',
  content: `<section id="protected-content" hidden>
    <h1>เปลี่ยน PIN / Change PIN</h1>
    <p>เปลี่ยน PIN สำหรับบัญชีปัจจุบัน / Change the PIN for your current account.</p>
    <form id="pin-form">
      <label>PIN ปัจจุบัน / Current PIN <input name="currentPin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="current-password" required></label>
      <label>PIN ใหม่ / New PIN <input name="newPin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="new-password" required></label>
      <label>ยืนยัน PIN ใหม่ / Confirm new PIN <input name="newPinConfirmation" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="new-password" required></label>
      <button>Change PIN</button>
    </form>
    <p id="message" class="message" role="status"></p>
    <a id="return-to-vote" href="/vote">กลับไปหน้าโหวต / Return to vote</a>
  </section>`,
  script: `
    const protectedContent = document.querySelector('#protected-content');
    const pinForm = document.querySelector('#pin-form');
    const message = document.querySelector('#message');
    let csrfToken = '';
    let sessionCheck = 0;
    function guardProtectedContent() {
      protectedContent.hidden = true;
      csrfToken = '';
      pinForm.reset();
      message.textContent = '';
    }
    function redirectToLogin() {
      guardProtectedContent();
      location.replace('/');
    }
    async function loadSession() {
      const currentCheck = ++sessionCheck;
      guardProtectedContent();
      try {
        const response = await fetch('/api/session', { cache: 'no-store' });
        if (currentCheck !== sessionCheck) return;
        if (!response.ok) { redirectToLogin(); return; }
        const session = await response.json();
        if (currentCheck !== sessionCheck) return;
        csrfToken = session.csrfToken;
        protectedContent.hidden = false;
      } catch {
        if (currentCheck === sessionCheck) redirectToLogin();
      }
    }
    pinForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      message.textContent = '';
      const form = new FormData(event.currentTarget);
      try {
        const response = await fetch('/api/account/pin', {
          method: 'PUT',
          headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
          body: JSON.stringify(Object.fromEntries(form)),
        });
        if (response.status === 401) { redirectToLogin(); return; }
        const result = response.status === 204
          ? { message: 'เปลี่ยน PIN สำเร็จ / PIN changed successfully.' }
          : await response.json();
        message.textContent = result.message;
        if (response.ok) pinForm.reset();
      } catch {
        message.textContent = 'เปลี่ยน PIN ไม่สำเร็จ / Could not change PIN.';
      }
    });
    window.addEventListener('pageshow', loadSession);
    loadSession();
  `,
});

const adminPage = () => page({
  title: 'Run Together | ผู้ดูแลระบบ / Admin',
  content: `<section id="admin-content">
    <h1>ผู้ดูแลระบบ / Admin</h1>
    <p>จัดการผู้ใช้ / Manage users</p>
    <a href="/vote" class="button">กลับไปหน้าโหวต / Back to vote</a>
    <p id="admin-message" class="message" role="status"></p>
    <p>Time zone: Asia/Bangkok</p>
    <div id="admin-users" aria-live="polite"></div>
  </section>`,
  script: `
    import { formatDateTime } from '/date-time.js?v=issue-27';
    const message = document.querySelector('#admin-message');
    const usersRegion = document.querySelector('#admin-users');
    let csrfToken = '';
    function addText(parent, tag, text) { const element = document.createElement(tag); element.textContent = text; parent.append(element); return element; }
    function showError(result) { message.textContent = result.message || 'เกิดข้อผิดพลาด / Something went wrong.'; }
    function makeTrashButton(userName) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'delete-user'; button.setAttribute('aria-label', 'Delete ' + userName); button.title = 'Delete ' + userName;
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M6 7h12m-9 0V5h6v2m-8 0 1 13h4 4l1-13M10 11v5m4-5v5'); path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '2');
      svg.append(path); button.append(svg); return button;
    }
    function makeDialog({ user, kind, onConfirm }) {
      const dialog = document.createElement('dialog');
      dialog.setAttribute('aria-labelledby', kind + '-title-' + user.id);
      const title = addText(dialog, 'h2', kind === 'reset' ? 'Reset votes for ' + user.displayName : 'Delete ' + user.displayName);
      title.id = kind + '-title-' + user.id;
      const detail = kind === 'reset'
        ? 'All votes for this user will be removed. The account and sessions stay active.'
        : 'The account, votes, and sessions will be permanently deleted.';
      addText(dialog, 'p', detail);
      const actions = document.createElement('div'); actions.className = 'dialog-actions';
      const confirm = document.createElement('button'); confirm.type = 'button'; confirm.textContent = kind === 'reset' ? 'Yes, reset votes' : 'Yes, delete user';
      const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'secondary'; cancel.textContent = 'No, cancel';
      const close = document.createElement('button'); close.type = 'button'; close.className = 'dialog-close'; close.setAttribute('aria-label', 'Close ' + kind + ' dialog'); close.textContent = 'Close';
      actions.append(confirm, cancel, close); dialog.append(actions); document.body.append(dialog);
      dialog.dataset.requestId = '';
      dialog.addEventListener('close', () => { dialog.dataset.requestId = ''; });
      cancel.addEventListener('click', () => dialog.close());
      close.addEventListener('click', () => dialog.close());
      dialog.addEventListener('cancel', () => { dialog.close(); });
      confirm.addEventListener('click', () => onConfirm({ dialog, confirm }));
      return { dialog, confirm, cancel };
    }
    function renderUsers(users) {
      usersRegion.replaceChildren();
      users.forEach((user) => {
        const article = document.createElement('article'); article.className = 'admin-user';
        const heading = document.createElement('div'); heading.className = 'admin-user-heading';
        addText(heading, 'h2', user.displayName + ' / ' + user.role);
        const metadata = document.createElement('dl'); metadata.className = 'admin-user-metadata';
        const created = document.createElement('div'); created.className = 'admin-user-metadata-item';
        addText(created, 'dt', 'Created'); addText(created, 'dd', formatDateTime(user.createdAt));
        const updated = document.createElement('div'); updated.className = 'admin-user-metadata-item';
        addText(updated, 'dt', 'Updated'); addText(updated, 'dd', formatDateTime(user.updatedAt));
        metadata.append(created, updated); article.append(metadata);
        if (user.role === 'user') {
          const resetForm = document.createElement('form');
          resetForm.className = 'actions';
          const resetInput = document.createElement('input');
          resetInput.name = 'newPin'; resetInput.type = 'password'; resetInput.inputMode = 'numeric'; resetInput.pattern = '[0-9]{4}'; resetInput.maxLength = 4; resetInput.required = true; resetInput.placeholder = 'PIN 4 หลัก / 4-digit PIN';
          const resetConfirm = document.createElement('input');
          resetConfirm.name = 'newPinConfirmation'; resetConfirm.type = 'password'; resetConfirm.inputMode = 'numeric'; resetConfirm.pattern = '[0-9]{4}'; resetConfirm.maxLength = 4; resetConfirm.required = true; resetConfirm.placeholder = 'ยืนยัน PIN / Confirm PIN';
          const resetButton = document.createElement('button'); resetButton.textContent = 'รีเซ็ต PIN / Reset PIN';
          resetForm.append(resetInput, resetConfirm, resetButton);
          resetForm.addEventListener('submit', async (event) => {
            event.preventDefault();
            const form = new FormData(resetForm);
            const response = await fetch('/api/admin/users/' + encodeURIComponent(user.id) + '/pin', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify(Object.fromEntries(form)) });
            if (response.ok) { resetForm.reset(); message.textContent = 'รีเซ็ต PIN สำเร็จ / PIN reset successfully.'; } else showError(await response.json());
          });
          const resetLabel = document.createElement('label'); resetLabel.className = 'admin-reset-toggle';
          const resetToggle = document.createElement('input'); resetToggle.type = 'checkbox'; resetToggle.setAttribute('aria-label', 'Reset votes for ' + user.displayName);
          resetLabel.append(resetToggle, document.createTextNode(' Reset votes for ' + user.displayName));
          const deleteButton = makeTrashButton(user.displayName); heading.append(deleteButton); article.prepend(heading); article.append(resetForm, resetLabel);
          const reset = makeDialog({ user, kind: 'reset', onConfirm: ({ dialog, confirm }) => submitAction({ user, kind: 'reset', dialog, confirm, resetToggle }) });
          const deletion = makeDialog({ user, kind: 'delete', onConfirm: ({ dialog, confirm }) => submitAction({ user, kind: 'delete', dialog, confirm, resetToggle }) });
          reset.dialog.addEventListener('close', () => { resetToggle.checked = false; });
          resetToggle.addEventListener('change', () => {
            if (!resetToggle.checked) return;
            reset.dialog.dataset.requestId = crypto.randomUUID(); reset.dialog.showModal(); reset.cancel.focus();
          });
          deleteButton.addEventListener('click', () => {
            deletion.dialog.dataset.requestId = crypto.randomUUID(); deletion.dialog.showModal(); deletion.cancel.focus();
          });
        } else {
          article.prepend(heading);
        }
        usersRegion.append(article);
      });
    }
    async function submitAction({ user, kind, dialog, confirm, resetToggle }) {
      if (confirm.disabled) return;
      const row = resetToggle.closest('.admin-user');
      const rowControls = row.querySelectorAll('button, input'); rowControls.forEach((control) => { control.disabled = true; });
      confirm.disabled = true;
      try {
        const response = await fetch('/api/admin/users/' + encodeURIComponent(user.id) + (kind === 'reset' ? '/votes' : ''), {
          method: 'DELETE', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
          body: JSON.stringify({ confirmation: true, requestId: dialog.dataset.requestId }),
        });
        const result = await response.json();
        if (response.status === 404) { showError(result); dialog.close(); await loadUsers(); return; }
        if (!response.ok) { showError(result); return; }
        message.textContent = kind === 'reset' ? 'Votes reset successfully.' : 'User deleted successfully.';
        dialog.close();
        if (kind === 'delete') await loadUsers();
      } catch { message.textContent = 'ดำเนินการไม่สำเร็จ / Could not complete the action.'; }
      finally { if (dialog.open) confirm.disabled = false; rowControls.forEach((control) => { control.disabled = false; }); resetToggle.checked = false; }
    }
    async function loadUsers() {
      const response = await fetch('/api/admin/users', { cache: 'no-store' });
      if (response.status === 401) { location.replace('/'); return; }
      if (response.status === 403) { location.replace('/vote'); return; }
      if (!response.ok) { showError(await response.json()); return; }
      renderUsers((await response.json()).users);
    }
    async function loadSession() {
      const response = await fetch('/api/session', { cache: 'no-store' });
      if (!response.ok) { location.replace('/'); return; }
      const session = await response.json();
      if (session.role !== 'admin') { location.replace('/vote'); return; }
      csrfToken = session.csrfToken; await loadUsers();
    }
    loadSession();
  `,
});

export function createApp({ databaseReady = false, database, env = process.env, now = () => new Date(), onVoteChanged = () => {}, onRunEventChanged = () => {}, onUserSessionsRevoked = () => {}, onUserDeleted = () => {}, onWeekReset = () => {} } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '10kb' }));
  const auth = database ? createAuthService({ database, env, now }) : null;

  const sendError = (response, error) => {
    const safe = error instanceof AuthError || error instanceof AdminActionError || error instanceof VoteError || error instanceof RunEventError
      ? error
      : new AuthError(500, 'SERVER_ERROR', 'เกิดข้อผิดพลาด กรุณาลองใหม่ / Something went wrong; please try again.');
    if (!(error instanceof AuthError) && !(error instanceof AdminActionError) && !(error instanceof VoteError) && !(error instanceof RunEventError)) console.error('Request failed:', error);
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

  app.get('/date-time.js', (_request, response) => response.type('application/javascript').send(dateTimeScript));

  app.get('/run-events.js', (_request, response) => response.type('application/javascript').send(runEventsScript));

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

    app.get('/admin', (request, response) => {
      const session = auth.requireAdmin(request, response);
      if (!session) return;
      response.setHeader('Cache-Control', 'no-store');
      response.type('html').send(adminPage());
    });

    app.get('/change-pin', (request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      const session = auth.requireSession(request, response);
      if (!session) return;
      response.type('html').send(changePinPage());
    });

    app.get('/api/admin/users', (request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      const session = auth.requireAdmin(request, response);
      if (!session) return;
      response.json({ users: listUsers(database) });
    });

    app.put('/api/admin/users/:id/pin', async (request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      const session = auth.requireAdmin(request, response);
      if (!session) return;
      try {
        auth.assertCsrf(request, session);
        const userId = Number(request.params.id);
        if (!Number.isSafeInteger(userId) || userId < 1) throw new AuthError(400, 'INVALID_USER_ID', 'ผู้ใช้ไม่ถูกต้อง / The user is invalid.');
        await auth.resetUserPin(userId, request.body);
        onUserSessionsRevoked(userId);
        response.status(204).end();
      } catch (error) {
        sendError(response, error);
      }
    });

    app.delete('/api/admin/users/:id/votes', (request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      const session = auth.requireAdmin(request, response);
      if (!session) return;
      try {
        auth.assertCsrf(request, session);
        const userId = Number(request.params.id);
        if (!Number.isSafeInteger(userId) || userId < 1) throw new AdminActionError(400, 'INVALID_USER_ID', 'ผู้ใช้ไม่ถูกต้อง / The user is invalid.');
        const { requestId } = adminActionBody(request.body);
        const result = resetUserVotes(database, { adminUserId: session.user_id, targetUserId: userId, requestId, now });
        if (!result.replayed) result.affectedDates.forEach((date) => onVoteChanged(date));
        response.json({ deletedVoteCount: result.deletedVoteCount, requestId: result.requestId, replayed: result.replayed });
      } catch (error) {
        sendError(response, error);
      }
    });

    app.delete('/api/admin/users/:id', (request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      const session = auth.requireAdmin(request, response);
      if (!session) return;
      try {
        auth.assertCsrf(request, session);
        const userId = Number(request.params.id);
        if (!Number.isSafeInteger(userId) || userId < 1) throw new AdminActionError(400, 'INVALID_USER_ID', 'ผู้ใช้ไม่ถูกต้อง / The user is invalid.');
        const { requestId } = adminActionBody(request.body);
        const deletion = deleteUserWithAudit(database, { adminUserId: session.user_id, targetUserId: userId, requestId, now });
        if (!deletion.replayed) onUserDeleted(userId, deletion.affectedDates);
        response.json({ deletedVoteCount: deletion.deletedVoteCount, requestId: deletion.requestId, replayed: deletion.replayed });
      } catch (error) {
        sendError(response, error);
      }
    });

    app.delete('/api/admin/weeks/:monday/votes', (request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      const session = auth.requireAdmin(request, response);
      if (!session) return;
      try {
        auth.assertCsrf(request, session);
        if (request.body?.confirmation !== true) {
          throw new AuthError(400, 'RESET_CONFIRMATION_REQUIRED', 'ต้องยืนยันการรีเซ็ต / Explicit reset confirmation is required.');
        }
        const result = resetWeek(database, { monday: request.params.monday, now });
        result.affectedDates.forEach((date) => onVoteChanged(date));
        onWeekReset(result.monday, result.sunday);
        response.status(204).end();
      } catch (error) {
        sendError(response, error);
      }
    });

    app.post('/api/events/:date', (request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      const session = auth.requireSession(request, response);
      if (!session) return;
      try {
        auth.assertCsrf(request, session);
        const { requestId } = runEventActionBody(request.body, { proposal: true });
        const result = proposeRunEvent(database, { userId: session.user_id, eventDate: request.params.date, requestId, now });
        if (result.changed) onRunEventChanged(request.params.date);
        response.status(result.changed ? 201 : 200).json(result);
      } catch (error) {
        sendError(response, error);
      }
    });

    app.delete('/api/events/:date', (request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      const session = auth.requireSession(request, response);
      if (!session) return;
      try {
        auth.assertCsrf(request, session);
        const { eventId, revision, requestId } = runEventActionBody(request.body);
        const result = withdrawRunEvent(database, {
          userId: session.user_id, eventDate: request.params.date, eventId, revision, requestId, now,
        });
        if (result.changed) onRunEventChanged(request.params.date);
        response.json(result);
      } catch (error) {
        sendError(response, error);
      }
    });

    app.put('/api/admin/events/:date', (request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      const session = auth.requireAdmin(request, response);
      if (!session) return;
      try {
        auth.assertCsrf(request, session);
        const { eventId, revision, requestId, status } = runEventActionBody(request.body, { status: true });
        const result = setRunEventStatus(database, {
          adminUserId: session.user_id, eventDate: request.params.date,
          eventId, revision, requestId, status, now,
        });
        if (result.changed) onRunEventChanged(request.params.date);
        response.json(result);
      } catch (error) {
        sendError(response, error);
      }
    });

    app.delete('/api/admin/events/:date', (request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      const session = auth.requireAdmin(request, response);
      if (!session) return;
      try {
        auth.assertCsrf(request, session);
        const { eventId, revision, requestId } = runEventActionBody(request.body);
        const result = deleteRunEvent(database, {
          adminUserId: session.user_id, eventDate: request.params.date, eventId, revision, requestId, now,
        });
        if (result.changed) onRunEventChanged(request.params.date);
        response.json(result);
      } catch (error) {
        sendError(response, error);
      }
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

    app.get('/api/vote-timeline', (request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      const session = auth.requireSession(request, response);
      if (!session) return;
      response.json(getEligiblePeriodVoteTotals(database, { now }));
    });

    app.put('/api/votes/:date', (request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      const session = auth.requireSession(request, response);
      if (!session) return;
      try {
        auth.assertCsrf(request, session);
        assertVoteBody(request.body);
        const result = setVote(database, {
          userId: session.user_id,
          voteDate: request.params.date,
          now,
          body: request.body,
        });
        if (result.changed) onVoteChanged(result.patch.date);
        response.json(result.patch);
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
      const resetControl = session.role === 'admin'
        ? '<div class="actions"><button id="reset-week" type="button" class="admin-action" hidden>Reset votes</button><button id="manage-user" type="button" class="admin-action">manage user</button></div>'
        : '';
      response.type('html').send(page({
        title: 'Run Together | Vote',
        mainClass: 'vote-page-main',
        scriptSrc: '/socket.io/socket.io.js',
        content: `<section id="protected-content" hidden>
          <h1>Run Together</h1>
          <section id="vote-timeline" class="vote-timeline" aria-labelledby="vote-timeline-heading">
            <h2 id="vote-timeline-heading">Vote timeline</h2>
            <p id="vote-timeline-range" class="vote-timeline__range" role="status">Loading vote totals…</p>
            <ol id="vote-timeline-days" class="vote-timeline__days" aria-label="Daily vote totals in chronological order"></ol>
          </section>
          <p>ยินดีต้อนรับ / Welcome, <strong id="display-name">${displayName}</strong></p>
          <h2 id="week-heading">สัปดาห์ / Week</h2>
          <p id="week-range"></p>
          <p id="message" class="message" role="status"></p>
          <ol id="run-events" class="run-event-list" aria-label="Run events"></ol>
          <ol id="week-days" class="vote-board" aria-label="Seven-day voting board / กระดานเลือกวันทั้งเจ็ด"></ol>
          <nav class="week-navigation actions" aria-label="Week navigation">
            <button id="previous-week" type="button" class="secondary" aria-label="Previous week">&lt;&lt;</button>
            <button id="current-week" type="button">Now</button>
            <button id="next-week" type="button" aria-label="Next week">&gt;&gt;</button>
          </nav>
          ${resetControl}
          <a id="change-pin" class="button" href="/change-pin">เปลี่ยน PIN / Change PIN</a>
          <div class="actions"><button id="logout" type="button" class="secondary">Logout</button></div>
        </section>`,
        script: `import { applyVoteCardPresentation, colorForDay, configureVoterNamesMarquee, createScheduledEffectController, createSocketRepairController, createVoterNamesRegion as buildVoterNamesRegion, createVoteTimelineController, formatDisplayDate, patchVoteDay } from '/vote-board.js?v=issue-34-beam-2';
          import { attachHorizontalSwipe, formatRunEventDate, getDateCardSwipeAction, getDateCardSwipePreview, getRunEventBannerSwipeAction, getRunEventBannerSwipePreview, millisecondsUntilBangkokMidnight, sortRunEventsForPresentation } from '/run-events.js?v=issue-34-beam-1';
          let csrfToken = '';
          let sessionCheck = 0;
          let weekLoadSequence = 0;
          let weekState = null;
          let eventsByDate = new Map();
          let rolloverTimer = null;
          const scheduledEffects = createScheduledEffectController();
          const runEventElements = new Map();
          const runEventHandlers = new Map();
          const pendingEventDates = new Set();
          let isAdmin = false;
          const currentWeekMonday = '${currentWeek}';
          let weekMonday = currentWeekMonday;
          const protectedContent = document.querySelector('#protected-content');
          const displayName = document.querySelector('#display-name');
          const weekHeading = document.querySelector('#week-heading');
          const weekRange = document.querySelector('#week-range');
          const weekDays = document.querySelector('#week-days');
          const timelineDays = document.querySelector('#vote-timeline-days');
          const timelineRange = document.querySelector('#vote-timeline-range');
          const previousWeek = document.querySelector('#previous-week');
          const currentWeekButton = document.querySelector('#current-week');
          const nextWeek = document.querySelector('#next-week');
          const resetWeek = document.querySelector('#reset-week');
          const manageUser = document.querySelector('#manage-user');
          const message = document.querySelector('#message');
          const runEvents = document.querySelector('#run-events');
          function guardProtectedContent() { weekLoadSequence += 1; window.clearTimeout(rolloverTimer); protectedContent.hidden = true; csrfToken = ''; displayName.textContent = ''; weekDays.replaceChildren(); runEvents.replaceChildren(); timelineDays.replaceChildren(); scheduledEffects.sync('banner', []); scheduledEffects.sync('date-card', []); scheduledEffects.sync('timeline', []); runEventHandlers.forEach(({ abort, disposeSwipe }) => { abort.abort(); disposeSwipe?.(); }); runEventHandlers.clear(); runEventElements.clear(); weekState = null; eventsByDate = new Map(); message.textContent = ''; }
          function redirectToLogin() { guardProtectedContent(); location.replace('/'); }
          function addText(parent, tag, text) { const element = document.createElement(tag); element.textContent = text; parent.append(element); return element; }
          const timelineItemsByDate = new Map();
          const timelineController = createVoteTimelineController({
            render(rows) {
              timelineDays.style.gridTemplateColumns = 'repeat(' + rows.length + ', minmax(0, 1fr))';
              const currentDates = new Set(rows.map(({ date }) => date));
              timelineItemsByDate.forEach((item, date) => {
                if (!currentDates.has(date)) { item.remove(); timelineItemsByDate.delete(date); }
              });
              const items = rows.map((row, index) => {
                let item = timelineItemsByDate.get(row.date);
                if (!item) {
                  item = document.createElement('li');
                  item.className = 'vote-timeline__day';
                  const count = addText(item, 'span', '');
                  count.className = 'vote-timeline__count';
                  const track = document.createElement('span');
                  track.className = 'vote-timeline__track';
                  track.setAttribute('aria-hidden', 'true');
                  const bar = document.createElement('span');
                  bar.className = 'vote-timeline__bar';
                  const cue = document.createElement('span');
                  cue.textContent = '★';
                  cue.className = 'vote-timeline__top-cue';
                  track.append(bar, cue);
                  const date = document.createElement('time');
                  date.className = 'vote-timeline__date';
                  const day = addText(date, 'span', '');
                  const month = addText(date, 'span', '');
                  month.className = 'vote-timeline__month';
                  item.append(count, track, date);
                  timelineItemsByDate.set(row.date, item);
                }
                const [count, track, date] = item.children;
                const [bar, cue] = track.children;
                const [day, month] = date.children;
                item.dataset.date = row.date;
                item.setAttribute('aria-label', row.accessibleLabel);
                count.textContent = String(row.voteCount);
                count.className = 'vote-timeline__count' + (row.showCount ? '' : ' is-zero');
                count.setAttribute('aria-hidden', String(!row.showCount));
                bar.className = 'vote-timeline__bar' + (row.isTopRanked ? ' is-top-ranked' : '') + (row.isScheduled ? ' is-scheduled' : '');
                bar.dataset.date = row.date;
                bar.style.height = row.barHeightPercent + '%';
                cue.hidden = !row.showTopCue;
                date.dateTime = row.date;
                date.className = 'vote-timeline__date' + (row.isScheduled ? ' is-scheduled' : '');
                day.textContent = row.dayLabel;
                month.textContent = row.monthLabel;
                month.hidden = index !== 0 && row.dayLabel !== '1';
                return { row, item, date, bar };
              });
              items.forEach(({ item }, index) => {
                if (timelineDays.children[index] !== item) timelineDays.insertBefore(item, timelineDays.children[index] ?? null);
              });
              scheduledEffects.sync('timeline', items.filter(({ row }) => row.isScheduled).map(({ row, date, bar }) => ({
                key: row.date,
                element: date,
                targets: row.voteCount > 0 ? [date, bar] : [date],
                scheduled: true,
              })));
            },
          });
          async function loadTimeline() {
            let totals;
            try {
              const refreshed = await timelineController.refresh(async () => {
                const response = await fetch('/api/vote-timeline', { cache: 'no-store' });
                if (response.status === 401) { redirectToLogin(); throw new Error('unauthenticated'); }
                totals = await response.json();
                if (!response.ok) throw new Error(totals.message || 'Could not load vote totals.');
                return totals;
              });
              if (refreshed && totals) { timelineRange.textContent = formatDisplayDate(totals.startDate) + ' – ' + formatDisplayDate(totals.endDate) + ' · ★ = highest votes'; return true; }
              return false;
            } catch {
              timelineRange.textContent = 'Could not load vote totals.';
              return false;
            }
          }
          const weekdays = [
            { thai: 'จ.', english: 'MON' }, { thai: 'อ.', english: 'TUE' }, { thai: 'พ.', english: 'WED' },
            { thai: 'พฤ.', english: 'THU' }, { thai: 'ศ.', english: 'FRI' }, { thai: 'ส.', english: 'SAT' }, { thai: 'อา.', english: 'SUN' },
          ];
          function appendVoterNames(parent, names) { parent.append(buildVoterNamesRegion(document, names)); }
          function eventActionLabel(action) {
            return action === 'propose' ? 'Propose run' : action === 'withdraw' ? 'Withdraw proposal' : '';
          }
          function makeDayEventAction(row, day) {
            row.querySelector('.run-event-day-action')?.remove();
            const event = eventsByDate.get(day.date);
            const selected = weekState?.currentUserSelectedDates.includes(day.date) ?? false;
            if (!day.eligible || !selected || event?.status === 'scheduled') return;
            const action = event ? 'withdraw' : 'propose';
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'run-event-day-action';
            button.dataset.date = day.date;
            button.dataset.runEventAction = action;
            button.setAttribute('aria-label', eventActionLabel(action) + ' on ' + formatRunEventDate(day.date));
            button.textContent = eventActionLabel(action);
            button.disabled = pendingEventDates.has(day.date);
            button.addEventListener('click', () => void submitRunEventAction(day.date, action, event));
            row.append(button);
          }
          function captureRunEventActionFocus(element) {
            const banner = element?.closest?.('.run-event-banner');
            if (!banner) return null;
            if (element.matches('.run-event-actions [data-run-event-status]')) return { date: banner.dataset.date, action: 'status' };
            if (element.matches('.run-event-actions .run-event-delete')) return { date: banner.dataset.date, action: 'delete' };
            return null;
          }
          function restoreRunEventActionFocus(target) {
            if (!target) return;
            const banner = runEventElements.get(target.date);
            const selector = target.action === 'status' ? '.run-event-actions [data-run-event-status]' : '.run-event-actions .run-event-delete';
            const button = banner?.querySelector(selector);
            if (button && !button.disabled) button.focus({ preventScroll: true });
          }
          function renderRunEvents(events) {
            const focusIntent = captureRunEventActionFocus(document.activeElement);
            const presentationEvents = sortRunEventsForPresentation(events);
            const activeDates = new Set(presentationEvents.map(({ date }) => date));
            runEventElements.forEach((banner, date) => {
              if (activeDates.has(date)) return;
              const handlers = runEventHandlers.get(date);
              handlers?.abort.abort();
              handlers?.disposeSwipe?.();
              banner.remove();
              runEventElements.delete(date);
              runEventHandlers.delete(date);
            });
            const banners = presentationEvents.map((event) => {
              let banner = runEventElements.get(event.date);
              if (!banner) {
                banner = document.createElement('li');
                runEventElements.set(event.date, banner);
              }
              const previousHandlers = runEventHandlers.get(event.date);
              previousHandlers?.abort.abort();
              previousHandlers?.disposeSwipe?.();
              const abort = new AbortController();
              banner.replaceChildren();
              banner.className = 'run-event-banner run-event-banner--' + event.status;
              banner.dataset.date = event.date;
              const summary = document.createElement('div');
              summary.className = 'run-event-banner__summary';
              const date = document.createElement('time');
              date.className = 'run-event-banner__date';
              date.dateTime = event.date;
              date.textContent = formatRunEventDate(event.date);
              const status = addText(summary, 'span', event.status === 'scheduled' ? 'Scheduled' : 'Proposed');
              status.className = 'run-event-banner__status';
              addText(summary, 'span', event.voteCount + (event.voteCount === 1 ? ' vote' : ' votes')).className = 'run-event-banner__count';
              summary.prepend(date);
              const voters = addText(banner, 'div', event.voterNames.length ? event.voterNames.join(', ') : 'No voters');
              voters.className = 'run-event-banner__voters';
              voters.setAttribute('aria-label', 'Current voters');
              banner.prepend(summary);
              if (isAdmin) {
                const actions = document.createElement('div');
                actions.className = 'run-event-actions';
                const toggle = addText(actions, 'button', event.status === 'proposed' ? 'Schedule run' : 'Revert to proposed');
                toggle.type = 'button';
                toggle.dataset.runEventStatus = event.status;
                toggle.disabled = pendingEventDates.has(event.date);
                toggle.addEventListener('click', () => void submitRunEventAction(event.date, event.status === 'proposed' ? 'schedule' : 'revert', event), { signal: abort.signal });
                const remove = addText(actions, 'button', 'Delete event');
                remove.type = 'button';
                remove.className = 'run-event-delete';
                remove.disabled = pendingEventDates.has(event.date);
                remove.addEventListener('click', () => {
                  if (window.confirm('Delete this event permanently? There is no undo.')) {
                    void submitRunEventAction(event.date, 'delete', event);
                  }
                }, { signal: abort.signal });
                banner.append(actions);
                banner.addEventListener('click', (clickEvent) => {
                  if (clickEvent.target.closest('button, a, input, select, textarea')) return;
                  void submitRunEventAction(event.date, event.status === 'proposed' ? 'schedule' : 'revert', event);
                }, { signal: abort.signal });
              }
              const cue = addText(banner, 'span', '');
              cue.className = 'run-event-banner__swipe-cue';
              cue.setAttribute('aria-live', 'polite');
              const disposeSwipe = attachHorizontalSwipe(banner, {
                resolveAction: (deltaX, deltaY) => getRunEventBannerSwipeAction({ deltaX, deltaY, isAdmin }),
                resolvePreview: (deltaX, deltaY) => getRunEventBannerSwipePreview({ deltaX, deltaY, isAdmin }),
                onPreview(action, deltaX, ready) {
                  cue.textContent = action ? (ready ? 'Release to delete' : 'Swipe ' + (deltaX < 0 ? 'left' : 'right') + ' to delete') : '';
                  if (action) cue.dataset.destructive = 'true';
                  else cue.removeAttribute('data-destructive');
                },
                onCommit(action) { if (action === 'delete') void submitRunEventAction(event.date, 'delete', event); },
              });
              runEventHandlers.set(event.date, { abort, disposeSwipe });
              return banner;
            });
            banners.forEach((banner, index) => {
              if (runEvents.children[index] !== banner) runEvents.insertBefore(banner, runEvents.children[index] ?? null);
            });
            scheduledEffects.sync('banner', presentationEvents.filter(({ status }) => status === 'scheduled').map((event) => ({
              key: event.date,
              element: runEventElements.get(event.date),
              scheduled: true,
            })));
            if (focusIntent && !pendingEventDates.has(focusIntent.date)) restoreRunEventActionFocus(focusIntent);
          }
          async function submitRunEventAction(date, action, event) {
            if (pendingEventDates.has(date)) return false;
            const originalActiveElement = document.activeElement;
            const focusIntent = captureRunEventActionFocus(originalActiveElement);
            pendingEventDates.add(date);
            runEvents.querySelectorAll('.run-event-actions button').forEach((button) => {
              if (button.closest('.run-event-banner')?.dataset.date === date) button.disabled = true;
            });
            const requestId = crypto.randomUUID();
            let path = '/api/events/' + encodeURIComponent(date);
            let method = 'POST';
            let body = { requestId };
            if (action === 'withdraw') {
              method = 'DELETE';
              body = { eventId: event.eventId, revision: event.revision, requestId };
            } else if (action === 'schedule' || action === 'revert') {
              path = '/api/admin/events/' + encodeURIComponent(date);
              method = 'PUT';
              body = { eventId: event.eventId, revision: event.revision, requestId, status: action === 'schedule' ? 'scheduled' : 'proposed' };
            } else if (action === 'delete') {
              path = '/api/admin/events/' + encodeURIComponent(date);
              method = 'DELETE';
              body = { eventId: event.eventId, revision: event.revision, requestId };
            }
            message.textContent = '';
            try {
              const response = await fetch(path, {
                method,
                headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken },
                body: JSON.stringify(body),
              });
              if (response.status === 401) { redirectToLogin(); return false; }
              const result = await response.json();
              if (!response.ok) {
                const errorMessage = result.message || 'Could not update the run event.';
                await loadWeek(weekMonday);
                message.textContent = errorMessage;
                return false;
              }
              const [refreshed, timelineRefreshed] = await Promise.all([loadWeek(weekMonday), loadTimeline()]);
              if (!refreshed || !timelineRefreshed) {
                message.textContent = 'Could not refresh the event board. Please reload.';
                return false;
              }
              message.textContent = action === 'propose' ? 'Run proposed.'
                : action === 'withdraw' ? 'Proposal withdrawn.'
                  : action === 'schedule' ? 'Run scheduled.'
                    : action === 'revert' ? 'Run reverted to proposed.' : 'Event deleted.';
              return true;
            } catch {
              const errorMessage = 'Could not update the run event. Please try again.';
              await loadWeek(weekMonday);
              message.textContent = errorMessage;
              return false;
            } finally {
              pendingEventDates.delete(date);
              const dayAction = weekDays.querySelector('.run-event-day-action[data-date="' + date + '"]');
              if (dayAction) dayAction.disabled = false;
              runEvents.querySelectorAll('.run-event-actions button').forEach((button) => {
                if (button.closest('.run-event-banner')?.dataset.date === date) button.disabled = false;
              });
              if (focusIntent && (document.activeElement === document.body || document.activeElement === originalActiveElement)) {
                restoreRunEventActionFocus(focusIntent);
              }
            }
          }
          function renderWeek(state) {
            weekState = state;
            eventsByDate = new Map(state.events.map((event) => [event.date, event]));
            renderRunEvents(state.events);
            weekMonday = state.week.monday;
            weekHeading.textContent = 'สัปดาห์ที่ ' + state.week.isoWeek + ' / ISO week ' + state.week.isoWeek + ' (' + state.week.isoWeekYear + ')';
            weekRange.textContent = state.week.monday + ' – ' + state.week.sunday;
            previousWeek.disabled = false;
            previousWeek.dataset.monday = state.navigation.previousMonday;
            currentWeekButton.disabled = state.week.monday === currentWeekMonday;
            nextWeek.disabled = !state.navigation.nextMonday;
            nextWeek.dataset.monday = state.navigation.nextMonday || '';
            if (resetWeek) {
              resetWeek.hidden = !(isAdmin && state.week.resetEligible);
              resetWeek.disabled = resetWeek.hidden;
              resetWeek.dataset.monday = state.week.monday;
              resetWeek.dataset.isoWeek = state.week.isoWeek;
              resetWeek.dataset.isoWeekYear = state.week.isoWeekYear;
              resetWeek.dataset.sunday = state.week.sunday;
            }
            const weeklyMaximum = Math.max(...state.days.map(({ voteCount }) => voteCount), 0);
            const scheduledCards = [];
            const rows = state.days.map((day, index) => {
              const selected = state.currentUserSelectedDates.includes(day.date);
              const isScheduled = eventsByDate.get(day.date)?.status === 'scheduled';
              const weekday = weekdays[index];
              const colors = colorForDay(day.voteCount, weeklyMaximum);
              const displayDate = formatDisplayDate(day.date);
              const [dayNumber, monthName] = displayDate.split(' ');
              const row = document.createElement('li');
              row.className = 'vote-day';
              row.dataset.date = day.date;
              const card = document.createElement('button');
              card.type = 'button';
              card.dataset.date = day.date;
              card.style.setProperty('--day-bg', colors.background);
              card.style.setProperty('--day-fg', colors.foreground);
              const header = document.createElement('span');
              header.className = 'vote-card__header';
              addText(header, 'span', weekday.english).className = 'vote-card__weekday--full';
              addText(header, 'span', weekday.english).className = 'vote-card__weekday--compact';
              addText(header, 'span', displayDate).className = 'vote-card__date--full';
              const compactDate = document.createElement('span');
              compactDate.className = 'vote-card__date--compact';
              addText(compactDate, 'span', dayNumber);
              addText(compactDate, 'span', monthName);
              header.append(compactDate);
              card.append(header);
              addText(card, 'span', String(day.voteCount)).className = 'vote-card__count';
              appendVoterNames(card, day.voterNames);
              const presentation = applyVoteCardPresentation(card, { selected, eligible: day.eligible, voteCount: day.voteCount });
              if (isScheduled) {
                card.classList.add('is-scheduled');
                scheduledCards.push({ key: day.date, element: card, scheduled: true });
              }
              card.setAttribute('aria-label', weekday.english + ', ' + formatDisplayDate(day.date) + ', ' + day.voteCount + ' votes, ' + presentation.accessibleState + (isScheduled ? ', Scheduled run' : ''));
              if (day.eligible) {
                card.addEventListener('pointerdown', (event) => { if (event.pointerType === 'touch') card.classList.add('is-touch-paused'); });
                card.addEventListener('click', () => toggleVote(day.date, card.dataset.selected !== 'true'));
              }
              const swipeCue = addText(card, 'span', '');
              swipeCue.className = 'vote-card__swipe-cue';
              swipeCue.setAttribute('aria-live', 'polite');
              attachHorizontalSwipe(card, {
                resolveAction: (deltaX, deltaY) => getDateCardSwipeAction({
                  deltaX, deltaY,
                  eligible: card.dataset.eligible === 'true',
                  selected: card.dataset.selected === 'true',
                  status: eventsByDate.get(day.date)?.status ?? null,
                }),
                resolvePreview: (deltaX, deltaY) => getDateCardSwipePreview({
                  deltaX, deltaY,
                  eligible: card.dataset.eligible === 'true',
                  selected: card.dataset.selected === 'true',
                  status: eventsByDate.get(day.date)?.status ?? null,
                }),
                onPreview(action, deltaX, ready) {
                  const label = action?.replaceAll('withdraw', 'withdraw proposal');
                  swipeCue.textContent = action ? (ready ? 'Release to ' : 'Swipe ' + (deltaX > 0 ? 'right' : 'left') + ' to ') + label : '';
                  if (action === 'withdraw') swipeCue.dataset.destructive = 'true';
                  else swipeCue.removeAttribute('data-destructive');
                },
                onCommit(action) { void submitRunEventAction(day.date, action, eventsByDate.get(day.date)); },
              });
              row.append(card);
              makeDayEventAction(row, day);
              return row;
            });
            weekDays.replaceChildren(...rows);
            scheduledEffects.sync('date-card', scheduledCards);
            configureVoterNamesMarquee(weekDays);
          }
          function patchDay(patch) {
            const day = weekState?.days.find((currentDay) => currentDay.date === patch.date);
            if (day) {
              day.voteCount = patch.voteCount;
              day.voterNames = patch.voterNames;
              const selectedDates = new Set(weekState.currentUserSelectedDates);
              if (patch.selected) selectedDates.add(patch.date);
              else selectedDates.delete(patch.date);
              weekState.currentUserSelectedDates = [...selectedDates].sort();
              const row = weekDays.querySelector('.vote-day[data-date="' + patch.date + '"]');
              if (row) makeDayEventAction(row, day);
            }
            return patchVoteDay({ weekDays, patch, createVoterNamesRegion, configureVoterNamesMarquee });
          }
          function createVoterNamesRegion(names) { return buildVoterNamesRegion(document, names); }
          async function toggleVote(date, selected) {
            const card = weekDays.querySelector('.vote-card[data-date="' + date + '"]');
            if (!card || card.disabled || card.getAttribute('aria-disabled') === 'true') return;
            card.disabled = true;
            card.setAttribute('aria-busy', 'true');
            message.textContent = '';
            try {
              const response = await fetch('/api/votes/' + encodeURIComponent(date), { method: 'PUT', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ selected }) });
              const result = await response.json();
              if (response.status === 401) { redirectToLogin(); return; }
              if (!response.ok) { message.textContent = result.message; return; }
              patchDay(result);
              timelineController.patch(result);
            } catch {
              message.textContent = 'บันทึกการเลือกไม่สำเร็จ / Could not save your selection.';
            } finally {
              card.disabled = false;
              card.removeAttribute('aria-busy');
            }
          }
          async function resetSelectedWeek() {
            if (!resetWeek || resetWeek.hidden || resetWeek.disabled) return;
            const monday = resetWeek.dataset.monday;
            const isoWeek = resetWeek.dataset.isoWeek;
            const isoWeekYear = resetWeek.dataset.isoWeekYear;
            const sunday = resetWeek.dataset.sunday;
            const confirmed = window.confirm('Irreversible: reset every vote for ISO week ' + isoWeek + ' (' + isoWeekYear + '), ' + monday + ' through ' + sunday + '. This deletes all seven days and cannot be undone.');
            if (!confirmed) return;
            resetWeek.disabled = true;
            message.textContent = '';
            try {
              const response = await fetch('/api/admin/weeks/' + encodeURIComponent(monday) + '/votes', { method: 'DELETE', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken }, body: JSON.stringify({ confirmation: true }) });
              if (response.status === 401) { redirectToLogin(); return; }
              const result = response.status === 204 ? null : await response.json();
              if (!response.ok) { message.textContent = result.message; return; }
              message.textContent = 'Votes reset for ISO week ' + isoWeek + ' (' + isoWeekYear + ').';
              await loadWeek(monday);
              await loadTimeline();
            } catch {
              message.textContent = 'รีเซ็ตไม่สำเร็จ / Could not reset votes.';
            } finally {
              resetWeek.disabled = resetWeek.hidden;
            }
          }
          async function loadWeek(monday) {
            const sequence = ++weekLoadSequence;
            message.textContent = '';
            try {
              const response = await fetch('/api/weeks/' + encodeURIComponent(monday), { cache: 'no-store' });
              const state = await response.json();
              if (sequence !== weekLoadSequence) return false;
              if (response.status === 401) { redirectToLogin(); return false; }
              if (!response.ok) { message.textContent = state.message; return false; }
              renderWeek(state);
              return true;
            } catch {
              if (sequence === weekLoadSequence) message.textContent = 'โหลดสัปดาห์ไม่สำเร็จ / Could not load this week.';
              return false;
            }
          }
          function scheduleBangkokDayRefresh() {
            window.clearTimeout(rolloverTimer);
            rolloverTimer = window.setTimeout(async () => {
              await Promise.all([loadWeek(weekMonday), loadTimeline()]);
              scheduleBangkokDayRefresh();
            }, millisecondsUntilBangkokMidnight());
          }
          async function loadSession() { const currentCheck = ++sessionCheck; guardProtectedContent(); try { const response = await fetch('/api/session', { cache: 'no-store' }); if (currentCheck !== sessionCheck) return; if (!response.ok) { redirectToLogin(); return; } const session = await response.json(); if (currentCheck !== sessionCheck) return; csrfToken = session.csrfToken; isAdmin = session.role === 'admin'; displayName.textContent = session.displayName; protectedContent.hidden = false; await Promise.all([loadWeek(weekMonday), loadTimeline()]); scheduleBangkokDayRefresh(); } catch { if (currentCheck === sessionCheck) redirectToLogin(); } }
          previousWeek.addEventListener('click', () => loadWeek(previousWeek.dataset.monday));
          currentWeekButton.addEventListener('click', () => loadWeek(currentWeekMonday));
          nextWeek.addEventListener('click', () => { if (!nextWeek.disabled) loadWeek(nextWeek.dataset.monday); });
          resetWeek?.addEventListener('click', resetSelectedWeek);
          manageUser?.addEventListener('click', () => { location.href = '/admin'; });
          document.querySelector('#logout').addEventListener('click', async () => { const response = await fetch('/api/auth/logout', { method: 'POST', headers: { 'x-csrf-token': csrfToken } }); if (response.ok) location.href = '/'; });
          const socket = window.io({ transports: ['websocket'] });
          const socketRepair = createSocketRepairController({ loadWeek: () => loadWeek(weekMonday), patchDay });
          socket.on('vote:changed', (patch) => { socketRepair.handlePatch(patch); timelineController.patch(patch); });
          socket.on('event:changed', ({ date }) => {
            if (weekState?.days.some((day) => day.date === date)) void loadWeek(weekMonday);
            void loadTimeline();
          });
          socket.on('week:reset', ({ monday }) => { if (monday === weekMonday) loadWeek(weekMonday); loadTimeline(); });
          socket.on('connect', () => { void socketRepair.handleConnect(); void loadTimeline(); });
          socket.on('auth:revoked', redirectToLogin);
          socket.on('connect_error', (error) => { if (error.message === 'unauthenticated') redirectToLogin(); });
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

  app.auth = auth;
  app.database = database;
  return app;
}

export default createApp();
