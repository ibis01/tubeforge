# TubeForge — W5/G1 commit sequences + W3/W4 API signature drafts

**Status:** companion to `docs/design/s120-2d-animation-roadmap.md` (the file-by-file roadmap). This document adds the two artifacts the roadmap deferred: (A) the **commit-by-commit sequence for W5** (the camera director — the highest-risk stage), (B) the **commit-by-commit sequence for G1** (the motion-graphics engine — the largest build), and (C/D) the **actual TypeScript signature drafts** for the two APIs other stages depend on: `asset-validate.ts` (W3) and the `scheduleScene` word-anchor input (W4).

**Ground truth:** verified against `ibis01/tubeforge` at origin HEAD `e387287` ("feat(whiteboard): W2 the semantic beat compiler"). The S120 roadmap exists as local commit `915dbee` in the audit clone (unpushed). Nothing in this document modifies repository code — every signature below is a draft for the implementer, written against the real types read from the tree (`storyboard.ts`, `timing.ts`, `beat-plan.ts`, `svg.ts`, `assets.ts`, `captions.ts`).

**Update 2026-11-14:** re-verified against a fresh full clone at origin HEAD `37796ce` — the W-track (W3–W7) and Stage S have **LANDED**. Status of the parts below: Part A EXECUTED by the repo, Part B still valid (G1.0/Stage S already green — G1.1 is the first remaining code commit), Part C EXECUTED, Part D SUPERSEDED by the leaner shipped anchors contract, Part E still valid and pending, Part F still valid and pending (its Stage-S aliases now resolve against the real `anim/` exports). The full reconciliation — the claims table, three post-landing findings, and the G1 gate reading — is **Part G** at the end of this document. CI at `37796ce` is independently verified 8/8 green (Part G.1, token-authenticated API lookup).

**House laws every commit below keeps:** every commit is green (tsc + eslint + unit suite + CI) — no commit exists that only becomes valid after a later one; determinism (S64 law: pure functions, no clock/fs/randomness); additive/tolerant-parse (v1 docs keep rendering); one source per truth (the render seam and the editor preview schedule through the same entry point); naming vocabulary verbatim (W3–W7, G1, K1, C2-ext, S, R, X — never M1/M2/C-N, which are taken by the Director milestones and billing issues).

---

## Part A — W5: content-driven camera director (commit-by-commit)

**Why this stage is the risk slice.** `cameraDrift` (timing.ts:186) is load-bearing: the QC battery's freezedetect/static-shot lenses are calibrated on cinematic full-frame motion, and whiteboard ink growth is spatially tiny — the drift is the ONLY thing keeping ink-only frames (inter-stroke gaps, post-scene holds) from failing frozen-frames. The S120 spec therefore pins: **director + drift demotion + QC proof land as ONE atomic slice** (risk register row 1), and drift stays the fallback forever.

**Design decision D1 — what keeps keyed scenes' frames alive after demotion.** Demoting drift cannot mean "no motion in keyed scenes": the director's own stable windows (writing windows, post-beat holds, end-of-scene holds) are exactly the stretches where ink growth is zero or near-zero — the S64 receipts' static tails. The director MUST NOT hold absolute zero motion during holds. Resolution (recommended, one-function change): `cameraAt` keeps an additive **residual sway** term — the same `cameraDrift` function at a reduced amplitude factor for keyed scenes, full amplitude for keyless scenes. The amplitude is not chosen by theory; it is pinned by receipts: `SWAY_FACTOR` must keep the frozen-frames lens green on the W1 benchmark AND keep sway ≤ ¼ of the readability safe-margin (so it never un-frames a label). Alternative (rejected): dense director-authored micro-keys — bloats the keyframe stream, duplicates the drift's arithmetic (two implementations of the same motion), grows the persisted grammar for no benefit.

**Seniority chain (the W2 precedence pattern, applied to camera):** author-authored `scene.camera` keys > director-plan keys > keyless drift fallback. The director never runs when the author wrote keys.

### Commit W5.1 — `feat(whiteboard): W5.1 focus targets — beat bounds resolve to camera focus rects (pure, unconsumed)`

- **New:** `src/lib/tubeforge/whiteboard/camera-director.ts` (part 1).
- **Contents:** `FocusRect`, `boundsOf(segs)` (flattened-bounds over `PathSegment[]` — svg.ts has no bounds helper today; it lives here because W5's file list adds exactly one new file), `focusRectsForScene(scene, project, durationMs, geometry, beats, opts)`: beat-aware focus rects from placement/text bounds (`buildGeometry` + `boundsOf`), safe margins per aspect (16:9 / 9:16 / 1:1 — the project's own dimensions, never hardcoded 960×540 — the S68 receipt), degenerate scenes → `[]`.
- **Behavior change:** none. The planner is exported but consumed by nothing yet.
- **Pins:** determinism (serialize-hash); containment math (rect ⊇ bounds ∪ safe margin); empty/unmatched beats → `[]`; bounds of a text-only scene derive from the character-count width model (the same approximation `handAt` uses — one text-width model per truth).
- **Rollback:** delete the file; nothing imports it.

### Commit W5.2 — `feat(whiteboard): W5.2 camera policy grammar — the pure checks the validator will enforce`

