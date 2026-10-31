# TubeForge — Risk Register

**Status:** Stage 1 audit complete; risks prioritized.
**Last updated:** 2026-11-01
**Source:** `FOUNDATION_AUDIT.md` §5 (defects D-01 through D-30)

---

## Severity definitions

| Severity | Definition | SLA |
| --- | --- | --- |
| CRITICAL | Unauthenticated write, secret leak, SSRF, data loss, or unbounded external call. Blocks launch. | Fix in current stage |
| HIGH | Missing input validation on a mutating route, path traversal, synchronous heavy work in-request, or dead scaffolding for a launch-required feature. | Fix before next stage |
| MEDIUM | Orphan cleanup gap, no zod validation on a read-only route, in-memory security state, missing timeout on a non-critical fetch. | Fix within 2 stages |
| LOW | Cosmetic drift, missing doc, dead config file. | Fix when convenient |

---

## CRITICAL risks (3)

| ID | Risk | File:line | Stage to fix | Mitigation |
| --- | --- | --- | --- | --- |
| R-CRIT-1 | **Multi-tenant data isolation does not exist.** Every Prisma model lacks `userId`/`tenantId`. Two users on the same install share the same `Video`, `Channel`, `Character`, `Setting` rows. | `prisma/schema.prisma` (entire file) | Stage 2 | Add `User`, `Organization`, `Membership`, `UserSetting`, `YouTubeAccount`, `ProviderCredential` models. Add `organizationId` to every existing model. Add `requireUser()` to every endpoint. Add automated cross-tenant isolation tests in CI. |
| R-CRIT-2 | **`Setting` table is a singleton per key.** One owner password, one YouTube OAuth grant, one set of provider keys per install. Multi-user SaaS is impossible without surgery. | `prisma/schema.prisma:184-188` | Stage 2 | Migrate `Setting` rows to per-user scoping. `auth.password` → `User.passwordHash`. `ytRefreshToken` → `YouTubeAccount`. `tts.*` / `zai.*` → `ProviderCredential` + `UserSetting`. Remove the global `Setting` table. |
| R-CRIT-3 | **First-come race on `POST /api/auth/setup`.** A fresh install can be claimed by the first caller. Mitigations exist (403s after configured; requires `TUBEFORGE_AUTH_SECRET`) but the race is not eliminated. | `src/app/api/auth/setup/route.ts:15` | Stage 1 | Add `TUBEFORGE_OWNER_TOKEN` env bootstrap so the first call must present it. Stage 2 replaces the whole flow with `POST /api/auth/register` + email verification. |

---

## HIGH risks (28)

### Synchronous heavy work in-request (5)

| ID | Risk | File:line | Stage to fix | Mitigation |
| --- | --- | --- | --- | --- |
| R-HIGH-1 | `POST /api/videos` runs full script generation synchronously in-request | `src/app/api/videos/route.ts:247,298` | Stage 1 | Wire `runScriptJob` into `startJob` (D-01, D-08). The worker body already exists. |
| R-HIGH-2 | `POST /api/research` runs LLM call synchronously | `src/app/api/research/route.ts:38` | Stage 1 | Wrap in `startJob` (kind: "research"). |
| R-HIGH-3 | `POST /api/research/[id]/greenlight` runs script generation synchronously | `src/app/api/research/[id]/greenlight/route.ts:127,141` | Stage 1 | Wrap in `startJob` (kind: "greenlight"). |
| R-HIGH-4 | `POST /api/characters/bible` runs LLM call synchronously | `src/app/api/characters/bible/route.ts:13` | Stage 1 | Wrap in `startJob` (kind: "bible"). |
| R-HIGH-5 | `POST /api/videos/batch` spawns N parallel in-process script jobs (count 2-6); unbounded concurrent AI calls if multiple batch requests land | `src/app/api/videos/batch/route.ts:82` | Stage 3 | Move to BullMQ with per-organization concurrency caps. |

