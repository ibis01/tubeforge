# S120 — The complete 2D animation system (file-by-file roadmap)

**Status:** PLANNED — the roadmap stage. No product code is changed by this document. Ground truth verified 2026-11-13 against HEAD `e387287` (W2, "the semantic beat compiler"): full reads of the reconciliation record, the S87 design, the W1 rubric, `beat-plan.ts`, `timing.ts`, `types.ts`, `render-lane.ts`, and the engine module inventory (755 tracked files). It reconciles the external capability audit (delivered 2026-11-13) against the live tree and supersedes the audit's framing where it drifted from the repo's own records.

**The question it answers:** "What exactly does it take to grow the whiteboard engine into a complete 2D animation studio — motion graphics, real character animation, cinematic depth — without a second renderer and without forking the composition truth?"

**Sequencing authority:** this roadmap executes under the recorded laws — the S75 order of operations ("shared contracts BEFORE engine expansion", ROADMAP.md), the reconciliation §9 stage plan (W1→W7), the S76 §4.C adoption decision, and the S64 determinism law. Nothing below may start before the shared systems it consumes are green.

---

## 0. Corrections to the external capability audit (read first — they change the plan)

The audit's facts were mostly right, but four framing errors would produce the wrong roadmap:

1. **The shared animation timeline already exists and is CLOSED.** S87 "Universal Timeline contract" (docs/design/s87-universal-timeline.md) is implemented through all five slices: schema stamping, v2 dual-write with the overwrite guard, compositor reads `tracks[]`, whiteboard emits engine-authored tracks (`whiteboard/tracks.ts`), 18/18 acceptance battery wired into CI. The audit's central recommendation ("build one shared animation timeline") is therefore already satisfied — the work is **adoption by the new engines + one recorded open tail** (persisted engine-authored tracks, "schema 3"), not a new build.
2. **Naming collision.** In this repo, `M1`/`M2` already mean **AI Director milestones** (production profiles + per-shot camera control — both LANDED), and `C1`–`C12` are **billing finding IDs**. The roadmap below uses **G1 (motion graphics)**, **K1 (2D character animation)** and **C2-ext (cinematic-2D extension)** and says so explicitly, to avoid colliding with in-repo vocabulary.
3. **"2D character rigging: not established" is half-true.** What exists: AI-generated identity-locked portraits + pose sheets (`characters.ts`), a cross-video identity VCE (`character-identity.ts`, S82/S83), and the S93 "character rig" — a camera breath-cycle over still portraits, honestly documented as NOT skeletal ("a still portrait cannot blink or lip-sync, and the rig will not fake it"). Real 2D character animation is genuinely missing; the pose sheet + i2v lane are the recorded paths to real motion.
4. **W1's 2.4/5 baseline is documented as NON-blind by design** (docs/audits/w1-blind-rubric.md §3: "operator proxy, AI-assisted, NON-blind for W1"). The rubric mandates blind kits with shuffled old/new artifacts from W2 onward. The gap is not "no independent score exists" — it is "the blind re-score that the protocol already prescribes has not been executed yet."

Also verified: `TimelineTrackKind` already reserves the future engines' seats at `src/lib/tubeforge/types.ts:580` — `"video" | "image" | "whiteboard" | "3d" | "character" | "audio" | "subtitle" | "graphics"`. The 3D engine (S94) and whiteboard both ride the shared compositor today. The "one shared architecture" the external audit drew is not a proposal in this repo — it is house law (ROADMAP.md: "shared contracts first, no parallel pipelines, quality infrastructure precedes engine expansion").

---

## 1. The non-negotiable laws every stage must keep

These are recorded in the repo (WHITEBOARD_ENGINE_DESIGN.md §1, s87 §0, whiteboard-videoscribe-reconciliation.md §11, ARCHITECTURE.md §1.9) and they bind every stage below:

| Law | Meaning for this roadmap |
| --- | --- |
| No second renderer | New engines render frames via the proven chromium-screenshot → ffmpeg-encode path; the compositor, QC battery, ship gates and storage seams are shared, unchanged |
| One source of motion truth | Each engine's frame plan is a pure function `frameAt(project, assets, tMs)` shared by editor preview AND final render (the `wb-page.ts` `APPLY_FRAME_FN` pattern) |
| Determinism | Frame N is a pure function of (project, library, N). No CSS animation, no clock, no randomness. Determinism pins = identical frame hashes |
| Compile-to-events / no parallel grammar | New planning layers compile INTO the frozen `AnimationEvent` grammar or project onto S87 `tracks[]`; the grammar itself does not grow |
| Timeline is a projection, never the truth | The video row is truth; tracks are derived/engine-authored projections with a consistency check |
| Native-first ($0 pixels) | Deterministic native rendering is the default; AI video generation (i2v) is the escalation lane, not the base |
| Every unbounded dimension has a named wall | Frame budgets (`WB_RENDER_FRAME_BUDGET = 25_920`), upload budgets, per-scene placement caps — each new engine declares its own walls |
| Leaf-module law | `whiteboard/*` imports only shared infra + siblings; new engines follow the same shape |
| AI suggests, human approves | Director/router output is advisory until an approval checkpoint flips state |
| Every task ships: objective, files, dependencies, acceptance criteria, tests, rollback | The per-stage specs below follow exactly this template |

---

## 2. How the external audit's target architecture maps to the repo

