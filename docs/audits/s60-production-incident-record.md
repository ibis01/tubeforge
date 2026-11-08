# S60 reliability record — production incident: the Vercel dashboard 500s

**Date**: 2026-11-08 (UTC) · **Stage**: S60 (owner-directed "SOLVE", with a
screenshot of the failing deployment)
**Status**: all tasks executed and verified locally on top of `5c7912d`;
**not pushed** — the landing rides a rotated PAT (the standing law; the S59
token transited chat once). The deployed database heals itself on the first
deploy of this fix.

## The report

The owner's screenshot: the deployed app
(`tubeforge-ibismuh.vercel.app`, logged in) showing
"Could not load dashboard — The stats service did not respond. Please
retry." on an otherwise-healthy shell.

## The triage — what was actually failing

A probe account was registered on the deployment (deleted afterward through
the front door, the E2E house rule) and the API surface was walked:

| Endpoint (authenticated) | Result |
|---|---|
| `/api/stats` | **200** (96 ms, full payload) |
| `/api/videos?limit=6` | **500**, empty body, no content-type |
| `/api/videos/stats` (→ the [id] route) | 500 |
| `/api/account/usage` | 500 |
| `/api/characters`, `/api/settings`, `/api/voices`, auth | 200 |

The stats service was never down. The dashboard's error card was a LIE by
omission — `Promise.all([fetch(stats).then(r=>r.json()),
fetch(videos).then(r=>r.json())])`: the videos 500's empty body made
`r.json()` reject, the whole chain fell to `.catch`, and `stats` stayed
null → the error card, with a healthy stats payload in hand.

## The root cause — pinned by the deployed DB itself, then reproduced