### Dead scaffolding (2)

| ID | Risk | File:line | Stage to fix | Mitigation |
| --- | --- | --- | --- | --- |
| R-HIGH-6 | `uploadToYouTube` implemented but never called — publish stage is dead scaffolding | `src/lib/tubeforge/youtube.ts:292-382` | Stage 6 | Add `POST /api/videos/[id]/publish` route; enqueue a publish job; call the existing `uploadToYouTube` function. |
| R-HIGH-7 | `Video.youtubeUrl` is never written by any code path | grep confirmed | Stage 6 | Consequence of R-HIGH-6. Fixed when the publish route is added. |

### Missing timeout/retry (1 cluster)

| ID | Risk | File:line | Stage to fix | Mitigation |
| --- | --- | --- | --- | --- |
| R-HIGH-8 | YouTube fetch calls have no timeout/retry — a single Google 500 fails the upload | `src/lib/tubeforge/youtube.ts:123,166,218,314,336,362` | Stage 3 | Wrap every YouTube fetch in the existing `budget.ts#aiCall` pattern (timeout, retry, 429 cool-down). Add per-call `AbortSignal.timeout`. |

### Missing validation framework (1)

| ID | Risk | File:line | Stage to fix | Mitigation |
| --- | --- | --- | --- | --- |
| R-HIGH-9 | Zero `zod` use across 110 endpoints — hand-rolled validation has known weaknesses (no type coercion, no nested object validation, no discriminated unions, copy-pasted music/motion/transition override block) | `src/app/api/**` | Stage 1 + Stage 2 | Stage 1: add `zod` to the highest-risk mutating routes (settings, voice clone, video create). Stage 2: every endpoint has a `zod` schema. |

### Schema management (1)

| ID | Risk | File:line | Stage to fix | Mitigation |
| --- | --- | --- | --- | --- |
| R-HIGH-10 | No `prisma/migrations/` directory — schema management is `db push` only; no migration history; no data-preserving column rename/drop; no down/rollback path | `prisma/` | Stage 1 | Adopt `prisma migrate dev`. Create the first migration from the current schema. Use `prisma migrate deploy` for zero-downtime prod. |

### CI (1)

| ID | Risk | File:line | Stage to fix | Mitigation |
| --- | --- | --- | --- | --- |
| R-HIGH-11 | No CI of any kind — tests only run when a human remembers | (no `.github/workflows/`) | Stage 1 | Add `.github/workflows/ci.yml` running `typecheck`, `lint`, `test` on every commit. Stage 2 adds cross-tenant isolation tests. |

### Settings secrets (3)

| ID | Risk | File:line | Stage to fix | Mitigation |
| --- | --- | --- | --- | --- |
| R-HIGH-12 | `PUT /api/settings/ai` saves Z.ai global creds + per-capability provider config to the singleton `Setting` table | `src/app/api/settings/ai/route.ts:71` | Stage 2 | Move to `ProviderCredential` per-user, encrypted at rest with `TUBEFORGE_ENCRYPTION_KEY`. |
| R-HIGH-13 | `PUT /api/youtube/config` saves OAuth client secret to the singleton `Setting` table | `src/app/api/youtube/config/route.ts:10` | Stage 2 | `ytClientId` / `ytClientSecret` stay server-wide in `.env`. Per-user `ytRefreshToken` / `ytChannelTitle` / `ytChannelThumb` move to `YouTubeAccount`. |
| R-HIGH-14 | `POST /api/settings/ai` fires real chat/tts/image/video calls with user-supplied `baseUrl` overrides | `src/app/api/settings/ai/route.ts:162` | Stage 1 | Mitigated by `providerFetch → safeFetch` (already in place). Add a per-call cost cap to prevent runaway test spend. |

### Long-running render (1)

