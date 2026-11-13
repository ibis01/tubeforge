# W1 — Whiteboard Blind Rubric + Perceptual Baseline (2026-11-13)

**Status:** LANDED. The fixed benchmark (`scripts/w1-whiteboard-benchmark.mts`
+ the pure definition in `src/lib/tubeforge/whiteboard/benchmark-scenarios.ts`)
renders the SAME five scene types at the SAME three aspects every run; this
document is the human scoring instrument and the record of the FIRST baseline
scores — the honest "before" picture every W2+ stage must move.

**Definition freeze:** five scene types (title, process diagram, comparison,
handwritten key phrase, conclusion) on the library's own benchmark topic
("How Your Heart Works"), built-in assets only, marker hand, 24 fps, explicit
durations (7.5 + 8.5 + 8 + 7 + 7 = 38 s), house music bed (`curiosity-spark`,
audio-only — zero effect on frames), three aspects (1920×1080, 1080×1920,
1080×1080). Baseline receipt: `docs/baselines/w1-whiteboard-baseline-2026-11-13.json`
(determinism pin: two 16:9 renders, IDENTICAL raw-frame SHA-256s).

---

## 1. The scoring instrument

Nine dimensions, each scored 1–5 against the anchors below. The score is for
THE ENGINE AS SHIPPED (assets + planner defaults + timing law + camera
behavior on this benchmark), not for the benchmark authoring. Score the
videos, not the intention.

| Dimension | 1 (broken) | 3 (usable) | 5 (professional) |
| --- | --- | --- | --- |
| stroke-naturalness | Strokes pop or flicker; speed ignores stroke shape | Clean dash-reveals, constant speed, no flicker | Velocity personality: fast straights, eased curves, pressure-like width |
| semantic-order | Draw order fights the explanation | Order is neutral (placement order), never wrong | The axis precedes the bars precedes the trend line — order follows the story |
| narration-alignment | Visuals contradict the narration | Visuals are consistent; timing is uniform | The important visual lands ON the important phrase (word-anchored) |
| camera-readability | Camera breaks reading (zoom jitter, text off-frame) | Gentle drift, never harmful, never helpful | Intentional focus: zoom to the claim, stable writing windows, safe margins |
| hand-realism | Hand teleports visibly, wrong angle on strokes | Plausible single pose, follows strokes | Poses (write/draw/point), pen-up travel between strokes, occlusion rules |
| continuity | Every scene erases the board (hard reset) | Deliberate resets only where the story needs them | The board carries: keep/fade/erase/pan-away, chosen per scene |
| text-readability | Text missing or unreadable at output size | Large, readable, but wiped (not written) | Handwritten glyph outlines; readable at every aspect; pen rides the glyphs |
| audio | Missing or painful | Bed + VO mixed inside the loudness window | Pen/stop/transition SFX ducked under narration, ON where wanted |
| comprehension | The video does not teach | The video teaches with effort | The video teaches effortlessly; a stranger recalls the claim an hour later |

**Protocol.**
1. The harness emits the blind kit (`validation/w1/blind/`): codenamed MP4s
   (`WB-XXXXXXXX.mp4`) + per-scene-type frames (`WB-XXXXXXXX-P1..P5.jpg`, P1–P5
   in the frozen scene order). The code→aspect key stays OUT of the repo
   (gitignored `validation/`).
2. Score the MP4s first (motion is the product), frames second (stillness for
   the readability rows). Watch each video at least twice: once whole, once
   paused at each scene's hold.
3. Score every cell 1–5, whole numbers only; "N/A" is allowed ONLY for
   `audio` in the silent baseline lane.
4. A stage (W2+) moves a dimension only with: the same rubric, a NEW blind kit
   (new codenames, old + new artifacts shuffled together), and the per-dimension
   delta recorded in the stage's audit doc. Baseline hashes make the artifacts
   byte-comparable forever.

---

## 2. The W1 catch — the baseline's first proof of value

The first harness run found a P0 the QC battery cannot see: **every
`write_text` element was invisible in every rendered frame** (editor preview
and final MP4 alike). Root cause (wb-page.ts `APPLY_FRAME_FN`): the reveal
clip's `<rect>` was re-addressed through `getElementById(clipId)` on every
frame after its first — which returns the `<clipPath>` element, not the rect
— so the reveal width froze at the first frame's sliver. The unit contracts
pinned the frame-plan MATH, not the pixels; the Docker smoke curls APIs; no
gate ever LOOKED at a frame with text in it.

