# S55 render forensics — the two §B failures, localized (T-55.1 + T-55.2)

Recorded 2026-11-08 UTC · anchor commit `77cad6f` · instrument
`scripts/s55-render-forensics.mts` (+ `scripts/s55-forensics-post.mts`) ·
raw evidence `docs/audits/s55-render-forensics-data.json`.

## Mandate

The S54 baseline's real-render matrix measured two failures on the anchor
render (14.6 s, 1080p, kenburns, 3 scenes): **frozen-frames** ("3 frozen
runs") and **cut-alignment** ("2 unexpected, 0 missing"). The owner audit's
S55 Priority 1 demands the WHY before any fix: "investigate why the renderer
produces frozen sections and why its actual cut positions differ from the
expected timeline." This note is that investigation. No production code was
touched.

## Method

Reproduce the §B anchor render VERBATIM (same Nova identity anchor, same
three scenes, same narrative profile, same render params — portrait →
director pass → approve → 3 paints → 4 s sine narration stand-ins → real
`renderVideo`), then measure the produced `final.mp4` at frame level:
freezedetect at the lens calibration (d=1.00) and at d=0.50, scene-change
detection at the lens threshold (0.40) and a near-miss view (0.20), a
per-frame pixel-difference profile, and the full QC battery; correlate
everything against the render's own timeline (segment lengths, blend
offsets, the fitted shot allocation `multiShotSceneGraph` executes).

The failures REPRODUCED on an independent plan (fresh LLM pass):

| lens | §B (2026-11-07) | forensic run 1 | forensic run 2 (evidence) |
|---|---|---|---|
| frozen-frames | fail — 3 runs | fail — 1 run | **fail — 2 runs** |
| cut-alignment | fail — 2 unexpected | fail — 3 unexpected | **fail — 3 unexpected** |
| other 14 checks | pass | pass | pass |

The count varies with the plan (the Director chooses the shots); the CLASSES
reproduce on every plan tried. Run 1 crashed after the battery on an
instrument bug (below) and its artifacts were torn down; run 2 completed and
its `final.mp4` + scene paints are preserved (session-scope, `/tmp/s55-evidence/`)
with everything essential carried in the data JSON.

## Root cause A — cut-alignment: the expectation never books intra-scene shot flips

`expectedCutsForTimeline` (render-qc.ts) books SCENE seams only: hard-cut
seams as `cuts`, blend seams as `windows`. But the anchor renders through
the M2 multi-shot path (`multiShotSceneGraph`): each scene executes the
Director's 2–3 shots joined by hard concats (or 0.4 s fades) INSIDE the
segment. Every one of those flips is a real content change in the pixels
with no expectation entry — so the faithful lens reads "unexpected".

This run's plan (7 shots / 3 scenes) and the measured correlation:

| detected cut (scene>0.40) | fitted flip time | Δ | verdict |
|---|---|---|---|
| 2.70 s | 2.70 s (scene 1: hold→zoom-in) | 0.00 s | intra-scene shot flip |
| 6.77 s | 6.78 s (scene 2: punch→pan-right) | 0.01 s | intra-scene shot flip |
| 11.73 s | 11.76 s (scene 3: hold→zoom-in) | 0.03 s | intra-scene shot flip |
| — (13.23 s @0.20 only) | 13.25 s (scene 3: zoom→diag-tl) | 0.02 s | 4th flip, under the 0.40 threshold |

**All three "unexpected" cuts are the render's own shot flips**, matched to
centisecond precision by the fitted allocation (`segSec × cum/sum` per
segment — `fitFrames` scales shot seconds proportionally; RAW cumulative
plan seconds are wrong by up to 1.2 s, which is why the flip column in the
raw run log initially read "unexplained" for 11.73 s). `missing` is empty
because both scene seams are 0.5 s fades — booked as windows, and the
detections inside them are correctly excused.

