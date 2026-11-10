# TubeForge — Architecture

**Status:** reconciled against the live source at S75 (2026-11-10 UTC).
**Last updated:** 2026-11-10 (S75 reconciliation; §2–§8 remain the S47-era target designs)
**Source for current state:** `prisma/schema.prisma`, `prisma/migrations/`, `src/lib/tubeforge/`, `src/app/api/`
**S75 assignment:** the reconciliation record lives in `docs/audits/s75-architecture-reconciliation-record.md`

---

## 1. Current architecture (reconciled at S75, 2026-11-10 UTC — baseline §1.1–1.8 from the S47 reconciliation)

**Source of truth:** `prisma/schema.prisma` (32 models), `prisma/migrations/`
(21 migrations), `src/lib/tubeforge/` (117 modules), `src/app/api/` (116 route
files). §1.1–1.8 were rewritten from those sources during S47 and stay
accurate for what they describe; §1.9 is the S48→S74 delta that the S47
reconciliation could not know about. The Stage-1-era snapshot that lived
here before S47 described a single-user, 11-model system that no longer
exists anywhere in the repo.

### 1.1 High-level

```
┌────────────────────────────────────────────────────────────────────┐
│ Browser (per user, per organization)                               │
│   └─ Next.js 16 App Router — Zustand store, TanStack Query         │
└────────────────────────────────────────────────────────────────────┘
                │ HTTPS (session cookie OR Bearer API token)
                ▼
┌────────────────────────────────────────────────────────────────────┐
│ Next.js 16 standalone server (Node 20) + independent workers       │
│   ├─ src/middleware.ts — DEFAULT-DENY gatekeeper                   │
│   │     (6 public auth endpoints + YouTube OAuth callback)         │
│   ├─ src/app/api/* — 103 route files, tenant-scoped via ALS        │
│   ├─ src/lib/tubeforge/* — 97 modules, 10 provider adapters        │
│   └─ scripts/worker.mts — DB-backed queue consumer                 │
│         (Compose/Fly run web and worker from one image)            │
└────────────────────────────────────────────────────────────────────┘
                │
        ┌───────┼───────┬────────────┬─────────────┐
        ▼       ▼       ▼            ▼             ▼
   PostgreSQL  Local   AI providers  YouTube     Pexels/Pixabay
   (Prisma +   disk or (chat/tts/    Data API    (stock
   migrations) S3/R2    image/video/  + OAuth     footage)
               (presig) asr/vision)  + Analytics)
```

### 1.2 Database

- **Engine:** PostgreSQL in production, SQLite for local dev. ONE source
  schema (`schema.prisma`, 31 models); the SQLite mirror is GENERATED from
  it (`scripts/sync-sqlite-schema.mjs`) — it cannot drift. Schema changes
  ship as versioned `prisma/migrations/` (19 today; SQLite provisions via
  `db push` in the setup path).
- **Tenancy:** `User` / `Organization` / `Membership` (owner, admin,
  editor, viewer); every content model carries `organizationId` with
  cascade delete and an index. Scoping is enforced in `tenant-db.ts` (a
  Prisma `$extends` client injecting `organizationId` from the request's
  async-local-storage context); raw `@/lib/db` imports in route code are
  lint-blocked. Cross-tenant isolation is pinned by `e2e/isolation.spec.ts`
  and per-stage route probes.
- **Secrets at rest:** `ProviderCredential.apiKey` and YouTube tokens are
  AES-256-GCM encrypted per record (`crypto.ts`, `v1.` format). Settings
  are per-user (`UserSetting`), not singleton rows.

### 1.3 Authentication & authorization

- **Mechanism:** PBKDF2 password hashes; server-side `Session` rows
  (7-day, revocable) behind signed cookies; 90-day scoped `ApiToken`
  bearer tokens; email verification + password reset; GDPR export/delete.
- **Gate model:** DEFAULT-DENY middleware with a public allow-list (the
  auth endpoints + `/api/youtube/callback`); a production fail-safe
  refuses to serve when `TUBEFORGE_AUTH_SECRET` is missing.
- **Login lockout (S46):** rolling 10-minute window, 5 in-window failures
  → lockout, backed by the `AuthAttempt` TABLE and verified through a
  second Prisma client — deployments and multi-instance rolls can no
  longer forget it. Fail-open on a lockout-read error is a documented,
  announced availability choice.
