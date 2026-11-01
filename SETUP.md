# TubeForge — Run It on Your Own PC

TubeForge is a YouTube-automation studio: it researches topics, writes scripts with
GLM, splits them into scene storyboards, paints AI images, generates voiceovers,
renders the final MP4 (with Shorts), and can even upload to YouTube.

This package is **source + empty database**: a fresh, private studio. For your
protection it deliberately does NOT include this machine's database (it held API
keys and account tokens), `.env` secrets, or the 550+ MB of generated media —
everything regenerates on demand once your own key is in.

---

## 1. What you need before starting

| Requirement | Why | Where to get it |
|---|---|---|
| **Node.js 20+ (LTS)** | runs the Next.js app AND the test suite | https://nodejs.org (npm comes with it) |
| **ffmpeg + ffprobe** on your PATH | video render, Shorts, narration checks | Ubuntu/Debian: `sudo apt install ffmpeg` · macOS: `brew install ffmpeg` · Windows: `winget install ffmpeg` |
| **A Z.ai API key** | every AI step (script, TTS, images, video) calls Z.ai services | https://z.ai/model-api — sign up, open API Keys, create a key (free) |
| ~2 GB free disk | node_modules + generated media | — |

**Cost tip:** the app defaults to the **GLM-4.5 Flash** chat model, which is
**free** on Z.ai — script writing costs $0. Voiceovers (TTS), images and video
rendering need a small credit balance on your account.

> **One package manager:** npm is the PM of record (Stage 1, task T-1.2).
> `bun.lock` was removed; `npm install` / `npm run …` drive everything, and
> `npm test` runs under Node via `tsx` — bun is no longer required.

---

## 2. Setup (5 steps)

The app ships with **two database modes** — pick one at setup time:

- **Local development (default for running on your own PC)** — SQLite, zero
  infra. Uses `prisma/schema.sqlite.prisma`; `npm run setup:local` creates
  `db/custom.db` and points the Prisma client at it.
- **Production / Vercel** — PostgreSQL. `prisma/schema.prisma` (the deployment
  default) expects a hosted Postgres `DATABASE_URL` (Neon, Supabase, RDS…).

```bash
# 1. unzip the package, then:
cd tubeforge

# 2. install dependencies (this also runs `prisma generate` automatically)
npm install

# 3. create the local SQLite database (empty — one-time)
npm run setup:local

# 4. start it
npm run dev
```

> `npm run setup` also works — since Stage 1 it auto-detects the database
> mode from `DATABASE_URL` (task T-1.3), so SQLite setups no longer crash
> with a provider mismatch.

> Deploying on **Vercel / PostgreSQL** instead? Keep `DATABASE_URL` pointed at
> your hosted Postgres connection string, run `npx prisma migrate deploy`
> (the schema is baselined in `prisma/migrations/`), and skip `setup:local` —
> `postinstall` already generates the Postgres client during the build.
> (If you previously ran `setup:local`, run `npx prisma generate` once to
> switch the local client back to Postgres.)

5. Open **http://localhost:3000** → go to **Settings → AI Providers**:

   You can mix providers per task — e.g. free Gemini for scripts, OpenAI for
   voice and art, Z.ai for video. The simplest start is one Z.ai key:

   - **Z.ai credentials** card — paste your **API key** (base URL is pre-filled,
     `https://api.z.ai/api/paas/v4`). This one key powers every Z.ai task.
   - **Script writing** row — pick the model (GLM-4.5 Flash = free default).
   - click **Save & apply**, then hit **Test** on the row — it should go green.

   Other providers (each with their own key + model, per task):

   | Task | Providers |
   |---|---|
   | Script writing | Z.ai (GLM) · OpenAI-compatible (OpenAI / OpenRouter / Groq / DeepSeek / Ollama…) · Anthropic Claude · Google Gemini |
   | Voiceover | Z.ai TTS · OpenAI-compatible (`/audio/speech`, 10 voices) |
   | Artwork | Z.ai CogView · OpenAI-compatible (DALL·E 3 / gpt-image-1) |
   | Scene animation | Z.ai CogVideoX (only option — Ken Burns render needs no AI video) |

That's it — no config files to edit by hand. The studio starts empty: create your
first video from the **Create** page (Auto-Pilot walks the whole pipeline), add
channels in **Channels**, recurring characters in **Cast**.

To let other devices on your Wi-Fi reach it: `npm run dev:lan`.

---

## 3. Accounts & access (Stage 2 — multi-user)

TubeForge is now a multi-user application: every visitor **registers** an
account (email + password, min 8 chars) and gets their own isolated studio —
own videos, channels, characters, settings, API keys and YouTube connection.
No data is shared between accounts; this is verified by the automated
cross-tenant isolation suite (`e2e/isolation.spec.ts`, runs in CI).

