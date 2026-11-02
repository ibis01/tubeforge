# Phase 0 — Read-Only Architecture Audit (Commercial Foundation)

- **Date:** 2026-11-02
- **Commit audited:** `2cda028` (`feat(m1): production profiles — the universal Director`), the same commit deployed to production (`tubeforge-ibismuh.vercel.app`). Working tree was clean and identical to `origin/main` at audit time.
- **Method:** read-only. No application code was changed. Five parallel evidence passes (data model, commerce, generation, identity/security, director/production/observability) produced file:line findings; the five most load-bearing claims were re-verified directly against the working tree and are marked **[verified]** below.
- **Purpose:** map the commercial-architecture proposal (multi-provider video SaaS; Director-orchestrated capabilities; subscriptions + credit top-ups; immutable credit ledger; `GenerationProvider` abstraction) onto the codebase as it exists today, and define what Phase 1 must build. This document is the Phase 0 exit artifact required by the proposal's roadmap.

---

## 1. Executive summary

TubeForge is much further along the proposal's target architecture than a typical "idea-stage" codebase. Identity, multi-tenancy, a durable job pipeline, a Director with approval gates, an ffmpeg production engine with publishing, and — decisively — a **real billing core** (canonical microcredit unit, period-scoped balances, transactional reserve→settle, DB-enforced idempotency, a 36-test integration suite) already exist on `main`.

What does **not** exist yet is the *commercial layer on top of that core*: no payment initiation (Stripe SDK, checkout, portal), no top-ups, no Free-tier watermark, no per-model cost truth (`costMicroUsd` is hardwired 0 **[verified]**), and no admin/audit surface. Two correctness gaps matter for the proposal's "0 duplicate charges / 0 untracked spend" targets: the render path skips credit reservation, and job dedupe ignores running jobs in split web/worker topologies **[verified]**.

The proposal's phased plan remains valid. Phase 0 is hereby complete; Phase 1 (commercial foundation) should start from the ordering in §11.

### Subsystem verdict matrix

| # | Proposal subsystem | Verdict | One-line reality |
|---|---|---|---|
| 1 | Application (product shell) | **SATISFIED** | Next.js 16 App Router app: studio UI, 23-stage pipeline, activity feed, settings; stages 1–6 shipped |
| 2 | Identity & Business | **PARTIAL** | Users/orgs/sessions/roles exist; membership APIs, role enforcement, admin surface and audit log do not |
| 3 | Director | **SATISFIED** | M1 7-profile planning + M2 shot execution, single enforced approval seam, advisory validation → activity feed |
| 4 | Commerce | **PARTIAL (strong core, no payments)** | Microcredit ledger + reservations + Stripe webhook receiver are production-grade; checkout/top-ups/refunds/prices are not built |
| 5 | Generation | **PARTIAL** | Capability-gateway functions with 20+ provider adapters; no `GenerationProvider` interface, no mock, video locked to Z.ai in the render path |
| 6 | Asset | **PARTIAL** | Storage driver (local/S3) + per-org quota + auth-gated serving; no `Asset` model, no artifact registry |
| 7 | Production (render/export) | **SATISFIED** | 4 render modes, multi-shot scene graph, loudness-normalized finalize, ZIP export, YouTube publish; watermark absent |
| 8 | Observability | **PARTIAL** | JSON logs with secret redaction, `UsageRecord` metering, `/api/diag`; no health endpoint, no error tracking, in-memory scaling limits |

---

## 2. Data model — the proposal's 14 entities vs `prisma/schema.prisma`

The Postgres schema (713 lines, 27 models) is the source of truth; `prisma/schema.sqlite.prisma` is a generated verbatim mirror (`scripts/sync-sqlite-schema.mjs`, header "DO NOT EDIT") so SQLite dev and Postgres prod behave identically. All JSON lives in TEXT columns by design.