Receipt (16:9 sample dark-pixel ratios, before → after the one-line fix):
title 0.76% → 2.59% (the headline text), phrase 0.82% → 1.11% ("60-100 /
beats every minute"). The applier is the one-source law shared by the editor
preview and the renderer — both surfaces healed by the same fix. This is
exactly the class of defect W1 exists to catch: perceptual, silent, and
invisible to every automated lens the house runs.

---

## 3. Baseline scores — 2026-11-13 (the "before" picture)

**Scorer:** operator proxy (AI-assisted first pass over the 16:9/9:16/1:1
artifacts + the receipts), NON-blind for W1 — the scorer knows this is the
"before". From W2 onward the protocol's blind kit is mandatory (old vs new
shuffled). Re-score whenever a human operator takes over; the hashes make the
artifacts re-scoreable at any time.

| Dimension | Score | Evidence (the honest notes) |
| --- | --- | --- |
| stroke-naturalness | **3** | Reveals are clean; constant speed regardless of stroke shape; the fill law's uniform scale makes every stroke feel equally urgent. |
| semantic-order | **2** | Order = placement order × asset doc order. The process scene draws heart → lungs → arrows — acceptable — but nothing follows the NARRATION (the axis/bars/trend failure mode is one asset away). The W2 gap, exactly as the reconciliation predicted. |
| narration-alignment | **2** | Silent lane (narration text rides the doc). The fill law spreads work uniformly across the window; no word anchors exist. Scored against the narration text, not audio. |
| camera-readability | **3** | The Lissajous drift never breaks reading (text stayed legible in every sampled frame, all aspects) — and never HELPS: no focus, no zoom-to-claim, and on 9:16 the drifting window leaves compositions high with dead margins. The load-bearing anti-freeze device, doing its only job. |
| hand-realism | **2** | Active-stroke following + tangent rotation + entry ease-out all work (receipted in every frame). Single pose; the hand vanishes in gaps and reappears at the next placement (teleport-by-cut); no pen-up travel. |
| continuity | **1** | Measured at every seam: outgoing last frame carries 0.9–1.3% ink, incoming first frame is the clean board (0.16% dark = the resting hand). Four hard board-wipes in 38 seconds. The W6 gap, receipted. |
| text-readability | **3** | Post-fix: "How Your Heart Works" and "60-100 beats every minute" are large and readable at ALL three aspects (16:9 headline ≈ 90 px cap height). BUT the reveal is a left-to-right mask wipe, not handwriting, and the pen rides the char-count width model — visibly off the glyphs on long labels. The W4 gap. (Pre-fix this row was 1: text did not exist.) |
| audio | **N/A** | Silent baseline lane by definition (explicit durations, bed-only for the QC playable contract). Scored on the story lane; W7 adds whiteboard SFX events. |
| comprehension | **3** | The five scene types read clearly and the topic teaches with effort; thin ink (~1% dark pixels), no mid-scene color (reveal_color rides after the strokes), uniform urgency. The overall ceiling the plan attacks. |

**Baseline composite: 2.4 / 5** (audio excluded). The plan's target state is
≥ 4/5 blind (the release-gate table's "Blind review ≥ 4/5" row). The gap is
concentrated exactly where the reconciliation said it would be: semantic
order (W2), narration anchors (W4), camera direction (W5), board continuity
(W6), hand finishing (W7).

**What already works (do not regress):** the deterministic frame plan
(identical hashes across runs), progressive dash-reveals, the hand's
active-stroke follow, per-aspect compositions that never clip labels, and the
QC battery's green (13 pass + the documented cut-alignment unmeasured) on
every aspect.

---

## 4. Run book

```bash
node --import tsx scripts/w1-whiteboard-benchmark.mts                    # full: 3 aspects + determinism pin + blind kit
node --import tsx scripts/w1-whiteboard-benchmark.mts --aspects 16:9     # one aspect, fast iteration
node --import tsx scripts/w1-whiteboard-benchmark.mts --no-repeat --no-blind
```

Artifacts: `validation/w1/aspect-*/` (projects, finals, frames, qc.json —
gitignored), the blind kit under `validation/w1/blind/` (key local-only), the
committed receipt `docs/baselines/w1-whiteboard-baseline-<date>.json`. The
gate is HARD: duration/frames ±tolerance, no blank samples, seam law (outgoing
ink present, incoming stroke-free), zero QC fails, determinism pin identical
hashes. RED gate = no baseline lands.
