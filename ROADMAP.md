# TubeForge — Roadmap

**Status:** Stages 1–7 closed at the code level; the S-series hardening
sprints landed on top (S1→S74, 2026-11-10 — the S-series index and the
S47 integrity ledger live in [`TASKS.md`](TASKS.md)); the Post-Stage-7
2.0 tracks below are the active era (Whiteboard Engine E0–E9 + Creator
Intelligence CI-1..CI-4 landed; S74's motion re-measure OPEN,
gateway-gated; S75 = architecture reconciliation + Whiteboard
production readiness, in flight).
**Last updated:** 2026-11-11 (the final implementation priority recorded
below — the governing order for everything after S74/S76)
**Source:** `MASTER_PLAN.md` + `FOUNDATION_AUDIT.md` findings + the S47 external audit + the stage records

---

## Overview

A 28-week (planning estimate; realistic ~32 weeks given the audit findings) development programme, with clearly defined milestones. Seven stages, from existing codebase to commercial launch. The order matters — security and reliability before the premium experience.

| # | Stage | Weeks (planned) | Weeks (audit-adjusted) | Completion gate |
| --- | --- | --- | --- | --- |
| 1 | Baseline & security | 1–2 | 1–2 | Application can be installed from a clean checkout, built reproducibly, and tested without relying on local secrets or a developer's existing database. |
| 2 | Multi-user SaaS architecture | 3–6 | 3–7 | Two independent test accounts cannot access each other's projects, files, jobs, credentials or generated content. |
| 3 | Production infrastructure | 7–10 | 8–12 | A video job can survive an application restart, resume safely where possible, and make its resulting assets available to the correct user. |
| 4a | Premium UX — core 5 surfaces | 11–12 | 13–15 | Dashboard, Project creation, Script editor, Storyboard, Scene editor feel like an established professional creative product. |
| 4b | Premium UX — remaining 5 surfaces | 13–14 | 16–18 (parallel with 5) | Research workspace, Character management, Voice studio, Render management, Analytics redesigned. |
| 5 | AI Director & film quality | 15–19 | 16–22 | The system flags scene inconsistencies and offers one-click regeneration; visuals match the narration; the video has a deliberate cinematic rhythm. |
| 6 | Editing, rendering & publishing | 20–24 | 23–28 | A user can edit, render, review, export and publish a finished video without leaving TubeForge. |
| 7 | Testing, launch & optimization | 25–28 | 29–33 | All Stage 7 tests pass against real beta usage; platform opened to paying customers. |

---

## Stage 1 — Baseline, security and code stabilization

**Weeks 1–2 · Must complete first**

The objective is to make the existing TubeForge safe to develop and deploy.

### Tasks (full detail in `TASKS.md`)

| Task | Deliverable |
| --- | --- |
| Restore missing scripts | `scripts/backup.sh`, `scripts/auth-reset.mjs`, `scripts/package-local.sh` present and executable |
| Fix `npm run setup` | Auto-detect URL protocol (like `postinstall.mjs`) or remove the ambiguous script |
| Pick one package manager | Delete the other lockfile; align all scripts; update `SETUP.md` |
| Add CI | `.github/workflows/ci.yml` running `typecheck`, `lint`, `test` |
| Add security headers | `next.config.ts` `headers()` — CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy, HSTS |
| Re-enable ESLint rules | `@typescript-eslint/no-explicit-any`, `@typescript-eslint/no-unused-vars`, `react-hooks/exhaustive-deps`, `no-console`, `no-debugger` (warn level) |
| Adopt `prisma migrate` | First migration created from the current schema; `prisma/migrations/` directory |
| Eliminate first-come setup race | `TUBEFORGE_OWNER_TOKEN` env bootstrap so the first `POST /api/auth/setup` must present it |
| Delete `DELETE /api/videos/[id]` orphan gap | `rmSync uploads/<id>/` on delete (D-05) |
| Fix `POST /api/videos` synchronous script generation | Wire `runScriptJob` into `startJob` (D-01, D-08) |
| Document architecture | `ARCHITECTURE.md` (done) |
| Document risk register | `RISK_REGISTER.md` (done) |
| Document Stage 1 backlog | `TASKS.md` (done) |

### Additional work

- Establish development, staging and production environments (defined; not yet provisioned — that is Stage 3).
- Create a backup and restore procedure (`scripts/backup.sh` restored; tested against a fresh SQLite DB).
- Add automated secret scanning (gitleaks in CI).
- Document the current architecture (done in `ARCHITECTURE.md`).
- Record existing defects before making changes (done in `FOUNDATION_AUDIT.md` §5; 30 defects D-01 through D-30).

### Completion gate

The application can be installed from a clean checkout, built reproducibly, and tested without relying on local secrets or a developer's existing database.

Specifically:

- `npm install && npm run setup:local && npm run dev` works on a fresh clone.
- `npm test` runs (with the chosen PM).
- `npm run lint` reports real issues (rules re-enabled).
- `npm run typecheck` passes.
- CI runs all three on every commit.
- `prisma migrate dev` produces a real migration.
- `next.config.ts` sets security headers.
- `POST /api/auth/setup` requires `TUBEFORGE_OWNER_TOKEN`.
- `POST /api/videos` enqueues a script job (no synchronous LLM call in the request).
- `DELETE /api/videos/[id]` cleans up `uploads/<id>/`.
- All 30 defects in `FOUNDATION_AUDIT.md` §5 are either fixed or have a `TASKS.md` entry assigning them to a later stage.

---

## Stage 2 — Multi-user SaaS architecture

**Weeks 3–7 (audit-adjusted from 3–6)**

Transform TubeForge from a protected single studio into a secure platform for multiple customers.

### Build

