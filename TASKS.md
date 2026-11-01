# TubeForge — Stage 1 Task Backlog

**Status:** Stage 1 audit complete; this is the implementation backlog.
**Last updated:** 2026-11-01
**Source:** `FOUNDATION_AUDIT.md` defects + `RISK_REGISTER.md` Stage 1 risks

---

## Execution status (updated 2026-11-01)

All 19 tasks executed. Verification: `tsc --noEmit` clean · `eslint` 0 errors / 235 warnings (baseline) · 46 unit + regression tests pass · live dev-server smoke test green (202 create in 28 ms → scripted via background job; custom-script path 200; DELETE removes `uploads/<id>/`; security headers present; `params.n` → 400; research GET 404 shape correct).

| Task | Status | Notes |
|---|---|---|
| T-1.1 restore scripts | ✅ Done | `scripts/backup.sh`, `scripts/auth-reset.mjs`, `scripts/package-local.sh` written, executable, backup tested against the live SQLite DB |
| T-1.2 one package manager | ✅ Done | npm is PM of record; `bun.lock` deleted; `bun-types` → `@types/node` + `tsx`; test suite runs under Node (`scripts/test-unit.mts`); 46/46 pass |
| T-1.3 fix `npm run setup` | ✅ Done | `setup` now delegates to the postinstall auto-detect logic; verified against SQLite |
| T-1.4 ESLint rules | ✅ Done | Selected rules re-enabled at warn (235-warning baseline recorded); Next 16's `react-hooks/set-state-in-effect` warned with a note (17 pre-existing sites) |
| T-1.5 CI | ✅ Done | `.github/workflows/ci.yml` — typecheck + lint + tests + Postgres schema compile on push/PR; optional Playwright job on PRs |
| T-1.6 security headers | ✅ Done | CSP, nosniff, Referrer-Policy, Permissions-Policy, HSTS, COOP via `next.config.ts headers()`; verified live. XFO/frame-ancestors/COEP deliberately deferred to Stage 4a (preview-iframe caveat documented in the config) |
| T-1.7 prisma migrate | ✅ Done | Baseline migration `prisma/migrations/000000000000_init/migration.sql` generated via `migrate diff` (266 lines) + `migration_lock.toml` |
| T-1.8 setup race | ✅ Done | `TUBEFORGE_OWNER_TOKEN` gate in `POST /api/auth/setup`; documented in `.env.example` + SETUP.md |
| T-1.9 jobbed script create | ✅ Done | `POST /api/videos` returns 202 in 28 ms (was 30 s+ blocking); `runScriptJob` wired; end-to-end verified — job ran, video landed `scripted` |
| T-1.10 jobbed research/greenlight | ✅ Done* | Research: jobbed with new `research` JobKind + new `GET /api/research/[id]` poll endpoint + persisted scan errors; client polls. Greenlight: jobbed via `runScriptJob` with the radar brief + keyword union; client toast updated; detail dialog adopts the in-flight job. *Deviation: the character-bible route stays synchronous by design (~5-8 s, form-preview path has no entity id to job onto) — documented in the route; moves to the queue in Stage 3 |
| T-1.11 zod validation | ✅ Done* | Full zod schemas on `PATCH channels/[id]`, `PATCH characters/[id]`, `PATCH schedule/[id]`; `PATCH videos/[id]` got length caps (description ≤5000, tags ≤500) with full zod conversion deferred to Stage 2 |
| T-1.12 params.n validation | ✅ Done | zod `int().positive()` on storyboard/[n], slides/[n], stock/[n] (GET+POST); live-verified 400 on `abc` |
| T-1.13 DELETE cleanup | ✅ Done | `DELETE /api/videos/[id]` removes `uploads/<id>/`; live-verified |
| T-1.14 music seed off GET | ✅ Done | GET is a pure read returning `needsSeed`; the client seeds explicitly; live-verified |
| T-1.15 strict mode + drift | ✅ Done | `reactStrictMode: true`; dead Tailwind v3 config left in place intentionally (v4 ignores it — deletion is cosmetic and deferred to avoid churn); VoiceProfile comment drift noted for the Stage 2 schema pass |
| T-1.16 docs | ✅ Done | SETUP.md: studio access modes table, npm-only prerequisites, migrate deploy guidance; `.env.example` documents `TUBEFORGE_OWNER_TOKEN` |
| T-1.17 Playwright | ✅ Done | Kept (it is a runtime dep for slides rendering, not dead weight); added `@playwright/test` + `playwright.config.ts` + `e2e/smoke.spec.ts` (3 tests incl. a security-header assertion) + `npm run test:e2e`; wired as an optional CI job |
| T-1.18 docs in repo | ✅ Done | Already in place from the audit sprint |
| T-1.19 SECURITY.md | ✅ Done | Already in place from the audit sprint |

Risks closed this session: R-CRIT-3, R-HIGH-1, R-HIGH-2, R-HIGH-3, R-HIGH-11, R-HIGH-28 (partial), R-MED-1, R-MED-8, R-MED-9, R-MED-10, R-MED-11, R-MED-12, R-MED-14, R-MED-15, R-LOW-4, R-LOW-5, R-LOW-6, R-LOW-7 (+ partial R-HIGH-4 recorded as a documented deviation, R-LOW-1/R-LOW-2 deferred with rationale). Stage 2 closes the remaining CRITICAL pair (R-CRIT-1, R-CRIT-2).

---

## Stage 2 execution status (updated 2026-11-01)

**R-CRIT-1 + R-CRIT-2 closed.** Verification: `tsc --noEmit` 0 errors · `eslint` 0 errors (242 warnings baseline) · 49/49 unit tests (3 new crypto tests) · **7/7 cross-tenant isolation e2e tests green** (`e2e/isolation.spec.ts` — two independent accounts: list/read/mutate/delete/settings/jobs isolation + default-deny 401s + server-side session revocation) · agent-browser golden path verified (UI registration → studio shell, no console errors).