| Proposed entity | Existing model(s) | Verdict | Notes |
|---|---|---|---|
| users | `User` | EXISTS-AS-IS | pbkdf2 password hash, verify/reset token hashes |
| organizations | `Organization` | EXISTS-AS-IS | tenant root; 15+ org-scoped models cascade from it |
| memberships | `Membership` | EXISTS-AS-IS | role owner/admin/editor/viewer; one-owner-per-org partial unique index (raw SQL) |
| subscriptions | `Subscription` | EXISTS-PARTIAL | structure right (plan ref, Stripe ids, status, period end) but **user-scoped** (`userId @unique`), not org-scoped |
| payments | — | **MISSING** | no Payment/Invoice/charge model; nearest markers: `CreditGrant.stripeInvoiceId`, `ProcessedWebhookEvent` |
| credit_wallets | — (deliberate) | **MISSING by design** | balance is **computed** (`CreditGrant` − signed `CreditLedger`, period-scoped); never denormalized (`billing.ts:161-180`) |
| credit_ledger | `CreditLedger` | EXISTS-AS-IS | append-only, signed `microCredits` (1 credit = 1,000 µ), 9 kinds, `usageRecordId` + `reconcilesId @unique` |
| projects | `Video` | NAME-DIFFERS | `Video` (~60 fields) plays the project role; no separate `Project` |
| scenes | `Video.scenes` (JSON) + `CharacterAppearance` | MISSING (embedded) | scenes are a JSON array on the video row, not a first-class table |
| assets | — | **MISSING** | storage keys mirror `uploads/` layout; DB has flags (`hasVideo`…) + `StorageUsage` byte counter only |
| generation_jobs | `Job` | NAME-DIFFERS | durable queue row (attempts, claim, backoff, payload, cancel); **no cost/hold link on the row** |
| provider_costs | `UsageRecord` | NAME-DIFFERS | per-AI-call row (capability/provider/model/tokens/`costMicroUsd`/latency/ok) — but cost is hardwired 0 today |
| exports | — | **MISSING** | export is route-level (`/api/videos/[id]/export` ZIP, `/mp4` streaming); no artifact model |
| usage_events | `UsageRecord` + `Activity` | EXISTS-PARTIAL | AI-call usage is covered; no distinct immutable usage-event stream |

**Migration timeline (12):** init (single-user + `Setting` KV) → stage2 multiuser (User/Org/Membership/Session/UserSetting/ProviderCredential; `Setting`→`LegacySetting`) → stage3 queue (+usage/storage, job payload) → stage5 director/world/sources → stage6 publishing → **stage7 billing → 7.1 integrity (`ProcessedWebhookEvent`, micro-unit rename, invoice-id unique) → 7.2 reservations (`reconcilesId` unique)**.

**Proposal-rule check:** "every attempt has a cost record" — *partial*: one `UsageRecord` per `aiCall` chain (retries collapsed), no `jobId` link. "Every billable job links to the ledger" — *partial*: ledger rows link to `UsageRecord` and holds, but `Job` → ledger linkage does not exist. "Multi-org" — content yes; **billing is user-scoped, not org-scoped**.

---

## 3. Commerce engine

**What is genuinely solid** (Stage 7 / 7.1 / 7.2):

- **Unit discipline.** `MICROS_PER_CREDIT = 1000` (`billing.ts:113`); grants renamed `grantedMicroCredits`; ledger amounts are signed micro-credit integers.
- **Computed, period-scoped balances.** `computePeriodBalance()` (`billing.ts:161-180`) — grants define the window, no rollover, fail-closed to 0 with no covering grant.
- **Transactional money primitives.** `runBilledTx` (`billing.ts:436-453`): Postgres `Serializable` / SQLite `BEGIN IMMEDIATE` with transient-retry; in-process serialization via `queueSpend` (`billing.ts:424-429`); the balance re-read happens *inside* the transaction, so check+write commit atomically.
- **Reserve → settle → release.** `reserveCredits` (`billing.ts:578-614`) writes a `hold` row before every AI call (enforced at the single chokepoint `budget.ts:222-285` — a blocked hold throws `CreditBlockedError` and the provider call never runs); `settleCreditHold` (`billing.ts:630-684`) writes exactly one settlement per hold — **DB-enforced** by `reconcilesId @unique` (stage 7.2 migration).
- **Idempotency where money enters.** `ProcessedWebhookEvent` (create-then-handle, `billing.ts:806-830`) + `CreditGrant.stripeInvoiceId @unique` + upsert — double grants are impossible.
- **Webhook receiver is production-grade.** `POST /api/billing/webhook` (`webhook/route.ts:38-90`): fail-closed signature matrix (401 on missing/bad sig, 500 in production without secret), hand-rolled HMAC-SHA-256 with 300 s replay window and constant-time compare (`billing.ts:998-1033`). Handles `checkout.session.completed`, `customer.subscription.*`, `invoice.paid`.
- **Auto-release on failed AI calls.** Failed held calls settle `ok=false` → full hold release, net 0 (`budget.ts:354-362`); pinned end-to-end by tests (`test-billing.mts:1114-1140`).
- **Test depth.** `scripts/test-billing.mts` — 36 integration tests against the real DB and the real webhook handler: 8-branch auth matrix, grant idempotency ×2, 10-way concurrency, full Stripe lifecycle, period scoping, reservation matrix, 3 end-to-end `aiCall` tests. Plus pure-function unit tests (`test-unit.mts:2076-2290`).