- **CSRF / SSRF:** Origin-check on mutations (`SameSite=Lax` beneath);
  `net-guard.ts#safeFetch` blocks private/looplink/CGNAT/metadata targets,
  re-resolves DNS per hop, caps bytes and time.
- **Rate limits:** per-IP buckets remain in-process (Redis deferred — the
  one §2.1 target row still open in letter).

### 1.4 Job execution

- **Mechanism:** the Stage-3 DB-backed queue (`queue.ts` +
  `queue-handlers.ts` + `scripts/worker.mts`): jobs are claimed atomically
  (`UPDATE ... WHERE status = 'pending'` — correct on SQLite AND Postgres),
  retried with exponential backoff, cancellable across processes, capped
  per organization, and re-enqueued after process death when their kind
  can be rebuilt from DB state. The fire-and-forget model described by
  earlier versions of this document is gone.

### 1.5 Storage & binaries

- **Artifact store:** `storage.ts` key-API abstraction — LocalDisk (the
  historical `uploads/` layout, zero data migration) or any
  S3-compatible store (zero-dep SigV4 signer, path-style, R2/MinIO
  compatible; presigned delivery for `GET mp4`). Per-org quota via the
  `StorageUsage` counter.
- **Binaries:** FFmpeg/ffprobe via the zombie-aware `runProcess` wrapper
  (Linux `/proc` watchdog); Playwright/Chromium for slide rendering;
  Node 20 standalone server — not Vercel serverless.

### 1.6 Provider integrations

- **Adapters:** `providers/` — chat, tts, image, video, asr, vision,
  http, settings, registry, config. Capability dispatch resolves from
  per-user `ProviderCredential`s; the acting user's encrypted Z.ai key
  wins over the platform gateway; providers are mixable per task.
- **Budget/gate:** `budget.ts` paces every AI call (per-minute budgets,
  concurrency caps, shared 429 cool-downs). `spend.ts` is the paid-USD
  law: worst-case reservation BEFORE dispatch, the est ≥ actual
  invariant, a versioned pricing registry (provisional until an operator
  verifies it — paid dispatches are REFUSED while `PRICING_STATUS` is
  `"provisional"`), and — since S47 — shared admission across ALL
  instances (see 1.7).

### 1.7 Shared state across instances

| Concern | Mechanism | Since |
| --- | --- | --- |
| Login lockout | `AuthAttempt` table, rolling window | S46 |
| Paid-spend gate | `SpendReservation` + ONE serialized READ-check-RESERVE transaction per paid admit (Serializable on Postgres; single-writer SQLite) | S47 |
| Content policy | `Video.contentPolicy` column — the one switch every enforcement layer reads (script-pass rules, director overlay + plan sanitization, image-prompt substitution + negative clause, restricted-visual QC gate); "standard" when null | S49 |
| Job queue | DB rows claimed atomically; workers recover after death | Stage 3 |
| Sessions | `Session` rows, server-side revocation | Stage 2 |
| Rate-limit buckets | in-process (deferred to Redis) | open |
| Budget pacing / 429 cool-downs | in-process, per-instance (advisory only) | open |

S48/S49 additions to the pipeline contract: the Director plan is schema v2
(the 19-field cinematic shot; engine-verbatim camera vocabulary —
`director-plan.ts`), the Director pass pins a director-grade model hint
(`llm.ts#resolveChatModel`: operator pick > hint > gateway default), and the
content-policy system (`restricted-subjects.ts`) provides the layered
Islamic visual protection (compose → direct → paint → verify → gate;
`docs/design/s48-s49-schema.md` §3).

### 1.8 Known gaps vs the §2 target

1. Redis-backed session/rate-limit state — Sessions are DB rows; the
   per-IP rate buckets remain in-process.
2. Server-side Auto-Pilot DAG — orchestration is client-chained (poll.ts)
   plus the Director's stage orchestration; no single server-side DAG.
3. BullMQ/Redis queue — replaced by the DB-backed queue on purpose; the
   §2.1 durability goal is met in substance, not in letter.

### 1.9 The S48→S74 subsystem delta (reconciled at S75)

