# Milestone 0 — Director / Shot-Engine Audit (Baseline Record)

**Date:** 2026-11-02 · **Baseline commit:** `d7816e3` (`main`, in sync with origin)
**Purpose:** Before any Director upgrade — prove what the existing Director's
approved decisions actually control in the rendered video. This is the
frozen baseline the Milestone 1–2 spec (`docs/director-m1-m2-spec.md`) builds on.

---

## 1. Baseline verification

| Check | Result |
|---|---|
| Working copy vs `origin/main` | identical (`d7816e3`), working tree clean, zero untracked files |
| Local-only changes | none — the ZIP-staleness warning is moot; the sandbox IS the latest source |
| Typecheck | pass |
| Lint | pass (warnings only, pre-existing) |
| Unit + regression suite | **97 passed, 0 failed** |
| Billing suite | **36 passed, 0 failed** |
| Full log | `docs/baselines/m0-check-2026-11-02.txt` |

CI parity: GitHub Actions run #5 on `d7816e3` = success; Vercel deployment on
`d7816e3` = success (first green since the postinstall fix).

---

## 2. The render reality (what actually happens today)

One image per scene. One Ken Burns movement plan per scene. Cuts happen only
at scene boundaries (transitions). **There is no intra-scene cutting in the
live render path.**

```
story.ts paintScene()          one AI image per scene
  └─ getApprovedAddendum()         shot[0].framing/lens/composition + scene.mood
  └─ getApprovedAppearanceClause() outfit/accessory from CharacterAppearance
  └─ getApprovedWorldClause()      locations/props from the org library
motion.ts planSceneMovements() one movement plan per scene (mode from
  └─ getApprovedMotionMap()        scene-level motion: zoom|pan|off|smart)
render.ts                       scene segment = image × movement plan × duration
qc.ts                           pacing gate via planStaticRuns() + measured scans
video-jobs.ts                   audio: pacing → TTS speed, ambience beds,
                                sfx cues, musicMood, ducking
```

The Director's shot list describes a video that does not exist: a 15-second
scene with a 4-shot plan still renders as **one** image moving for 15 seconds.

## 3. Field → consumer map (every field, verdict included)

### 3.1 `DirectorPlan` (plan level)

| Field | Consumer(s) | Verdict |
|---|---|---|
| `version` | `parsePlan()` round-trip | used (v1 only; forward-compat hook) |
| `generatedAt` | informational | used (UI/log only) |
| `concept` | director-card display, Activity log | used (display only) |
| `musicMood` | `getApprovedAudioMap` → `video-jobs.ts` `resolveMusicForVideo()` | **used — reaches the mix** |
| `ducking` | `getApprovedAudioMap` → `video-jobs.ts` `resolveDuckingForVideo()` | **used — reaches the mix** |

### 3.2 `DirectorScene` (per scene)

| Field | Consumer(s) | Verdict |
|---|---|---|
| `sceneIndex` | every lookup key | used |
| `mood` | `directorImageAddendum()` → scene image prompt; `timeline.ts` `shot.mood`; `CharacterAppearance.mood` | **used — reaches the image prompt** |
| `transitionIn` | `planTransitionIn()` → `timeline.ts` per-scene transition (render consumes the assembled timeline) | **used — reaches the cut** |
| `motion` | `getApprovedMotionMap()` → `render.ts:905` overrides the Ken Burns mode per scene | **used — reaches the render** (but only 4 coarse values: smart/zoom/pan/off) |
| `needsI2V` | `director-card.tsx:229,244` **UI badge only** | **DEAD in the render path** — the user must manually switch render mode to "animated" |
| `useStock` | `director-card.tsx:230,247` **UI badge only** | **DEAD in the render path** — same, "stock" render mode is manual |
| `pacing` | `getApprovedAudioMap().pacing` → `generateSceneVoiceovers()` TTS speed (±12%) | **used — reaches the narration** |
| `ambience` | `getApprovedAudioMap().ambience` → `render.ts:927` synthesized beds | **used — reaches the mix** |
| `sfx` | `getApprovedAudioMap().sfx` → scene-boundary cues (add-only) | **used — reaches the mix** |
| `locations` | `getApprovedWorldClause()` → scene image prompt | **used — reaches the image prompt** |
| `props` | `getApprovedWorldClause()` → scene image prompt | **used — reaches the image prompt** |
| `outfit` | `runDirectorPass` upserts `CharacterAppearance` → `getApprovedAppearanceClause()` → image prompt | **used — reaches the image prompt** |
| `accessory` | same path as `outfit` | **used — reaches the image prompt** |
| `shots` | see 3.3 — only aggregate/first-shot consumers | **partial** |

### 3.3 `DirectorShot` (per shot) — the heart of the gap