**What is missing or deviates** (each row is a Phase 1 work item):

| # | Gap / deviation | Evidence | Impact on proposal targets |
|---|---|---|---|
| C1 | **Renders never reserve.** Route does a non-transactional `hasCredits` pre-check (402 gate), spend is recorded *post-success*, unconditionally | `render/route.ts:104-125`, `video-jobs.ts:640-650` | TOCTOU overspend on paid tiers; balance can go negative — "0 untracked spend" at risk |
| C2 | **`costMicroUsd` hardwired 0**; per-capability flat estimates only (chat 3,000 µ … video 40,000 µ), placeholder $0.001/credit | `budget.ts:344` **[verified]**, `billing.ts:742-781` | No real per-model cost → pricing formula (credits = cost/(price×(1−margin))) cannot be populated |
| C3 | **No payment initiation.** No `stripe` dependency; no checkout/portal routes; Upgrade button unwired; `TUBEFORGE_STRIPE_SECRET_KEY` never read | `billing.ts:49-52`, `plan-card.tsx:5-8` | Revenue streams blocked; "0 duplicate charges" vacuous until money moves |
| C4 | **No top-ups / no `refund` writer.** `topup`/`refund` kinds declared, never written; `charge.refunded` acked silently; refunds are manual operator rows | `billing.ts:326-336`, `test-billing.mts:590-601` | Proposal's second revenue stream absent; clawback policy absent |
| C5 | **3 plans, not 6.** starter/creator/studio only; no Free (watermark) tier, no Pro, no Enterprise; no prices/price IDs; no Plan seed script | `billing.ts:75-103` **[verified]** | Tier mismatch with launch pricing |
| C6 | **Billing is user-scoped, not org-scoped.** `Subscription.userId @unique`; org cannot pool credits | `schema.prisma:641` | Blocks business/team plans (Phase 5) |
| C7 | **`CreditBlockedError` → 402 mapping unwired** — only the render pre-gate returns 402; interactive AI routes would 500 | `billing.ts:552-554` | Broken UX at credit exhaustion |
| C8 | **Stale-hold sweep missing.** Crash between reserve and settle permanently withholds credits (fail-closed), sweep is a documented follow-up | `billing.ts:542-545` | Silent credit liability |
| C9 | **No reconciliation.** `sumAICallSpends` helper exists but nothing runs it; no Stripe-side reconciliation job | `billing.ts:695-714` | "100% payment reconciliation" unimplemented |
| C10 | **Billing suite not in CI.** CI runs `typecheck && lint && test && e2e` only; `test:billing` is in `npm run check` (local) | `.github/workflows/*` **[verified]** | Money-code regressions could merge green |
| C11 | Ledger is append-only *by code convention*; one sanctioned `update` (hold metadata); no DB-level immutability or tamper evidence; cascade-deletes with user | `billing.ts:670-674`, `schema.prisma:696-697` | Acceptable now; revisit before real money |
| C12 | Quotas partial: resolution cap enforced; `priorityRendering`/`teamMembers` decorative; storage quota per-org env-driven; rate limits per-IP not per-plan | `billing.ts:719-729`, `storage.ts:53-56` | Plan enforcement incomplete |