| | Local dev (default) | Production |
|---|---|---|
| `TUBEFORGE_AUTH_SECRET` in `.env` | set (`npm run setup` provisions one) | set (32+ hex chars) — without it a production server refuses to serve any API (503) |
| `TUBEFORGE_ENCRYPTION_KEY` in `.env` | set — encrypts provider keys + YouTube tokens at rest | set |
| First visit | registration form (the FIRST account claims any pre-Stage-2 data — see below) | same |
| Email verification / password reset | `TUBEFORGE_EMAIL_MODE=console` (default): links are logged + returned in the response | `TUBEFORGE_EMAIL_MODE=smtp` + `TUBEFORGE_SMTP_*` (see §7) — the response then omits the link |
| Locked out? | `npm run auth:reset -- --email you@example.com` (prints a reset link; `--set NewPass123` sets it directly) | same |

**Upgrading an existing single-user install** — the migration
(`npm run migrate:stage2`, also run by `setup:local`/`postinstall`) parks the
old studio's rows under a bootstrap organization; the first person who
registers **and proves the old access password** (when one was configured)
claims everything: the legacy content moves into their new studio and the old
global settings become their per-user settings (YouTube connection, provider
keys, preferences). A stranger registering first cannot steal the data — the
password proof blocks them.

Rotating `TUBEFORGE_AUTH_SECRET` signs every session/token out instantly.
Rotating `TUBEFORGE_ENCRYPTION_KEY` invalidates stored secrets (they must be
re-entered) — rotate one at a time, not both together.

---

## 4. Optional: config file instead of the UI

The Z.ai SDK reads a `.z-ai-config` JSON file (project dir → home dir → `/etc`).
The Settings UI writes this file for you (UI wins over the file). If you prefer
doing it manually:

```bash
cp .z-ai-config.example .z-ai-config
nano .z-ai-config   # paste your key
```

- bigmodel.cn key instead? Set `"baseUrl": "https://open.bigmodel.cn/api/paas/v4"` (in the file or the Settings UI).
- Keep this file private — never commit it to git (already in `.gitignore`).

The same 429 quota limits can happen on your own key. The app handles them:
escalating retry back-offs, patient storm rounds, and the red **Stop** button
on scripting videos / library cards.

---

## 5. What ships in this package

```
tubeforge/
├── src/               # full app source (Next.js 16 + React 19 + Tailwind 4)
├── prisma/            # database schemas + migration chain (schema.prisma =
│                      #  PostgreSQL deploy default, schema.sqlite.prisma =
│                      #  GENERATED mirror — never edit it by hand)
├── db/                # empty — `npm run setup:local` creates custom.db here
├── public/            # icons, PWA manifest
├── scripts/           # backup.sh, auth-reset.mjs, worker.mts, test suite
├── Dockerfile         # production image (web + worker roles, ffmpeg inside)
├── docker-compose.yml # postgres + web + worker topology
├── fly.toml           # Fly.io process-group deployment
├── package.json       # npm scripts (dev / setup / build / db / auth:reset)
├── .env               # DATABASE_URL (relative, works anywhere) + fresh auth secret
├── .env.example       # same, for reference
├── .z-ai-config.example  # optional manual config template
├── SECURITY.md        # protection matrix + security checklist
└── SETUP.md           # this guide
```

---

## 6. Troubleshooting

**`ffmpeg not found`** when rendering — install it (see table above) and restart
the dev server so the PATH refreshes.

**`Error: Cannot find module '@prisma/client'`** — run `npx prisma generate`
(the `postinstall` hook normally does this for you).

**`P1003: database file does not exist`** — run `npm run setup:local` (creates
`db/custom.db` from the schema). The `.env` uses a relative path
(`file:../db/custom.db`) resolved against the `prisma/` folder — keep the folder
layout as shipped.

**AI calls fail instantly with 429** — quota throttling on your API key, not a
bug. Free flash models are concurrency-limited: wait a moment or switch model in
Settings. Paid models need credit on the account. Use the **Stop** button to
cancel and retry later.

**Test connection fails with auth error** — the key was copied with a stray
space/newline, or was revoked. Re-copy it from the Z.ai API keys page.

**Port 3000 already in use** — change the port: `npx next dev -p 3001`.

**Production mode** (optional): `npm run build && npm start` serves the optimized
build on port 3000. The build/start scripts use `cp`, so on Windows use WSL or
Git Bash for those two commands — `npm run dev` works everywhere as-is.

**Backups** (optional): `npm run backup` writes a hot-copy of the database plus
an uploads manifest into `backups/` (needs the `sqlite3` CLI installed).

