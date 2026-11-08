# S62 — Proving real video quality: the 8-profile i2v validation lane

Opened + executed 2026-11-08 UTC. Owner-directed ("s62"), executing the
2026-11-08 external audit's verdict: after five engineering stages, the
next milestone is **proven real video quality** — the audit's P1 items
being render/video-job coverage, validation of REAL image-to-video output,
and blind visual scoring across the production profiles.

## 1. The reconciliation the audit's wording missed

The audit said "all 7 production profiles". The catalog has been **eight**
since S49 (`islamic-history` joined; `PROFILE_IDS` and
`PRODUCTION_PROFILES` are pinned in lockstep by a module-load check). The
lane scores **all eight**:

`narrative · documentary · explainer · advertisement · animation · podcast · social · islamic-history`

## 2. What the lane does — every link real

`scripts/s62-i2v-validation.mts` runs, per profile, the production chain
end to end against the live gateway. Fixed inputs: two seeded script
scenes per profile, written to exercise that profile's signature
discipline. Everything after that is production code:

1. **Director pass** — `directorSystemPrompt(profile, policy)` +
   `buildDirectorUserPrompt` → `llmChat` (glm-4.6 hint, temp 0.6) →
   `parsePlan` inside `aiCallJson`'s retried validation with the same
   2/2-scene-coverage rule as `runDirectorPass`.
2. **Scene art** — shot 0's `imagePrompt` through the real image path
   (`imageGenerate`, 1344×768), sanitized under the plan's content policy
   exactly like shots.ts (L3, `appendNegative: true`).
3. **I2V** — the plan-aware motion prompt (`i2vMotionPrompt(scene,
   planScene)`), sanitized exactly like `ensureSceneClip`, drives real
   CogVideoX via `zaiVideoViaClient` with `ensureSceneClip`'s exact call
   shape: `duration 5 · fps 30 · size 1920x1080 · pollMs 10_000 ·
   maxPolls 60`, one retry, budget reservation through `aiCall`.
4. **QC** — ffprobe geometry + `runQcReport` on the raw clip + frames at
   1.0 / 2.5 / 4.0 s for the blind pass.

**The provider override, stated plainly.** A fresh sandbox DB ships the
video capability UNCONFIGURED (registry default → `fal`), while
production's `ensureSceneClip` hard-requires `zai` (it throws for any
other provider — the i2v path only speaks CogVideoX). The lane therefore
pins `{ provider: "zai", model: "" }` through `getCapability`'s override
parameter — the SAME mechanism the Settings → Test button uses. The lane
validates the shape production enforces.

**Raw-clip QC classification.** The `playable` check demands H.264 + AAC.
A raw CogVideoX clip is video-only by construction (audio enters at the
audiomix stage), so `playable:fail` on a RAW clip is a category mismatch,
not a defect. Binding lenses for this lane: black-frames, frozen-frames,
aspect, static-shots, flicker, stutter, dead-air. Audio-bearing checks
(loudness family, tail-fade) are unmeasured-by-design at this stage; the
assembled-video gates already run in the unit fixtures and E2E.

## 3. Blind scoring protocol (T-62.3)

- The 8 clips' frames enter a shuffled pool labeled A–H; the mapping key
  is written once and not consulted during scoring.
- **Blind pass** — generic quality dimensions only, 1–5 each with
  written justification: motion realism (no freeze/drag), artifact load,
  temporal coherence, visual composition, overall.
- **Unmasked pass** — per-profile conformance, checked against the
  profile's own doctrine: advertisement opens product-forward and closes
  CTA; social's hook is an attention pivot; islamic-history composes
  around, never on, revered figures (the hard policy lens — under the
  islamic-history content policy this is also enforced upstream by the
  S49 sanitizers); documentary favors grounded cameras + stock-ready
  framing; podcast stays intimate and calm.
- Scores land in `validation/s62/scores.json`; the distilled table lives
  in this record at close.

## 4. First probe — narrative (2026-11-08, GREEN)

| Stage | Result |
|---|---|
| Director pass (glm-4.6, narrative overlay) | 2 scenes / 10 shots — 15.0 s |
| Scene art (real t2i, 1344×768) | 136 KB — 31.5 s |
| CogVideoX i2v (real, 5 s 1080p) | 7.6 MB MP4 — 3.7 min |
| Raw-clip QC | black ✓ frozen ✓ aspect ✓ static ✓ flicker ✓ stutter ✓ dead-air ✓ · playable: raw-clip category mismatch (video-only, §2) · audio family: unmeasured-by-design |

## 5. Landing

Evidence binaries (plans, art, clips, frames, manifest) live in
`validation/s62/` — gitignored by size, referenced by path. The manifest
and this record are committed. Stage close rides the full gate set + CI
evidence by SHA, per the standing law.
