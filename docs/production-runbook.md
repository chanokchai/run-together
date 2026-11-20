# Run Together production operations runbook

Version: 1.0.0
Status: Operational guidance only. This document does not authorize a deployment.

## Scope and approval gate

Use this runbook only after the owner has separately authorized a specific production deployment. The production host is `https://run.jjbtech.com`. It must remain unchanged without separate explicit deployment authorization. An issue assignment, preview validation, test PASS, pull request, or merge is not production-deployment approval.

Run Together preview and production must use different hostnames, launch configurations, secrets, processes, and SQLite databases. Never point a preview at production storage or copy preview data/configuration into production. Do not reset or replace persistent account data as a deployment step.

## Runtime configuration

Set the following variables in a protected process environment or a private launch file outside Git. Do not put credentials in source, shell history, logs, or deployment notes.

- `HOST`: bind address; use `127.0.0.1` behind a local reverse proxy or tunnel.
- `PORT`: application listener port, distinct for each environment.
- `DB_PATH`: absolute or working-directory-relative path to the persistent SQLite database.
- `ADMIN_NAME`: administrator login name; must remain exactly `admin`.
- `ADMIN_PIN`: initial administrator PIN used only when the database has no administrator yet. A later change to this variable does not reset an existing account.
- `PIN_PEPPER`: private server-only pepper. Keep it stable for the life of the database; changing it can prevent users from authenticating.

Keep the private launch configuration and its parent directory readable only by the service account. Do not print its values while diagnosing the service. Keep production secrets separate from preview secrets.

## Persistent storage and database safety

Mount a durable writable volume for the production `db/` directory. The application enables SQLite WAL mode; the database, `-wal`, and `-shm` files belong to one live database and must stay on the same durable filesystem. Never back up a live database by copying only its main `.sqlite` file.

For a consistent backup while the service is running, use SQLite's online backup API (for example, the SQLite CLI `.backup` command) to write to a new timestamped backup file on protected storage. Alternatively, stop the service cleanly, wait for checkpoint/close to finish, and then copy the closed database. Verify the backup by opening it read-only and running `PRAGMA integrity_check;`. Retain backups according to the owner's retention policy; never add backups to Git or public web roots.

Before a schema-changing release, confirm a recent verified backup exists and record its protected location. Do not delete, replace, or reset the production database during rollback. If a migration is not backward-compatible, stop and obtain an explicit recovery plan before switching code or data.

## Process supervision

Run one Node.js 22+ application instance per SQLite database unless the application is deliberately redesigned for multi-process SQLite coordination. Use a service manager (such as systemd, s6, or an equivalent supervisor) with:

- an explicit working directory for the deployed release;
- the protected environment file or service-managed environment variables;
- automatic restart on unexpected process exit and controlled restart for planned releases;
- logs directed to protected system/service logs, never to Git-tracked paths;
- graceful `SIGTERM` delivery and a bounded shutdown timeout;
- no restart loop for configuration errors such as an invalid database path or admin bootstrap configuration.

Keep `HOST`, `PORT`, and `DB_PATH` explicit. Confirm the active PID, working directory, effective port, and database path after every restart without exposing secret environment values.

## Reverse proxy or tunnel mapping

Terminate public HTTPS at the approved reverse proxy or tunnel. Route only the production hostname `run.jjbtech.com` to the production listener. Preserve the correct `Host` and forwarded-protocol headers so secure session cookies work. Do not route the production hostname to a preview process, and do not change the mapping without explicit production deployment approval.

Limit direct access to the application listener to the local proxy/tunnel and authorized operations. Keep the preview hostname `run2.jjbtech.com` mapped only to its preview listener and database. Verify both mappings from the actual public URLs after any approved routing change.

## Health monitoring

Poll `GET /health` over the public HTTPS hostname and locally from the host. A healthy response is HTTP 200 with `status: "ok"`, `database: "ready"`, and `timeZone: "Asia/Bangkok"`. Alert on connection failures, non-200 responses, malformed readiness JSON, or sustained latency/error increases. The endpoint intentionally reports readiness only; it does not prove login, voting, realtime delivery, backup integrity, or correct environment isolation.

After a planned restart, verify the listener PID and working directory, local `/health`, public `/health`, and public landing page. Confirm the production hostname still reaches the production release and its pre-existing database. Never test destructive actions against production without separate explicit approval and a reviewed test plan.

## Release and rollback procedure

1. Obtain explicit owner authorization for the exact production release and host. Identify the reviewed commit and the already verified preview commit.
2. Verify the deployment checkout, production hostname mapping, protected config, persistent `db/` mount, and a recent integrity-checked backup. Stop if any environment boundary is unclear.
3. Stage the reviewed release in a new versioned directory. Keep the current release available for rollback. Do not edit the preview or production database as part of staging.
4. Review migration compatibility against the current SQLite schema and backup. Do not run a destructive reset. Apply the approved release using the supervisor's controlled restart mechanism.
5. Verify process identity, working directory, database path, local/public health, HTTPS, login, and the approved smoke checks. Record the deployed commit and check results.
6. If a check fails, route traffic back to the previous code release and restart that release. Preserve the database. Restore a database backup only under a separately approved recovery decision, because restoring loses later writes.
7. Record the outcome and any follow-up issue. Deployment does not authorize additional scope or a subsequent issue.

## CDN and service-worker cache updates

When a release changes browser assets, use fingerprinted asset names or update versioned asset URLs so browsers and CDNs fetch the new files. Review `public/sw.js` cache names and its install/activate behavior; increment the cache version when the precache contents or offline shell changes. Ensure activation removes only obsolete application cache names and that clients can refresh without losing the offline read-only contract.

Purge only the exact affected public asset paths if the CDN retains stale content. Do not purge unrelated sites or broad cache zones. Verify the HTML, manifest, service worker, and versioned assets from the production HTTPS host after the authorized release. Check both a fresh browser profile and an existing installed client where available. Phone installation and offline reopening require real-device verification and must not be marked passed based on desktop automation.

## Current boundary

This runbook adds no production configuration and performs no deployment. `run.jjbtech.com`, production services, and production data remain outside this issue's authorization. Any production action requires separate, explicit owner approval.