| Audit's diagram node | Repo reality today | Remaining work |
| --- | --- | --- |
| AI Director (chooses the style) | `director.ts` + `director-plan.ts` (19-field shot schema, 8 production profiles, M1/M2 landed) — but it directs ONE style family (cinematic Ken Burns/i2v/stock/slides) | Add per-scene engine/style selection (`engine` field) + router mapping (Stage R) |
| Shared Animation Timeline | S87 contract CLOSED: `timeline.ts` (8 track kinds), `composition-plan.ts`, `render-lane.ts`, whiteboard `tracks.ts` | Engines G1/K1 emit tracks (like `whiteboard/tracks.ts`); schema-3 persisted engine-authored tracks for cross-engine videos (Stage X) |
| Whiteboard W1–W7 | W1 (benchmark + rubric), W2 (beat compiler) landed; W3–W7 specced in reconciliation §9 | Execute W3–W7 (Stages W3–W7) |
| Motion Graphics | Nothing (closest: `slides.ts` — static designed PNGs + camera push; no element-level animation) | Build G1 (Stage G1) |
| Character Animation | S93 camera-breath rig + pose sheets + i2v lane; no skeletons/lip-sync | Build K1 (Stage K1) |
| Cinematic 2D | The deepest subsystem: `motion.ts` (11 moves, zoompan compilation), `shots.ts` (M2 per-shot engine), `transitions.ts` (15 xfades) | Vocabulary extension, not plumbing (Stage C2-ext) |
| Shared Renderer + QC + Export | `render.ts` (2,101 lines), `render-qc.ts`, `qc.ts` (13 checks), `render-assembly.ts` (S117 manifest), audiomix −16 LUFS contract | Ride it; add per-engine segment builders only where composition requires them |

---

## 3. Stage specs — whiteboard finishing track (W3–W7)

Each stage lands with unit pins, all gates green, CI-green push. Order is the repo's own (reconciliation §9). Nothing requires a Prisma migration until W6's manifest fields (JSON columns only).

### W3 — Stroke-authored assets + validator
**Objective:** enforce the single-subpath/no-teleport law that is today convention-only (a multi-subpath path renders a teleporting pen with no gate firing).
**Exit gate:** every validator check fires on a crafted-bad fixture; every library asset passes its own validator; upload lane rejects with readable errors.

New files:
- `src/lib/tubeforge/whiteboard/asset-validate.ts` — pure module. Checks, each returning `{ok, reason, pathId?}`:
  - `checkTeleport(path)` — multi-subpath (`M` mid-path) rejection (the assets.ts:95-100 S67 receipt is the rationale);
  - `checkSelfIntersection(path)` — segment-pair intersection on flattened polylines (`svg.ts#flattenPath` provides geometry; O(n·m) is fine at the `WB_PATH_COMMAND_BUDGET = 512` cap);
  - `checkCaps(path)` — stroke-width / linecap consistency within a pen group;
  - `checkClosedDirection(path)` — consistent winding for closed shapes (fill ordering);
  - `checkFillAfterOutline(asset)` — fill paths must follow their outline in draw order;
  - `checkOrientation(asset)` — up-vector sanity for arrow/label roles;
  - aggregate `validateAsset(asset): AssetValidationReport`.
- `docs/audits/w3-asset-validator.md` — the stage record.

Modified files:
- `src/lib/tubeforge/whiteboard/assets.ts` — `WhiteboardAsset` gains additive optional metadata: `penGroups?`, `drawOrder?`, `role?: "outline"|"fill"|"label"|"arrow"|"emphasis"`, `durWeight?`, `framing?`, `alts?`, `a11y?` (reconciliation §5.3); `extractAsset` emits richer rejection reasons; starter pack extended (education/business/science/process) with golden-frame renders per asset;
- `src/lib/tubeforge/whiteboard/asset-store.ts` + `upload.ts` — `loadLibrary` runs `validateAsset` warn-and-exclude; the S69 upload gate rejects with readable errors (7 existing gates + the new validator);
- `scripts/w1-whiteboard-benchmark.mts` — re-run against the new starter pack (baseline hashes stay frozen; new receipt file lands in `docs/baselines/`).

Pins (in the house suite, `scripts/test-unit.mts` conventions): each check fires on a crafted-bad fixture; all 18 built-ins pass; warn-and-exclude does not mutate the doc; upload rejection copy is stable.

Rollback: the validator is an additive gate — revert the `loadLibrary`/upload call sites; metadata fields are optional and ignored by old parsers (tolerant-read law).

### W4 — Word-aligned timing + handwritten text
**Objective:** the important visual lands ON the important phrase; text becomes handwritten glyph strokes with a readability guarantee.
**Exit gate:** anchor alignment tolerance pinned; fill law byte-identical when anchors absent; readability threshold passes per aspect.

New files:
- `src/lib/tubeforge/whiteboard/text-draw.ts` — (a) glyph-outline mode: one handwriting face converted to SVG path outlines (deterministic, decision §10.3 recommends the single-face route over a font picker) emitted as `draw_path` events; (b) marker label mode (existing wipe) as fallback; (c) `checkReadability(textPlacement, camera, outputSize)` — pure check at final output scale, per aspect.

