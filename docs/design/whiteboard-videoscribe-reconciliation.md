# Whiteboard VideoScribe-Like Improvement — Stage 0 Reconciliation

**Status:** READ-ONLY reconciliation of the operator's improvement plan
("TubeForge Whiteboard Engine: VideoScribe-like improvement plan",
delivered 2026-11-13) against the live whiteboard engine at HEAD `276cd49`.
No product code was changed by this stage. This document is the plan's
§"Recommended implementation order" mapped onto the live tree: proposed
capability → existing code → precise gaps → file-by-file stage plan.

**Method.** Full reads of the engine's core (`timing.ts`, `storyboard.ts`,
`assets.ts`, `whiteboard-planner.ts`, `render.ts`, the routes, the e2e
contract) plus the S64–S75/S87 record set (design, audits, proofs). Every
claim carries a file reference.

**Prior state, for the record:** the engine is production-ready on its
CURRENT gates (S75 readiness report: 3-format E10 benchmarks, E12 ledger
closed, QC 13/14 + the documented cut-alignment exemption). The 2026-11-13
sandbox re-proof ran green both silent and narrated (scaffold → validate →
render → VO loudness in window). This track is perceptual-quality work on
a proven base — the plan's own "bottom line" says exactly this: a better
visual DIRECTOR on the current renderer, not a new renderer.

---

## 1. Verdict, in one paragraph

The plan's foundation claim is correct and the constraint it insists on
("do not replace the deterministic frame seam") is already the engine's
load-bearing law. Of the plan's eight weaknesses, one is already fully
built (progressive reveal + hand-follow + narration-ruled clock), two are
half-built with the right seam (asset stroke-splitting discipline exists
as convention, not validation; the LLM planner already returns the
project schema with native degradation), and five are genuinely missing:
semantic beat planning, word-aligned timing, a content-driven camera
director, continuous-canvas mode, and the finishing layer (hand poses,
pen-up travel, draw sounds). The reconciliation also found THREE
structural tensions the plan must resolve rather than paper over: (1) the
permanent camera drift exists SOLELY to defeat the house QC
frozen-frame/static lenses — a real camera director makes it a fallback,
but until then the drift is load-bearing and cannot simply be deleted;
(2) the S87 universal-timeline contract projects the frame plan onto
tracks — every new event type (beats, board-state exits, emphasis marks)
must project or the editor and preview diverge from the final render;
(3) scene-level revisions (S112–S118) cover `Video.scenes`, NOT
`Video.whiteboardProject` — the plan's "editable scene revisions"
differentiator currently rests on the doc-level advisory rev only.

## 2. Capability map — plan item → live code

| Plan item | Live code | Verdict |
| --- | --- | --- |
| Visible hand drawing strokes | `handAt` (timing.ts:253-339): follows the ACTIVE stroke, tangent rotation, entry ease-out, hidden in inter-stroke gaps (pen-lift mask) | **EXISTS** (single pose; no pen-up travel; no occlusion rules — W7) |
| Progressive stroke reveal | dash-offset draws, `frameAt` (timing.ts:345-374) + the applier (wb-page.ts `APPLY_FRAME_FN`) | **EXISTS** (benchmark-proven) |
| Semantic draw order | Draw order = placement `order` × asset document order (timing.ts:82-97); the scheduler length-weights, nothing semantic | **GAP** — W2's beat plan |
| Deterministic frame plan | `frameAt` pure of (project, assets, durations) — the S64 frozen law | **EXISTS** — the seam the plan builds on |
| Narration-ruled clock | `sceneDurationMs` (timing.ts:48-52): explicit > VO-measured (+350ms tail) > 2.6-wps estimate, clamp [4s,30s] | **EXISTS** (the plan keeps it as the hard clock — W4 adds anchors inside it) |
| Beat/semantic timing | The fill law (timing.ts:102-129): lead-in 400ms, hold 900ms, gaps 130ms, length-weighted, uniform scale to fill | **GAP** — W4; the fill law stays the fallback |
| Word timestamps | Captions lane: silence-aligned narration timing + ASR sync (captions.ts:17, :223, :402); `asrTranscribe` (providers/asr.ts:14) | **PARTIAL** — per-scene speech-run timing exists; per-WORD anchors are W4's build |
| Camera director | Keyframes + easeInOut + PERMANENT Lissajous drift `cameraDrift` (timing.ts:176-190) — an anti-freeze device, not a director | **GAP** — W5; see tension §8.1 |
| Continuous canvas | Every scene starts clean (background per scene); per-scene encodes + concat (render.ts:456-501) | **GAP** — W6 |
| Text rendering | SVG `<text>` + write-on via char-count model (`TEXT_CHARS_BY_ID`, MS_PER_CHAR 55, timing.ts:30, :94-95) | **PARTIAL** — wipe works; no handwritten glyph paths, no readability check — W4 |
| Asset stroke-authoring | Single-subpath law + semantic split (assets.ts:88-107, the S67 port notes) — enforced by CONVENTION only | **PARTIAL** — no pen groups, draw-order config, or authoring validator — W3 |
| LLM planner with fallback | `scaffoldWhiteboardProjectLlm` (llm-planner.ts): same schema, `plannerReport`, degrades to native | **EXISTS** — W2 extends the schema, the degradation law already holds |
| Sound design | Story-lane SFX system (sfx.ts: `SFX_KINDS`, `isSfxKind`) | **PARTIAL** — the machinery exists; no whiteboard pen/camera events — W7 |
| Editable revisions | Whiteboard doc: advisory `rev` + 409-with-current (whiteboard/route.ts:156-177) | **PARTIAL** — doc-level only; see tension §8.3 |
| QC/ship gates, provenance, cost | The full battery passes (S75); S113 artifacts, S117 manifest, S115 ceilings all ride the render lane | **EXISTS** — the plan's differentiators are already house law |