| Field | Consumer(s) | Verdict |
|---|---|---|
| `shotIndex` | ordering (`parsePlan` sort) | used (ordering only) |
| `framing` | **shot[0] only** — `directorImageAddendum()` → scene image prompt; `timeline.ts` `TimelineShot` | **PARTIAL — shots 1..N never render** |
| `camera` | `planStaticRuns()` QC pacing gate (all shots, `=== "static"` test only); `timeline.ts` shot[0] display | **PARTIAL — never moves a pixel; only feeds a QC verdict** |
| `lens` | **shot[0] only** — `directorImageAddendum()` (skipped when `"35mm"`) | **PARTIAL — shots 1..N dead** |
| `composition` | **shot[0] only** — `directorImageAddendum()` (skipped when `"rule of thirds"`) | **PARTIAL — shots 1..N dead** |
| `duration` | **sum only** — `planSceneDuration()` → `timeline.ts` extend-only rule (`max(planDuration, narrationSec)`) | **PARTIAL — individual shot durations never shape the cut** |
| `imagePrompt` | produced by the LLM prompt spec, parsed, clamped to 400 chars, persisted, round-trips through every test fixture… | **DEAD — zero consumers in src/, scripts/, e2e/** |

### 3.4 The "shot engine" (`src/lib/tubeforge/shots.ts`)

| Export | Consumer(s) | Verdict |
|---|---|---|
| `planShots()`, `ensureShotImages()`, `shotImageFile()`, `PSEUDO_CROPS`, `SHOT_FRAMINGS`, `SHOT_CAMERAS`, `SHOT_MAX_SEC`… | **none — zero imports anywhere** | **THE ENTIRE MODULE IS DEAD CODE** |

`shots.ts` was built (Stage 5 era) to subdivide scenes into ≤3s shots with
per-shot images, its own framing rotation and camera rotation, plus a
pseudo-shot crop fallback — and was never wired into `render.ts`. The
`shots:` arrays inside `render.ts`/`motion.ts` are motion.ts's *movement
segments* (`{kind:"hold", zStart, zEnd, focal, travel}`), a different concept
that shares only the word "shot".

## 4. External-analysis claims — verified

| # | Claim (from the roadmap) | Verdict | Evidence |
|---|---|---|---|
| 1 | `runDirectorPass()` rejects non-`story` formats | ✅ confirmed | `director.ts:137-138`; API route repeats it at `route.ts:59-61` |
| 2 | System prompt assumes a faceless-YouTube studio style | ✅ confirmed | `director.ts:90` ("AI Director of a faceless YouTube video studio") |
| 3 | `DirectorShot.imagePrompt` has no consumer | ✅ confirmed | repo-wide grep: produced + persisted + tested, never read |
| 4 | `directorImageAddendum()` uses only the first shot's framing/lens/composition | ✅ confirmed | `director-plan.ts:235` (`const first = s.shots[0]`) |
| 5 | `getApprovedMotionMap()` uses scene-level motion, not per-shot camera | ✅ confirmed | `director-plan.ts:470-474` maps `scene.motion` only |
| 6 | `shots.ts` generates its own prompts/camera sequence → two competing sources | ⚠️ **understated** | true of the code, but `shots.ts` is **dead** — never imported. There are not two competing engines; there is ONE live engine (one image + one movement per scene) and one unwired engine |

## 5. Findings the external analysis missed

1. **`shots.ts` is 100% dead code** (see 3.4). This is bigger than "the two
   systems are not fully connected" — the connection was never made, and the
   module's 3-second-shot design (the retention fix from the external review)
   silently never shipped. Wiring it in is not a refactor of a live path; it
   is activating a dormant one. That *lowers* M2's risk: today's render path
   cannot regress, because none of it changes until the plan exists.
2. **`needsI2V` and `useStock` are UI badges only.** The Director "suggests"
   animating a scene or using stock, the badge shows in the approval card,
   and nothing in the render ever acts on it. Either the plan should drive
   per-scene source selection (M2 scope decision) or the fields should be
   documented as advisory.
3. **`camera` does have one all-shots consumer** — the QC pacing gate
   (`planStaticRuns`), i.e. the Director is *graded* on per-shot camera
   choices that never reach the render. The gate can fail a video for "flat
   pacing" that the render itself created by ignoring the plan's movement.
4. **The duration contract is already half-built and sane**: `timeline.ts`
   allows a plan to EXTEND a scene beyond its narration share but never
   shorten it (Battle Yamuk guard). M2's shot-level reconciliation should
   inherit exactly this rule at the scene level.

## 6. Frozen behavior record (what M2 must not break)

- No plan / proposed / dismissed plan → render is bit-identical to today
  (single image per scene, even-split pseudo behavior absent, motion from
  video-level settings). `getApproved*` accessors all no-op on
  `directorState !== "approved"` — the approval gate is already airtight.
- Plan audio direction (pacing/ambience/sfx/musicMood/ducking) — live and
  tested; M2 does not touch it.
- Continuity VLM check — live; M2 does not touch it.
- QC pacing gate — live; M2 must keep `planStaticRuns` semantics (it becomes
  *more* meaningful once shots actually render).
- The one-image-per-scene path is the fallback for every failure: image-gen
  failure, missing plan scenes, pseudo-shot crops. M2 keeps that floor.

**Bottom line:** the audit *sharpens* the roadmap's central recommendation.
The Director's scene-level decisions (mood, transition, motion mode, pacing,
ambience, sfx, outfit, world) genuinely steer production. Its **shot-level**
decisions — the part that makes a director a director — steer nothing. M2 is
not an upgrade of a working system; it is the completion of a half-built one.
