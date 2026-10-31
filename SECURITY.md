# TubeForge — Security & Release Notes

Last updated: 2025-10-28 (security hardening pass)

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

## What this pass locked down

| Area | Protection |
| --- | --- |
| API access | **Opt-in.** The studio is OPEN by default. Once the owner enables it (Settings → Studio access), `src/middleware.ts` requires a signed session cookie or Bearer token on every `/api/*` request (except `/api/auth/*`). Wrong/absent credential → 401 JSON. |
| Lock screen | Appears only while protection is ON: first visit to `/` shows a password setup (first run) or sign-in. Passwords: PBKDF2-SHA256, 120k iterations, salted, constant-time compare. |
| Brute force | 5 failed logins per IP per 10 minutes → 10-minute lockout. |
| CSRF | Cookie-authenticated mutations with a mismatching `Origin` are rejected (plus `SameSite=Lax`). |
| Sessions | HMAC-SHA256-signed tokens (`TUBEFORGE_AUTH_SECRET` in `.env`), HttpOnly cookies, 7-day expiry. Rotating the secret revokes everything instantly. |
| API tokens | `POST /api/auth/token` (signed in) mints a 90-day Bearer token for scripts/CLI. |
| SSRF | User-supplied audio URLs: http(s) only, private/loopback/link-local/CGNAT/metadata hosts blocked, DNS answers re-checked, redirects manually followed with each hop re-validated, size + type caps. |
| Secrets in responses | Provider API keys are masked in every settings GET; YouTube tokens never leave the server. |
| Distributables | `scripts/package-local.sh` no longer copies the live database; `.gitignore` excludes `db/`, `uploads/`, `.env`. |
| Local dev | The lock is opt-in: Setting `auth.enabled` (mirrored to `db/auth.lock`, hot-checked by the middleware) decides. Removing the flag file or the secret instantly re-opens the studio. |

## Daily-use security checklist

- Keep `TUBEFORGE_AUTH_SECRET` set in `.env` (32+ hex chars) and never commit `.env` — the secret
  is required to SIGN sessions; the lock itself is toggled in Settings → Studio access.
- Sharing the studio outside your machine? Turn the lock ON first (Settings → Studio access),
  then run behind a reverse proxy with TLS. Do not port-forward an open studio.
- Locked out? `bun run auth:reset` (dev sandbox) / `npm run auth:reset` (local
  package) switches back to the open studio (add `--purge` to also forget
  the password). Enable protection again from Settings when ready.
- Before uploading to YouTube, review the track license record in Settings → Background Music.

## Backups

`bun run backup` → `backups/tubeforge-<timestamp>/` with a hot-copy of the SQLite database
(`VACUUM INTO`) and a manifest of `uploads/`. Keep at least one backup off-machine.

> **Note (2026-11):** the `scripts/backup.sh` file is referenced here and in `package.json` but is currently absent from the shipped tree. Restoring it is Stage 1 task `T-1.1` in `TASKS.md`. Until then, use `sqlite3 db/custom.db ".backup backups/manual.db"` as a manual fallback.

## 2026-11 Foundation Audit findings

A full security audit was run as part of Stage 1 of the TubeForge product development plan. The audit covered all 71 API route files (110 endpoints), the 11 Prisma models, the auth/middleware layer, the video-generation pipeline, and the build/test baseline.

Findings:

- **3 CRITICAL risks** (all multi-tenant blockers; addressed in Stage 2):
  - No `userId`/`tenantId` on any Prisma model — every endpoint assumes one user.
  - `Setting` table is a singleton per key — one owner password, one YouTube OAuth grant, one set of provider keys per install.
  - First-come race on `POST /api/auth/setup` (mitigated in Stage 1 by the new `TUBEFORGE_OWNER_TOKEN` env var — see §"Daily-use security checklist" above).
- **28 HIGH findings** (mostly Stage 1 and Stage 3): synchronous heavy work in-request (`POST /api/videos`, `/api/research`, `/api/research/[id]/greenlight`, `/api/characters/bible`), dead scaffolding for the YouTube publish stage (`uploadToYouTube` is implemented but never called), missing timeout/retry on YouTube fetch calls, zero `zod` use across 110 endpoints, no `prisma/migrations/` directory, no CI, no security headers.
- **15 MEDIUM findings**: orphan cleanup gap on `DELETE /api/videos/[id]`, in-memory security state (login lockouts and rate-limit buckets reset on restart), memory-bound media streaming, side-effecting `GET /api/music`, cross-platform `/proc/<pid>/stat` watchdog.
- **7 LOW findings**: cosmetic schema comment drift, dead Tailwind v3 config file, `reactStrictMode: false`, Playwright installed but unwired.

Full detail:

- `FOUNDATION_AUDIT.md` — the complete audit report (route inventory, pipeline trace, build baseline, 30 recorded defects).
- `RISK_REGISTER.md` — all 55 risks prioritized with the stage that fixes each.
- `TASKS.md` — the Stage 1 implementation backlog (19 tasks).

The single most important security recommendation from the audit: **add automated cross-tenant isolation tests in CI from Stage 2 onward, not as a Stage 7 QA item.** By Stage 7 it is too late to find leakage. The next major security milestone is Stage 2 (multi-user SaaS architecture).

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
