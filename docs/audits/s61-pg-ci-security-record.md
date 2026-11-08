# S61 — PostgreSQL reliability lane + production security closure

**Status: EXECUTED (2026-11-08) — landing rides the rotated PAT (see §6).**
**Trigger:** the owner's external audit of 8 November 2026 ("fresh audit:
8 November 2026"), which confirmed S60 closed on CI evidence and ranked the
outstanding work. S61 is the audit's P0 list, code-side half.

---

## 1. Why this stage exists

The S60 incident's deepest lesson was not the wedge itself — it was that
every CI surface (check, coverage, e2e, nightly) runs SQLite, so the
Postgres path had **zero automated coverage**. A Postgres-only migration
wedge (42P07 at auth_setting) and two Postgres-only SQL bugs (42703 unquoted
camelCase identifiers, 42883 boolean `ok = 0`) shipped and sat in production
for six days. The audit's #1 recommendation: a real PostgreSQL service in
CI. The audit's security P0s: `/api/diag` was still public, and the
deployment runs without `TUBEFORGE_ENCRYPTION_KEY`.

## 2. What changed

### 2.1 `/api/diag` is no longer public (T-61.1)

Removed from `PUBLIC_API` in `src/middleware.ts`. Both the S60 record's
owner checklist and the route's own header called for exactly this once the
heal was confirmed — it was (the production DB self-healed ~4 minutes after
the S60 deploy; all endpoints re-probed 200). The route itself remains for
**authenticated** incident triage: with the default-deny middleware it now
requires a session cookie or Bearer token like every other `/api/*`
endpoint.

Verified live on the rebuilt sandbox preview: `GET /api/diag` → **401**
`{"error":"Authentication required — sign in to use TubeForge"}`;
`GET /api/auth/status` → still public 200 (signed-out browsers need it).

### 2.2 The encryption-key watchlight (T-61.2)