**Frontend never touches balances — met.** The only session-facing billing surface is `GET /api/billing/plan` (auth required, read-only); the webhook is the only writer.

---

## 4. Generation provider layer

**Pattern today:** a *capability-gateway function* per capability (`imageGenerate`, `imageToVideo`, `ttsSynthesize`, `chatComplete`, `visionComplete`, `asrTranscribe` in `src/lib/tubeforge/providers/*`), each switching on per-user config from `getCapability()` (`providers/settings.ts:106-136`), wrapped by `aiCall` (pacing, credits, retries, metering). The Director is provider-agnostic (`director.ts:296-304` uses `llmChat` only). There is **no `GenerationProvider` interface** with `generateImage/Video/Audio`, `getJobStatus`, `cancelJob` — the proposal's seam must be introduced, not patched.

**Adapter inventory (real code):**

| Capability | Implemented | Unreachable / drift |
|---|---|---|
| chat | zai SDK + any OpenAI-compatible endpoint (13 listed), anthropic, gemini | — |
| vision | zai, openai, anthropic, gemini | follows chat config |
| tts | zai, zhipu, openai, selfhost | **elevenlabs listed in registry, not implemented** (`registry.ts:196-202` vs `tts.ts:112-121`) |
| asr | zai, openai | piggybacks tts capability; no `audio` capability id |
| image | zai, pollinations, openai, stability, fal, replicate, ideogram, recraft | **ideogram/recraft implemented but unlisted** (`image.ts:405,444` vs `registry.ts:206-268`) |
| image edit | zai, openai only; others fall back to prompt-seeded generation (billed as own aiCall) | — |
| video (i2v) | fal, replicate, huggingface, runway, luma — all **unreachable from the product pipeline**; zai adapter is a stub that throws | **huggingface unlisted** (`video.ts:145` vs `registry.ts:271-323`) |
| music/SFX | synthesized locally by ffmpeg (`music.ts:391,510-524`) | no external provider, no cost record |
| mock / piapi | **do not exist anywhere** | required by proposal |

**The hard abstraction leak:** the animated render mode bypasses `providers/video.ts` entirely — `render.ts:241` **[verified]** rejects any non-Z.ai provider, then calls the Z.ai SDK directly with inline 60×10 s polling (`render.ts:248-281`). Fal/replicate/runway/luma adapters are dead code from the product's perspective. This is the single change point the proposal's Phase 2 must rewire (through `ensureSceneClip`, `render.ts:230-284`).

**Duplicate-billing analysis (proposal: fallback must never create duplicate billable jobs):**

- No cross-provider fallback exists at all — the offending pattern cannot occur *today*.
- Retry is two-layered and same-provider: call-level `withRetry` (×3, exp backoff, shared 429 penalty, `budget.ts:183-213`) and queue-level requeue (30 s→10 min + jitter, per-kind caps — AI-heavy kinds capped at 1 attempt to avoid re-payment, `queue.ts:62-74`).
- Holds cannot double-deduct (`reconcilesId @unique`).
- **One real window remains:** `startJob` dedupe checks only `status: "pending"` (`jobs.ts:370` **[verified]**). In the supported split topology (web enqueue-only + N workers), a job already `running` in the worker is invisible to the web process — a double-click can enqueue a second billable job for the same logical work. Fix is small: dedupe on `status IN ("pending","running")` or an advisory lock keyed by `entityId:kind`.
- Provider-side tasks cannot be cancelled or reconciled across crashes: no `getJobStatus`/`cancelJob` at provider level, no webhook receivers, task ids live only in the closure stack. A `provider_tasks` table (external task id + status per job) is the structural fix.

**The `needsI2V` seam exists exactly as the proposal expects:** Director-produced per-scene flag, typed/parsed/persisted (`director-plan.ts:105,205`), consumed by UI badge, pacing QC, and the animation profile's validation — deliberately advisory in M2; the render path ignores it (documented in `docs/director-audit-m0.md:69`). Future I2V providers plug in at `ensureSceneClip` + this flag.

