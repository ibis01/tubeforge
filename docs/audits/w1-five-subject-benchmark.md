# The five-subject whiteboard benchmark — the benchmark-stage fill receipt

**Date:** 2026-11-19 · **Branch work:** the P0 plan's fourth Next Action (the
five-subject suite fill) + P5 production profiles · **Receipts:**
`validation/w1/subjects/` + `validation/w1/traced/` (local, gitignored — the
535c90e law: dated receipts never shadow the frozen baseline in
`docs/baselines/`).

## What landed

1. **The five-subject suite FILLED** (`benchmark-scenarios.ts`): all four
   placeholder slots now carry authored five-scene sets (title / process
   diagram / comparison / handwritten phrase / conclusion — the frozen W1
   TYPES, subject-scoped ids `eng-*`, `isl-*`, `biz-*`, `edu-*`), the same
   per-kind durations (38.0 s per subject), the same two design spaces, the
   same fit math. Science rides the frozen W1 set unchanged (project-hash
   pins in `scripts/test-whiteboard-profiles.mts` §7).
2. **The I.8 lane as data**: the islamic-history set is authored on OBJECTS
   ONLY — `ISLAMIC_SUBJECT_ASSET_ALLOWLIST` enforces it at build time (an
   out-of-allowlist placement is a build error), the narrations pass
   `scanRestrictedSubjects(…, "islamic-history")` clean, and the battery
   pins both. No figures, no faces — the slot's policy id rides the
   manifest exactly as P0-7 wired it.
3. **P5 production profiles** (`whiteboard/profiles.ts`): the five recipes
   (Classic Whiteboard / Storytelling / Mathematical & Scientific /
   Technical & Engineering / Modern Motion) as a PURE configuration layer
   over the knobs the pipeline already reads — hand {style, scale, side},
   sfxOn, scene paper (the existing two-color union — no new grammar),
   board defaults. `applyWhiteboardProfile` bakes them (authored choices
   are never overwritten; the report says what changed); the validator
   treats an unknown profile id as an ERROR; the native + LLM scaffolds
   take `profileId`; the Studio gains a selector; regeneration preserves
   the profile.
4. **The before/after pair**: `w1-whiteboard-benchmark.mts --traced` renders
   the P0 raster-to-stroke seed (the committed line-art fixture traced at
   run time through the SAME `traceRasterToStrokes` the upload gates ride)
   — the "after" half against the "before" (the frozen W1 library run).
   The runner also gained `--subject <id>` so every subject renders through
   the SAME lenses (samples, seams, QC, determinism-grade gates).

## Gate receipts (this sandbox, 2026-11-19)

| Run | Frames (decoded / expected) | Wall | QC | Gate |
| --- | --- | --- | --- | --- |
| science (frozen W1 baseline) | committed baseline 2026-11-13 | — | pass | GREEN (pinned hashes re-verified) |
| traced seed (16:9) | 204 / 204 | 18.6 s | all checks pass | GREEN |
| engineering (16:9) | 912 / 912 | 81.4 s | all checks pass | GREEN |
| islamic-history (16:9) | 912 / 912 | — | all checks pass | GREEN |
| business (16:9) | 912 / 912 | — | all checks pass | GREEN |
| general-education (16:9) | 912 / 912 | — | all checks pass | GREEN |

Trace receipt for the traced seed: 24 strokes / 40 commands / quality
"icon" / 98 ms — matching the P0 commit's live proof (24/64 on the 10 KB
fixture upload path; the benchmark fixture traces 40 expanded commands).

The batteries: `npm run test:whiteboard-profiles` (22 pins — applier
purity/additivity, authored-override survival, validator errors, scaffold
passthrough, subject determinism + in-canvas, I.8 allowlist + narration
scan, W1 freeze hashes) joined the CI check chain as its own step.

## Reproduce

```bash
node --import tsx scripts/w1-whiteboard-benchmark.mts --subject engineering --no-repeat --no-blind
node --import tsx scripts/w1-whiteboard-benchmark.mts --traced --no-repeat --no-blind
node --import tsx scripts/w1-whiteboard-benchmark.mts            # the frozen W1 baseline (all aspects + determinism pin)
```