- **New models:** `User`, `Organization`, `Membership`, `UserSetting`, `YouTubeAccount`, `ProviderCredential`.
- **Migration of every existing model:** add `organizationId` to `Channel`, `Character`, `Video`, `Activity`, `ResearchSession`, `ScheduleSlot`, `VideoStat`, `VoiceProfile`, `MusicTrack`, `Job`.
- **One-time data migration:** the existing `Setting` rows are migrated to per-user scoping. `auth.password` → the first claimed owner's `User.passwordHash`. `ytRefreshToken` / `ytChannelTitle` / `ytChannelThumb` → the first owner's `YouTubeAccount`. `tts.*` / `zai.*` / `stock.*` → the first owner's `ProviderCredential` + `UserSetting`.
- **Remove the global `Setting` table.** Its non-secret contents (music library seed defaults) move to `UserSetting`. Its secret contents (auth password, OAuth client secret, provider keys, YouTube refresh token) move to the new per-user models.
- **User registration and login:** email + password; email verification; password recovery via email.
- **User profiles:** name, avatar, default organization.
- **Organizations and workspaces:** every content entity belongs to an organization.
- **Roles:** owner, administrator, editor, viewer. Authorization enforced by `requireRole(role)` on every endpoint.
- **Tenant-level data ownership:** every Prisma query includes a tenant filter (`where: { organizationId, … }`).
- **Session management:** signed session cookies; 7-day expiry; revocation via a `Session` table (or Redis set).
- **API authorization:** `requireUser()` returns the caller's `userId` and `tenantId`; used by every endpoint.
- **Audit logs:** every mutating action appends an `Activity` row with `userId` + `organizationId`.
- **Account deletion and data export:** `POST /api/account/delete` and `POST /api/account/export` (per GDPR).
- **Move session state, rate-limit buckets, login lockouts to Redis** (survive restart; eliminate D-20, D-21).
- **Encrypt secrets at rest:** `ProviderCredential.apiKey` and `YouTubeAccount.refreshToken` encrypted with `TUBEFORGE_ENCRYPTION_KEY`.
- **Eliminate D-27 (first-come setup race)** — already done in Stage 1; the new flow is `POST /api/auth/register` with email verification.

### Important

Every project, character, voice profile, channel, generated asset and job must belong to an authorized tenant.

### Completion gate

Two independent test accounts cannot access each other's projects, files, jobs, credentials or generated content. Verified by automated cross-tenant isolation tests in CI.

> **Status: COMPLETE (2026-11-01).** Verified by `e2e/isolation.spec.ts` — 7/7 green (list/read/mutate/delete/settings/jobs isolation, 401 default-deny, server-side session revocation), wired into the CI Playwright job. Full execution record + documented deviations (SMTP, per-user Z.ai, Redis state, LegacySetting drop → Stage 3): see TASKS.md "Stage 2 execution status".

---

## Stage 3 — Production infrastructure

**Weeks 8–12 (audit-adjusted from 7–10)**

Make TubeForge capable of reliably handling substantial video-production workloads.

### Build

| System | Recommended direction |
| --- | --- |
| Database | Managed PostgreSQL (Neon, Supabase, or RDS) with `prisma migrate deploy` for zero-downtime schema changes |
| Background queue | Redis + BullMQ (durable jobs across worker restarts) |
| Media storage | S3-compatible object storage (Cloudflare R2, AWS S3, or GCS) with presigned URLs |
| Video processing | Dedicated FFmpeg workers (long-running Node processes; cross-platform zombie reaper replacing the Linux-only `/proc/<pid>/stat` watchdog — D-10) |
| Web application | Next.js standalone deployment (Vercel, Fly.io, or a VPS) |
| Monitoring | Centralized logs (pino structured JSON) + error tracking (Sentry or self-hosted GlitchTip) |
| Secrets | Managed secrets service (AWS Secrets Manager, Doppler, or `.env` encrypted at rest) |
| Delivery | CDN (Cloudflare, Vercel Edge, or CloudFront) + signed media URLs |

### Implement

- **Persistent job execution:** `startJob` enqueues a BullMQ job instead of running in-process. The worker process consumes the queue.
- **Job retries and cancellation:** BullMQ built-in retries with exponential backoff; cooperative cancellation via a Redis flag (replacing `__tfCancel`).
- **Automatic recovery after worker restarts:** BullMQ requeues in-flight jobs on SIGTERM; resumed by another worker.
- **Render concurrency limits:** per-organization concurrency caps enforced by the queue.
- **Per-user generation limits:** per-user, per-capability rate limits enforced by Redis (replacing `__tfBudget`).
- **Provider timeout handling:** every provider call goes through the provider abstraction with a configurable timeout per capability (replacing the 5-minute universal timeout in `http.ts`).
- **Storage quotas:** per-organization GB limit enforced on every `storage.put`.
- **Cost tracking:** per-user, per-capability `UsageRecord` rows; surfaces in the admin dashboard.
- **Job progress visible across devices:** the existing `Job` row + `poll.ts` pattern continues to work; the queue is the source of truth, the DB row is the user-facing view.
- **Eliminate D-22 (AI budget pacing resets on restart):** `__tfBudget` state moves to Redis.
- **Eliminate D-23, D-24 (memory-bound media streaming):** `GET /api/videos/[id]/mp4` and `GET /api/videos/[id]/export` redirect to presigned URLs; the client downloads directly from the CDN.

### Completion gate

A video job can survive an application restart, resume safely where possible, and make its resulting assets available to the correct user.

---

## Stage 4a — Premium user experience (core 5 surfaces)

**Weeks 13–15 (audit-adjusted from 11–12)**

The application should start feeling like an established professional creative product.

### Redesign

