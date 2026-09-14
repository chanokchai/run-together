# Run Together

Bilingual realtime PWA for runners to vote on shared practice days.

## Foundation

The initial foundation provides a minimal Express server and SQLite domain foundation with:

- `GET /health` returning `{"status":"ok","database":"ready","timeZone":"Asia/Bangkok"}` with HTTP 200 after startup migrations and admin bootstrap.
- `GET /` returning a placeholder landing page in English and Thai.
- Graceful shutdown on `SIGINT` and `SIGTERM`.
- Versioned transactional SQLite migrations for users, votes, sessions, and the migration ledger.
- Strict Bangkok-calendar helpers for ISO dates, Monday weeks, ISO week identity, and the current week plus two full future weeks.
- A single idempotent admin bootstrap using `ADMIN_NAME`, `ADMIN_PIN`, and server-only `PIN_PEPPER`.

Product features are intentionally out of scope for this foundation.

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

The local `.env`, runtime data, logs, uploads, and generated outputs are ignored by Git.