**Keys:** per-user `ProviderCredential`, AES-256-GCM at rest, masked client views (`hasKey`/`maskedKey` only), `redactText` scrubbing before persistence, SSRF-guarded fetch. Server-side-only is essentially met (two plaintext exceptions — §5).

---

## 5. Identity, organizations, security

**Solid:** default-deny middleware for `/api/*` with a small public allow-list; production fails closed without `TUBEFORGE_AUTH_SECRET`; CSRF origin check for cookie mutations; per-IP rate limits (600 read/90 write per min); PBKDF2-SHA-256 (120k iters, 16-byte salt, constant-time compare); server-side revocable `Session` rows (7-day, `jti` = row id → instant revocation); registration transactionally creates User + personal Organization + owner Membership; login lockout (5/10 min). Tenant isolation is centralized in a Prisma client extension (`tenant-db.ts`) injecting `organizationId` for 15+ org-scoped models, with a lint guard banning raw `@/lib/db` imports in `src/app` and an e2e isolation suite pinning a historically-fixed leak.

**Gaps:**

| # | Gap | Evidence |
|---|---|---|
| I1 | **Roles never enforced.** `requireRole()` implemented (`tenant.ts:256-273`) with **zero call sites**; authorization = authentication + tenant scope only | `tenant.ts:256` |
| I2 | **No membership management APIs** — no invite/list/role-change/remove; every org is single-member in practice | only `src/app/api/auth/*` |
| I3 | **No admin surface, no audit log.** No `/admin` routes/nav; no `AuditLog` model; activity feed is a pipeline timeline, not privileged-action audit | repo-wide grep |
| I4 | **Two plaintext secrets.** `zai.apiKey` and `yt.clientSecret` stored as plaintext `UserSetting` rows — and `/api/account/export` dumps all `UserSetting` values **verbatim** | `account/export/route.ts:49`, `settings/ai/route.ts:88-97` |
| I5 | `.z-ai-config` written plaintext on disk (SDK design); public `/api/diag` exposes table/migration names (self-declared temporary) | `providers/config.ts:23-42`, `diag/route.ts:1-5` |
| I6 | Legacy dead code: `src/app/login/page.tsx` + `security-card.tsx` call removed APIs (vestigial) | — |
| I7 | Session fixed 7-day (no sliding renewal); 90-day API Bearer tokens irrevocable individually (secret rotation only); in-memory rate limits/lockout break on multi-instance; role read from user's *first* membership (latent multi-org bug) | `tenant.ts:174-184` |

**Signed URLs: hybrid, safe.** S3 driver issues 5-minute presigned URLs only after tenant-checked authz; local driver streams through authenticated Range routes. No unauthenticated asset URLs exist. `uploads/` is outside `public/`.

---

## 6. Director & production engine

**Director (M1+M2 shipped):** 7 production profiles (`production-profiles.ts:70-272`, `narrative` byte-identical legacy), `DirectorPlan` parse/serialize with strict snapping (unknown profile → legacy), plan→approve→storyboard→shots→render flow with a **single enforced seam** (`directorState === "approved"`, 6 accessor functions), advisory profile validation surfaced to the human *before* approval, `buildSceneShots` pure contract (`shots.ts:88-150`: inputs `{scene, planScene, measuredSec}` → `SceneShotPlan`, sum-adjust scale-to-fit, ≤7 shots, extras budget 3, legacy fallback bit-identical).

**Production:** `render.ts` (1,227 lines) — 4 modes (kenburns / stock / animated i2v / slides), per-scene ffprobe timing with narration floors, M2 `multiShotSceneGraph` (per-shot inputs, largest-remainder frame budgets, focal-anchored zoompan math confined to `motion.ts`), bounded xfade blending groups (memory-scaled, probe-verified), two-pass loudnorm to −16 LUFS, optional subtitle burn, `+faststart`, `finally`-cleaned tmp. Publishing: aspect/fps/captions options, Range-streaming MP4 (+S3 presigned 302), ZIP export with license `CREDITS.txt`, auto-Short ≤45 s, YouTube publish job. Durable queue with crash-recovery for every job kind.

