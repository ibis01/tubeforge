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

---

# T-55.3 — the fixes, evidence-directed (landed 2026-11-08, commit `1d79f99`)

The owner picked option (ii) for the statics. Both fixes landed with the
forensics above as their map; the verification run below is the acceptance.

## (a) cut-alignment — the contract now books the shot graph

- `motion.ts`: the fitted allocation is extracted VERBATIM into
  `allocateShotFrames`; `shotGraphJoins` walks the SAME accumulator the xfade
  chain uses, so the boundary marks can never drift from the rendered graph
  (pinned by a unit test that cross-checks the marks against the graph's own
  `xfade offset` string).
- `render.ts`: `buildSegment.onShotJoins` records the joins that ACTUALLY
  executed per scene (i2v/stock/slides scenes carry none — their channels have
  no intra-scene flips); `renderVideo` merges them via
  `expectedCutsForTimeline(durations, boundary, shotJoinMarks)`.
- `render-qc.ts`: the joins ride the expectation as WINDOWS on the blended
  clock (scene i's local 0 sits at `offsets[i-1]` — the stitcher's own math).

**One deviation from the staged design, on record.** The sketch said
"hard-concat flips as `cuts`". The verification run itself proves why that
would have failed: this plan's five fitted flips (2.70 / 6.57 / 8.34 / 11.09 /
12.84 s) produced only TWO detections at the lens's 0.40 threshold (6.57,
11.10) — the other three sit between 0.20 and 0.40, the same class as the
13.25 s flip measured in the forensics. Booked as cuts, three would read
"missing" and the lens would keep failing on faithful renders. Booked as
windows, the flips keep the excuse side (no more "unexpected") without
fabricating must-appear obligations the detector cannot see. Scene seams keep
the must-appear side (a swallowed scene still flags); stray cuts anywhere
else still flag.

## (b) frozen/static — owner option (ii), the minimal ambient drift

`STATIC_AMBIENT_DRIFT = 0.03` (exported, pinned by tests). A DECLARED static
shot executes z 1.00→1.03 across its span — focal-anchored, standard eased
progress (`movementForKind` splits the two cases; `shotZoompan`'s hold branch
honors `zEnd > zStart`). The user's stillness contract (intensity < 1) keeps
the TRUE hold with the byte-identical constant-zoom graph. The real-ffmpeg
unit test pins the differential: the drifted static renders
freezedetect-clean at n=0.004:d=1.00 while the TRUE hold still flags — the
law keeps its teeth.

## (c) the verification run — both failures read PASS on a real MP4

Instrument: `scripts/s55-render-forensics.mts` (the §B anchor VERBATIM —
same Nova anchor, scenes, profile, render params; fresh independent plan),
run at gateway pool 247/300. Evidence:
`docs/audits/s55-fix-verification-data.json` (commit `1d79f99`) +
`/tmp/s55-verify/final.mp4`.

- **Plan (fresh, independent): 8 shots / 3 scenes, INCLUDING two declared
  statics** — scene 1 #0 `hold` 2.8 s, scene 3 #0 `hold` 2.5 s. The drift
  path was exercised on real anchor content, not just fixtures.
- Render: 14.634 s · 1080p · 4,051,470 bytes · 198 s wall.
- **frozen-frames: PASS** — freezedetect n=0.004:d=1.00 finds **0 runs**
  (the forensics measured 1–3 runs on the same anchor). The d=0.50
  calibration view shows ONE 0.63 s run at the very head (the opening ease
  plateau + scene fade-in) — under the lens's 1.00 s floor, recorded here as
  the honest margin, not hidden. Motion profile: p10 0.20 luma units (the
  forensics' holds sat at ≈ 0.00), p50 1.32, p90 5.36.
- **cut-alignment: PASS** — 0 unexpected, 0 missing. Seven booked windows
  (2 scene-seam blends + 5 intra-scene flips); both 0.40-threshold detections
  (6.57, 11.10) land inside flip windows; all five flips visible at the 0.20
  view sit within ±0.03 s of the booked marks.
- The other 12 structural checks all green: −16.0 LUFS · TP −14.4 dBTP ·
  LRA 1.5 LU · tail-fade −91.0 dB · no black frames / dead air / flicker /
  stutter · static-shots "visual change throughout".
- NOT run in this verification (the instrument's structural focus — gateway
  budget discipline): the two S53 visual lenses. Both were green in §B
  (subject-continuity 90/100 vs the 70 floor; text-artifacts clean) and are
  untouched by a 3 % creep plus a booking change; T-55.6's human kit
  re-renders anchors per profile regardless.

## Known limitation, on record

The QC RE-RUN path rebuilds its expectation from the timeline doc — scene
seams only, no shot joins (the joins are render-time state, not persisted).
Same lossiness class as that path's unstored blackWindows (its own comment
says so). The render→QC contract — the path §B measures — carries the joins
end to end.
