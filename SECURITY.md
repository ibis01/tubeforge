# TubeForge — Security & Release Notes

Last updated: 2026-11-13 (P2 opening — reconciled to the live source after the production-readiness arc S99–S108)

## ⚠️ If you already shared an archive of this project

**Earlier archives shipped with `db/custom.db` (a populated SQLite database) and possibly `.env`.**
That database contains everything you configured inside the app — **including your provider API
keys (Settings → AI Providers) and, if you connected it, your YouTube OAuth refresh token.**

Do this now:

1. **Rotate any API key** that was in the database (Z.ai / OpenAI / Anthropic / Gemini).
2. **Revoke the YouTube OAuth grant** at https://myaccount.google.com/permissions if you had
   connected a channel in a shared archive.
3. Re-package the project with the fixed `scripts/package-local.sh` (below) — it no longer
   includes the live database.

## Current security posture (2026-11-13)

What holds at HEAD, with the stage that proved it. The governing record is
[`docs/production-readiness.md`](docs/production-readiness.md) (the gate table + the
evidence ledger); every item below is re-proven by CI on every push to `main`.

| Area | Protection |
| --- | --- |
| Accounts & tenancy | Multi-user accounts with per-user organizations; cross-tenant isolation pinned by the Playwright suites and the per-stage route probes; 90-day API tokens; email verification; password recovery; GDPR export/delete. |
| Sessions | HMAC-SHA256-signed tokens (`TUBEFORGE_AUTH_SECRET`), HttpOnly cookies, 7-day expiry. Rotating the secret revokes everything instantly. |
| Brute force | Login lockout is DB-backed (S46) — survives restarts and is shared across instances. |
| Rate limiting | SHARED and DB-backed (`RateLimitCounter`, S102), enforced at `requireUser`; the client IP is resolved by the trusted-proxy right-to-left walk (`proxy-trust.ts`) — `X-Forwarded-For` spoofing is dead (pinned by `test:rate`). |
| CSP | Nonce-based (S104): production drops `unsafe-inline` and `unsafe-eval` from `script-src`; `style-src 'unsafe-inline'` is the one documented exception; SVG ingestion sanitizes before storage and rasterizes before trust (attack fixtures pinned). |
| Queue integrity | Renewable leases + monotonic fencing tokens + conditional terminal writes (S100) — a stale worker cannot corrupt a job the reaper reclaimed (token bumped on recovery, proven in-container by the Docker smoke). |
| Storage quota | Admission is ATOMIC (S101): durable reservations, expiry sweep, release-on-failure — concurrent uploads cannot exceed quota. |
| Secrets | Provider API keys encrypted at rest (`TUBEFORGE_ENCRYPTION_KEY`) and masked in every settings GET; YouTube tokens never leave the server. |
| SSRF | User-supplied audio URLs: http(s) only, private/loopback/link-local/CGNAT/metadata hosts blocked, DNS answers re-checked, redirects manually followed with each hop re-validated, size + type caps. |
| CSRF | Cookie-authenticated mutations with a mismatching `Origin` are rejected (plus `SameSite=Lax`). |
| Backups & recovery | `npm run backup` (SQLite `VACUUM INTO` hot copy / Postgres `pg_dump`) + `scripts/backup-postgres.sh`; the restore drill runs in CI with a MEASURED RTO (~55 ms at S108); the alert probe (8 checks, exit 1 + one actionable line per failure) watches queue depth, stale leases, disk, and backup age. |
| Deployment evidence | The Docker production-topology smoke — register → create → render → store → retrieve → restart → recover, plus a real in-container whiteboard render through the worker's chromium — runs on every push to `main` (S105/S108). |

**Two deliberate exceptions, stated as policy:**

1. **The shared rate limiter fails OPEN, loudly.** On a database error the limiter
   degrades to per-instance middleware shedding and announces
   `RateLimitCounter write failed` once per process — it is a damper, not a security
   control. Treat any such announcement as an incident: a database outage removes the
   authoritative shared limiter. The alert probe (`npm run alert:probe`) is the
   monitoring seam; keep it on a schedule.
2. **`frame-ancestors` / `X-Frame-Options` are omitted.** The studio is previewed
   inside cross-origin sandbox iframes; a blanket deny breaks those embeds (the
   Stage-1 decision, pinned by the CSP regression suite so nobody "fixes" it blind).
   Restricting embedding to an allowlist of origins is tracked as a P2 cleanup, gated
   on proving the preview architecture permits it.

## Daily-use security checklist

- Keep `TUBEFORGE_AUTH_SECRET` and `TUBEFORGE_ENCRYPTION_KEY` set (32+ hex chars each)
  and never commit `.env` — the secret signs sessions; the key encrypts provider
  credentials at rest.
- Exposing the studio beyond your machine? Run it behind a reverse proxy with TLS and
  configure the trusted-proxy chain (see [`DEPLOYMENT.md`](DEPLOYMENT.md)) — the rate
  limiter and login lockout depend on correct client-IP resolution.
- Locked out? `npm run auth:reset -- --email you@example.com` prints a one-time reset
  link (add `--set <password>` to set it directly — that also revokes every live
  session of that user).
- Before uploading to YouTube, review the track license record in Settings → Background Music.
- Run `npm run backup` on a schedule and keep at least one copy off-machine; the alert
  probe's backup-age check (opt-in via `TUBEFORGE_ALERT_BACKUPS_DIR`) is the reminder net.

## Backups

