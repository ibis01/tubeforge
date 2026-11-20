# Whiteboard Production System — Full Audit + the P0 Raster-to-Stroke Plan

**Status:** PROPOSED (implementation per stage requires the operator's approval, per the
cinematic plan's law). This document is the two deliverables the operator ordered for the
"professional whiteboard video production system" directive:

1. **The audit** — TubeForge's live whiteboard (via the Studio lineage) implementation measured against the target
   architecture (six-stage production flow, three stroke techniques, choreography
   features, five-layer architecture, five production profiles, five benchmark subjects,
   the Islamic-content constraint).
2. **The P0 plan** — the file-by-file implementation plan for the raster-to-stroke
   engine (technique B, the operator's "Highest priority for TubeForge"), on the existing
   engine, with no second renderer and no new frame clock.

**Method.** Every claim below was read out of the live tree at `08827d9` (main, CI 8/8,
run 44483527453). File:line references are load-bearing; where a claim rests on a prior
receipt, the receipt is named.

---

## Part I — The audit

### I.1 Verdict, in one paragraph

The engine at `src/lib/tubeforge/whiteboard/` is a **mature, deterministic, vector-only
whiteboard system** that already satisfies the two hardest architecture laws the
directive insists on: preview and export run the SAME animation logic on the SAME frame
clock (`frameAt`, `timing.ts:682-739`, applied by the one `APPLY_FRAME_FN` in
`wb-page.ts` — editor call site `wb-canvas.tsx:292`, renderer call site `render.ts:629`;
there is no second implementation to drift), and rendering rides the retained Chromium +
FFmpeg pipeline (`render.ts:376-805`). Stage 4 (drawing animation) and Stage 5 (camera &
choreography) are the strongest layers — hand-following, variable stroke speed, pen-up
travel, a beat-driven camera director, carried-ink board continuity, and SFX all exist
and are receipted (W1–W7 stages of the VideoScribe reconciliation landed as
`benchmark-scenarios.ts`, `beat-plan.ts`, `asset-validate.ts`, `text-draw.ts`/`glyphs.ts`,
`camera-director.ts`, the `BoardPolicy` block in `storyboard.ts`, `sfx-plan.ts`).
The three material gaps are exactly the ones the directive targets: **(B) raster-to-stroke
is entirely absent** — a PNG/JPG cannot even enter the pipeline (it dies at the UTF-8
sniff, `upload.ts:63-71`); **AI illustration generation has no bridge into the
whiteboard lane** (the story lane generates PNGs via `providers/image.ts`, but no
whiteboard code path touches them); and **the whiteboard lane has no production profiles
and no restricted-subject guard** (both exist only in the story/director lane).

### I.2 The six-stage production flow, against the live tree

| Stage | Verdict | Evidence |
| --- | --- | --- |
| 1 Script & narration | EXISTS (delegated to the story lane) | `scaffold/route.ts:49` consumes `parseScenes(video.scenes)`; narration clock `sceneDurationMs` precedence explicit > VO-measured > 2.6-wps estimate (`timing.ts:101-105`); per-word anchors `voice-anchors.ts` (`buildVoiceAnchors:79`, ASR `transcribeWords`), fed when `opts.asrAnchors` (`render.ts:412-433`) |
| 2 Visual planning | EXISTS (catalog selection, not generation) | Native rule-table planner `scaffoldWhiteboardProject` (`whiteboard-planner.ts:364-492`); LLM planner `scaffoldWhiteboardProjectLlm` (`llm-planner.ts:547-628`) — model may only pick ids from the merged catalog (`buildPlannerCatalog:92-109`); honest degradation to native (`:565-577`); semantic beats `beat-plan.ts` compile-only law |
| 3 Illustration generation | **MISSING for the whiteboard lane** | Zero `imageGenerate` imports under `whiteboard/`; the story lane's `generateSceneImage` (`story.ts:793`) produces raster PNG (`providers/image.ts:565-566`) with no bridge into whiteboard assets. Vector library: ~40 hand-authored SVG assets incl. the `fx-*` emphasis pack (`assets.ts:100-478`) |
| 4 Drawing animation | EXISTS (strong) | Fill-law scheduler `scheduleScene` (`timing.ts:160-251`); eased per-stroke `penProgress` (sine-in-out, `:53-59`), one progress for ink/text/hand (lockstep law `:607-612`); dash write-on (`wb-page.ts:142-165`, `render.ts:596-613`); handwriting via committed Caveat glyph outlines (`glyphs.ts`, `text-draw.ts:90+`); sketch/hatch (`sketch.ts`) and Rough.js port (`roughen.ts:270`, `fills.ts:260`) |
| 5 Camera & choreography | EXISTS | Camera director `directCamera` (`camera-director.ts:150+`) — beat focus rects, zoom clamps 1→1.6, travel floor 420 ms; interpolation + fallback drift `cameraAt`/`cameraDrift` (`timing.ts:351-382`, `:314-320`); hand `handAt` (`timing.ts:530-665`) — active-stroke sampling, micro-tremble, pen-up travel, poses by role; board carry/exit `BoardPolicy` (`storyboard.ts:99-118`, `resolveCarriedInk` `timing.ts:433-464`) |
| 6 Audio & final rendering | EXISTS | `renderWhiteboard` (`render.ts:376-805`): frame-budget pre-flight (25,920 frames, `timing.ts:758`), per-scene chromium contexts, per-frame JPEG screenshots, per-scene ffmpeg + VO apad, loudness contract `normalizeVoSlot` (`:93-126`), final concat + music bed + SFX amix (`:738-800`); SFX cue plan `sfx-plan.ts:92-117`; job wiring `runWhiteboardJob` (`video-jobs.ts:2215-2324`) |

### I.3 The three stroke techniques

**A. Vector stroke animation — EXISTS (benchmark-proven).** Full SVG path grammar
flattened to polylines with arc-length math (`svg.ts:101-136` + flatteners); geometry
map `buildGeometry` (`timing.ts:781-796`); progressive reveal via `stroke-dashoffset` in
the shared applier (`wb-page.ts:142-165`). This is the engine's core.

**B. Raster-to-stroke — MISSING (confirmed; the P0 gap).** No edge detection,
skeletonization, centerline tracing, or stroke-ordering code exists anywhere in the repo
(`rg potrace|imagetracer|opencv|vectorize|centerline` → zero hits). The pipeline actively
rejects raster content at three independent walls:
1. The UI file input accepts SVG only (`whiteboard-studio.tsx:645`, `accept=".svg,image/svg+xml"`).
2. The sniff kills non-UTF-8 byte streams before anything else (`upload.ts:63-71` —
   a PNG/JPG returns "the file is not valid UTF-8 — export plain SVG text").
3. Even a wrapped raster dies: `<image>` is a blocked element (`svg.ts:39`), and the
   extraction law demands `<path>`/`<text>` geometry (`upload.ts:166-172`).
Storage is SVG-fragment-only (`asset-store.ts:27-40` — key `${…}/${assetId}.svg`,
manifest `WhiteboardUploadRow` carries `viewBoxW/H, bytes, uploadedBy` only).

**C. Layered reveal — PARTIAL.** Exists: per-text clipPath wipe (`wb-page.ts:167-198`);
color reveal as opacity fade on a path or asset group (`wb-page.ts:199-205`); progressive
fill as drawable pen strokes (hachure/cross-hatch/zigzag/dots, `fills.ts:64-297`,
budget-capped `MAX_FILL_COMMANDS 512`); scene-level exits fade/erase/pan-away
(`timing.ts:473-493`). Missing: directional wipe/mask over arbitrary artwork and a
first-class mask channel in `FrameState` (`timing.ts:283-300` has none — the only mask
is the ad-hoc per-text clip). P0 does NOT need this channel; P1+ does.

### I.4 Choreography features

| Feature | Verdict | Evidence |
| --- | --- | --- |
| Progressive drawing | EXISTS | `scheduleScene` + `frameAt` draws map (`timing.ts:691-703`) |
| Hand follows pen | EXISTS | `handAt`/`strokePoint` sample the same flattened geometry (`timing.ts:564-595`); lockstep law `:607-612` |
| Variable stroke speed | EXISTS | Eased progress (`:53-59`); length-weighted slices (`:196-197`); derived-stroke cost factors (`:187-188`); sparse-board cadence (`:219`) |
| Drawing pauses | PARTIAL | Pen-lift gaps `PATH_GAP_MS 130` (`:39`) + `pen-stop` SFX on ≥400 ms gaps (`sfx-plan.ts:36,71`); no first-class pause event type (`storyboard.ts:28-59`) |
| Camera movement | EXISTS | Keys (`storyboard.ts:62-69`), director (`camera-director.ts`) |
| Highlights/emphasis | EXISTS | `fx-*` role `"emphasis"` (`assets.ts:316-390`); emphasis beats (`beat-plan.ts:523-542`); hand `circle`/`point` poses (`timing.ts:550-557`) |
| Object transforms | EXISTS | `move_object` event (`storyboard.ts:52-59`), `placementAt` (`timing.ts:496-516`) |
| Scene transitions | PARTIAL | Board carry/exit policy exists; cross-scene visual blends pinned `null` (`tracks.ts:99-101,129-130`) |
| Sound effects | EXISTS | `project.sfxOn` (`storyboard.ts:138`), cue plan + ffmpeg layer; audio never affects frames (`sfx-plan.ts:8-9`) |

### I.5 Five-layer architecture

| Layer | Verdict | Note |
| --- | --- | --- |
| AI Director | PARTIAL | Planning (`llm-planner.ts`, `beat-plan.ts`, `camera-director.ts`) exists; script/VO live in the story lane — by design, not a defect |
| Visual Asset Engine | PARTIAL | Vector-only; AI illustration and data-bound charts absent |
| Stroke Processing Engine | PARTIAL (strong on vectors) | Sanitizer, path grammar + arc-length, W3 validator (`teleport \| self-intersection \| caps \| closed-direction \| fill-after-outline \| orientation`, `asset-validate.ts:43-49`), sketch/roughen/fills derivation — all excellent. **Raster tracing: absent** |
| Animation & Choreography Engine | EXISTS | Deterministic, receipted |
| Shared Preview & Rendering Pipeline | EXISTS — verified | Same `frameAt` + `APPLY_FRAME_FN` both sides (see I.1); the 720p/24 fps scene-preview MP4 also rides `renderWhiteboard` (`video-jobs.ts:2244-2259`) |

### I.6 Production profiles — MISSING in the whiteboard lane

`production-profiles.ts` defines 8 director-lane profiles (`narrative, documentary,
explainer, advertisement, animation, podcast, social, islamic-history`) — none
whiteboard-shaped. Whiteboard configuration is per-project today (`hand {style:
marker\|pencil\|chalk, scale, side}`, `width/height/fps`, `sfxOn`, per-scene
`background` + `BoardPolicy`, per-asset `roughness/bowing`, `textMode: glyph|marker`).
The five production profiles (Classic / Storytelling / Mathematical & Scientific /
Technical & Engineering / Modern Motion) are a **configuration layer that does not
exist yet** — P4/P5 scope, not P0.

### I.7 Benchmark coverage — W1 exists; the five-subject suite does not

`benchmark-scenarios.ts` is the W1 perceptual baseline: fixed topic ("How Your Heart
Works"), five scene types (`w1-title`, `w1-process`, `w1-comparison`, `w1-phrase`,
`w1-conclusion`), three aspects (16:9 / 9:16 / 1:1) at 24 fps, deterministic build
(`buildBenchmarkProject:266-303`), nine rubric dimensions (`:82-92`). The directive's
five benchmark subjects (science, engineering, Islamic history, business, general
education) are an **extension of this harness**, not a new one.

### I.8 The Islamic-content constraint — MISSING in the whiteboard lane (audit finding)

The doctrine exists system-level and is enforced L1–L5 in the story/cinematic lane only
(`restricted-subjects.ts:50-75`; compose/direct/paint/verify/gate, BLOCK severity in
`qc-policy.ts`). Grep for `islamic|restricted|contentPolicy|policyId` across the
whiteboard module, its routes, and UI: **zero matches**. The whiteboard LLM planner
prompt carries no policy clause; the render lane has no restricted-subject frame scan.
Mitigating fact: today's asset universe is generic vector icons — but the P0 raster lane
introduces arbitrary imagery (uploads AND AI generations), so the guard must land WITH
P0, not after. The P0 plan carries it (see P0-7).

### I.9 Change-surface facts P0 must respect (read out of the code)

1. **Sniff order is law** (`upload.ts` header): transport → sniff → sanitize → budget →
   validator → probe → quota/storage. A raster branch must preserve the gate semantics,
   not bypass them.
2. **Traced output needs no new runtime machinery**: pure single-subpath `<path id d>`
   markup flows through the existing `extractAsset → validateAsset → buildGeometry →
   scheduleScene → frameAt` chain unchanged — the hand rides it like any library asset.
3. **Command budgets**: `WB_PATH_COMMAND_BUDGET 512`/path (`assets.ts:505`) and
   `WB_UPLOAD_TOTAL_COMMAND_BUDGET 2048`/asset (`upload.ts:28`); a photo trace exceeds
   2,048 expanded commands easily — the tracer must simplify/merge, and a traced-profile
   budget constant is needed.
4. **The validator is the teleport gate**: tracer output MUST be split into discrete
   single-subpath paths or uploads land in warn-and-exclude (`assets.ts:669-674`).
5. **`FrameState.draws` keys `"assetId::pathId"`** → per-element dash reveal; traced
   strokes are ordinary geometry. No mask channel needed for P0.
6. **Store is trace-only friendly**: storing the derived SVG fits the existing
   `WhiteboardUploadRow` schema unchanged; keeping the original raster would need a
   migration (P0 recommends trace-only storage + a trace receipt).
7. **Scheduling pressure**: `MAX_PATH_MS 2600`/`MIN_PATH_MS 260` + fill law compresses
   dense traces to the floor; pen-group batching is the tuning lever
   (`penGroups`/`drawOrder`/`role` metadata already exist, `assets.ts:33-43`).
8. **Levers already in the tree**: `sharp` is a dependency (preprocessing), playwright
   is available (offscreen canvas if needed), `countPathCommands` gives an exact
   post-trace budget check (`svg.ts:129-136`).

---

## Part II — The P0 plan: the raster-to-stroke engine

**Goal (the operator's words, operationalized):** PNG/JPG uploads AND AI-generated
illustrations become drawable whiteboard strokes — same engine, same frame clock, same
renderer, same validator law. Nothing about the vector lane changes.

**Non-goals (this stage):** color-layer masking (technique C full), production profiles,
the five-subject benchmark suite beyond its P0 seed, editor/timeline work.

### Design in one paragraph

A **pure, deterministic tracing module** converts a raster image into line-art strokes:
normalize (sharp) → grayscale + downscale to a fixed working size → adaptive threshold
to a binary mask → morphological cleanup → Zhang-Suen skeletonization to 1 px
centerlines → centerline following into polylines (junction-aware, deterministic start
order) → Douglas-Peucker simplification → split into single-subpath `<path>` elements →
deterministic stroke ordering (reading order, role grouping, length-aware) → emit a
sanitized SVG fragment with a proper viewBox. The fragment enters the EXISTING upload
gates at the sanitize step and rides the existing pipeline to storage, library, editor,
and render. The upload route grows a magic-byte branch; the studio UI grows file
acceptance and a trace state; the AI bridge is a provider call feeding the SAME trace
pipeline. Preview ≡ export is preserved by construction — traced strokes are ordinary
geometry; `frameAt` and `APPLY_FRAME_FN` are untouched.

### File-by-file

**P0-1 `src/lib/tubeforge/whiteboard/trace.ts` (NEW — the core).** Pure module, no fs/DB/
network. Exports:
- `traceRasterToStrokes(bytes: Buffer, opts: TraceOptions): TraceResult` — the pipeline
  above. `TraceOptions { maxWorkingSize?: number (default 1024); threshold?: "otsu" |
  number; simplifyEpsilon?: number (default 1.2 working-px); minStrokeLenPx?: number
  (default 6); maxStrokes?: number (default 400) }`.
- `TraceResult { svgFragment: string; viewBox: {w,h}; strokes: number; commands: number;
  workingSize: {w,h}; receipt: TraceReceipt }` — the receipt records every stage's
  numbers (mask coverage, junction count, simplification ratio, per-stage ms) for the
  render manifest and honest debugging.
- Determinism law: fixed working size, fixed threshold, stable tie-breaking sorts, fixed
  decimal precision on emitted coordinates. Unit pins assert byte-identical output for
  identical input bytes.
- Stage helpers are exported for pins: `grayscaleResize`, `binaryMask`, `skeletonize`,
  `followCenterlines`, `simplifyPolyline`, `orderStrokes`, `emitStrokeSvg`.
- Implementation notes: Zhang-Suen on a Uint8Array working grid; junction handling =
  do not cross a pixel with >2 skeleton neighbors twice (split at junctions — strokes
  end where the pen would lift); ordering = reading order (row bands top→bottom,
  left→right inside a band), long structural strokes before short details, details
  before fills (the `fill-after-outline` validator law already demands this shape).

**P0-2 `src/lib/tubeforge/whiteboard/upload.ts` (EDIT — the raster gate branch).**
- `sniffImageUpload(raw)` — magic bytes: `\x89PNG` / `\xFF\xD8\xFF`; returns
  `{kind: "raster", width, height}` (dimensions parsed from the headers, sharp-verified
  later) or defers to `sniffSvgUpload` for text.
- `WB_RASTER_MAX_BYTES = 8 MB`, `WB_RASTER_DIMENSION_MAX = 4096` (mirrors the viewBox
  ceiling law).
- `validateUploadedRaster(raw, filename, reservedIds)` — gates 1–4 mapped to raster:
  byte cap → magic-byte sniff → **trace** (`traceRasterToStrokes`) → the SAME
  sanitize/budget/validator gates the SVG path runs on the traced fragment → returns
  the same `UploadValidationOk` shape (asset tags `["upload","traced"]`, plus the trace
  receipt on the ok branch). Rejection errors stay readable and name the failing gate
  (e.g. "the trace produced 0 strokes — the image may be a solid photo without line art;
  try a higher-contrast source").
- `validateUpload(raw, filename, reservedIds)` — new unified entry: sniffs once,
  dispatches to the SVG or raster validator. The route calls only this.

**P0-3 `src/app/api/videos/[id]/whiteboard/asset/route.ts` (EDIT).**
- POST: accept `.png/.jpg/.jpeg` beside `.svg`; call `validateUpload`; everything after
  gate 4 (probe, quota, storage, manifest) is UNCHANGED — the traced fragment passes
  through the identical code path. The trace receipt rides the manifest row (one more
  optional JSON field on the existing row — additive, no migration).
- Document the gate order change in the route header comment (the gates stay seven;
  gate 2's sniff now has two branches; the trace step sits between sniff and sanitize
  and its OUTPUT is what sanitize sees).

**P0-4 `src/lib/tubeforge/whiteboard/asset-store.ts` (EDIT — minimal).**
- `WhiteboardUploadRow` gains optional `traced?: { strokes: number; commands: number;
  sourceBytes: number; sourceFormat: "png" | "jpeg"; ms: number }` (additive, optional —
  V1 rows parse unchanged). Storage key stays `.svg` — P0 stores the DERIVED fragment
  only; the original raster is intentionally not persisted (trace-only flow; the
  receipt is the provenance record). Re-upload regenerates deterministically.

**P0-5 `src/lib/tubeforge/whiteboard/trace-budget.ts` (NEW — small, pure).**
- `WB_TRACED_PATH_BUDGET = 96` commands/path (a skeleton polyline simplifies well below
  this), `WB_TRACED_TOTAL_BUDGET = 4096` commands/asset (raised from the SVG upload's
  2,048 — photo density; enforced post-simplification, over-budget → drop shortest
  strokes first and record it in the receipt, never silently).
- Per-scene pressure guard: `WB_TRACED_STROKES_PER_PLACEMENT = 120` — a placement of a
  traced asset draws at most its first 120 strokes per the fill law window; the rest
  reveal with the asset group at the stroke-completion boundary (the existing
  `reveal_color` group fade, `wb-page.ts:199-205` — no new event type).

**P0-6 `src/components/tubeforge/whiteboard/whiteboard-studio.tsx` (EDIT).**
- `accept=".svg,image/svg+xml,.png,image/png,.jpg,.jpeg,image/jpeg"`; the upload
  branch shows a "Tracing image → strokes…" progress state and renders the readable
  gate errors (the route's error JSON is already user-shaped).
- The asset palette labels traced uploads ("traced · N strokes") from the manifest row.

**P0-7 The AI illustration bridge (NEW route + small lib).**
- `src/app/api/videos/[id]/whiteboard/asset/generate/route.ts` (NEW): POST
  `{prompt, size?}` → the provider call (`imageGenerate`, `providers/image.ts`) →
  PNG bytes → `validateUploadedRaster` (same gates, same store, same manifest;
  `uploadedBy: "ai"`, prompt recorded on the row) → 201 with the asset. The bridge is
  deliberately THIN: no new provider code, no whiteboard-owned image model — the story
  lane's provider machinery is reused exactly.
- Prompt hygiene: the route composes the operator's prompt with a whiteboard style
  suffix (line-art, black ink on white, no shading gradients) — traced output quality
  is a prompt-shaped problem before it is an algorithm problem.
- The Islamic-content guard rides here AND on the upload route: `src/lib/tubeforge/
  whiteboard/policy.ts` (NEW, small) — reads the video's content policy (the
  `restricted-subjects.ts` policy id on the video row) and (a) injects the constraint
  clause into the generation prompt, (b) refuses generate calls for restricted subjects
  without an explicit policy acknowledgment, (c) records the policy id on the manifest
  row. Frame-level scan integration is P4 scope; the P0 guard is honest and additive:
  prompt constraint + refusal + provenance. This closes the I.8 gap for the new
  raster lane without touching the story lane.

**P0-8 `src/lib/tubeforge/whiteboard/benchmark-scenarios.ts` (EDIT — the P0 seed).**
- Add `w1-traced` to the benchmark set: a fixed PNG fixture (committed, tiny, line-art)
  traced at benchmark time through the SAME `traceRasterToStrokes`, placed in a
  process-diagram scene. Pins: trace determinism (two runs → byte-identical SVG
  fragment), post-trace validator pass, post-trace command budget, frame receipts show
  the traced strokes drawing progressively under the fill law, hand rides the traced
  geometry (no teleport — the W3 validator already proves this at upload).
- The five-subject suite (science/engineering/Islamic-history/business/general-ed) is
  seeded by NAMING the five scenario slots with placeholder topics now and filling them
  in the benchmark stage (the operator's order for the benchmark video), each carrying
  its policy id — the Islamic-history slot carries the I.8 constraint from day one.

**P0-9 Tests (EDIT/NEW — the pins).**
- `scripts/test-whiteboard-trace.mts` (NEW, the unit battery): determinism pins;
  stage pins (skeletonize reduces a thick line to 1 px; junctions split; DP-simplify
  preserves endpoints; ordering is reading-order stable); budget pins (over-budget
  drops shortest-first, receipt says so); validator pins (traced output passes
  `validateAsset`; crafted multi-subpath output would fail — proving the split law);
  magic-byte pins (PNG/JPEG/WebP-rejected/empty/truncated).
- `e2e/whiteboard.spec.ts` (EDIT): upload a PNG fixture through the UI → the palette
  shows the traced asset → place it → preview draws it progressively → the render
  receipt includes the traced asset. One spec, the golden path.

### What will NOT be built (P0)

No second renderer, no new frame clock, no `<image>`-element allowance in the runtime
(the sanitizer's blocked-element law is untouched — traced markup is `<path>` only),
no persistence of original rasters, no color masking (FrameState untouched), no
production profiles, no editor changes beyond the upload affordance. The vector lane,
the fill law, the camera director, and the whole render pipeline are byte-identical
when no traced asset is present.

### P0 exit criteria (acceptance)

1. A PNG upload traces, passes all seven gates, lands in the library, draws
   progressively in preview AND in the exported MP4 — same frames.
2. An AI-generated illustration (bridge route) traces and draws the same way.
3. Determinism pin: identical bytes → identical traced SVG fragment.
4. The full local battery (`typecheck`, `lint`, `test`, `build`) and CI 8/8 green;
   the W1 benchmark still renders byte-identically for non-traced scenarios
   (the no-regression pin).
5. The Islamic-history policy guard is active on both raster entry points.

### Order of work

P0-1 (pure core + pins) → P0-2/P0-3/P0-4 (gates + route + store) → P0-6 (UI) →
P0-7 (AI bridge + policy guard) → P0-8/P0-9 (benchmark seed + battery) → full gates →
CI push. Each step lands with its pins; no step moves a law it does not own.

---

## Part III — the remaining ladder, mapped (post-P0, for the record)

| Operator priority | State | Where it lands |
| --- | --- | --- |
| P0 raster-to-stroke | PLANNED above | Part II |
| P1 smart stroke ordering | PARTIAL (beats + validator + pen-group metadata exist; traced-order heuristics arrive with P0-1) | `beat-plan.ts` + `trace.ts` ordering refinement |
| P2 draw styles (pencil/marker/chalk/crayon) | PARTIAL (hand styles exist; per-stroke texture pass is `roughen.ts`/`sketch.ts` work) | style profiles over the existing derivation |
| P3 animation choreography | STRONG (hand/camera/pauses mostly exist; first-class pause event is the gap) | `storyboard.ts` event grammar addition (compiled, not persisted — the §5.1 law) |
| P4 narration-aware visual director | PARTIAL (beats + voice anchors exist; AI-illustration-for-beat is the gap) | llm-planner + the P0-7 bridge |
| P5 camera & refinement | PARTIAL (director + carried ink exist; production profiles + readability checks do not) | profile layer over per-project config |
| P6 editor/timeline improvements | open | tracks projection follows the compile-only law |

Each later stage lands on the frozen event grammar and the shared frame clock — the
reconciliation's §11 "will not be built" list remains the law for all of them.

---

**Decision points for the operator (before P0 implementation):**

1. **Trace-only storage** (recommended: derived SVG only, receipt as provenance — zero
   migration) vs persisting original rasters (schema + storage change).
2. **Traced budget posture** (recommended: 4,096 commands/asset, shortest-first drop
   recorded in the receipt) vs rejecting over-budget traces outright.
3. **AI bridge scope** (recommended: thin bridge over `imageGenerate` + policy clause)
   vs a whiteboard-owned prompt pipeline.
4. **Five-subject benchmark timing** (recommended: seed the slots in P0-8, fill them in
   the benchmark stage) vs full suite in P0.
