# Run Together

Bilingual realtime PWA for runners to vote on shared practice days.

## Foundation

The application provides a bilingual Express server and SQLite domain foundation with:

- `GET /health` returning `{"status":"ok","database":"ready","timeZone":"Asia/Bangkok"}` with HTTP 200 after startup migrations and admin bootstrap.
- `GET /` returning a placeholder landing page in English and Thai.
- Graceful shutdown on `SIGINT` and `SIGTERM`.
- Versioned transactional SQLite migrations for users, votes, sessions, and the migration ledger.
- Strict Bangkok-calendar helpers for ISO dates, Monday weeks, ISO week identity, and the current week plus two full future weeks.
- A single idempotent admin bootstrap using `ADMIN_NAME`, `ADMIN_PIN`, and server-only `PIN_PEPPER`.
- Public login and registration at `/` and `/register`, with immediate sign-in after registration.
- Authenticated placeholder board at `/vote`, session state at `/api/session`, PIN change, and logout.
- Opaque `run_together_session` cookies backed by SHA-256 token hashes in SQLite. Cookies are `HttpOnly`, `Secure`, `SameSite=Lax`, scoped to `/`, and use a rolling 30-day lifetime.
- Server-side scrypt PIN hashing with per-user salts and `PIN_PEPPER`, generic delayed credential failures, same-origin and CSRF checks, and a ten-successful-registration per source IP per ten-minute window.

Voting/week behavior, realtime updates, and admin management remain intentionally out of scope for Issue #3.

## Local development

Requirements: Node.js 22 or newer and npm.

```sh
npm ci
cp .env.example .env
npm test
npm run check
npm start
```

The server listens on `HOST` and `PORT` from `.env` (defaults to `127.0.0.1:3000`) and stores the runtime database under `DB_PATH` (default `db/run-together.sqlite`). Set a synthetic local admin name, exactly four ASCII digits for `ADMIN_PIN`, and a private random `PIN_PEPPER` before starting. Verify readiness with:

```sh
curl -i http://127.0.0.1:3000/health
curl -i http://127.0.0.1:3000/
```

The health response is intentionally limited to safe readiness information. It never includes admin credentials, PIN material, pepper, session tokens, or personal data. The initial admin PIN is only used during first bootstrap; restarting with the same admin name does not reset it.

The registration limiter is intentionally in-memory for this single-instance MVP: its ten-registration rolling window resets when the process restarts. Sessions remain database-backed across normal process restarts, but in-memory application configuration and any browser-cleared cookie cannot restore a session.

The local `.env`, runtime data, logs, uploads, and generated outputs are ignored by Git.
