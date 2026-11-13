# TubeForge — Deployment

**Decision (S33, improvement roadmap §4.4, 2026-11-05):** one topology wins.
Four deployment artifacts had accumulated — `fly.toml`, `Dockerfile`,
`docker-compose.yml`, `vercel.json` — with no staging environment and no
statement of which one is real. This document is that statement.

| Artifact | Role | Status |
| --- | --- | --- |
| `fly.toml` + `Dockerfile` | **Production**: web + worker process groups from one image | ✅ the deployment of record |
| `docker-compose.yml` | Local full-stack dev (Postgres + web + worker) | ✅ kept, development only |
| `vercel.json` | Fluid-compute preview builds only | ⚠️ marked — **not** the production target |
| (none) | Staging | 🚧 spec in §3 + the S110 kit (`fly.staging.toml`, `scripts/staging-provision.sh`, `scripts/staging-drills.sh`, the runbook [`docs/runbooks/staging.md`](docs/runbooks/staging.md)) — provisioned when operator accounts exist |

---

## 1. Why this topology

The deciding constraint is the **worker**. Rendering, the durable queue, and
AI stage coordination are long-running processes; a serverless web platform
cannot run them. The shared voice server (when enabled) wants a persistent
box. Therefore:

- **Fly.io** runs the app: the `web` process group (Next.js standalone
  server, 2 machines behind the Fly proxy) and the `worker` process group
  (`scripts/worker.mts`, 1 machine, scale with
  `fly scale count worker=2`). Both come from one Docker image — see
  `fly.toml`, which already encodes this.
- **Neon Postgres** (or equivalent managed Postgres) is the database.
  Migrations run with `npx prisma migrate deploy --schema prisma/schema.prisma`;
  the postinstall baselines an unmanaged database automatically on first
  deploy.
- **Cloudflare R2** (or any S3-compatible store) holds media:
  `TUBEFORGE_STORAGE_DRIVER=s3` plus the `TUBEFORGE_S3_*` secrets. Zero
  egress fees; the presigned-URL delivery path is already built and tested
  (the mp4 route). Fly machines have ephemeral disks — S3 mode is the
  default for any real deployment; a persistent volume for local-storage
  mode is documented in `fly.toml` but not recommended.
- **Voice server** (optional): the self-hosted Chatterbox Turbo server runs
  on its own persistent box (an Oracle free-tier ARM machine works — see
  `voice-server/oracle/`), pointed at by
  `TUBEFORGE_SHARED_VOICE_URL`/`TUBEFORGE_SHARED_VOICE_KEY`. The app
  supervisor spawn (`TUBEFORGE_SPAWN_VOICE_SERVER=1`) is for single-box
  dev/preview only.

**Why not Vercel for the app:** no place to run the worker; ephemeral
filesystem fights the media pipeline; build OOM behavior on constrained
plans. `vercel.json` is retained only because preview builds of the web
surface are occasionally useful — it is not a production target and carries
no data.

## 2. Provisioning production (the checklist)

```bash
# 0. databases + storage first
#    - Neon: create project → copy the connection string
#    - R2:   create bucket → create an S3 API token (access key + secret)

# 1. the app
fly launch --no-deploy --copy-config          # picks up fly.toml
fly secrets set \
  DATABASE_URL="postgresql://…" \
  TUBEFORGE_AUTH_SECRET="$(openssl rand -hex 32)" \
  TUBEFORGE_ENCRYPTION_KEY="$(openssl rand -hex 32)" \
  TUBEFORGE_STORAGE_DRIVER=s3 \
  TUBEFORGE_S3_ENDPOINT="https://<account>.r2.cloudflarestorage.com" \
  TUBEFORGE_S3_BUCKET="<bucket>" \
  TUBEFORGE_S3_ACCESS_KEY_ID="<key>" \
  TUBEFORGE_S3_SECRET_ACCESS_KEY="<secret>" \
  TUBEFORGE_S3_REGION=auto

# 2. schema (postinstall also baselines, but be explicit on first deploy)
fly ssh console -a tubeforge --command 'npx prisma migrate deploy --schema prisma/schema.prisma'

# 3. ship it
fly deploy                                     # web + worker from one image

# 4. verify
curl -f https://tubeforge.fly.dev/api/auth/status
```

