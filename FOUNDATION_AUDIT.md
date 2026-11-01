# TubeForge Foundation Audit — Stage 1

**Audited:** 2026-11-01
**Codebase:** `/home/z/my-project/` (Next.js 16, Prisma, TypeScript)
**Audit type:** Static read-only. No builds, tests, or modifications were run.
**Auditor:** Z.ai (Stage 1 of the 28-week product development plan)

---

## Executive summary

TubeForge is a working single-user AI video production studio. The pipeline is real and well-instrumented per stage: jobbed routes, persistent `Job` rows with restart-recovery, a retry/budget layer for AI calls, a 10-check QC battery, and render-time shot/motion planners. The application can already take an idea through script, storyboard, voiceover, render, QC and export.

The audit identified **four blocking seams** that must be addressed before TubeForge can be a multi-user SaaS product:

1. **Single-tenant schema.** Every Prisma model lacks `userId`/`tenantId`. The `Setting` table is a singleton per key — one owner password, one YouTube OAuth grant, one set of provider keys per install. Every one of the 110 endpoints assumes one user.
2. **Synchronous-in-request heavy work.** Single-video script generation (`POST /api/videos`), research, greenlight and character bible all block the HTTP request through multi-minute LLM calls. The worker body that would fix this (`script-job.ts`) exists but is dead code.
3. **Local filesystem as the artifact store.** ~30 endpoints write to `process.cwd()/uploads/<videoId>/…`. The `db/auth.lock` flag file and the Linux-only `/proc/<pid>/stat` zombie watchdog will not survive a serverless deployment.
4. **YouTube publishing is dead scaffolding.** `uploadToYouTube` is implemented but never called. `Video.youtubeUrl` is never written. The plan's "Export/Publish" stage does not exist in code.

Beyond these, the "AI Director" stage from the target pipeline is only present as heuristic render-time planners — there is no LLM-driven shot-list / camera / lens / coverage pass. Stage 5 of the roadmap will need to build this from scratch.

### Numbers at a glance

| Metric | Value |
| --- | --- |
| API route files | 71 |
| API endpoints (method-separated) | 110 |
| Prisma models | 11 (none carry `userId` / `tenantId`) |
| Endpoints touching the singleton `Setting` table | 13 |
| Endpoints writing to local disk | ~30 |
| Endpoints spawning in-process long jobs | 15 (`startJob`) |
| Endpoints doing synchronous heavy work in-request | 10 |
| Endpoints using `zod` for input validation | 0 of 110 |
| Endpoints with external server-side fetch | 18 (all guarded by `safeFetch` or hardcoded URLs) |
| CRITICAL findings | 1 (`/api/auth/setup` first-come race) |
| HIGH findings | ~28 |
| In-memory `globalThis.__tf*` symbols | 9 (6 caches + 2 security regs + 1 job runner) |
| Migration files | 0 (`prisma db push` only) |
| CI workflows | 0 |
| Test files using `*.test.ts`/`*.spec.ts` convention | 0 (formal suite lives in `scripts/test-unit.ts`) |

---

## 1. Codebase inventory

### 1.1 Stack

- **Framework:** Next.js 16 (`next@^16.1.1`) — App Router, React 19, standalone build output.
- **Database:** Prisma 6 with two parallel schemas — `prisma/schema.prisma` (PostgreSQL, default) and `prisma/schema.sqlite.prisma` (local dev). No `prisma/migrations/` directory; schema management is `prisma db push` only.
- **Auth:** Self-rolled HMAC-SHA256 signed cookies + Bearer tokens, PBKDF2-SHA256 120k iterations for the owner password. `next-auth` is in `package.json` but not wired — the studio uses its own opt-in lock model.
- **UI:** Tailwind v4 (CSS-based config in `src/app/globals.css`), shadcn/ui-style components in `src/components/ui/`, framer-motion, Zustand store, TanStack Query.
- **AI providers:** `src/lib/tubeforge/providers/` has adapters for `chat`, `tts`, `image`, `video`, `asr`, `vision`. Default Z.ai SDK (`z-ai-web-dev-sdk`); OpenAI/Anthropic/Gemini-compatible via baseUrl overrides.
- **Media pipeline:** FFmpeg + ffprobe via the zombie-aware `runProcess` wrapper (`proc.ts`). Playwright/Chromium for keynote slides. CogVideoX i2v for "animated" render mode.
- **Test runner:** `bun scripts/test-unit.ts` (726 lines, custom harness, ~342 checks).

### 1.2 Application modules

Source lives entirely under `src/`. Top-level modules:

- `src/app/api/` — 71 route files, 110 endpoints (full inventory in §2).
- `src/app/page.tsx`, `src/app/layout.tsx`, `src/app/globals.css`, `src/login/page.tsx` — the single-page studio shell.
- `src/components/ui/` — shadcn/ui-style primitives (45 files).
- `src/components/tubeforge/` — studio views (`dashboard-view.tsx`, `create-view.tsx`, `library-view.tsx`, `channels-view.tsx`, `cast-view.tsx`, `calendar-view.tsx`, `research-view.tsx`, `analytics-view.tsx`, `settings-view.tsx`), plus `app-sidebar.tsx`, `scene-editor.tsx`, `auth-gate.tsx`, `video-detail-dialog.tsx`, `motion-controls.tsx`, `transition-controls.tsx`, `music-controls.tsx`, `brand-kit.tsx`, `attention-panel.tsx`, `pwa.tsx`, `security-card.tsx`, `logo.tsx`, `brand.tsx`, `shared.tsx`.
- `src/lib/tubeforge/` — 53 library modules (full list in §3 of the pipeline trace).
- `src/lib/tubeforge/providers/` — 8 provider adapters.
- `src/middleware.ts` — opt-in API gatekeeper.
- `prisma/schema.prisma`, `prisma/schema.sqlite.prisma` — 11 models, no migration history.

### 1.3 Database models (`prisma/schema.prisma`)

| Model | Purpose | Has `userId`? | Has `tenantId`? |
| --- | --- | --- | --- |
| `Channel` | YouTube channel profile (one record per channel) | No | No |
| `Character` | Cast member with portrait + poses | No | No |
| `Video` | The core entity — script, scenes, voiceover, render, QC, music, motion, transitions, brand kit | No | No |
| `Activity` | Per-stage audit log | No | No |
| `ResearchSession` | Topic Radar idea scan | No | No |
| `ScheduleSlot` | Publishing calendar slot | No | No |
| `VideoStat` | YouTube analytics snapshot | No | No |
| `Setting` | Key-value singleton (auth password, provider keys, YouTube OAuth tokens) | No | No |
| `VoiceProfile` | Cloned voice (zhipu or self-hosted) | No | No |
| `MusicTrack` | Background music library with license record | No | No |
| `Job` | Persistent job registry (running / done / failed / interrupted / cancelled) | No | No |