1. **Dashboard** — project overview, recent activity, quick-start actions.
2. **Project creation** — guided brief; topic + niche + tone + length + format + render mode + character + voice + music + brand.
3. **Script editor** — MDX-style editor with research-assisted writing, narrative structure visualization, emotional progression map, scene and narration timing, fact-checking side panel.
4. **Storyboard** — visual storyboard with per-scene image, camera direction, mood, caption, character in-scene flag, re-roll button.
5. **Scene editor** — per-scene editing with image, voiceover, captions, transitions, motion controls.

### Design system

- Typography and spacing rules (design tokens in `globals.css`).
- Consistent buttons and controls (shadcn/ui — already in place).
- Accessible color contrast (WCAG AA minimum).
- Responsive layouts (mobile-first; tablet and desktop variants).
- Keyboard shortcuts.
- Loading and error states.
- Autosave and undo/redo where appropriate.

### User journey (target)

```
Create project → Define brief → Approve script → Approve storyboard
  → Produce → Edit → Review → Export → Publish
```

### Completion gate

Dashboard, Project creation, Script editor, Storyboard, Scene editor feel like an established professional creative product. User testing with 5 internal users; SUS score ≥ 75.

---

## Stage 4b — Premium user experience (remaining 5 surfaces)

**Weeks 16–18 (parallel with Stage 5; audit-adjusted from 13–14)**

### Redesign

6. **Research workspace** — Topic Radar with idea list, greenlight flow, niche trends.
7. **Character management** — character roster, identity anchor, portrait + poses, voice assignment, appearance tracking, continuity checks.
8. **Voice studio** — voice catalog, cloning, pronunciation controls, audition.
9. **Render management** — render queue, QC report, preview, export.
10. **Analytics** — video performance, niche trends, learning loop.

### Completion gate

All 10 surfaces redesigned; consistent design system applied; mobile responsive. User testing with 5 internal users; SUS score ≥ 75 across all 10.

---

## Stage 5 — AI Director and cinematic quality

**Weeks 16–22 (audit-adjusted from 15–19; runs in parallel with Stage 4b)**

This is the most important product differentiation stage. The AI Director should not simply generate pictures. It should make creative decisions.

### Honest note from the audit

In 2026, no off-the-shelf model makes creative decisions reliably. What we can actually build in this timeframe:

- **AI Director *proposes*, human approves.** Shot selection, framing, lens suggestions, transitions — all as suggestions the user accepts/rejects/regenerates. This is achievable and still feels magical.
- **Character continuity via reference image systems** (IP-Adapter, Seedance reference, Qwen image-edit with camera control). These get ~80–90% character consistency, not 100%. Plan for a "regenerate until consistent" loop, not a "guaranteed consistent" promise.
- **Scene-level continuity checks** via VLM comparison (frame-to-frame character matching) — achievable and worth building.

The Stage 5 completion gate from the master plan ("the same character remains recognizable across scenes") is rewritten below as "the system flags inconsistencies and offers one-click regeneration" — that's honest and still premium.

### Build these modules

#### A. Script intelligence

- Research-assisted writing.
- Narrative structure (three-act; hook → context → escalation → payoff).
- Emotional progression (mapped to music mood selection).
- Scene and narration timing (per-scene word count targets from target duration).
- Fact-checking and source references (link out to source URLs in the script editor).

#### B. Director's brain

- **Shot selection** — LLM-driven shot-list pass producing a JSON array of `Shot { sceneIndex, shotIndex, framing, camera, lens, duration, transitionIn, transitionOut }`. Persisted as `Video.shotList`.
- **Camera framing** — wide / medium / close-up / extreme close-up / over-the-shoulder / POV / aerial.
- **Lens and composition suggestions** — focal length (mm), aperture, depth-of-field, composition rule (rule of thirds, leading lines, golden ratio).
- **Camera movement** — static / pan / tilt / dolly / crane / handheld / steadicam / drone.
- **Scene duration** — per-scene target from the script's word count + pace.
- **Visual mood** — color palette, lighting key, time-of-day.
- **Transition selection** — picked from the existing 15-style `transitions.ts` catalog; the director picks one per shot boundary.

#### C. Character continuity

- **Character identity profiles** — `Character.identityAnchor` already exists; extend with `referenceImageLibrary` (multiple reference images per character).
- **Reference image library** — `uploads/characters/<id>/ref-*.png` (or object storage equivalent).
- **Clothing and appearance tracking** — per-scene `CharacterAppearance { characterId, videoId, sceneIndex, outfit, accessory, mood }`.
- **Location and prop consistency** — `Location { id, name, referenceImages }` and `Prop { id, name, referenceImages }` models.
- **Scene-level continuity checks** — VLM compares each generated scene image against the character reference library; flags mismatches; offers one-click regeneration. Persists a `consistencyScore` per scene.

#### D. Visual production

- **Image generation** — existing `providers/image.ts` continues to work; the AI Director passes the shot-list's framing/camera/lens as image-prompt modifiers.
- **Image-to-video generation** — existing `animated` render mode continues to work; the AI Director picks which scenes need i2v based on motion cues.
- **Stock-footage selection** — existing Pexels/Pixabay integration continues to work; the AI Director picks stock for scenes that need real-world footage (documentary, news, location-based).
- **Maps and illustrative inserts** — new: SVG map generation for location-based scenes; vector illustrations for concept scenes.
- **Motion effects** — existing `motion.ts` (Ken Burns) continues to work; the AI Director picks the motion mode per scene based on the shot-list.
- **Scene-specific visual alternatives** — per-scene "regenerate with this constraint" loop (e.g. "regenerate scene 14 with the character wearing a red jacket").

#### E. Audio production