What the S47 reconciliation could not know — each subsystem verified in
the live tree at S75:

- **The Whiteboard Engine** (`whiteboard/` lib: renderer, svg, timing,
  storyboard, llm-planner, planner, asset-store, page/assets/upload;
  the `whiteboard-studio.tsx` + `wb-canvas.tsx` editor components; the
  `WhiteboardAssetUpload` table — the one post-S47 model). A SECOND
  render mode with a strict peer-mode law: `RENDER_MODES` gains
  `"whiteboard"`, the engine renders the standard `final.mp4` through
  the UNCHANGED QC battery and ship gate, and `runRenderJob` refuses
  the mode (the compositor never renders whiteboard). Storyboard
  intelligence is native-first: the S67 keyword rule-table planner
  (zero AI), upgraded by the S73 LLM planner (`aiCallJson` at the
  single budget choke point, per-scene native fallback, honest
  whole-project degradation). The upload path (S69) passes §7's seven
  gates. Pixels cost $0 — local Chromium + ffmpeg, no generation API.
  Design: `WHITEBOARD_ENGINE_DESIGN.md`; status: the E0–E12 matrix in
  its §9.
- **Creator Intelligence** (`hook-score.ts`, `packaging-lint.ts`,
  `shorts.ts` upgraded behind the pure-function seam,
  `retention.ts` + the `yt-analytics.readonly` scope + the
  retentionReport doc column, S70–S72). Native services,
  proposes-never-auto-edits, every score labeled a heuristic. Record:
  `docs/audits/creator-intelligence-record.md`.
- **The motion-vigor laws and their measurement lanes** — S63's
  T-63.1 tempo law + T-63.2 doctrine-always-rides law
  (`liveliness.ts#i2vMotionPrompt`), and the S74 paired re-measure
  lane (`scripts/s74-paired-remeasure.mts` + `s74-blind-score.mts`):
  OPEN, measurement gateway-gated, watcher-resumed
  (`docs/audits/s74-motion-vigor-remeasure-record.md`).
- **CI hardening** — six-job lane; the ffmpeg-install step waits out
  the boot-time dpkg-lock race then retries with per-request timeouts
  (five documented stalls receipts in the worklog); the credential-
  safe push gates (askpass, plain URL, token never in args/disk —
  `scripts/tf-push.sh`).

---

## 2. Target architecture

> **S47 status note:** this target section (and the §2.1 diff
> table) was written at Stage 1 against the pre-tenant snapshot.
> Most of its rows have since landed — tenancy, default-deny auth,
> zod validation, encrypted per-user secrets, the durable queue,
> the storage abstraction, the Director, assemble, QC, publish —
> with the remaining deltas listed in §1.8. Read §2 as history;
> §1 is the current state.

```
┌────────────────────────────────────────────────────────────────────┐
│ Browser (per user, per tenant)                                     │
│   └─ Next.js 16 App Router — React Server Components + Client       │
│       TanStack Query for cache, Zustand for local UI state          │
└────────────────────────────────────────────────────────────────────┘
                │ HTTPS (signed session cookie + CSRF token)
                ▼
┌────────────────────────────────────────────────────────────────────┐
│ Next.js 16 standalone server (Node 20) — stateless                 │
│   ├─ src/middleware.ts — required API gatekeeper                    │
│   │     (auth required by default; public allow-list only)         │
│   ├─ src/app/api/* — endpoints with zod validation + tenant scoping │
│   └─ src/lib/tubeforge/* — provider abstraction, services          │
└────────────────────────────────────────────────────────────────────┘
                │
        ┌───────┼───────┬────────────┬─────────────┐
        ▼       ▼       ▼            ▼             ▼
   PostgreSQL  Redis   Object       External      YouTube
   (Prisma +   (queue  storage      AI providers  Data API
   migrations) + session  (S3/R2/    via provider  (per-tenant
                + rate   GCS) +      abstraction   OAuth grant)
                state)  CDN         layer)
                │
                ▼
┌────────────────────────────────────────────────────────────────────┐
│ Independent production workers (long-running Node processes)        │
│   ├─ AI Director worker     (shot-list, camera, lens, coverage)    │
│   ├─ Voice worker           (TTS, voice clone, narration verify)   │
│   ├─ Scene worker           (image gen, image-to-video, stock)      │
│   ├─ Render worker          (FFmpeg + Playwright + QC)             │
│   ├─ Quality control worker (re-runnable QC checks)                 │
│   └─ Publishing worker      (YouTube upload + thumbnail + retry)   │
└────────────────────────────────────────────────────────────────────┘
```

