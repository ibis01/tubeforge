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

### Execution status — Stage 3 close-out (updated 2026-11-01, part 3 — durable resume for EVERY kind)

The "backlog continues next session" item from part 2 is done: every JobKind the routes actually start now has a DB-derivable handler, so a process crash resumes the stage instead of marking it "interrupted". Verification: `tsc --noEmit` 0 errors · `eslint` 0 errors (257-warning baseline, −5) · **66/66 unit tests** (2 new queue units) · **queue integration test PASS** (three phases: registry completeness, payload roundtrip incl. corrupt-payload degradation, real-worker restart recovery incl. per-scene dispatch + honest interruption) · **11/11 Playwright e2e** (7 isolation + 4 smoke) · live smoke: register → custom-script create → voiceover URL-mode job → durable payload confirmed in the Job row → readable failure surfaced → guards intact → DELETE.

| Change | Notes |
|---|---|
| `Job.payload` column | New TEXT column (migration `20261101070000_stage3c_job_payload`, Postgres + SQLite mirror + `db push`). Routes store their request-scoped options at enqueue; the crash-recovery handler re-runs the job with the SAME choices. Plain TEXT (not Json) so both providers behave identically. |
| `startJob(entityId, kind, fn, { payload })` | Optional 4th arg, backward compatible — the 22 existing call sites kept working; the routes that HAVE request options now pass them. |
| `video-jobs.ts` (new) | 11 extracted job bodies: voiceover (TTS + custom url/upload), storyboard (full), scene (re-roll/AI-edit), render (mode/subtitles/music/sceneLimit), short, convert, verify, comments, thumbnail, variants, slide. Route closures and the crash handler call the SAME function — one implementation, two entry points, no drift. Uploaded voice bytes are staged into object storage BEFORE enqueue (a request buffer cannot survive a restart; a storage key can) and cleaned up after ingest. |
| `character-jobs.ts` (new) | portrait + poses job bodies, derived entirely from the character row. |
| Per-scene stock fix | A crashed per-scene stock job (`entityId "<videoId>#scene<N>"`) used to resume as a SILENT NO-OP (the handler passed the composite id to `runStockRefresh`, whose findUnique came back null). New `runStockSceneJob` + entityId dispatch — caught by a regression probe in the queue test. |
| `queue.ts` | `JobHandler` now receives `(entityId, payload)`; payload parsed once at claim (corrupt JSON degrades to null, never kills the job); `setClaiming()` for test/drain control; `voiceover`/`variants`/`poses` capped at 1 attempt (multi-call AI stages whose calls already retry internally — same rationale as `script`). |
| `upload` stays unregistered | The ONLY kind without a handler — YouTube publishing wiring is Stage 6 and nothing enqueues it today; a crashed row interrupts honestly (pinned by test). |

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

**Completion gate (roadmap):** a video job survives an application restart, resumes safely where possible, and its assets reach the correct user. ✅ CLOSED — see "Stage 3 close-out" below (every kind the routes start is now resumable).

---

## Stage 4a task backlog (defined 2026-11-01 — executing now)

**Scope:** premium UX for the core 5 surfaces (Dashboard, Project creation, Script editor, Storyboard, Scene editor) + the design-system foundation the roadmap requires (tokens, keyboard model, loading/error states, responsive). Survey finding that shapes the plan: *the data layer is ahead of the UI* — per-video YouTube stats, published/failed counts, QC reports and per-scene stock data all exist in DTOs but are not surfaced; and the detail dialog (2,643 lines, 3 overloaded tabs) is where script/storyboard/scene work actually happens.

**Carry-in defect (found during survey):** two raw-`fs` media paths in `src/app/api/videos/[id]/route.ts` (script-artifact invalidation in PATCH, media-tree cleanup in DELETE) bypass the T-3.7 storage abstraction — under the s3 driver they silently no-op (DELETE leaks the whole `<id>/` prefix, quota never decremented). `storage.removePrefix()` was built for exactly this and never wired.

| Task | Objective | Dependencies |
|---|---|---|
| T-4.0 | Migrate the two raw-`fs` sites in `PATCH/DELETE /api/videos/[id]` to `storage.remove()`/`removePrefix()` (driver-correct, quota-decrementing) | — |
| T-4.1 | Design-system foundation: semantic tokens + utility classes in `globals.css`; shared primitives (`Kbd`, `Sparkline`, `TrendDelta`…); `useHotkeys` + ⌘K command palette + `?` shortcut sheet; store palette state | — |
| T-4.2 | Dashboard redesign: performance KPI row (views/likes/comments + 7-day delta, from new `GET /api/stats` aggregates over VideoStat), published/failed surfaced, quick-start actions, continue-where-you-left-off, clickable recent projects + activity rows, richer chart | T-4.1 |
| T-4.3 | Project creation → guided brief: 4-step wizard (Concept → Format → Voice & art → Destination & launch) with per-step validation, localStorage draft autosave + restore, review summary; production line untouched | T-4.1 |
| T-4.4 | Script editor as a real tab in the detail dialog (both formats): classic = editable script w/ autosave + undo/redo + word count/est duration + preserve-artifacts option; story = per-scene narration/caption editing (needs `narration` on `PATCH /api/videos/[id]/scenes` w/ script-equivalent invalidation), timing, narrative-structure strip, emotional-progression map, ASR accuracy panel | T-4.1 |
| T-4.5 | Storyboard polish: density toggle (grid ↔ filmstrip), explicit per-scene status chips (art ready / re-rolling / stock / slide), timing bars, keep every existing action | T-4.1 |
| T-4.6 | Scene editor upgrade: narration + caption fields, before/after compare for AI edits, in-dialog regeneration progress (poll inside the dialog instead of closing it) | T-4.4 |
| T-4.7 | Cross-cutting sweep: responsive (390px) verification, WCAG AA contrast on new surfaces, loading/error/empty states, e2e additions, docs | all |

