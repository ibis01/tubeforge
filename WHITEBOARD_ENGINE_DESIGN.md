# TubeForge Whiteboard Engine — E1 Technical Design

Status: **E1 deliverable (S65)** — architecture for the product-integration
phase, submitted for owner review. Per the plan's own law, product
implementation (routes, editor, DB migration, JobKind wiring) does not
begin until this design is reviewed.

Companions: `WHITEBOARD_ENGINE_AUDIT.md` (E0 — the verified repository
state, the reusable-component map, the risks) · `docs/audits/s64-whiteboard-p0-record.md`
(the P0 engine) · `docs/audits/s65-whiteboard-e1-record.md` (this stage's
execution record). Everything this document asserts about the CURRENT tree
was re-verified during S65 recon on `99a3c3a`.

What landed WITH this document (engine-side hardening the E0 audit §6
explicitly assigned to E1 — not product integration): the id-charset law
and the resource budgets, with 9 new unit contracts (suite 293 → 302).
See §6.

---

## 1. Design summary — the laws that bind every decision

Carried from E0/P0 unchanged:

1. **`whiteboard/` is a leaf module.** It imports shared infra only, never
   Director, never the story engine's planners. Product integration adds
   AROUND it, not INTO it.
2. **One source of motion truth.** `timing.ts`'s frame plan is what the
   renderer rasterizes AND what the editor will play back — the editor
   never re-implements animation (§5).
3. **Determinism.** Frame N is a pure function of (project, library, N).
   No wall-clock animation libraries, no CSS animation during export.
4. **The security pipeline is a property of the pipeline, not the caller.**
   `sanitizeSvg` runs on every asset load; the rasterizer's chromium aborts
   ALL network routes; uploaded assets pass the SAME gates (§7).
5. **$0 native rendering.** Drawing, camera, composition, and encoding
   touch no generation APIs. Only the optional AI planner and TTS are
   metered, through `budget.ts`'s single choke point.
6. **The CI-lane split (S62 law).** CI pins pure contracts; real-render
   evidence is the sandbox benchmark. Product code that becomes a money
   path joins `MONEY_PATHS` (§8).

New with E1:

7. **Every unbounded dimension has a wall with a name.** Ids, path
   commands, placements, events, camera keys, scenes, durations, and
   total frames each have an explicit budget constant (§6) — enforced at
   validation, at extraction, and at render pre-flight.
8. **The project is a document.** One validated JSON doc column on `Video`,
   edited atomically (§2).

---

## 2. Product data model

### 2.1 The decision: `Video.whiteboardProject String?` (a JSON doc column)

The `WhiteboardProject` (title/width/height/fps/hand + scenes with
placements, animation events, camera keyframes — `storyboard.ts`) is
stored as ONE JSON document column, `whiteboardProject`, on the existing
`Video` model. Null = the video never opened the whiteboard editor.

Why a doc column, not a `WhiteboardScene` row family — receipts:

- **House precedent.** `Video` already carries five JSON doc columns —
  `scenes`, `shotList` (the DirectorPlan), `verifyReport`, `commentsKit`,
  `qcReport` — read through the same tolerant parse discipline
  (`parseScenes`/`parsePlan`-style: null-on-invalid, never throw on
  untrusted JSON). `whiteboardProject` is the sixth, not a new pattern.
- **Atomicity.** The editor edits across scenes in one gesture (move a
  camera keyframe, rebalance draw timings). One column write is one atomic
  save. Row-per-scene would need a transaction per keystroke-save and
  still drift on partial failures.
- **Scale is bounded by the budgets.** Worst legal project: 24 scenes ×
  (64 placements + 256 events + 32 camera keys) ≈ a few hundred KB of
  JSON; typical projects are 10–30 KB. Comfortably a doc column.
- **No cross-video scene queries exist or are planned.** Analytics queries
  at video level (duration, status, QC), never scene internals.
