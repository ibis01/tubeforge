# S74 — Subject-motion vigor: the paired re-measure (S63's open item, adapted post-rebuild)

Opened 2026-11-10 UTC. This stage closes S63's standing open item — the
re-measurement of subject-motion vigor under the repaired laws (S63's
T-63.1 tempo law + T-63.2 doctrine-always-rides law, CI-verified on
`0c659b8` but never measured, blocked by a gateway outage that outlasted
the stage). S74 executes the measurement S63 named as its close condition.

## 0. Why a new stage, not S63 resumed

S63's resumption protocol (`scripts/s63-motion-vigor.mts --all`) required
reusing the S62 art and plans verbatim — the attribution design that made
the S62→S63 comparison a single-variable measurement. Between sessions the
sandbox was rebuilt, and the gitignored `validation/s62/` binaries (art
PNGs, plan JSONs, clips, frames) did not survive. What survived is
committed: the S62 manifest (per-profile shot, artPrompt, the exact
sanitized motionPrompt) and the S62 blind scores. The original protocol is
unrunnable as written.

S74 adapts the attribution design to what survived, with a STRONGER
control: a paired same-art measurement. The stage discipline (real clips +
blind scores, never a laws-only close) is unchanged.

## 1. The paired design (the documented deviation)

Per profile, the art is regenerated ONCE from the committed S62
`artPrompt` (the exact sanitized string fed to the image provider — the
manifest carries the post-sanitization bytes, including the islamic-history
negative-suffix append). Then TWO clips are rendered on that SAME art:

- **before** — the S62 `motionPrompt` verbatim (the old laws, exact bytes
  from the committed manifest — the pose-kill, the tempo collision, the
  run-on seam, all carried forward as the control).
- **after** — the S63-law prompt, reconstructed from the committed shot's
  `camera` / `moveSpeed` / `subjectAction` through `i2vMotionPrompt`.

Within each pair the ONLY variable is the motion prompt. The art sampling
noise (a regeneration is not byte-identical to the original) is held
constant WITHIN the pair — both clips share the one regeneration — so the
before/after delta is attributable to the prompt laws, not to art variance.
The S62 original scores stay as historical context (different art
sampling); the paired deltas are the stage's measurement.

The reconstruction law is unit-pinned: `i2vMotionPrompt` reads ONLY
`planScene.shots[0].{camera, moveSpeed, subjectAction}` from the plan
(S74 unit test 1), so the 3-field reconstruction from the committed manifest
yields the byte-identical prompt the lost `validation/s62/<id>.plan.json`
would have produced. The before/after prompt contracts are pinned against
the committed S62 manifest for all 8 profiles (S74 unit test 2): the kind
clause ALWAYS rides the after prompt; the S62 prompts carry no kind clause
(8/8 real plans — the pose-kill, verbatim); the subject ask gets a real
sentence boundary; the tempo collisions (social's "Quick, energetic slow
cinematic zoom in", islamic-history's "Slow, deliberate slow cinematic zoom
in") are gone from the after prompts and present verbatim in the before.

## 2. The scripts

- **`scripts/s74-paired-remeasure.mts`** — the paired lane. Per profile:
  regenerates art from the committed `artPrompt` (provider pinned to zai,
  same 1344×768 production shape S62 used), renders the before clip (S62
  prompt verbatim) and the after clip (S63-law prompt) on that one art,
  runs QC + frame grabs on both. Resumable per profile (healthy pairs are
  skipped unless `--force`). `--pace-ms=<n>` spaces every video submission
  by `<n>` ms — the gateway's shared 429 cool-down (the S62 receipt)
  punishes short-backoff retries, so the lane supervisor passes
  `--pace-ms=150000` (2.5 min between submissions).
- **`scripts/s74-blind-score.mts`** — the blind scorer, 16-slot pool
  (8 profiles × before/after). The S62 protocol verbatim, widened from
  A–H to A–P: three frames per clip (1.0 / 2.5 / 4.0 s), shuffled pool
  (seed 20261110; key withheld during scoring), one real vision call per
  letter with the SAME generic rubric. Resumable per letter (checkpoint
  after every letter — a mid-run 429 loses nothing). Post-unmask: the
  per-pair before/after table, the S63 falsification check (explainer /
  social / islamic-history motion_realism must rise without coherence or
  composition degrading), and the original S62 scores as historical context.
- **`scripts/tf_s74_lane.sh`** — paced supervisor: runs untried profiles
  first, throttle-burned retries last, 2.5-min pacing between submissions.
- **`scripts/tf_s74_catchup.sh`** — the catch-up pass for profiles that
  failed under throttle: 75 min of full gateway silence (the S63
  discipline — silence is the only thing that moves the window), then a
  rotating canary; max 3 cycles.
- **`scripts/s74-resume.sh`** — self-contained resume: probes first
  (cheap, no gateway cost if 429), runs the lane only when green.

## 3. The 2026-11-10 throttle (the S63 outage shape, recurring)

The pilot (social profile, naturally-spaced pair) went through clean —
the art landed, the before clip landed, the after clip landed. Then the
account entered a hard throttle window: every probe 429, account-wide
(video AND llm), identical shape to the S63 outage documented in
`docs/audits/s63-motion-vigor-record.md §5`. Patient backoffs (4 min, 5
min, 7 min) did not penetrate — consistent with S63's finding that
probing neither extends nor clears the window. The lane is resumable by
design; the supervisor and catch-up pass carry the S63 discipline forward.

## 4. What would falsify the repair (unchanged from S63 §3)

Motion realism NOT improving on the pose-killed / tempo-contradicted
profiles (explainer, social, islamic-history) while coherence or
composition degrade — that would mean the doctrine clause is noise and
the tempo law cosmetic, and the record would say so. The paired design
makes this check STRONGER: the before clip on the SAME art isolates the
prompt variable from art variance, so a null delta is a real null (not
art noise).

## 5. Stage status

**OPEN — code landed, measurement gateway-gated.** The scripts, unit
pins, and this record are committed. The local gate battery on the
commit: tsc 0 · eslint 0 (20 baseline warnings) · unit 345/345 · queue
PASS · billing 40/40 · build 0 · e2e 30/30. The measurement (8 paired
i2v renders + 16 blind vision calls) runs when the gateway window
clears, via the lane supervisor. The close commit lands only on real
clips + blind scores, per the stage law that took S62 from "assumed" to
"measured" — a laws-only close would repeat the sin S62's audit named.

Stage discipline: full local gate battery before any push; CI evidence by
SHA for the close; doctrine wording untouched (S63's T-63.1 / T-63.2
laws are unchanged — S74 measures them, does not revise them).
