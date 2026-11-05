# Runbook — Production database backup & restore drill

**Scope:** production Postgres. (SQLite, the development database, is covered
by `npm run backup` + `scripts/test-backup.mts` — a tested roundtrip.)
**Introduced:** S33 (improvement roadmap §4.6, 2026-11-05).
**Rule:** a backup that has never been restored is a hypothesis, not a
control. The drill below runs **quarterly**, and after any change to the
backup script, the schema, or the database provider.

---

## 1. What backs up the database

Three layers, in order of preference when restoring:

| Layer | Mechanism | Cadence | Covers |
| --- | --- | --- | --- |
| Point-in-time restore | Enabled on the managed Postgres provider (Neon PITR / restore-to-branch) | continuous | Any moment inside the provider's retention window |
| Nightly logical dump | `npm run db:backup:pg` (`scripts/backup-postgres.sh`) | nightly | An **independent, off-provider copy** — survives provider account loss, region failure, or a bad migration the provider happily replicated |
| Pre-migration snapshot | `neon branch create` (or provider equivalent) before every `prisma migrate deploy` that touches data | per deploy | The "undo" for a migration that went wrong |

The nightly dump is the layer this runbook drills. It writes a
`pg_dump --format=custom` archive (compressed, `pg_restore`-compatible),
verifies it by listing it back (`pg_restore --list`), writes a `.sha256`
sidecar, and — when `BACKUP_S3_URI` is set — uploads both to object storage
(Cloudflare R2 / any S3-compatible bucket) via the `aws` CLI or `rclone`.

## 2. Scheduling the nightly dump

The dump must run on a machine that is always on and holds the production
`DATABASE_URL`. The Fly **worker** machine qualifies (it is the always-on
process group). Two workable options:

**Option A — cron on the worker machine (recommended, fewest moving parts):**

```bash
# from a machine with the fly CLI, authenticated:
fly ssh console -a tubeforge --select \
  --command 'grep -q db:backup:pg /etc/cron.d/tubeforge 2>/dev/null || \
    echo "17 3 * * * root cd /app && BACKUP_S3_URI=s3://<bucket>/tubeforge-backups npm run db:backup:pg >> /app/backups/backup-cron.log 2>&1" > /etc/cron.d/tubeforge'
```

(Cron inside a Fly machine resets on redeploy — re-check after each deploy,
or bake the crontab into the Dockerfile when the schedule is proven.)

**Option B — scheduled GitHub Action** calling
`fly ssh console -a tubeforge --command 'cd /app && BACKUP_S3_URI=… npm run db:backup:pg'`
with the Fly API token stored as a repository secret.

**Success criterion:** a new `tubeforge-YYYY-MM-DD_HHMMSS.dump` +
`.sha256` pair appears in the bucket every day, and `backup-cron.log` ends
with `done`.

## 3. The restore drill (quarterly)

Time it. The measured time is the RTO (recovery time objective) — write it
into the drill log in §4.

1. **Pick the artifact.** Take the most recent dump from the bucket (or
   `backups/pg/`). Verify it against its sidecar:
   `sha256sum -c tubeforge-<stamp>.dump.sha256`.
2. **Create a scratch database.** With Neon, the cheapest drill target is a
   branch: `neonctl branches create --name restore-drill-$(date +%Y%m%d)`,
   then copy its connection string. (Any scratch Postgres works — even
   `docker run -e POSTGRES_PASSWORD=drill -p 5433:5432 postgres:16-alpine`.)
3. **Restore into it:**
   ```bash
   pg_restore --dbname "$SCRATCH_URL" --no-owner --no-privileges --clean --if-exists tubeforge-<stamp>.dump
   ```
   Any error here is a finding: the backup is not restorable as-is. Record
   it and fix the cause before continuing.
4. **Boot the app against the scratch database** (never production secrets):
   ```bash
   DATABASE_URL="$SCRATCH_URL" \
   TUBEFORGE_AUTH_SECRET=$(openssl rand -hex 32) \
   TUBEFORGE_ENCRYPTION_KEY=<the PRODUCTION encryption key — needed to read stored credentials> \
   npm run dev
   ```
   Note: with the production `TUBEFORGE_AUTH_SECRET`, restored sessions and
   API tokens are valid — for a drill, a fresh random secret is safer
   (restored sessions simply fail, which is fine for the checks below).
   The **encryption key must be the production one** if you want to verify
   stored provider credentials decrypt; for a data-shape drill, a random key
   also works.
5. **Smoke checks** (each one exercises a different table family):
   - `GET /login` returns 200 (app boots, schema loads).
   - Register a throwaway account, log in, log out (User, Org, Session).
   - The dashboard lists videos with counts (Video, Scene, Job).
   - Open Settings → AI Providers (Setting, encrypted credentials path).
   - `GET /api/billing/plan` returns a plan (Plan, Subscription, CreditGrant,
     CreditLedger, SpendReservation).
6. **Record the result** in the drill log (§4): date, dump stamp, bytes,
   restore time, boot time, anomalies.
7. **Destroy the scratch database / branch.** Leave nothing behind.

## 4. Drill log

| Date | Dump stamp | Size | Restore time | Boot + smoke time | Result | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| — | — | — | — | — | _first drill pending_ | — |

## 5. Failure modes and responses

| Symptom | Likely cause | Response |
| --- | --- | --- |
| `pg_restore: error: could not execute query` mid-restore | Dump taken with a newer schema than the scratch DB expects | Re-create the scratch DB empty (no `--clean`), or use a matching Postgres major version |
| Nightly dump missing from the bucket | Worker machine redeployed (cron wiped), or aws credentials expired | Re-install the crontab (§2A); check `backup-cron.log`; alert on absence (the uptime monitor's companion check — see S33+ backlog, observability) |
| `sha256sum -c` fails after download | Truncated/corrupted transfer | Re-download; if it fails at the source, the dump was bad at write time — investigate disk health immediately |
| Dump size drops sharply day-over-day | A table stopped being written, or a silent schema change | Compare `pg_restore --list` table-data counts against the previous day before assuming |