| ID | Risk | File:line | Stage to fix | Mitigation |
| --- | --- | --- | --- | --- |
| R-HIGH-15 | `POST /api/videos/[id]/render` runs long in-process render + ffmpeg + QC (can take minutes) | `src/app/api/videos/[id]/render/route.ts:51` | Stage 3 | Already jobbed (`startJob`); move to BullMQ. Worker auto-resumes on SIGTERM. |

### Per-scene work (10)

| ID | Risk | File:line | Stage to fix | Mitigation |
| --- | --- | --- | --- | --- |
| R-HIGH-16 | `POST /api/videos/[id]/script` startJob + heavy fs cleanup + AI call | `src/app/api/videos/[id]/script/route.ts:44` | Stage 3 | Move to BullMQ. |
| R-HIGH-17 | `POST /api/videos/[id]/storyboard` startJob image-gen loop | `src/app/api/videos/[id]/storyboard/route.ts:34` | Stage 3 | Move to BullMQ. |
| R-HIGH-18 | `POST /api/videos/[id]/convert` startJob + LLM + ffmpeg | `src/app/api/videos/[id]/convert/route.ts:29` | Stage 3 | Move to BullMQ. |
| R-HIGH-19 | `POST /api/videos/[id]/verify` startJob + ASR (uploads audio to provider) | `src/app/api/videos/[id]/verify/route.ts:13` | Stage 3 | Move to BullMQ. |
| R-HIGH-20 | `POST /api/videos/[id]/brand` 5MB binary upload + fs write | `src/app/api/videos/[id]/brand/route.ts:42` | Stage 3 | Move binary upload to presigned S3 URL; the API route only records the metadata. |
| R-HIGH-21 | `POST /api/videos/[id]/thumbnail` startJob image + VLM quality gate | `src/app/api/videos/[id]/thumbnail/route.ts:33` | Stage 3 | Move to BullMQ. |
| R-HIGH-22 | `POST /api/videos/[id]/slides` startJob slide design + screenshot (Playwright) | `src/app/api/videos/[id]/slides/route.ts:64` | Stage 3 | Move to BullMQ. |
| R-HIGH-23 | `POST /api/videos/[id]/voiceover` startJob + ffmpeg + safeFetch | `src/app/api/videos/[id]/voiceover/route.ts:26` | Stage 3 | Move to BullMQ. |
| R-HIGH-24 | `POST /api/videos/[id]/stock` and `…/stock/[n]` startJob + external Pexels/Pixabay fetch loop | `src/app/api/videos/[id]/stock/route.ts:71` | Stage 3 | Move to BullMQ. |
| R-HIGH-25 | `POST /api/videos/[id]/variants` startJob ×3 images | `src/app/api/videos/[id]/variants/route.ts:44` | Stage 3 | Move to BullMQ. |

### Voice clone (1)

| ID | Risk | File:line | Stage to fix | Mitigation |
| --- | --- | --- | --- | --- |
| R-HIGH-26 | `POST /api/voices/clone` uploads + Zhipu external clone API + optional user-supplied URL (guarded by safeFetch) | `src/app/api/voices/clone/route.ts:19` | Stage 3 | Move binary upload to presigned S3 URL. Per-tenant voice profile ownership (Stage 2). |

### Synchronous YouTube sync (1)

| ID | Risk | File:line | Stage to fix | Mitigation |
| --- | --- | --- | --- | --- |
| R-HIGH-27 | `POST /api/youtube/sync` synchronous YouTube Data API call in-request | `src/app/api/youtube/sync/route.ts:11` | Stage 3 | Move to a per-user cron job (acknowledged in comment as "Fast enough to run synchronously" — defensible, but still move it off the request path). |

### Thinnest validation on mutating routes (1)

| ID | Risk | File:line | Stage to fix | Mitigation |
| --- | --- | --- | --- | --- |
| R-HIGH-28 | `PATCH /api/channels/[id]`, `PATCH /api/characters/[id]`, `PATCH /api/schedule/[id]`, `PATCH /api/videos/[id]` have inconsistent length caps and missing caps on PATCH | various | Stage 1 + Stage 2 | Stage 1: add `zod` schemas to these 4 routes. Stage 2: every endpoint has a `zod` schema. |

