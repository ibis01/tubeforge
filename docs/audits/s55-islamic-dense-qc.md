# S55 Islamic dense-frame QC — the L4 scan the timeline cannot slip through (T-55.4)

Recorded 2026-11-08 UTC · code commit `f3b98b5` · instrument
`scripts/s55-dense-qc-probe.mts` (local only, zero gateway spend) · raw
evidence `docs/audits/s55-dense-qc-data.json`.

## Mandate

The owner-approved S55 chain tasks T-55.4 with: "Denser temporal frame
inspection + restricted-face detection on final-render frames; sparse
8-frame sampling cannot guarantee a brief violation between frames is
caught (the audit's core safety point)." This note records the mechanism,
the measured evidence, and the honest margins that remain.

## The gap, quantified

The S49 L4 scan (`runRestrictedVisualScan`) sampled 8 frames evenly from
the rendered `final.mp4` — one VLM call, batch-local frame numbers. The
mean gap between judged frames by duration:

| duration | S49 judged gap | a 1.5s restricted-figure flash… |
|---|---|---|
| 20s | 2.50s | ~40% chance to fall entirely between samples |
| 60s | 7.50s | ~80% chance |
| 300s | 37.50s | ~96% chance |

A "pass" from that scan certified the 8 frames it saw, not the video —
while the check's label promised "verified visually before export". That
is the audit's core safety point, and L5's blocking gate cannot repair a
layer that never looked.

## The mechanism (three stages, fail-closed at every seam)

`runRestrictedVisualScan` — same exported signature, both call sites
(post-render + QC re-run) ride as-is:

1. **Dense grid** (`planDenseGrid`): one frame per 0.50s (2 fps), capped
   at 240 frames; longer videos coarsen the interval honestly (300s →
   1.25s, 600s → 2.50s) and the check detail DISCLOSES the interval.
   Pure ffmpeg + disk — no AI spend.
2. **Face tripwire** (`runFaceTripwire`, python3 + OpenCV haar cascades,
   probed per scan): frontal + profile detection at ≥1.5% of frame area;
   hits force themselves + immediate temporal neighbors into the judge set
   (top 12 anchors by area, ≤36 seats). A missing detector (lean hosts,
   the Vercel deploy) DEGRADES resolution — noted as
   `tripwire unavailable (…)` in the detail — never the verdict: the VLM
   still measures every frame it is shown. Faces are a tripwire, not a
   verdict: anonymous people are allowed content (S49 doctrine); the VLM
   decides reverence.
3. **Batched VLM judge**: ≤48 frames in batches of 8 (the S49 attention
   law per call), labeled with GLOBAL frame numbers + timestamps the
   judge echoes back; temperature 0. The first failing batch
   SHORT-CIRCUITS (a fail already blocks export — more calls buy nothing
   the human can use). Any unreadable or crashed batch → the whole scan
   reports **unmeasured** (L5 holds export — the fail-closed law, never
   silently clean). Pass only when every batch measured clean.

The check detail now carries the honest coverage — e.g.
`grid 120 @0.50s · tripwire 3 hit(s) → 9 forced (cv2 4.13.0) · judged 48
≈1.25s apart · 6/6 batch(es)` — so a human reads the scan's actual
resolution, never a bare "pass". Spend: ≤6 VLM calls per Islamic render
(bounded, metered through `aiCall`; the spend gate untouched).

## The measured evidence (probe, zero gateway spend)

On a fresh 1080p 20s render (the §B stand-in lineage: testsrc2 + sine):

- **Stage 1**: 40 frames extracted in 1.19s; ~104KB mean per JPEG.
- **Stage 2 false-positive control**: cv2 4.13.0 available, 40 frames
  scanned in 1.21s, **0 hits** — testsrc2 carries no faces and the
  tripwire invents none.
- **Stage 2 positive control**: skimage's `astronaut` sample (a NASA
  portrait riding BSD-licensed sample data — a real face, no network
  fetch, no repo fixture) beside one solid frame: **exactly 1 hit, index
  0, areaFrac 0.0363** (2.4× the threshold) in 0.30s. The detection path
  is proven on a real face, not on a mock.
- **Stage 3 coverage** (the number that closes the audit):

| duration | S49 gap | S55 grid | S55 judged | batches | S55 judged gap |
|---|---|---|---|---|---|
| 20s | 2.50s | 40 @0.50s | 40 | 5 | 0.50s |
| 60s | 7.50s | 120 @0.50s | 48 | 6 | 1.25s |
| 120s | 15.00s | 240 @0.50s | 48 | 6 | 2.50s |
| 300s | 37.50s | 240 @1.25s | 48 | 6 | 6.25s |
| 600s | 75.00s | 240 @2.50s | 48 | 6 | 12.50s |

(With simulated face anchors the forced seats always keep their places —
`forcedSeatsKept: true` across the table.) The 60s class goes from a
7.50s judged gap to 1.25s — 6× denser judgment, on top of a 0.50s local
grid that feeds the tripwire.

Unit pins: `planDenseGrid` (interval, cap coarsening, degenerate
durations), `selectVlmFrames` (forced seats, exact-cap fill with
largest-gap top-up, determinism, flood/garbage safety),
`restrictedVerdictFromBatches` (first-fail-wins, unmeasured-beats-pass,
all-clean-is-the-only-pass), and the real-detector controls (solid frames
hit-free; a broken probe degrades to `unavailable`, never throws).
240 → 244 tests.

## The honest margins (on record, not hidden)

- **Haar sees FACES.** Silhouettes, light-bodies and figures-without-
  faces ride the even grid only — the documented backstop, same as S49's
  judge prompt covers them, now at 6× the temporal density.
- **Sub-interval flashes.** Below the grid interval (0.50s at ≤120s;
  coarser at the 240-frame cap) a violation can still slip between LOCAL
  grid frames; the coverage note states the interval so the limitation is
  visible per render.
- **The VLM end-to-end verdict is T-55.5's to run.** This probe spent
  zero gateway quota by design (the probe-hygiene law); the acceptance
  render exercises the full funnel — dense inspection, scene regeneration
  + i2v paths, violation-blocks-export, unmeasured-blocks-export — on
  real Islamic-history content.
- **Judge attention.** 8 frames per call stays the S49 law; density comes
  from batching, not from overloading single calls.

## Files

- `src/lib/tubeforge/restricted-subjects.ts` — the dense L4 (pure
  planners + tripwire bridge + batched judge); L1–L3, L5 untouched.
- `scripts/s55-dense-qc-probe.mts` — the evidence probe (versioned).
- `scripts/test-unit.mts` — the S55 T-55.4 suite section (+4).
- `docs/audits/s55-dense-qc-data.json` — the raw evidence (commit
  `f3b98b5`).