`src/instrumentation.ts` now warns — once per process, at boot, with the
exact remediation — when a production server starts without a usable
`TUBEFORGE_ENCRYPTION_KEY` (< 16 chars). The S60 record found the Vercel
deployment in precisely this state (`diag: encryptionKey false`): the
crypto module fails closed at USE time, so nothing was visibly broken until
someone stores or reads a provider credential. Boot is the one
guaranteed-loud moment. Never fatal (the hook's fault-tolerance law).

**The actual fix remains an owner action:** set a securely generated 32+
char key in the Vercel environment settings, then re-store any saved
provider credentials (values encrypted under the old/absent key are
unreadable by design).

### 2.3 The PostgreSQL CI lane (T-61.3)

`.github/workflows/ci.yml` gains the `postgres` job — a real
`services: postgres:17` container, `DATABASE_URL` exported **before**
`npm ci` so postinstall picks `prisma/schema.prisma` (the other jobs stay
SQLite). The job then replays the S60 incident end-to-end:

1. **Pass 1** (`npm ci`'s postinstall): a CLEAN database walks the chain.
2. **Pass 2** (the explicit postinstall step): the self-heal completes it.
3. **`scripts/pg-ci-verify.mts`** — the gate — asserts on the healed state:

| Assertion class | What it proves |
|---|---|
| `_prisma_migrations` exists, all 18 chain migrations have finished rows, nothing stuck | the migration chain completes and stays healthy |
| `Setting_pkey` attached to `Setting`, `LegacySetting_pkey` to `LegacySetting`, no surviving `Setting_pkey` on `LegacySetting` | the S60 wedge (42P07 seed) cannot silently return |
| `Video.qcOverrideAt` + `Video.contentPolicy` exist | the s40/s49 columns land (their absence was the production P2022) |
| the REAL sparkline SQL runs with seeded `ok: true/false` rows → `calls=2, failures=1` | the 42703 (quoting) + 42883 (`NOT "ok"` boolean) fixes hold, verified with a boolean roundtrip |
| `prisma.video` create + full-select read | the exact query shape that 500'd production |

The battery exits non-zero on any failure — the lane is a regression gate,
not a report.

### 2.4 Single-sourced the sparkline SQL (T-61.4)

The daily-usage sparkline moved from an inline block in
`src/app/api/account/usage/route.ts` into
`src/lib/tubeforge/usage-sql.ts` (`dailyUsageSparkline`). The route and the
CI probe now call **one** function — CI verifies the exact production SQL;
copy-drift is structurally impossible. Pure code motion: the SQL text is
byte-identical to the S60-fixed version (quoted identifiers + `NOT "ok"`).

### 2.5 The virgin-database deploy bug — found by the lane's own drill (T-61.5)

The audit asked CI to prove "complete migration chain from a clean
database." Reproducing the job locally (embedded Postgres, the S60 harness
method) immediately caught a real latent bug, older than S60:

- `pgRepairMissingInitTables` (b8ec16f, Nov 2) was built for **partial**
  legacy schemas (the production DB had 10 tables, missing VoiceProfile).
- Run on a **virgin** database (zero public tables), it CREATED
  VoiceProfile with no `_prisma_migrations` to show for it — so
  `migrate deploy` refused forever with **P3005** ("The database schema is
  not empty" + unmanaged). Every retry reproduced the state.
  **A brand-new Postgres deployment could never migrate.** Nobody noticed
  because every real deployment so far inherited a legacy-shaped database.

Fix, in `postgresMigrate` (two moves):

1. **Virgin guard** — zero public tables ⇒ deploy directly. The chain's
   init migration creates everything; nothing needs repairing.
2. **In-run heal** — on a virgin database the clean chain is *expected* to
   wedge at auth_setting **mid-deploy** (the survivor constraint only
   comes into existence when stage2's rename runs, so no pre-deploy repair
   can catch it — this is precisely how every chain-walking Postgres got
   wedged). postgresMigrate now catches that failure, verifies the wedge
   fingerprint (`pgWedgePresent`), fires the S60 repair, resolves the
   stuck row (`pgResolveStuckMigrations`, extracted), and redeploys once.

Verified end-to-end on the embedded cluster — **one** postinstall pass:

```
igrate-stage2] empty database — deploying the full chain (no repairs apply)
Applying migration `20261102040000_auth_setting`
Error: P3018 … Database error code: 42P07 … "relation \"Setting_pkey\" already exists"
igrate-stage2] clean-chain deploy wedged at auth_setting (42P07) — the S60 repair fires mid-chain; redeploying
igrate-stage2] repair: renaming the surviving "Setting_pkey" constraint on LegacySetting (the auth_setting wedge)
igrate-stage2] failed migration row detected (20261102040000_auth_setting) — resolving as rolled back for retry
Applying migration `20261102040000_auth_setting` … `20261107000000_s49_content_policy`
```

→ all 18 migrations finished · **27/27** battery assertions · second
postinstall a clean no-op (`No pending migrations`, exit 0). A fresh
deployment now heals within a **single build** — S60's real-world story
needed a second deploy.

## 3. Gates (all local, 2026-11-08)

| Gate | Result |
|---|---|
| `tsc --noEmit` | 0 |
| `eslint .` | 0 errors / 20 warnings (census unchanged — zero added) |
| unit (`test-unit.mts`) | 247/247 |
| billing | 40/40 |
| queue | 39/39, exit 0 (one first-run ✗: the live preview server's claim loop won a race on the shared dev DB — environment interference; clean rerun) |
| `next build` | exit 0, 57/57 pages, the same four documented warnings |
| embedded-PG drill | wedge reproduced + healed in one pass; 27/27; idempotent no-op |

## 4. Security posture notes

- `/api/diag` authenticated: its body remains booleans/protocols/redacted
  text (never env values, never connection strings) — now behind the same
  gate as every other endpoint.
- The encryption key: the warning is the code-side half; the owner sets the
  env + re-stores credentials. Until then, provider-credential encryption
  stays unavailable (fails closed — no silent plaintext fallback exists).
- No secrets touched this stage; gitleaks scans the push as always.

## 5. Deliberately NOT in S61

- The remaining 20 lint warnings (audit P2 — the burn-down programme
  continues separately).
- Dependabot reconciliation (audit P2 — 8 open PRs; typescript-7 major is
  known CI-red).
- Real-provider video-quality validation + blind scoring across the seven
  production profiles (audit P1 — a product-readiness sprint of its own;
  the audit itself says engineering reliability first, then prove the
  videos).
- Running the unit/billing/queue suites ON Postgres (the lane currently
  proves migrations + the two 500ing query shapes; full suite portability
  is a natural S62+ extension once the lane is proven in CI).

## 6. Landing

The S60 close stated the law: the S59 token transited chat **twice** (its
second transit was the S60 landing green-light itself) — **rotation is
mandatory before S61 lands, and the replacement must not transit chat.**
Consequently this stage is committed locally and fully gated; the push, CI
verification, and stage close ride the owner's rotated credential
(delivery bundle + push instructions in `download/`). CI run link and any
fleet adjustments will be appended when it lands.
