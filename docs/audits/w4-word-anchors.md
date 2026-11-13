# W4 — word-aligned timing + handwritten text

**Status:** SLICE 1 LANDED (this commit) — the anchors seam, the spoken-window schedule, and the readability law. Slices 2–3 (the glyph-outline mode; the captions-lane ASR wiring) are specced in `docs/design/s120-2d-animation-roadmap.md` §3 W4 and are NOT claimed here.

## What landed in slice 1

**`timing.ts` — `WordAnchors` + `anchorEnvelope` + the spoken-window fill law.** `WordAnchor = { index, startMs, endMs }` (the word's position in the scene narration — the captions lane's contract), `WordAnchors = { byWord }`. `scheduleScene(scene, durationMs, geometry, anchors?)`: when the anchors are present AND sane, the draw span fills the SPOKEN window `[firstWord.startMs, lastWord.endMs]` — the strokes land on the words that introduce them and the hold extends to the scene clock's edge. Absent or degenerate anchors (empty spans, non-monotonic indexes, negative starts, an envelope past the clock) schedule exactly the nominal window, **byte-for-byte** — the hard pin, not a hope. Anchors are INPUTS, never a doc field: `storyboard.ts` never sees them (source-pinned).

**`beat-plan.ts` — the beat windows ride the spoken clock.** `planBeats` opts gain `anchors?`: when the anchor count matches the narration's word tokenization AND the derived windows march forward, each sentence's window IS its words' spoken span; a mismatch (misheard ASR, a paraphrased doc) degrades to the W2 word-proportional estimator byte-for-byte. `beatSceneEvents` grows the additive `anchors` parameter (last, optional — every existing caller unchanged) and feeds the anchors through BOTH the plan path and the fill-law fallback — one seam, the one-source law.

**`text-draw.ts` — `checkReadability` (the pixel wall).** Effective glyph height = asset text size × placement scale × camera zoom × (output width / scene-plane width), against `WB_TEXT_READABILITY_PX = 12`. A scale-0.4 placement of the 22px heart labels (8.8px) fails; the camera's zoom rescues it; a half-width export halves the pixels; an unregistered text id fails CLOSED with a reason. The W5 camera director consumes this as a framing policy; the glyph-outline mode (slice 2) obeys the same wall.

## Proof

- House suite **556 → 563** (the W4 slice-1 battery: envelope validation; byte-identity without anchors; the spoken-window schedule with exact numbers; aligned-anchor windows per sentence; count-mismatch byte-degradation; anchors through both `beatSceneEvents` paths; the readability wall incl. the spec's scale-0.4 pin; the compile-only source pin). tsc clean; eslint clean on touched files.
- **Pixel freeze:** the W1 harness 16:9 GATE GREEN against the COMMITTED baseline after the scheduler change — the no-anchor path renders byte-identical frames. (The committed baseline JSON stays frozen; the harness's local receipt overwrite reverted.)

## What is honestly NOT here yet

- **Slice 2 — the glyph-outline text mode** (one handwriting face → deterministic SVG path outlines; the wb-page reveal switch). The marker wipe remains the only text mode.
- **Slice 3 — the captions-lane wiring** (`detectSpeechRuns` + the ASR chunk-token alignment feeding real per-word anchors per scene WAV). The pure seam accepts anchors; nothing produces them in the render job yet, so production renders still ride the estimator (byte-identical to HEAD by the pin).

## Rollback

Stop passing anchors → the engine renders exactly as HEAD (the parameter is optional end-to-end). `text-draw.ts` is a new leaf nothing imports yet — delete to revert.