---

## MEDIUM risks (15)

### Filesystem orphans and cleanup (2)

| ID | Risk | File:line | Stage to fix | Mitigation |
| --- | --- | --- | --- | --- |
| R-MED-1 | `DELETE /api/videos/[id]` does not clean up `uploads/<id>/` — orphaned files on disk | `src/app/api/videos/[id]/route.ts:207` | Stage 1 | Add `rmSync uploads/<id>/` recursive on delete. Stage 3: replace with `storage.delete(videoId)`. |
| R-MED-2 | `DELETE /api/characters/[id]` does the cleanup correctly — keep this pattern | `src/app/api/characters/[id]/route.ts` | Stage 3 | Replace fs.rmSync with `storage.delete()` for the character directory. |

### In-memory security state (2)

| ID | Risk | File:line | Stage to fix | Mitigation |
| --- | --- | --- | --- | --- |
| R-MED-3 | Login brute-force counters reset on restart (`__tfAuthLimit` in-memory only) | `src/lib/tubeforge/auth.ts:189-190` | Stage 2 | Move to Redis. |
| R-MED-4 | API rate-limit buckets reset on restart (`__tfRateBuckets` in-memory only) | `src/lib/tubeforge/rate-limit.ts:18-21` | Stage 2 | Move to Redis. |

### In-memory pacing state (1)

| ID | Risk | File:line | Stage to fix | Mitigation |
| --- | --- | --- | --- | --- |
| R-MED-5 | AI budget pacing state resets on restart (`__tfBudget`) — thundering-herd risk on fresh process | `src/lib/tubeforge/budget.ts:45-54` | Stage 3 | Move to Redis (or accept as a degraded mode with documented restart behavior). |

### Memory-bound media streaming (2)

| ID | Risk | File:line | Stage to fix | Mitigation |
| --- | --- | --- | --- | --- |
| R-MED-6 | `GET /api/videos/[id]/mp4` reads entire file into memory via `fs.readFileSync` | `src/lib/tubeforge/render.ts:729` | Stage 3 | Replace with redirect to presigned S3 URL (or `fs.createReadStream` + Range support if staying on a Node server). |
| R-MED-7 | `GET /api/videos/[id]/export` buffers entire ZIP in memory via `buildZip` | `src/app/api/videos/[id]/export/route.ts:248` | Stage 3 | Stream the ZIP to the client (or to S3 then redirect). |

### Build / packaging (4)

| ID | Risk | File:line | Stage to fix | Mitigation |
| --- | --- | --- | --- | --- |
| R-MED-8 | `npm run setup` is broken for SQLite local dev | `package.json:14` | Stage 1 | Auto-detect URL protocol like `postinstall.mjs` does, OR remove the script and document `setup:local` as the only valid local command. |
| R-MED-9 | `npm run backup` and `npm run auth:reset` reference missing files (`scripts/backup.sh`, `scripts/auth-reset.mjs`) | `package.json:16,17` | Stage 1 | Restore the scripts (preferred) or remove the references from `package.json` and `SETUP.md` / `SECURITY.md`. |
| R-MED-10 | Two lockfiles committed (`bun.lock` + `package-lock.json`) — PM-of-record unclear | repo root | Stage 1 | Pick one PM (recommend npm, since `SETUP.md` documents it); delete the other lockfile; align all scripts; update `SETUP.md`. |
| R-MED-11 | ESLint rules all disabled — `npm run lint` gives false confidence | `eslint.config.mjs:10-45` | Stage 1 | Re-enable at warn level: `@typescript-eslint/no-explicit-any`, `@typescript-eslint/no-unused-vars`, `react-hooks/exhaustive-deps`, `no-console`, `no-debugger`. |

### Missing security headers (1)