## 3. The plan's eight weaknesses, against reality

**1. Semantic drawing order — MISSING.** The native planner is a
keyword→tag rule table + placement grid (whiteboard-planner.ts:30-42);
the scheduler fills animations by length weight (timing.ts:102-129).
Nothing knows that the axis precedes the bars precedes the trend line
because the NARRATOR says so. The plan's `WhiteboardBeat` type lands
cleanly beside `AnimationEvent` (storyboard.ts:25-56) — it is a planning
layer that COMPILES to events, which is exactly how the editor already
treats explicit events (the precedence law, timing.ts:57-58: pre-existing
events are RESPECTED, the fill law only fills unclaimed work). The
compile target and the editor surface therefore agree by construction.

**2. Stroke-authored assets — convention, not validation.** The S67 port
split multi-M paths "semantic, not cosmetic" and recorded WHY (a mid-path
M teleports the hand — assets.ts:95-100), but nothing enforces it: a
future asset (or an upload) with a multi-subpath path renders with a
teleporting pen and no gate fires. The plan's authoring validator is the
missing enforcement; its checks (teleport, self-intersection, caps,
closed-shape direction, fill-after-outline) belong in a pure module both
`loadLibrary` and the S69 upload gate can call.

**3. Handwriting/text — approximation-grade.** Text reveals by char-count
width model (`widthUnits = chars * 11`, timing.ts:300-301) and rides the
pen along that approximation. W4's handwritten glyph outlines give exact
geometry — the pen ride improves for free. A readability check at final
output size does not exist anywhere (the plan's "text technically present
but unreadable because the camera is too far" is a live possibility at
scale 0.4 placements).

