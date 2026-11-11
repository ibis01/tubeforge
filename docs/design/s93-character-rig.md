# S93 — Character animation engine v1 (design)

**Status:** v1 implemented — the rig motion source (`character-rig.ts`, 4
pins), the compositor wiring (bottom of the seniority ladder, parity-
gated), the real-artifact smoke (`scripts/s93-rig-smoke.mts`, 10/10,
2026-11-11), unit 468/468. Spec source: the S76 adoption decision §3
Phase 3 ("rigged character animation") + the §6 acceptance row ("Rig,
motion, continuity, export tests — Reusable engine contract") + the
governing rule §8. The S76 §5 P5 deferral ("until the Universal Timeline
is stable") is MET: the timeline contract closed at S87 with the §4.C
battery.

**The question it answers:** "Do cast scenes have to sit frozen under a
generic camera?" They don't: the rig gives portrait-backed cast scenes a
measured, in-character life — the breath cycle — while every executor
downstream stays shared.

## 0. The laws

1. **A motion SOURCE, not a pipeline.** The rig emits `MotionScenePlan`s —
   the existing zoompan engine's OWN plan vocabulary — for eligible
   scenes. It introduces no renderer, no clock, no assembly, no QC path:
   the frame-quantized shot allocation (sceneFilterGraph), the QC
   battery, the critic and the timeline contract are consumed unchanged.
   The governing rule (no isolated pipeline) holds by construction.
2. **The seniority ladder is untouched.** Director per-shot plan (M2) >
   studio motion overrides (Stage 5 D) > studio camera keyframes (S2
   wave 2, the last word) > **the rig** > the auto plan. The rig only
   replaces the auto plan for scenes nothing senior claimed. No cast /
   no portrait → the rig loop never runs → plans untouched, the legacy
   path byte-identical (the parity law).
3. **The stillness contract is senior to the rig itself**: motion mode
   off / intensity below the floor → the rig emits a HOLD plan (the
   existing hold law's ambient drift), never movement.
4. **The continuity law**: the rig moves CAST scenes only
   (hostInScene on a video with a portrait-backed character) — the
   identity-locked art the VCE anchors (S77–S83). Moving an identity
   anchor's framing risks exactly the drift the VCE judges, so the rig's
   amplitudes are deliberately below the kenburns defaults
   (RIG_AMP_MAX 3% vs the 12% smart default — "a whisper, never a punch").
5. **Honest motion on a still**: a still portrait cannot blink or
   lip-sync, and the rig will not fake it. The v1 vocabulary is the
   breath cycle — alternating gentle push-in/pull-back on the face band
   (RIG_HEAD_FOCAL 0.5/0.35), at the resting breath rate (2.2s beats,
   modulated ±12% by the approved plan's pacing hints — module E's own
   factor, one truth). The pose sheet (S83) and the i2v lane (S35) remain
   the paths to real motion; the rig is the measured layer between them.

## 1. The wiring

- `character-rig.ts` (pure): `rigPlan({sceneIndex, durationSec,
  intensity, motionMode, pacingHint})` → the breath-cycle plan; the
  amplitude clamps `intensity × 0.25` into [1%, 3%]; the beat count
  covers the scene (≥1 in/out pair); `rigEligible(video, character,
  sceneHostInScene)` is the ONE eligibility law the callers read.
- `render.ts`: the rig overlay sits after the Stage-5 override block and
  before the S2 camera-keyframe block; the module-E `getApprovedAudioMap`
  read is hoisted above it (ONE read — the rig's breath rate and the
  voiceover's pacing consume the same map).
- `video-jobs.ts`: the render job reads the cast character's hasPortrait
  and passes `character: { hasPortrait }` — the rig's only input beyond
  the scene itself.

## 2. The proof

- **Unit (4 pins)**: the eligibility matrix (portrait-backed cast scenes
  only; non-host scenes keep their motion), the breath cycle (beat
  alternation, the face-band focal, zero travel, the exact 1.03/1.0
  endpoints at 12% intensity), the clamps (4% → the 1% floor, 30% still
  caps at 3%) + the stillness contract (motion off / intensity 0 → a
  hold plan, labeled why), the pacing modulation (fast breathes quicker
  at 2.2/1.12, slow deeper at 2.2/0.88).
- **The smoke (10/10, real render)**: the rig's emitted filter graph
  DIFFERS from the auto plan's graph (the rig actually replaced it); the
  3% amplitude and one-zoompan-per-beat are visible in the graph; a real
  renderVideo with `character` set lands (5.23s, exact, audio present);
  the rig-off render lands through the untouched legacy plumbing.

## 3. Recorded tails

1. **The S74 paired-motion battery as the quality instrument** — rig
   renders join the paired re-measure when that loop resumes (the rig's
   motion budget is deliberately tiny; measuring it blind would say so).
2. **Rig modulation ON planned shots** — v1 yields to the Director's
   per-shot plan entirely; a breath-modulation layer on planned shots
   (intensity bias, not replacement) is the natural v2.
3. **Pose-driven beats** — the pose sheet's anchor rows could drive beat
   timing (gesture on beat changes) — the contract already carries
   per-beat shots.
4. **A per-video rig toggle** — Settings-level; v1 ships always-on for
   eligible scenes (the parity law makes off-by-default unnecessary).
