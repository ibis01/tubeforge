# TubeForge — Roadmap

**Status:** Stages 1–7 closed at the code level; the S-series hardening
sprints (S1→S46) landed on top. Feature sprints are ON HOLD for S47 —
Production Integrity and Acceptance (external audit, 2026-11-06: prove
shared admission, acceptance benchmarks, CI evidence, docs truth).
**Last updated:** 2026-11-06
**Source:** `MASTER_PLAN.md` + `FOUNDATION_AUDIT.md` findings + the S47 external audit

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
   Phase A/B landed (S67/S68); the Phase B remainder (palette + asset
   management behind §7's seven gates) is the immediate milestone.
2. **Creator Intelligence Engine** (`docs/audits/creator-intelligence-record.md`)
   — hook/script scoring (CI-1), title+thumbnail pairing lint (CI-2),
   transcript-based Shorts selection feeding the existing renderer
   (CI-3), retention ingestion mapped to scenes (CI-4, needs the
   Analytics API scope). Proposes, never auto-edits; every score labeled
   a heuristic.
3. **Visual Consistency platform service** — not verified as complete.
4. **Video Critic and Repair foundation** — not verified as complete.
5. **Universal timeline contract and editor** — pending; the Whiteboard
   loop proves the shared contracts first.
6. **Audio / motion graphics / character animation / documentary / 3D
   engines, asset marketplace** — pending, sequenced after the shared
   systems they consume.

Standing risks tracked in the worklog: Z.ai gateway outage (S63
remeasurement and the LLM whiteboard planner gated on the one-probe
resumption discipline), production `TUBEFORGE_ENCRYPTION_KEY` on Vercel
(owner-side, unverified), and the open dependency PRs (majors tested
individually, never batch-merged).