`/api/diag` (public, rate-limited — the earlier Vercel-registration-500
incident's tool) dumped the deployed Postgres state: migrations
`init`…`stage72` **finished**; `auth_setting` carrying **~90 rolled-back
failed rows** — one per deploy since 2026-11-02, each retried by the
postinstall failed-row recovery and re-failed; `s20`/`s32`/`s40`/`s46`/
`s49` never attempted. Consequence: `Video.qcOverrideAt` (s40) and
`Video.contentPolicy` (s49) do not exist → every full-select Video query
fails Prisma P2022 at query time → empty-body 500.

Why auth_setting fails — reproduced 1:1 on a local embedded Postgres 17
(`scripts/pgtest/`, the harness ships in the delivery): apply the chain
through stage72, then `migrate deploy` →

```
Applying migration `20261102040000_auth_setting`
Error: P3018 … Database error code: 42P07
ERROR: relation "Setting_pkey" already exists
```

The mechanism: **Postgres's `ALTER TABLE … RENAME TO` renames the table but
NOT its constraints.** stage2's `Setting → LegacySetting` rename left the
PK constraint still named `Setting_pkey` (verified:
`pg_indexes` shows `Setting_pkey` on `LegacySetting`); auth_setting later
re-creates `Setting` with `CONSTRAINT "Setting_pkey"` → 42P07 → the chain
wedges. Deterministic on EVERY Postgres database that walked the chain —
this was never a Vercel quirk; the production-of-record (Fly + Neon) would
wedge identically. `postinstall`'s "Postgres failures are NON-FATAL by
design" (deploy must not block on a bad DB) is what hid it: the warning
lands in build logs nobody read, the recovery loop retries forever, and the
dashboard 500s.

Why it surfaced NOW: s40 (Nov 6) added the first post-stage72 column the
client SELECTs on a hot path. Before that, the wedge was silent — the six
pending migrations' tables/columns were simply unused by the deployed
routes.

## The fixes (three, all verified)

1. **`scripts/migrate-stage2.mjs` — the self-heal.**
   - `pgRepairSettingPkeySurvivor`: when the wedge fingerprint is present
     (`LegacySetting` exists, `Setting` absent, a `Setting_pkey` constraint
     attached to `LegacySetting`), rename the survivor to
     `LegacySetting_pkey`. Idempotent, guarded, logged — the same pattern
     as the file's existing VoiceProfile repair.
   - `BASELINE_SENTINELS` extended through s49 — the list had silently
     stopped at stage72, so any legacy `db push`-shaped database newer than
     that era would collide with the chain's CREATE TABLEs. New
     `unlessColumn` disambiguator: auth_setting's Setting and init's Setting
     share a name but not a shape (init's carries `updatedAt`); an
     init-era fingerprint can never baseline the tail.
   - Verified end-to-end on the repro via the AUTHENTIC deploy path
     (`DATABASE_URL=postgres://… node scripts/postinstall.mjs`):
     repair fired → failed row resolved → all six pending migrations
     applied → `No pending migrations` → the exact `/api/videos` query
     shape returns OK.
2. **`/api/account/usage` — two Postgres portability bugs** in the daily
   sparkline's raw SQL: unquoted camelCase identifiers (Postgres folds them
   to lowercase → 42703) and `ok = 0` (a type error on Postgres booleans;
   `ok` is `Boolean` in schema.prisma, 0/1 only on SQLite). Fixed with
   quoted identifiers + `NOT "ok"`. Proven: old SQL fails 42703 / fixed SQL
   returns on the PG repro; SQLite suites green. The other raw-SQL sites
   were audited: `billing.ts` (releaseStaleHolds) is portable;
   `claim.ts` reads `sqlite_master` but is wrapped in try/catch by design
   (legacy claim is a SQLite-era concept); `/api/diag` is Postgres-only by
   purpose.
3. **`dashboard-view.tsx` — independent degradation.** Each fetch guards
   its own `ok` + JSON parse; a failing `/api/videos` renders the dashboard
   with stats and no recents instead of blanking it as a stats failure.

## The reproduction battery (the evidence)

On the stale PG repro (the exact production shape — chain wedged at
auth_setting, `qcOverrideAt`/`contentPolicy` missing):

- `/api/videos` **500 in-session** and the dashboard rendered FULLY anyway
  (Mission Control, hero, Production Volume, Pipeline Breakdown) — the
  resilience fix proven under the live failure.
  Screenshot: `download/tf-s60-dashboard-resilient.png`.
- `/api/account/usage` **200** with the fixed SQL on Postgres.
- After the authentic postinstall heal: `videos=200 usage=200 stats=200`,
  dashboard fully rendered, both constraints correctly named
  (`Setting_pkey` on `Setting`, `LegacySetting_pkey` on `LegacySetting`).
  Screenshot: `download/tf-s60-dashboard-healed.png`.

## The gates

| Gate | Result |
|---|---|
| tsc --noEmit | 0 |
| eslint . (frozen config) | 0 errors / 20 warnings (census unchanged — zero added) |
| unit (test-unit.mts) | **247/247** (sentinel tests extended: init-era updatedAt regression guard, auth_setting-era, s40-era, modern) |
| billing | 40/40 |
| queue | PASS |
| next build | exit 0, 57/57 pages, the same four documented warnings |
| E2E (Playwright, own dev server) | **26/26** (1.1m) |

## The spend-gate law — untouched

No `TUBEFORGE_SPEND_GATE=0`, no forced `TUBEFORGE_PRICING_VERIFIED`; zero
gateway quota, zero paid dispatches. The probe account on the deployment
performed reads and was deleted through its own front door.

## Landing + the owner's instant-heal option

- **On landing this fix** (push on a rotated PAT → CI → Vercel auto-deploy),
  the deployment's postinstall runs the repair + recovery + deploy and the
  DB heals itself. Verify with `/api/diag`: every migration `finished`,
  then close the diag route's public exposure (its own header comment says
  to remove it from PUBLIC_API once the incident is closed).
- **Manual instant heal** (no code needed): against the deployed DATABASE_URL
  from any shell with the repo checked out at `5c7912d+`:
  ```sql
  ALTER TABLE "LegacySetting" RENAME CONSTRAINT "Setting_pkey" TO "LegacySetting_pkey";
  ```
  ```bash
  npx prisma migrate resolve --rolled-back 20261102040000_auth_setting --schema prisma/schema.prisma
  npx prisma migrate deploy --schema prisma/schema.prisma
  ```
  (The resolve clears the last failed row; deploy applies the six.)

## Owner-side findings (not code)

1. **`TUBEFORGE_ENCRYPTION_KEY` is absent** on the Vercel deployment (diag:
   `encryptionKey: false`). Provider-credential encryption and the security
   card need it — set it (32+ chars) and re-store any saved credentials.
2. `/api/diag` is public — close it after confirming the heal.
3. DEPLOYMENT.md's doctrine stands: Vercel is a preview surface; Fly +
   Neon is the deployment of record. Whichever surface runs, its database
   needs the chain — and with this fix, drift self-heals at deploy time.
4. The CI blind spot that let both bugs through: every CI surface
   (check, coverage, e2e, nightly) runs SQLite. The Postgres path had zero
   automated coverage until this record's manual repro. Candidate follow-up:
   a Postgres CI lane (services: postgres) running migrate deploy + the
   usage route — the natural S61.
