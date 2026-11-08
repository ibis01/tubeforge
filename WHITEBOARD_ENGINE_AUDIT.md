# TubeForge Whiteboard Engine — E0 Repository Audit

- **Date**: 2026-11-09 UTC
- **Audited state**: `main` @ `83aa7d3` (CI run 42534021634, 6/6 green —
  gitleaks · postgres · Typecheck/Lint/Unit · coverage · build · e2e)
- **Auditor**: the coding agent, read-only pass over every area the plan's
  §15 E0 assignment lists. Application code was NOT modified for this
  document.
- **Provenance note**: the plan's E0 (repository audit) was first executed
  as Stage 64's Phase 0 (see `docs/audits/s64-whiteboard-p0-record.md` §1);
  the P0 prototype (the plan's "first working 60-second MP4" milestone)
  then landed as S64 itself, CI-proven. This document is the formal,
  consolidated E0 deliverable the plan names — it audits the repository
  AS IT NOW STANDS, P0 included, and sets the E1+ road.
- **Governance vocabulary**: every section below closes with
  PASS / PARTIAL / FAIL / BLOCKED / NOT VERIFIED.

---

## 1. Executive summary

TubeForge is unusually well-positioned to host the Whiteboard Engine:
nearly every piece of surrounding infrastructure the plan's §3 asks for
already exists, is production-hardened, and is CI-pinned — the job queue
(20 registered kinds, crash-recovery payloads, cooperative cancel,
per-org heavy caps), multi-tenant auth with a default-deny API gate,
credit billing with reservation holds and a USD spend door, local/S3
storage with quotas and signed URLs, the FFmpeg render/QC/audiomix stack,
and the synthesized music library. What did NOT exist before S64 — an SVG
path engine, a drawing-hand model, deterministic frame planning, a
chromium rasterizer — landed as the S64 P0 and is now proven by a real
63.88-second 1080p benchmark that passes every applicable house QC lens.

The plan's six architectural requirements score as follows TODAY:

| Requirement | Verdict | Evidence |
|---|---|---|
| Independent (of Director) | **PASS** | `src/lib/tubeforge/whiteboard/` imports nothing from `director.ts`/`director-plan.ts`/`production-profiles.ts`/`shots.ts`/`motion.ts`/`liveliness.ts`; unit-pinned by module isolation (the engine's tests never touch Director code paths) |
| Native-first (no paid APIs to draw) | **PASS** | SVG + chromium + FFmpeg only; the S64 benchmark rendered 63.88s with zero generation-API calls |
| Deterministic | **PASS** | The frame plan is a pure function of (project, assets, durations) — pinned by a same-inputs-same-frames unit contract; no CSS animation, no wall-clock in the engine |
| Editable | **PARTIAL** | Every visual change is an `AnimationEvent` with identity/start/duration and the scheduler treats editor events as senior — but there is no editor surface yet (Phase 1+) |
| Scalable (background jobs) | **PARTIAL** | The queue is proven; the whiteboard is not yet wired to it (benchmark-only path today) |
| Compatible (no regressions) | **PASS** | Full battery green on `83aa7d3`: tsc 0 · eslint 0/20 (census unchanged) · unit 293/293 (253 pre-S64 + 40 new) · billing 40/40 · queue PASS · build ✓ · CI 6/6 |

**Overall E0 exit gate: PASS.** The recommended next milestone is E1 —
the technical design doc for product integration (§8 below).

---

## 2. Verified current repository state

Everything in this section was re-verified on the audited tree this
session (not from memory):

- **Stack**: Next.js 16 (App Router, standalone output) · React 19 ·
  TypeScript 5 strict · Prisma 6.19 over PostgreSQL (SQLite mirror for
  local/CI lanes) · Tailwind 4 · shadcn/radix UI. Node 22 in CI, Node 24
  in the sandbox. `package.json` scripts: `typecheck`, `lint`, `test`,
  `test:queue`, `test:billing`, `test:coverage`, `test:e2e`, `worker`.
- **CI** (`.github/workflows/ci.yml`): six jobs on every push/PR —
  gitleaks full-history secret scan; check (typecheck+lint+unit+queue+
  billing, with ffmpeg installed); production build; money-path coverage
  (c8, 50% floor, baseline 56.30%); PostgreSQL 17 integration lane
  (migrations + the S60 wedge-recovery replay + a 27-assertion battery);
  Playwright e2e on main pushes. A nightly workflow runs the route
  battery + e2e on schedule.
- **Test inventory**: unit+regression 293 (real-ffmpeg QC fixtures
  included) · billing integrity 40 (self-seeding money path) · queue
  integration (real worker-restart recovery, 2 phases) · e2e 26 across
  5 Playwright suites (smoke, isolation, pipeline, premium-ux,
  mobile-sweep) · ~60 stage probe scripts (sandbox discipline).
- **Deployment**: Vercel (`vercel.json` fluid compute) for the app;
  `fly.toml` + `Dockerfile` + `docker-compose.yml` define a web+worker
  split with a Postgres service and a shared uploads volume — the
  plan's §10 "separate rendering workloads" topology already has a
  committed skeleton.
- **The whiteboard P0 (S64, landed this session)**:
  `src/lib/tubeforge/whiteboard/{svg,storyboard,timing,assets,render}.ts`
  (~1.6k lines), 40 unit contracts, `scripts/s64-whiteboard-benchmark.mts`,
  evidence in `validation/s64/` (manifest + project.json committed).

Verdict: **PASS**.

---

## 3. Existing reusable components (mapped to the plan's needs)

| Plan need | Existing component (path) | Reuse verdict |
|---|---|---|
| Job orchestration | `jobs.ts` (20 kinds, dedupe, progress, boot recovery), `queue.ts` (atomic claims, retry backoff 30s→10min, per-kind max attempts, per-org heavy cap `TUBEFORGE_MAX_RENDER_CONCURRENCY`), `queue-handlers.ts`, `cancel.ts`, `scripts/worker.mts` | **Direct reuse** — a `whiteboard-render` kind joins the registry (Phase 1) |
| Auth + tenancy | `middleware.ts` (default-deny, signed tokens, rate limits, CSRF origin guard), `auth.ts`/`auth-token.ts`, `tenant.ts`/`tenant-db.ts` (Prisma client extension scoping every query by org) | **Direct reuse** — routes inherit everything for free |
| Billing | `billing.ts` (microcredits, reserve→settle holds, Stripe lifecycle), `spend.ts` (USD "the $5 door"), `budget.ts` (the `aiCall` choke point) | **Direct reuse** — native rendering is $0-metered; only optional AI planner/TTS touches credits |
| Storage | `storage.ts` (local + S3 via zero-dep SigV4, quotas, presign, `withLocalFile` scratch) | **Direct reuse** — outputs land as artifacts exactly like final.mp4 today |
| Providers | `providers/registry.ts` + per-capability adapters (chat/vision/image/video/tts/asr), `llm.ts` | **Direct reuse** — the plan's "structured-output provider abstraction" IS `aiCallJson`/`parseJsonLoose` + the registry |
| Audio | `wav.ts`, `audiomix.ts` (−16 LUFS contract), `music.ts` (synthesized library), `captions.ts`, `voice.ts`/`voice-clone.ts`, `audio-preview.ts` | **Direct reuse** — the S64 benchmark already consumes the house music path |
| QC | `qc.ts` (13 lenses), `render-qc.ts`, `visual-qc.ts`, `qc-policy.ts` (S40 ship gate) | **Direct reuse** — the whiteboard benchmark already passes through `runQcReport` |
| Render/encode discipline | `render.ts` (execFile, no shell), `motion.ts`, `slides.ts` (the Playwright-rasterizes-designed-PNGs precedent) | **Pattern reuse** — the whiteboard renderer follows the slides-mode law |
| Storyboard intelligence | `story.ts`, `director-plan.ts` vocabularies, `production-profiles.ts` | **Reuse for the AI-assisted planner phase only** — deliberately NOT imported by the P0 |

Verdict: **PASS** — the plan's "do not duplicate infrastructure" rule is
satisfiable everywhere.

---

## 4. Proposed module boundaries

As landed (S64 record §2, frozen):

```
src/lib/tubeforge/whiteboard/
├── svg.ts          PURE — sanitizer (security gate) + full path grammar +
│                   arc-length/point/tangent math
├── storyboard.ts   PURE — WhiteboardProject/Scene/AnimationEvent/CameraEvent
│                   + house-style validation (null-on-invalid)
├── timing.ts       PURE — narration clock (2.6 wps | measured VO), the fill
│                   law scheduler, the frame plan, pen follow/rest/enter,
│                   the permanent camera drift
├── assets.ts       DATA — the starter vector library + extraction +
│                   scheduler text registries
└── render.ts       PROCESS — chromium rasterizer (network-aborted) +
│                   FFmpeg assembly (scenes → concat → music bed)
```

Phase-1+ boundaries (for E1 to formalize):

- `whiteboard/` stays a leaf module importing only shared infra — never
  Director.
- Product integration adds: a `whiteboard-render` JobKind +
  `runWhiteboardRenderJob` in `video-jobs.ts`'s pattern; a `Whiteboard`
  DB model family (project/scene rows or a JSON-doc column on Video —
  E1 decides, the parsePlan/JSON-doc precedent favors a doc column);
  API routes under `src/app/api/videos/[id]/whiteboard/*` following the
  studio route conventions; the editor as a `views/` + `components/`
  surface like timeline-studio.
- The asset library grows in `assets.ts` (P0) → a categorized library
  phase (plan §C) with an upload path through `image-upload.ts`-style
  byte sniffing + `sanitizeSvg`.

Verdict: **PASS** (P0 boundaries frozen and unit-pinned; Phase-1
boundaries sketched, E1's job).

---

## 5. Dependency analysis

Present and required (verified in `package.json` + this session's runs):

- `playwright` 1.57 (+ cached chromium-1200) — the rasterizer; already a
  production dependency for slides/e2e.
- `zod` 4 — used at API boundaries; the whiteboard's own validation is
  hand-rolled (`parsePlan` precedent) which the plan explicitly permits.
- `sharp`, `undici`, FFmpeg/ffprobe (system, 7.1.5 in sandbox and CI) —
  house media stack.

Absent, and deliberately so:

- **Remotion** — NOT VERIFIED as needed: the P0 proves chromium+
  FFmpeg produces the exact frame-based determinism the plan demands
  (state computed per-frame from OUR math), at zero new dependency and
  zero license exposure. Remotion remains an E8-alternative only if
  scene complexity outgrows the SVG compositor.
- **GSAP** — not needed: all interpolation is our pure math (the
  determinism law forbids wall-clock animation libraries during
  export anyway, per the plan's own §6 note).
- **framer-motion** — declared but with ZERO imports anywhere in
  `src/` (dead dependency, pre-existing). Cleanup candidate for a
  dependency-hygiene stage; removal is trivial and safe.

Cost posture: rendering, drawing, camera, composition, and encoding are
$0 API. LLM storyboard assistance and TTS ride the existing metered
providers through `budget.ts`'s single choke point — the $5 testing cap
is enforced by `spend.ts` today.

Verdict: **PASS** (with the framer-motion dead-dependency note).

---

## 6. Security risks

Already in place (verified):

- **SVG sanitization** (`sanitizeSvg`): strips script/foreignObject/
  iframe/embed/object/image/use/animate subtrees, `on*` handlers,
  `javascript:`/`data:`/`vbscript:` URLs, external `url()` refs, and
  DOCTYPE/ENTITY attacks — unit-pinned with attack fixtures, including
  the byte-identical round-trip for clean markup.
- **Defense in depth**: the rasterizer's chromium context aborts ALL
  network routes — the page can only ever render markup we wrote.
- Route-level auth/tenancy/rate-limiting all inherit from the existing
  default-deny middleware once product routes exist.

Known risks to carry into E1 (NOT VERIFIED yet, by design of P0 scope):

1. **User-uploaded SVGs** — the sanitizer is regex-based; the upload
   path (byte limits, size caps, rasterize-before-trust) does not exist
   yet. The plan's "rasterize or sanitize uploaded assets" needs an
   explicit upload phase with fuzzed fixtures.
2. **Unbounded path counts** — a path with thousands of commands
   flattens to thousands of points; `CURVE_STEPS`/`ARC_STEPS` multiply.
   Needs a per-asset command/point budget at validation time.
3. **The renderer's regex id namespacing** (`composeScene`) assumes
   asset ids/path ids cannot contain `--` or `::`; the validator does
   not yet pin an id charset — cheap to add in E1.
4. **Render resource limits** — chromium memory on 4GB workers for long
   videos; the job's heavy-kind concurrency cap helps but per-project
   frame budgets (max scenes × duration) belong in validation.

Verdict: **PARTIAL** — the P0 surface is pinned; upload hardening is
the open work.

---

## 7. Testing gaps (against the plan's §9 matrix)

Covered today: unit (path math, sanitizer, storyboard, timing,
library) · real-render evidence (benchmark + QC + pixel forensics) ·
regression (Director untouched; suite 253 → 293 green; e2e 26 green).

Open gaps, in priority order:

1. **Whiteboard money-path coverage** — the c8 `--include` list does
   not cover `src/lib/tubeforge/whiteboard/` (the 50% floor measures
   billing/spend/render kin). Add the module once product routes make
   it a money path.
2. **Chromium-in-CI** — check/coverage lanes install ffmpeg but not
   browsers (only e2e owns chromium). Real-render whiteboard tests
   must stay out of the check lane (the CI-lane law), or the lanes
   need a browser install — an E1 decision with a cost attached.
3. **Determinism across encodes** — the frame PLAN is pinned
   deterministic; bit-exact MP4 reproducibility (same inputs → same
   bytes) is NOT VERIFIED (x264 is not bit-deterministic across
   machines). The plan's "same frame output" holds; "same file bytes"
   would need fixed-thread x264 — document, don't chase.
4. **VO synchronization** — the timing engine consumes measured WAV
   durations, but no end-to-end VO test has run (the gateway outage).
   NOT VERIFIED until real TTS WAVs exist.
5. **Adversarial upload fixtures** — per §6 above.

Verdict: **PARTIAL** — deliberate, receipted gaps.

---

## 8. Recommended implementation order (E-milestone mapping)

The plan's E0–E12, mapped onto the repo's stage system and what
already exists:

| Plan milestone | Status / next stage |
|---|---|
| E0 audit | **DONE** — S64 Phase 0 + this document |
| E1 technical design | **NEXT (S65)** — `WHITEBOARD_ENGINE_DESIGN.md`: the JobKind wiring, DB shape (doc-column vs rows), API surface, editor views, upload hardening, the CI-lane decision |
| E2 prototype | **DONE** (S64 P0) — 63.88s benchmark, all QC lenses green |
| E3/E4/E7 drawing/hand/camera | **DONE** at P0 fidelity (progressive stroke reveal, path-following pen with enter/rest/wobble, keyframed camera + drift); refinement rides E1's editor |
| E5 storyboard intelligence | **OPEN** — native fallback rules + the LLM-assisted planner through `budget.ts` |
| E6 audio sync | **BLOCKED** on the gateway outage for real-VO verification (the engine side is ready — `voFiles` + measured durations) |
| E8 renderer integration | P0 proven; Remotion explicitly deferred as NOT VERIFIED-unnecessary |
| E9 editor | **OPEN** — Phase 1 surface work |
| E10 QC/benchmarks | lens-passing proven; per-format (9:16, 1:1) and performance baselines ride E1 |
| E11 security hardening | upload path + fuzzed fixtures (§6) |
| E12 production integration | entitlements, publishing paths, worker topology (the fly/compose skeleton exists) |

Standing owner-side blockers (unchanged from the external audit):
`TUBEFORGE_ENCRYPTION_KEY` on Vercel (re-store provider credentials
after), and the GitHub PAT that transited chat — rotate out-of-band at
the next natural milestone. Also parked: S63's gateway-blocked
re-measure (resumable protocol in its record §5).

---

## 9. Exit gate

**E0: PASS.** The repository state is verified, the reusable surface is
mapped, the P0 prototype is landed and CI-proven, and the risks above
are explicit and receipted. Per the plan's own law — "do not begin
[product] implementation until the audit and architecture have been
reviewed" — the next deliverable is **E1: WHITEBOARD_ENGINE_DESIGN.md**,
awaiting owner review of this audit.