Modified files:
- `src/lib/tubeforge/whiteboard/timing.ts` — `scheduleScene(scene, durationMs, geometry, anchors?)`: `anchors: WordAnchors` = `{ byWord: { index, startMs, endMs }[] }` passed as INPUT (never a doc field — reconciliation §5.4). Beat windows derive from anchor spans; emphasis beats fire after the spoken claim; final-idea hold preserved. Absent anchors → today's fill law **byte-for-byte** (this is a hard pin, not a hope);
- the whiteboard render job (whiteboard lane caller) — passes captions-lane anchors: `detectSpeechRuns` (silencedetect −35 dB / 0.30 s) + the ASR chunk-token alignment already in `captions.ts` (`chunkEndPositionsByTranscript`, `wordPosToTime`, `snapToPause`) produce per-word anchors per scene WAV; scenes without VO keep the estimator;
- `src/lib/tubeforge/whiteboard/beat-plan.ts` — `beatSceneEvents` consumes anchor-derived windows when provided (W2's word-proportional windows become the no-anchor fallback);
- `wb-page.ts` — text reveal switches to glyph strokes when the asset carries outlines (the W1-caught reveal-rect bug class is covered by pins that LOOK at pixels).

Pins: `|beatWindow − speechRun| ≤ tolerance` on fixture WAVs; determinism both modes; fallback byte-identity (serialize-hash the schedule with and without anchors present); readability check rejects scale-0.4 placements that fail the threshold; glyph geometry rides the hand exactly (the reconciliation §8.5 pen-drift defect closes).

Rollback: stop passing anchors → engine renders exactly as HEAD. Text mode is per-asset metadata → revert asset set.

### W5 — Content-driven camera director (highest-risk stage)
**Objective:** camera motion becomes content-driven; the permanent Lissajous drift demotes to a fallback WITHOUT regressing the QC frozen-frame lenses.
**Exit gate:** QC green on the W1 benchmark with drift fully demoted; policy violations reject in validation.

New files:
- `src/lib/tubeforge/whiteboard/camera-director.ts` — pure: focus rects from beat placement/text bounds (geometry via `buildGeometry` + `svg.ts` bounds) → `CameraEvent[]` implementing: lead-in framing before a beat, eased travel between focus rects, stable writing window during draws (director camera must NOT move the world under the pen tip while a stroke is in progress — policy check), post-beat hold, safe margins per aspect. Policy set exported as pure checks (`cameraPolicies`): min travel duration, max zoom speed, focus-rect containment, text-readability margin.

Modified files:
- `src/lib/tubeforge/whiteboard/timing.ts` — `cameraDrift` becomes the **no-camera-keys fallback only** (the drift tension, reconciliation §8.1: drift is load-bearing for `qc.ts` freezedetect/static-shot lenses, so director + demotion MUST land in the same stage — shipping the director alone changes nothing; demoting drift alone fails QC);
- `storyboard.ts` — camera validation consumes the new policy checks (invalid `CameraEvent[]` → validation error, not silent clamp).

Pins: policy violations reject; determinism; QC green on the full W1 benchmark (3 aspects) with drift disabled; per-aspect framing receipts (label bounds inside safe margins); writing-window stability check.

Rollback: the drift fallback is one boolean branch — reverting the demotion restores HEAD behavior exactly.

### W6 — Continuous canvas
**Objective:** scenes can carry the board (keep/fade/erase/pan-away) instead of four hard board-wipes per video (the continuity score is 1/5 in the baseline).
**Exit gate:** carried-state equality pinned; exit events deterministic; scene-card mode byte-identical to today.

Modified files:
- `src/lib/tubeforge/whiteboard/storyboard.ts` — additive `board` policy on `WhiteboardScene`: `{ mode: "clean"|"continuous"; carryPlacements?: string[]; exit?: "keep"|"fade"|"erase"|"pan-away"; transitionMs?: number }` (additive-parse law: v1 docs with no `board` = clean, unchanged);
- `src/lib/tubeforge/whiteboard/timing.ts` — `FrameState` gains a carried-ink layer: incoming state resolved from the previous scene's placements (data, NOT page residue — per-scene chromium recycling stays untouched, the S75 OOM receipt is the reason);
- `src/lib/tubeforge/whiteboard/wb-page.ts` — `composeScene` accepts carried placements (pre-rendered as resolved paths in the frame plan, same applier);
- `src/lib/tubeforge/whiteboard/render.ts` — per-scene carry resolution before composition; the S117 render manifest records board state per scene (`render-assembly.ts` manifest schema +1 field, additive);
- `src/lib/tubeforge/whiteboard/tracks.ts` — carried scenes still project as one clip per scene (no grammar change — the contract tension resolves the same way W2 did).

Pins: carried-state equality (frame 0 of scene K+1 contains exactly scene K's carried ink, hash-pinned); fade/erase/pan-away deterministic; `board.mode:"clean"` scenes byte-identical to HEAD; frame budget accounting unchanged.

Rollback: delete the `board` fields from the doc → parse falls back to clean mode (tolerant-read).

### W7 — Finishing layer
**Objective:** hand poses, pen-up travel, occlusion rules, left/right variants, and optional whiteboard SFX.
**Exit gate:** no-teleport travel pinned; mix inside the loudness contract; editor round-trips new fields.

Modified files:
- `src/lib/tubeforge/whiteboard/timing.ts` — `handAt` extension: pose variants (`write|draw|point|circle|rest` — pose selected by role metadata from W3), pen-up travel between strokes (the hand follows the path between stroke end and next stroke start instead of vanish-reappear; travel is bounded and eased), smoothing, occlusion/scale rules, left/right hand variants (asset-level `hand.style` extension);
- `src/lib/tubeforge/whiteboard/assets.ts` — hand asset variants (`hand-marker-l`, `hand-pencil`, poses as sub-assets with named tip points extending `HAND_TIP`);
- `src/lib/tubeforge/sfx.ts` — whiteboard kinds added to the recipe table (`pen-stroke`, `pen-stop`, `page-turn`, `pop` — synthesized like the existing 4 kinds, 48 kHz PCM16), **OFF by default** (decision §10.4); events mixed under the existing bed/VO chain (`normalizeVoSlot`, −16 LUFS window enforced by the unchanged audiomix contract);
- `whiteboard-studio.tsx` — controls for beat order/timing (advisory beats surface), camera focus, board policy, hand style, SFX toggle; editor round-trip pins.

Pins: travel paths contain no inter-stroke jumps > geometry bounds; sound mix passes loudness; editor round-trip of every new field; determinism (SFX never affect frames).

Rollback: SFX default-off and event-driven; hand variants are per-asset; reverting `handAt` is a single function.

---

## 4. Stage spec — the blind re-score (the audit's "independent quality scores")

**Objective:** execute the protocol the W1 rubric already prescribes. This is not a new design task — it is scheduled work with a hard artifact trail.

- **When:** a blind kit per stage that claims a perceptual win: after W4 (narration-alignment), after W5 (camera-readability), after W6 (continuity), after W7 (hand-realism, audio). W3 is enforcement and moves no perceptual row by itself.
- **How (w1-blind-rubric.md §1 protocol, verbatim):** same 9 dimensions, same anchors; NEW codenamed MP4 kit (`WB-XXXXXXXX.mp4` + `P1..P5` frames); old and new artifacts shuffled together; code→aspect key stays out of the repo (`validation/` is gitignored); whole numbers 1–5; per-dimension delta recorded in the stage's audit doc.
- **Scorers:** ≥3 humans for the first full re-score (the rubric's "Blind review ≥ 4/5" release gate is meaningless with one scorer); composite target ≥ 4/5; artifacts are hash-frozen so the re-score is repeatable at any time.
- **Deliverable:** `docs/audits/wN-blind-rescore.md` per stage + updated composite in the W1 doc's baseline table (baseline stays untouched — it is the honest "before").

If the ≥4/5 gate fails, the failing dimensions route back into the W-track before G1 starts (quality infrastructure precedes engine expansion — ROADMAP.md law).

---

## 5. Stage spec — G1: the motion-graphics engine

**Objective:** animated typography, icons, charts, counters, callouts and transitions as a deterministic native engine — the biggest genuine gap (today `slides.ts` animates nothing; it renders static designed PNGs and pushes the camera).
**Pattern:** the whiteboard engine's proven shape, applied to a new grammar — NOT a competing renderer. G1 renders through chromium frame screenshots → ffmpeg, emits S87 tracks of the reserved kind `"graphics"`, rides the shared QC battery.

**Decision recorded up front (two-phase composition strategy):**
- **Phase 1 — peer lane** (exactly the whiteboard's integration): G1 renders whole graphics-led videos; `render-lane.ts` routes by mode; `render.ts` is untouched. This is the lowest-risk landing and matches the newest proven precedent.
- **Phase 2 — compositor citizenship** (cross-engine videos): a `graphics`-kind segment builder in `render.ts` + schema-3 persisted tracks (Stage X). Phase 2 is gated on Phase 1 shipping and on Stage X's design.

New files (`src/lib/tubeforge/graphics/`, leaf-module law):
- `graphics/types.ts` — the GraphicsDoc grammar (versioned like `Scene3D`): `GraphicsScene { id, narration, durationMs?, background, elements: GraphicsElement[] }`; `GraphicsElement` variants: `headline`, `subhead`, `bullet`, `counter` (number tween + unit), `bar`/`barChart` (data-driven, not static HTML), `icon` (inline sanitized SVG paths — reuse `svg.ts#sanitizeSvg`/`parsePathData`), `callout`, `shape` (rect/line/circle), `group` (for enter/exit choreography); each element: `{ id, at: Placement, enter: ElementMotion, exit?: ElementMotion, emphasis?: ElementMotion }`; `ElementMotion = { kind: "fade"|"rise"|"slide"|"pop"|"wipe"|"count"|"grow"|"draw", durationMs, delayMs, ease }`; named walls mirroring `WB_BUDGETS` (`elementsPerScene`, `scenesPerProject`, `sceneDurationMsMax`, `GRAPHICS_FRAME_BUDGET`); `validateGraphicsDoc` (tolerant parse, strict write);
- `graphics/anim.ts` — the shared animation substrate (see Stage S below): easing table, keyframe evaluation, clock quantization;
- `graphics/frame.ts` — **the one source of motion truth**: `frameAt(doc, geometry, tMs): GraphicsFrameState` (element transforms/opacities/text states/counters), pure and deterministic; enter/exit/emphasis compose with a fixed precedence (emphasis > exit > enter); bar/count tweens are data-driven pure math;
- `graphics/compose.ts` — HTML/SVG composer (the `composeScene` pattern): static skeleton + one `APPLY_FRAME_FN` applier shared by editor preview and renderer; no CSS animation — every frame applied by JS, deterministic;
- `graphics/render.ts` — the chromium loop (mirror `whiteboard/render.ts`: fresh context per scene, no-network route abort, JPEG quality 92, ffmpeg encode, VO slot normalization `normalizeVoSlot`, music bed under the mix contract); pre-flight frame budget; returns `{ scenes, file, tracks, plan }` with the `plan.totalSec == Σ deliveredSec` assertion;
- `graphics/tracks.ts` — S87 projection: `graphicsTracks(doc, fps, { voSceneIds, musicOn })` → visual track kind `"graphics"` (one clip per scene, `asset: null`), audio + subtitle tracks; the `framePlanClock` pattern re-used so edges are frame-quantized and contiguous by construction;
- `graphics/planner.ts` + `graphics/llm-planner.ts` — native keyword/rule scaffold + LLM spec with per-element degradation to native (the `llm-planner.ts` shape: same schema, planner report, fallback byte-compatible);
- API routes: `src/app/api/videos/[id]/graphics/route.ts` (GET/PUT doc, advisory rev + 409-with-current), `.../graphics/scaffold/route.ts`, `.../graphics/render/route.ts`;
- Studio surface: `graphics-studio.tsx` (mirror `whiteboard-studio.tsx` — element editor over the four motion kinds, per-element timing strips);
- `scripts/g1-graphics-benchmark.mts` + `docs/audits/g1-blind-rubric.md` — the W1 pattern: five fixed scene types (kinetic headline, stat reveal, process chain, chart story, call-to-action), 3 aspects, determinism pin (identical frame hashes), blind kit;
- `docs/design/g1-motion-graphics.md` — the design record.

Modified files:
- `src/lib/tubeforge/types.ts` — `RENDER_MODES` gains `graphics` (types.ts:107; the lockstep law in `render-lane.ts#laneDecisionsComplete` must move in the SAME slice — the S88 CI lesson: both ledgers in one slice);
- `src/lib/tubeforge/render-lane.ts` — `StoryRenderMode` + `RenderLane` + `resolveRenderLane` gain the graphics lane (peer-lane law);
- `prisma/schema.prisma` — `Video.graphicsProject Json?` (the eleventh JSON doc column; additive migration, SQLite + PG);
- queue wiring — a `graphics` job kind following the whiteboard job shape (crash-resumable, deterministic re-render on resume);
- `render-assembly.ts` — manifest accepts graphics entries (additive).

Pins: determinism; frame-budget wall; tracks projection parity (plan.totalSec assertion); QC battery green (the graphics lane's finals ride the unchanged 13-check battery); element state never NaN outside its motion window; mixed doc round-trips; LLM degrade-to-native byte-compatibility; e2e spec `e2e/graphics.spec.ts` following `whiteboard.spec.ts`.

Rollback: mode id removal reverts to lane refusal; the JSON column is nullable and ignored.

**Explicit non-goals (G1):** no video-generation model, no second timeline grammar, no Lottie/After-Effects import in v1 (an adapter can compile INTO the grammar later), no custom shader transitions (the transitions catalog stays ffmpeg-xfade).

---

## 6. Stage spec — K1: 2D character animation (real rigs, honest motion)

**Objective:** characters that actually move — poses, gestures, mouth shapes on narration, simple walk/turn cycles — deterministically and natively, consistent with the S93 honesty law ("the rig will not fake it" — K1 replaces stills with real art, so it CAN honestly animate them).

**Two-lane strategy:**
- **K1-native (primary, $0 pixels):** a 2D puppet rig — identity-locked character art decomposed into layered parts (head, torso, upper/lower arms, hands, brows, mouth set), posed per frame by a pure function. This is the native-first law applied to characters.
- **K1-i2v (escalation, premium):** the existing i2v lane with rig-aware prompts (pose sheet + motion intent), consistency re-checked by the S83 cross-video VCE. This lane already exists; K1 only improves the prompt contract and QC.

New files:
- `src/lib/tubeforge/characters/rig2d.ts` — the `CharacterRigDoc` contract (versioned): `RigPart { id, svgRef, z, pivot: {x,y}, parent?: partId, rest: Placement }`; `RigPose { id, name, joints: Record<partId, {rotateDeg, x?, y?, scale?}> }`; standard slot names so pose sheets map: `mouth` set (`closed|open|wide|oh|smile` — 5 shapes is enough for honest narration-sync at explainer quality), `brow`, `arm-l/arm-r` 3-way (rest/raise/point); `validateRigDoc` (referential integrity to the character's parts, pivot sanity);
- `src/lib/tubeforge/characters/rig-frame.ts` — `poseAt(rig, timeline, tMs): RigFrameState` — pure pose evaluation: keyframed joint states over the scene clock using the shared `anim.ts` easings; speaking = mouth-shape schedule derived from **W4 word anchors** (syllable-counted open/close beats inside each word span — the honest, deterministic alternative to phoneme lip-sync; scope-claimed as "beat-sync", not phoneme lip-sync, in all docs/UI);
- `src/lib/tubeforge/characters/rig-render.ts` — chromium frame loop composing rig layers into scene SVG (reuse `svg.ts` sanitize/parse; the rig renders INTO the same frame pipeline as graphics, sharing `APPLY_FRAME_FN` discipline and the frame budget);
- `src/lib/tubeforge/characters/rig-director.ts` — pure planner: narration + pose sheet → pose timeline (gesture beats from W2-style purpose classification: setup = welcoming pose, action = gesture on the action verb, emphasis = point/circle on the claim — reusing `beat-plan.ts#classifySentence` instead of duplicating it, one classifier, two consumers);
- API: `src/app/api/characters/[id]/rig/route.ts` (GET/PUT rig doc), `.../rig/auto` (planner pass), plus per-video render hook;
- `prisma/schema.prisma` — `Character.rigDoc Json?`, `Character.parts Json?` (additive);
- Studio: extend the existing character surfaces (portrait/poses flow already exists) with the rig editor + pose-timeline strip;
- `scripts/k1-rig-smoke.mts` + `docs/audits/k1-blind-rubric.md` — the S93 smoke pattern (4 unit pins + real-render smoke) extended: walk cycle renders, mouth beats land on anchors, identity VCE ≥80 on rig frames.

Modified files:
- `src/lib/tubeforge/characters.ts` — part decomposition prompt for the portrait flow (generate layered parts, not one flat PNG); pose-sheet generation targets rig slots;
- `src/lib/tubeforge/composition-plan.ts` — `PlanVisualKind` gains `"character"` (types.ts:580 track kind already reserved) for cast scenes in mixed videos (Phase 2, with Stage X);
- `src/lib/tubeforge/character-rig.ts` — S93 breath rig stays for still-portrait scenes; seniority ladder extended: explicit rig timeline > S93 breath > auto (the ladder pattern is preserved);
- `liveliness.ts` — channel precedence gains the native-rig channel for cast scenes (between `kenburns` and `i2v` — native-first).

Pins: pose interpolation determinism; mouth beats inside word spans (tolerance pin from W4); rig part transforms never NaN; identity floor ≥80 via VCE on rendered frames; frame budget; tracks projection (`characterTracks`, the `tracks.ts` pattern).

Rollback: `rigDoc` absent → S93 still-portrait path byte-identical (additive parse).

**Explicit non-goals (K1):** no skeletal mesh deformation/skinning, no phoneme-exact lip-sync claim, no IK solvers in v1 (FK rotations cover explainer poses), no real-time playback engine (deterministic frame rendering only).

---

## 7. Stage spec — C2-ext: cinematic-2D extension (extension, not plumbing)

**Objective:** richer cinematic vocabulary in the existing, deepest subsystem. No new files except tests/docs unless noted.

Modified files:
- `src/lib/tubeforge/motion.ts` — `MoveKind` additions: `"shake"` (bounded jitter around the focal, amp tied to SFX `boom`/`sting` — visual-audio pairing like the `punch` pattern), `"push-follow"` (zoom + simultaneous focal travel — today zoom and pan are exclusive per shot), `"drift-crawl"` (slow constant-direction creep for ambient scenes); extend the easing expression builder beyond `smooth|linear|pop` with one new curve (`"ease-back"` — small overshoot on settle, one closed-form zoompan expression, keeping the compile-time-ffmpeg architecture);
- `src/lib/tubeforge/shots.ts` — pseudo-crop additions (2 more windows for verticals), `CAMERA_TO_MOVE` mapping for the new verbs (v2 engine-verbatim row + legacy approximation row, the existing table pattern);
- `src/lib/tubeforge/director-plan.ts` — `CAMERA_MOVES` vocabulary + the three new verbs (engine-verbatim, plus the LLM prompt list); `MOVE_SPEED_FACTOR` unchanged;
- `src/lib/tubeforge/transitions.ts` — **catalog stays ffmpeg-xfade-native** (the 15 ids); custom shader wipes are explicitly out (a custom builder would fork the blend pipeline and its QC math);
- `src/lib/tubeforge/character-rig.ts` — the recorded S93 tails: rig modulation on planned shots, pose-driven beats (consumes K1 pose timelines when present), per-video toggle already landed.

Pins: every new move's zoompan expression is deterministic and edge-pinned (the 8% safety-pad law); QC flicker/stutter lenses pass on shake shots (shake amplitude bounded under the `FLICKER_SAMPLE` thresholds — this is the real risk of `shake`, pin it first); `expectedCutsForTimeline` accounts for new shot joins; the W1-style benchmark for cinematic moves is the existing E-series battery (no new harness).

Rollback: each verb is a table row + one branch in `shotZoompan`; delete rows to revert.

---

## 8. Stage S — the shared animation substrate (`anim/`)

**Objective:** the ONE shared piece the external audit's diagram implies that does not exist yet: a tiny, pure, engine-neutral motion substrate used by G1 and K1 so they do not duplicate easing/keyframe/clock math between themselves. (The whiteboard's `timing.ts` is deliberately NOT migrated onto it — determinism pins make byte-identity the priority; the substrate is for new engines only. The composition truth remains S87 tracks; the substrate is intra-clip motion truth.)

New files:
- `src/lib/tubeforge/anim/easing.ts` — named curves (`linear`, `ease-in-out`, `ease-out`, `pop`, `ease-back`) as pure functions + the zoompan-expression compiler used by G1/K1 frame math (whiteboard W5 may adopt the camera curves later as an OPTION — not in scope);
- `src/lib/tubeforge/anim/keyframe.ts` — ordered keyframe lists, clamped evaluation, tween composition (`Keyframe<T>`, `evalAt(keys, tMs)`), the generic shape `frameAt` implementations for graphics/character consume;
- `src/lib/tubeforge/anim/clock.ts` — frame quantization + the shared frame-budget wall constant (one wall, two engines) + `framePlanClock` semantics extracted as a generic helper (whiteboard keeps its own copy until its soak gate clears).

Pins: easing curves pure and table-complete; quantization matches `framePlanClock` byte-behavior; no fs, no clock, no randomness (the S64 law generalizes).

---

## 9. Stage R — AI Director style router + Stage X — cross-engine composition

### R — per-scene style selection (the external audit's "AI Director chooses the animation style")
Modified files:
- `src/lib/tubeforge/director-plan.ts` — `DirectorScene` gains advisory `engine?: "auto"|"kenburns"|"slides"|"whiteboard"|"graphics"|"character"` (tolerant parse; v2 plans read fine);
- `src/lib/tubeforge/director.ts` — the director pass proposes per-scene engines from script/mood/profile (LLM), under "AI suggests, human approves": the proposal lands in `directorState: proposed` exactly like shots do today;
- `src/lib/tubeforge/composition-plan.ts` — the plan→kind mapping consumes the approved engine per scene (kind = the S87 track kind; this is where mixed videos become real);
- `src/app/api/videos/[id]/director/route.ts` — approval checkpoint unchanged.

Constraints: the lane lockstep law still holds per whole-video mode; mixed-engine videos require Stage X. Until X, the router's approved output is honored only when all scenes map to ONE lane; otherwise assemble surfaces the conflict (honest UI, no silent mode-flip).

### X — schema-3 persisted engine-authored tracks (the recorded S87 open tail)
**Objective:** mixed-engine videos (whiteboard + graphics + character + footage in one timeline) with one composition truth.
- `src/lib/tubeforge/timeline.ts` — schema 3: engine-authored tracks persisted at assemble time with the re-derive/compare consistency check the S87 §11 refinement already specifies (never blindly stored — verified or refused);
- `src/lib/tubeforge/composition-plan.ts` — multi-kind plans validated per-scene (all-or-nothing law extends: every kind must have a segment builder);
- `src/lib/tubeforge/render.ts` — segment builders for `graphics` and `character` kinds (the per-scene dispatch the extension-points audit identified: new `PlanVisualKind` → lane resolver → segment builder → tracks emission); whiteboard-in-composition reuses the phase-2 builder once G1 proves the pattern;
- acceptance battery extension (the §4.C pattern, 18/18 → mixed-kind rows).

**Sequencing law:** X is LAST. It is gated on G1 and K1 shipping as peer lanes first (the whiteboard precedent: engine-level peer, contract-level unified, then compositor citizenship — slices 3→4→5 replayed for the new engines).

---

## 10. Dependency graph, sequencing and sizing

```
W3 ──► W4 ──► W5 ──► W6 ──► W7
 │      │      │      │      │
 │      │      │      │      └─► blind re-scores (per stage) ──► ≥4/5 gate
 │      │      │      └────────► (manifest fields feed S117)
 │      └──────┼──► K1 mouth beats (word anchors are a K1 input)
 └─► W3 role metadata feeds W7 hand poses
S (anim substrate) ──► G1 ──► (K1 renders share G1's frame discipline)
G1 ──► R (style router needs the style menu) ──► X (mixed composition)
C2-ext — independent of G1/K1; any time after the W-track; before X ideally (vocab freezes before batteries extend)
```

Recommended sprint order (repo-sequenced, each sprint = CI-green push + audit doc):

| # | Stage | Depends on | Size (focused dev) | Principal risk |
| --- | --- | --- | --- | --- |
| 1 | W3 validator | — | S (3–5 d) | validator over-rejects uploads (mitigate: warn-and-exclude in library, reject only at upload) |
| 2 | W4 anchors + text | W3 (metadata), captions lane (exists) | M (1–2 wks) | ASR mishears degrade anchors (mitigate: silence-run fallback + tolerance pins) |
| 3 | W5 camera director | W4 (beat bounds) | M (1–2 wks) | **the drift tension** — ship director + demotion + QC proof as ONE slice |
| 4 | W6 continuous canvas | W5 (camera interacts with carried ink) | M–L (2 wks) | frame-plan growth (carried ink) vs frame budget; OOM discipline |
| 5 | W7 finishing | W3 (roles), W6 (exit events) | M (1–2 wks) | SFX taste — default OFF |
| 6 | Blind re-score (consolidated kit per protocol) | W7 | S (scheduling-bound) | scorer availability; N=1 scorer invalidates the gate |
| 7 | S anim substrate | — (parallel with W-track) | S (2–3 d) | scope creep into whiteboard (forbidden — new engines only) |
| 8 | G1 motion graphics | S; W-track gate ≥4/5 | L (3–4 wks) | scope (grammar breadth); frame budget; NEW perceptual baseline needed |
| 9 | C2-ext cinematic vocab | — (parallel; before X) | S–M (1 wk) | shake vs flicker lenses (pin amplitude first) |
| 10 | K1 character rig | W4 (anchors), S, G1 (frame discipline) | L (3–4 wks) | part-decomposition art quality; identity floor; honesty-law scope claims |
| 11 | R style router | G1 (+K1 for the character option) | S–M (1 wk) | router conflicts with lane lockstep (honest conflict UI until X) |
| 12 | X schema-3 mixed composition | G1, K1, R | L (3–4 wks) | the largest render.ts surgery since S87 — replay the slice ladder |

Total: roughly 10–14 focused weeks for one senior developer after the W-track (the repo's own sizing style), with the blind re-score running as a human-parallel track.

---

## 11. Risk register (new risks only — the repo's RISK_REGISTER.md is maintained separately)

| Risk | Stage | Mitigation |
| --- | --- | --- |
| Drift demotion regresses QC frozen-frame lenses | W5 | drift demotion + director + QC proof land as one atomic slice; drift stays the fallback forever |
| ASR mishears corrupt word anchors | W4 | anchors come from silence-runs + ASR with tolerance; estimator fallback is byte-identical; anchors are inputs, never stored |
| Carried-ink breaks the frame budget / OOM receipts | W6 | carried ink is DATA in the frame plan; per-scene chromium recycling untouched; budget accounting pins |
| Validator rejects legitimate hand-authored SVG | W3 | three-tier: library = warn-and-exclude; uploads = reject with reasons; built-ins must pass (golden frames) |
| G1 grammar sprawl | G1 | v1 element set is closed (8 variants); named walls; new elements require a design-doc slice |
| Character art decomposition produces unusable parts | K1 | parts are generated + human-editable; rig validation requires referential integrity; fallback = still portrait + S93 |
| Mixed composition regresses the 18/18 battery | X | schema-3 is additive; v2 path keeps working; parity pins before any retirement (the slice-4 soak pattern) |
| Naming confusion (M1/M2/C1) in docs and commits | all | this roadmap's vocabulary (W3–W7, G1, K1, C2-ext, S, R, X) is used verbatim in stage docs and commit subjects |

---

## 12. What will NOT be built (confirmed against the live tree — the reconciliation §11 law, extended)

- No Remotion, no video-generation model as the base path, no second rendering pipeline, no parallel timeline grammar, no new QC battery, no new queue.
- No rewrite of `timing.ts` onto the new substrate (byte-identity beats elegance where determinism is pinned).
- No custom shader transitions; the transitions catalog stays ffmpeg-xfade.
- No phoneme lip-sync claims, no IK, no mesh skinning in K1 v1.
- No Lottie import in G1 v1 (an adapter compiling INTO the grammar may be designed later).
- The per-scene chromium recycling and every named wall are untouched by every stage.

---

## 13. Acceptance summary — how each stage proves done

| Stage | Done means |
| --- | --- |
| W3 | validator pins green; all built-ins pass; upload gate rejects bad SVG with readable errors; W1 benchmark re-run receipt |
| W4 | anchors-within-tolerance pins; byte-identical fallback; glyph text renders at all 3 aspects with pen riding glyphs; readability check enforced |
| W5 | QC green on W1 benchmark with drift demoted; camera policy pins; per-aspect framing receipts |
| W6 | carried-state equality pins; exits deterministic; clean mode byte-identical; manifest records board state |
| W7 | no-teleport travel pins; SFX mix in loudness window (off by default); editor round-trip |
| Re-score | ≥3 human scorers; shuffled kits; per-dimension deltas recorded; composite ≥ 4/5 or the failing dimensions route back |
| G1 | determinism + budget + tracks-parity pins; QC battery green; benchmark + rubric landed; mode lockstep law updated in the same slice |
| K1 | rig determinism pins; mouth-beat tolerance pins; VCE identity ≥80 on rig frames; fallback byte-identical |
| C2-ext | new verbs pinned (edge-safe, flicker-safe); director vocabulary updated; expected-cuts accounting extended |
| R/X | router proposes, human approves, conflicts surface honestly; X replays the S87 slice ladder with parity pins before any retirement |

---

## Appendix A — verified file inventory (evidence for the seams cited above)

- Whiteboard engine: `src/lib/tubeforge/whiteboard/{storyboard,svg,assets,timing,beat-plan,llm-planner,whiteboard-planner,tracks,wb-page,render,upload,asset-store,benchmark-scenarios}.ts`
- Shared contract: `src/lib/tubeforge/{timeline,composition-plan,render-lane,render-assembly,types}.ts` (types.ts:580 reserves `3d|character|graphics` track kinds)
- Compositor/QC: `src/lib/tubeforge/{render,motion,transitions,shots,slides,render-qc,qc,scene-qc,visual-qc,visual-consistency}.ts`
- Audio: `src/lib/tubeforge/{captions,pacing,sfx,audiomix,studio-sound}.ts`
- Characters: `src/lib/tubeforge/{characters,character-identity,character-rig,character-jobs}.ts`
- Director: `src/lib/tubeforge/{director,director-plan,liveliness,pacing}.ts`
- Design records: `docs/design/{whiteboard-videoscribe-reconciliation,s87-universal-timeline,s92-narration-pacing,s93-character-rig,s94-3d-engine}.md`, `docs/audits/w1-blind-rubric.md`, `WHITEBOARD_ENGINE_DESIGN.md`, `ROADMAP.md` (2.0 tracks), `ARCHITECTURE.md` §1.9
- Harness precedent: `scripts/w1-whiteboard-benchmark.mts`, `docs/baselines/w1-whiteboard-baseline-2026-11-13.json`

*Prepared from a read-only audit of HEAD `e387287` (2026-11-13). No product code is changed by this stage.*