**Gaps for commercialization:** **no watermark pipeline at all** (blocks the Free tier), single delivery format (H.264 1080p; resolution cap exists but is hardcoded "1080p" at the route), YouTube-only publish target, render cost model placeholder ($0.03/min flat, no CPU-minute measurement), no per-tier render concurrency/priority in the queue, budget waits fail open after 10 min, no scheduled scratch/orphan cleanup.

---

## 7. Observability

JSON-per-line logging with secret redaction and `log.child` (zero-dependency, pino-format, designed for stdout ingest — nothing wired yet); every AI call metered into `UsageRecord` (tokens/cost zeroed — §3 C2); aggregates at `/api/account/usage`; activity feed (23 stage types) as the tenant-facing timeline. **Missing:** no `/api/health` (only public `/api/diag`, flagged temporary), no error tracking, no metrics/OTel, no request-id correlation, ~200 legacy `console.*` calls unbridged, and in-memory state (rate limits, budget queues, job memory map, `queueSpend` serialization) that breaks with >1 web replica — the principal horizontal-scaling blocker.

---

## 8. Consolidated risk register (Phase 1 input)

| ID | Risk | Severity | Where |
|---|---|---|---|
| R-01 | Split-topology duplicate-enqueue window (running jobs invisible to dedupe) → double billable work | **High** | `jobs.ts:370` [verified] |
| R-02 | Render spend bypasses reservation (TOCTOU overspend, negative balances possible) | **High** | `render/route.ts:115-125`, `video-jobs.ts:640-650` |
| R-03 | `costMicroUsd` ≡ 0 → pricing/margin math unpopulatable; "0 untracked spend" unprovable | **High** | `budget.ts:344` [verified] |
| R-04 | Plaintext secrets in `UserSetting` + full-secret dump via `/api/account/export` | **High** | `account/export/route.ts:49` |
| R-05 | No payment initiation, no top-ups, no refund writer → revenue blocked | **High** (roadmap, not defect) | `billing.ts:49-52` |
| R-06 | No Free-tier watermark → launch pricing (Free $0 tier) impossible | **High** (roadmap) | render pipeline |
| R-07 | Render I2V Z.ai-locked; 4 video adapters dead code; no mock → multi-provider story blocked | Medium-High | `render.ts:241` [verified] |
| R-08 | Roles/admin/audit absent | Medium (Phase 5 scope) | `tenant.ts:256` |
| R-09 | Billing suite not in CI gate | Medium | workflows [verified] |
| R-10 | Stale-hold sweep missing → credit liability after crashes | Medium | `billing.ts:542-545` |
| R-11 | Single-process assumptions (rate limits, budget queues, spend serialization) | Medium (scaling) | `billing.ts:424-429` |
| R-12 | No `/api/health`; public `/api/diag` | Medium | `diag/route.ts:1-5` |
| R-13 | Billing user-scoped vs proposal org-scoped | Medium (Phase 5) | `schema.prisma:641` |
| R-14 | Registry/adapter drift (elevenlabs, ideogram, recraft, huggingface) | Low | `registry.ts` |
| R-15 | Dual-schema drift risk (SQLite mirror) | Low | `sync-sqlite-schema.mjs` |
| R-16 | Operational: rotate any credential ever pasted into logs/worklog (flagged in worklog close-out) | Low (hygiene) | `worklog.md` |

---

## 9. Protected invariants — what must NOT change

1. **Atomic claim primitive** — `job.updateMany WHERE status="pending"` + `count !== 1 → skip` (`queue.ts:321-333`), plus cross-process claim liveness. Any queue work must preserve it.
2. **Append-only ledger convention + `reconcilesId` uniqueness** — settlement-once is DB-enforced; never add an update/delete path for amounts/kinds.
3. **Reserve-before-call at the `aiCall` chokepoint** — new billable capabilities must go through `budget.ts`, not around it.
4. **The single Director approval seam** — `directorState === "approved"` gating all render-side plan accessors; unapproved plans never touch the pipeline.
5. **`narrative` profile byte-identity** with the legacy path (M1 guarantee, pinned by tests).
6. **Tenant scoping via the `tenant-db.ts` extension + lint guard** — new models must join `ORG_SCOPED_MODELS` or be deliberately user-scoped with justification.
7. **The SQLite mirror discipline** — schema changes go to `schema.prisma` and are regenerated, never hand-edited.
8. **The DoD culture** — `npm run check`, evidence artifacts under `docs/baselines/` with commit hashes and rerun instructions.