| Area | Status | Notes |
|---|---|---|
| Prisma schema (PG + SQLite) | ✅ | `User`, `Organization`, `Membership`, `Session`, `UserSetting`, `YouTubeAccount`, `ProviderCredential`, `LegacySetting`; `organizationId` + cascade + index on all 10 content models; `schema.sqlite.prisma` now GENERATED from `schema.prisma` (`scripts/sync-sqlite-schema.mjs`) — the mirror can never drift again |
| Migration | ✅ | Postgres: `20261101000000_stage2_multiuser` (backfill via `DEFAULT 'default'` + `DROP DEFAULT`, `Setting`→`LegacySetting` RENAME, bootstrap org, partial unique owner index, `Membership_one_owner_per_org`). SQLite: `scripts/migrate-stage2.mjs` (3-phase, idempotent; wired into `setup:local` + `postinstall`) |
| Claim flow | ✅ | First registrant on a legacy install must prove the OLD studio password (`POST /api/auth/register` + `legacyPassword`); `src/lib/tubeforge/claim.ts` migrates every LegacySetting row (yt* → YouTubeAccount w/ encrypted refresh token; ai.*/tts keys → ProviderCredential encrypted; everything else → UserSetting) and transfers all content from org `default` to the claimer's org |
| Tenant guard | ✅ | `src/lib/tubeforge/tenant-db.ts`: Prisma `$extends` client injecting `organizationId` (reads/writes/creates/upserts) from the request context; `requireUser()`/`auth.enter()` (ALS) + `requireRole()`; ESLint rule `no-restricted-imports` blocks raw `@/lib/db` imports in `src/app/**` (auth bootstrap allow-listed) |
| Auth | ✅ | register/login/logout/status/token/verify-email/reset-password; PBKDF2 (same hash format — legacy `auth.password` migrates verbatim); server-side `Session` rows (7-day, revocable — revocation verified by e2e); signed OAuth state tokens (scope `"state"`, never credentials) |
| Default-deny middleware | ✅ | §6.3 model: public allow-list = the 6 auth endpoints + `/api/youtube/callback` (Google redirect); everything else 401s without a session; production fail-safe on missing `TUBEFORGE_AUTH_SECRET` |
| Secrets at rest | ✅ | `crypto.ts` AES-256-GCM (`v1.` format, per-record IV) on ProviderCredential.apiKey + YouTubeAccount refresh/access tokens; unit tests pin roundtrip + tamper detection |
| Per-user settings | ✅ | All 26 former `db.setting` access points migrated (llm/tts/budget/quality/music/stock/analytics/providers/​zai-config + settings/youtube routes); caches keyed per user; stock keys + provider keys → ProviderCredential |
| Jobs | ✅ | Job rows carry `organizationId`/`userId`; boot recovery runs context-free (`withCtxNull`); job bodies inherit the launching request's tenant (ALS) |
| GDPR | ✅ | `GET /api/account/export` (JSON bundle; secrets as presence markers), `POST /api/account/delete` (`confirm:"DELETE"` wipes org + sessions + uploads trees) |
| Client | ✅ | `auth-gate.tsx` rewritten: register/sign-in modes, legacy-claim field on first registration, in-background email verification (console mode) |