- **Modified:** `camera-director.ts` (part 2).
- **Contents:** `cameraPolicies` — pure checks, each returning `CameraPolicyViolation[]`: `checkMinTravelMs` (a travel key must not start before `MIN_TRAVEL_MS` after the previous key — today: 450 ms floor), `checkMaxZoomSpeed` (scale units/sec bound — the anti-nausea clamp), `checkFocusContainment` (every key's implied viewport must contain its beat's focus rect ∪ safe margins), `checkReadabilityMargin` (label bounds stay inside the frame at final output scale — the W4 `checkReadability` math reused, ONE readability model), `checkWritingWindowStability` (no key's travel span intersects an active stroke span — the director must not move the world under the pen tip while a stroke is in progress). Aggregate: `checkCameraPlan(keys, scene, project, geometry): CameraPolicyReport`.
- **Behavior change:** none (checks exported, unconsumed).
- **Pins:** each check fires on a crafted-bad key list; **zero violations on every doc in the current W1 benchmark suite** — this is the grandfather data point that proves the policy grammar cannot reject today's artifacts before the validator adopts it (W5.4).
- **Rollback:** delete the checks; nothing imports them.

### Commit W5.3 — `feat(whiteboard): W5.3 the director planner — focus rects to CameraEvent[] (behind the seam, unconsumed)`

- **Modified:** `camera-director.ts` (part 3 — file complete).
- **Contents:** `planSceneCamera(scene, project, durationMs, geometry, beats, opts): CameraEvent[]` — lead-in framing before a beat (camera settles BEFORE the first stroke: the S64 scene-open receipt), eased travel between focus rects (`easeInOut`, the house curve — never a second easing), stable writing windows (policy W5.2 enforced by construction, not by post-hoc fixing), post-beat holds, safe margins per aspect, residual-sway emission decision (D1: sway lives in `cameraAt`, NOT in the key stream — this commit only records the boundary), degenerate → `[]`. Plus the one-source seam (the W2 `beatSceneEvents` pattern):
  ```ts
  export function sceneCameraPlan(
    scene: WhiteboardScene,
    project: WhiteboardProject,
    durationMs: number,
    geometry: Map<string, AssetGeometry>,
    beats: WhiteboardBeat[]
  ): CameraEvent[] {
    if (scene.camera.length > 0) return scene.camera;          // author keys are SENIOR
    const plan = planSceneCamera(scene, project, durationMs, geometry, beats);
    return plan;                                                // usable plan; [] → keyless drift fallback
  }
  ```
- **Behavior change:** none (the seam is exported, unconsumed).
- **Pins:** determinism (hash over full plan); keys sorted, monotonic, first key covers t=0, no key outlasts the scene clock; **the anti-frozen-frame property test** — for every benchmark scene, the planned key stream + ink-activity timeline has no 2-second window where BOTH ink is static AND camera deltas are below the freezedetect sensitivity — this property test predicts the QC battery's behavior cheaply, BEFORE the expensive chromium run (W5.5 is where it is proven for real); writing-window stability holds for every benchmark scene.
- **Rollback:** delete the file; nothing imports it.

### Commit W5.4 — `feat(whiteboard): W5.4 camera validation consumes the policy grammar (strict on write, tolerant on read)`

- **Modified:** `src/lib/tubeforge/whiteboard/storyboard.ts` — the save/PUT validation path runs `checkCameraPlan`; violations → validation **errors** (the spec: "invalid CameraEvent[] → validation error, not silent clamp").
- **Tolerant-parse law applied to stored docs:** the LOAD path stays tolerant — stored v1 docs that predate the policies load with warnings, never refuse (otherwise this commit bricks every existing project; the same strict-write/tolerant-read split G1's `validateGraphicsDoc` uses). Editor round-trip keeps working: load → save of an unedited legacy doc must not newly fail (pin).
- **Pins:** crafted-bad doc rejected at save with per-violation reasons; every stored benchmark doc loads clean; editor round-trip; the grandfather pin from W5.2 re-run against the live validator.
- **Rollback:** revert the storyboard call site (one call).

### Commit W5.5 — `feat(whiteboard): W5.5 render and preview adopt the director; drift demoted to the keyless fallback` — **THE RISK COMMIT, atomic**

- **Modified:**
  - `src/lib/tubeforge/whiteboard/timing.ts` — `cameraAt`: drift applies **only when the effective key list is empty** (byte-identical to HEAD for keyless scenes — hard pin); keyed scenes interpolate keys with NO full-amplitude drift, plus the **residual sway** term (D1): `cameraDrift(tMs, factor)` gains the factor parameter — keyless factor 1 (byte-identical), keyed factor `SWAY_FACTOR` (constant, receipt-pinned, ≤ ¼ safe-margin, ≥ freezedetect sensitivity).
  - `src/lib/tubeforge/whiteboard/render.ts` + `wb-canvas.tsx` — both schedule camera through `sceneCameraPlan` (the one-source law: preview ≡ final by construction, exactly the W2 seam).
- **Behavior change:** keyed scenes lose full drift (author-keyed scenes included — the spec's explicit call); keyless scenes byte-identical; director scenes get planned travel + holds + residual sway.
- **Proof (this commit carries the W5 exit gate):** FULL W1 harness on real chromium+ffmpeg — 3 aspects × exact frames, QC battery green per aspect **with drift fully demoted on director scenes**; frozen-frames/static-shots receipts attached per aspect; per-aspect framing receipts (label bounds inside safe margins); writing-window stability receipts; keyless-scenes byte-identity serialize-hash pin. The W5.3 property test is the cheap pre-gate; this benchmark run is the law.
- **Rollback:** the demotion is one boolean branch in `cameraAt` + one seam call per surface — reverting restores HEAD behavior exactly (spec's rollback note).

### Commit W5.6 — `docs(audits): W5 the camera-director stage record + blind re-score kit`

- **New:** `docs/audits/w5-camera-director.md` (drift-tension resolution D1, QC receipts, amplitude derivation for `SWAY_FACTOR`); blind kit per the S120 §4 protocol (`WB-XXXXXXXX.mp4` + `P1..P5`, shuffled with pre-W5 artifacts, key outside the repo). The W5 re-score row is "camera-readability" — scheduling-bound, human track.

---

## Part B — G1: the motion-graphics engine (commit-by-commit)

**Pattern:** the whiteboard engine's proven shape applied to a new grammar — peer lane first (Phase 1: G1 renders whole graphics-led videos; `render-lane.ts` routes by mode; `render.ts` untouched), compositor citizenship later (Phase 2, gated on Stage X). **Sizing note:** this is the L (3–4 wk) stage; the commits below average one focused day each except G1.5/G1.8 (2–3 days).

**File-list refinement vs S120 §5:** the substrate that §5 lists as `graphics/anim.ts` is realized at its §8 home `src/lib/tubeforge/anim/` — one home, no shim, no re-export layer. G1/K1 import `@/lib/tubeforge/anim/*` directly. (Two homes for one substrate would violate the leaf-module law's spirit.)

### Commit G1.0 — `feat(anim): S1 the shared animation substrate — easings, keyframes, clock (pure, unused by any engine yet)`

*(This is Stage S from the roadmap; it lands as G1's first commit because G1 is its first consumer — the dependency graph's "S → G1" edge.)*

- **New:** `src/lib/tubeforge/anim/easing.ts` (`linear | ease-in-out | ease-out | pop | ease-back` as pure functions + the zoompan-expression compiler for G1/K1 frame math), `src/lib/tubeforge/anim/keyframe.ts` (`Keyframe<T>`, `evalAt(keys, tMs)` — ordered keys, clamped evaluation, tween composition), `src/lib/tubeforge/anim/clock.ts` (frame quantization matching `framePlanClock` byte-behavior + the shared frame-budget wall constant — one wall, two engines).
- **Pins:** purity (no fs/clock/randomness — the S64 law generalized); curve table complete; `evalAt` clamps outside the key range; quantization byte-matches the whiteboard's `framePlanClock`; `ease-back` overshoot bounded.
- **Scope law:** the whiteboard's `timing.ts` is NOT migrated onto it (byte-identity beats elegance where determinism is pinned — S120 §8).
- **Rollback:** delete the folder; nothing imports it.

### Commit G1.1 — `feat(graphics): G1.1 the GraphicsDoc grammar + validator`

- **New:** `src/lib/tubeforge/graphics/types.ts` — versioned like `Scene3D`: `GraphicsScene { id, narration, durationMs?, background, elements }`; `GraphicsElement` closed v1 set of 8 variants: `headline | subhead | bullet | counter | bar | barChart | icon | callout` (+ `shape`, `group` as structural variants — see spec wording) each carrying `{ id, at: Placement, enter: ElementMotion, exit?, emphasis? }`; `ElementMotion = { kind: "fade"|"rise"|"slide"|"pop"|"wipe"|"count"|"grow"|"draw", durationMs, delayMs, ease }`; named walls mirroring `WB_BUDGETS`: `elementsPerScene`, `scenesPerProject`, `sceneDurationMsMax`, `GRAPHICS_FRAME_BUDGET`; `validateGraphicsDoc` (tolerant parse / strict write; unknown element variants ignored on read with warnings — the additive law; id-charset law enforced — the `${assetId}--${pathId}` namespace seam lesson applies to element ids verbatim).
- **Pins:** mixed doc round-trips byte-identical; wall violations reject with named walls; tolerant parse of v-next fields; id-charset rejects separator-carrying ids.
- **Rollback:** unused module.

### Commit G1.2 — `feat(graphics): G1.2 frame truth — GraphicsFrameState (pure)`

- **New:** `src/lib/tubeforge/graphics/frame.ts` — `frameAt(doc, geometry, tMs): GraphicsFrameState` (element transforms / opacities / text states / counters) — **the one source of motion truth**; fixed precedence `emphasis > exit > enter`; `counter` number tweens and `bar`/`barChart` data-driven tweens are pure math (no `Math.random`, no `Date.now`).
- **Pins:** determinism (frame-hash over a fixed doc sweep); precedence; **element state never NaN outside its motion window** (the named G1 pin); tween continuity (no discontinuity at motion boundaries).
- **Rollback:** unused module.

### Commit G1.3 — `feat(graphics): G1.3 the composer — static skeleton + one APPLY_FRAME_FN`

- **New:** `src/lib/tubeforge/graphics/compose.ts` — the `composeScene` pattern: static HTML/SVG skeleton + ONE applier function shared by editor preview and renderer; icon variant paths through `svg.ts#sanitizeSvg`/`parsePathData` (reuse, never a second parser); **no CSS animation** — every frame applied by JS, deterministic.
- **Pins:** applier idempotence (apply twice ≡ once); deterministic DOM (no wall-clock in output); sanitize path exercised on a hostile-icon fixture.
- **Rollback:** unused module.

### Commit G1.4 — `feat(graphics): G1.4 the native planner + the LLM spec with per-element degradation`

- **New:** `src/lib/tubeforge/graphics/planner.ts` (native keyword/rule scaffold over narration), `src/lib/tubeforge/graphics/llm-planner.ts` (same schema as the whiteboard's `llm-planner.ts`: planner report, normalization police, per-element degradation to native, **byte-compatible fallback** when the model is absent or returns junk).
- **Pins:** LLM-less compose byte-identical to the native planner's output; dropped/invalid elements reported in the planner report; degrade path compiles the SAME doc the native planner would.
- **Rollback:** unused modules.

### Commit G1.5 — `feat(graphics): G1.5 the render engine — chromium loop, encode, VO slot, frame-budget wall`

- **New:** `src/lib/tubeforge/graphics/render.ts` — mirror of `whiteboard/render.ts` discipline: fresh context per scene, no-network route abort, JPEG quality 92, ffmpeg encode, VO slot normalization (`normalizeVoSlot`), music bed under the −16 LUFS mix contract, **pre-flight frame budget** (refuse over-budget docs BEFORE chromium launches — the E1 lesson).
- **Returns:** `{ scenes, file, tracks, plan }` with the `plan.totalSec == Σ deliveredSec` assertion baked in.
- **Pins:** determinism (identical frame hashes across two runs — G1's benchmark headline pin); budget wall refusal; seam law (no network from the page).
- **Rollback:** unused module.

### Commit G1.6 — `feat(graphics): G1.6 S87 projection — graphicsTracks (one clip per scene, kind "graphics")`

- **New:** `src/lib/tubeforge/graphics/tracks.ts` — `graphicsTracks(doc, fps, { voSceneIds, musicOn })`: visual track kind **`"graphics"`** (one clip per scene, `asset: null` — the reserved kind at types.ts:580), audio + subtitle tracks; the `framePlanClock` pattern re-used so edges are frame-quantized and contiguous **by construction**.
- **Pins:** projection parity (the `plan.totalSec` assertion against the tracks' own arithmetic); contiguity pins; quantization matches `anim/clock.ts`.
- **Rollback:** unused module.

### Commit G1.7 — `feat(lane): G1.7 the graphics render mode — types and lane routing move in ONE slice`

- **Modified:** `src/lib/tubeforge/types.ts` — `RENDER_MODES` gains `graphics`; `src/lib/tubeforge/render-lane.ts` — `StoryRenderMode` + `RenderLane` + `resolveRenderLane` gain the graphics lane.
- **The lockstep law (S88 CI lesson):** both ledgers move in the SAME slice — a half-registered mode is exactly the failure mode `laneDecisionsComplete` exists to catch.
- **Pins:** lane battery green; unknown modes still refuse; the graphics lane resolves and refuses ONLY on missing assets (honest errors).
- **Note:** until G1.8 the mode is reachable only through a direct doc PUT — no queue wiring, no user-facing surface change.
- **Rollback:** remove the mode id → lane refusal reverts.

### Commit G1.8 — `feat(graphics): G1.8 persistence + queue — graphicsProject column and the crash-resumable job`

- **Modified:** `prisma/schema.prisma` — `Video.graphicsProject Json?` (additive nullable, SQLite + PG); queue wiring — a `graphics` job kind following the whiteboard job shape (crash-resumable, deterministic re-render on resume); `render-assembly.ts` — manifest accepts graphics entries (additive field).
- **Pins:** re-render on resume is deterministic (hash equality); migration additive on both drivers; manifest parity (`plan.totalSec` == manifest sum).
- **Rollback:** nullable column ignored; job kind unregistered.

### Commit G1.9 — `feat(graphics): G1.9 API routes + the studio surface`

- **New:** `src/app/api/videos/[id]/graphics/route.ts` (GET/PUT doc, advisory rev + 409-with-current — the whiteboard route pattern), `.../graphics/scaffold/route.ts`, `.../graphics/render/route.ts`; `graphics-studio.tsx` (mirror `whiteboard-studio.tsx`: element editor over the four motion kinds, per-element timing strips).
- **Pins:** 409 rev conflict; doc round-trip; `e2e/graphics.spec.ts` following `whiteboard.spec.ts`.
- **Rollback:** routes/studio are additive surfaces.

### Commit G1.10 — `test(benchmark): G1.10 the G1 benchmark + blind rubric + design record`

- **New:** `scripts/g1-graphics-benchmark.mts` — the W1 pattern: five fixed scene types (kinetic headline, stat reveal, process chain, chart story, call-to-action) × 3 aspects, determinism frame-hash pin, the unchanged 13-check QC battery on graphics finals; `docs/audits/g1-blind-rubric.md` (NEW perceptual baseline — G1 cannot be scored against the whiteboard rubric's anchors); `docs/design/g1-motion-graphics.md`.
- **Proof:** benchmark green end-to-end on real chromium+ffmpeg; blind kit generated.
- **Rollback:** docs/scripts only.

---

## Part C — `asset-validate.ts` signature draft (W3)

Written against the real tree: `PathSegment { points, lengths, closed }` per subpath (`svg.ts:20`), `pathSegments(d)` splits `M…M/Z` into subpaths, `WB_PATH_COMMAND_BUDGET = 512` (storyboard.ts), and the S67 receipt (assets.ts:95–100) as the teleport rationale. Structural inputs only — the validator takes shapes, not the `WhiteboardAsset` import, so the pure module cannot cycle into `assets.ts`.

```ts
// W3 — the stroke-authored asset validator (the reconciliation §5.3 / §9 W3).
//
// The single-subpath/no-teleport law is convention-only today: a path id
// whose `d` carries a second `M` renders a TELEPORTING pen (handAt samples
// across subpaths — timing.ts buildGeometry maps pathId → PathSegment[],
// and the pen flies the gap), and nothing fires. This module is the gate:
// structural checks always run (they need no metadata); metadata checks
// degrade to skipped-warnings until W3 lands the additive asset metadata
// in assets.ts. Pure — no fs, no DOM, no randomness (the S64 law).
//
// Enforcement is three-tier (risk register row 4):
//   library load  → warn-and-exclude (loadLibrary keeps the doc unmutated)
//   upload gate   → REJECT with readable, stable copy (the 7 S69 gates + this)
//   built-ins     → must pass their own validator (golden frames in CI)
import {
  parsePathData,
  pathSegments,
  totalLength,
  type PathSegment,
  type Point,
} from "./svg";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AssetCheckId =
  | "teleport"
  | "self-intersection"
  | "caps"
  | "closed-direction"
  | "fill-after-outline"
  | "orientation";

/** Severity: "reject" excludes an asset from the drawable index (library)
 *  or fails the upload; "warn" is recorded, never excluding. */
export type AssetCheckSeverity = "reject" | "warn";

export interface AssetCheckResult {
  check: AssetCheckId;
  ok: boolean;
  /** Stable, human-readable reason — the upload gate's copy is built from
   *  these; wording is pinned (rejection-copy pin). */
  reason: string;
  /** The offending path id when the check is path-scoped. */
  pathId?: string;
  severity: AssetCheckSeverity;
}

export interface AssetValidationReport {
  assetId: string;
  /** false ⇔ at least one "reject"-severity check fired. */
  ok: boolean;
  checks: AssetCheckResult[];
}

/** The W3 additive metadata the metadata-scoped checks consume. Absent
 *  metadata ⇒ those checks return severity-"warn", ok:true, reason
 *  "skipped: no metadata" — the validator passes today's 18 built-ins
 *  on day one, then enforces deeper once assets.ts ships the fields. */
export interface AssetW3Metadata {
  penGroups?: { id: string; pathIds: string[]; strokeWidth?: number; linecap?: "butt" | "round" | "square" }[];
  drawOrder?: string[];
  role?: Record<string, "outline" | "fill" | "label" | "arrow" | "emphasis">;
}

/** Structural asset shape — everything the validator may look at. */
export interface ValidatableAsset {
  id: string;
  paths: { id: string; d: string }[];
  viewBox: { w: number; h: number };
  meta?: AssetW3Metadata;
}

// ---------------------------------------------------------------------------
// Structural checks — always run
// ---------------------------------------------------------------------------

/** A path id whose `d` opens a second subpath (an `M` after the first
 *  command run) teleports the pen across the gap. One path id = ONE
 *  subpath; multi-subpath art must be split into separate path ids at
 *  authoring time (the S67 receipt). */
export function checkTeleport(assetId: string, d: string): AssetCheckResult;

/** Pairwise segment intersection on the flattened polylines of every
 *  subpath (adjacent pairs skipped; O(n·m) is fine at the
 *  WB_PATH_COMMAND_BUDGET = 512 cap). A stroke that crosses itself makes
 *  draw-order ambiguous and fill previews wrong. */
export function checkSelfIntersection(assetId: string, pathId: string, segs: PathSegment[]): AssetCheckResult;

// ---------------------------------------------------------------------------
// Metadata-scoped checks — degrade to skipped-warnings without metadata
// ---------------------------------------------------------------------------

/** Stroke-width / linecap consistency WITHIN a pen group (a pen cannot
 *  change nib mid-stroke without an unphysical pop). */
export function checkCaps(assetId: string, meta: AssetW3Metadata | undefined): AssetCheckResult;

/** Consistent winding for closed shapes (fill ordering depends on it). */
export function checkClosedDirection(assetId: string, pathId: string, segs: PathSegment[]): AssetCheckResult;

/** Fill-role paths must FOLLOW their outline in draw order — a fill that
 *  lands before its outline animates color onto invisible geometry. */
export function checkFillAfterOutline(assetId: string, meta: AssetW3Metadata | undefined): AssetCheckResult;

/** Up-vector sanity for arrow/label roles (an upside-down arrow renders
 *  fine and reads wrong). */
export function checkOrientation(assetId: string, meta: AssetW3Metadata | undefined): AssetCheckResult;

// ---------------------------------------------------------------------------
// Aggregates — the seams the loaders call
// ---------------------------------------------------------------------------

/** Full report for one asset. Deterministic order: teleport,
 *  self-intersection, closed-direction, caps, fill-after-outline,
 *  orientation. */
export function validateAsset(asset: ValidatableAsset): AssetValidationReport;

/** Library seam (asset-store.ts loadLibrary): warn-and-exclude — kept
 *  assets pass; excluded assets are recorded with their reports and the
 *  doc is NEVER mutated (the warn-and-exclude law). */
export function validateLibrary<A extends ValidatableAsset>(
  assets: A[]
): { kept: A[]; excluded: { asset: A; report: AssetValidationReport }[] };

/** Upload seam (upload.ts): the stable rejection copy — one line per
 *  reject-severity check, asset-prefixed. Wording pinned. */
export function uploadRejectionCopy(report: AssetValidationReport): string[];
```

**Implementation notes for the implementer:** `checkTeleport` counts `M` commands in `parsePathData(d)` beyond index 0 (cheaper and stricter than counting flattened subpaths — it catches the defect before geometry exists). `checkSelfIntersection` runs per subpath over `points` and must bail out gracefully above a segment-pair budget (a crafted 512-command path is ~130k pairs — pin the budget behavior, don't hang CI). Built-in library pass = all 18 assets validate `ok:true` with zero "warn"s after assets.ts ships metadata (that is the W3 exit gate's "every library asset passes its own validator").

---

## Part D — `scheduleScene` word-anchor API draft (W4)

Written against the real tree: `scheduleScene(scene, durationMs, geometry)` (timing.ts:62), the beat layer's fallback contract (`beatSceneEvents` → byte-for-byte `scheduleScene` output), and the captions lane's existing alignment arithmetic — `detectSpeechRuns` (exported, async) but `chunkEndPositionsByTranscript` / `wordPosToTime` / `snapToPause` (currently internal, captions.ts:167/208/229 — W4 exports them; that export is part of the stage).

### D.1 — the anchor type (lives in `timing.ts`, or a new `word-anchors.ts` if the file budget prefers it)

```ts
// W4 — word-level narration anchors, passed as INPUT (never a doc field —
// the reconciliation §5.4 law: anchors are scheduling evidence, not
// persisted state; tolerant-parse keeps v1 docs anchor-free forever).
//
// Producers: silence runs (silencedetect −35 dB / 0.30 s) + the ASR
// chunk-token alignment the captions lane already runs. Consumers:
// scheduleScene (window derivation), beat-plan (beat windows), and later
// K1 (mouth beats ride the same spans — one timing model, two engines).
//
// The byte-identity law: ABSENT or UNUSABLE anchors ⇒ scheduleScene
// output byte-for-byte identical to HEAD. Usability is decided by the
// guards below, deterministically, INSIDE the scheduler — the caller
// never branches on anchor validity.

/** One spoken word's span on the scene clock (ms, scene-relative). */
export interface WordAnchor {
  /** 0-based index into splitSentences-then-tokenized narration — the
   *  SAME tokenization the beat layer uses (one token model). */
  index: number;
  word: string;
  startMs: number;
  endMs: number;
}

export interface WordAnchors {
  /** Binding guard: anchors bind to ONE scene. */
  sceneId: string;
  /** Drift guard: the narration the anchors were aligned against
   *  (normalized hash of the scene's narration). A mismatch ⇒ anchors
   *  are UNUSABLE (the ASR transcribed different words than the doc
   *  holds — the mishear failure mode, risk register row 2). */
  narrationHash: string;
  /** Clock guard: the duration the anchors were measured on. A scene
   *  clock that drifted beyond ANCHOR_CLOCK_TOLERANCE_MS ⇒ unusable. */
  durationMs: number;
  byWord: WordAnchor[];
  source: "asr" | "silence-runs" | "hybrid";
}

/** Clock drift beyond this ⇒ anchors unusable (pinned; generous — a
 *  measured VO tail of +350 ms is normal per sceneDurationMs). */
export const ANCHOR_CLOCK_TOLERANCE_MS = 400;

/** Deterministic usability decision (exported so tests and the caller
 *  can both observe it — one decision, two readers). */
export function anchorsUsable(
  anchors: WordAnchors,
  scene: WhiteboardScene,
  durationMs: number
): boolean;
```

### D.2 — the scheduler signature change (timing.ts)

```ts
/**
 * Schedule a scene — W4 signature: the optional fourth input carries
 * word anchors. ABSENT anchors (or unusable per anchorsUsable) ⇒ today's
 * fill law BYTE-FOR-BYTE (serialize-hash pinned — this is the hard pin,
 * not a hope). Usable anchors ⇒ the draw budget distributes over the
 * MEASURED speech spans instead of word-proportional estimates:
 *   - beats derive from anchor spans (a beat window ≈ its speech run,
 *     tolerance-pinned |window − run| on fixture WAVs);
 *   - emphasis beats fire AFTER the spoken claim (the visual lands on
 *     the word, never before it);
 *   - the final-idea hold is preserved (HOLD_END_MS semantics untouched);
 *   - explicit events remain senior (the precedence law, unchanged).
 * PURE. Same inputs ⇒ same events, byte-for-byte (S64).
 */
export function scheduleScene(
  scene: WhiteboardScene,
  durationMs: number,
  geometry: Map<string, AssetGeometry>,
  anchors?: WordAnchors
): AnimationEvent[];
```

### D.3 — the beat layer signatures (beat-plan.ts, unchanged in spirit)

```ts
export interface PlanBeatsOptions {
  durationMs: number;
  geometry: Map<string, AssetGeometry>;
  assetTags?: ReadonlyMap<string, readonly string[]>;
  /** W4: usable anchors replace word-proportional windows (which remain
   *  the no-anchor fallback — W2's model demotes, it does not die). */
  anchors?: WordAnchors;
}

export function planBeats(scene: WhiteboardScene, opts: PlanBeatsOptions): WhiteboardBeat[];

export function beatSceneEvents(
  scene: WhiteboardScene,
  durationMs: number,
  geometry: Map<string, AssetGeometry>,
  assetTags?: ReadonlyMap<string, readonly string[]>,
  anchors?: WordAnchors
): AnimationEvent[];
```

### D.4 — the producer seam (captions.ts)

```ts
// W4 exports the three internal helpers (they were the captions lane's
// private arithmetic; the whiteboard render job now shares them — one
// alignment model, two consumers):
export { chunkEndPositionsByTranscript, wordPosToTime, snapToPause };

/** Build per-word anchors for one scene's VO WAV. Returns null when no
 *  usable runs exist (no VO, silence-only, alignment too sparse) — the
 *  caller treats null exactly like absent anchors (byte-identical
 *  fallback). The narration hash + duration ride the result so the
 *  scheduler's guards can refuse drift deterministically. */
export async function buildWordAnchors(opts: {
  sceneId: string;
  narration: string;
  wavPath: string;
  wavDurSec: number;
  maxSnapMs?: number; // default 450 — snapToPause's existing bound
}): Promise<WordAnchors | null>;
```

**Caller wiring (the whiteboard render job):** per scene with a VO file — `buildWordAnchors({ sceneId, narration, wavPath, wavDurSec })` → pass the result (or undefined) into `sceneDurationMs`/`beatSceneEvents`/`scheduleScene` at the existing seams. Scenes without VO keep the estimator. Nothing is stored; the rollback is "stop passing anchors" — the engine renders exactly as HEAD (spec's rollback note).

### D.5 — `text-draw.ts` signatures (the W4 companion; concise)

```ts
// W4 — handwritten text. Two modes: glyph outlines (one handwriting face,
// pre-converted to SVG path outlines — deterministic, decision §10.3's
// single-face route) emitted as plain draw_path events (ZERO grammar
// growth — the pen rides glyphs through the EXISTING hand pipeline,
// closing the §8.5 pen-drift defect), and the marker-label wipe fallback.

/** One glyph's outline + advance width (asset-space units). */
export interface GlyphOutline { d: string; advance: number; }

/** Deterministic glyph outlines for a string (cached per string — pure
 *  module, S64 law). Whitespace advances without a glyph. */
export function glyphOutlinesFor(text: string): GlyphOutline[];

/** Compile handwritten text into draw_path events riding ONE synthetic
 *  path id per glyph, within [startMs, startMs + windowMs], using the
 *  fill law's clamps. Explicit events stay senior (precedence law). */
export function handwrittenTextEvents(opts: {
  assetId: string;
  /** A W3-consistent path id: charset law applies (storyboard.ts id law). */
  pathIdPrefix: string;
  text: string;
  startMs: number;
  windowMs: number;
  at: Placement;
}): AnimationEvent[];

/** Readability at final output scale, per aspect: the rendered glyph
 *  height on screen must clear MIN_GLYPH_HEIGHT_PX at the current camera
 *  state. Pure; consumed by the planner (placement sizing), the camera
 *  director (W5 reuses this ONE model), and validation (the
 *  scale-0.4 rejection pin). */
export function checkReadability(opts: {
  textPlacement: Placement;
  camera: { cx: number; cy: number; scale: number };
  outputSize: { width: number; height: number };
}): { ok: boolean; renderedHeightPx: number; minPx: number; reason: string };
```

---

## Part E — K1: 2D character animation (commit-by-commit)

**Pattern:** the two-lane strategy from S120 §6 — **K1-native** (primary, $0 pixels): a 2D puppet rig over identity-locked character art decomposed into layered parts, posed per frame by pure functions; **K1-i2v** (escalation, premium): the existing i2v lane with rig-aware prompts and the S83 VCE identity floor. The honesty law governs every claim: S93's "the rig will not fake it" is satisfied BECAUSE K1 replaces stills with real art — and every doc/UI surface says **"mouth beat-sync", never "lip-sync"** (risk register row 10).

**Dependency gating (roadmap §10 row 10):** K1 starts once **W4 anchors are green** (mouth beats are anchor-driven) and **G1.0–G1.4 have landed** (the rig renders share G1's frame discipline — APPLY_FRAME_FN applier, fresh-context loop, frame budget). S (G1.0) is a hard input: `rig-frame.ts` consumes `anim/keyframe.ts` + `anim/easing.ts` directly.

**One prerequisite seam:** `beat-plan.ts#classifySentence` is internal today (verified — not exported at `e387287`). The spec's "one classifier, two consumers" law requires the export; it rides K1.2 as a one-line modified file.

### Commit K1.0 — `feat(characters): K1.0 the CharacterRigDoc contract + validator (pure, unused)`

- **New:** `src/lib/tubeforge/characters/rig2d.ts` — versioned like `Scene3D` (the S88 house doc laws verbatim: tolerant parse null-on-unreadable, strict write, byte-stable round-trip): `RIG2D_VERSION = 1`; `RigPart { id, svgRef, z, pivot: Point, parent?: partId, rest: Placement }`; **standard slot names** — the closed vocabulary pose sheets map to: mouth `{ closed | open | wide | oh | smile }` (5 shapes — honest narration-sync at explainer quality), brow `{ neutral | raised | furrowed }`, `arm-l` / `arm-r` `{ rest | raise | point }` (3-way); `RigPose { id, name, slot, joints }`; `RigTimeline` (ordered pose keyframes over the scene clock); `validateRigDoc` — referential integrity (svgRef exists in the character's parts, parent refs acyclic, pivot inside svgRef bounds, joint partIds exist), **FK-rotation-only** (no IK in v1 — the non-goal); `parseRig2D(json): CharacterRigDoc | null` / `writeRig2D(doc): string`.
- **Pins:** round-trip byte-stable; acyclic-parent check fires on a crafted cycle; slot names are a closed set (unknown slot → validation error); id law mirrors `validWhiteboardId` (the namespace-seam law applies to part ids verbatim).
- **Rollback:** unused module.

### Commit K1.1 — `feat(characters): K1.1 pose evaluation — poseAt + the mouth beat schedule (pure, unused)`

- **New:** `src/lib/tubeforge/characters/rig-frame.ts` — `poseAt(rig, timeline, tMs): RigFrameState`: per-part resolved FK transforms, parent chain composed root-down, keyframed joint states evaluated through `anim/keyframe.ts#evalAt` + the shared easing curves; `mouthSchedule(anchors: WordAnchors, opts): MouthBeat[]` — **syllable-counted open/close beats inside each word span** (vowel-group counting — a pure, deterministic heuristic; the honest alternative to phoneme lip-sync, scope-claimed as beat-sync everywhere); `mouthAt(beats, tMs): MouthShape`; a locomotion primitive `travelTimeline(opts): RigTimeline` (stride-coupled torso bob + arm swing — v1 has NO leg parts in the spec's part list, so the walk reads as glide-with-bob; the scope claim is recorded in the stage doc, not hidden).
- **Pins:** determinism (serialize-hash over a pose sweep); **transforms never NaN** (the named K1 pin); **mouth beats ⊂ word spans** (the W4 tolerance pin — beats never leak outside anchor spans); mouth `closed` outside speech runs; FK composition pinned on a 3-part chain fixture (rotations compose in the documented order).
- **Rollback:** unused module.

### Commit K1.2 — `feat(characters): K1.2 the rig director — narration + pose sheet → pose timeline (pure, unused)`

- **New:** `src/lib/tubeforge/characters/rig-director.ts` — `planRigTimeline(scene, poseSheet, anchors?): RigTimelinePlan` — gesture beats from W2-style purpose classification, **reusing `beat-plan.ts#classifySentence`** (one classifier, two consumers — the spec's own law): setup → welcoming pose, action → gesture on the action verb's word span, emphasis → point/circle on the claim; the mouth channel rides continuously through speech runs; idle = rest pose with breathing (the S93 breath cadence, `BREATH_SEC = 2.2`, as the idle oscillator — subtle, in-character). Degradation report pattern: poses requested but missing from the pose sheet resolve to nearest rest and are REPORTED (`missingSlots[]`), never silently dropped.
- **Modified:** `src/lib/tubeforge/whiteboard/beat-plan.ts` — export `classifySentence` (the cue tables stay private; `BeatPurpose` is already exported).
- **Pins:** determinism; order-monotonic law respected (gestures never scheduled before an earlier-ordered beat — the W2 law extends to gestures); emphasis lands AFTER the spoken claim (the W4 law); missing-slot degradation reported.
- **Rollback:** unused module; the export is additive.

### Commit K1.3 — `feat(characters): K1.3 part decomposition + pose-sheet generation targeting rig slots`

- **Modified:** `src/lib/tubeforge/characters.ts` — the portrait flow gains a part-decomposition pass: generate layered parts (head, torso, upper/lower arms, hands, brows, mouth set) instead of one flat PNG; pose-sheet generation targets the K1 slot vocabulary verbatim; parts are generated AND human-editable (the art-quality mitigation, risk register row 6).
- **Pins:** the decomposition prompt produces the slot vocabulary verbatim; **identity VCE ≥ 80 between the composed parts and the source portrait** — parts must reassemble into the same face, enforced HERE at generation time (the identity floor pin, not deferred to render); every part passes svg sanitize; failure of the floor → the character falls back to still portrait + S93 (reported, honest).
- **Rollback:** the pass is additive per-character; absent parts → portrait flow byte-identical.

### Commit K1.4 — `feat(characters): K1.4 the rig render engine — chromium loop into the shared frame pipeline`

- **New:** `src/lib/tubeforge/characters/rig-render.ts` — composes rig layers into scene SVG per frame (`svg.ts` sanitize/parse; z-ordered part stacking; `poseAt` transforms applied root-down; `mouthAt` swaps the mouth part's svgRef); rides the G1 frame discipline: the APPLY_FRAME_FN applier pattern, per-scene fresh context, no-network route abort, JPEG quality 92, ffmpeg encode, **pre-flight frame budget** — the shared wall from `anim/clock.ts` (one wall, three engines now); returns `{ scenes, file, tracks, plan }` with the `plan.totalSec == Σ deliveredSec` assertion.
- **Pins:** determinism (identical frame hashes across two runs); **identity VCE ≥ 80 on RENDERED frames** (the full-chain floor — generation-time in K1.3, render-time here); transforms never NaN in output SVG; budget wall refusal BEFORE chromium launches (the E1 lesson).
- **Rollback:** unused module.

### Commit K1.5 — `feat(characters): K1.5 S87 projection — characterTracks (one clip per scene, kind "character")`

- **New:** `src/lib/tubeforge/characters/tracks.ts` — `characterTracks(doc, fps, { voSceneIds, musicOn })`: visual track kind **`"character"`** (reserved at types.ts:580 and already present in the `TimelineTrackDTO` union — no contract change needed), audio + subtitle tracks; the `whiteboardTracks` pattern verbatim: `framePlanClock` quantization, contiguous edges by construction, `rowSceneIndex` linkage, `asset: null` (the frame is posed by the engine).
- **Pins:** projection parity (the totalSec assertion); contiguity; quantization byte-matches `anim/clock.ts`.
- **Rollback:** unused module.

### Commit K1.6 — `feat(liveliness): K1.6 the native-rig channel + the rig seniority ladder`

- **Modified:** `src/lib/tubeforge/liveliness.ts` — `LivelinessChannel` gains `"character"`; the channel precedence inserts **native-rig between `kenburns` and `i2v`** — native-first ($0 pixels) before premium pixels, the ladder law applied to channels; `src/lib/tubeforge/character-rig.ts` — the S93 seniority ladder extended: **explicit rig timeline > S93 breath > auto** (the ladder pattern preserved; S93 breath stays for still-portrait scenes).
- **Pins:** channel decision determinism (the existing unit pattern); **rigDoc-absent path byte-identical** (the master rollback pin — additive parse means every existing character renders exactly as HEAD); ladder order pinned.
- **Rollback:** remove the channel from the precedence list; rigDoc absent → S93 byte-identical (spec's rollback note).

### Commit K1.7 — `feat(characters): K1.7 persistence + API — rigDoc/parts columns, rig routes, render hook`

- **Modified:** `prisma/schema.prisma` — `Character.rigDoc Json?`, `Character.parts Json?` (additive nullable, SQLite + PG).
- **New:** `src/app/api/characters/[id]/rig/route.ts` (GET/PUT rig doc, advisory rev + 409-with-current — the whiteboard route pattern), `.../rig/auto/route.ts` (the K1.2 planner pass); the per-video render hook follows the whiteboard job shape (crash-resumable, deterministic re-render on resume).
- **Pins:** migration additive both drivers; route round-trip; 409 rev conflict; resume re-render deterministic (hash equality).
- **Rollback:** nullable columns ignored; routes additive.

### Commit K1.8 — `feat(characters): K1.8 studio — the rig editor + pose-timeline strip`

- **Modified:** the existing character studio surfaces (portrait/poses flow) — rig editor (part list, pivots, z-order, slot assignment), pose-timeline strip (gesture beats over the scene clock + the mouth channel lane), and the **scope labeling in user-facing copy: "mouth beat-sync", never "lip-sync"** (the honesty law enforced in UI, not just docs).
- **Pins:** editor round-trip of every rig field; the copy pin (no surface claims phoneme lip-sync); e2e spec follows the character flow.
- **Rollback:** studio surfaces additive.

### Commit K1.9 — `feat(characters): K1.9 the i2v escalation lane — rig-aware prompts + identity re-check`

- **Modified:** the i2v lane prompt contract gains rig awareness (pose sheet + motion intent injected — the premium escalation when native rig quality is insufficient or the scene demands full-frame motion); `src/lib/tubeforge/visual-consistency.ts` — the S83 cross-video VCE re-checks identity on i2v outputs at the same ≥ 80 floor.
- **Pins:** prompt determinism; VCE floor enforced — below floor the scene falls back to the native rig and the fallback is REPORTED (honest degradation, never silent).
- **Rollback:** the prompt extension is additive text; the re-check is a gate, removable independently.

### Commit K1.10 — `test(characters): K1.10 the rig smoke + blind rubric + design record`

- **New:** `scripts/k1-rig-smoke.mts` — the S93 smoke pattern (4 unit pins + real-render smoke) extended: **walk/travel cycle renders** (glide-with-bob in v1 — no leg parts; the scope claim is recorded in the doc), **mouth beats land on anchors** (the W4 tolerance pin exercised on real frames), **identity VCE ≥ 80 on rig frames**; `docs/audits/k1-blind-rubric.md` — a NEW perceptual baseline (the W1 rubric's anchors do not cover character motion; the W1 protocol is reused, the anchors are new); `docs/design/k1-character-rig.md` — the design record.
- **Proof:** smoke green end-to-end on real chromium+ffmpeg; blind kit generated.
- **Rollback:** docs/scripts only.

**Explicit non-goals (K1, restated from S120 §6):** no skeletal mesh deformation/skinning, no phoneme-exact lip-sync claim, no IK solvers in v1 (FK rotations cover explainer poses), no real-time playback engine (deterministic frame rendering only).

---

## Part F — `graphics/types.ts` signature draft (G1.1)

Written against the real tree: the **Scene3D grammar precedent** (`scene3d.ts` — `SCENE3D_VERSION`, tolerant parse via `parseScene3D(json): Scene3D | null`, the S88 house doc laws quoted verbatim in its header), the **`WB_BUDGETS` named-walls shape** (storyboard.ts:126, `as const` + JSDoc), and the **id-charset law** (`WB_ID_RE` + the `--`/`::` separator ban, storyboard.ts:114–119). One deliberate deviation from S120 §5's file list, recorded in Part B: the easing/clock types live at `anim/` (Stage S) — the draft re-declares them as local aliases ONLY so it compiles standalone; the implementation imports them.

```ts
// G1.1 — the motion-graphics doc contract + validator (the reconciliation
// roadmap §5 / S120 §5).
//
// THE HOUSE DOC LAWS (S88's, verbatim — the Scene3D precedent):
// versioned (an unknown version reads as absent and is never
// overwritten), tolerant parse (null on unreadable — junk fields fall
// back honestly), strict write (exactly the declared fields, version
// first), byte-stable round-trip.
//
// The v1 element set is CLOSED (risk register row 5: grammar sprawl is
// G1's named risk — new element variants require a design-doc slice,
// never a drive-by union member).
//
// PURE — no fs, no DOM, no clock, no randomness (the S64 law
// generalizes); the composer (G1.3) and the render engine (G1.5) own the
// side effects.
import { parsePathData, type Placement } from "../whiteboard/svg";

// ---------------------------------------------------------------------------
// Stage-S aliases — the implementation imports these from anim/ (easing.ts,
// clock.ts); re-declared here only so this draft compiles standalone.
// ---------------------------------------------------------------------------

/** The anim/easing.ts curve table (Stage S / commit G1.0). */
export type GraphicsEase = "linear" | "ease-in-out" | "ease-out" | "pop" | "ease-back";

/** THE shared frame-budget wall (anim/clock.ts, Stage S) — one wall, two
 *  engines. 25,920 frames = 18 min at 24 fps; the render pre-flight (G1.5)
 *  refuses over-budget docs BEFORE chromium launches. */
export const GRAPHICS_FRAME_BUDGET = 25_920;

// ---------------------------------------------------------------------------
// Version + id law
// ---------------------------------------------------------------------------

export const GRAPHICS_VERSION = 1;

/** Legal element/scene id — the whiteboard's id-charset law verbatim
 *  (WB_ID_RE + the separator ban): ids ride DOM-namespace-shaped keys; a
 *  `--` or `::` inside an id corrupts that seam (the storyboard.ts:101
 *  defense-in-depth receipt applies to graphics ids as-is). */
export const GRAPHICS_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

export function validGraphicsId(id: string): boolean {
  return GRAPHICS_ID_RE.test(id) && !id.includes("--") && !id.includes("::");
}

// ---------------------------------------------------------------------------
// Motion grammar
// ---------------------------------------------------------------------------

export const GRAPHICS_MOTION_KINDS = [
  "fade", "rise", "slide", "pop", "wipe", "count", "grow", "draw",
] as const;
export type GraphicsMotionKind = (typeof GRAPHICS_MOTION_KINDS)[number];

export interface ElementMotion {
  kind: GraphicsMotionKind;
  durationMs: number; // > 0, validator-pinned
  delayMs: number;    // ≥ 0
  ease: GraphicsEase;
}

export const GRAPHICS_ELEMENT_KINDS = [
  "headline", "subhead", "bullet", "counter", "bar", "barChart",
  "icon", "callout", "shape", "group",
] as const;
export type GraphicsElementKind = (typeof GRAPHICS_ELEMENT_KINDS)[number];

/** Which motions are legal per element kind — the compatibility table the
 *  validator enforces (a "count" on a headline is a doc bug, not a
 *  renderer branch; a "draw" on a text element has no stroke to draw).
 *  The table IS the grammar's enforcement surface — closed like the kind
 *  set. */
export const MOTION_KINDS_BY_ELEMENT: Readonly<
  Record<GraphicsElementKind, readonly GraphicsMotionKind[]>
> = {
  headline: ["fade", "rise", "slide", "pop"],
  subhead:  ["fade", "rise", "slide", "pop"],
  bullet:   ["fade", "rise", "slide", "pop"],
  counter:  ["fade", "rise", "slide", "pop", "count"],
  bar:      ["fade", "slide", "wipe", "grow"],
  barChart: ["fade", "slide", "wipe", "grow"],
  icon:     ["fade", "slide", "pop", "draw"],
  callout:  ["fade", "rise", "slide", "pop"],
  shape:    ["fade", "slide", "wipe", "grow", "draw"],
  group:    ["fade", "rise", "slide", "pop"],
};

// ---------------------------------------------------------------------------
// Element payloads — one optional payload per kind (the Scene3D flat shape:
// the validator enforces payload-per-kind, tolerant parse never refuses on
// an absent payload for a kind that has one)
// ---------------------------------------------------------------------------

export interface TextPayload {
  text: string;
  sizePx?: number;   // default 48, clamped 12..288
  weight?: number;   // 100..900, default 700
  color?: string;    // #rrggbb
  align?: "left" | "center" | "right";
}

export interface CounterPayload {
  from: number;      // finite; from < to for a count-up (validator-pinned)
  to: number;        // finite
  unit?: string;     // "%", "×", "k" … rendered after the number
  decimals?: 0 | 1 | 2;
}

export interface BarDatum { label: string; value: number; } // value finite, ≥ 0

export interface BarPayload {
  data: BarDatum[];       // 1..GRAPHICS_BUDGETS.barDataMax rows
  unit?: string;
  max?: number;           // scale ceiling; absent ⇒ max(data)
  horizontal?: boolean;   // default false
}

export interface IconPayload {
  /** SVG path `d` strings — parsed (command budget) at validation;
   *  sanitized at compose time (G1.3, svg.ts#sanitizeSvg). */
  paths: string[];
  color?: string;
  strokeWidth?: number;
}

export interface CalloutPayload {
  text: string;
  pointsAt?: { x: number; y: number }; // scene units — the tail's target
}

export interface ShapePayload {
  kind: "rect" | "line" | "circle";
  w?: number;  // rect
  h?: number;  // rect
  r?: number;  // circle
  stroke?: string;
  fill?: string;
  strokeWidth?: number;
}

export interface GroupPayload {
  /** Member element ids — must exist, must not reference the group itself
   *  or an ancestor (acyclic); v1: groups do not nest (a named wall). */
  children: string[];
}

export interface GraphicsElement {
  id: string;
  kind: GraphicsElementKind;
  /** Scene-space placement — the whiteboard's Placement (svg.ts:438):
   *  one placement shape across engines, never a second one. */
  at: Placement;
  /** The payload for `kind` (typed above); validator checks presence +
   *  shape per kind. */
  text?: TextPayload;
  counter?: CounterPayload;
  bar?: BarPayload;
  icon?: IconPayload;
  callout?: CalloutPayload;
  shape?: ShapePayload;
  group?: GroupPayload;
  /** Choreography: enter is REQUIRED (an element that cannot enter has
   *  no reason to exist in this grammar); exit/emphasis optional. The
   *  frame engine composes with fixed precedence emphasis > exit > enter
   *  (G1.2's pin). */
  enter: ElementMotion;
  exit?: ElementMotion;
  emphasis?: ElementMotion;
  opacity?: number; // base opacity 0..1, default 1
}

// ---------------------------------------------------------------------------
// Scene + doc
// ---------------------------------------------------------------------------

export interface GraphicsScene {
  id: string;
  narration: string;
  /** Explicit clock override; absent ⇒ the house 2.6-wps estimate
   *  (whiteboard timing.ts estimateNarrationMs — ONE clock model, reused,
   *  not re-implemented). VO-measured duration rides the render call, not
   *  the doc (the anchors-are-inputs law, same as W4). */
  durationMs?: number;
  background: string; // #rrggbb
  elements: GraphicsElement[];
}

export interface GraphicsDoc {
  version: number; // GRAPHICS_VERSION — first field on write (strict write)
  title: string;
  /** Output surface — one of the three house aspects' native sizes:
   *  1920×1080 (16:9), 1080×1920 (9:16), 1080×1080 (1:1). */
  width: number;
  height: number;
  fps: 24 | 30;
  scenes: GraphicsScene[];
}

// ---------------------------------------------------------------------------
// Named walls — the WB_BUDGETS shape (storyboard.ts:126): constants cited
// by the validator, the tests, and the design doc — ONE source. Values are
// the implementer's receipts to tune; the NAMES are the contract.
// ---------------------------------------------------------------------------

export const GRAPHICS_BUDGETS = {
  /** Max elements per scene. */
  elementsPerScene: 32,
  /** Max scenes per project (the whiteboard's number). */
  scenesPerProject: 24,
  /** Max EXPLICIT scene duration (estimates clamp lower — the timing law). */
  sceneDurationMsMax: 120_000,
  /** Max Σ explicit scene durations (VO-measured totals are bounded at the
   *  render pre-flight by GRAPHICS_FRAME_BUDGET instead). */
  projectExplicitDurationMsMax: 900_000,
  /** Max data rows per bar/barChart. */
  barDataMax: 8,
  /** v1: groups do not nest. */
  groupDepthMax: 1,
  /** Parsed command budget per icon path — the WB_PATH_COMMAND_BUDGET
   *  number (the self-intersection math is fine at this cap; so is the
   *  composer). */
  iconPathCommandBudget: 512,
} as const;

// ---------------------------------------------------------------------------
// Validation — tolerant parse (null on unreadable), strict write
// ---------------------------------------------------------------------------

export interface GraphicsValidationResult {
  doc: GraphicsDoc | null;
  errors: string[];
  /** Tolerant-read notes: unknown element kinds / unknown fields / unknown
   *  version — the doc still parses, the notes explain what was ignored
   *  (the additive-parse law: v-next docs load in v1 readers). */
  warnings: string[];
}

/** Full validation: version check, id law on every id, walls, per-kind
 *  payload shapes, motion/element compatibility (MOTION_KINDS_BY_ELEMENT),
 *  group referential integrity + acyclicity + depth, time sanity
 *  (durationMs > 0, delayMs ≥ 0, enter required, motion spans within the
 *  scene clock), icon path parse under the command budget, color/#rrggbb
 *  shape, fps ∈ {24, 30}, aspect size ∈ the three house surfaces.
 *  PURE — same input, same result. */
export function validateGraphicsDoc(raw: unknown): GraphicsValidationResult;

/** Tolerant entry (the parseScene3D shape): null on unreadable — junk
 *  JSON, wrong version shape, structural nonsense. */
export function parseGraphicsDoc(json: string | null | undefined): GraphicsDoc | null;

/** Strict write: exactly the declared fields, version first, key order
 *  stable — byte-stable round-trip is the pin
 *  (parseGraphicsDoc(writeGraphicsDoc(doc)) ≡ doc, serialize-hashed). */
export function writeGraphicsDoc(doc: GraphicsDoc): string;
```

**Validator behavior notes for the implementer:**

- **Tolerant vs strict, exactly like `validateWhiteboardProject`:** structural nonsense (not an object, missing scenes, id-law violation, wall violation, motion/element incompatibility, group cycle) → `errors` + `doc: null`. Unknown-but-harmless extras (unknown fields on a known element, unknown element kinds, higher version) → `warnings` + the doc parsed without them — v1 readers never refuse v-next docs.
- **The motion compatibility table is enforced at validation, not at render** — a doc that reaches `graphics/frame.ts` is guaranteed legal, so `frameAt` carries no defensive branches (the whiteboard's own split: validate integrity once, schedule purely everywhere else).
- **Groups resolve at compose time, not validation time** — the validator pins referential integrity + acyclicity + depth; `frameAt` (G1.2) inherits group motion to children by composition, one inheritance rule, documented in the design record.
- **Placement reuse is deliberate** — `at: Placement` is `whiteboard/svg.ts`'s type (x/y/scale/rotateDeg). The spec's `Placement` means THIS shape; re-declaring it would create a second placement grammar and a conversion seam no engine needs.

---

## Part G — post-landing verification (HEAD `37796ce`, 2026-11-14)

**Method:** fresh full clone; commit ladder read; every claimed stage checked against the tree (files, exports, seams, audit docs, baselines); the Parts A–F drafts compared against what actually shipped. This section reconciles the fresh external audit (delivered 2026-11-14) with ground truth and updates the status of every part above.

### G.1 — the fresh audit's claims, verified

| Claim | Verified against the tree | Verdict |
| --- | --- | --- |
| HEAD is `37796ce` (2026-11-14 03:46 UTC) | `git log -1` | CONFIRMED |
| W3 landed | `381e534`; `asset-validate.ts` (six checks + `AssetFinding`/`AssetValidationReport`); `upload.ts:184` rejects with readable reasons; `asset-store.ts:111` warn-and-exclude (`warnings[]`); `docs/audits/w3-asset-validator.md` + golden baseline JSON | CONFIRMED |
| W4 complete (three slices) | `c818f75` (anchors are inputs) → `5fbd134`/`d45faed`/`41b7416` (glyph table + consumer seam + page fix) → `d45faed` (captions lane drives the spoken schedule) → `9f337c3` (status close); `voice-anchors.ts`, `glyphs.ts`, `text-draw.ts`; three W4 audit docs | CONFIRMED |
| W5 landed | `e6fafe6`; `camera-director.ts` (`directCamera`, `cameraPolicies`, policy constants); `storyboard.ts` imports `cameraPolicies` (validation enforces, never clamps); `cameraAt` demotion branch; `docs/audits/w5-camera-director.md` records the exit gate: QC green ×3 aspects with drift demoted | CONFIRMED (with two findings, §G.2) |
| Stage S landed | `14b67fe`; `anim/{easing,keyframe,clock}.ts`; `EaseName` table (`linear\|ease-in-out\|ease-out\|pop\|ease-back`), `evalAt(keys, tMs, lerp)`, `ANIM_FRAME_BUDGET = 25_920`, `framePlanWindows` | CONFIRMED |
| W6 landed | `712e0e5`; `BoardPolicy` on `WhiteboardScene` (`carryPlacements`, `exit`); `resolveCarriedInk`/`carriedExitAt` in `timing.ts` (carry as DATA, page recycling untouched); `docs/audits/w6-continuous-canvas.md` | CONFIRMED |
| W7 landed | `b871e01` + `37796ce`; `HandPose` (write/draw/point/circle/rest) + pen-up travel in `handAt` (`HAND_TRAVEL_LIFT`, arrival tool-in-hand); `sfx-plan.ts` (cue walls, recipes); audit doc: **590 → 597 unit tests, −16.4 LUFS / −11.9 dBTP** on a three-way mixed final, full QC battery green | CONFIRMED — the audit's numbers match the repo's own receipts |
| G1/K1/C2-ext/R/X remain | No `graphics/` dir, no `characters/` rig dir; `RENDER_MODES` has no `graphics`; `LivelinessChannel` has no `character`; `motion.ts` has no new verbs; no `rig2d.ts` | CONFIRMED |
| Blind re-score outstanding | No `wN-blind-rescore.md` anywhere in `docs/audits/` | CONFIRMED — the W-track's §4 gate is genuinely open |
| CI 8/8 green (README) | Token-authenticated GitHub API lookup (2026-11-14): check-runs at `37796ce` — E2E (Playwright), Clean-clone bootstrap (P0.1), Secret scan (gitleaks), Typecheck · Lint · Unit, Money-path coverage, PostgreSQL integration (migrations + wedge recovery), Production build, Docker production smoke (P0.6) — **all `success`, 8/8**; the six latest main-branch CI workflow runs (back through `41b7416`) all `success` (305 total runs on main) | INDEPENDENTLY VERIFIED |

### G.2 — three findings the fresh audit does not surface

1. **`directCamera` is a proven but UNPLUGGED leaf.** The only `src/` consumer of `camera-director.ts` is `storyboard.ts` (`cameraPolicies` for validation). The default compose/render path does **not** auto-direct cameraless scenes; `directCamera` is consumed only by the unit battery and `scripts/w5-camera-proof.mts`. The W6 audit states it explicitly: "`directCamera`/`beatSceneEvents` are untouched." So "content-driven camera" today means: authored/validated keys ride `cameraAt`, cameraless scenes keep the drift fallback — the director is proven, policy-gated, and ready, but its adoption (studio authoring button, planner emission, or render-path auto-direct) is a **recorded tail of the W-track**, not landed work. Any G1/K1 planning should carry this as a known whiteboard tail, not assume every render is directed.
2. **W5 is behavior-preserving at HEAD by construction.** `directedBreath(tMs) { return cameraDrift(tMs); }` — the keyed lane's "motion floor" is numerically identical to the fallback drift today; the demotion is semantic ("keys lead, the floor follows") and becomes behavioral only when real director/author keys with travel land. The W5 audit also records that the PREDICTED failure was reproduced and fixed in-slice: the first demoted render failed frozen-frames (a fully-static directed camera), exactly the "demoting drift alone fails QC" the reconciliation §8.1 named — the fix (the anchored motion floor + the director's closing move) is part of the slice with both failed runs in the worklog. This validates the roadmap Part A's design decision D1 and its risk framing: the failure mode was real, and the atomic-slice discipline caught it.
3. **The shipped anchors contract is leaner than the Part D draft.** `WordAnchors = { byWord: WordAnchor[] }` with `WordAnchor = { index, startMs, endMs }` — no `sceneId`/`narrationHash`/`source` binding fields. Degeneracy protection lives in `anchorEnvelope(anchors, durationMs)` (empty spans, non-monotonic indexes, negative starts, envelope past the clock → null → schedule exactly as if absent). The producer is a dedicated `voice-anchors.ts` (`buildVoiceAnchors`, `sceneVoiceAnchors`), not a captions.ts export. The draft's drift guards were declined in favor of the tolerant-read law ("misheard ASR degrades to the estimator, it never corrupts the schedule"). The shipped contract is the authority; the Part D draft is superseded on this point.

### G.3 — status of the drafts above (Parts A–F)

- **Part A (W5 sequence): EXECUTED by the repo** — commits `e6fafe6` and the W4/W3 companions follow the sequence's shape (pure planner first, policies before enforcement, one atomic demotion+proof commit) with these divergences from the draft: the residual-sway mechanism shipped as `directedBreath` (the "calibrated floor") plus the director's closing move, instead of the draft's `SWAY_FACTOR` parameter; the validator's legacy default-key **insertion was removed** (cameraless docs stay empty — an inserted key would have silently demoted the drift on every stored doc; the S68 dimension-aware-center pin moved to render time); and the draft's W5.5 "render+preview adopt the director" is the one commit-shaped item that did NOT land as written — the director remains a proven leaf (§G.2 finding 1).
- **Part C (asset-validate draft): EXECUTED** — the six checks landed with the same names (`checkTeleport` … `checkOrientation`), structural `{ id, d }` inputs as drafted, `AssetFinding` realizing the draft's `AssetCheckResult`, and both enforcement seams (`upload.ts` reject, `asset-store.ts` warn-and-exclude).
- **Part D (anchors draft): SUPERSEDED by a leaner shipped contract** (§G.2 finding 3). `scheduleScene(scene, durationMs, geometry, anchors?)` landed EXACTLY as drafted; `PlanBeatsOptions.anchors?` and `beatSceneEvents(..., anchors?)` likewise.
- **Part E (K1 sequence): STILL VALID AND PENDING** — re-verified: no `characters/` rig modules; `classifySentence` is **still not exported** from `beat-plan.ts` (the K1.2 prerequisite seam stands, now re-confirmed at `37796ce`); `LivelinessChannel` unchanged.
- **Part F (graphics/types.ts draft): STILL VALID AND PENDING** — G1 unstarted. One update: the Stage-S aliases are now resolvable against the real `anim/` exports — import `EaseName` from `anim/easing.ts` (the real table matches the draft's curve list exactly) and use `ANIM_FRAME_BUDGET` (25_920) from `anim/clock.ts` as the shared wall the draft pinned as `GRAPHICS_FRAME_BUDGET`.

### G.4 — what actually gates G1 (the reconciliation with the audit's recommendation)

The audit's recommendation ("next development priority: G1") is directionally correct and matches the repo's own status (MASTER_PLAN: "G1 motion-graphics engine [is] the roadmap's next gate"). But the repo's own sequencing law is stricter than the audit's phrasing: **S120 §4 + §10 row 8 gate G1's start on the blind re-score clearing ≥4/5 with ≥3 human scorers**, and no rescore artifacts exist yet. The audit's own next-actions list already orders this correctly ("Complete independent blind quality reviews" before "Start G1 motion graphics"). The practical reading: **G1.0 (Stage S) is already green — the anim substrate landed with the W-track** — so G1.1 (the GraphicsDoc grammar, Part F) is the first *code* commit of G1, and it can start the moment the re-score gate clears or the operator explicitly waives it with the decision recorded. Everything else in Parts B/F stands unchanged at `37796ce`.

---

## How to use this document

1. **Sequence status (verified at `37796ce`):** the W-track is executed — W3→W4→W5→W6→W7 and Stage S all landed in the S120 order (Part G.1). What remains: the blind re-score (gates G1 per §10 row 8 — the §G.4 nuance), the `directCamera` adoption tail (§G.2 finding 1), and G1.1+ / K1 / C2-ext / R / X. **G1.0 (Stage S) is already green — the anim substrate landed;** G1.1 (Part F) is the first remaining code commit of G1. **K1 starts once G1.0–G1.4 have landed** (row 10 — the rig consumes the anchors [green], the anim substrate [green], and G1's frame discipline [pending]).
2. **Commit subjects** are final copy — use them verbatim (risk register row 8: the naming-confusion mitigation is that this vocabulary appears in stage docs AND commit subjects).
3. **The atomic rules that must not be softened:** W5.5 ships director + demotion + QC proof as one commit; G1.7 ships both mode ledgers in one commit; K1.6's rigDoc-absent path must stay byte-identical to HEAD (the master rollback for the whole stage).
4. **Signature drafts** (Parts C/D/F) are for the implementer's first pass — Part F re-declares the Stage-S easing/clock aliases only so it compiles standalone; the implementation imports them from `anim/`. The unit pins listed in S120 §13 (and the stage specs) are the source of truth for behavior.
5. **One prerequisite seam for K1:** `beat-plan.ts#classifySentence` is internal at `e387287` (verified); the K1.2 commit carries the export (one classifier, two consumers — the spec's law).

---

*Prepared 2026-11-13; re-verified 2026-11-14 at HEAD `37796ce` (Part G) after a fresh full clone — the W-track (W3–W7) and Stage S landed; G1/K1/C2-ext/R/X remain unstarted. No repository code is changed by this document.*