### 2.1 Differences from current

| Aspect | Current | Target |
| --- | --- | --- |
| Tenancy | None (single owner) | Per-user + per-organization (owner/admin/editor/viewer roles) |
| Auth | Opt-in lock; gate open by default in dev | Auth required by default; production fail-safe refuses to serve if gate disabled |
| Validation | Hand-rolled string-slice + typeof on 110 endpoints | `zod` schema per endpoint; shared schemas for music/motion/transition overrides |
| Secrets | `Setting` singleton (one owner password, one YouTube grant, one set of provider keys) | `User.passwordHash`, `Organization`, `UserSetting` (per-user), `YouTubeAccount` (per-user/per-channel), `ProviderCredential` (per-user, encrypted at rest) |
| Job execution | In-process fire-and-forget; lost on restart | BullMQ + Redis; durable across worker restarts; worker auto-resumes interrupted jobs |
| Artifact store | Local `uploads/` directory | S3/R2/GCS via presigned URLs; CDN for reads; lifecycle policies for old renders |
| Session state | `__tfAuthLimit`, `__tfRateBuckets` in-memory | Redis-backed session store + Redis-backed rate-limit buckets (survive restart) |
| Provider abstraction | Partial — `providers/registry.ts` dispatches by Setting | Full — every provider call goes through a capability interface; providers can be swapped without touching call sites |
| AI Director | Heuristic, render-time (`shots.ts#planShots`, `motion.ts#planSceneMovements`) | LLM-driven pass producing shot-list, camera framing, lens suggestions, coverage plan; persisted as `Video.shotList` |
| Scene assembly | Rolled into `renderVideo` orchestrator | Separate `POST /api/videos/[id]/assemble` endpoint producing an editable preview timeline before final render commits |
| QC | Inline inside render job; not re-runnable | Separate `POST /api/videos/[id]/qc` endpoint; QC report stored on `Video.qcReport`; re-runnable without re-rendering |
| YouTube publish | `uploadToYouTube` implemented but never called | `POST /api/videos/[id]/publish` route enqueues a publish job; resumable upload with retry; thumbnail set; per-user OAuth |
| Auto-Pilot | Client-side polling + chaining | Server-side DAG: a single `POST /api/videos/[id]/autopilot` enqueues the full chain with stage-level savepoints |
| Schema management | `prisma db push` only; no migration history; manual SQL for Neon | `prisma migrate dev` + `prisma/migrations/` directory; `prisma migrate deploy` for zero-downtime prod |
| CI | None | `.github/workflows/` running `typecheck`, `lint`, `test`, and cross-tenant isolation tests on every PR |
| Security headers | None configured | CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, HSTS, COOP/COEP via `next.config.ts` `headers()` |

### 2.2 Migration strategy

We migrate incrementally, not in one operation. Each subsystem is migrated behind a well-defined interface, with the old implementation removed only after the replacement passes testing.

The order follows the roadmap stages:

1. **Stage 1 (weeks 1–2):** Clean baseline — restore missing scripts, fix broken `npm run setup`, pick one package manager, adopt `prisma migrate`, add security headers, re-enable ESLint rules, restore `__tfAuthLimit` and `__tfRateBuckets` to Redis (or document the in-memory limit for the dev sandbox).
2. **Stage 2 (weeks 3–6):** Add `User`, `Organization`, `Membership`, `UserSetting`, `YouTubeAccount`, `ProviderCredential` models. Migrate `Setting` rows to per-user scoping (one-time data migration). Add `userId`/`tenantId` to every existing model. Add a `requireUser()` helper to every endpoint. Add automated cross-tenant isolation tests in CI.
3. **Stage 3 (weeks 7–11):** Introduce BullMQ + Redis. Migrate `startJob` to enqueue work instead of running it in-process. Add a worker process. Move local `uploads/` writes to S3/R2 via presigned URLs. Replace `db/auth.lock` flag file with a Setting row + env signal. Replace Linux-only `/proc/<pid>/stat` zombie watchdog with a cross-platform child-process reaper.
4. **Stage 4 (weeks 12–15):** Redesign the 10 core UX surfaces behind a consistent design system. Split into 4a (core 5 surfaces) and 4b (remaining 5, done in parallel with Stage 5).
5. **Stage 5 (weeks 16–21):** Build the AI Director from scratch — LLM-driven shot-list, camera framing, lens suggestions, coverage plan, character continuity checks. Add per-scene regeneration with consistency scoring. Persist the director plan as `Video.shotList`.
6. **Stage 6 (weeks 22–27):** Build the Scene Assembly stage (preview timeline before final render). Wire the dead `uploadToYouTube` scaffolding into a `POST /api/videos/[id]/publish` route with per-user OAuth, resumable upload, retry, and thumbnail set. Add a separate `POST /api/videos/[id]/qc` endpoint.
7. **Stage 7 (weeks 28–32):** Add CI cross-tenant isolation tests, billing reconciliation tests, worker failure tests, mobile responsiveness tests. Run a controlled beta. Launch.

### 2.3 Architectural rules

1. **Each stage saves its outputs independently.** If scene 14 fails, TubeForge should not regenerate scenes 1–13.
2. **Every endpoint validates input with `zod`.** No hand-rolled string slicing on mutating routes.
3. **Every endpoint is tenant-scoped.** `requireUser()` returns the caller's `userId` and `tenantId`; every Prisma query includes the tenant filter; cross-tenant access tests run in CI.
4. **No synchronous heavy work in a request handler.** Anything that can take more than 1 second goes through the queue.
5. **No local filesystem writes from API routes.** All artifacts go to object storage; all reads go through CDN or presigned URLs.
6. **No in-memory security state.** Sessions, rate-limit buckets, login lockouts all live in Redis.
7. **Every provider call goes through the provider abstraction.** No direct `fetch` to a provider URL from a route handler.
8. **No `TUBEFORGE_ALLOW_PRIVATE_HOSTS=1` in production.** The opt-out is dev-only for self-hosted Ollama.
9. **No endpoint is public unless explicitly listed in `PUBLIC_API`.** Default-deny; the auth gate is required.
10. **Schema changes go through `prisma migrate dev`** with a reviewable migration file. No `prisma db push` against production.

---

## 3. Data model evolution (Stage 2 preview)

```
User
  id            String   @id @default(cuid())
  email         String   @unique
  passwordHash  String   // pbkdf2$120000$<saltB64>$<hashB64>
  emailVerifiedAt DateTime?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  memberships   Membership[]
  settings      UserSetting[]
  youtubeAccounts YouTubeAccount[]
  providerCredentials ProviderCredential[]
  videos        Video[]   // via tenant
  activities    Activity[]

Organization
  id            String   @id @default(cuid())
  name          String
  slug          String   @unique
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  memberships   Membership[]
  videos        Video[]
  channels      Channel[]
  characters    Character[]
  // ... every existing content model gets an organizationId

Membership
  id              String   @id @default(cuid())
  userId          String
  organizationId  String
  role            String   // owner | admin | editor | viewer
  createdAt       DateTime @default(now())
  user            User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  organization    Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  @@unique([userId, organizationId])

UserSetting  // replaces global Setting for per-user config
  id              String   @id @default(cuid())
  userId          String
  key             String
  value           String
  user            User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@unique([userId, key])

YouTubeAccount  // per-user, per-channel
  id              String   @id @default(cuid())
  userId          String
  channelId       String   // YouTube channel ID
  channelTitle    String?
  channelThumb    String?
  refreshToken    String   // encrypted at rest
  accessToken     String?  // 50-min cache
  tokenExpiresAt  DateTime?
  privacyStatus   String   @default("private")
  categoryId      String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  user            User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  videos          Video[]  // link Video to a specific YouTubeAccount for publish
  @@unique([userId, channelId])

ProviderCredential  // per-user provider keys
  id              String   @id @default(cuid())
  userId          String
  capability      String   // chat | tts | image | video | asr | vision
  provider        String   // zai | openai | anthropic | gemini | zhipu | elevenlabs | stability | fal | replicate | ideogram | recraft | pollinations | selfhost
  baseUrl          String?
  apiKey          String   // encrypted at rest
  isActive        Boolean  @default(true)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  user            User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  @@unique([userId, capability, provider])
```