Then the operational layer (tracked in the S33+ backlog in `TASKS.md`):

- **Billing:** `TUBEFORGE_STRIPE_SECRET_KEY`, `TUBEFORGE_STRIPE_WEBHOOK_SECRET`,
  `TUBEFORGE_STRIPE_PRICE_CREATOR`, `TUBEFORGE_STRIPE_PRICE_STUDIO` — and a
  Stripe webhook endpoint pointed at `https://<host>/api/billing/webhook`.
- **Email:** `TUBEFORGE_EMAIL_MODE=smtp` + the `TUBEFORGE_SMTP_*` set (or the
  console mode for single-owner installs).
- **YouTube:** `TUBEFORGE_YT_CLIENT_ID` / `TUBEFORGE_YT_CLIENT_SECRET`
  (server-wide OAuth client; users connect their own channels).
- **Backups:** the nightly cron + the quarterly restore drill —
  `docs/runbooks/backup-restore.md`.
- **Observability:** Sentry DSN + uptime monitor (S34+; see backlog).
- **Release tag:** tag the commit (`vX.Y.Z`) at every staging→production
  promotion; cut the GitHub Release from the worklog entry.

## 3. Staging (the drill ground)

Every remaining launch item in the worklog marked "operational" needs a
staging environment, not the dev sandbox:

| Resource | Staging value |
| --- | --- |
| Fly app | `tubeforge-staging` (same image, `fly launch --no-deploy --copy-config --name tubeforge-staging`) |
| Database | A Neon **branch** of the production project (resettable, free) |
| Object storage | A separate R2 bucket (or a subfolder + lifecycle rule) |
| Stripe | **Test mode** keys + test-mode webhook endpoint |
| Email | `TUBEFORGE_EMAIL_MODE=console` (links land in the logs — fine for drills) |
| Secrets | Fresh `AUTH_SECRET`/`ENCRYPTION_KEY` — staging never shares production secrets |

The staging environment is the target for: the k6 load run
(`scripts/load-test.js`), the YouTube test-channel publish smoke, the Stripe
checkout → webhook → portal lifecycle rehearsal, the backup restore drill,
and the beta cohort before production opens.

**The S110 kit makes §3 executable**: `scripts/staging-provision.sh`
(one command — fresh secrets, app registration, secrets, deploy, health
poll; `--dry-run` prints the plan), `scripts/staging-drill.mts` (the
HTTP-only drill harness: health / billing / pipeline suites, each
self-skipping when its prerequisites are missing), and
`scripts/staging-drills.sh` (the orchestrator: harness + k6 + the exact
operator-step sequences). The full runbook — accounts checklist, drills,
reset, teardown, the RC gate — is
[`docs/runbooks/staging.md`](docs/runbooks/staging.md).

## 4. Local development

Two modes, both tested: SQLite zero-config (`npm ci && npm run dev`, see
[`SETUP.md`](SETUP.md)) and full-stack Postgres
(`docker compose up` — Postgres + web + worker, migrations on boot).

## 5. The Chromium worker contract (whiteboard + slides rendering)

