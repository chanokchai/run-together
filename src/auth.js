import {
  createHash,
  randomBytes,
  scrypt,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { normalizeName } from './names.js';

const scryptAsync = promisify(scrypt);
export const SESSION_COOKIE = 'run_together_session';
export const SESSION_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
const SESSION_LIFETIME_MS = SESSION_LIFETIME_SECONDS * 1000;
const MAX_NAME_CODE_POINTS = 40;
const REGISTRATION_WINDOW_MS = 10 * 60 * 1000;
const REGISTRATION_LIMIT = 10;
const FAILED_LOGIN_MINIMUM_MS = 1000;

const MESSAGES = {
  invalidRequest: 'ข้อมูลไม่ถูกต้อง / The submitted information is invalid.',
  invalidName: 'ชื่อยาว 1–40 ตัวอักษร / Name must be 1–40 Unicode characters.',
  invalidPin: 'PIN ต้องเป็นตัวเลข ASCII 4 หลัก / PIN must be exactly four ASCII digits.',
  pinMismatch: 'PIN ไม่ตรงกัน / PIN confirmation does not match.',
  duplicateName: 'ชื่อนี้ถูกใช้แล้ว / That name is already registered.',
  invalidCredentials: 'ชื่อหรือ PIN ไม่ถูกต้อง / Name or PIN is incorrect.',
  unauthenticated: 'กรุณาเข้าสู่ระบบ / Please sign in.',
  csrf: 'คำขอไม่ปลอดภัย กรุณาลองใหม่ / Unsafe request; please try again.',
  currentPin: 'PIN ปัจจุบันไม่ถูกต้อง / Current PIN is incorrect.',
  registrationLimit: 'สมัครครบจำนวนชั่วคราวแล้ว / Registration limit reached temporarily.',
  server: 'เกิดข้อผิดพลาด กรุณาลองใหม่ / Something went wrong; please try again.',
};

export class AuthError extends Error {
  constructor(status, code, message, { cause } = {}) {
    super(message, { cause });
    this.status = status;
    this.code = code;
  }
}

function currentDate(now) {
  const value = now instanceof Date || typeof now === 'string' ? now : now();
  return value instanceof Date ? new Date(value.getTime()) : new Date(value);
}

function isoNow(now) {
  return currentDate(now).toISOString();
}

function codePointLength(value) {
  return Array.from(value).length;
}

export function validateCredentials({ name, pin, pinConfirmation } = {}, { requirePinConfirmation = false } = {}) {
  if (typeof name !== 'string') throw new AuthError(400, 'INVALID_NAME', MESSAGES.invalidName);
  const displayName = name.trim().normalize('NFKC');
  if (!displayName || codePointLength(displayName) > MAX_NAME_CODE_POINTS) {
    throw new AuthError(400, 'INVALID_NAME', MESSAGES.invalidName);
  }
  if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) {
    throw new AuthError(400, 'INVALID_PIN', MESSAGES.invalidPin);
  }
  if ((requirePinConfirmation || pinConfirmation !== undefined)
    && (typeof pinConfirmation !== 'string' || pin !== pinConfirmation)) {
    throw new AuthError(400, 'PIN_MISMATCH', MESSAGES.pinMismatch);
  }
  return { name: displayName, nameKey: normalizeName(displayName), pin };
}

function validatePin(pin, fieldCode = 'INVALID_PIN') {
  if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) {
    throw new AuthError(400, fieldCode, MESSAGES.invalidPin);
  }
  return pin;
}

function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest();
}

function appendSetCookie(response, value) {
  const previous = response.getHeader('set-cookie');
  response.setHeader('set-cookie', previous ? [...(Array.isArray(previous) ? previous : [previous]), value] : [value]);
}