Nothing is misrendered. The LENS is right, the RENDER is right, the
EXPECTATION is incomplete: the shot graph's own boundaries (which
`multiShotSceneGraph` computes frame-exactly — `accLen` tracks every join)
never reach `ExpectedCuts`.

## Root cause B — frozen-frames: the Director's `static` shots, executed faithfully

freezedetect on the evidence file (n=0.004, the lens's noise floor):

| freeze | duration | where it lives |
|---|---|---|
| 0.00 – 2.70 s | 2.70 s | scene 1 shot #0 — Director camera **`static`**, planned 2.8 s, executed as the z=1 `hold` |
| 9.90 – 11.73 s | 1.83 s | scene 3 shot #0 — Director camera **`static`**, planned 3.5 s; head trimmed by the scene-2→3 blend (completes ≈9.9 s), tail ends exactly at the hold→zoom-in flip (11.73 s) |

Both frozen runs are the plan's own opening holds. `movementForKind`
executes `static`/`hold` as zStart=zEnd=1, travel 0 — a fully static window
by design; the motion-everywhere law (`frozen-frames`: no run ≥ 1.00 s)
then flags it. The d=0.50 calibration view finds the SAME two runs and
nothing else — there are no hidden sub-second freezes; the cos-ease plateaus
the calibration history worried about stay well under 1 s on this anchor.
The motion profile agrees: p10 ≈ 0.00 (the hold stretches) against p50 1.16
luma units elsewhere; `static-shots` (the sampled pass) passes because the
SHOTS change at every flip — "visual change throughout" at shot granularity.

This is a genuine vocabulary/law CONFLICT, not a defect in either side:
the Director's camera vocabulary legitimately contains `static`, and the QC
law legitimately demands motion everywhere. §B's "3 frozen runs" was the
same class on that day's plan (three static/low-motion shots).

## Instrument bugs found and fixed (recorded for honesty)

1. **freezedetect parse**: this ffmpeg build prints the three fields ONE
   PER LINE; the run's same-line regex silently ate every event (reported
   "0 runs" while the battery correctly said 2). Found by re-running
   freezedetect on the preserved artifact and diffing against the battery.
   Fixed in the instrument + the post-processor; the evidence JSON now
   carries the corrected parse and a `postProcessed` note.
2. **flip math**: raw cumulative plan seconds vs the fitted proportional
   allocation — corrected (raw kept as `flipTimesRaw`).

## Fix directions for T-55.3 (PROPOSED — none applied yet)

- **cut-alignment (unambiguous)**: extend the render→QC contract so
  `ExpectedCuts` carries the shot graph's own boundaries — hard-concat
  flips as `cuts`, fade hand-offs as `windows` (0.4 s, the
  `SHOT_FADE_SEC` span). `multiShotSceneGraph` already computes the frame
  budgets; `renderVideo` can surface them the same way it surfaces
  `expectedCuts` today. Lens unchanged; the anchor's four flips become
  booked, and the lens keeps catching REAL stray cuts.
- **frozen/static (a product decision, owner's call)**: three options —
  (i) forbid `static` cameras in multi-shot kenburns plans (prompt-side
  law + plan validation); (ii) execute declared static shots with a
  minimal ambient drift (e.g. z 1.00→1.03 across the shot: perceptually
  still, pixels move, the law stays bright) — RECOMMENDED, it preserves
  the Director's creative intent without exempting anything;
  (iii) exempt declared holds in the lens — weakest: it erodes the exact
  law that caught the real Battle-Yamuk-class defects.

## Evidence

- `docs/audits/s55-render-forensics-data.json` — plan (raw + parsed), shot
  tables, timeline, QC battery rows, freezes (d=1.00/0.50), scene cuts
  (0.40/0.20), motion-profile stats, correlations, corrections note.
- `/tmp/s55-evidence/final.mp4` + `scene-{1,2,3}.png` — the render and its
  paints (session-scope; the JSON carries everything durable).
