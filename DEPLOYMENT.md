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
| (none) | Staging | 🚧 spec in §3, provisioned when accounts exist |

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

## 4. Local development

Two modes, both tested: SQLite zero-config (`npm ci && npm run dev`, see
[`SETUP.md`](SETUP.md)) and full-stack Postgres
(`docker compose up` — Postgres + web + worker, migrations on boot).