function sessionCookie(token, expiresAt) {
  return `${SESSION_COOKIE}=${token}; Max-Age=${SESSION_LIFETIME_SECONDS}; Expires=${new Date(expiresAt).toUTCString()}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function clearedSessionCookie() {
  return `${SESSION_COOKIE}=; Max-Age=0; Expires=${new Date(0).toUTCString()}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function readCookie(request) {
  const header = request.headers.cookie ?? '';
  for (const part of header.split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === SESSION_COOKIE) return value.join('=');
  }
  return null;
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.isBuffer(left) ? left : Buffer.from(String(left ?? ''), 'utf8');
  const rightBuffer = Buffer.isBuffer(right) ? right : Buffer.from(String(right ?? ''), 'utf8');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function safeUser(user) {
  return { displayName: user.name, role: user.role };
}

function genericError(error) {
  if (error instanceof AuthError) return error;
  if (error?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    return new AuthError(409, 'NAME_TAKEN', MESSAGES.duplicateName, { cause: error });
  }
  return new AuthError(500, 'SERVER_ERROR', MESSAGES.server, { cause: error });
}

function effectiveSourceKey(request) {
  const remote = request.socket?.remoteAddress;
  const forwarded = request.headers['x-forwarded-for'];
  const trustedLocalProxy = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  if (trustedLocalProxy && typeof forwarded === 'string') {
    const first = forwarded.split(',')[0].trim();
    if (/^(?:\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]+$/i.test(first)) return first;
  }
  return remote || 'unknown';
}

function createRegistrationLimiter({ now }) {
  const attempts = new Map();
  function prune(timestamp) {
    for (const [source, values] of attempts) {
      const remaining = values.filter((value) => timestamp - value < REGISTRATION_WINDOW_MS);
      if (remaining.length) attempts.set(source, remaining);
      else attempts.delete(source);
    }
  }
  return {
    reserve(source) {
      const timestamp = currentDate(now).getTime();
      prune(timestamp);
      const values = attempts.get(source) ?? [];
      if (values.length >= REGISTRATION_LIMIT) return null;
      values.push(timestamp);
      attempts.set(source, values);
      return () => {
        const current = attempts.get(source) ?? [];
        const index = current.lastIndexOf(timestamp);
        if (index >= 0) current.splice(index, 1);
        if (current.length) attempts.set(source, current);
        else attempts.delete(source);
      };
    },
  };
}

async function derivePin(pin, pepper, salt = randomBytes(16)) {
  const hash = await scryptAsync(pin, Buffer.concat([Buffer.from(pepper, 'utf8'), salt]), 64);
  return { salt, hash: Buffer.from(hash) };
}

export async function verifyPin(pin, pinSalt, pinHash, pepper) {
  const derived = await scryptAsync(pin, Buffer.concat([Buffer.from(pepper, 'utf8'), pinSalt]), pinHash.length || 64);
  return safeEqual(derived, pinHash);
}

function createSessionValues(userId, now) {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  const csrfSecret = randomBytes(32);
  const createdAt = isoNow(now);
  const expiresAt = new Date(currentDate(now).getTime() + SESSION_LIFETIME_MS).toISOString();
  return { token, tokenHash, csrfSecret, userId, createdAt, lastSeenAt: createdAt, expiresAt };
}

export function createAuthService({ database, env = process.env, now = () => new Date(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), monotonic = () => performance.now(), limiter = createRegistrationLimiter({ now }) }) {
  const pepper = String(env.PIN_PEPPER ?? '');
  if (!pepper) throw new Error('PIN_PEPPER is required');
  const dummySalt = randomBytes(16);
  const dummyHash = scryptSync('invalid-login-pin', Buffer.concat([Buffer.from(pepper, 'utf8'), dummySalt]), 64);


  function touchSession(session, response) {
    const lastSeenAt = isoNow(now);
    const expiresAt = new Date(currentDate(now).getTime() + SESSION_LIFETIME_MS).toISOString();
    database.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?').run(lastSeenAt, expiresAt, session.id);
    appendSetCookie(response, sessionCookie(session.rawToken, expiresAt));
    session.last_seen_at = lastSeenAt;
    session.expires_at = expiresAt;
  }

  function findSession(request, response) {
    const rawToken = readCookie(request);
    if (!rawToken || rawToken.length < 43) return null;
    const tokenHash = hashToken(rawToken);
    const session = database.prepare(`
      SELECT sessions.*, users.name, users.role, users.pin_salt, users.pin_hash
      FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ?
    `).get(tokenHash);
    if (!session) return null;
    if (new Date(session.expires_at).getTime() <= currentDate(now).getTime()) {
      database.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
      return null;
    }
    session.rawToken = rawToken;
    touchSession(session, response);
    return session;
  }

  function sessionPayload(session) {
    return {
      displayName: session.name,
      role: session.role,
      csrfToken: Buffer.from(session.csrf_secret).toString('base64url'),
      expiresAt: session.expires_at,
      sessionRestored: true,
    };
  }


  async function register({ name, pin, pinConfirmation, sourceKey }) {
    const credentials = validateCredentials({ name, pin, pinConfirmation }, { requirePinConfirmation: true });
    const source = sourceKey ?? 'unknown';
    const release = limiter.reserve(source);
    if (!release) throw new AuthError(429, 'REGISTRATION_LIMIT', MESSAGES.registrationLimit);
    try {
      const material = await derivePin(credentials.pin, pepper);
      const values = createSessionValues(null, now);
      const transaction = database.transaction(() => {
        const timestamp = isoNow(now);
        const result = database.prepare(`
          INSERT INTO users (name, name_key, pin_salt, pin_hash, role, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'user', ?, ?)
        `).run(credentials.name, credentials.nameKey, material.salt, material.hash, timestamp, timestamp);
        values.userId = result.lastInsertRowid;
        database.prepare(`
          INSERT INTO sessions (token_hash, user_id, csrf_secret, created_at, last_seen_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(values.tokenHash, values.userId, values.csrfSecret, values.createdAt, values.lastSeenAt, values.expiresAt);
      });
      transaction();
      return { user: { name: credentials.name, role: 'user' }, session: values };
    } catch (error) {
      release();
      throw genericError(error);
    }
  }

  async function login({ name, pin }) {
    let credentials;
    try {
      credentials = validateCredentials({ name, pin });
    } catch (error) {
      throw error;
    }
    const started = monotonic();
    const user = database.prepare('SELECT * FROM users WHERE name_key = ?').get(credentials.nameKey);
    const valid = user
      ? await verifyPin(credentials.pin, user.pin_salt, user.pin_hash, pepper)
      : (await verifyPin('invalid-login-pin', dummySalt, dummyHash, pepper), false);
    if (!user || !valid) {
      const elapsed = monotonic() - started;
      if (elapsed < FAILED_LOGIN_MINIMUM_MS) await sleep(FAILED_LOGIN_MINIMUM_MS - elapsed);
      throw new AuthError(401, 'INVALID_CREDENTIALS', MESSAGES.invalidCredentials);
    }
    const values = createSessionValues(user.id, now);
    try {
      database.prepare(`
        INSERT INTO sessions (token_hash, user_id, csrf_secret, created_at, last_seen_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(values.tokenHash, user.id, values.csrfSecret, values.createdAt, values.lastSeenAt, values.expiresAt);
    } catch (error) {
      throw genericError(error);
    }
    return { user: safeUser(user), session: values };
  }

  function requireSession(request, response) {
    const session = findSession(request, response);
    if (!session) {
      response.status(401).json({ code: 'UNAUTHENTICATED', message: MESSAGES.unauthenticated });
      return null;
    }
    return session;
  }

  function expectedOrigin(request) {
    const remote = request.socket?.remoteAddress;
    const trusted = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    const protocolHeader = trusted ? request.headers['x-forwarded-proto'] : null;
    const protocol = protocolHeader === 'https' || protocolHeader === 'http'
      ? protocolHeader
      : request.protocol || 'http';
    return `${protocol}://${request.get('host')}`;
  }

  function assertSameOrigin(request) {
    const origin = request.headers.origin;
    if (origin && origin !== expectedOrigin(request)) {
      throw new AuthError(403, 'ORIGIN_MISMATCH', MESSAGES.csrf);
    }
    const referer = request.headers.referer;
    if (!origin && referer) {
      try {
        if (new URL(referer).origin !== expectedOrigin(request)) {
          throw new AuthError(403, 'ORIGIN_MISMATCH', MESSAGES.csrf);
        }
      } catch (error) {
        if (error instanceof AuthError) throw error;
        throw new AuthError(403, 'ORIGIN_MISMATCH', MESSAGES.csrf, { cause: error });
      }
    }
  }

  function assertCsrf(request, session) {
    assertSameOrigin(request);
    const token = request.headers['x-csrf-token'];
    const expected = Buffer.from(session.csrf_secret).toString('base64url');
    if (!safeEqual(token, expected)) throw new AuthError(403, 'CSRF_INVALID', MESSAGES.csrf);
  }

  async function changePin(session, { currentPin, newPin, newPinConfirmation }) {
    validatePin(currentPin, 'INVALID_CURRENT_PIN');
    validatePin(newPin);
    validatePin(newPinConfirmation);
    if (newPin !== newPinConfirmation) throw new AuthError(400, 'PIN_MISMATCH', MESSAGES.pinMismatch);
    if (!(await verifyPin(currentPin, session.pin_salt, session.pin_hash, pepper))) {
      throw new AuthError(401, 'INVALID_CURRENT_PIN', MESSAGES.currentPin);
    }
    const material = await derivePin(newPin, pepper);
    const timestamp = isoNow(now);
    try {
      const transaction = database.transaction(() => {
        database.prepare('UPDATE users SET pin_salt = ?, pin_hash = ?, updated_at = ? WHERE id = ?')
          .run(material.salt, material.hash, timestamp, session.user_id);
        database.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?').run(session.user_id, session.id);
        database.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?')
          .run(timestamp, new Date(currentDate(now).getTime() + SESSION_LIFETIME_MS).toISOString(), session.id);
      });
      transaction();
      return true;
    } catch (error) {
      throw genericError(error);
    }
  }

  function logout(session, response) {
    database.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
    appendSetCookie(response, clearedSessionCookie());
  }

  return {
    assertCsrf,
    assertSameOrigin,
    changePin,
    effectiveSourceKey,
    findSession,
    login,
    logout,
    register,
    requireSession,
    sessionPayload,
    sessionCookie,
    safeUser,
    validateCredentials,
  };
}

export { effectiveSourceKey };