- **Voice generation** — existing TTS providers continue to work.
- **Pronunciation controls** — per-word pronunciation override (phoneme spelling, emphasis tags).
- **Voice timing** — per-scene pacing control (slower for emotional, faster for action).
- **Music selection** — existing `music.ts` mood-matching continues to work; the AI Director picks the mood from the script's emotional progression.
- **Sound effects** — existing `sfx.ts` (whoosh/boom/riser/sting) continues to work; the AI Director places cues at scene boundaries.
- **Ambient audio** — new: per-scene ambient bed (city traffic, nature, room tone, weather).
- **Automatic audio ducking** — existing `audiomix.ts#duckChain` continues to work; the AI Director sets the ducking intensity from the script's dialogue vs. music ratio.

### Completion gate (audit-adjusted)

- The system flags scene inconsistencies and offers one-click regeneration (rather than "the same character remains recognizable across scenes" — see honest note above).
- The visuals match the narration (per-scene ASR verification continues to work via `verify.ts`).
- The video has a deliberate cinematic rhythm (the shot-list's pacing is reflected in the rendered video; QC check `static-shots` fails if 3+ consecutive shots are static without motivation).
- Character consistency score ≥ 80% across scenes (measured by the VLM continuity check).

---

## Stage 6 — Editing, rendering and publishing

**Weeks 23–28 (audit-adjusted from 20–24)**

Build the professional editing and delivery experience.

### Editing Studio

- **Scene timeline** — visual timeline with per-scene thumbnails, durations, transitions.
- **Drag-and-drop ordering** — `@dnd-kit/sortable` (already in dependencies).
- **Scene trimming** — per-scene in/out point editing.
- **Individual scene regeneration** — existing per-scene re-roll continues to work.
- **Narration editing** — per-scene narration text edit; re-synthesizes only that scene's voiceover.
- **Caption editing** — per-scene caption text edit; re-renders only the SRT cue.
- **Audio tracks** — voice / music / SFX / ambient levels per scene.
- **Transition previews** — click-to-preview each transition in the timeline.
- **Undo and redo** — full edit history.

### Rendering Engine

- **1080p and 4K export** where supported (provider capability matrix).
- **16:9, 9:16 and 1:1 formats** — per-project default; per-export override.
- **Consistent frame rates** — 24 / 30 / 60 fps per-project; default 30.
- **Audio normalization** — existing `audiomix.ts` two-pass loudnorm continues to work.
- **Caption burn-in and subtitle files** — burn-in toggle; SRT/VTT export.
- **Render progress** — existing `pollRender` continues to work.
- **Interrupted-render recovery** — BullMQ requeues on SIGTERM; resumed by another worker (Stage 3).
- **Export validation** — existing 12-check QC battery continues to run; re-runnable via new `POST /api/videos/[id]/qc` endpoint.
- **Eliminate D-23, D-24 (memory-bound media streaming)** — done in Stage 3; final.mp4 streamed via CDN.

### YouTube and publishing (wire the dead scaffolding — D-06, D-07)

- **`POST /api/videos/[id]/publish`** — new route. Enqueues a publish job (`kind: "upload"` — already defined in `jobs.ts`). Calls the existing `uploadToYouTube` function (resumable upload + thumbnail set).
- **Per-user OAuth account connection** — `YouTubeAccount` from Stage 2 (one per channel). User picks which account to publish to.
- **Channel selection** — list the user's connected YouTube accounts; pick one.
- **Title and description generation** — LLM-driven from the script + niche; user-editable.
- **Thumbnail variants** — existing 3-variant generation continues to work; user picks one or uploads a custom.
- **Scheduled publishing** — pick a future publish time; YouTube's `publishAt` API.
- **Publishing status** — `Video.status: "publishing"` → `"published"` after YouTube confirms; `Video.youtubeUrl` written on success.
- **Upload retry and failure recovery** — BullMQ retries with exponential backoff; on `invalid_grant`, the `YouTubeAccount.refreshToken` is cleared and the user is prompted to reconnect.
- **Analytics synchronization** — existing `POST /api/youtube/sync` continues to work; moves to a per-user cron.
- **Every external publishing action requires clear user authorization** — a "Publish to YouTube" confirmation dialog with the chosen channel, title, description, thumbnail, privacy status, and scheduled time.

### New: separate QC endpoint

- **`POST /api/videos/[id]/qc`** — re-runs the 12-check QC battery against the existing `final.mp4`. Persists a new `Video.qcReport`. Does NOT re-render. Useful after the user manually edits a scene's narration or caption.

### New: Scene Assembly stage

- **`POST /api/videos/[id]/assemble`** — new route. Produces a "preview timeline" JSON: per-scene start/end times, transitions, audio levels, caption cues. The user can edit this in the Editing Studio (Stage 6) before the final render commits.
- The render job consumes the assembled timeline instead of computing it inline.

### Completion gate

A user can edit, render, review, export and publish a finished video without leaving TubeForge.

---

## Stage 7 — Quality assurance and commercial launch

**Weeks 29–33 (audit-adjusted from 25–28)**

Before launch, we must prove that the entire product works, not just individual screens.

### Test

- Authentication and account recovery.
- **Cross-tenant authorization** — automated tests in CI (Stage 2 deliverable).
- Project creation.
- Script generation.
- Voice generation.
- Character consistency.
- Scene generation.
- Rendering.
- Export.
- YouTube integration (with a test channel).
- **Billing and credit accounting** — Stripe integration (Stage 6 deliverable); reconciliation tests in CI.
- Worker failures (BullMQ retry, recovery).
- Backup restoration.
- Mobile and desktop layouts.
- Concurrent user workloads (load test with k6 or similar).

### Launch

A controlled beta, gather feedback, fix issues, open the platform to paying customers.

### Launch metrics (from `MASTER_PLAN.md` §8)

| Metric | Target |
| --- | --- |
| Successful core production jobs | At least 98% |
| Cross-tenant data leakage | 0 |
| Recoverable job interruption | 100% recovery of eligible jobs |
| Production build | 100% reproducible |
| Critical security issues | 0 open |
| First successful project | Within 15 minutes |
| Scene regeneration | Without losing approved scenes |
| Export quality checks | 100% of exports checked |
| Billing reconciliation | Exact credit accounting |
| Mobile responsiveness | All core workflows usable |

We will measure these against real beta usage, not just assume they have been achieved.

### Completion gate

All Stage 7 tests pass against real beta usage; platform opened to paying customers.

---

## What changes from the original 28-week plan

The audit informed the following adjustments:

1. **Stage 2 extended by 1 week** (weeks 3–7 instead of 3–6) — the `Setting` table singleton surgery is deeper than the plan estimated. Migrating 13 endpoints off the global `Setting` table to per-user `UserSetting` + `YouTubeAccount` + `ProviderCredential` requires touching every secret-handling route, plus a one-time data migration.

2. **Stage 3 extended by 1 week** (weeks 8–12 instead of 7–10) — adding a provider abstraction layer for AI provider churn resilience. The audit confirmed providers all go through `providers/registry.ts`, but call sites still sometimes bypass it (e.g. `youtube.ts` direct `fetch` calls with no timeout — D-09).

3. **Stage 4 split** (4a core 5 surfaces + 4b remaining 5) — the original plan asked for 10 redesigns in 4 weeks, which is ~2.5 days per surface including design review. Splitting allows the user to hit the main workflow with polished UX while secondary surfaces get improved incrementally, in parallel with Stage 5.

4. **Stage 5 extended by 2 weeks** (weeks 16–22 instead of 15–19) — character continuity is the hardest part and is being built from scratch (the audit confirmed there is no LLM-driven director pass today). The honest completion gate ("flags inconsistencies and offers one-click regeneration" rather than "the same character remains recognizable") is achievable; the original gate was not.

5. **Stage 6 extended by 1 week** (weeks 23–28 instead of 20–24) — wiring the dead `uploadToYouTube` scaffolding + building the missing Scene Assembly stage + adding the separate QC endpoint is more work than the original "Editing Studio + Rendering Engine + YouTube" estimate implied.

6. **Stage 7 extended by 1 week** (weeks 29–33 instead of 25–28) — adding automated cross-tenant isolation tests to CI (the audit's biggest risk recommendation: "automated cross-tenant isolation tests in CI from Stage 2 onward, not as a Stage 7 QA item").

Total: 33 weeks (audit-adjusted) vs 28 weeks (original plan). For a focused 2-3 person team. For a solo developer, expect ~40-52 weeks.

---

## Post-Stage-7 — TubeForge 2.0 tracks (the shared-systems era, in flight)

Stage 7 closed into the era the stage records track as S-series stages.
The active tracks, one line each (detail lives in `docs/audits/` records
and the engine design docs):

1. **Whiteboard Engine E-series** (`WHITEBOARD_ENGINE_DESIGN.md`) — E9
   Phases A/B/C landed (S67/S68/S69: the editor, the editable storyboard,
   and the upload palette behind §7's seven gates — E11's upload path
   executed) and E5 phase 2 LANDED (S73: the LLM scaffold planner —
   `aiCallJson` through budget.ts's choke point, per-scene native
   fallback, honest whole-project degradation; live probe green 2026-11-10).
   The whiteboard loop has proven the shared contracts; what remains on
   the track is E10 per-format benchmarks and the E12
   production-integration entitlements.
   **S74 OPEN** (`docs/audits/s74-motion-vigor-remeasure-record.md`):
   S63's motion-vigor re-measure, paired on regenerated art. Code +
   unit pins landed (local gate green); the measurement (8 paired i2v
   renders + 16 blind vision calls) is gateway-gated, resumable via the
   lane supervisor when the window clears.
2. **Creator Intelligence Engine** (`docs/audits/creator-intelligence-record.md`)
   — **LANDED (S70–S72)**: hook/script scoring (CI-1), title+thumbnail
   pairing lint (CI-2), transcript-based Shorts selection feeding the
   existing renderer (CI-3), and retention ingestion mapped to scenes
   (CI-4, the `yt-analytics.readonly` scope + the retentionReport doc
   column). Every module proposes-never-auto-edits and labels every score
   a heuristic. The record's unscheduled tail (chapters, query targeting,
   channel audit, competitor benchmarking, performance learning) stays
   recorded.
3. **Visual Consistency platform service** — not verified as complete.
4. **Video Critic and Repair foundation** — not verified as complete.
5. **Universal timeline contract and editor** — pending; the Whiteboard
   loop proves the shared contracts first.
6. **Audio / motion graphics / character animation / documentary / 3D
   engines, asset marketplace** — pending, sequenced after the shared
   systems they consume.

### The S75 order of operations (the approved sequencing, recorded as law)

1. **S75** — reconcile the front documents (done: README/ARCHITECTURE/
   ROADMAP corrected against the live source); record the three product
   decisions (universal platform, quality-first, native-first) as
   architecture constraints; execute the Whiteboard **E10** per-format
   benchmarks (16:9 / 9:16 / 1:1, gateway-free — native rendering);
   close or explicitly defer the **E12** production-integration ledger.
   Protocol and ledger: `docs/audits/s75-architecture-reconciliation-record.md`.
2. **S74 close** — real clips + blind scores only (watcher-automated;
   independent of S75's work).
3. **Shared quality systems** — Visual Consistency → Video Critic and
   Repair → the Universal Timeline contract. BEFORE any new engine.
4. **Engine expansion** — each consuming the shared contracts, none a
   parallel pipeline.

The anti-goal, recorded: not a collection of disconnected video
generators. Quality infrastructure precedes engine expansion.

### The final implementation priority (the governing order, recorded 2026-11-11)

The operator's final order for everything after the S75/S76 close-out.
Critical = Phase-0 closers; the P0 shared quality systems precede every
P1–P3 engine (the anti-goal above still governs: shared contracts
first, no parallel pipelines).

| # | Work | Priority | Status (2026-11-13) |
| --- | --- | --- | --- |
| 1 | S74 real motion measurement | Critical | OPEN — the auto-resume loop (cron 521163) drives the 8 paired renders + 16 blind scores; watcher-automated |
| 2 | Docker production image smoke | Critical | CLOSED — S105 + S108: the CI docker-smoke job (every main push) builds the production image and walks the full composed topology — HTTP register/login/create, ffmpeg render, S3 round-trip with the S101 lifecycle, cross-process jobs, worker-restart recovery with the S100 token bump — and since S108 renders a REAL whiteboard project IN-CONTAINER through the worker's chromium (DEPLOYMENT §5.1's exact ask: launch args, frames, encode, artifact, ffprobe'd duration) |
| 3 | Real TTS Whiteboard smoke | Critical | CLOSED — S76 `d991015`: the synthetic-audio caveat struck; the loudness contract pinned at the engine boundary |
| 4 | Visual Consistency Engine | P0 | IN PROGRESS — Phase A landed (S77: the unified engine + style dimension + auto-chain); Phase B slices 1-6 landed (S78: the dedicated appearance dimension keyed to the approved plan's logged looks; S79: the targeted single-scene re-check after repaints, resume-safe via the job payload; S80: the consistencyCheck user setting off|manual|auto gating both auto-chains; S81: shot-art lock coverage — extra shots paint under the scene-art identity locks, portrait/location seed ladder, anchor-only byte-identical; S82: cross-video character identity — one batched VLM call judging the character's latest frame from each casting video, min-across verdicts, manual-only surface; S83: pose-level identity rows — the pose sheet judged against its own portrait anchor, additive poses[] in the character-identity report); Phase B tail = photoreal-suffix reconciliation only (waits on S74) + live-artifact validation recorded |
| 5 | Video Critic and Repair | P0 | IN PROGRESS — foundation landed (S84: the rendered-cut quality report — deterministic rows from the QC battery + the VCE consistency report, one fail-open VLM call for narrative+visual over sampled frames, ship\|hold\|insufficient-evidence verdict as a report for the human, repair proposals naming the existing affordances; contract docs/design/s84-video-critic.md); the critic card landed (S85: the report surface in the Video tab — verdict badge, per-dimension rows with sources, proposals, honesty notes, run/re-run + Mission Control resume for interrupted critic jobs); the one-click repair lane landed (S86: each hold's proposal fires the affordance it names — open Storyboard / re-run voiceover / re-render — through the dialog's existing handlers, §0.2 intact); tail recorded (factual dimension — blocked on the per-video research-brief surface; auto-run after render — gated on S74) |
| 6 | Universal Timeline contract | P0 | CLOSED (code level; soak tail recorded) — design contract + slices 0–1 landed (S87: docs/design/s87-universal-timeline.md — the seam survey, the v2 multi-track target, the 6-slice migration ladder, the §4.C acceptance battery; slice 0 = the version stamp; slice 1 = the v2 dual-write — serializeTimeline derives tracks AT SERIALIZATION from the scenes it is handed (schema 2; the stale-tracks hazard structurally impossible), parseTimeline reads 2/1/absent and re-derives on read, guardTimelineOverwrite refuses overwriting an unknown-stamp doc across all six write paths (assemble POST+PUT, scenes caption sync, studio clip/voice/pace) with DELETE /assemble as the explicit escape hatch, +5 pins); slices 0–2 landed (slice 2 = the composition plan — composition-plan.ts reads the visual track behind the discriminator, the render dispatches per-scene on kind/assetSource with mode fallback, the job feeds durations from the plan, parity-pinned identical cut points/windows + fail-open junk-tracks fallback, +4 pins); slice 3 = Whiteboard emits tracks[] — whiteboard/tracks.ts maps the frame plan onto whiteboard-kind clips on the ONE frame-quantized clock (framePlanClock: windows ≡ delivered frames, contiguous by construction), the render loop + assembly compose on it behind a contract assert, planFromTracks reads engine-authored tracks through the SAME reader (PlanVisualKind gains whiteboard; the structural { tracks } carrier — no doc needed), the S67 refusal in POST /render is RETIRED (whiteboard videos route to their engine lane before the story gates; runRenderJob DELEGATES on stale replays; GET /render sees both lanes), the whiteboard lane gains the VO interlock (safety parity), the compositor gains the whiteboard routing wall, +4 pins); slice 4 = the legacy branches collapse — the storyboard-art gate reads the per-scene KIND (the first render branch onto the contract, mode as the no-plan fallback, parity-pinned neutral), the mixed-kind/geometry laws pinned, kind-completeness pinned (the mode fallback provably unreachable for aligned docs), the channel boundary recorded (liveliness/cameraKeys stay production-channel-scoped), the SOAK GATE recorded (the scenes[] slimming to settings-only schema 3 + the v1 fallback retirement wait on a ≥14-day soak with zero v1-doc renders), +3 pins); slice 5 = the §4.C acceptance close — scripts/s87-acceptance-battery.mts: real renders through BOTH engine lanes (whiteboard chromium + compositor kenburns, $0 AI) held mechanically to the contract, 18/18 checks, wired into the CI E2E job; the battery's first run CAUGHT and fixed a real engine bug (the mixed-VO assembly crash — partial voice coverage previously crashed the whiteboard render); receipt docs/audits/s87-acceptance-battery-record.md — the contract is CLOSED at the code level; the one recorded tail = the slice-4 soak gate (≥14 days, zero v1-doc renders) |
| 7 | Reference-video intelligence | P1 | v1 LANDED (S88: docs/design/s88-reference-video.md) — upload-only ingestion (URL fetch deferred with the rights rationale), the analysis pipeline (ffprobe → the QC detector's scene boundaries at 0.30 → the scene map + keyframes → the ASR transcript → one VLM treatment call → one LLM structure pass, every AI pass fail-open, the deterministic beats standing), the versioned doc column (referenceAnalysis, the ninth JSON doc), the reference job kind (crash-resumable), POST/GET/DELETE /api/videos/[id]/reference, and the Director integration — referenceBlockForPrompt carries pacing numbers, beat roles, treatment adjectives and narration density, PINNED to never emit the transcript text (the copyright wall); the real-artifact smoke green (12s textured fixture, 2 cuts → measured, live VLM+LLM passes); tails recorded (word-level timing, the Studio card, stock-query steering) |
| 8 | Advanced stock retrieval | P1 | v1 LANDED (S89: docs/design/s89-stock-intelligence.md) — the source adapter contract (stock-index.ts: Pexels + Pixabay as the first two adapters, pure normalizers, the per-scene candidate index deduped by source:id with matchedQueries union, fail-soft per source×query), the ranker (stock-ranker.ts: license floor ×2 defense-in-depth, duration/resolution/aspect/semantic factors at 40/20/10/30, the visible −1000 duplicate penalty for clips already placed on another scene, deterministic tiebreak), the multi-frame verifier (stock-verify.ts: ffprobe duration → interior frame sampling → SEQUENTIAL relevance judging with early exit at 2 verdicts — the evidence without 3× the VLM spend — plus deterministic motion measurement via blend+signalstats YAVG, static clips rejected at MOTION_STATIC_MAX 1.0, calibrated: animated 3.82 vs frozen 0.000), the never-silent law PINNED (ref verdict "pass" constructible only with ≥2 passing frames — every 3-frame combination enumerated; fail-open accepts stamped "unverified" with evidence counts, surfaced in GET /stock), the additive ref fields (license/providerId/dimensions/verification) with tolerant parseStockRef round-trip (legacy refs valid, bad records drop the record only), the s3 latent fix (withLocalFile + storage.exists replace direct local-FS access), searchAll compat kept byte-identical; 16 unit pins (444/444), smoke 17/17 on real ffmpeg artifacts; public-archives evaluated individually (NASA = the recorded first candidate, Wikimedia/IA per-item licensing blockers, NOAA no API); tails: the studio verification badge, perceptual cross-provider dedupe, the third adapter |
| 9 | Provider selection intelligence | P1 | v1 LANDED (S90: docs/design/s90-provider-selection.md) — the advisory scoring engine (provider-score.ts, pure): the configurable production-calibrated weighted sum (quality 30 / reliability 25 / cost 20 / latency 10 / fit 15, user-overridable via the ai.scoreWeights setting, tolerantly parsed + clamped, all-zero-safe), priors per capability×provider pinned in lockstep with the registry (priorsComplete — the queue-ledger lesson applied), the org's OWN UsageRecords blended in Bayesian-style (success rate, mean latency 2s→1.0/30s→0.0, mean cost; failures count toward reliability AND the cost average), THE UNKNOWN-PRICING LAW pinned (a paid provider + unpriced model prices at the conservative fallback — NEVER free; non-chat keyed externals without observations score cost 0.4 "unknown, never assumed free"; free must be established BY DESIGN: the gateway, selfhost, no-key providers), spend.ts gains modelPriced (the real-row resolver, the GATE untouched); the surface: GET/PUT /api/settings/ai/score (all four capabilities scored, the current pick marked) + the Settings comparison line (top pick vs yours with quality/reliability/cost reasons — ADVISORY ONLY, dispatch reads the user config, the paid-dispatch safety rules stand unchanged); 11 unit pins (455/455); tails: the weight sliders UI, credential-aware availability, per-model priors |
| 10 | Living production board | P2 | v1 LANDED (S91: docs/design/s91-production-board.md) — one composed snapshot in the project studio, backed ENTIRELY by the existing database/storage/job system (no new tables, no new pipeline): production-board.ts (pure derivation, 4 pins — running outranks done, partial is first-class 3/8, checkpoints claim exactly their evidence: proposed plan → attention, unreviewed QC report → pending, absent → n/a never alarming), GET /api/videos/[id]/board (stages script/storyboard/voice/render/publish with lane-appropriate storyboard progress — scene-art storage stats for the image lanes, the whiteboard doc for the whiteboard lane; the running-job snapshot + last errors; the five approval checkpoints — Director plan, the QC ship gate, narration verify, continuity, the critic verdict; org-scoped 30-day costs WITH the honest attribution note — UsageRecord has no videoId, the tail is recorded; the Activity production history, last 40), production-board.tsx mounted in the video detail dialog (stage strip with state dots, needs-you attention badges, checkpoint icons + the cost line, collapsible history, 4s live polling while jobs run, context-never-blocker); 459/459 unit; tails: per-video cost attribution, stage deep-links, checkpoint actions |
| 11 | Advanced audio intelligence | P2 | v1 LANDED (S92: docs/design/s92-narration-pacing.md) — narration pacing, measured not guessed: the pure engine (pacing.ts, 5 pins — countWords English tokens + CJK per-character, sceneWpm from the REAL scene-XX.wav durations ÷ word counts, the documented English bands <130 dragging / 130-175 measured / 175-205 brisk / >205 rushed, roles with different targets: hook 185 / body 155 / close 150, the proposal speaks the plan's own vocabulary — the slow/normal/fast hint + the PROJECTED WPM via pacingSpeedFactor, "normal" when in-band, a brisk hook FITS its role, unmeasured scenes land honestly, float noise rounded), GET /api/videos/[id]/pacing (story-format, durations from the real WAV headers through the storage seam, the approved plan's current hints + video speed alongside, the scope note in the response), the measured pacing strip in the Script tab (median WPM + drag/rush counts, expanding to the offenders with their hints — ADVISORY ONLY, never re-synthesizes); 464/464 unit; tails: one-click apply through the existing speed lanes, ASR word-timing precision, music/bed balance intelligence, classic-format pacing |
| 12 | Character animation engine | P3 | v1 LANDED (S93: docs/design/s93-character-rig.md) — the rig as a MOTION SOURCE, not a pipeline (the governing rule holds by construction): character-rig.ts (pure, 4 pins) emits MotionScenePlans — the zoompan engine's OWN vocabulary — for portrait-backed cast scenes: the breath cycle (alternating 2.2s push-in/pull-back on the face-band focal 0.5/0.35, amplitude clamped to intensity×0.25 within [1%,3%] — deliberately below kenburns' 12% default, "a whisper, never a punch"; the approved plan's pacing hints modulate the breath rate via module E's own factor, one hoisted read), the stillness contract senior to the rig itself (motion off/intensity 0 → a labeled hold plan), the continuity law (cast scenes only — the VCE-anchored identity art; non-host scenes keep their motion), the honest-motion law (a still portrait cannot blink — the pose sheet and the i2v lane remain the paths to real motion); the compositor wiring sits at the BOTTOM of the seniority ladder (M2 per-shot > overrides > S2 camera keys > rig > auto plan; no cast → byte-identical legacy path), renderVideo gains character:{hasPortrait}; the smoke 10/10: the rig's graph DIFFERS from the auto plan's, the 3% amplitude + one-zoompan-per-beat visible in the emitted graph, a real render lands (5.23s exact, audio present) + the rig-off legacy render; 468/468 unit; the deferral condition MET (the Universal Timeline closed at S87); tails: the S74 paired battery as the rig's quality instrument, breath-modulation on planned shots, pose-driven beats, a per-video toggle |
| 13 | Blender / 3D engine | P3 | v1 LANDED (S94: docs/design/s94-3d-engine.md) — the acceptance row PROVEN: a real 3D scene rendered through the shared timeline, no isolated pipeline — scene3d.ts (the versioned Scene3D contract, 3 pins: junk/version/empty refused, byte-stable round-trip with strict optionality, deterministic scaffold, cameraAt interpolation, the never-silent light law — no lights → the ambient default, never a black render), render3d.ts (three.js WebGL 2.0 under SwiftShader headless chromium — the S94 probe receipt — through the whiteboard engine's proven chromium pipeline: E10 launch args, route-abort, per-frame screenshots, ffmpeg encode; three r187's ./three.core.js relative import resolved by dual blob injection with the specifier rewritten; blank-raster/init failures throw READABLE errors), the clip rides as an ORDINARY video-kind asset (assembleTimeline → compositionPlan → renderVideo → a delivered cut — the compositor cannot tell it from stock footage, and must not: the governing rule by demonstration), Video.scene3d (the tenth JSON doc column + migration), the scene3d job kind (crash-resumable, deterministic re-render on resume), POST/GET(?clip)/DELETE /api/videos/[id]/scene3d, BOTH kind ledgers 23→24 in the same slice (the S88 CI lesson applied where it bit); the smoke 14/14 (96 frames at 24fps in ~10s, 4.00s exact, the ride-through cut 5.23s vs the 5.2s contract, narration mixed); Blender = the recorded adapter (an offline exporter emits the SAME contract); tails: the LLM scene planner, the Blender exporter, the 3D studio UI, richer materials |

