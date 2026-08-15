# Deployment Guide — Coding Challenge 2026

## 1. Actual architecture (verified, not assumed)

This project is **not** a split `backend/` + `frontend/` Express application and it does
**not** use Prisma, Socket.IO or Judge0. What is actually in the repository:

| Concern | Implementation |
| --- | --- |
| Framework | TanStack Start v1 (React 19, Vite 8), single deployable app |
| Runtime | Edge worker runtime (Cloudflare Workers style), SSR + server functions |
| Backend logic | `createServerFn` handlers in `src/lib/*.functions.ts` (no Express server) |
| Data access | `src/lib/own-db.server.ts` — one cached Supabase service-role client |
| Database | The competition Supabase/Postgres project (`OWN_SUPABASE_*`) |
| Auth | Own JWT session in an httpOnly cookie (`src/lib/app-session.server.ts`) + `sessions` table |
| Realtime | **Polling** (`refetchInterval` on TanStack Query). There is no Socket.IO server |
| Code execution | QuickJS **WebAssembly** sandbox in-process (`src/lib/sandbox.server.ts`) |
| Health check | `GET /api/public/health` |
| Hosting | Lovable publish pipeline (`bun run build` → worker bundle) |

Because there is no Express/Prisma layer, the Express-specific hardening items
(`helmet`, `express-rate-limit`, `body-parser` limits, `prisma migrate deploy`) do not
apply literally; the equivalent protections are listed below.

## 2. Environment variables

See `.env.example`. Summary:

**Server-only (secret — never `VITE_`, never committed):**
`APP_SESSION_SECRET`, `OWN_SUPABASE_URL` / `OWN_SUPABASE_DB_URL`,
`OWN_SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`,
`DEFAULT_STUDENT_PASSWORD`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`.

**Browser-visible (public by definition):** `VITE_SUPABASE_URL`,
`VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_SUPABASE_PROJECT_ID`.

All secrets are read with `process.env[...]` **inside** handler bodies, never at module
scope and never in client code. Secrets are stored in the hosting platform's secret
store, not in the repository.

## 3. Build and release

```bash
bun install
bun run build     # type-checked production build of SSR worker + client assets
```

Publishing is done from the Lovable editor (Publish). Frontend changes go live when the
publish dialog is confirmed; server-function changes ship with the same build.

## 4. Database migrations (non-destructive policy)

Schema changes for the competition database are applied through the scripts in
`tmpscripts/` (`ddl.ts`, `ddl2.ts`) which issue **additive** DDL only
(`ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`).

Forbidden on the competition database, at any time:
`DROP DATABASE`, `DROP TABLE`, `TRUNCATE`, `prisma migrate reset`,
`db push --force-reset`, `docker compose down -v`.

Before running any DDL: inspect the live schema (`tmpscripts/schema.ts`), confirm the
statements are additive, and take a backup (below).

## 5. Backup and restore

Backups are taken against the competition Postgres instance:

```bash
# Backup (run from an operator machine that has the connection string in its env)
pg_dump "$OWN_SUPABASE_DB_URL" --no-owner --format=custom \
  --file "backups/cc2026-$(date +%Y%m%d-%H%M).dump"

# Restore into a NEW, EMPTY database — never over the live competition database
createdb cc2026_restore_test
pg_restore --no-owner --dbname "postgresql://.../cc2026_restore_test" backups/<file>.dump
```

- **Location:** operator-controlled `backups/` directory (git-ignored) plus one off-machine copy.
- **Frequency:** once the day before the event, once immediately before the first round,
  once after each round ends, once immediately after the final round.
- **Retention:** keep every competition-day dump for at least 90 days; never overwrite an
  existing dump — filenames are timestamped.
- **Restore drills:** only into a scratch database. Never restore over live data.

**Status in this environment: NOT TESTED.** The build sandbox has no `pg_dump` access to
the competition database, so the procedure above is documented but was not executed here.

## 6. Security posture

- **Session cookie:** `HttpOnly; Secure; SameSite=Lax; Path=/`, 12-hour lifetime, JWT
  (HS256) signed with `APP_SESSION_SECRET`, mirrored in the `sessions` table so admins can
  revoke and single-session-per-user is enforced. Not readable from JavaScript.
- **CSRF:** TanStack `createCsrfMiddleware` is registered for all server functions in
  `src/start.ts`.
- **CORS:** the app is same-origin (server functions live under the app's own origin), so
  no wildcard `origin: "*"` exists anywhere.
- **Security headers** (`src/server.ts`): `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`,
  `X-Permitted-Cross-Domain-Policies: none`, restrictive `Permissions-Policy`,
  `Cross-Origin-Opener-Policy: same-origin-allow-popups`. A strict CSP and
  frame-ancestors rule are intentionally **not** set: the app runs inside the Lovable
  preview iframe and loads a WASM sandbox, and a strict policy breaks both.
- **Request size limits:** every server-function input is validated with Zod and capped
  (source code ≤ 100 000 chars, text fields ≤ 8 000, identifiers ≤ 200). Oversized bodies
  are rejected before any database work.
- **Rate limiting** (`src/lib/rate-limit.server.ts`): login 12/min, registration 8/min,
  run 40/min, submit 60/min, violation reports 60/min.
  *Limitation:* counters are held in the memory of the serving instance, so on a
  multi-instance deployment the limit is per instance. It stops brute force and
  submit-spam from one client; it is not a distributed quota.
- **Error responses:** handlers throw short user-facing strings; the raw database error is
  logged server-side only (`console.error("[scope] …", error.message)`). No stack traces,
  Prisma/Postgres internals, file paths or environment values reach the client.
- **Logging:** logs contain scope tags, entity ids and error messages. No passwords,
  cookies, JWTs, connection strings or key material is logged.
- **Authorisation:** every admin function calls `requireAdmin()`, every student function
  calls `requireStudent()`; round gating, timing, scoring and bug awards are computed
  server-side only. Client input can never set round state, deadlines, scores or student ids.

## 7. Code execution — honest isolation statement

Student code runs in a **QuickJS WebAssembly virtual machine** created per execution
inside the server process. Guarantees actually provided:

- separate WASM heap with a hard memory limit,
- wall-clock interrupt handler (execution is aborted on timeout),
- no filesystem, no network, no timers, no host objects — only `readLine` and `print`
  bridges are exposed,
- output is truncated, and the VM is disposed after every run.

What it is **not**: it is not a container, not a VM-per-submission, not an OS-level
sandbox, and it does not run untrusted native code. It is a language-level interpreter
sandbox inside the worker process; a QuickJS/WASM escape would be a compromise of the
server process.

**Supported execution language: JavaScript only.** C, C++, Java and Python may be listed
as problem metadata but there is no `gcc`/`g++`/`javac`/`python` toolchain in this
runtime and no external judge — those languages cannot be executed and must not be
enabled for a live round.

## 8. Failure recovery on competition day

- **Server restart / redeploy:** stateless workers. All state (round state, deadlines,
  answers, submissions, scores, violations) is in Postgres and survives.
- **Student refresh / device change:** progress and drafts are re-read from the database;
  Round 2 drafts are autosaved to `round_progress.savedData`.
- **Deadline integrity:** deadlines are derived server-side from the stored round start
  time and duration. A late joiner or a reconnecting student receives the same absolute
  deadline; the client clock is display-only, and expiry is enforced server-side
  (`autoSubmitIfExpired`).
- **Realtime loss:** there are no sockets to lose — the UI polls REST/server functions, so
  recovery is automatic on the next poll or page load.
- **Results:** publication is enforced server-side; hiding is not a frontend concern.