- **Schema evolution is migration-free.** Tolerant validation + defaults
  is the exact pattern that survived S40→S49 additive changes: old docs
  read into new engines with defaults filled, new fields ignored by old
  engines.

Concurrency: last-write-wins (the house rule for `scenes`), plus an
advisory `rev` integer inside the doc the editor echoes on save — a
mismatch returns 409 with the server's current doc so the editor can
offer a diff instead of silently clobbering. LWW remains the final law
(exactly like `scenes`); `rev` is UX, not a guarantee.

### 2.2 renderMode

`renderMode` gains the value `"whiteboard"` — a fifth mode alongside
`kenburns` (default), `animated`, `stock`, `slides` in the compositor's
mode union. Whiteboard requires `format: "story"` (narration comes from
scenes, like slides mode enforces). Setting `renderMode = "whiteboard"`
on a `script`-format video returns 409 with the convert-first hint (the
existing convert job converts script → story).

### 2.3 Artifacts + flags

- `uploads/<videoId>/whiteboard/scene-<N>.mp4` (per-scene encodes),
  `final.mp4`, `preview-<sceneId>.mp4` (§4), `assets/` (uploads, §7).
- The existing flags carry the state: `hasVideo` (full render done),
  `hasPreview` (the T-3.7 preview flag), `videoDuration`. `qcReport`
  carries the whiteboard render's QC battery (the benchmark already
  passes 13 lenses).
- Stale-artifact purge joins `render.ts`'s invalidation discipline: a
  storyboard/project edit invalidates final.mp4 + previews exactly the
  way slide-design edits do today.

### 2.4 Migration

One additive column, no default, no backfill:

```prisma
  // Whiteboard Engine (E1 design §2.1) — the validated WhiteboardProject
  // JSON doc; null = never opened the whiteboard editor.
  whiteboardProject String?
```

Additive chain migration, self-healing deploy (the S60/S61 law — the
postgres CI lane replays the wedge-recovery on every push), and the
SQLite mirror syncs via the existing `db:sync-sqlite` path.

---

## 3. JobKind wiring — `whiteboard`, the 21st kind

### 3.1 The kind and its handler

