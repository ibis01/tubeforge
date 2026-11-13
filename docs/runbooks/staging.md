# Staging — the drill ground (S110)

**The law (DEPLOYMENT §3):** every launch item marked "operational" is
drilled on a REAL staging environment, not the dev sandbox. The P2 entry
queue (docs/production-readiness.md) names staging as the gate between
"technically strong" and "release candidate": the drills below must be
green before the RC tag is cut.

The kit: `fly.staging.toml` (same topology as production) ·
`scripts/staging-provision.sh` (one-command provision) ·
`scripts/staging-drill.mts` (the HTTP harness) ·
`scripts/staging-drills.sh` (the orchestrator) ·
`.env.staging.example` (the input template).

---

## 1. Accounts you need (one-time)

| Account | What you create | Cost |
| --- | --- | --- |
| Fly.io | nothing yet — the provisioner registers `tubeforge-staging` | pay-as-you-go; two small machines + one 2 GB worker |
| Neon | a **branch** of the production project (resettable) | free tier |
| Cloudflare R2 | a separate bucket + an S3 API token (Object Read & Write on that bucket) | free tier covers drills |
| Stripe | **test-mode** API key + two test prices (creator / studio) | free |
| Google (optional) | a test OAuth client with a test YouTube channel | free |
| Z.ai (optional) | one API key for the pipeline drill | free tier |

## 2. Fill in the inputs

```bash
cp .env.staging.example .env.staging   # gitignored — fill in §1's values
```

`TUBEFORGE_AUTH_SECRET` / `TUBEFORGE_ENCRYPTION_KEY` are NOT in the file:
the provisioner generates them FRESH on every run — staging never shares
production secrets (the §3 law).

## 3. Provision + verify

```bash
bash scripts/staging-provision.sh --dry-run   # see the plan first
bash scripts/staging-provision.sh             # launch → secrets → deploy → health poll
```

Then the two manual steps the script cannot do:

1. **Stripe webhook** — in the Stripe dashboard (test mode) register an
   endpoint for `https://tubeforge-staging.fly.dev/api/billing/webhook`,
   copy the signing secret into `.env.staging`
   (`TUBEFORGE_STAGING_STRIPE_WEBHOOK_SECRET`) and re-run the provisioner
   (or `fly secrets set -a tubeforge-staging TUBEFORGE_STRIPE_WEBHOOK_SECRET=whsec_…`).
2. **Provider key for the pipeline drill** — sign in at the staging URL →
   Settings → AI Providers → paste the Z.ai key → Test. (One key powers
   every Z.ai task; the drill's render itself is $0 — the whiteboard
   engine is native.)

## 4. The drills

```bash
STAGING_URL=https://tubeforge-staging.fly.dev bash scripts/staging-drills.sh
```

### 4.1 Automated — the harness suites (`staging-drill.mts`)

- **health** — status, register + console-mode email verify, logout→login,
  authed list. Proves web + database + auth.
- **billing** — with test-mode Stripe wired, a checkout session must come
  back as a real `checkout.stripe.com` URL (the fail-closed 503 law makes
  "not configured" an honest SKIP).
- **pipeline** — create a story video (AI scene-split) → scaffold the
  whiteboard project with the native planner ($0) → enqueue the render →
  the WORKER renders (chromium + ffmpeg) → `final.mp4` round-trips the
  authenticated mp4 route (302→presigned under the s3 driver). This walks
  the entire production topology minus the AI billable surface.

Each suite self-skips with its reason when prerequisites are missing; a
SKIP never blocks, a FAIL always does.

### 4.2 Automated — the k6 load run

`scripts/load-test.js` (20 VUs, ~2 min): register / login / create /
list / status hot paths, < 2% errors, p95 < 500 ms. Skips with a note if
k6 is not installed.

### 4.3 Stripe webhook rehearsal (Stripe CLI)

```bash
stripe listen --forward-to https://tubeforge-staging.fly.dev/api/billing/webhook
stripe trigger checkout.session.completed
```

The drill user's billing plan must upgrade (verify in the app or via
`GET /api/billing/plan` signed in as that user). Then walk the portal:
open the checkout URL, complete the test payment, open the customer
portal, cancel — the whole lifecycle in test mode.

### 4.4 Worker recovery (the S100 law on the real platform)

```bash
node --import tsx scripts/staging-drill.mts --url https://tubeforge-staging.fly.dev --suite pipeline &
sleep 45   # let the render claim + start
fly machines restart --app tubeforge-staging --process-group worker
```

The render must still land: `hasVideo` + a fetchable `final.mp4`. The
expired lease is reaped with a fencing-token bump and a fresh worker
reclaims the job — the same contract the Docker smoke proves in CI, now
on the real platform.

### 4.5 YouTube test-channel publish smoke

Sign in → Settings → YouTube → connect the TEST channel (the test OAuth
client must list you as a test user) → publish one drill video → confirm
it lands (unlisted) on the test channel → delete it.

### 4.6 Backup + restore (Postgres edition of the CI drill)

```bash
TUBEFORGE_DB_URL="<the Neon branch URL>" npm run db:backup:pg
# restore the dump into a SCRATCH Neon branch (never the live one):
createdb "$SCRATCH_URL" && psql "$SCRATCH_URL" -f backups/tubeforge-<stamp>/database.sql
```

Row counts must match the live branch. The SQLite edition of this drill
(`npm run drill`, measured RTO) already runs in CI on every push — this
step proves the Postgres path against the real provider.

## 5. Reset (between drill rounds)

```bash
# a fresh Neon branch (dashboard or neon CLI), then point staging at it:
fly secrets set -a tubeforge-staging DATABASE_URL="<new branch URL>" \
  TUBEFORGE_AUTH_SECRET="$(openssl rand -hex 32)" \
  TUBEFORGE_ENCRYPTION_KEY="$(openssl rand -hex 32)"
fly deploy -a tubeforge-staging --config fly.staging.toml
```

Rotating the auth secret revokes every staging session instantly; old
data stays on the abandoned branch (delete it when done).

## 6. Teardown

```bash
fly apps destroy tubeforge-staging     # machines, secrets, the app
# Neon branch + R2 bucket: delete from their dashboards.
```

## 7. The RC gate

The release-candidate tag is cut when, on one staging deployment:

- [ ] health, billing, pipeline suites: PASS (no FAILs)
- [ ] k6 load run: thresholds met
- [ ] Stripe lifecycle: checkout → webhook → portal → cancel, all in test mode
- [ ] worker recovery: the interrupted render landed
- [ ] YouTube smoke: the test-channel publish landed
- [ ] backup/restore: row counts match on the scratch branch

Then: `git tag vX.Y.Z-rc1 && git push origin vX.Y.Z-rc1` at that HEAD,
cut the GitHub Release from the worklog entry (DEPLOYMENT §2's release law).