**4. Uniform timing — the fill law's honest limit.** The current law
scales raw durations so the LAST stroke ends at durationMs − 900ms
(timing.ts:116-119). The plan's target inverts this: the IMPORTANT visual
appears when the narrator says the important phrase. Word anchors have a
live source (the captions lane's speech-run timing + ASR); the beat
window sits between them; the fill law demotes to the no-anchors
fallback. `HOLD_END_MS`/`LEAD_IN_MS` stay as scene-level defaults.

**5. Camera director — the drift is load-bearing (tension §8.1).**
`cameraDrift` exists to keep every frame alive against the house QC
frozen-frames/static-shots lenses (timing.ts:176-183 — the receipts are
cited in-source). The plan's camera policies ("no drift during a critical
reveal") assume motion comes from the director. W5 must therefore ship
the director AND demote the drift to the no-director fallback in the same
stage, or QC regresses the moment drift is removed.

**6. Continuous canvas — the largest structural change.** Scenes are
isolated by design (fresh chromium context per scene — the S75 OOM
receipt, render.ts:314-323), encoded independently, then concat'd. Faking
continuity by concat is exactly what the plan forbids, and the frame plan
agrees: board state must be composed INTO each scene's frame state
(`FrameState` gains a carried-ink layer), with the per-scene context
recycling untouched — carried ink is data, not page residue.

**7. Hand/pen behavior — the strongest existing base.** Active-stroke
following, tangent rotation, entry ease-out, and gap masking are built
and receipted. Missing: pose variants, pen-up TRAVEL (today the hand
hides during gaps — the plan calls the vanish-and-reappear look
synthetic), occlusion/scale rules, left/right variants. All are
`handAt`-local changes that keep the pure-function law.

**8. Sound design — machinery exists, events don't.** The story lane's
SFX system (sfx.ts) has the kinds, the store, and the mix discipline;
whiteboard pen/stop/transition events are new rows on that system, mixed
under the existing loudness contract (render.ts already mixes VO + bed).

## 4. Release-gate table vs live protections

| Plan release gate | Live protection today |
| --- | --- |
| Intentional stroke order | NONE — W2's pins |
| Narration anchor tolerance | NONE — W4's pins (measure |beat window − speech run|) |
| No hand teleportation | Convention only — W3's validator formalizes |
| No clipped labels at any aspect | NONE — W5 readability pins (16:9 / 9:16 / 1:1 already render — E10) |
| Camera never makes text unreadable | NONE — W5 |
| Continuous-canvas preserves board state | N/A until W6 |
| Preview ≡ final frame plan | EXISTS — the one-source law (wb-page.ts shared by editor + render) |
| Loudness contract | EXISTS — `normalizeVoSlot` + the −16 LUFS window, receipted |
| Repeat renders, same frames | EXISTS — the S64 determinism law, pinned |
| Failed jobs keep prior artifact | EXISTS — the S45/S113 discipline |
| Blind review ≥ 4/5 | NONE — W1's rubric + benchmark harness |
| QC + ship gates green | EXISTS — 13/14 + documented exemption |

## 5. Data-model reconciliation

1. **`WhiteboardBeat` compiles; it does not persist as a rival grammar.**
   The beat plan is a PLANNING artifact: `beatPlan.ts` produces beats →
   compiles to `AnimationEvent[]` + `CameraEvent[]` (the doc's existing
   rows) → the editor keeps editing events, exactly as today. A
   `beats?: WhiteboardBeat[]` advisory field may ride the doc for
   round-tripping, but the RENDER contract stays events-only. This keeps
   S87's tracks projection, the studio's four-kind event editor
   (whiteboard-studio.tsx:205-250), and the fill-law precedence untouched.
2. **`BoardStatePolicy` extends `WhiteboardScene` additively**
   (storyboard.ts:68-81): `board?: { mode: "clean" | "continuous";
   carryPlacements?: string[]; exit?: "keep"|"fade"|"erase"|"pan-away";
   transitionMs?: number }`. V1 docs parse with `board` absent = clean —
   the additive parse law the schema already follows (`voFile`,
   `durationMs` precedents).
3. **Asset authoring metadata extends `WhiteboardAsset` additively**
   (assets.ts:16-22): `penGroups?`, `drawOrder?`, `role?`
   (outline/fill/label/arrow/emphasis), `durWeight?`, `framing?`,
   `alts?`, `a11y?`. The loader and the W3 validator consume them; the
   renderer's geometry map is unchanged.
4. **Word anchors are an INPUT to timing, not a doc field.** Anchors come
   from the VO lane at render time (ASR/silence-aligned, the captions
   source), passed like `voMsBySceneId` — the pure-function law holds
   (`scheduleScene` gains an optional anchors map; absent = today's fill
   law, byte-identical).
5. **No schema migration is required by W1–W5.** The whiteboard doc lives
   in `Video.whiteboardProject` (JSON). W6's board policy and W2's
   advisory beats ride the same column. Only if beat HISTORY is demanded
   does a column enter the discussion — it is not required by the plan.

## 6. Surface reconciliation

| Plan need | Reconciled surface |
| --- | --- |
| Benchmark + rubric harness | `scripts/w1-whiteboard-benchmark.mts` (the s67-e9a-proof pattern: scaffold → validate → render → receipts) + `docs/audits/w1-blind-rubric.md` |
| Beat planner (native) | `src/lib/tubeforge/whiteboard/beat-plan.ts` — pure, deterministic, sentence/punctuation/cue rules |
| Beat planner (LLM) | llm-planner.ts extends to emit beats in the SAME schema; degradation stays beat-by-beat to native |
| Asset authoring validator | `src/lib/tubeforge/whiteboard/asset-validate.ts` — wired into `loadLibrary` (warn-and-exclude) + the S69 upload gate (reject with readable errors) |
| Word anchors | timing.ts `scheduleScene(opts)` + the render job passing the captions lane's anchors; `estimateProjectFrames` unchanged (duration is still the hard clock) |
| Camera director | `src/lib/tubeforge/whiteboard/camera-director.ts` — focus rects from placement/text bounds → `CameraEvent[]`; `cameraDrift` demoted to the no-keys fallback |
| Continuous canvas | storyboard.ts `board` policy + `FrameState` carried-ink layer + composeScene accepting carried placements; render manifest (S117) records board state per scene |
| Sound events | sfx.ts kinds + whiteboard event rows; mixed under the existing bed/VO chain, OFF by default |

## 7. QA mapping

The plan's rubric dimensions (stroke naturalness, semantic order,
narration alignment, camera readability, hand realism, continuity, text
readability, audio, comprehension) are PERCEPTUAL — they cannot be
honestly automated. The house split applies: W1's benchmark renders the
SAME five scene types every iteration (deterministic inputs → comparable
artifacts), the rubric is scored by humans (the S55 human-evaluation-kit
pattern), and the AUTOMATABLE pins land as unit/battery rows: beat-plan
determinism, anchors-within-duration, validator rejections, camera
policies (speed/zoom/focus-rect minimums), carried-state equality,
preview≡final, per-aspect label-bounds checks. The blind-review gate is
evidence recorded in docs/audits, exactly like S54/S55's lanes.