Items 1–3 close Phase 0; item 4 starts the shared-quality era the
moment the Critical row is green. The S75 order of operations above
remains the HOW; this table is the WHAT and the WHEN.

**The production-readiness arc (S99–S107, 2026-11-13).** Between the
table above and the engines, the repo adopted and CLOSED a
production-readiness roadmap — every P0/P1 gate holds with CI evidence
at HEAD: P0.1 clean-clone bootstrap, P0.2 queue leases + fencing,
P0.3 atomic storage admission, P0.4 shared rate limiting + proxy
trust, P0.5 nonce CSP, P0.6 the Docker topology smoke (extended S108
with the in-container whiteboard render), P1.1 the measured restore
drill + alert probe, P1.2 zero warnings + the storage decomposition.
The governing record is `docs/production-readiness.md`. Feature
expansion (new engines beyond the table) stays FROZEN at its decision
point — the freeze lifts only on the operator's explicit call, and
nothing unfreezes autonomously. **The call was made on 2026-11-13
(S109): P2 is OPEN**, against the fully-gated baseline; the entry
queue — security-doc reconciliation, staging provisioning, the launch
drills, the release-candidate tag — is recorded in
`docs/production-readiness.md`.

Standing risks tracked in the worklog: Z.ai gateway outage (S63
remeasurement and the LLM whiteboard planner gated on the one-probe
resumption discipline), production `TUBEFORGE_ENCRYPTION_KEY` on Vercel
(owner-side, unverified), and the dependency PRs (the S97 triage:
five merged, two tombstoned with their dead deps removed, PR #10
TypeScript 7 still open — typescript-eslint's peer ceiling is
`<6.1.0`, re-verified against npm 2026-11-13; mergeable the day the
toolchain catches up).
