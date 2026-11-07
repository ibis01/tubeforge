# S55 human cinematic evaluation kit (T-55.6)

Recorded 2026-11-08 UTC · harness `scripts/s55-eval-kit.mts` · manifest
`docs/baselines/s55-eval-kit-manifest.json` · anchors for review:
`uploads/s55-evalkit/<profile>.mp4` (regenerate with the harness below).

## Purpose and doctrine

The cinematic transformation (S47–S54) is measured by lenses; lenses measure
damage, not taste. This kit is the HUMAN half: per-profile anchor renders a
reviewer watches and scores against a rubric. **Scoring stays human** — the
harness produces anchors and a measured manifest, never a verdict. No
threshold in this kit is law until review rounds put it on record (the S54
doctrine: thresholds stated WITH evidence, marked for human review).

## The anchors (tier 1 — engine axes, available now)

One render per production profile (8), through the REAL production path
(`runDirectorPass` → approve → `runStoryboardJob` → `runRenderJob`,
kenburns, 1080p, 2 neutral scenes ≈ 9.9 s each), with the plan built FROM
THE LIVE PROFILE CATALOG: the profile's narrowed camera and framing
vocabularies cycled over the shots, its pacing bias, its transition bias,
and its shot-density bias (sparse 2 / normal 3 / dense 4 shots per scene).
The two scenes are the same for every profile — the controlled variable:
only the profile's direction changes.

What is REAL in an anchor: the engine — the M2 shot graph, the camera
vocabulary executing verbatim (the S48 law), pacing, transitions, AV sync,
the QC battery (every anchor passed all structural lenses; see the
manifest).

What is SYNTHETIC: the imagery (local stand-in paints, testsrc2 lineage;
zero gateway quota, zero paid dispatches — the T-55.5 disclosure applies).
Consequently the three IMAGERY axes of the rubric (lighting, composition on
content, scene relevance) are **tier 2** and score only on gateway-anchored
renders (below).

Regenerate / extend:

```bash
S55_KIT_PROFILES=narrative,documentary,explainer node --import tsx scripts/s55-eval-kit.mts
S55_KIT_PROFILES=advertisement,animation,podcast,social,islamic-history node --import tsx scripts/s55-eval-kit.mts
S55_KIT_LEG=report node --import tsx scripts/s55-eval-kit.mts   # manifest + review copies
```

Determinism note (from the manifest): profiles whose engine direction
coincides on this anchor content render byte-identical anchors (this round:
podcast and islamic-history — same cycled cameras, both sparse/slow/fade).
Their real differences live in the L2 overlay and the imagery tier. That is
a finding, not a flaw of the kit.

## The rubric — six axes, 1–5, anchored descriptors

Score each anchor per axis. 3 = "as intended for the profile"; 4–5 require
naming what exceeded intent; 1–2 require naming the defect (timecodes).

**1. Motion realism** (tier 1) — the S55 core.
- 5 Motion is continuous and motivated everywhere; no visible freeze, hitch
  or jump; static holds breathe (ambient drift) without reading as stuck.
- 4 As 5 with one moment that draws attention on close inspection.
- 3 Motion continuous; any stillness reads as a deliberate hold.
- 2 One visible freeze/stutter or an unmotivated still ≥ 1 s.
- 1 Multiple freezes, janky pans, or motion that reads broken.

**2. Camera movement** (tier 1) — the S48 verbatim law, felt.
- 5 Every move executes as directed, is legible, and FITS the profile's
  vocabulary (a documentary's grounded pans; an ad's punch-ins).
- 4 As 5 with one move that feels misjudged in strength or length.
- 3 Moves execute and are legible; none fights the content.
- 2 A move that visibly fails its verb (a "zoom" that reads as a jump), or
  vocabulary that fights the profile.
- 1 Moves are illegible, repetitive to distraction, or absent on a plan
  that asked for them.

**3. Lighting** (tier 2 — score only on gateway anchors).
- 5 Light is physically coherent per scene (direction, time of day),
  consistent across shots within a scene, graded to the profile's mood.
- 4 One shot's light drifts from the scene's coherence.
- 3 Coherent but flat; grading present but timid.
- 2 Visible incoherence across shots (midday → dusk in one scene).
- 1 Broken lighting (blown highlights, crushed blacks, wrong time of day).

**4. Composition** (tier 1 for framing/crop execution; tier 2 for content).
- 5 Framing executes the plan (wide/medium/close), focal anchors hold,
  horizon and subjects sit where the composition rule promised.
- 4 One shot composes loosely against its rule.
- 3 Framings correct; composition rules not legible on synthetic content.
- 2 A framing that contradicts its plan verb (a "close-up" that is wide).
- 1 Framings effectively random against the plan.

**5. Scene relevance** (tier 2 — score only on gateway anchors).
- 5 Every scene's imagery depicts its narration's moment; nothing
  off-world or off-story.
- 4 One shot's imagery is generic where the narration was specific.
- 3 Imagery plausibly adjacent to the narration.
- 2 A scene whose imagery contradicts or ignores its narration.
- 1 Imagery unrelated to the script.

**6. AV sync** (tier 1 — narration stand-ins are tones; sync = structure).
- 5 Scene boundaries land with the narration blocks; pacing feels as the
  profile intends (slow breathes, fast pushes); no dead air, no clipping.
- 4 One boundary a beat early/late.
- 3 Structure sound; pacing neutral.
- 2 A visible AV misalignment (scene changes mid-block or blocks overlap
  scene seams) or dead air ≥ 1 s.
- 1 Sync broken (scenes and narration drift apart).

## The protocol

1. Environment: full screen, sound on, no other motion on the screen;
   one anchor per sitting, in the manifest's random order (shuffle by
   timestamp), blind to which profile until after scoring (the anchor
   filenames carry the profile — have someone else rename, or use the
   manifest's sha map).
2. Score all tier-1 axes per anchor (1–5 each) + a one-line note for any
   axis scored ≤ 2 or ≥ 4 (timecodes for defects).
3. Record on the sheet (one row per anchor: six scores + notes), then
   compute: **anchor mean** and **minimum axis**.
4. Reading (advisory, until review rounds put law on record):
   mean ≥ 3.5 and no axis ≤ 2 → the profile's engine direction holds;
   any axis ≤ 2 → a defect finding with timecodes (feed the lens owners —
   the S55 pattern: forensics first, then fixes);
   mean < 3.5 → the profile's direction itself needs review.
5. Tier 2 (imagery axes): when gateway quota allows, re-render the same
   eight anchors with real CogView paints through the same harness
   (the S54 §A relaunch runbook's launch condition applies: probe the
   pool, don't race the reset), then score lighting / composition-on-
   content / scene relevance per this rubric, and re-score axes 1/2/6 on
   the real imagery (motion can read differently on photographic content).
6. The S54 pending item rides this kit: on the first gateway-anchored
   render, recheck the subject-continuity **70 floor** against the
   post-render judge (S54's calibration datapoint: 90/100 on the §B anchor
   vs 85/100 pre-render; the floor's fate is this review's to decide).

## What the kit is not

- Not an automated verdict: no score in this kit is produced by code.
- Not an imagery benchmark on tier-1 anchors: synthetic paints make
  lighting/relevance scoring meaningless there — do not score tier-2 axes
  on tier-1 anchors.
- Not a pass/fail gate: nothing in the product blocks on these scores;
  they inform the next calibration round (S54's thresholds-on-record
  doctrine).