## 8. Tensions and defects found by the reconciliation

1. **THE DRIFT TENSION (W5's hidden dependency).** `cameraDrift` is the
   only thing keeping thin-ink scenes past the frozen-frames/static-shots
   lenses (timing.ts:176-183, receipts in-source). The plan's camera
   policies read as if drift can simply be forbidden — it cannot, until
   the director's motion is real. W5 must ship director + drift-demotion
   together, with a QC run proving the no-drift path passes on the W1
   benchmark.
2. **THE CONTRACT TENSION (every new event type).** S87 froze the frame
   plan ↔ tracks projection (`whiteboardTracks`, tracks.ts). Beats,
   emphasis marks, board-state exits, and director camera moves must
   either project onto tracks or the studio's preview, the render status,
   and the assembly contract diverge. The compile-to-events decision
   (§5.1) is what resolves this — new layers compile INTO the frozen
   grammar; the grammar itself does not grow.
3. **THE REVISION TENSION.** The plan sells "editable scene revisions and
   rollback" as a differentiator, but S112–S118's `SceneRevision` covers
   the STORY doc (`Video.scenes`); the whiteboard doc's only history is
   the advisory `rev`. Decision point §10.2.
4. **Convention-only stroke discipline.** Multi-subpath paths teleport
   the hand today with no gate (§3.2). W3's validator closes it; until
   then the upload lane is the exposure (S69 accepts any sanitized SVG
   that rasterizes in budget).
5. **The text width approximation feeds the pen.** `handAt` rides the
   char-count model; a long label drifts the pen off the actual glyphs.
   W4's glyph outlines fix the ride; until then it is cosmetic, not
   correctness.

## 9. Stage plan (file-by-file)

Order follows the plan's W1→W7; the reconciliation sizes each stage but
moves nothing. Each stage lands with unit pins, full gates, and a
CI-green push (the house law).

**W1 — perceptual baseline** (exit: iterations are measurable)
- `scripts/w1-whiteboard-benchmark.mts`: five fixed scene types (title,
  process diagram, comparison, handwritten key phrase, conclusion), same
  narration + assets every run, renders all three aspects, drops
  receipts (frames, ink coverage, seam integrity).
- `docs/audits/w1-blind-rubric.md`: the 1–5 rubric, the scoring
  protocol, the baseline scores (scored BEFORE any W2+ work — the
  honest "before" picture).
- Pins: benchmark determinism (two runs, identical frame hashes).

**W2 — semantic beat compiler** (exit: draw order is semantic)
- `src/lib/tubeforge/whiteboard/beat-plan.ts`: the `WhiteboardBeat`
  type + native rules (sentence type, keywords, punctuation → purpose /
  action / emphasis / windows) + `compileBeats` →
  `AnimationEvent[]`.
- llm-planner.ts: emits beats in the same schema; beat-by-beat
  degradation to native.
- Pins: determinism; every beat has an action; referenced assets exist;
  windows fit inside the narration duration; fallback renders.

**W3 — stroke-authored assets + validator** (exit: the teleport law is
enforced)
- `asset-validate.ts`: teleport, self-intersection, cap/width
  consistency, closed-shape direction, fill-after-outline, orientation —
  wired into `loadLibrary` and the S69 upload gate.
- `assets.ts`: metadata fields (§5.3) + the professional starter pack
  (education/business/science/process priorities) with golden-frame
  renders per asset.
- Pins: each validator check fires on a crafted-bad fixture; every
  library asset passes its own validator.

**W4 — word-aligned timing + text** (exit: important visuals land on
important phrases)
- timing.ts: `scheduleScene(…, anchors?)` — beat windows from word
  anchors, emphasis after the spoken claim, final-idea hold; fill law
  stays the no-anchors fallback (byte-identical when anchors absent).
- The render job passes the captions lane's speech-run anchors.
- `whiteboard/text-draw.ts`: handwritten glyph-outline mode + marker
  label mode + fallback; readability check at output scale.
- Pins: anchor alignment tolerance; determinism both modes; readability
  threshold per aspect.

**W5 — camera director** (exit: motion is content-driven; drift demoted)
- `camera-director.ts`: focus rects from beat placement/text bounds →
  lead-in framing, eased travel, stable writing window, post-beat hold,
  safe margins; the policy set as pure checks.
- timing.ts: `cameraDrift` becomes the no-camera-keys fallback only.
- Pins: policy violations reject; QC green on the W1 benchmark without
  drift; per-aspect framing receipts.

**W6 — continuous canvas** (exit: scenes can carry the board)
- storyboard.ts: `board` policy (§5.2); validator rules.
- `FrameState` carried-ink layer + composeScene support; render.ts
  composes carried state per scene (context recycling untouched); the
  S117 render manifest records board state per scene.
- Pins: carried-state equality (frame N of scene K+1 contains scene K's
  carried ink); exit events (fade/erase/pan-away) deterministic;
  scene-card mode byte-identical to today.

**W7 — finishing layer** (exit: the polish pass)
- handAt: pose variants (write/draw/point/circle/rest), pen-up travel,
  smoothing, occlusion/scale rules, left/right variants.
- sfx.ts: whiteboard pen/stop/transition kinds, ducked under narration,
  OFF by default.
- Studio controls: beat order/timing/camera focus/board policy.
- Pins: no-teleport travel; sound mix inside the loudness contract;
  editor round-trips the new fields.

## 10. Decision points for the operator (before W2)

1. **Beat persistence** — compile-only (beats are planning artifacts,
   docs store events; recommended — zero grammar growth) vs persist
   `beats[]` on the doc for editor round-trip (bigger surface, better
   LLM re-edit UX)?
2. **Whiteboard revision history** — keep the doc-level advisory rev
   (recommended for this track; the plan's differentiator already holds
   via the story lane's S112–S118 for scene CONTENT) vs extend
   SceneRevision to whiteboard doc slices (a Stage-1-scale retrofit)?
3. **Handwritten text engine** — ship one handwriting font converted to
   outlines (recommended, deterministic) vs a font-picker surface?
4. **Sound design default** — OFF by default (recommended; the plan says
   so for formal content) vs per-project template default?

## 11. What will NOT be built (confirmed against the live tree)

No Remotion, no video-generation model, no second rendering pipeline
(the plan's own constraint, and the S64/S75 evidence chain's foundation).
No parallel timeline grammar — beats compile INTO the frozen event
grammar (§5.1). No replacement of the fill law — it demotes to fallback.
No new QC battery — the whiteboard lane keeps riding the unchanged
whole-file probes plus W-stage-scoped pins. The per-scene chromium
recycling and the frame budget wall are untouched by every stage.