`npm run backup` → `backups/tubeforge-<timestamp>/` with a hot copy of the database
(SQLite `VACUUM INTO`, safe while the app runs; Postgres `pg_dump`) and a manifest of
`uploads/`. Postgres deployments also have `scripts/backup-postgres.sh`. The restore
path is not aspirational: `scripts/restore-drill.mts` (`npm run drill`) round-trips a
real backup and prints the measured RTO — and it runs in CI on every push.

> Historical note: the 2025-10-28 edition of this file said `scripts/backup.sh` was
> "currently absent from the shipped tree" (a Stage-1 finding, task T-1.1). It was
> restored the same month — the file's own header records the restoration — and this
> note replaces the stale one.

## Historical: the 2025-10-28 single-user hardening pass

The table below is the record of the FIRST hardening pass, from the single-user era
before multi-user accounts landed (Stage 2). The opt-in lock model it describes no
longer exists — auth is account-based now — but the pass is kept verbatim as the audit
trail of what shipped then. The current posture is the table above.

| Area | Protection (as shipped 2025-10-28) |
| --- | --- |
| API access | **Opt-in.** The studio is OPEN by default. Once the owner enables it (Settings → Studio access), `src/middleware.ts` requires a signed session cookie or Bearer token on every `/api/*` request (except `/api/auth/*`). Wrong/absent credential → 401 JSON. |
| Lock screen | Appears only while protection is ON: first visit to `/` shows a password setup (first run) or sign-in. Passwords: PBKDF2-SHA256, 120k iterations, salted, constant-time compare. |
| Brute force | 5 failed logins per IP per 10 minutes → 10-minute lockout (in-memory then; DB-backed since S46). |
| CSRF | Cookie-authenticated mutations with a mismatching `Origin` are rejected (plus `SameSite=Lax`). |
| Sessions | HMAC-SHA256-signed tokens (`TUBEFORGE_AUTH_SECRET` in `.env`), HttpOnly cookies, 7-day expiry. Rotating the secret revokes everything instantly. |
| API tokens | `POST /api/auth/token` (signed in) mints a 90-day Bearer token for scripts/CLI. |
| SSRF | User-supplied audio URLs: http(s) only, private/loopback/link-local/CGNAT/metadata hosts blocked, DNS answers re-checked, redirects manually followed with each hop re-validated, size + type caps. |
| Secrets in responses | Provider API keys are masked in every settings GET; YouTube tokens never leave the server. |
| Distributables | `scripts/package-local.sh` no longer copies the live database; `.gitignore` excludes `db/`, `uploads/`, `.env`. |
| Local dev | The lock was opt-in: Setting `auth.enabled` (mirrored to `db/auth.lock`, hot-checked by the middleware) decided. Removing the flag file or the secret instantly re-opened the studio. (Superseded by accounts in Stage 2.) |

## 2026-11 Foundation Audit findings

A full security audit was run as part of Stage 1 of the TubeForge product development plan. The audit covered all 71 API route files (110 endpoints), the 11 Prisma models, the auth/middleware layer, the video-generation pipeline, and the build/test baseline.

Findings:

- **3 CRITICAL risks** (all multi-tenant blockers; addressed in Stage 2):
  - No `userId`/`tenantId` on any Prisma model — every endpoint assumes one user.
  - `Setting` table is a singleton per key — one owner password, one YouTube OAuth grant, one set of provider keys per install.
  - First-come race on `POST /api/auth/setup` (mitigated in Stage 1 by the new `TUBEFORGE_OWNER_TOKEN` env var).
- **28 HIGH findings** (mostly Stage 1 and Stage 3): synchronous heavy work in-request (`POST /api/videos`, `/api/research`, `/api/research/[id]/greenlight`, `/api/characters/bible`), dead scaffolding for the YouTube publish stage (`uploadToYouTube` is implemented but never called), missing timeout/retry on YouTube fetch calls, zero `zod` use across 110 endpoints, no `prisma/migrations/` directory, no CI, no security headers.
- **15 MEDIUM findings**: orphan cleanup gap on `DELETE /api/videos/[id]`, in-memory security state (login lockouts and rate-limit buckets reset on restart), memory-bound media streaming, side-effecting `GET /api/music`, cross-platform `/proc/<pid>/stat` watchdog.
- **7 LOW findings**: cosmetic schema comment drift, dead Tailwind v3 config file, `reactStrictMode: false`, Playwright installed but unwired.

Full detail:

- `FOUNDATION_AUDIT.md` — the complete audit report (route inventory, pipeline trace, build baseline, 30 recorded defects).
- `RISK_REGISTER.md` — all 55 risks prioritized with the stage that fixes each.
- `TASKS.md` — the Stage 1 implementation backlog (19 tasks).

The single most important security recommendation from the audit: **add automated cross-tenant isolation tests in CI from Stage 2 onward, not as a Stage 7 QA item.** By Stage 7 it is too late to find leakage. That recommendation was adopted — the cross-tenant suites have run in CI since Stage 2.

---

## Stage 1 execution (2026-11-01)

The Stage 1 backlog was executed the same day: `TUBEFORGE_OWNER_TOKEN` now gates
the first-run setup claim (close-out of the CRITICAL setup race), security
headers are served by `next.config.ts`, CI runs typecheck + lint + tests, the
test suite moved to npm/Node (bun no longer required), the multi-minute script
generation moved off the request path into a background job (202 + polling),
and the first-come setup race, DELETE orphan gap, side-effecting music GET and
`params.n` validation gaps are all fixed. Verification: typecheck clean, 46/46
tests pass, live smoke test green. Remaining CRITICAL work is Stage 2
(cross-tenant isolation). Full per-task status: `TASKS.md`.