| ID | Risk | File:line | Stage to fix | Mitigation |
| --- | --- | --- | --- | --- |
| R-MED-12 | No security headers configured (CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, HSTS) | `next.config.ts` | Stage 1 | Add a `headers()` function to `next.config.ts`. |

### Cross-platform compatibility (1)

| ID | Risk | File:line | Stage to fix | Mitigation |
| --- | --- | --- | --- | --- |
| R-MED-13 | `/proc/<pid>/stat` zombie watchdog is Linux-only (won't work on macOS/Windows hosts) | `src/lib/tubeforge/proc.ts:37-46` | Stage 3 | Replace with a cross-platform child-process reaper (e.g. `tree-kill` or signal-based with `process.kill`). |

### Side-effecting GET (1)

| ID | Risk | File:line | Stage to fix | Mitigation |
| --- | --- | --- | --- | --- |
| R-MED-14 | `GET /api/music` is a side-effecting GET — seeds the music library on first open via ffmpeg synth | `src/app/api/music/route.ts` | Stage 1 | Move the seeding to a `POST /api/music/seed` route; `GET /api/music` becomes a pure read. |

### Path parameter validation (1)

| ID | Risk | File:line | Stage to fix | Mitigation |
| --- | --- | --- | --- | --- |
| R-MED-15 | `params.n` not strictly validated as positive integer in storyboard/slides/stock routes | `src/app/api/videos/[id]/storyboard/[n]/route.ts` etc. | Stage 1 | Add `zod` schema: `z.coerce.number().int().positive()`. |

---

## LOW risks (7)

| ID | Risk | File:line | Stage to fix | Mitigation |
| --- | --- | --- | --- | --- |
| R-LOW-1 | `VoiceProfile` SQLite comment drifted from Postgres version (cosmetic; fields are identical) | `prisma/schema.sqlite.prisma:194-198` | Stage 1 | Sync the comment block from Postgres to SQLite. |
| R-LOW-2 | Tailwind v3 config file is dead drift (v4 uses CSS-based config in `globals.css`) | `tailwind.config.ts` | Stage 1 | Either delete the file (v4 doesn't need it) or wire it via `@config` in `globals.css` and update the `content` globs to include `./src/**`. |
| R-LOW-3 | `TUBEFORGE_AUTH_SECRET` absent from local `.env` (studio runs open by default — documented dev mode) | (local dev only) | Stage 1 | Document in `SETUP.md` that local dev with the studio open is the default; production requires `TUBEFORGE_AUTH_SECRET` + `TUBEFORGE_REQUIRE_LOCK=1`. |
| R-LOW-4 | `runScriptJob` is dead code (the fix for D-01 already exists) | `src/lib/tubeforge/script-job.ts:35-174` | Stage 1 | Wire `runScriptJob` into `startJob` for `POST /api/videos`. |
| R-LOW-5 | `reactStrictMode: false` in `next.config.ts` weakens React dev-mode check | `next.config.ts:8` | Stage 1 | Set `reactStrictMode: true`. |
| R-LOW-6 | Playwright installed (`1.57.0`) but unwired (no `playwright.config.*`, no `e2e/` dir) | `package.json:74` | Stage 1 | Either wire Playwright E2E tests (preferred) or remove the dependency. |
| R-LOW-7 | `bun-types` in devDependencies but `npm` is the documented PM — `test` and `check` scripts require bun | `package.json:99` | Stage 1 | Pick one PM. If npm: migrate `test-unit.ts` to node + tsx or vitest. If bun: update `SETUP.md` to document bun as the prerequisite. |

---

## Cross-cutting risks (not from the defect list, but flagged by the audit)

| ID | Risk | Stage to fix | Mitigation |
| --- | --- | --- | --- |
| R-X-1 | **AI provider churn.** Every AI video startup in 2025-2026 has been derailed by provider API changes (Runway, Sora, Veo, Seedance all changed APIs, pricing, or availability mid-build). The current code goes through `providers/registry.ts` but call sites sometimes bypass it. | Stage 3 | Enforce "every provider call goes through the provider abstraction" as an architectural rule. Add a CI lint that flags direct `fetch` to a known provider URL outside `providers/`. |
| R-X-2 | **AI Director is a research problem.** The master plan says the AI Director should "make creative decisions" but no off-the-shelf model does this reliably in 2026. | Stage 5 | The roadmap honest-note says: "AI Director *proposes*, human approves." Shot selection, framing, lens suggestions, transitions — all as suggestions the user accepts/rejects/regenerates. This is achievable and still feels magical. |
| R-X-3 | **Character continuity is ~80-90%, not 100%.** Reference image systems (IP-Adapter, Seedance reference, Qwen image-edit) get close but not perfect. | Stage 5 | Plan for a "regenerate until consistent" loop with VLM-based consistency scoring, not a "guaranteed consistent" promise. The completion gate is "the system flags inconsistencies and offers one-click regeneration." |
| R-X-4 | **The 28-week timeline assumes no AI provider surprises.** | All stages | The roadmap is 33 weeks (audit-adjusted). For a focused 2-3 person team. For a solo developer, expect 40-52 weeks. Build for provider abstraction from day one. |
| R-X-5 | **The biggest risk is Stage 2 — multi-tenant data isolation.** If we get this wrong anywhere in the codebase, we have a catastrophic breach the first time a paying customer signs up. | Stage 2 | Add automated cross-tenant isolation tests in CI from Stage 2 onward (not as a Stage 7 QA item). By Stage 7 it's too late to find leakage. |

---

## Risk burn-down

| Stage | Risks fixed |
| --- | --- |
| Stage 1 | R-CRIT-3, R-HIGH-1, R-HIGH-2, R-HIGH-3, R-HIGH-4, R-HIGH-9 (partial), R-HIGH-10, R-HIGH-11, R-HIGH-14, R-HIGH-28 (partial), R-MED-1, R-MED-8, R-MED-9, R-MED-10, R-MED-11, R-MED-12, R-MED-14, R-MED-15, R-LOW-1, R-LOW-2, R-LOW-3, R-LOW-4, R-LOW-5, R-LOW-6, R-LOW-7 |
| Stage 2 | R-CRIT-1, R-CRIT-2, R-HIGH-9 (rest), R-HIGH-12, R-HIGH-13, R-HIGH-28 (rest), R-MED-3, R-MED-4 |
| Stage 3 | R-HIGH-5, R-HIGH-8, R-HIGH-15, R-HIGH-16, R-HIGH-17, R-HIGH-18, R-HIGH-19, R-HIGH-20, R-HIGH-21, R-HIGH-22, R-HIGH-23, R-HIGH-24, R-HIGH-25, R-HIGH-26, R-HIGH-27, R-MED-2, R-MED-5, R-MED-6, R-MED-7, R-MED-13, R-X-1 |
| Stage 4 | (none — UX stage) |
| Stage 5 | R-X-2, R-X-3 |
| Stage 6 | R-HIGH-6, R-HIGH-7 |
| Stage 7 | R-X-4, R-X-5 |

**At end of Stage 1:** 25 of 53 risks closed. All CRITICAL risks except R-CRIT-1 and R-CRIT-2 are closed (those require Stage 2 schema changes).

**At end of Stage 2:** 33 of 53 risks closed. All CRITICAL risks closed. The multi-tenant blocker is gone.

**At end of Stage 3:** 54 of 55 risks closed. Only R-X-4 (timeline risk) and R-X-5 (multi-tenant risk) remain — both mitigated by Stage 7 launch tests.

**At end of Stage 6:** All risks closed except the launch risks (R-X-4, R-X-5), which Stage 7 close.

---

## Risk acceptance

Risks not in this register either:

- Are not present in the codebase (per the audit), OR
- Are present but LOW and not worth tracking formally.

If a new risk is discovered during implementation, it is added to this register with a new ID (R-NEW-N) and assigned to a stage.