Every existing content model (`Video`, `Channel`, `Character`, `Activity`, `ResearchSession`, `ScheduleSlot`, `VideoStat`, `VoiceProfile`, `MusicTrack`, `Job`) gains:

- `organizationId String`
- `organization Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)`
- `@@index([organizationId])`

The global `Setting` table is removed in Stage 2. Its contents are migrated:

- `auth.password` → `User.passwordHash` on the first claimed owner.
- `auth.enabled` → env-only signal (`TUBEFORGE_REQUIRE_LOCK=1` becomes the default in production; the opt-out is `TUBEFORGE_REQUIRE_LOCK=0`).
- `ytClientId`, `ytClientSecret` → server-wide config in `.env` (the OAuth client is shared across users; only the per-user refresh token is in `YouTubeAccount`).
- `ytRefreshToken`, `ytChannelTitle`, `ytChannelThumb`, `ytPrivacyStatus`, `ytCategoryId` → `YouTubeAccount`.
- `tts.*`, `zai.*`, `stock.*`, capability provider config → `ProviderCredential` + `UserSetting` (for non-secret per-user preferences).
- Music library seed defaults → `UserSetting`.

---

## 4. Worker process design (Stage 3 preview)

A single worker process consumes all job kinds from BullMQ:

```
Worker process
  ├─ AI Director queue consumer   (kind: director)
  ├─ Script queue consumer        (kind: script)
  ├─ Voice queue consumer         (kind: voiceover, voice_clone)
  ├─ Scene queue consumer         (kind: storyboard, scene, stock, slide, variants, portrait, poses)
  ├─ Render queue consumer        (kind: render, short, convert)
  ├─ Verify queue consumer         (kind: verify)
  ├─ QC queue consumer             (kind: qc)         // new in Stage 6
  ├─ Publish queue consumer        (kind: upload)     // wired in Stage 6
  └─ Analytics queue consumer      (kind: sync)       // wired in Stage 6
```

Each consumer:

- Pulls a job from its queue with visibility timeout.
- Runs the job body (the existing `lib/tubeforge/<stage>.ts` modules, unchanged in behavior).
- Saves outputs to object storage (S3/R2/GCS via `lib/tubeforge/storage.ts` abstraction — same interface as today's `videoDir()`, different backend).
- Updates the `Job` row with progress + label.
- On failure: retries with exponential backoff (BullMQ built-in); after max attempts, marks `failed` and surfaces to the user.
- On worker shutdown (SIGTERM): in-flight jobs are requeued by BullMQ; resumed by another worker (or the same one on restart).

The existing `startJob` API becomes a thin wrapper that enqueues a BullMQ job and creates the `Job` DB row. The existing `poll.ts` client pollers stay — they continue to poll `GET /api/jobs` and the per-stage status endpoints.

---

## 5. Object storage migration (Stage 3 preview)

A new `lib/tubeforge/storage.ts` module provides the same interface as today's filesystem helpers, backed by S3/R2/GCS:

```
// today
videoDir(videoId) → process.cwd() + "/uploads/" + videoId
writeSceneImage(videoId, n, buf) → fs.writeFileSync(videoDir + "/scene-NN.png", buf)
readSceneImage(videoId, n) → fs.readFileSync(videoDir + "/scene-NN.png")

// target
storage.put(videoId, `scene-NN.png`, buf, { contentType: "image/png" })
storage.get(videoId, `scene-NN.png`) → Buffer
storage.presign(videoId, `final.mp4`, { expiresInSeconds: 3600 }) → string (URL)
storage.delete(videoId, `scene-NN.png`)
storage.list(videoId) → string[]
```

Routes that stream media (`GET /api/videos/[id]/mp4`, `GET /api/videos/[id]/voiceover`, `GET /api/videos/[id]/thumbnail`, etc.) redirect to presigned URLs instead of `fs.createReadStream`. The client downloads directly from the CDN.

The `db/auth.lock` flag file becomes a `Setting` row (`auth.enabled` already is) — the middleware's `lockFlagActive()` check switches to reading an env signal (`TUBEFORGE_REQUIRE_LOCK=1`) on serverless, or a Redis key on standalone.

---

## 6. Security architecture (Stage 1 + 2)

### 6.1 Stage 1 — immediate

- Restore missing scripts (`scripts/backup.sh`, `scripts/auth-reset.mjs`) or remove their `package.json` references.
- Fix `npm run setup` to auto-detect URL protocol (like `postinstall.mjs` does) or remove the ambiguous script.
- Add security headers via `next.config.ts` `headers()` — CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, HSTS.
- Re-enable ESLint rules: `@typescript-eslint/no-explicit-any`, `@typescript-eslint/no-unused-vars`, `react-hooks/exhaustive-deps`, `no-console`, `no-debugger` (warn level).
- Pick one package manager; delete the other lockfile; align all scripts; update `SETUP.md`.
- Add CI: `.github/workflows/ci.yml` running `typecheck`, `lint`, `test`.
- Add `prisma migrate dev` workflow; create the first migration from the current schema.
- Eliminate D-27 (first-come race on `/api/auth/setup`): add `TUBEFORGE_OWNER_TOKEN` env bootstrap so the first call must present it.

### 6.2 Stage 2 — multi-tenant

- Add `User`, `Organization`, `Membership`, `UserSetting`, `YouTubeAccount`, `ProviderCredential` models.
- Add `requireUser()` and `requireRole(role)` helpers used by every endpoint.
- Migrate the existing `Setting` rows to per-user scoping.
- Add automated cross-tenant isolation tests in CI: two test accounts; assert no access to each other's projects, files, jobs, credentials, generated content.
- Move session state, rate-limit buckets, and login lockouts to Redis (survive restart).
- Replace the in-memory `__tfBudget` pacing state with Redis-backed pacing (or accept that AI budget resets on restart as a degraded mode).
- Encrypt `ProviderCredential.apiKey` and `YouTubeAccount.refreshToken` at rest with a `TUBEFORGE_ENCRYPTION_KEY` env var.

### 6.3 Default-deny auth model

Today the studio is opt-in (open by default). For a multi-user SaaS, the model flips:

- Auth is required by default for every `/api/*` route.
- The public allow-list shrinks to `/api/auth/{status,login,logout,register,verify-email,reset-password}`.
- The production fail-safe refuses to serve any non-auth endpoint if `TUBEFORGE_AUTH_SECRET` is missing.
- The `db/auth.lock` flag file is removed; the gate is always active when `TUBEFORGE_AUTH_SECRET` is set.

The recovery path (`bun run auth:reset` / `npm run auth:reset`) becomes a CLI that resets a specific user's password by email, not a global lock toggle.

---

## 7. Observability (Stage 3)

Today there are no centralized logs and no error tracking. Stage 3 introduces:

- **Structured logs:** JSON logs to stdout with `pino` or `winston`; request ID, user ID, organization ID, job ID, stage.
- **Error tracking:** Sentry or self-hosted GlitchTip for unhandled exceptions in API routes and worker processes.
- **Job metrics:** BullMQ built-in dashboard or a custom `/admin/jobs` panel showing queue depth, throughput, failure rate, p50/p95 latency per kind.
- **Provider spend:** per-user, per-capability cost tracking in a new `UsageRecord` model; surfaces in the admin dashboard (Stage 2 admin workspace) and in the user's billing page.
- **Render performance:** FFmpeg wall-clock per video; QC check pass rate; interrupted-job recovery rate.

---

## 8. The release gate (restated)

The release gate from `MASTER_PLAN.md` §10:

> A new user can: register, create a project, generate a complete cinematic video, edit individual scenes, export it, and manage their subscription securely.

Architecturally this requires:

- ✓ Stage 2: User registration + login + per-user projects.
- ✓ Stage 5: AI Director producing a complete cinematic video.
- ✓ Stage 6: Scene editing + export.
- ✓ Stage 6: YouTube publish (or at minimum, export to file).
- ✓ Stage 7: Billing + subscription management (Stripe or equivalent) + billing reconciliation tests in CI.

The architecture is the contract. The roadmap (`ROADMAP.md`) is the schedule. The task backlog (`TASKS.md`) is the work.