**Tests**: `npm test` runs the unit + regression suite (pure Node — no bun,
no extra services). `npm run check` runs typecheck + lint + tests together.
`npm run test:e2e` runs the Playwright browser smoke suite (downloads Chromium
on first run).

---

## 7. Production deployment matrix (Stage 3)

The application ships as ONE container image with TWO roles — the compose file
and `fly.toml` pick the command per service:

| Role | Command | What runs there |
|---|---|---|
| **web** | `node .next/standalone/server.js` | Next.js server (port 3000) + the in-process queue loop. Route closures run preferentially here; every kind ALSO has a DB-derivable handler (video-jobs.ts / character-jobs.ts), so the worker can take any job over when the web process dies |
| **worker** | `node --import tsx scripts/worker.mts` | Dedicated durable-queue worker — claims every handler-registered kind (script, research, stock, voiceover, storyboard, scene, render, short, convert, verify, comments, thumbnail, variants, slide, portrait, poses) rebuilt from DB state + the Job row's `payload` options. Scale horizontally — claims are atomic |

### Option A — Docker Compose (one box)

```bash
cp .env.example .env      # set POSTGRES_PASSWORD, TUBEFORGE_AUTH_SECRET,
                           # TUBEFORGE_ENCRYPTION_KEY (required!)
docker compose up -d --build
docker compose up -d --scale worker=2   # more render capacity
```

Postgres runs as a compose service; migrations (`prisma migrate deploy`)
run automatically on the web container's start. Media defaults to a named
Docker volume (`uploads`) — see storage below to move it off-box.

### Option B — Fly.io (multi-machine)

```bash
fly launch --no-deploy --copy-config
fly secrets set TUBEFORGE_AUTH_SECRET=... TUBEFORGE_ENCRYPTION_KEY=... \
  DATABASE_URL=postgres://... \
  TUBEFORGE_STORAGE_DRIVER=s3 TUBEFORGE_S3_BUCKET=... TUBEFORGE_S3_ACCESS_KEY_ID=...
fly deploy
fly scale count worker=2
```

Fly machines have ephemeral disks — **use the S3 driver** (below) or attach a
volume and mount it at `/app/uploads` (see the commented `[[mounts]]` in
`fly.toml`).

### Option C — Vercel + Neon (web only)

`npm run build && npm start` works, but Vercel's serverless functions cannot
run ffmpeg renders or the queue loop — pair it with at least one worker
container elsewhere (any VPS running the same image with
`node --import tsx scripts/worker.mts`), pointing at the same Neon/Supabase
Postgres. Set `TUBEFORGE_NO_CLAIM=1` on the web role so only the workers claim
jobs.

### Storage — local volume vs. S3/R2

| | `TUBEFORGE_STORAGE_DRIVER=local` (default) | `TUBEFORGE_STORAGE_DRIVER=s3` |
|---|---|---|
| Media lives in | a shared volume at `/app/uploads` | any S3-compatible bucket (AWS S3, Cloudflare R2, MinIO) |
| Video delivery | streamed by the app (Range requests, constant memory) | **302 → presigned URL** — bytes flow CDN → client, never through the app |
| Quota | per-organization byte counter (`TUBEFORGE_STORAGE_QUOTA_GB`, default 10) | same |
| Render scratch | same volume | local tmp on the worker (`TUBEFORGE_SCRATCH_ROOT`), artifacts upload on completion |
| Env | — | `TUBEFORGE_S3_BUCKET`, `TUBEFORGE_S3_REGION` (`auto` for R2), `TUBEFORGE_S3_ENDPOINT`, `TUBEFORGE_S3_ACCESS_KEY_ID`, `TUBEFORGE_S3_SECRET_ACCESS_KEY` |

### Email — console vs. real SMTP

`TUBEFORGE_EMAIL_MODE=smtp` activates the built-in zero-dependency SMTP client
(STARTTLS on 25/587, implicit TLS on 465) with `TUBEFORGE_SMTP_HOST`,
`TUBEFORGE_SMTP_PORT`, `TUBEFORGE_SMTP_USER`, `TUBEFORGE_SMTP_PASS`,
`TUBEFORGE_SMTP_FROM`. Console mode (default) is fine for single-owner boxes
ONLY — in production the verification/reset links must reach inboxes.

### Operations quick reference

```bash
docker compose logs -f worker          # queue activity (JSON lines)
curl -s localhost:3000/api/auth/status # liveness
npx prisma migrate deploy              # manual schema sync (compose does it)
npm run backup                         # SQLite only; on Postgres: pg_dump
docker compose exec web node scripts/auth-reset.mjs --email you@example.com  # lockout recovery
```

Usage metering: every AI call lands in `UsageRecord` (per user, per
capability, latency + success); `GET /api/account/usage?days=30` returns the
aggregates that power the account dashboard.