The worker role renders video. Every ffmpeg/ffprobe stage is covered by
the image's `ffmpeg` package; the **Whiteboard Engine** (and the slides
engine's browser path) rasterize in headless Chromium driven by
Playwright — and **the production image does not ship a browser**
(`Dockerfile` §3 states this for the old slides-only world: "no browser
here"). A worker built from the current image runs every job kind EXCEPT
whiteboard rendering, which dies at `chromium.launch()`. This section is
the deployment requirement, measured not assumed (the S75 E10 benchmark
and the E12 live queue drill, 2026-11-10).

**5.1 — Install the browser (the image gap).** In the runner stage, as
root, before `USER tubeforge`:

```dockerfile
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
RUN npx playwright install --with-deps chromium
```

`--with-deps` apt-installs Chromium's OS libraries; the env var keeps the
browser out of the (wiped) home cache and readable by the `tubeforge`
user at runtime.

**Status (2026-11-11): the lines have landed in the `Dockerfile` runner
stage** — the `ENV` sits in the base env block, and the install `RUN`
sits after the `node_modules` `COPY` (so `npx` resolves the pinned
playwright from the image's own `node_modules`: 1.57.0 → browser build
chromium-1200) and before `USER tubeforge`, with
`chown -R tubeforge:tubeforge /opt/ms-playwright` appended. Static
verification on record: `npx playwright install-deps --dry-run
chromium` enumerates the closure mechanism (X11/GBM/NSS/ALSA libraries
plus CJK/emoji fallback fonts — `fonts-wqy-zenhei`, `fonts-ipafont-
gothic`, `fonts-noto-color-emoji` — so the image renders CJK titles
without a separate font layer; playwright emits the matching package
names per distro at build time, bookworm here); `playwright` is pinned
`1.57.0` in **dependencies**, so the browser version is locked to the
lockfile. **Status (2026-11-13): the image is CI-proven, whiteboard
render included.** The P0.6 Docker production smoke
(`scripts/docker-smoke.sh`, a CI job on every main push — S105) builds
the real image and boots the full topology (Postgres + the S3 store +
web + worker); since S108 its acceptance walk also renders a REAL
whiteboard project IN-CONTAINER — the worker launches chromium with
these launch args, rasterizes the frames, encodes with ffmpeg, ships
`final.mp4` through the s3 driver, and the walk ffprobes the duration
and checks the video row. (The pre-S105 caveat — "the dev sandbox has
no Docker daemon, so the image itself is unverified" — is historical:
the gate now runs where the daemon is, on every push to main.)

**5.2 — The launch args are mandatory.** Chromium must launch with
`--no-sandbox --disable-dev-shm-usage` — encoded as
`WB_CHROMIUM_LAUNCH_ARGS` in `src/lib/tubeforge/whiteboard/render.ts`
and used at BOTH launch sites; the slides engine carries the same args.
Measured why: on a 4 GB worker with the default 64 MB `/dev/shm`, a bare
`chromium.launch({ headless: true })` is SIGKILLed mid-scene by the OOM
killer (the E10 receipt: the 16:9 benchmark died at scene 2, frame
230/378, no JS trace). The unit suite fails if a bare launch returns.

**5.3 — Per-scene context recycling is the memory contract.** The scene
loop births and closes one Chromium context PER SCENE — never one page
for the whole project (the one-page approach OOMs the 4 GB worker
mid-render). Measured envelope at 1080p: peak RSS 444 / 442 / 285 MB
across 16:9 / 9:16 / 1:1. Size the worker VM at 4 GB (the measured
shape); 1 GB is untested and expected to OOM on 1080p projects.

**5.4 — The worker is already a proper long-running process.**
`scripts/worker.mts` runs the claim loop under `tini`
(`TINI_SUBREAPER=1`); zombie reaping is handled. The double-fork
daemonizer (`scripts/daemonize.py`) is a DEV-SANDBOX tool that escapes
per-call process reapers — it is never needed under the container
worker, whose renders are ordinary long-lived children.

**5.5 — The drill that verifies this contract.**
`scripts/s75-e12-queue-drill.mts` proves, against the real queue and a
real chromium+ffmpeg render: a dead worker's whiteboard render is
recovered by a fresh worker and actually lands (final.mp4 + a probed
duration), and Stop cancels a running render mid-flight ("completed
scenes kept"). Run it after any change to the queue, the whiteboard job
path, or the storage driver.
