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
| API access | `src/middleware.ts` — every `/api/*` request requires a signed session cookie or Bearer token (except `/api/auth/*`). Wrong/absent credential → 401 JSON. |
| Lock screen | First visit to `/` shows a password setup (first run) or sign-in. Passwords: PBKDF2-SHA256, 120k iterations, salted, constant-time compare. |
| Brute force | 5 failed logins per IP per 10 minutes → 10-minute lockout. |
| CSRF | Cookie-authenticated mutations with a mismatching `Origin` are rejected (plus `SameSite=Lax`). |
| Sessions | HMAC-SHA256-signed tokens (`TUBEFORGE_AUTH_SECRET` in `.env`), HttpOnly cookies, 7-day expiry. Rotating the secret revokes everything instantly. |
| API tokens | `POST /api/auth/token` (signed in) mints a 90-day Bearer token for scripts/CLI. |
| SSRF | User-supplied audio URLs: http(s) only, private/loopback/link-local/CGNAT/metadata hosts blocked, DNS answers re-checked, redirects manually followed with each hop re-validated, size + type caps. |
| Secrets in responses | Provider API keys are masked in every settings GET; YouTube tokens never leave the server. |
| Distributables | `scripts/package-local.sh` no longer copies the live database; `.gitignore` excludes `db/`, `uploads/`, `.env`. |
| Local dev | Without `TUBEFORGE_AUTH_SECRET` the gate stays open (documented) — set the secret to enable it. |

## Daily-use security checklist

- Keep `TUBEFORGE_AUTH_SECRET` set in `.env` (32+ hex chars) and never commit `.env`.
- Don't port-forward the dev server without the secret set; run behind a reverse proxy with TLS.
- Change the access password if you suspect exposure (clear the `auth.password` row in Settings →
  next boot offers first-run setup again).
- Before uploading to YouTube, review the track license record in Settings → Background Music.

## Backups

`bun run backup` → `backups/tubeforge-<timestamp>/` with a hot-copy of the SQLite database
(`VACUUM INTO`) and a manifest of `uploads/`. Keep at least one backup off-machine.
