# Run Together

Bilingual realtime PWA for runners to vote on shared practice days.

## Foundation

The initial foundation provides a minimal Express server with:

- `GET /health` returning `{"status":"ok"}` with HTTP 200.
- `GET /` returning a placeholder landing page in English and Thai.
- Graceful shutdown on `SIGINT` and `SIGTERM`.

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

The server listens on `HOST` and `PORT` from `.env` (defaults to `127.0.0.1:3000`). Verify it with:

```sh
curl -i http://127.0.0.1:3000/health
curl -i http://127.0.0.1:3000/
```

The local `.env`, runtime data, logs, uploads, and generated outputs are ignored by Git.