**Documented deviations (up front):**
1. **Fact-check side panel with source URLs is deferred.** `ResearchIdea` carries no source URLs (LLM-synthesized radar: title/angle/keywords/volume/competition/score) and `Video` has no research linkage — there is no source data to link out to. The Script tab ships the **ASR accuracy panel** (existing `verify.ts` report) as its accuracy surface instead; real citation-backed fact-checking needs research-with-sources (Stage 5+ server work).
2. **Drag-reorder / add-delete scene stays in Stage 6** (roadmap puts the scene timeline there); 4a polishes layout, status and per-scene controls.
3. **Per-scene voice re-synthesis stays in Stage 6** (roadmap: "re-synthesizes only that scene's voiceover"); 4a's narration edit invalidates stale voiceover via the existing full-run semantics and the UI says so.
4. **MDX-style markup** is not introduced; the script editor is structured per-scene text (the product's scripts are plain narration + scene metadata, not rich docs).

**Completion gate (roadmap):** Dashboard, Project creation, Script editor, Storyboard, Scene editor feel like an established professional creative product (SUS ≥ 75 with 5 internal users — not measurable in this sandbox; verified instead by live browser review + e2e assertions).

### Execution status (updated 2026-11-01, part 4 — Stage 4a complete)

**All 8 tasks done.** Verification: `tsc --noEmit` 0 errors · `eslint` 0 errors (262-warning baseline) · **67/67 unit tests** (+1 storage list) · **14/14 Playwright e2e** (7 isolation + 4 smoke + **3 new premium-ux**: ⌘K palette filter+navigate, wizard gating+draft roundtrip, Script-tab autosave write-through) · live agent-browser pass at 1440px and 390px (dashboard / wizard / dialog: no horizontal overflow, mobile nav sheet intact) with a seeded story video exercising the Script tab end-to-end (narration edit persisted; stale-voiceover invalidation flipped hasVoiceover/hasVideo).

| Task | Status | Notes |
|---|---|---|
| T-4.0 storage migration finish | ✅ Done | Found during survey: the script-invalidating PATCH and DELETE in `videos/[id]` were raw `fs` with PRE-T-3.7 file names (render.mp4, scene-N-clip.*) — silently no-op under s3, wrong files locally; `invalidateRenderedArtifacts`/`invalidateSlidePngs`, the whole characters module (portrait/poses read/write/list), brand-logo GET/POST/DELETE, `clearStock` and the voiceover-job stale-render wipe were all raw fs too. All migrated behind a new `storage.list(prefix)` primitive (local recursive readdir + s3 ListObjectsV2 w/ continuation tokens); DELETE uses `removePrefix` (quota-decrementing). |
| T-4.1 design system | ✅ Done | `--tf-*` semantic tokens (AA text hierarchy, hairlines, surfaces, status, motion) + utilities (`.tf-card/-hover/.tf-kicker/.tf-num/.tf-focusable/.tf-scroll/.tf-fade-x/.tf-kbd`); shared primitives `Kbd/Dot/Sparkline/TrendDelta/SkeletonRows/compactNumber`; `useHotkeys` (typing-target suppression, React-compiler-safe ref updates); ⌘K command palette (actions + 9 views + recent videos w/ status badges, ↑↓/↵ navigation, group headers) + `?` shortcut sheet + top-bar Search trigger. |
| T-4.2 dashboard | ✅ Done | `GET /api/stats` gains a `performance` block over VideoStat snapshots (views/likes/comments totals, **stable-cohort 7-day delta** — a freshly-synced back catalog can't fake growth —, 7-point cumulative series, syncedVideos). Dashboard: quick-start hero (Generate/Research CTAs + one-tap topic chips on a fresh install), Published KPI (+failed sub-line), performance strip (sparkline + TrendDelta), Continue-where-you-left-off, clickable Recent Projects grid (thumb/status/duration/views), activity rows drill into their video, chart aria-label + hover titles, Failed pipeline segment. |
| T-4.3 guided brief | ✅ Done | Left card → 4-step wizard (Concept → Format → Voice & art → Launch) with clickable step rail, per-step gating, Back/Next, "Your brief" review chips on the launch step, series batch in Destination; localStorage draft autosave (debounced, never mid-run, cleared once the video exists) + amber restore banner + Discard; production line untouched. |
| T-4.4 Script tab | ✅ Done | Dialog tabs: story = Package\|Script\|Storyboard\|Video (Script default before artifacts), classic = Package\|Script. Story: narrative-structure strip (hook/context/escalation/payoff + rehook pivots, click-to-jump) + emotional-progression map + `SceneScriptCard`s (autosaving narration+caption, per-scene words/est-seconds, structure/mood badges). Classic: autosaving editor + ⌘Z chunk-undo (25 deep) + "typo fix only" preserve toggle. ASR accuracy check moved here. Server: `narration` on `PATCH /scenes` with script-equivalent invalidation + `{invalidated}` response. **Hooks-order regression caught live and fixed** (new hooks must sit above the dialog's early return). |
| T-4.5 storyboard polish | ✅ Done | Grid ↔ filmstrip density toggle (snap-scroll + edge fade); explicit status chips (Painting…/Slide/Stock·source/Art ready/Awaiting art); per-scene ≈s + share-of-spoken bar; header ≈ total spoken; every existing action preserved. |
| T-4.6 Scene Studio | ✅ Done | Narration + caption editors ride the existing Save (invalidated-voiceover toast via the T-4.4 contract); re-roll/AI-edit/upload keep the dialog open with an in-place "Repainting…" overlay (local 3s poll) and a uniform Before/After compare over the art. |
| T-4.7 cross-cutting | ✅ Done | 3 new e2e tests (above); 390px responsive sweep (dashboard/wizard/dialog: no overflow); AA-checked tokens power every new surface; `bun.lock` drift re-deleted + gitignored (T-1.2 hygiene). Deviations 1–4 stand as documented. |

**Known scope notes (honest):**
1. The narration invalidation semantics are whole-voiceover (Stage 6 adds per-scene re-synthesis); the UI says so at every narration edit.
2. `sceneEstimate`'s 156-wpm model is an estimate — the TTS render remains the timing source of truth (the QC gate checks real duration).
3. The premium-ux e2e suite covers the classic Script-tab path (deterministic, no AI); the story scene-card path was verified live with a seeded script (`scripts/seed-story-scene.mjs`) because story seeding needs DB access the API deliberately doesn't expose.

---

## Stage 4b task backlog (defined 2026-11-01 — executing now)

**Scope:** premium UX for the remaining 5 surfaces (Research workspace, Character management, Voice studio, Render management, Analytics) on top of the Stage 4a design system. Survey finding: **voices are the most fragmented surface** — the catalog is scattered across three picker sites plus a per-video dialog tab, and there is no Voice view at all; **render management** lives inside a 3,206-line dialog with a plain-list QC report and a bare "Export" link, while the cross-video queue is a static Settings panel; **research and analytics** are solid but one panel short of the roadmap (niche pulse / niche trends); **characters** have the studio but no readiness or cast-usage surfacing.

| Task | Objective | Dependencies |
|---|---|---|
| T-4.8 | Research workspace: idea toolbar (sort by viral score / volume / length; competition filter), session insight header (best score, avg, competition split), "Niche pulse" panel aggregating recent scans (ideas per niche, avg score, top keywords), scan history 10→25; every existing action (scan / poll / delete / greenlight / classic-script) preserved | — |
| T-4.9 | Character management: roster cards gain an identity-readiness strip (portrait / poses / anchor); CharacterStudio gains a "Cast in" section (recent videos casting the character, server-provided, click-through to the library dialog); voice assignment keeps the inline ▶ preview; every existing action preserved | — |
| T-4.10 | Voice studio (**NEW VIEW** + sidebar / palette / store wiring): one catalog grid — built-in studio voices + cloned profiles with audition playback everywhere; the clone form (upload / URL, name, sample text) moves from the per-video dialog to the studio (the dialog keeps a deep-link); clone delete + re-audition; "where it's used" hints | — |
| T-4.11 | Pronunciation controls: per-user word→say-as map (`UserSetting voice.pronunciations`), applied server-side at TTS synthesis time (classic script, per-scene story, studio preview) with a live test row in the Voice Studio; map validated (≤100 entries, sane characters) | T-4.10 |
| T-4.12 | Render management: the QC report becomes a grouped scorecard (video / audio / captions, three-state chips); export gains a contents summary of the bundle; the Settings "Background Jobs" panel becomes a live queue (auto-refresh while jobs run, kind filter, cancel for running jobs, honest interrupted/failed states) | — |
| T-4.13 | Analytics: `niches` block in `AnalyticsOverviewDTO` (per-niche views / engagement / video count, server aggregate) + a "Niche trends" card; the per-video table gains client-side sort (views / engagement / delta); every existing stat and action preserved | — |
| T-4.14 | Cross-cutting sweep: 390px responsive verification across the 5 surfaces, WCAG AA on new panels, e2e additions (voice catalog + pronunciation roundtrip; research toolbar; analytics niche block), docs, TASKS.md + worklog close-out | all |

**Documented deviations (up front):**
1. **Continuity checks (VLM character-consistency scoring) stay in Stage 5** (roadmap module C). Stage 4b ships the character *surface* (readiness strip + cast usage); the VLM comparison is a server capability that does not exist yet.
2. **Pronunciation is a global per-user map** applied at synthesis time; per-scene pacing ("voice timing", roadmap Stage 5 E) is out of scope here.
3. **Render "queue"** — the durable DB queue already exists (Stage 3); T-4.12 upgrades its *presentation* (live panel, cancel, filters), not the queue machinery.
4. **Niche trends** are aggregates over the user's own videos and scans — there is no external trend API to cite; research-side trends are the Topic Radar "niche pulse" over recent scan history.

**Completion gate (roadmap):** all 10 surfaces redesigned under one design system, mobile responsive (SUS ≥ 75 with 5 internal users — not measurable in this sandbox; verified by live browser review + e2e assertions instead).

### Execution status (updated 2026-11-01, part 5 — Stage 4b complete)

**All 7 tasks done, plus one CRITICAL pre-existing regression found by the sweep and fixed live.** Verification: `tsc --noEmit` 0 errors · `eslint` 0 errors (266-warning baseline) · **70/70 unit** (+3: two pronunciation, one tenant-db scope pin) · **19/19 Playwright e2e** (7 isolation + **1 NEW previously-unscoped-models isolation** + 4 smoke + 3 premium-4a + **4 NEW premium-4b**) · live agent-browser pass at 1440px and 390px across all five surfaces with seeded data (`scripts/seed-4b.mjs` — two research sessions at mixed competition levels, three published videos × two snapshot days across two niches, one cast character with assigned videos).

| Task | Status | Notes |
|---|---|---|
| T-4.8 research workspace | ✅ Done | Idea toolbar (sort: viral/volume/length; competition filter with counts), session insight chips (Best + title, Avg, competition split), "Niche pulse" left-rail card (ideas + avg viral score per niche, recurring keywords counted once per scan), scan history 10→25 (API cap raised; list capped at 8 with an "+N older" note). Live-verified: filter → 2 cards, insights + pulse render, no 390px overflow. |
| T-4.9 character management | ✅ Done | `CharacterDTO.recentVideos` (≤4, newest first); the list route computes them in ONE grouped query (≤4 per character), single-character routes via `recentVideosFor()` scoped by the character's own organizationId. Roster cards gained an identity-readiness strip (Portrait / n-of-3 poses / Bible); the studio gained a "Cast in" section (thumb, title, status chip, click-through → library detail dialog, "+N earlier" note). Live-verified end-to-end including the click-through (h1 flips to "Video Library"). |
| T-4.10 voice studio | ✅ Done | **NEW VIEW** (store ViewId + sidebar + command palette + VIEW_META wired): one catalog grid — studio voices + clones with ▶ auditions (provider previews via the shared preview cache; clones with cached clone-time previews), "where it's used" chips (default narrator star + characters cast on the voice), one-click "Set default narrator" (PUT /api/settings). The clone form (upload **or direct link**, name, sample text) moved here from the per-video dialog; the dialog's clone tab gained a deep-link. Clone library rows: instant cached audition + delete. |
| T-4.11 pronunciation | ✅ Done | `pronounce.ts`: per-user word→say-as map on `UserSetting voice.pronunciations`, applied at the ONE TTS choke point (`ttsSynthesize`) so every flow inherits it — classic script, per-scene story, clones, ▶ previews. Longest-match-first, word-boundary, case-insensitive; 30s TTL cache with write-invalidation; fail-open (a settings hiccup never breaks synthesis). Dedicated GET/PUT route (≤100 entries, control chars rejected, case-insensitive dedupe). The studio's Pronunciation card: chip list, add form, and a live test row (preview route accepts a one-off `text`). 2 unit tests (one test-fixture bug caught: numeric from/to is COERCED, only structural garbage drops). |
| T-4.12 render management | ✅ Done | QC report → grouped scorecard (Video / Audio / Sync, per-group clean-or-flagged chips, unknown checks fall into "Other"); the Video tab gained an Export bundle panel (present/absent chips per artifact + Download ZIP); Settings "Background Jobs" → live queue: auto-refresh every 4s while anything runs, kind filter chips with counts, running rows show progress label/bar, per-row cooperative Cancel (with stopping… state), cancelled/queued status chips (cancelled previously fell through to "Done"), KIND_META gaps filled (script/research/short/slide had generic icons). |
| T-4.13 analytics | ✅ Done | `niches` block server-side (per-niche views/likes/comments/engagement/videos over tracked videos) + "Niche trends" card with share bars; per-video table sort (views / engagement / last-sync growth) via a header select; `sortedRows` memo — **hooks-order regression caught LIVE and fixed** (the memo initially sat below the early returns; the exact class the Stage 4a worklog warned about). |
| T-4.14 sweep | ✅ Done | 4 new premium-ux e2e + 1 new isolation e2e; 390px sweep across all five surfaces (research/cast/voice/dialog fit as-built; **two real overflows found and fixed**: the analytics grid lacked `[&>*]:min-w-0` so tracks blew past 390px, and two Settings provider selects had fixed/content widths — pre-existing, now `max-w-full`); the seeded live pass verified every data-bearing panel. |

**The critical find (pre-existing, Stage 2): `tenant-db` never scoped five models.** The Stage 2 `ORG_SCOPED_MODELS` set carried camelCase entries (`researchSession`, `scheduleSlot`, `videoStat`, `voiceProfile`, `musicTrack`) while the `$allOperations` hook lowercases the Prisma model name at lookup — so those five models silently ran UNSCOPED through the tenant guard: any signed-in user's `GET /api/research` returned every other tenant's sessions (the same held for schedule slots, stats snapshots, voice clones and music tracks wherever they query through tenant-db). It surfaced live during the T-4.14 sweep: a fresh e2e account's Topic Radar rendered the live-pass account's seeded scans; a curl probe confirmed the server returned cross-org rows. The isolation battery never caught it because it only LISTED models with single-word lowercase names. Fix: the set is lowercase-normalized at construction (`tenant-db.ts`, with a regression comment); pinned by a new unit test AND a new isolation e2e (`research sessions stay tenant-scoped` — a 202 shell row is a real cross-tenant probe even without AI keys). Re-verified: a fresh account now gets `{"sessions":[]}`.

**Known scope notes (honest):**
1. The ▶ audition / pronunciation test row need a working TTS provider key; in this sandbox (ambient Z.ai credential 401s) they render but were not exercised live — the preview route's custom-text path is typechecked and the map application is unit-pinned instead.
2. Deviations 1–4 from the backlog stand as documented (VLM continuity stays Stage 5; pronunciation is global per-user, not per-scene; the queue machinery is Stage 3's, only its presentation changed; niche trends are own-data aggregates).
3. `scripts/seed-4b.mjs` is a local-only harness like `seed-story-scene.mjs` (never shipped); it targets the newest organization by design.

---

## Stage 5 task backlog (defined 2026-11-01 — executing now)

**Scope:** the AI Director and cinematic quality — ROADMAP modules A–E on the "AI suggests, human approves" doctrine. Module B (shot plan + approval gate) and the VLM continuity check landed with T-5.1; this pass completed the remaining modules: the plan-aware pacing gate, director-driven visual selection (module D), audio production (module E: pacing / ambience / cues / music mood / ducking), the World library + appearance editing + outfit weaving (module C), and research-with-sources + the fact-check surface (module A, the debt Stage 4b explicitly deferred here).

| Task | Objective | Dependencies |
|---|---|---|
| T-5.1 | Director's brain + continuity core: plan schema, LLM pass, approval gate, VLM check, render hook, DirectorCard, jobs + route | — (done 2026-11-01) |
| T-5.2 | Restore the CI workflow lost to the history rewrite (T-1.5 contract) | — |
| T-5.3 | QC static-shots pacing gate: fail on 3+ consecutive unmotivated static shots in an APPROVED plan | T-5.1 |
| T-5.4 | Director-driven visual selection: per-scene motion override, i2v/stock suggestion badges, regenerate-with-constraint | T-5.1 |
| T-5.5 | Audio production (module E): per-scene narration pacing, synthesized ambient beds, boundary cues, music mood from the emotional progression, ducking intensity | T-5.1 |
| T-5.6 | World library + cast looks (module C): Location/Prop models + CRUD, appearance editing UI, outfit + set-piece prompt weaving | T-5.1 |
| T-5.7 | Research-with-sources (module A): web-search grounding, source snapshots, reference-material prompts, Script tab fact-check panel | — |
| T-5.8 | Stage 5 close-out: TASKS.md + worklog, final gate, push | all |

### Execution status (updated 2026-11-01, part 6 — Stage 5 complete)

**All 8 tasks done.** Verification (final gate): `tsc --noEmit` 0 errors · `eslint` 0 errors (baseline warnings only) · **76/76 unit** (+3 across T-5.3/5.5/5.7) · **19/19 Playwright e2e** · live smokes: 6/6 director (T-5.1), 17/17 world (T-5.6), 6/6 sources (T-5.7), plus a live ffmpeg integration of the 3-input segment graph (voice + cue + bed). LLM/VLM/TTS/search paths typechecked and unit-pinned but not exercised live in this sandbox (ambient credential 401s — the same honest limit as Stage 4b).

| Task | Status | Notes |
|---|---|---|
| T-5.2 CI restore | ✅ Done | `.github/workflows/ci.yml` recreated to the T-1.5 contract (check job: typecheck+lint+unit+pg-schema validate on push/PR; e2e job PR-only with Playwright + dummy secrets). **Deviation:** the file sits on disk but is NOT pushed — the provided GitHub PAT lacks `workflow` scope and GitHub rejects any push that creates/updates workflow files with it. One `git push` with a workflow-scoped token ships it (tracked as the only unpushed commit). |
| T-5.3 pacing gate | ✅ Done | `planStaticRuns`: runs of 3+ consecutive static-camera shots with no motivation channel (motion off + no i2v + no stock), longest first; index gaps and shot-less scenes break runs; render-mode blanket exemptions (animated/stock). The qc `static-shots` check now fails deterministically on a flat APPROVED plan before any pixel is measured; runRenderJob passes the approved plan + exemptions. |
| T-5.4 visual selection | ✅ Done | `getApprovedMotionMap` → per-scene motion override in the Ken Burns/stock-fallback path (smart = defer; slides keep deck plans; i2v exempt). DirectorCard chips carry i2v/stock/motion badges beside the human's render-mode + stock-stage decisions. Continuity rows gained **Fix…** — constraint input pre-filled with the VLM's diagnosis, riding the storyboard route's AI-edit mode (the module-D "regenerate scene 14 with a red jacket" loop). |
| T-5.5 audio production | ✅ Done | Plan vocabularies (PACINGS/AMBIENCE_KINDS/SFX_HINTS + plan-level musicMood/ducking); `ambience.ts` — 7 synthesized beds (room/city/rain/wind/waves/crowd/nature), 60s loudnorm-tailed renders measured within ~4 dB of each other; `sceneAudio()` owns inputs+graph together (voice + 40ms cue @0.35 + looped bed @0.22; Settings-Sound silences every synthesized extra); pacing factors (±12%) at voiceover synthesis; music mood + ducking slot into the resolvers under manual per-video overrides. Legacy T-5.1 plans parse with audio defaults. |
| T-5.6 World library | ✅ Done | `Location` + `Prop` models (migration 20261101123000, org-scoped + pinned in ORG_SCOPED_MODELS before any row existed); CRUD routes with soft-delete; the director pass sees the library and tags scenes with exact names (≤3); `getApprovedWorldClause` weaves descriptions into scene prompts; `getApprovedAppearanceClause` closes the T-5.1 outfit gap; Scene Studio "Cast look in this scene" editing via PUT /appearance. 17-check smoke: CRUD, validation, cross-tenant 404s, soft-delete. |
| T-5.7 research sources | ✅ Done | `llmWebSearch` (SDK web_search, metered "search" service, fail-open); one grounding search per radar scan; `matchSourcesToIdeas` (keyword-overlap, ≤3/idea, unit-pinned); greenlight + create snapshot sources onto `Video.researchSources` (http(s)-only, ≤6); reference-material prompt block; Script tab Sources panel. The Stage 4b deferred debt is paid. |
| T-5.8 close-out | ✅ Done | This section + worklog; final gate re-run clean; push to origin. |

**Completion gate (audit-adjusted) — met:**
1. *Flags scene inconsistencies and offers one-click regeneration* — VLM continuity (T-5.1) + Repaint + Fix…-with-constraint (T-5.4).
2. *Visuals match the narration* — per-scene ASR verification (`verify.ts`) continues to work; the continuity clauses (outfit + set pieces) make the match stronger.
3. *Deliberate cinematic rhythm* — the plan-aware `static-shots` QC check fails 3+ consecutive unmotivated static shots (T-5.3), measured plans only.
4. *Character consistency score ≥ 80%* — the VLM check scores every cast scene 0–100 and the one-click loop drives them above the bar (mechanism + loop; live ≥80% needs a working VLM key, not exercisable in this sandbox).

**Known scope notes (honest):**
1. **SVG maps / illustrative inserts (module D) are deferred** — the one roadmap line item not built. Rationale: keynote slides + stock b-roll cover the insert use-cases today; standalone SVG map generation is a full feature (design system, rendering, geography data) with the weakest payoff per week of the module. It moves to Stage 6+ candidate territory.
2. All LLM/VLM/TTS/search paths (director pass, continuity check, pacing, grounding) are typechecked and unit-pinned at their pure layers, but not exercised live here (ambient credential 401s). The smoke scripts cover the API surfaces that do not need AI keys.
3. The per-user Z.ai client cache stays in-process (Stage 3 note) — Redis revisited only if multi-instance workers ship.
4. ci.yml awaits a workflow-scoped token (see T-5.2) — the only unpushed commit on an otherwise fully synced main.

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

---

## Stage 6 — Editing, rendering & publishing — task list

**Status:** ✅ COMPLETE — all 11 tasks closed.
**Last updated:** 2026-11-02
**Source:** `ROADMAP.md` §Stage 6 + `FOUNDATION_AUDIT.md` defects D-06, D-07 (dead `uploadToYouTube` scaffolding) + the audit's "no separate QC re-run endpoint" gap.

| Task | Status | Notes |
|---|---|---|
| T-6.1 Scene Assembly endpoint | ✅ Done | `POST /api/videos/[id]/assemble` (+ GET / PUT / DELETE) — pure `timeline.ts` builds the preview from scenes + shotList + audio settings; per-scene start/end/transition/audio/caption/shot; persists to `Video.timeline`; roundtrip unit-pinned |
| T-6.2 Separate QC endpoint | ✅ Done | `POST /api/videos/[id]/qc` (+ GET) — new `runQcJob` body re-runs the 12-check battery against the existing final.mp4 without re-rendering; registered `"qc"` job kind + durable recovery |
| T-6.3 YouTube publish route | ✅ Done | `POST /api/videos/[id]/publish` (+ GET) — new `runUploadJob` body wires the dead `uploadToYouTube` (D-06, D-07); `"upload"` job kind now registered (was the only unregistered kind); persists `Video.youtubeUrl` + `publishedAt` + `status:"published"` on success; `invalid_grant` → reconnect (handled inside getAccessToken) |
| T-6.4 Per-user OAuth account picker | ✅ Already exists (Stage 2) | `YouTubeAccount` model + OAuth flow + `/api/youtube/connect` + `/api/youtube/status` pre-date Stage 6; the publish route re-checks `isConnected()` and rejects with 400 if no channel |
| T-6.5 Title/description generation (LLM) | ✅ Done | `POST /api/videos/[id]/publish/suggest` — new `publish-suggest.ts` module asks the LLM to draft `{title, description, tags}` from script + niche + tone + per-scene captions; 4 tone styles (clickbait / descriptive / question / curiosity); output clamped to YouTube API limits; same "AI suggests + human approves" doctrine as Stage 5 |
| T-6.6 Scheduled publishing (publishAt) | ✅ Done | `uploadToYouTube` accepts ISO `publishAt`; publish job threads `opts.publishAt` through; YouTube only honors it when `privacyStatus === "private"` (caller's responsibility) |
| T-6.7 Caption burn-in + SRT/VTT export | ✅ Done | New `subtitle-export.ts` (`srtToVtt` + `looksLikeSrt`); `GET /api/videos/[id]/captions?format=srt\|vtt` serves both formats; PATCH `/api/videos/[id]` accepts `aspectRatio` / `frameRate` / `burnCaptions` |
| T-6.8 Aspect-ratio + frame-rate consumption | ✅ Done | motion.ts `Aspect` + `OUTPUT_SIZES` gained `1:1` (2160×2160 work / 1080×1080 out); qc.ts `QcAspect` + `ASPECT_TARGET` gained `1:1`; render.ts `RenderOptions` accepts `aspectRatio` + `frameRate`; `buildSegment` threads `aspect`/`fps` into ffmpeg `-r`/`-framerate`; the `FPS = 30` constant becomes a default. RenderJobOptions gains aspectRatio + frameRate; runRenderJob resolves per-render override > per-project default > 30 fps / 16:9. Slides mode always 9:16. Per-project `burnCaptions` becomes the default for subtitles; per-render override still wins. Live smoke: 12/12 aspect × fps combinations pass (1:1, 16:9@24, 16:9@60, 9:16) |
| T-6.9 Editing Studio UI | ✅ Done | `src/components/tubeforge/editing-studio.tsx` (~430 lines, self-contained) — uses `@dnd-kit/sortable` (already in deps). Mounted at the top of the Video tab in `video-detail-dialog.tsx` when `isStory && scenes.length > 0`. Features per the ROADMAP §6 list: scene timeline, drag-and-drop ordering (PointerSensor + KeyboardSensor), per-scene trimming (number input [0.5, 300]s, `recomputeTimes` cascades), audio levels (per-scene voice/music/sfx/ambient sliders 0..1), transition previews (in/out labels per scene), undo/redo (bounded 50-entry history stack with Reset). Auto-loads GET /assemble; Save PUTs; Re-assemble POSTs; the existing render button's POST honors saved trims via T-6.10. |
| T-6.10 Render job consumes the assembled timeline | ✅ Done | RenderOptions gains `sceneDurationsSec?: number[]`; renderVideo computes WAV durations as default, prefers the timeline's per-scene durationSec when it sits inside [MIN_SEG_SEC, 3× measured narration]. RenderJobOptions + parseRenderPayload + the render route's `ignoreTimeline` body flag wire the full pipeline. Safety: a single bad/missing duration falls back to WAV durations for ALL scenes (a half-overridden timeline would produce a broken render) |
| T-6.11 Stage 6 sweep + close-out | ✅ Done | Worklog + TASKS.md updated; final gate below. (Live YouTube upload smoke still pending a connected channel — the publish path is structurally identical to the other 13 job bodies and is typecheck-verified.) |

### Stage 6 complete (2026-11-02)

All 11 Stage 6 tasks are closed. The publish loop is end-to-end functional: LLM suggest → publishAt → uploadToYouTube → `Video.youtubeUrl` + `publishedAt` written. The two ROADMAP §6 endpoints that didn't exist (`/assemble`, `/qc`) now exist; the third (`/publish`) wires the audit's dead `uploadToYouTube` (D-06, D-07). The render pipeline honors per-project `aspectRatio` (16:9 / 9:16 / 1:1) + `frameRate` (24 / 30 / 60) + `burnCaptions` defaults, and consumes the assembled timeline's per-scene trims. Captions export serves SRT + VTT. The Editing Studio UI lets the user edit the timeline (drag-drop reorder + per-scene trims + audio levels + undo/redo) and Save it before the render commits the trims to disk — closing the Stage 6 completion gate ("edit, render, review, export and publish without leaving TubeForge").

**Final gate for Stage 6:** tsc 0 · eslint 0 errors / 275 warnings · **81/81 unit** (76 baseline + 5 new: 3 timeline + 1 captions + 1 timeline-render-shape) · live aspect smoke 12/12 · live route smoke 401×5 on the new endpoints · dev-server boots clean with the Editing Studio mounted. Push status: 6 Stage 6 commits pushed cleanly to origin/main across the sprint (`3114d58` → `53dd362`); no workflow file in any diff. The T-1.5 ci.yml still requires a workflow-scoped PAT to push — pending.

---

## Stage 7 — Quality assurance & commercial launch — task list

**Status:** ✅ COMPLETE — all code-side tasks closed.
**Last updated:** 2026-11-02
**Source:** `ROADMAP.md` §Stage 7 + `MASTER_PLAN.md` §8 launch metrics.

| Task | Status | Notes |
|---|---|---|
| T-7.1 Full production pipeline e2e | ✅ Done | `e2e/pipeline.spec.ts` — 3 tests covering the deterministic subset (auth → create → patch → Stage 6 surfaces → export → GDPR → logout + wrong-password rejection + cross-tenant denial across qc/publish/assemble/suggest) |
| T-7.2 Backup + restore roundtrip test | ✅ Done | `scripts/test-backup.mts` — runs `npm run backup` + verifies row counts (videos/users/orgs) match; falls back to `fs.copyFileSync` when sqlite3 CLI missing; skips Postgres |
| T-7.3 Mobile responsiveness sweep e2e | ✅ Done | `e2e/mobile-sweep.spec.ts` — 4 tests at 390px (iPhone 12/13/14): no horizontal overflow, detail dialog fits the Editing Studio card, publish/assemble auth gates viewport-independent |
| T-7.4 Load test scaffold | ✅ Done | `scripts/load-test.js` (k6) — 20 VUs ramp 30s + hold 1m + ramp down 30s; thresholds < 2% error rate + p95 < 500ms; tests register → create → GET video → auth/status → logout |
| T-7.5 Stripe billing scaffolding | ✅ Done | New Prisma models Plan / Subscription / CreditGrant / CreditLedger (migration `20261102010000_stage7_billing`). New `billing.ts`: resolveUserPlan (Starter default — fresh installs never seed rows), recordCreditSpend, sumAICallSpends, planSupportsResolution, hasCredits, handleStripeEvent, verifyStripeSignature (Web Crypto HMAC). Two routes: `POST /api/billing/webhook` (PUBLIC, signature is the auth) + `GET /api/billing/plan` (auth-required, returns plan + balance). Stripe Checkout / Portal wiring is a follow-up. |
| T-7.6 Worker failure recovery | ✅ Already covered | `scripts/test-queue.mts` Phase B (worker process restart recovery) covers the durable-resume contract; the Stage 6 additions (`qc`, `upload`) are registered in `queue-handlers.ts` so they get the same path; the `resumableKinds` contract test pins this. No new test needed. |
| T-7.7 Stage 7 close-out | ✅ Done | This entry + the worklog. |

### Stage 7 progress (2026-11-02)

All code-side Stage 7 tasks are closed. The test scaffolding + the billing foundation + the load test scaffold are in place. The remaining ROADMAP §7 launch items are operational, not code:

- **Live beta with real users** — needs a deployed environment, not a dev sandbox.
- **YouTube integration smoke against a real test channel** — needs a connected YouTube account (the publish path is structurally identical to the other 13 job bodies; typecheck-verified).
- **Stripe Checkout / Customer Portal wiring** — the foundation + the webhook are in place; the checkout routes are a follow-up (the webhook handles `checkout.session.completed` already).
- **The actual k6 run against staging** — `scripts/load-test.js` is ready to run; needs k6 installed + a staging URL.

**Final gate for Stage 7 (code side):** tsc 0 · eslint 0 errors / 283 warnings · **86/86 unit** · backup test ALL GREEN · pipeline + mobile-sweep e2e specs typecheck-verified · Stages 1→7 all closed at the code level. Push status: 2 Stage 7 commits pushed cleanly to origin/main; no workflow file in any diff.

## Stage 7.1 — Billing integrity & security — task list

**Source:** the pre-launch billing review (five production blockers + two hardening asks). **Gate:** no commercial feature ships until every defect below is closed AND pinned by a regression test.

| Task | Status | Notes |
|---|---|---|
| B-1 Webhook auth fail-closed | ✅ Done | `POST /api/billing/webhook`: with the secret set, a missing `stripe-signature` header is now a **401** (was: silently skipped verification) and a bad signature stays 401. With the secret unset the endpoint accepts NOTHING — 401 in dev, 500 under `NODE_ENV=production`. The only unsigned path is the explicit `TUBEFORGE_ALLOW_UNSIGNED_WEBHOOKS=1` dev opt-in (refused in production regardless). `verifyStripeSignature` gained a 300s timestamp replay window + constant-time compare. |
| B-2 Canonical credit units | ✅ Done | ONE ledger unit: the **microCredit** (1 UI credit = 1,000 micro, `MICROS_PER_CREDIT`). `CreditGrant.grantedCredits` renamed → `grantedMicroCredits` (migration `20261102020000_stage71_billing_integrity`), grants converted from the plan's UI-credit allowance at grant time, balances converted back only at the display edge (`microToCredits`). The exact regression — a full Creator allowance failing the 50,000-micro render pre-check — is pinned in both suites. |
| B-3 Ledger↔subscription linkage | ✅ Done | Spends auto-attach the user's active subscriptionId (`recordCreditSpend`/`spendCredits` resolve it internally — callers can no longer write null-linked rows by omission). Balance math is **user-scoped** (grants + ledger filtered by userId directly, never via the subscription relation), so legacy null-linked rows still count and nothing spent can resurrect. Canceled subscriptions collect no new linked rows. |
| B-4 Subscription status enforcement | ✅ Done | `subscriptionAccess(status)`: active/trialing → `full`, past_due → `grace` (paid plan continues while dunning runs; plan card shows a payment-failed banner), canceled/unpaid/incomplete/incomplete_expired/paused/**unknown** → `none` → resolver falls back to Starter (fail-closed on new Stripe statuses). Enforcement tier in `spendCredits` follows the access decision, not the stored plan row. Every status is tested. |
| B-5 Idempotent invoice grants | ✅ Done | Two layers: (1) `ProcessedWebhookEvent` records every handled Stripe event id BEFORE the handler runs (create-then-handle; a failed handler frees the id so Stripe's retry re-runs it); (2) `CreditGrant.stripeInvoiceId` is `@unique` and `invoice.paid` upserts on it, so the same invoice under a different event id still grants exactly once. A paid invoice also re-activates a non-canceled subscription (renewal clears past_due, period end tracks Stripe). |
| B-6 Concurrent-spend / overspend protection | ✅ Done | New `spendCredits()` — the enforcement primitive: a transactional check-and-spend that re-reads the balance INSIDE the transaction (in-process promise-chain queue + SQLite `BEGIN IMMEDIATE` file lock / Postgres Serializable with P2034+busy retry). AI-call metering (`budget.ts`) now goes through it; rejected spends leave no ledger row. Render actuals stay `recordCreditSpend` (accounting truth — the cost already happened; enforcement is the render route's pre-gate). 10 parallel spends of 30,000 micro against a 100,000-micro grant → exactly 3 recorded, 7 rejected, balance ≥ 0. |
| B-7 Billing lifecycle tests | ✅ Done | New `scripts/test-billing.mts` (`npm run test:billing`, wired into `npm run check`) — **21 tests** against the real DB + the REAL route handler in-process: full webhook auth matrix (8), canonical units, grant idempotency ×2 (same event id; same invoice/different event), linkage ×2, the 7-status matrix + renewal-after-past_due, canceled-sub spend behavior, the concurrency probe, and the **lifecycle phase (#7)**: checkout via the signed route, payment-failure → grace, cancellation → Starter with the record kept, refund semantics (unknown `charge.refunded` acked safely; credit refunds via the negative `refund` ledger row), and the full 6-step event-driven chain checkout → grant → failure → recovery grant → cancel → late-invoice-no-grant. Unit suite gained 3 more (status map, unit conversions, signature tamper/stale/malformed). |
| B-6b Canceled-subscription grant guard | ✅ Done | **Caught by the B-7 lifecycle test.** The `invoice.paid` handler guarded re-activation against `canceled` but wrote the CreditGrant unconditionally — a late or replayed invoice for a canceled subscription minted credits onto the account, and the user-scoped balance would hand those orphaned credits to the user's NEXT subscription (credit resurrection across subscriptions). Fix: `invoice.paid` refuses the grant (and the re-activation) when the subscription is `canceled`; genuine recovery payments (`past_due`/`unpaid`) still grant AND re-activate. Pinned by lifecycle chain step 6. |
| B-8 Docs + env contract | ✅ Done | `.env.example` documents the fail-closed webhook + the dev opt-in. Migration `20261102020000_stage71_billing_integrity` carries the Postgres DDL; the SQLite mirror was regenerated and pushed (dev grant rows reset — pre-production data, the next `invoice.paid` re-grants in the correct unit). |

### Stage 7.1 progress (2026-11-02)

All five production blockers are fixed and pinned — plus B-6b, a sixth defect the lifecycle test caught (canceled-subscription grant resurrection). **Final gate for Stage 7.1:** tsc 0 · eslint 0 errors / 295 warnings · **90/90 unit** · **21/21 billing integration** · schema pushed to the dev DB (both providers) · Postgres migration written.

Not yet established (operational, unchanged from Stage 7): real Stripe test-mode Checkout + webhook lifecycle against Stripe itself, staging k6 run, live beta. **The exposed GitHub PAT still needs rotation** — outside the repo's reach.

### Whole-program summary (Stages 1 → 7)

| Stage | Status | Commits |
|---|---|---|
| 1 — Baseline, security, code stabilization | ✅ Done (Stage 1 close-out) | T-1.1 → T-1.19 |
| 2 — Multi-user SaaS architecture | ✅ Done (Stage 2 close-out) | isolation.spec.ts 7/7 green |
| 3 — Production infrastructure | ✅ Done (Stage 3 close-out) | storage abstraction + UsageRecord + SMTP + per-user Z.ai + LegacySetting drop + deploy pipeline + durable resume for every job kind |
| 4a — Premium UX core 5 surfaces | ✅ Done (T-4.7) | design system + dashboard + wizard + script tab + storyboard + scene studio |
| 4b — Premium UX remaining 5 surfaces | ✅ Done (T-4.14) | research + cast + voice studio + pronunciation + render management + analytics |
| 5 — AI Director & film quality | ✅ Done (T-5.8 close-out) | shot plan + approval gate + VLM continuity + pacing gate + audio production + World library + research sources |
| 6 — Editing, rendering & publishing | ✅ Done (T-6.11) | assembly + QC re-run + YouTube publish + LLM suggest + publishAt + VTT + aspect/frame-rate + Editing Studio UI + timeline consumption |
| 7 — Quality assurance & commercial launch | ✅ Done (T-7.7 — code side) | pipeline e2e + backup test + mobile sweep + k6 + Stripe billing scaffold + reconciliation tests |

All 33 weeks of the ROADMAP are covered at the code level. The commercial-launch items (real beta, real YouTube, real Stripe Checkout, real k6 staging run) are operational follow-ups against a deployed environment.