---

## 10. Proposal phases vs current state

| Proposal phase | Current state | Remaining to exit |
|---|---|---|
| 0 — read-only audit | **this document** | — |
| 1 — commercial foundation | billing core + webhook receiver done | C1-C6, C8-C10: render reservation, 402 mapping, Stripe SDK + checkout/portal, 6-tier catalog + prices + seed, top-ups, refund writer, stale-hold sweep, cost truth |
| 2 — provider orchestration | capability gateways + 20 adapters; render I2V locked | `GenerationProvider` interface, mock provider, rewire `ensureSceneClip`, registry alignment, `provider_tasks` |
| 3 — Director intelligence | M1 profiles + M2 shots shipped with evidence | per-scene source switching (M3/M4), profile validation hardening |
| 4 — production engine | 4 render modes, exports, YouTube publish | watermark pipeline, resolution ladder, more publish targets, render quotas |
| 5 — business/team | org model exists, roles inert | membership APIs, `requireRole` wiring, admin dashboard, `AuditLog`, org-scoped billing decision |
| 6 — optimization & launch | DoD culture, baselines | `/api/health`, error tracking, metrics, multi-replica state externalization, price calibration from real cost data |

---

## 11. Recommended Phase 1 scope (commercial foundation) — ordered

1. **Close the money-correctness holes first** (small, high value): render reservation through the same hold pattern (or an explicit documented exception with a quota gate); `CreditBlockedError` → 402 mapping; stale-hold sweep job; extend `startJob` dedupe to `pending|running` (R-01, R-02, C7, C8).
2. **Payment initiation:** add the Stripe SDK; checkout + customer portal routes; seed the 6-tier plan catalog (Free/Starter/Creator/Pro/Studio/Enterprise) with real price IDs; wire the Upgrade button; decide and implement the **org-vs-user wallet** scoping now (schema change is cheap before launch, expensive after) (C3, C5, C6).
3. **Top-ups + refunds:** `topup` writer via one-off checkout; `refund` writer + `charge.refunded` handler; auto-refund policy for failed *settled* spends (C4).
4. **Cost truth:** populate `UsageRecord.costMicroUsd`/tokens from provider responses (Z.ai usage fields first, then per-provider meters); link usage rows to `Job` (add `jobId` or a per-attempt child); nightly reconciliation job (`UsageRecord` ↔ `CreditLedger` ↔ Stripe invoices) (C2, C9).
5. **Security hardening:** migrate `zai.apiKey`/`yt.clientSecret` into encrypted stores; mask `/api/account/export`; auth-gate or remove `/api/diag`; delete legacy `/login` + `security-card`; put `test:billing` into the CI gate (C10, R-04, R-09, I4-I6).
6. **Free-tier watermark:** ffmpeg drawtext/overlay pass gated by plan (Free) — prerequisite for the launch pricing table (R-06).
7. **Minimal health/observability:** `/api/health` (liveness+DB), request-id middleware; defer OTel/error-tracking vendor choice to Phase 6 (R-12).

**Exit conditions for Phase 1** (mirroring the proposal's targets): a paid checkout completes in test mode end-to-end (checkout → webhook → grant → spend → renewal → cancel) pinned by CI tests; render and AI paths both reserve-then-settle; reconciliation reports 0 discrepancies on a seeded dataset; no secret is returnable unmasked by any API; watermark demonstrably applied on the Free tier.

---

## 12. Phase 0 exit criteria — check

- [x] All 8 proposal subsystems mapped to code with verdicts (§1).
- [x] All 14 proposed entities mapped to schema models (§2).
- [x] Commerce, generation, identity, production, observability audited with file:line evidence (§3-§7).
- [x] Risk register with severities (§8) and protected invariants (§9).
- [x] Phase ordering validated; Phase 1 scope and exit conditions defined (§10-§11).
- [x] No application code modified during the audit (read-only guarantee held).