`jobs.ts`'s `JobKind` union gains `"whiteboard"`. Name rationale: the
union's convention is single lowercase words; `render` is taken by the
kenburns/animated/stock final render, and whiteboard is a peer MODE with
its own lifecycle (its failure states, progress labels, and entitlements
must never alias the generic render's).

`queue-handlers.ts` `registerDefaultHandlers()` gains:

```ts
registerJobHandler("whiteboard", (entityId, payload) =>
  runWhiteboardJob(entityId, parseWhiteboardPayload(payload))
);
```

`runWhiteboardJob` follows the `runSlideJob`/`runRenderJob` pattern in
`video-jobs.ts`: `assertCtx` → load video → null-return no-ops (video
gone, `renderMode !== "whiteboard"`, project doc absent/invalid) → run
`renderWhiteboard` with `onProgress` wired to the jobs progress map
(per-scene fractions — the engine already emits them) → store artifacts →
set `hasVideo`/`videoDuration`/`qcReport`. Composite entityIds for scene
previews: `<videoId>#wb<sceneId>` (the `#`-split the slide jobs use;
`sceneId` is charset-legal by §6's law, so it can never contain the
separator).

`resumableKinds()` derives from the live registry (the S3 drift lesson —
registration is the single source; no hand-maintained list).

### 3.2 Queue classification

- **Heavy kind.** `HEAVY_KINDS` gains `"whiteboard"` alongside
  `render`/`short`/`convert` — chromium + ffmpeg is the same class of
  CPU/RAM bound work, and the per-org cap
  (`TUBEFORGE_MAX_RENDER_CONCURRENCY`, default 2) must count it.
- **Attempts: default (2).** Unlike `voiceover`/`director` (maxAttempts 1
  because a whole-job re-run re-pays AI calls), a whiteboard re-run is
  deterministic local work at zero marginal API cost — a crashed worker
  re-renders cleanly.
- **Boot recovery.** The jobs.ts recovery guard gains the idempotence
  check `kind === "whiteboard" && video.hasVideo && video.renderMode === "whiteboard"`
  → mark done instead of re-enqueue.
- **Cancellation.** The engine loops scenes; the job wrapper checks
  cancellation between scenes (the `JobCancelledError` checkpoint
  pattern), so cancel lands at scene granularity.

### 3.3 Worker topology — the honest constraint

`renderWhiteboard` needs headless chromium — the SAME dependency slides
mode has. Today's `Dockerfile` runner ships ffmpeg/fonts but **no
browser** ("the container host mounts one when slide rendering is
enabled"). The whiteboard worker therefore inherits slides' deployment
contract verbatim: the fly/compose worker mounts a chromium (volume or a
dedicated image layer — the exact mechanism is E12's call, decided with
the first slides-production deployment, not duplicated per-mode). Nothing
about whiteboard changes that constraint; the design deliberately shares
it instead of inventing a second browser path.

---

## 4. API surface

All routes live under `src/app/api/videos/[id]/whiteboard/` and inherit
the default-deny middleware: signed-token auth, org tenancy, rate limits,
CSRF origin guard (zero new security surface). Shapes follow the studio
route conventions.

| Route | Method | Purpose |
|---|---|---|
| `/api/videos/[id]/whiteboard` | GET | `{ project \| null, rev, library, budgets }` — the doc (validated server-side before return), the editor palette (asset ids, viewBoxes, tags, drawable summaries — NOT raw SVG; the editor fetches render shapes from the packaged library), and the §6 budgets for client-side enforcement. |
| `/api/videos/[id]/whiteboard` | PUT | Save the whole doc. Body `{ project, rev? }`. Validate via `validateWhiteboardProject` → `400 { errors }` on invalid (the validator's error strings, verbatim — no second error vocabulary). 409 on rev mismatch with the current doc in the response. Normalized project returned. |
| `/api/videos/[id]/whiteboard/scaffold` | POST | The NATIVE planner (E5 phase 1, zero AI): builds a starter project from the story scenes — narration copied per scene, placements from a per-scene-kind rule table, default camera, draw schedules from the fill law. 409 if a project already exists (`force: true` to regenerate). |
| `/api/videos/[id]/whiteboard/render` | POST | Enqueue. Payload `{ sceneId?: string }` — absent = full render (job on the videoId), present = single-scene preview at 720p/24fps without the music bed (job on `<videoId>#wb<sceneId>`, artifact `preview-<sceneId>.mp4`, sets `hasPreview`). Rejects when the project is invalid or over-budget with the exact wall it hit. |
| `/api/videos/[id]/whiteboard/asset` | POST | SVG upload (E11-hardened, §7).multipart, byte-capped. |

Progress/status rides the EXISTING per-video DTO + jobs progress surface —
no new polling route. Scene re-render replaces only that scene's artifact
(the per-scene file layout in §2.3 makes this a file swap + concat at
next full render).

---

## 5. Editor surface — the frame-plan seam

One component family, no new top-level view (whiteboard is per-video,
like the scene editor — it lives in the video detail studio, shown when
`renderMode === "whiteboard"`):

```
src/components/tubeforge/whiteboard/
├── whiteboard-studio.tsx   the surface: palette + canvas + timeline
├── wb-canvas.tsx           playback canvas — SVG DOM + rAF
├── wb-timeline.tsx         event lanes (draw/text/color/move + camera)
└── wb-palette.tsx          asset browser (library + uploads)
```

The seam that makes this design honest: **`wb-canvas` plays back the
project by calling `frameAt(project, library, tMs)` — the same pure
function the renderer rasterizes from — and applies `APPLY_FRAME_FN`**
(the exact page-side applier, already exported for the benchmark).
Scrubbable playback, then, is correct BY CONSTRUCTION: what the editor
shows at t=12.4s is what the MP4 will contain at t=12.4s. There is no
second animation implementation to drift (the determinism law's
consequence for UX, not just for QC).

Phasing:

- **Phase A (view):** scaffold + scrub + play + render buttons. The
  minimum loop that makes the engine a product.
- **Phase B (edit):** timeline event editing (times, durations), placement
  move/resize/rotate, camera keyframes, per-scene narration text,
  background/hand style. All edits go through PUT (validate server-side;
  the client mirrors the budgets from GET).
- **Phase C (assets):** palette browsing + SVG upload (§7) + per-asset
  drawable previews.

E9's stages execute these phases in order; Phase A is the first
product-integration commit after owner review.

---

## 6. Resource + validation budgets — LANDED THIS STAGE

The E0 audit's §6 risks 2–4, now enforced in code with unit contracts
(suite 293 → 302). One source of truth per wall; the constants are the
API the editor and E11 cite.

| Wall | Constant (source) | Value | Enforced at |
|---|---|---|---|
| Id charset | `WB_ID_RE` / `validWhiteboardId` (storyboard.ts) | `[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}`, never `--`/`::` | `extractAsset` (drawable index) AND `validateWhiteboardProject` (scene ids, defense in depth) |
| Path commands | `WB_PATH_COMMAND_BUDGET` (assets.ts) + `countPathCommands` (svg.ts) | 512 EXPANDED commands/path (implicit repeats count) | `extractAsset` — over-budget paths are excluded + reported in `rejected` |
| Placements/scene | `WB_BUDGETS.placementsPerScene` | 64 | `validateWhiteboardProject` |
| Events/scene | `WB_BUDGETS.animationsPerScene` | 256 | `validateWhiteboardProject` |
| Camera keys/scene | `WB_BUDGETS.cameraKeysPerScene` | 32 | `validateWhiteboardProject` |
| Scenes/project | `WB_BUDGETS.scenesPerProject` | 24 | `validateWhiteboardProject` |
| Explicit scene duration | `WB_BUDGETS.sceneDurationMsMax` | 120 s | `validateWhiteboardProject` |
| Σ explicit durations | `WB_BUDGETS.projectExplicitDurationMsMax` | 900 s | `validateWhiteboardProject` |
| Total render frames | `WB_RENDER_FRAME_BUDGET` (timing.ts) | 25,920 (18 min @ 24fps; 14.4 min @ 30fps) | `renderWhiteboard` PRE-FLIGHT via the pure `estimateProjectFrames` — refuses BEFORE chromium launches |

Design notes pinned by tests:

- The frame budget bounds what the validator CANNOT see (VO-measured
  durations): the pre-flight probes VOs, computes every scene duration
  through the shared estimator (`estimateProjectFrames`), and throws
  before any chromium launch — then the render loop REUSES those
  durations, so budget and render can never disagree.
- `countPathCommands` counts EXPANDED commands (a `polyline` written as
  one `L` with 10,000 implicit points counts as 10,000) — the unit the
  flattener and rasterizer actually pay.
- `extractAsset` exclusions are SURFACED (`rejected: {kind, id, reason}[]`),
  never silent — the E11 upload path will reject the upload outright on
  any non-empty `rejected`.

---

## 7. Upload hardening (E11 spec — designed now, built then)

The upload path for user SVGs, in order, each gate naming its existing
unit-pinned sibling:

1. **Transport:** multipart POST, byte cap **256 KB** raw (the
   music-upload precedent's per-file cap discipline).
2. **Sniff:** UTF-8 validity + a single root `<svg` (the
   `sniffImageFormat` byte-inspection pattern from `image-upload.ts`;
   content-type headers are advisory only).
3. **Sanitize:** `sanitizeSvg` (the S64 attack-fixture battery — script/
   foreignObject/iframe/embed/object/image/use/animate subtrees, `on*`
   handlers, `javascript:`/`data:`/`vbscript:` hrefs, external `url()`,
   DOCTYPE/ENTITY).
4. **Budget:** per-path `countPathCommands ≤ 512`; per-asset total ≤ 2,048
   commands; `extractAsset(...).rejected` MUST be empty (charset + command
   walls) — any rejection fails the upload with the reasons.
5. **Rasterize-before-trust:** render the asset standalone through the
   network-aborted chromium context under a wall-clock budget (~5 s) —
   catches pathological-but-valid markup that parses fine and explodes
   raster time. The probe is the SAME renderer, not a separate validator.
6. **Quota:** per-org asset count + bytes through `storage.ts`'s quota
   surface.
7. **Storage:** `uploads/<videoId>/whiteboard/assets/<id>.svg` + a library
   manifest row; the library loader merges built-in + uploaded assets at
   load, uploaded assets carrying an `uploadedBy` provenance field.

Fuzzed fixtures (the S64 attack-fixture pattern extended): malformed
grammar, quadratic-blowup entities, nested `<use>` chains, oversized
coordinate runs, charset-violating ids — all land in the unit suite when
E11 builds the path.

---

## 8. CI-lane + coverage decision

- **Now (E1):** the whiteboard module stays exactly where it is — the
  unit suite's pure contracts (49 whiteboard contracts after S65: 40 from
  S64 + 9 from S65). NOT added to `MONEY_PATHS`: there are no product
  routes yet, and diluting the 50% money-path floor with engine internals
  would weaken the signal the S56 baseline protects.
- **At E9 (routes + JobKind live):** `video-jobs.ts` (already in
  `MONEY_PATHS`) carries the handler's coverage automatically — the
  whiteboard kind's job function will be measured through the existing
  include, no list edit needed. The whiteboard route handlers join the
  money paths only if/when they gate spend (they don't — §1 law 5).
- **Real-render evidence stays the sandbox benchmark** (the S62 split):
  CI has no chromium cache budget for full renders and should not — the
  benchmark script is the per-stage evidence instrument, run in the
  sandbox on the exact tree, exactly as S64 did.

---

## 9. Milestone mapping (E-matrix → stages, updated)

| Plan milestone | Status / next stage |
|---|---|
| E0 audit | DONE — S64 + `WHITEBOARD_ENGINE_AUDIT.md` |
| E1 technical design | **THIS DOCUMENT (S65)** + the §6 hardening landed |
| E2 prototype | DONE (S64 P0) — 63.88s benchmark, all QC lenses green |
| E3/E4/E7 drawing/hand/camera | DONE at P0 fidelity; refinement rides E9 Phase B |
| E5 storyboard intelligence | Phase 1 (native scaffold, zero AI) lands WITH E9 Phase A; phase 2 (LLM planner via `aiCallJson`) is gateway-blocked for verification like S63's re-measure |
| E6 audio sync | Engine-ready (`voFiles` + measured durations + the §6 pre-flight); real-VO verification gateway-blocked |
| E8 renderer integration | P0 proven; the compositor-mode union gains `"whiteboard"` at E9 |
| E9 editor | Phase A/B/C — the FIRST product-integration stages, after owner review of this design |
| E10 QC/benchmarks | Lens-passing proven; per-format (9:16, 1:1) benchmarks ride E9 (the engine already takes width/height/fps from the doc) |
| E11 security hardening | §7 spec'd; execution after E9 Phase C |
| E12 production integration | Entitlements preview: native render is $0 → available to ALL tiers (first $0 creative mode); AI planner/TTS metered as usual. Publish path reuses the export gate + QC. Worker chromium = the slides deployment contract (§3.3) |

---

## 10. Exit gate

**E1: complete.** The architecture above is decided, receipted against
the live tree, and the E0 audit's §6 engine-side risks are closed in code
(302/302 contracts green). Product implementation (E9 Phase A onward)
begins on owner review of this document — the plan's own sequencing law.