**Verdict:** every model is global. Multi-tenant migration touches every model + every endpoint.

### 1.4 Existing repo-level docs

- `SECURITY.md` (last updated 2025-10-28) — accurate description of the opt-in lock, password hashing, brute-force lockout, CSRF, sessions, API tokens, SSRF, secrets in responses, distributables, backups. **Worth keeping; the audit confirms everything it claims.**
- `SETUP.md` — 5-step setup (npm install → setup:local → dev → :3000 → Settings → AI Providers).
- `worklog.md` — 840-line development log covering Phase 1 → packaging → security hardening pass.

---

## 2. API route security & dependency map

This is the per-endpoint inventory. **Auth** = `✓` (middleware-gated when lock on) / `PUBLIC` (in `PUBLIC_API`) / `BOOT` (only in `PROD_BOOTSTRAP_API`). **Validation:** `zod` / `manual` / `none`. **Risk:** `LOW` / `MEDIUM` / `HIGH` / `CRITICAL`. Full per-route table is in the [route audit appendix](#appendix-a--full-route-table); summary findings below.

### 2.1 Public routes (no auth required)

| Route | Why public |
| --- | --- |
| `GET /api` | Trivial health check. |
| `POST /api/auth/setup` | First-run password claim. `PUBLIC_API`. 403s once configured. |
| `POST /api/auth/login` | Password verify + cookie mint. `PUBLIC_API`. Rate-limited 5/10min per IP. |
| `POST /api/auth/logout` | Cookie clear. `PUBLIC_API`. |
| `GET /api/auth/status` | Lock state booleans. `PUBLIC_API`. |
| `POST /api/auth/lock` | Bootstrap-superset only; under active gate it requires the existing password. |
| `GET /api/youtube/callback` | OAuth code-exchange landing (Google redirect). NOT in `PUBLIC_API`, but works because the user's session cookie travels with the browser redirect; CSRF-guarded by stored `ytOAuthState`. |

### 2.2 CRITICAL / HIGH findings

**CRITICAL (1)**

- `src/app/api/auth/setup/route.ts:15` — `POST /api/auth/setup` is publicly reachable on a fresh install and creates the owner password (first-come race). Mitigations exist (403s after configured; requires `TUBEFORGE_AUTH_SECRET`; production fail-safe 503s everything else). **Mitigation for Stage 2:** add a `TUBEFORGE_OWNER_TOKEN` env bootstrap so the first call must present it, or require the setup to happen during a one-time install window.

**HIGH (28)** — selected highlights (full list in [Appendix A](#appendix-a--full-route-table)):

- `src/app/api/videos/route.ts:41` (POST) — synchronous full script generation in-request; the worker body `runScriptJob` exists but is never called (`script-job.ts:35-174` is dead code).
- `src/app/api/videos/batch/route.ts:82` — N parallel in-process script jobs (count 2-6); unbounded concurrent AI calls if multiple batch requests land.
- `src/app/api/research/route.ts:24` and `/api/research/[id]/greenlight/route.ts:29` — synchronous LLM calls in-request.
- `src/app/api/characters/bible/route.ts:13` — synchronous ~5-8s LLM call in-request.
- `src/app/api/videos/[id]/render/route.ts:51` — long in-process render + ffmpeg composite + QC (can take minutes).
- `src/app/api/videos/[id]/route.ts:207` (DELETE) — deletes DB row but leaves `uploads/<id>/` orphaned on disk.
- `src/app/api/settings/ai/route.ts:71` (PUT) — saves Z.ai global creds + per-capability provider config to the singleton `Setting` table.
- `src/app/api/settings/ai/route.ts:162` (POST) — fires real chat/tts/image/video calls with user-supplied `baseUrl` overrides; mitigated by `providerFetch → safeFetch`.
- `src/app/api/youtube/config/route.ts:10` (PUT) — saves OAuth client secret to the singleton `Setting` table.
- `src/app/api/youtube/sync/route.ts:11` — synchronous YouTube Data API call in-request.

### 2.3 Routes that assume single-user (multi-tenant migration blocker)

Every model lacks `userId`/`tenantId`. The `Setting` table is the most acute blocker because it's a singleton per key — one row per key, no scoping.

Routes reading or writing the `Setting` table (13 endpoints):

- All of `/api/auth/*` (single owner password)
- All of `/api/settings/*` (single set of provider keys, TTS config, stock keys, AI provider config)
- All of `/api/youtube/*` (single YouTube OAuth grant)
- `/api/music` (reads `Setting` for music library seeding defaults)

Beyond `Setting`, every content route (Channel, Character, Video, Activity, ResearchSession, ScheduleSlot, VoiceProfile, MusicTrack, VideoStat, Job) is also single-tenant because none of those tables have an `ownerId`/`tenantId`. A multi-tenant migration touches every one of the 110 endpoints — every list/findUnique/update/delete needs a `where: { userId, … }` filter.

### 2.4 Routes with external fetch (SSRF surface)

Every external server-side fetch is either to a hardcoded upstream (Google OAuth, Pexels, Pixabay, Zhipu) or to a user-supplied URL guarded by `safeFetch`:

| Surface | Guard |
| --- | --- |
| User-supplied audio URL (`POST /api/voices/clone`, `POST /api/videos/[id]/voiceover` mode=url) | `safeFetch` via `net-guard.ts` — http(s) only, private-IP blocklist, manual redirect re-resolve, byte cap, timeout. |
| User-supplied provider baseUrl (`POST /api/settings/ai`, `PUT /api/settings/tts`) | `providerFetch → safeFetch`. `TUBEFORGE_ALLOW_PRIVATE_HOSTS=1` opt-out exists for self-hosted/Ollama. |
| Hardcoded upstreams | Google OAuth token exchange + YouTube Data API, Pexels, Pixabay, Zhipu. |

**Residual risk:** the `TUBEFORGE_ALLOW_PRIVATE_HOSTS=1` opt-out bypasses the private-IP blocklist for provider calls. Voice/media URLs stay locked regardless.

### 2.5 Routes that write to local disk (serverless blocker)

~30 endpoints write to `process.cwd()/uploads/<entityId>/…` or `db/auth.lock`. Read-only streamers (`GET …/mp4`, `GET …/voiceover`, `GET …/thumbnail`, etc.) also need a backed filesystem. The full list is in [Appendix A](#appendix-a--full-route-table).

**Migration target:** an object store (S3 / Cloudflare R2 / GCS) with presigned URLs. ~30 endpoints affected.

### 2.6 Routes that spawn long jobs (need queue migration)

15 endpoints use `lib/tubeforge/jobs.ts#startJob()` — fire-and-forget inside the Node process, deduped via a `globalThis` map, with `Job` table rows for crash recovery. None are queue-backed. Serverless cold-start kills running jobs (the `runRecovery()` function marks them `interrupted` on next request).

10 additional endpoints do synchronous heavy work in-request (LLM, TTS, ffmpeg) that should also be jobbed but isn't:

- `POST /api/videos` — full script generation (can take 30s+).
- `POST /api/videos/analyze-script` — LLM analysis.
- `POST /api/research` and `POST /api/research/[id]/greenlight` — LLM scans + script generation.
- `POST /api/characters/bible` — LLM character bible.
- `POST /api/settings/ai` and `POST /api/settings/voices/preview` — real provider test calls.
- `POST /api/voices/clone` — Zhipu clone API + ffmpeg normalize.
- `POST /api/youtube/sync` — YouTube Data API batched call.

**Migration target:** BullMQ + Redis, Inngest, or a DB-backed queue polled by a worker process. ~25 endpoints affected.

### 2.7 Input validation gap

**0 of 110 endpoints use `zod`.** Every route uses hand-rolled `String(body.x ?? "").trim()` + `.slice(0, N)` + `typeof` checks. Known weaknesses:

- No type coercion (a JSON number where a string is expected silently passes through `String(...)` as `"NaN"` or `"undefined"`).
- No nested object validation.
- No discriminated unions for multipart vs JSON branches (`/api/music`, `/api/videos/[id]/voiceover` switch on content-type with manual branching).
- The music/motion/transition override block is duplicated across 4 video-create/patch routes — same field list, four copy-pasted validators.

Thinnest validation (worst gaps):

- `PATCH /api/channels/[id]` — accepts `body.niche`/`body.description` of any length.
- `PATCH /api/characters/[id]` — `body.role`, `body.personality`, `body.appearance` written as-is (no length cap on PATCH; POST has caps).
- `PATCH /api/schedule/[id]` — `body.title?.trim()` no length cap.
- `PATCH /api/videos/[id]` — `body.title.slice(0, 120)` but `body.description`/`body.tags` written verbatim with no cap.

### 2.8 Path traversal / id-validation notes

- `params.id` is never regex-validated but is always used as a Prisma `findUnique({ where: { id } })` — invalid ids return 404, not a traversal. ✓
- `params.pose` is whitelisted against the `POSES` array in `characters.ts`. ✓
- `params.style` in `/api/videos/[id]/variants/[style]/route.ts:13` is `/^[\w-]+$/`-validated. ✓
- `params.n` in `/api/videos/[id]/storyboard/[n]`, `…/slides/[n]`, `…/stock/[n]` is passed through `Number(n)` — non-integer `n` produces `NaN`, which `path.join` would coerce to `"NaN"` (no traversal, but produces wrong filenames). Low risk.

---

## 3. Video generation pipeline trace

The target pipeline (per the master plan) is:

> Idea → Research/Script → AI Director → Storyboard → Scene Asset Generation → Voice/Sound → Scene Assembly/Editing → Rendering → QC → Export/Publish

The actual code implements these stages as follows.

### 3.1 Idea / Research / Script generation

| Entry point | Jobbed? | File |
| --- | --- | --- |
| `POST /api/videos` (single create) | **No — synchronous in-request** | `src/app/api/videos/route.ts:41-357` |
| `POST /api/videos/analyze-script` | No — synchronous LLM | `src/app/api/videos/analyze-script/route.ts:17-49` |
| `POST /api/research` (Topic Radar) | No — synchronous LLM | `src/app/api/research/route.ts:24-67` |
| `POST /api/research/[id]/greenlight` | No — synchronous LLM | `src/app/api/research/[id]/greenlight/route.ts:29-213` |
| `POST /api/videos/batch` | **Yes** — `startJob(videoId, "script", …)` × N | `src/app/api/videos/batch/route.ts:82-252` |
| `POST /api/videos/[id]/script` (re-roll) | Yes — `startJob(id, "script", …)` | `src/app/api/videos/[id]/script/route.ts:44` |

**Dead code:** `src/lib/tubeforge/script-job.ts:35-174` — `runScriptJob(videoId)` implements the correct worker pattern (6 storm rounds × ~16.5 min backoff, escalating 3/6/10/15/20 min cool-downs ≈ 2.5 h auto-patience, cancellation support). Grep confirmed it is referenced only inside its own file. The single-video create path should call it the way `batch/route.ts:156` already does.

**Provider & retry layer:** all `providers/chat.ts` calls go through `budget.ts#aiCall(service, label, fn)` — pacing (per-minute budget), concurrency caps (`MAX_CONCURRENT`), shared 429 cool-downs, 3-attempt exponential backoff. 5-minute timeout via `AbortSignal.timeout` in `http.ts:7,92`.

### 3.2 Storyboard / Scene planning

- Route: `POST /api/videos/[id]/storyboard` (`storyboard/route.ts:34-217`) — **jobbed**. Full storyboard via `startJob(id, "storyboard", …)`; single-scene re-roll via `startJob(\`${id}#scene${sceneIndex}\`, "scene", …)`. Returns 202 immediately. Cancellation checkpoints at `route.ts:152,164`.
- Scene representation: `prisma/schema.prisma:60` — `scenes String?` is a JSON-encoded array of `Scene` (`src/lib/tubeforge/types.ts:209-226`): `{index, title, narration, visual, camera, mood, caption, hostInScene, rehook, sfx, focal?, stock?, style?, seedVariant?}`.

**Is there an "AI Director" today? — No.**

The LLM emits the flat per-scene fields (`visual`, `camera`, `mood`, `caption`, `focal`, `sfx`) inside the script JSON itself (`convert.ts:107-128`, `story.ts:147-160`). There is no separate LLM-driven director pass that produces a shot-list, lens choice, coverage plan, or wide→medium→close-up ordering.

The closest thing to a "Director" is two **heuristic, render-time** planners (no LLM):

- `src/lib/tubeforge/shots.ts:54-83` — `planShots(dur)` subdivides each scene into ≤3 s shots with rotated framings (`SHOT_FRAMINGS` lines 30-37) and camera moves (`SHOT_CAMERAS` line 40). Invoked at render time only.
- `src/lib/tubeforge/motion.ts` — `planSceneMovements` picks per-scene Ken Burns moves from scene metadata (face/map/landscape/action classification is heuristic, not LLM).

Stage 5 of the roadmap will need to build the AI Director from scratch.

### 3.3 Scene asset generation

| Route | Jobbed? | Files written |
| --- | --- | --- |
| `POST /api/videos/[id]/storyboard` | Yes (202) | `uploads/<videoId>/scene-NN.png` |
| `POST /api/videos/[id]/slides` | Yes (202, kind "slide") | `uploads/<videoId>/slide-NN.png` (rendered by Playwright/Chromium at `slides.ts:883-908`) + `slides.json` |
| `POST /api/videos/[id]/variants` | Yes (202, kind "variants") | `uploads/<videoId>/variant-<style>.png` ×3 |
| `POST /api/videos/[id]/stock` and `…/stock/[n]` | Yes (202, kind "stock") | `uploads/<videoId>/scene-NN-stock.<ext>` (Pexels/Pixabay fetch) |
| `PATCH /api/videos/[id]/scenes` | No (sync DB edit only) | — |
| `POST /api/characters/[id]/portrait` | Yes (202, kind "portrait") | `uploads/characters/<id>/portrait.png` |
| `POST /api/characters/[id]/poses` | Yes (202, kind "poses") | `uploads/characters/<id>/pose-<id>.png` ×3 |

Image provider abstraction: `providers/image.ts:105-130` dispatches to 8 providers (zai/openai/stability/fal/replicate/ideogram/recraft/pollinations). Identity-locked edits via `imageEdit` only on zai + gpt-image-1. 150s timeout on Z.ai SDK calls.

### 3.4 Voice / audio production

- Route: `POST /api/videos/[id]/voiceover` (`voiceover/route.ts:26-241`) — **jobbed** via `startJob(id, "voiceover", …)`. Three modes: TTS / multipart upload / URL download (the URL mode uses `safeFetch`).
- TTS stack: `providers/tts.ts` — `zai` (SDK), `zhipu` (GLM-TTS, also accepts cloned voice ids), `openai`-compatible (`audio/speech`), `selfhost` (Chatterbox on user's PC). All go through `providerFetch` → 5-min timeout.
- Bring-your-own-voice: `voice.ts` — `isValidAudioUrl` SSRF guard (lines 44-57), `ingestCustomAudio` (lines 175-258): `ffprobe` validates, `ffmpeg` normalizes to 24 kHz mono PCM-16 WAV, then for story videos cuts into per-scene WAVs via `cutVoiceoverIntoScenes` (`convert.ts:184-288` using `silencedetect`).
- Voice cloning: `voice-clone.ts` — Zhipu GLM-TTS-Clone API; VoiceProfile rows persist `providerVoiceId`, `sampleWav` (base64) for self-hosted re-send per synthesis.
- Audiomix: `audiomix.ts` — single source of truth. Delivery targets: integrated LUFS -16, truePeak -1 dBTP, LRA 11. Ducking via `sidechaincompress`. Linear two-pass loudnorm.
- SFX: `sfx.ts` — 4 cues (whoosh/boom/riser/sting) **synthesized from ffmpeg filters** (no third-party audio). Royalty-free by construction.
- Music: `music.ts` — library tracks under `uploads/_music/`. TubeForge-original beds synthesized in-app from pure oscillators. Per-video overrides via Video columns.

### 3.5 Scene assembly / editing / rendering

- Route: `POST /api/videos/[id]/render` (`render/route.ts:51-257`) — **jobbed** via `startJob(id, "render", …)`. Returns 202. Stage interlocks against concurrent voiceover regen (line 74-78). Cancellation checkpoint at `route.ts:164`.
- Rendering binary: **FFmpeg + ffprobe** exclusively via the zombie-aware `runProcess` wrapper in `proc.ts:48-142`. Linux-only `/proc/<pid>/stat` zombie watchdog (lines 37-46) — will not work on macOS/Windows hosts. Slides mode also requires **Playwright/Chromium** (`slides.ts:883`).
- Renderer: `render.ts:735-933` — `renderVideo(opts)`:
  1. Per-scene timing from narration WAVs.
  2. Smart Motion plans via `planSceneMovements`.
  3. Per-scene segment built; for "animated" mode calls CogVideoX i2v.
  4. Stitch via concat demuxer ("cut") or xfade/acrossfade (15-style catalog in `transitions.ts`).
  5. Smart SRT via `buildSmartSrt` (audio-synced captions).
  6. Music + ducking + loudnorm finalize.
  7. Output to `uploads/<videoId>/final.mp4` or `preview.mp4`. Temp work in `render-tmp/`.

**Render modes (Video.renderMode):** `kenburns | stock | slides | animated`. `animated` = CogVideoX i2v (~4 min/scene — `poll.ts:160` timeout 50 min).

**No separate "Scene Assembly / Editing" stage.** The plan separates Storyboard → Scene Assembly/Editing → Rendering. In code, scene assembly (per-scene segment build + transition stitching + music + captions + loudnorm) is rolled into the monolithic `renderVideo` orchestrator. There is no preview-assembly stage where the user can reorder scenes, trim timing, or substitute assets before the final render commits.

### 3.6 QC and Export

**QC:** `qc.ts:191-452` — `runQcReport(opts)` runs a 12-check battery:

1. playability (H.264 video + AAC audio)
2. duration vs narration length
3. black-frames (`blackdetect=d=0.25:pix_th=0.10`, transition-aware)
4. frozen-frames (`freezedetect`)
5. aspect (frame geometry vs 16:9 or 9:16)
6. loudness (integrated LUFS in `[-19.5, -13.0]`)
7. true-peak (≤ -1 dBTP + 0.2 dB AAC tolerance)
8. loudness-range (LRA ≤ 18 LU)
9. dead-air (silence ≥1.5 s inside the video)
10. static-shots (sampled visual-change detection)
11. tail-fade (final 0.4 s should sit in fade/silence)
12. captions (SRT cues monotonic, non-overlapping, inside duration)

Each check has 3-state status: `pass | fail | unmeasured`. QC runs **inline inside the render job** (`render/route.ts:172-180`, after a successful `final.mp4` only). The report is persisted on `Video.qcReport`. **The QC stage is NOT a separate API endpoint** — it cannot be re-run independently.

**Verify (ASR narration check):** `POST /api/videos/[id]/verify` (`verify/route.ts:13-55`) — **separately jobbed** (`startJob(id, "verify", …)`). `verify.ts` transcribes the voiceover via ASR, computes word-coverage similarity vs the script, reports per-scene drift for story videos. Stored on `Video.verifyReport`.

**Quality gate (image VLM):** `quality.ts:1-60` — `runQualityGate` runs a VLM inspection on thumbnails and storyboard scene art. Called from `story.ts:630-636` for every scene image. Fails open (line 10-11).

**Export:** `GET /api/videos/[id]/export` (`export/route.ts:16-259`) — builds an in-memory ZIP via `buildZip(files)` containing script, voiceover, scenes, captions, `final.mp4`, thumbnails, variants, credits, engagement kit, `metadata.json`. **Memory-bound** — entire ZIP buffered into a single `NextResponse`.

**MP4 streaming:** `GET /api/videos/[id]/mp4` (`mp4/route.ts:12-87`) — supports HTTP Range requests (206 partial content), but reads the entire file into memory via `fs.readFileSync`. Memory-bound for large videos.

### 3.7 YouTube publishing — dead scaffolding

- OAuth flow: `POST /api/youtube/connect` builds Google consent URL (sets `ytOAuthState` Setting for CSRF); `GET /api/youtube/callback` verifies state, exchanges code, stores `ytRefreshToken`, `ytChannelTitle`, `ytChannelThumb` in the `Setting` table.
- All credentials live as flat `Setting` rows: `ytClientId`, `ytClientSecret`, `ytRefreshToken`, `ytChannelTitle`, `ytChannelThumb`, `ytPrivacyStatus`, `ytCategoryId`. **This is the single-tenant blocker** — one TubeForge install = one YouTube channel.
- Access token cache: `youtube.ts:105-106` — `__tfYtToken` on `globalThis`; refreshed every ~50 min. On `invalid_grant` the refresh token is cleared so the UI can prompt reconnect.
- **`uploadToYouTube(input)` is defined at `youtube.ts:292-382`** (resumable upload: init at 314, PUT bytes at 336-343, set custom thumbnail at 362-372). **Grep confirmed it is referenced only inside its own file — never called from any route.**
- `JobKind "upload"` is defined (`jobs.ts:26, 85, 116, 130, 321`) and listed in `cancel/route.ts:27`. `pollUpload(videoId)` exists in `poll.ts:224-231` polling for `v.youtubeUrl`. But `Video.youtubeUrl` is **never written** anywhere.
- `PATCH /api/videos/[id]` (`route.ts:167-192`) sets `status:"published"` but only writes an `Activity` row ("Published to YouTube queue — …"). No upload fires.

**Verdict:** the publish stage is **dead scaffolding**. `uploadToYouTube` is implemented but no route wires it. The plan's "Export/Publish" stage does not exist in code.

### 3.8 Job persistence

- Schema: `Job { id, kind, entityId, status ("running"|"done"|"failed"|"interrupted"|"cancelled"), progress?, label?, error?, startedAt, endedAt, … }`. Comment lines 249-251 explicitly call out the "interrupted recovery" design.
- Implementation: `jobs.ts` — **HYBRID model**. Live state is the in-memory `state.running: Map<string, RunningEntry>` (lines 50, 59-66), queried by `isJobRunning`. The `Job` DB row is created alongside for: progress persistence, history panel, and boot recovery.
- The job body runs **in-process** via `void fn().then(...).catch(...).finally(...)` at lines 265-293. **No worker queue, no separate process.** If the server dies, the in-flight work dies with it.
- Boot recovery: `runRecovery()` (`jobs.ts:101-149`) — any `running` Job row whose `startedAt < state.bootTs` is from a dead process. Marked `interrupted`. The owning video gets a visible error so polling clients stop waiting. Triggered lazily by `ensureRecovered()` on every `startJob` and `jobHistory`.

### 3.9 In-memory `globalThis.__tf*` state (won't survive restart)

| Symbol | File:line | What's lost on restart |
| --- | --- | --- |
| `__tfJobs` | `jobs.ts:58` | Running job Map — in-flight work dies; recovery marks DB rows `interrupted` but the computation is gone |
| `__tfBudget` | `budget.ts:45-54` | AI rate-budget pacing, concurrency state, shared 429 cool-downs, FIFO queue chains, active call counts — all reset → callers may flood upstream immediately on restart |
| `__tfAuthLimit` | `auth.ts:189-190` | Login throttle buckets — **security regression** (brute-force counters reset) |
| `__tfRateBuckets` | `rate-limit.ts:18-21` | API rate-limit buckets — **DoS protection resets** on restart |
| `__tfCancel` | `cancel.ts:30-31` | Cancellable-sleep state — cancellation signal lost |
| `__tfLLM`, `__tfTTS`, `__tfYtToken`, `zaiInstance` | various | Settings/token caches (safe; re-read or re-refresh from DB) |

### 3.10 Architectural seams (file:line references)

**A. Synchronous-in-request work that should be in a worker**

- `src/app/api/videos/route.ts:247` and `:298` — `generateSceneScriptPackage` / `generateScriptPackage` inside `POST /api/videos`.
- `src/app/api/research/[id]/greenlight/route.ts:127` and `:141` — same calls inside the request.
- `src/app/api/videos/analyze-script/route.ts:41` — `analyzeScript` LLM round-trip.
- `src/app/api/research/route.ts:38` — `generateTopicResearch`.
- `src/app/api/youtube/sync/route.ts:19` — `syncYouTubeStats` (acknowledged in comment as "Fast enough to run synchronously" — defensible).
- `src/lib/tubeforge/script-job.ts:35-174` is **dead code** — the correct worker pattern, never invoked.

**B. In-memory state that won't survive restart** — see §3.9.

**C. Local filesystem writes that won't work on serverless**

- `src/lib/tubeforge/ai.ts:19-25` — `UPLOAD_ROOT = process.cwd() + "/uploads"`. Every stage writes here: `scene-NN.png`, `scene-NN.wav`, `voiceover.wav`, `final.mp4`, `preview.mp4`, `subtitles.srt`, `short.mp4`, `shot-NN-k.png`, `slide-NN.png`, `slides.json`, `stock-NN.mp4`, `render-tmp/*`, `brand-logo.*`.
- `src/lib/tubeforge/sfx.ts:28` — `uploads/_sfx/<kind>.wav` (cross-video cache).
- `src/lib/tubeforge/music.ts:36` — `uploads/_music/` (library tracks).
- `src/lib/tubeforge/proc.ts:55-56` — `os.tmpdir() + "tf-run-*.out/.err"`.
- `src/lib/tubeforge/slides.ts:886` — `tmp-<stamp>.html` written into `videoDir` for Playwright `file://` load.
- `src/app/api/videos/[id]/mp4/route.ts:12-87` and `render.ts:729` — `fs.readFileSync(final.mp4)` for streaming (memory-bound + local FS).
- `next.config.ts:4` — `output: "standalone"` (Node server target, NOT Vercel serverless), but routes still call `fs.writeFileSync` directly which serverless would reject at runtime.
- `src/lib/tubeforge/proc.ts:37-46` — `/proc/<pid>/stat` zombie watchdog is **Linux-only** (will not run on macOS/Windows hosts).

**D. Provider calls without timeout/retry**

Have timeout & retry (good): all AI provider calls (`chat`, `image`, `tts`, `asr`, `vision`) — wrapped by `budget.ts#aiCall` with pacing + 3-attempt exponential backoff + shared 429 cool-down + 5-minute timeout.

Missing timeout / retry (concerning) — the entire YouTube path:

- `youtube.ts:123-132` — OAuth token refresh fetch — no timeout, no retry.
- `youtube.ts:166-169` — `fetch("...channels?part=snippet&mine=true")` — no timeout.
- `youtube.ts:218-221` — stats sync fetch — no timeout, no retry.
- `youtube.ts:314-326` — resumable upload session init — no timeout.
- `youtube.ts:336-343` — upload body PUT — no timeout, no retry, no resume (the comment "resumes once on a transient failure" at line 332 is aspirational; the catch at 344-349 throws, no retry).
- `youtube.ts:362-372` — `fetch("...thumbnails/set...")` — no timeout.

A single Google 500 fails the upload outright.

**E. Missing stages vs. the target pipeline**

1. **No "AI Director" stage.** The LLM emits per-scene flat fields inside the script JSON. The only "director-like" passes are heuristic, render-time (`shots.ts#planShots`, `motion.ts#planSceneMovements`). Stage 5 of the roadmap builds this from scratch.
2. **No "Export/Publish" stage wired up.** `uploadToYouTube` is implemented but never called. There is no `POST /api/videos/[id]/publish` route. `Video.youtubeUrl` is never written. Stage 6 of the roadmap wires this up.
3. **No server-side "Auto-Pilot" pipeline DAG.** The plan implies idea→script→storyboard→voice→render→QC→export→publish chained server-side. Today each stage is a separate API endpoint; the client must poll + chain manually (`poll.ts:82-459`).
4. **QC is not a separate stage.** `qcForVideo` runs inline inside the render job. There is no independent QC re-run endpoint.
5. **No separate "Scene Assembly / Editing" stage.** Scene assembly is rolled into the monolithic `renderVideo` orchestrator. There is no preview-assembly stage where the user can reorder scenes, trim timing, or substitute assets before the final render commits.
6. **YouTube tokens are single-tenant.** `Setting` table holds one OAuth credential set per install.

---

## 4. Build & test baseline

### 4.1 Build reproducibility

**Can a fresh dev clone, run `npm install && npm run setup && npm run dev`, and get a working app? — Partially, with caveats.**

✅ **What works out of the box (SQLite path):**

- `npm install` triggers `postinstall.mjs` → auto-detects missing `.env`, writes `DATABASE_URL=file:../db/custom.db`, runs `prisma generate --schema prisma/schema.sqlite.prisma`, runs `prisma db push` to create the SQLite `.db` file.
- `npm run dev` boots Next 16 on :3000. UI works without any AI credentials.

❌ **Blockers / friction:**

1. **`npm run setup` is broken for local dev.** It calls `prisma db push` with no `--schema` flag → uses default `schema.prisma` (Postgres) — but `DATABASE_URL` is `file:` (SQLite) → Prisma throws `Provider sqlite does not match datasource provider postgresql`. The correct command is `npm run setup:local`. The plain `setup` script is only valid when `DATABASE_URL` points at Postgres.
2. **`npm test` requires `bun` installed** (`package.json:22`) — not declared as a prerequisite in `SETUP.md`.
3. **`npm run check` requires `bun run`** (`package.json:23`).
4. **`npm run backup` and `npm run auth:reset` will fail** — `scripts/backup.sh` and `scripts/auth-reset.mjs` are referenced in `package.json` but the files are **missing** from the shipped tree. Both are documented in `SETUP.md`/`SECURITY.md` as recovery paths.
5. **Build script uses shell `cp`** (`package.json:9`) — Windows fails unless WSL/Git Bash.
6. **`ffmpeg` is a hard runtime dependency** but is not checked at boot. Missing ffmpeg surfaces as runtime errors deep in pipelines.
7. **Tailwind `content` globs in `tailwind.config.ts`** point at `./pages`, `./components`, `./app` — directories that don't exist. This is dead v3 config; Tailwind v4 uses `globals.css` `@import "tailwindcss"` and auto-source detection, so styles still work — but the file is misleading drift.
8. **ESLint will report ~0 errors regardless of code quality** (all rules off in `eslint.config.mjs`). A clean `npm run lint` gives false confidence.
9. **Two lockfiles** (`bun.lock` 328 KB + `package-lock.json` 535 KB) — depending on which PM a dev uses, dependency versions may diverge.

### 4.2 Package manager consistency

Mixed. Three PMs are touched:

| Area | PM | Evidence |
| --- | --- | --- |
| Documented install | npm | `SETUP.md:44` "npm install"; `SETUP.md:170` "npm run build && npm start" |
| Test runner | bun | `package.json:22` `bun scripts/test-unit.ts` |
| `check` meta-script | bun | `package.json:23` `bun run typecheck && bun run lint && bun run test` |
| `dev:daemon` | npm exec | `package.json:8` (via python3) |
| Lockfiles | both | `bun.lock` + `package-lock.json` both committed |
| CI | none | no workflows |
| `devDependencies` | bun-types installed | `package.json:99` |

**Recommendation (for Stage 1):** pick one PM, delete the other lockfile, align all scripts to it, update `SETUP.md`. Document bun as a prerequisite OR migrate the test runner to node.

### 4.3 Test coverage

| Dimension | Status |
| --- | --- |
| Naming convention (`*.test.ts` / `*.spec.ts`) | **0 files** — not used |
| Formal runner | 1 file: `scripts/test-unit.ts` (726 lines, Bun, custom harness, ~342 checks) |
| Pure unit coverage | ✓ — audiomix, music mood, QC, voice catalog, voice-clone URL validation, arthash, stock-query, token contract, IPv4/IPv6 table, URL sanitizer, settings allow-list, redact, rate-limit window math, transitions, RIFF |
| ffmpeg fixture regression | ✓ — `test-unit.ts` layer 2 (tiny MP4s through `runQcReport`) |
| HTTP E2E | ✓ (ad-hoc) — `test-providers.mjs`, `test-voice-preview.mjs`, `test-quality-overhaul.mjs`, `test-byov.mjs`, `test-script-regen.mjs`, `preview_e2e.py` — all require a running dev server + often a stub provider |
| Standalone ffmpeg validation | ✓ — `test-shotchain.mjs` |
| React component tests (RTL/Vitest) | ✗ none |
| Playwright browser E2E | ⚠ playwright `1.57.0` is in `dependencies` but no `playwright.config.*`, no `e2e/` dir — installed but unwired |
| Integration tests (DB layer) | ✗ none — no test that exercises Prisma against a real DB |
| CI | ✗ no `.github/workflows`, no YAML, no CI of any kind |

**Verdict:** Layered but informal — strong on the audio/render/QC core (the high-risk areas), weak on UI/DB/integration, completely unwired in CI. The Playwright dep is dead weight.

### 4.4 Env var inventory

| Category | Vars |
| --- | --- |
| Required for boot | `DATABASE_URL`, `TUBEFORGE_AUTH_SECRET` (required for auth; absence silently opens the studio in dev mode), `NODE_ENV` |
| Optional behavior toggles | `TUBEFORGE_LOCK=1`, `TUBEFORGE_REQUIRE_LOCK=0`, `TUBEFORGE_LOG_QUERIES=1`, `TUBEFORGE_ALLOW_PRIVATE_HOSTS=1`, `TUBEFORGE_RATE_READ`, `TUBEFORGE_RATE_WRITE`, `TUBEFORGE_ACCESS_TOKEN`, `TUBEFORGE_DIR`, `VERCEL`, `NOW_BUILDER` |
| AI providers | **none via env** — all provider keys live in the `Setting` table or `.z-ai-config` JSON |
| Scripts only | `NEON_URL` (manual Neon sync), `BASE` (E2E test base URL) |

### 4.5 Security header gaps

`next.config.ts` defines **no `headers()`**. Missing:

- `Content-Security-Policy`
- `X-Frame-Options: DENY` (or CSP `frame-ancestors`)
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy`
- `Strict-Transport-Security` (assumed at edge; not asserted)
- `Cross-Origin-Opener-Policy` / `Cross-Origin-Embedder-Policy`

Additionally, `reactStrictMode: false` (next.config.ts:8) weakens the React dev-mode check. CSRF Origin is enforced server-side in middleware, which is the only header-level mitigation in place.

### 4.6 Drift between `schema.prisma` and `schema.sqlite.prisma`

- Models, fields, types, defaults, indexes, relations: **identical** — line-by-line equivalent except for the datasource block.
- Comment drift on `VoiceProfile`: the Postgres schema documents both `zhipu` and `selfhost` provider paths; the SQLite mirror only documents `zhipu`. Schema fields are the same — both have `provider`, `providerVoiceId`, `sampleWav`. The SQLite comment block was not updated when the selfhost provider was added.
- Maintenance burden: the SQLite file's own header comment admits this is a manual mirror — "Keep field definitions in sync with `schema.prisma`". There is no automation enforcing this.

### 4.7 Migration story

- **No `prisma/migrations/` directory exists.** Schema management is `prisma db push` only, both locally (`setup:local`) and on Vercel.
- For production Neon, the worklog shows the team wrote a one-off manual SQL script `scripts/neon-sync.mjs` that issues `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` DDL — i.e., schema evolution is hand-rolled idempotent SQL, not Prisma migrations.

**What this means for production:**

1. No migration history — no auditable record of schema changes over time.
2. No data-preserving column rename/drop — `prisma db push` will drop+recreate columns that changed type or were renamed.
3. No down/rollback path — `prisma migrate reset` would wipe data; there is no `migrate deploy` story for zero-downtime prod.
4. Multi-environment drift risk — production Postgres schema is not pushed by the build. Operator must remember to run `neon-sync.mjs` (or `prisma db push`) after every schema edit. The worklog itself records an incident: "musicEnabled/motion columns were missing — pre-existing drift".

---

## 5. Existing defects (recorded before any changes)

These are recorded as-is before any Stage 1 work, per the master plan's instruction to "record existing defects before making changes".

| # | Defect | File:line | Severity | Notes |
| --- | --- | --- | --- | --- |
| D-01 | `POST /api/videos` runs full script generation synchronously in-request | `src/app/api/videos/route.ts:247,298` | HIGH | Gateway timeout risk; worker body exists but is dead code |
| D-02 | `POST /api/research` runs LLM call synchronously in-request | `src/app/api/research/route.ts:38` | HIGH | Same as D-01 |
| D-03 | `POST /api/research/[id]/greenlight` runs script generation synchronously | `src/app/api/research/[id]/greenlight/route.ts:127,141` | HIGH | Same as D-01 |
| D-04 | `POST /api/characters/bible` runs LLM call synchronously | `src/app/api/characters/bible/route.ts:13` | HIGH | ~5-8s LLM call |
| D-05 | `DELETE /api/videos/[id]` does not clean up `uploads/<id>/` | `src/app/api/videos/[id]/route.ts:207` | MEDIUM | Orphaned files on disk |
| D-06 | `uploadToYouTube` implemented but never called | `src/lib/tubeforge/youtube.ts:292-382` | HIGH | Publish stage is dead scaffolding |
| D-07 | `Video.youtubeUrl` is never written by any code path | grep confirmed | HIGH | Consequence of D-06 |
| D-08 | `runScriptJob` is dead code | `src/lib/tubeforge/script-job.ts:35-174` | MEDIUM | The fix for D-01 already exists |
| D-09 | YouTube fetch calls have no timeout/retry | `src/lib/tubeforge/youtube.ts:123,166,218,314,336,362` | HIGH | A single Google 500 fails the upload |
| D-10 | `/proc/<pid>/stat` zombie watchdog is Linux-only | `src/lib/tubeforge/proc.ts:37-46` | MEDIUM | Won't work on macOS/Windows hosts |
| D-11 | `npm run setup` is broken for SQLite local dev | `package.json:14` | MEDIUM | Should auto-detect URL protocol like `postinstall.mjs` does |
| D-12 | `npm run backup` and `npm run auth:reset` reference missing files | `package.json:16,17` | MEDIUM | `scripts/backup.sh` and `scripts/auth-reset.mjs` absent |
| D-13 | Two lockfiles committed (`bun.lock` + `package-lock.json`) | repo root | LOW | PM-of-record unclear |
| D-14 | ESLint rules all disabled | `eslint.config.mjs:10-45` | MEDIUM | `npm run lint` gives false confidence |
| D-15 | Tailwind v3 config file is dead drift | `tailwind.config.ts` | LOW | v4 uses CSS-based config in `globals.css` |
| D-16 | `VoiceProfile` SQLite comment drifted from Postgres version | `prisma/schema.sqlite.prisma:194-198` | LOW | Cosmetic |
| D-17 | No `prisma/migrations/` directory | `prisma/` | HIGH | Schema management is `db push` only; no migration history |
| D-18 | No CI of any kind | (no `.github/workflows/`) | HIGH | Tests only run when a human remembers |
| D-19 | No security headers configured | `next.config.ts` | MEDIUM | CSP, X-Frame-Options, etc. all missing |
| D-20 | Login brute-force counters reset on restart | `src/lib/tubeforge/auth.ts:189-190` | MEDIUM | `__tfAuthLimit` is in-memory only |
| D-21 | API rate-limit buckets reset on restart | `src/lib/tubeforge/rate-limit.ts:18-21` | MEDIUM | `__tfRateBuckets` is in-memory only |
| D-22 | AI budget pacing state resets on restart | `src/lib/tubeforge/budget.ts:45-54` | MEDIUM | Thundering-herd risk on fresh process |
| D-23 | `GET /api/videos/[id]/mp4` reads entire file into memory | `src/lib/tubeforge/render.ts:729` | MEDIUM | Memory-bound for large videos |
| D-24 | `GET /api/videos/[id]/export` buffers entire ZIP in memory | `src/app/api/videos/[id]/export/route.ts:248` | MEDIUM | Memory-bound for large exports |
| D-25 | `params.n` not strictly validated as positive integer | `src/app/api/videos/[id]/storyboard/[n]/route.ts` etc. | LOW | `Number(n)` produces `NaN` for non-integer; no traversal but wrong filenames |
| D-26 | No input validation framework (zero `zod` use across 110 endpoints) | `src/app/api/**` | HIGH | Hand-rolled validation has known weaknesses |
| D-27 | `POST /api/auth/setup` first-come race on a fresh install | `src/app/api/auth/setup/route.ts:15` | CRITICAL | Documented; mitigations exist but not eliminated |
| D-28 | No `userId`/`tenantId` on any Prisma model | `prisma/schema.prisma` (entire file) | CRITICAL | Multi-tenant migration blocker — touches every endpoint |
| D-29 | `Setting` table is singleton per key | `prisma/schema.prisma:184-188` | CRITICAL | One owner password, one YouTube grant, one set of provider keys per install |
| D-30 | `TUBEFORGE_AUTH_SECRET` absent from local `.env` | (local dev only) | LOW | Studio runs open by default (documented dev mode) |

---

## Appendix A — Full route table

The full per-endpoint table (113 rows, method-separated) is in the route audit working notes. The summary findings in §2 above cover all CRITICAL / HIGH entries; the per-route row is available on request.

## Appendix B — Files read during the audit

71 route files under `src/app/api/`; 53 library modules under `src/lib/tubeforge/`; 8 provider adapters under `src/lib/tubeforge/providers/`; `prisma/schema.prisma` + `prisma/schema.sqlite.prisma`; `package.json`, `tsconfig.json`, `eslint.config.mjs`, `next.config.ts`, `tailwind.config.ts`, `postcss.config.mjs`, `src/middleware.ts`, `src/lib/tubeforge/auth.ts`, `src/lib/tubeforge/auth-token.ts`, `src/lib/tubeforge/jobs.ts`, `src/lib/tubeforge/poll.ts`, `src/lib/tubeforge/net-guard.ts`, `src/lib/tubeforge/rate-limit.ts`, `src/lib/tubeforge/budget.ts`, `src/lib/tubeforge/render.ts`, `src/lib/tubeforge/qc.ts`, `src/lib/tubeforge/verify.ts`, `src/lib/tubeforge/youtube.ts`, `src/lib/tubeforge/script-job.ts`, `src/lib/tubeforge/shots.ts`, `src/lib/tubeforge/motion.ts`, `src/lib/tubeforge/transitions.ts`, `src/lib/tubeforge/captions.ts`, `src/lib/tubeforge/proc.ts`, `src/lib/tubeforge/voice.ts`, `src/lib/tubeforge/voice-clone.ts`, `src/lib/tubeforge/audiomix.ts`, `src/lib/tubeforge/sfx.ts`, `src/lib/tubeforge/music.ts`, `src/lib/tubeforge/stock.ts`, `src/lib/tubeforge/slides.ts`, `src/lib/tubeforge/story.ts`, `src/lib/tubeforge/script-analysis.ts`, `src/lib/tubeforge/convert.ts`, `src/lib/tubeforge/types.ts`, `src/lib/tubeforge/quality.ts`, `src/lib/tubeforge/providers/{chat,tts,image,asr,vision,video,http,settings,registry,config}.ts`, `src/lib/db.ts`, `SETUP.md`, `SECURITY.md`, `worklog.md` (first 200 lines), `scripts/postinstall.mjs`, `scripts/test-unit.ts`.

---

## Completion gate for Stage 1 audit

This audit satisfies the first sprint deliverable of the master plan:

- ✓ Inventory every application module and API route (71 files / 110 endpoints)
- ✓ Map all database models and relationships (11 models, 0 with userId)
- ✓ Inspect authentication and security boundaries (1 CRITICAL, ~28 HIGH)
- ✓ Trace the complete video-generation and rendering pipeline (8 stages traced, 3 missing)
- ⚠ Establish a clean baseline for builds and automated tests (baseline assessed; cleanup is Stage 1 task work, not audit work)
- ✓ Create a prioritized technical debt and risk register (30 defects recorded in §5; full register in `RISK_REGISTER.md`)
- ✓ Prepare the implementation backlog for Stage 1 (in `TASKS.md`)

The next step is to execute the Stage 1 task backlog — see `TASKS.md`.