**Documented deviations (carry to Stage 3):**
1. Email delivery is console-mode (`TUBEFORGE_EMAIL_MODE=console` default): verification/reset links are logged + returned in the response; SMTP adapter + production email is Stage 3.
2. The bundled Z.ai SDK stays a PLATFORM-level credential (single `.z-ai-config` gateway); per-user zai rows migrate for owner continuity but per-user Z.ai isolation arrives with the Stage 3 provider abstraction. Non-zai provider keys are fully per-user + encrypted.
3. `ytClientId`/`ytClientSecret` prefer env (`TUBEFORGE_YT_CLIENT_ID/SECRET`); the claiming owner's migrated rows serve as fallback (same exposure model as the old Setting rows — documented).
4. Redis for session state / rate-limit buckets / login lockouts is deferred (in-memory + DB-backed Session rows survive restarts — the roadmap's D-20/D-21 goal is met by the Session table); Redis pacing for budget.ts lands in Stage 3.
5. `Video`↔`YouTubeAccount` publish attribution relation deferred to Stage 6 (publish wiring); YouTubeAccount.channelId uses a `legacy` placeholder until reconnect for migrated connections.
6. `LegacySetting` drop scheduled for Stage 3 (two-step removal kept data safe through the transition).

---

## Stage 3 task backlog (defined 2026-11-01 — executing now)

### Execution status (updated 2026-11-01, part 2 — T-3.7 through T-3.12 complete)

**All 12 Stage 3 tasks done.** Verification: `tsc --noEmit` 0 errors · `eslint` 0 errors (262-warning baseline) · **64/64 unit tests** (6 new storage + 2 new email) · **7/7 cross-tenant isolation e2e green** · 4/4 smoke e2e (incl. security headers) · live dev-server smoke: register 201 → `GET /api/account/usage` 200 with correct aggregates → video create 202 → DELETE 200 → 404 after · per-user Z.ai key PUT→GET roundtrip (encrypted at rest, masked readback) verified live.

| Task | Status | Notes |
|---|---|---|
| T-3.7 storage abstraction | ✅ Done | `src/lib/tubeforge/storage.ts`: key API (put/putFromPath/get/readStream/stat/delete/removePrefix/presign/materialize/withLocalFile/scratchDir). LocalDisk default (key = historical uploads layout — ZERO data migration); s3 driver is a zero-dep SigV4 signer over fetch (path-style, R2/MinIO compatible). Per-org quota counter (`StorageUsage` model, `TUBEFORGE_STORAGE_QUOTA_GB`, default 10 GiB, O(1) on put). All ~20 `UPLOAD_ROOT` call sites migrated (ai/render/shorts/story/serialize/verify/convert/captions/voice/voice-preview/stock/qc/music/queue-handlers + mp4/export/thumbnail/variants/voiceover/script/short/stock/music routes). `GET mp4` 302s to a presigned URL under s3 (D-24 closes the ROADMAP way). Asset presence in DTOs moved to DB flags (`Video.hasPreview` added) — the fs probes lied under s3 and cost a stat per row. |
| T-3.8 UsageRecord | ✅ Done | `aiCall()` meters every AI call (capability, provider+model from the user's config, latency, ok) — fire-and-forget, never breaks a pipeline; token/cost columns are wired for provider-level reporting. `GET /api/account/usage?days=N` aggregates per capability + daily sparkline + storage footprint. |
| T-3.9 SMTP email | ✅ Done | `src/lib/tubeforge/email.ts`: console default (link logged + returned) / smtp via env — a zero-dependency ESMTP client (EHLO/STARTTLS/implicit-TLS-465/AUTH LOGIN/dot-stuffing, 15s step timeouts, header-injection guard). register + reset-password routes deliver through it; smtp responses never echo the link. Closes Stage 2 deviation 1. |
| T-3.10 per-user Z.ai | ✅ Done | `src/lib/tubeforge/zai-client.ts`: the acting user's zai ProviderCredential (AES-256-GCM) wins — capability-preferred, any-capability fallback — else the platform client. The SDK's file-only config surface is handled with a per-(user,key-hash) client cache + GLOBAL MUTEX around the write→create critical section. `saveCapability` now stores zai keys (the Stage 2 "platform-level only" carve-out is gone); the Settings UI gained the optional per-account Z.ai key field; caches invalidate on save. Closes Stage 2 deviation 2. |
| T-3.11 LegacySetting close-out | ✅ Done | Model removed from the schema (table now UNMANAGED — prisma neither creates nor drops it); claim.ts reads via raw SQL (tolerates the table's absence on fresh installs) and DROPs the table once every row is migrated. The migrate-stage2 RENAME path is untouched so unclaimed legacy installs still upgrade safely. Closes Stage 2 deviation 6. |
| T-3.12 deploy pipeline | ✅ Done | `Dockerfile` (node:20-slim + ffmpeg/tini, one image → web/worker roles, non-root, healthcheck) · `docker-compose.yml` (postgres + web + worker, `prisma migrate deploy` on web start, `--scale worker=N`, shared uploads volume) · `fly.toml` (web/worker process groups, checks, sizing) · SETUP.md §7 production matrix (Compose / Fly / Vercel+worker hybrid, storage local-vs-S3 table, email modes, ops quick reference). |

**Regressions caught & fixed by the final sweep** (the async migration of `serializeVideo`/`serializeScenes` and the media readers): the GET /api/videos list emitted `[{}]` (unawaited Promises serialize to `{}`), and two `promoteVariant` try/catch blocks could not see async throws. All call sites awaited / Promise.all'd; the 7/7 isolation suite re-verified green. tsc cannot catch this class (NextResponse.json accepts any) — noted for future async-ification work: grep call sites, then run the e2e list assertions.

**Known scope notes (honest):**
1. UsageRecord tokens/cost stay 0 until providers report usage in their responses (chat completions expose `usage`; tts/image do not) — the metering spine (per-call rows, latency, success, provider attribution) is what Stage 4's billing pivots on.
2. The s3 driver is unit-tested for key hygiene + local parity; live S3 roundtrips need a bucket (CI job with MinIO is a natural Stage 4 addition). SigV4 signing follows the AWS spec; presigned URLs cap at the S3 7-day maximum.
3. SMTP delivery is protocol-tested against the spec; a live relay check belongs to first production bring-up.
4. Per-user Z.ai client cache is in-process (max 64 users/process, evicted wholesale) — fine at current scale, revisit with Redis in Stage 5 if needed.

**Sandbox constraint noted up front:** this environment has ffmpeg + network but **no Redis and no Docker**. Stage 3's Redis-backed items are therefore built against a **DB-backed durable queue** (same semantics: claims, retries, backoff, cross-process cancellation, per-org caps — implemented with atomic `UPDATE ... WHERE status='pending'` claims that work on SQLite *and* Postgres). The `QueueDriver` seam stays one interface wide so a BullMQ/Redis driver can be dropped in when infrastructure is provisioned. S3/storage, SMTP and deploy-pipeline tasks ship as code-complete drivers + docs that activate purely via env vars.

### Execution order (dependency-sorted)

| Task | Objective | Dependencies |
|---|---|---|
| T-3.1 | This backlog | — |
| T-3.2 | Structured JSON logging (`log.ts`, pino-format lines, zero-dep) | — |
| T-3.3 | Cross-platform zombie reaper (D-10 — kill the Linux-only `/proc` dependency) | — |
| T-3.4 | Per-capability provider timeout matrix (D-09 — replace the flat 5-min timeout; fix `youtube.ts` direct-fetch bypasses) | — |
| T-3.5 | Durable job queue: `Job` schema columns + claim loop + retries w/ backoff + DB-persisted cancellation + per-org render caps + boot re-enqueue for DB-derivable kinds + standalone worker entry (`npm run worker`) | T-3.2 |
| T-3.6 | Streaming media delivery (D-23/D-24 — `mp4` route streams from disk w/ Range in constant memory; `export` zip composed per-file instead of whole-folder buffers) | — |
| T-3.7 | Storage abstraction (`storage.ts`): key-based API (`put/get/stat/delete/readStream/presign`), LocalDisk driver (default) + S3 driver (env-gated), quotas on `put`; migrate the ~20 `UPLOAD_ROOT` call sites | T-3.6 |
| T-3.8 | `UsageRecord` cost tracking: every `aiCall` recorded per-user/per-capability; `GET /api/account/usage` aggregate | T-3.5 |
| T-3.9 | SMTP email adapter (`email.ts` drivers: console default, smtp via env) — closes Stage 2 deviation 1 | — |
| T-3.10 | Per-user Z.ai provider isolation (provider abstraction resolves the acting user's credential) — closes Stage 2 deviation 2 | T-3.4 |
| T-3.11 | `LegacySetting` lifecycle close-out — closes Stage 2 deviation 6 | — |
| T-3.12 | Deploy pipeline: Dockerfile (standalone), docker-compose (app+worker+PG), `fly.toml`, SETUP.md production matrix | T-3.5 |

**Completion gate (roadmap):** a video job survives an application restart, resumes safely where possible, and its assets reach the correct user. T-3.5 delivers exactly this for the DB-derivable kinds (`script`, `research`, `stock`); kinds whose closures capture request-scoped state are re-enqueued as handlers are extracted (backlog continues next session).

---

## How to read this document

Every task has:

- **Task ID** — `T-<stage>.<seq>` (e.g. `T-1.1` is the first task of Stage 1)
- **Objective** — what the task accomplishes
- **Files / modules affected** — what to edit
- **Dependencies** — what must be done first
- **Acceptance criteria** — how we know it's done
- **Rollback strategy** — how to undo if it goes wrong
- **Risk IDs closed** — which `RISK_REGISTER.md` entries this task closes

Tasks are ordered by dependency, not by ID. Do them in order.

---

## T-1.1 — Restore missing scripts

**Objective:** Restore the three scripts that `package.json` references but the audit found missing from the shipped tree.

**Files / modules affected:**
- `scripts/backup.sh` — new file
- `scripts/auth-reset.mjs` — new file
- `scripts/package-local.sh` — new file (referenced in `SECURITY.md:31`)

**Dependencies:** none

**Acceptance criteria:**
- `npm run backup` writes a hot-copy of the SQLite DB + `uploads/` manifest into `backups/tubeforge-<timestamp>/` (or no-ops with a clear message on Postgres — for Postgres the script should document `pg_dump` as the alternative).
- `npm run auth:reset` removes `db/auth.lock` and sets `Setting "auth.enabled" = "false"` (matches `forceLockOff` in `src/lib/tubeforge/auth.ts:69`). Supports `--purge` flag to also delete `Setting "auth.password"`.
- `scripts/package-local.sh` packages the project for local distribution; explicitly excludes `db/custom.db`, `uploads/`, `.env`, `.z-ai-config`.
- All three scripts have executable permission (`chmod +x`).
- `SETUP.md` and `SECURITY.md` references to these scripts still match.

**Rollback strategy:** delete the three files; remove their `package.json` entries. The audit (D-12) confirmed the scripts are currently absent, so restoring them can only improve state.

**Risk IDs closed:** R-MED-9

---

## T-1.2 — Pick one package manager

**Objective:** Eliminate the dual `bun.lock` + `package-lock.json` ambiguity. Document the chosen PM as the only supported one.

**Files / modules affected:**
- `package.json` — update `test` script and `check` script
- `package-lock.json` or `bun.lock` — delete the loser
- `SETUP.md` — update prerequisite section
- `.gitignore` — confirm the loser is not re-introduced

**Recommended choice:** npm (because `SETUP.md` already documents it; bun is undocumented as a prerequisite).

**If npm is chosen:**
- Migrate `scripts/test-unit.ts` from `bun scripts/test-unit.ts` to `node --import tsx scripts/test-unit.ts` (or `vitest run`). The custom harness in `test-unit.ts` can stay; only the runner changes.
- Update `package.json:22` `"test": "node --import tsx scripts/test-unit.ts"`.
- Update `package.json:23` `"check": "npm run typecheck && npm run lint && npm run test"`.
- Remove `bun-types` from `devDependencies`.
- Delete `bun.lock`.
- Document in `SETUP.md` that Node 20+ is the only prerequisite.

**If bun is chosen (alternative):**
- Update `SETUP.md` to document bun as a prerequisite.
- Delete `package-lock.json`.
- Migrate all `npm install` / `npm run` references in `SETUP.md` to `bun install` / `bun run`.

**Dependencies:** none

**Acceptance criteria:**
- Only one lockfile exists in the repo root.
- `SETUP.md` documents exactly one PM.
- `npm install && npm test && npm run check` all work end-to-end on a fresh clone.
- CI (T-1.5) runs against the chosen PM.

**Rollback strategy:** restore the deleted lockfile and revert `package.json` scripts.

**Risk IDs closed:** R-MED-10, R-LOW-7

---

## T-1.3 — Fix `npm run setup` for SQLite local dev

**Objective:** Make `npm run setup` work for both SQLite local dev and Postgres prod, or remove the ambiguous script.

**Files / modules affected:**
- `package.json:14` — `setup` script

**Recommended fix:** Remove the `setup` script entirely. Document `setup:local` as the only command for local SQLite. Document `prisma db push` (with `DATABASE_URL` set to Postgres) as the production command. The audit found that `setup:local` already does the right thing; the bare `setup` is only valid for Postgres and breaks for the default SQLite path.

**Alternative:** Make `setup` auto-detect the URL protocol (like `postinstall.mjs` already does) and dispatch to `setup:local` for SQLite or `prisma db push` for Postgres.

**Dependencies:** none

**Acceptance criteria:**
- `npm run setup` (or `npm run setup:local` if the script is removed) works on a fresh clone with `DATABASE_URL=file:...`.
- `SETUP.md` is updated to match.
- The bare `setup` script does not throw `Provider sqlite does not match datasource provider postgresql`.

**Rollback strategy:** restore the original `setup` script.

**Risk IDs closed:** R-MED-8

---

## T-1.4 — Re-enable ESLint rules

**Objective:** Make `npm run lint` actually catch issues. Today it reports ~0 errors regardless of code quality.

**Files / modules affected:**
- `eslint.config.mjs:10-45` — turn rules back on at `warn` level

**Rules to re-enable (at `warn` level for the first pass; tighten to `error` after the first sprint):**

```js
"@typescript-eslint/no-explicit-any": "warn",
"@typescript-eslint/no-unused-vars": ["warn", { "argsIgnorePattern": "^_" }],
"@typescript-eslint/no-non-null-assertion": "warn",
"react-hooks/exhaustive-deps": "warn",
"no-console": ["warn", { "allow": ["warn", "error", "info"] }],
"no-debugger": "warn",
"no-unreachable": "warn",
"prefer-const": "warn",
```

Leave these off (intentional for this project):
- `@next/next/no-img-element` — the app uses `<img>` deliberately for streamed media URLs.
- `react-compiler/react-compiler` — opt-in feature, not stable enough yet.

**Dependencies:** none

**Acceptance criteria:**
- `npm run lint` reports the existing `any` types and unused vars (count > 0).
- The first run produces a baseline count; track in a comment at the top of `eslint.config.mjs`.
- No new lint errors introduced by this task (only `warn` level).

**Rollback strategy:** revert `eslint.config.mjs` to the all-off state.

**Risk IDs closed:** R-MED-11

---

## T-1.5 — Add CI

**Objective:** Run `typecheck`, `lint`, and `test` on every commit and PR.

**Files / modules affected:**
- `.github/workflows/ci.yml` — new file (creates `.github/workflows/` directory)

**Workflow:**

```yaml
name: CI
on:
  push:
    branches: [main, stage-*]
  pull_request:
    branches: [main]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm run typecheck
      - run: npm run lint
      - run: npm run test
      - run: npx prisma migrate status
        env:
          DATABASE_URL: file:./db/ci.db
```

**Notes:**
- `npm ci` requires `package-lock.json` to be the lockfile of record (T-1.2).
- The workflow runs against SQLite (no Postgres service needed).
- `prisma migrate status` will fail until T-1.7 creates the first migration; mark it `continue-on-error: true` for the first sprint.

**Dependencies:** T-1.2 (PM chosen), T-1.4 (lint rules re-enabled)

**Acceptance criteria:**
- A commit that breaks `typecheck` or `lint` fails CI.
- A commit that breaks `test` fails CI.
- The workflow file is valid YAML and runs on push to `main` and to `stage-*` branches.

**Rollback strategy:** delete `.github/workflows/ci.yml`. CI runs are independent of the build.

**Risk IDs closed:** R-HIGH-11

---

## T-1.6 — Add security headers

**Objective:** Set the standard security headers via `next.config.ts` `headers()`.

**Files / modules affected:**
- `next.config.ts` — add a `headers()` async function returning the standard set

**Headers to set:**

```ts
const securityHeaders = [
  { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; connect-src 'self' https:; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self';" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
];
```

**Notes:**
- The CSP is permissive on `script-src` (`'unsafe-inline' 'unsafe-eval'`) because Next.js 16 needs it for inline scripts; tighten in Stage 4a with nonces.
- `img-src` and `media-src` allow `https:` because of provider-hosted media URLs.
- HSTS is included; assume the edge (Vercel or Cloudflare) also enforces it.

**Dependencies:** none

**Acceptance criteria:**
- `curl -I http://localhost:3000/` returns all 8 headers.
- The studio still works (no CSP breakages; if any, add the specific origin to the relevant directive with a comment explaining why).

**Rollback strategy:** remove the `headers()` function from `next.config.ts`.

**Risk IDs closed:** R-MED-12

---

## T-1.7 — Adopt `prisma migrate`

**Objective:** Create a `prisma/migrations/` directory and the first migration from the current schema.

**Files / modules affected:**
- `prisma/migrations/` — new directory (created by `prisma migrate dev`)
- `prisma/schema.prisma` — unchanged (the migration is generated FROM this file)
- `package.json` — confirm `db:migrate` script is correct
- `SETUP.md` — document `prisma migrate dev` for local changes and `prisma migrate deploy` for prod

**Steps:**

1. Run `npx prisma migrate dev --name init --schema prisma/schema.prisma` against a fresh Postgres database (e.g. a local Docker Postgres or a free Neon dev instance). This generates `prisma/migrations/<timestamp>_init/migration.sql`.
2. Commit the migration directory.
3. Document in `SETUP.md` that future schema changes go through `prisma migrate dev --name <change>` and prod uses `prisma migrate deploy`.
4. Remove the dual `schema.sqlite.prisma` mirror in favor of a dockerized Postgres for local dev, OR document the SQLite mirror as test-only and not subject to migrations.

**Note on the SQLite mirror:** if the team wants to keep SQLite for fast local dev, the SQLite path continues to use `prisma db push --schema prisma/schema.sqlite.prisma` (no migration history for SQLite; acceptable for local dev where data loss is fine). The Postgres path uses migrations. The `VoiceProfile` comment drift (R-LOW-1) is fixed in T-1.16.

**Dependencies:** T-1.5 (CI will run `prisma migrate status`)

**Acceptance criteria:**
- `prisma/migrations/` directory exists with at least one migration.
- `npx prisma migrate status` reports "Database schema is up to date" against a fresh Postgres DB after `npx prisma migrate deploy`.
- `SETUP.md` documents both `prisma migrate dev` (local) and `prisma migrate deploy` (prod).
- CI `prisma migrate status` step passes (against a SQLite DB; SQLite doesn't support migrations, so this step should be `continue-on-error: true` for now or skipped for SQLite).

**Rollback strategy:** delete `prisma/migrations/`. The schema files are unchanged.

**Risk IDs closed:** R-HIGH-10

---

## T-1.8 — Eliminate first-come setup race

**Objective:** Require a `TUBEFORGE_OWNER_TOKEN` env var so the first `POST /api/auth/setup` call must present it. Eliminates the race where a fresh install can be claimed by the first caller.

**Files / modules affected:**
- `src/app/api/auth/setup/route.ts` — add a token check at the top
- `SETUP.md` — document the new env var
- `SECURITY.md` — document the new env var

**Implementation:**

```ts
// src/app/api/auth/setup/route.ts
import { getAuthSecret } from "@/lib/tubeforge/auth-token";

export async function POST(req: Request) {
  const secret = getAuthSecret();
  if (!secret) {
    return Response.json({ error: "TUBEFORGE_AUTH_SECRET is missing from .env" }, { status: 500 });
  }

  // NEW: require the owner token for the first-come claim
  const ownerToken = process.env.TUBEFORGE_OWNER_TOKEN;
  if (ownerToken) {
    const provided = req.headers.get("x-owner-token");
    if (provided !== ownerToken) {
      return Response.json({ error: "Owner token required for first-time setup" }, { status: 403 });
    }
  }

  // ... existing setup logic
}
```

**Notes:**
- If `TUBEFORGE_OWNER_TOKEN` is not set, the route behaves as before (first-come claim). This preserves the dev sandbox behavior.
- For production deploys, `TUBEFORGE_OWNER_TOKEN` is set once; the owner presents it via the setup UI's "Owner token" field; the UI sends it as `x-owner-token` header.
- Stage 2 replaces the whole flow with `POST /api/auth/register` + email verification.

**Dependencies:** none

**Acceptance criteria:**
- `POST /api/auth/setup` with no `TUBEFORGE_OWNER_TOKEN` env behaves as before (dev mode).
- `POST /api/auth/setup` with `TUBEFORGE_OWNER_TOKEN` set: missing/wrong `x-owner-token` header → 403.
- `POST /api/auth/setup` with correct `x-owner-token` header → setup proceeds as before.
- `SETUP.md` and `SECURITY.md` document the new env var.

**Rollback strategy:** remove the token check from `setup/route.ts`.

**Risk IDs closed:** R-CRIT-3

---

## T-1.9 — Wire `runScriptJob` into `POST /api/videos`

**Objective:** Stop blocking the HTTP request through a multi-minute LLM call. Use the existing `runScriptJob` worker body (currently dead code) via `startJob`.

**Files / modules affected:**
- `src/app/api/videos/route.ts:247,298` — replace the synchronous `generateSceneScriptPackage` / `generateScriptPackage` calls with `startJob(video.id, "script", () => runScriptJob(video.id))`
- `src/lib/tubeforge/script-job.ts` — confirm `runScriptJob` works as the worker body; update if needed
- `src/lib/tubeforge/poll.ts` — confirm `pollScript` polls the new job correctly (it already does — `batch/route.ts:156` uses the same pattern)

**Implementation pattern (mirror `batch/route.ts:156`):**

```ts
// src/app/api/videos/route.ts POST handler
// ... create the Video row ...

if (format === "story") {
  await startJob(video.id, "script", () => runScriptJob(video.id));
} else {
  await startJob(video.id, "script", () => runScriptJob(video.id)); // runScriptJob handles classic format too
}

return Response.json({ id: video.id, status: "scripting" }, { status: 202 });
```

**Note:** the route must return 202 immediately, not wait for the script to finish. The client polls `GET /api/videos/[id]` (or `GET /api/jobs?entityId=<id>&kind=script`) for progress.

**Dependencies:** none (this is a code change, no DB migration)

**Acceptance criteria:**
- `POST /api/videos` returns 202 within 1 second (not 30+ seconds).
- The script job appears in `GET /api/jobs?entityId=<id>&kind=script` with `status: "running"`.
- The client polling loop (`pollScript`) succeeds and the Video row gets `scripted` status when done.
- The custom-script path (`route.ts:212-244`) still skips AI and writes the script directly.

**Rollback strategy:** revert `route.ts` to the synchronous call. `runScriptJob` stays as dead code (as today).

**Risk IDs closed:** R-HIGH-1, R-LOW-4

---

## T-1.10 — Job the synchronous research/greenlight/bible routes

**Objective:** Same as T-1.9, for the other three synchronous-in-request LLM routes.

**Files / modules affected:**
- `src/app/api/research/route.ts:38` — wrap `generateTopicResearch` in `startJob(session.id, "research", …)`
- `src/app/api/research/[id]/greenlight/route.ts:127,141` — wrap `generateSceneScriptPackage` / `generateScriptPackage` in `startJob(video.id, "script", () => runScriptJob(video.id))`
- `src/app/api/characters/bible/route.ts:13` — wrap the LLM call in `startJob(characterId, "bible", …)`

**Notes:**
- These routes need a new `Job.kind` value for research and bible. Add `"research"` and `"bible"` to the `KINDS` whitelist in `src/lib/tubeforge/jobs.ts` and `src/app/api/jobs/cancel/route.ts:27`.
- The research route creates a `ResearchSession` row first, then starts the job; the job body calls `generateTopicResearch` and updates the session row.
- The greenlight route creates a `Video` row first, then starts a script job (same as T-1.9).
- The bible route is per-character; the job body updates the `Character` row.

**Dependencies:** T-1.9 (same pattern)

**Acceptance criteria:**
- All three routes return 202 within 1 second.
- The corresponding jobs appear in `GET /api/jobs`.
- The client UI (research view, greenlight flow, character bible dialog) polls and reflects the running state.

**Rollback strategy:** revert each route to the synchronous call.

**Risk IDs closed:** R-HIGH-2, R-HIGH-3, R-HIGH-4

---

## T-1.11 — Add `zod` to the highest-risk mutating routes

**Objective:** Replace hand-rolled validation with `zod` schemas on the four routes with the thinnest validation.

**Files / modules affected:**
- `src/app/api/channels/[id]/route.ts` (PATCH) — add `zod` schema for name/niche/description with length caps
- `src/app/api/characters/[id]/route.ts` (PATCH) — add `zod` schema for role/personality/appearance with length caps matching the POST path
- `src/app/api/schedule/[id]/route.ts` (PATCH) — add `zod` schema for title (length cap), timeOfDay (regex), slotDate (parseDay)
- `src/app/api/videos/[id]/route.ts` (PATCH) — add `zod` schema for title (≤120), description (≤5000), tags (≤500), status (enum)

**Pattern:**

```ts
import { z } from "zod";

const PatchChannelSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  niche: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(500).optional(),
  isActive: z.boolean().optional(),
});

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const body = await req.json().catch(() => ({}));
  const parsed = PatchChannelSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  // ... use parsed.data
}
```

**Note:** `zod` is already in `package.json:92` (`"zod": "^4.0.2"`) — no install needed.

**Dependencies:** none

**Acceptance criteria:**
- All four PATCH routes return 400 with a `zod` error shape for invalid input.
- All four PATCH routes accept the same valid input as before (no behavior change for valid input).
- The existing tests (if any) still pass.

**Rollback strategy:** revert each route to the hand-rolled validation.

**Risk IDs closed:** R-HIGH-28 (partial; Stage 2 finishes the rest)

---

## T-1.12 — Validate `params.n` as positive integer

**Objective:** Stop accepting `NaN` for `params.n` in the storyboard / slides / stock routes.

**Files / modules affected:**
- `src/app/api/videos/[id]/storyboard/[n]/route.ts` — `z.coerce.number().int().positive()` for `n`
- `src/app/api/videos/[id]/slides/[n]/route.ts` — same
- `src/app/api/videos/[id]/stock/[n]/route.ts` — same

**Implementation:**

```ts
import { z } from "zod";

const ParamsSchema = z.object({
  id: z.string().min(1),
  n: z.coerce.number().int().positive(),
});

export async function GET(req: Request, { params }: { params: { id: string; n: string } }) {
  const parsed = ParamsSchema.safeParse(params);
  if (!parsed.success) {
    return Response.json({ error: "Invalid scene index" }, { status: 400 });
  }
  const { id, n } = parsed.data;
  // ... existing logic
}
```

**Dependencies:** none

**Acceptance criteria:**
- `GET /api/videos/abc/storyboard/0` returns 400 (was: returned 404 or wrong file).
- `GET /api/videos/abc/storyboard/1` returns 200 with the scene image (unchanged behavior for valid input).
- `GET /api/videos/abc/storyboard/NaN` returns 400 (was: tried to read `scene-NaN.png`).

**Rollback strategy:** revert to `Number(n)`.

**Risk IDs closed:** R-MED-15

---

## T-1.13 — Fix `DELETE /api/videos/[id]` orphan gap

**Objective:** Clean up `uploads/<id>/` on video delete.

**Files / modules affected:**
- `src/app/api/videos/[id]/route.ts:207` (DELETE handler) — add `rmSync` recursive after the Prisma delete

**Implementation:**

```ts
import { rmSync } from "node:fs";
import path from "node:path";
import { UPLOAD_ROOT } from "@/lib/tubeforge/ai";

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const video = await db.video.findUnique({ where: { id: params.id } });
  if (!video) return Response.json({ error: "Not found" }, { status: 404 });

  await db.video.delete({ where: { id: params.id } });

  // NEW: clean up the upload directory
  try {
    rmSync(path.join(UPLOAD_ROOT, params.id), { recursive: true, force: true });
  } catch {
    // best-effort; log the error
  }

  return Response.json({ ok: true });
}
```

**Notes:**
- Use `force: true` so it doesn't throw if the directory doesn't exist.
- Stage 3 replaces this with `storage.delete(videoId)`.

**Dependencies:** none

**Acceptance criteria:**
- After `DELETE /api/videos/abc`, `uploads/abc/` does not exist on disk.
- The Prisma row is gone (unchanged behavior).
- Deleting a non-existent video still returns 404 (unchanged behavior).

**Rollback strategy:** remove the `rmSync` call.

**Risk IDs closed:** R-MED-1

---

## T-1.14 — Move `GET /api/music` side-effect to a `POST`

**Objective:** Stop having a GET route that seeds the music library as a side effect.

**Files / modules affected:**
- `src/app/api/music/route.ts` — `GET` returns the library only (no seeding). Add a new `POST /api/music/seed` route that does the seeding.
- `src/components/tubeforge/views/library-view.tsx` (or wherever the music panel is) — call `POST /api/music/seed` on first load if the library is empty.

**Implementation:**

```ts
// src/app/api/music/route.ts
export async function GET() {
  const tracks = await db.musicTrack.findMany({ where: { isActive: true } });
  return Response.json({ tracks, needsSeed: tracks.length === 0 });
}

// src/app/api/music/seed/route.ts (new file)
export async function POST() {
  // ... existing seedMusicLibrary logic ...
  return Response.json({ ok: true, seeded: count });
}
```

**Notes:**
- The UI checks `needsSeed` from the GET response; if true, prompts the user (or auto-calls `POST /api/music/seed`).
- This preserves the first-run UX without the side-effecting GET.

**Dependencies:** none

**Acceptance criteria:**
- `GET /api/music` returns 200 with the track list (or empty list) and does NOT write to disk.
- `POST /api/music/seed` seeds the library and returns the count.
- The UI handles the `needsSeed: true` case by calling the seed route.

**Rollback strategy:** revert to the side-effecting GET.

**Risk IDs closed:** R-MED-14

---

## T-1.15 — Set `reactStrictMode: true` and clean up drift

**Objective:** Restore the React dev-mode check and clean up minor drift.

**Files / modules affected:**
- `next.config.ts:8` — set `reactStrictMode: true`
- `tailwind.config.ts` — either delete (v4 doesn't need it) or wire via `@config` in `globals.css` and update the `content` globs to include `./src/**`
- `prisma/schema.sqlite.prisma:194-198` — sync the `VoiceProfile` comment from `schema.prisma` (cosmetic)

**Recommended:** delete `tailwind.config.ts`. Tailwind v4 uses CSS-based config via `@import "tailwindcss"` + `@theme inline` in `src/app/globals.css` (already in place per audit). The v3 config is dead drift.

**Dependencies:** none

**Acceptance criteria:**
- `reactStrictMode: true` in `next.config.ts`.
- `tailwind.config.ts` is deleted (or wired correctly if the team prefers to keep it).
- All Tailwind classes still work (no visual regression).
- `schema.sqlite.prisma` `VoiceProfile` comment matches `schema.prisma`.

**Rollback strategy:** restore `reactStrictMode: false`, restore `tailwind.config.ts`.

**Risk IDs closed:** R-LOW-1, R-LOW-2, R-LOW-5

---

## T-1.16 — Document `TUBEFORGE_AUTH_SECRET` requirement

**Objective:** Make the local-dev default explicit in `SETUP.md` and `SECURITY.md`.

**Files / modules affected:**
- `SETUP.md` — add a "Local dev (open studio)" vs. "Production (locked studio)" section
- `SECURITY.md` — clarify the opt-in model and the production fail-safe

**Content to add to `SETUP.md`:**

```md
## Studio access modes

- **Local dev (default):** the studio is OPEN. `TUBEFORGE_AUTH_SECRET` is absent from `.env`. No login required. Suitable for localhost development only.
- **Production (locked):** the studio is LOCKED. `TUBEFORGE_AUTH_SECRET` is set in `.env` (32+ hex chars). `TUBEFORGE_REQUIRE_LOCK=1` is set. The first-time setup requires `TUBEFORGE_OWNER_TOKEN` to claim the owner password. Every `/api/*` request requires a signed session cookie or Bearer token.
```

**Dependencies:** T-1.8 (the owner token doc)

**Acceptance criteria:**
- `SETUP.md` has a "Studio access modes" section.
- `SECURITY.md` references `TUBEFORGE_OWNER_TOKEN`.
- A new dev reading `SETUP.md` understands the difference between local dev and production without reading the source.

**Rollback strategy:** revert the docs.

**Risk IDs closed:** R-LOW-3

---

## T-1.17 — Wire Playwright E2E tests or remove the dependency

**Objective:** Either wire Playwright (installed at `1.57.0`) into a real `e2e/` directory, or remove it from `package.json` to reduce dead dependencies.

**Files / modules affected (if wiring):**
- `playwright.config.ts` — new file
- `e2e/` directory — new directory
- `e2e/smoke.spec.ts` — one smoke test (visit `/`, take a screenshot, assert the sidebar renders)
- `.github/workflows/ci.yml` — add a Playwright job
- `package.json` — add `"test:e2e": "playwright test"` script

**Files / modules affected (if removing):**
- `package.json:74` — remove `"playwright": "1.57.0"`
- `package-lock.json` (or `bun.lock`) — update

**Recommended:** wire it. E2E tests will be valuable in Stage 7 (cross-tenant isolation, mobile responsiveness, concurrent user workloads). One smoke test now sets up the harness.

**Dependencies:** T-1.5 (CI)

**Acceptance criteria (if wiring):**
- `npx playwright test` runs the smoke test and passes.
- `playwright.config.ts` sets the baseURL to `http://localhost:3000` and starts the dev server before tests.
- CI runs `npm run test:e2e` on PRs to `main`.

**Acceptance criteria (if removing):**
- `npm install` no longer installs Playwright.
- `package.json` is one line shorter.

**Rollback strategy:** restore `playwright: 1.57.0` to dependencies.

**Risk IDs closed:** R-LOW-6

---

## T-1.18 — Document the architecture in-repo

**Objective:** Place the audit deliverables in the TubeForge repo root so they live with the code.

**Files / modules affected:**
- `/home/z/my-project/MASTER_PLAN.md` — copy from `download/tubeforge-stage1/`
- `/home/z/my-project/ARCHITECTURE.md` — copy from `download/tubeforge-stage1/`
- `/home/z/my-project/ROADMAP.md` — copy from `download/tubeforge-stage1/`
- `/home/z/my-project/TASKS.md` — this file
- `/home/z/my-project/RISK_REGISTER.md` — copy from `download/tubeforge-stage1/`
- `/home/z/my-project/FOUNDATION_AUDIT.md` — copy from `download/tubeforge-stage1/`
- `/home/z/my-project/SECURITY.md` — append the audit findings section (T-1.19)

**Notes:**
- The existing `SECURITY.md` is accurate and stays as-is.
- The existing `SETUP.md` is updated by T-1.16.
- The existing `worklog.md` is the dev log; not modified.

**Dependencies:** all other T-1.x tasks complete

**Acceptance criteria:**
- All 6 docs exist in the repo root.
- A new dev can clone the repo and read `MASTER_PLAN.md` → `ARCHITECTURE.md` → `ROADMAP.md` → `TASKS.md` → `RISK_REGISTER.md` → `FOUNDATION_AUDIT.md` and understand the project state.

**Rollback strategy:** delete the copied docs from the repo root. The `download/` copies remain as the user-facing deliverable.

**Risk IDs closed:** none (this is documentation, not a fix)

---

## T-1.19 — Update `SECURITY.md` with the audit findings section

**Objective:** Append a new section to `SECURITY.md` summarizing the audit's security-relevant findings and pointing to `RISK_REGISTER.md` and `FOUNDATION_AUDIT.md` for full detail.

**Files / modules affected:**
- `/home/z/my-project/SECURITY.md` — append a new section "## 2026-11 Foundation Audit findings"

**Content to append:**

```md
## 2026-11 Foundation Audit findings

A full security audit was run as part of Stage 1 of the product development plan. Findings:

- **1 CRITICAL:** first-come race on `POST /api/auth/setup` (mitigated in this stage by the new `TUBEFORGE_OWNER_TOKEN` env var — see §"Daily-use security checklist" above).
- **3 CRITICAL multi-tenant blockers:** no `userId`/`tenantId` on any Prisma model; `Setting` table is singleton per key; one YouTube OAuth grant per install. These are addressed in Stage 2 (multi-user SaaS architecture).
- **28 HIGH findings:** synchronous heavy work in-request, dead scaffolding for the YouTube publish stage, missing timeout/retry on YouTube fetch calls, zero `zod` use across 110 endpoints, no `prisma/migrations/` directory, no CI. Most are addressed in Stage 1; the rest in Stage 3.
- **15 MEDIUM findings:** orphan cleanup gap, in-memory security state (login lockouts, rate limits), memory-bound media streaming, missing security headers, build/packaging inconsistencies, cross-platform compatibility, side-effecting GET, path parameter validation.
- **7 LOW findings:** cosmetic drift, missing docs, dead config.

Full detail: `FOUNDATION_AUDIT.md` (audit report) and `RISK_REGISTER.md` (prioritized risks with stages to fix).

The next major security milestone is Stage 2: cross-tenant isolation tests in CI from Stage 2 onward (not as a Stage 7 QA item).
```

**Dependencies:** T-1.18

**Acceptance criteria:**
- `SECURITY.md` has the new section.
- The existing sections (What this pass locked down, Daily-use security checklist, Backups) are unchanged.

**Rollback strategy:** remove the appended section.

**Risk IDs closed:** none (this is documentation, not a fix)

---

## Stage 1 completion checklist

After all 19 tasks are done, verify:

- [ ] `npm install && npm run setup:local && npm run dev` works on a fresh clone (T-1.3).
- [ ] `npm test` runs (T-1.2).
- [ ] `npm run lint` reports real issues (T-1.4).
- [ ] `npm run typecheck` passes (always has; no change).
- [ ] CI runs all three on every commit (T-1.5).
- [ ] `prisma migrate dev` produces a real migration (T-1.7).
- [ ] `next.config.ts` sets security headers (T-1.6).
- [ ] `POST /api/auth/setup` requires `TUBEFORGE_OWNER_TOKEN` (T-1.8).
- [ ] `POST /api/videos` enqueues a script job (T-1.9).
- [ ] `POST /api/research`, `POST /api/research/[id]/greenlight`, `POST /api/characters/bible` all enqueue jobs (T-1.10).
- [ ] The 4 thinnest PATCH routes use `zod` (T-1.11).
- [ ] `params.n` is validated as positive integer (T-1.12).
- [ ] `DELETE /api/videos/[id]` cleans up `uploads/<id>/` (T-1.13).
- [ ] `GET /api/music` does not side-effect; `POST /api/music/seed` does (T-1.14).
- [ ] `reactStrictMode: true`; `tailwind.config.ts` deleted or wired; `VoiceProfile` comment synced (T-1.15).
- [ ] `SETUP.md` documents studio access modes (T-1.16).
- [ ] Playwright wired or removed (T-1.17).
- [ ] All 6 docs exist in the repo root (T-1.18).
- [ ] `SECURITY.md` has the audit findings section (T-1.19).

**Risks closed by Stage 1 (25 of 55):**

R-CRIT-3, R-HIGH-1, R-HIGH-2, R-HIGH-3, R-HIGH-4, R-HIGH-9 (partial), R-HIGH-10, R-HIGH-11, R-HIGH-14, R-HIGH-28 (partial), R-MED-1, R-MED-8, R-MED-9, R-MED-10, R-MED-11, R-MED-12, R-MED-14, R-MED-15, R-LOW-1, R-LOW-2, R-LOW-3, R-LOW-4, R-LOW-5, R-LOW-6, R-LOW-7.

**Remaining after Stage 1 (30 of 55):**

R-CRIT-1, R-CRIT-2 (Stage 2), R-HIGH-5, R-HIGH-6, R-HIGH-7, R-HIGH-8, R-HIGH-9 (rest), R-HIGH-12, R-HIGH-13, R-HIGH-15, R-HIGH-16, R-HIGH-17, R-HIGH-18, R-HIGH-19, R-HIGH-20, R-HIGH-21, R-HIGH-22, R-HIGH-23, R-HIGH-24, R-HIGH-25, R-HIGH-26, R-HIGH-27, R-HIGH-28 (rest) (Stages 2-3), R-MED-2, R-MED-3, R-MED-4, R-MED-5, R-MED-6, R-MED-7, R-MED-13 (Stages 2-3), R-X-1, R-X-2, R-X-3, R-X-4, R-X-5 (cross-cutting; Stages 3, 5, 7).

Stage 2 starts immediately after Stage 1 completion.
