# Milestone 1–2 Implementation Specification — The Unified Director→Shot-Engine Contract

**Status:** DESIGN — no production code written yet (per the M0 rule: prove
control before features). Baseline: `docs/director-audit-m0.md` @ `d7816e3`.
**Companion rule (from the roadmap review):** *no new Director features until
the existing Director's approved decisions are actually controlling the
rendered video.*

---

## 0. Sequencing decision (read first)

The external roadmap numbers the milestones M1 (profiles) → M2 (shot control),
but its own closing rule demands the opposite implementation order: M1 adds
creative *features*, M2 proves *control*. We implement **M2 first**, then M1.
Rationale:

1. M2 activates dead code (`shots.ts`) — today's render path cannot regress,
   because none of it changes until an approved plan exists.
2. M1's profiles multiply the inputs to a contract that doesn't exist yet;
   building profiles first means validating 7 formats against a renderer that
   ignores half the plan.
3. The user's quality complaints (jumping video, dead-pan stretches, shots
   that don't match the narration) are M2 problems, not M1 problems.

---

## 1. Milestone 2 — the shot-execution contract

### 1.1 Goal

An **approved** `DirectorScene.shots[]` becomes the authoritative shot list of
the rendered scene: per-shot image, per-shot camera movement, per-shot
duration. Everything else keeps today's behavior, bit-for-bit.

### 1.2 The contract type (new, pure, in `shots.ts` — the module it revives)

```ts
/** The execution-time projection of one DirectorShot — what the renderer
 *  actually runs. Built ONLY from an approved plan + measured narration. */
export interface ShotExecution {
  shotIndex: number;          // from DirectorShot
  source: "scene" | "extra" | "pseudo";
  //  scene  = shot 0, the existing scene image (director addendum already in prompt)
  //  extra  = AI-generated image from THIS shot's plan fields
  //  pseudo = crop window over the scene image (fallback when generation fails)
  imageFile: string;          // shotImageFile(sceneIndex, k)
  crop?: { w: number; h: number; x: number; y: number };  // pseudo only
  moveKind: MoveKind;         // CAMERA_MOVES → motion.ts vocabulary (§1.5)
  sec: number;                // reconciled duration (§1.4)
  prompt?: string;            // extra only — §1.6 assembly
}

export interface SceneShotPlan {
  sceneIndex: number;
  available: ShotExecution[]; // ordered, sums ≈ scene duration
}
```

Builder signature (pure, unit-testable, no DB):

```ts
export function buildSceneShots(input: {
  scene: Scene;                       // narration, visual, mood
  planScene: DirectorScene | null;    // null → fallback behavior
  measuredSec: number;                // narration/timeline duration for the scene
}): SceneShotPlan;
```

### 1.3 Data flow (render job)

```
render.ts (per scene, AFTER paintScene, BEFORE motion planning):
  plan = getApprovedShotPlan(videoId)            // ONE read, new accessor
                                                    (mirrors getApprovedMotionMap;
                                                     null unless approved)
  shots = buildSceneShots({scene, planScene, measuredSec})
  ensureShotImages(shots)                        // AI-generates "extra" images,
                                                    marks failures → "pseudo"
  per shot: motion.ts movement plan via moveKind  // planSceneMovements stays
                                                    the engine — Director picks
                                                    the move, motion.ts executes
  sceneFilterGraph(...)                          // §1.7 — N images instead of
                                                    split=1 image
```

`getApprovedMotionMap`'s per-scene override (render.ts:904-921) becomes
**derived**: when a plan supplies shots, the scene-level `motion` field only
fills gaps (shots without a mappable camera). It is NOT removed — it stays the
override for plan-less scenes.

### 1.4 Duration reconciliation (inherits the Battle Yamuk rule)

Scene level — unchanged: `planDuration` may extend beyond the narration share,
never shorten it (`timeline.ts:174-176` keeps its exact semantics).

Shot level — new, scale-to-fit: the scene's **measured** duration (voiceover
WAV or timeline override) is distributed across the plan's shots proportional
to their planned durations, preserving the Director's *relative* rhythm:

```
scale = measuredSec / sum(plannedDurations)      // only when sum < measuredSec
shot.sec = plannedDuration × scale               // extends to fill exactly
```

- `sum(planned) ≥ measuredSec` → planned durations pass through unchanged and
  the scene extends (today's extend-only rule).
- No plan / no shots → `planShots(dur)` even-split fallback (revives the
  existing function as the no-plan path — its rotation tables become
  gap-fillers only).
- Tolerance for the acceptance test: `|rendered scene duration − measuredSec| ≤
  0.2s` (one frame at 5s/scene granularity).

### 1.5 Camera-move mapping (one table, one authority)

`CAMERA_MOVES` (Director) → `MoveKind` (motion.ts) — motion.ts stays the ONLY
engine that computes zoompan math:

| Director camera | MoveKind | Note |
|---|---|---|
| `static` | `hold` | also feeds planStaticRuns exactly as today |
| `push-in` | `zoom-in` | |
| `pull-out` | `zoom-out` | |
| `pan-left` / `pan-right` | `pan-left` / `pan-right` | |
| `tilt-up` / `tilt-down` | `tilt-up` / `tilt-down` | |
| `dolly-in` | `zoom-in` | slower curve, larger scale (documented approximation) |
| `handheld` | `diag-tl` **or** `diag-br` | alternating; Ken Burns cannot shake — approximation documented |
| `crane-up` | `tilt-up` + `zoom-out` | combined move, new composite in the table only |
| `drone` | `diag-br` + `zoom-out` | aerial pull-back reveal |

Unknown value (parsePlan already snaps to `static`) → `hold`. The mapping lives
in `shots.ts` as a const table; motion.ts imports nothing new.

### 1.6 Prompt assembly for extra shot images (`source: "extra"`)

Today's `ensureShotImages` builds prompts from `scene.visual + framing
rotation + mood`. Under a plan, the prompt becomes:

```
{scene.visual}. {shot.imagePrompt}.
{shot.framing} shot, {shot.lens}, {shot.composition}.
{scene.mood}. {styleClause}. {appearanceClause} {worldClause}
{photoreal base prompt — the same boilerplate story.ts:606 uses}
```

- `imagePrompt` — the field's first-ever consumer — is the **lead** modifier.
- The continuity clauses (appearance/world) are reused verbatim from the
  story.ts accessors so cast/world consistency holds across shot images.
- No plan → the framing rotation table remains (fallback path unchanged).

### 1.7 Render change (the one real edit in render.ts)

`sceneFilterGraph` already concatenates movement segments per scene
(`split → trim → zoompan → concat`, motion.ts:807-861) — today over ONE image.
M2 adds a multi-image variant:

- `ShotExecution[]` with all `scene`/`pseudo` sources → today's single-input
  graph, pseudo crops applied pre-zoompan (PSEUDO_CROPS finally used).
- Any `extra` images → per-shot inputs `[k:v]` replace the `split`, each
  through its own zoompan, then the same `concat`. Same pattern the slides
  compositor already uses (single-frame zoompan per shot, no looped-image
  demuxer — render.ts:407's deadlock lesson is respected).

### 1.8 Fallback matrix (the contract's failure floor)

| Condition | Behavior |
|---|---|
| No plan / proposed / dismissed | **Bit-identical to today** (single image, video-level motion) |
| Plan scene missing / zero shots | `planShots()` even split over the scene image |
| Extra image generation fails (per shot) | that shot → `pseudo` crop + planned move; render continues |
| ALL extras fail | whole scene = pseudo crops (never a failed render) |
| Pseudo + scene image unusable | scene image hold (today's floor) |
| Unmeasured narration | estimate path (estimateNarrationSec) — unchanged |

### 1.9 `needsI2V` / `useStock` in M2 — advisory, deliberately

Per-scene source selection (i2v/stock switching inside one video) is a
pipeline-capability change, not a contract change. M2 keeps them as approval
UI badges and documents it; per-scene source adoption moves to M3/M4 scope.
(Flagged as an open decision in §4 if the user wants it sooner.)

### 1.10 M2 acceptance tests

| Test | Type | Passes when |
|---|---|---|
| `buildSceneShots` plan → shots | unit | one ShotExecution per DirectorShot, order preserved, prompt leads with imagePrompt |
| Duration reconciliation | unit | scale-to-fit exact fill; extend-only at scene level; no-plan path unchanged |
| Camera mapping table | unit | all 11 CAMERA_MOVES covered, unknown → hold |
| Pseudo fallback | unit | failed generation demotes to pseudo, never throws |
| Fallback floor | unit | no-plan output === a snapshot of today's behavior (golden test) |
| Render contract | integration (ffmpeg fixture) | 2-shot synthetic plan → output duration within 0.2s; frame-hash sampling shows ≥2 distinct visual segments; scene-boundary transitions still applied |
| Approval gate | e2e (`pipeline.spec.ts`) | proposed plan changes NOTHING in the render; approved plan changes shot count |
| QC gate | unit (existing) | `planStaticRuns` semantics unchanged — the audit's §5.3 inversion is closed: graded moves now actually render |
| Regression | full suite + CI | 97 unit + 36 billing + e2e green on `main` |

---

## 2. Milestone 1 — production profiles (universal Director)

### 2.1 Principle

No second plan format. `DirectorPlan` stays the one source of truth; a
**profile** is a prompt overlay + validation layer + default set applied
*around* the existing pass. Schema change is additive only:

```ts
export interface DirectorPlan {
  version: 1;            // stays 1 — parsePlan tolerates unknown fields by design
  profile?: string;      // NEW, optional: absent = "narrative" (legacy plans)
  ...
}
```

`parsePlan` gains one line (read optional `profile`, snap to the profile id
catalog, absent → undefined). Every legacy plan parses identically — verified
by the existing parse round-trip fixtures.

### 2.2 `production-profiles.ts` (new module)

```ts
export interface ProductionProfile {
  id: string;
  label: string;
  systemOverlay: string;        // appended to SYSTEM_PROMPT (structure, shot
                                // grammar, do/don't for the format)
  defaultTone: Partial<{        // profile defaults the LLM prompt falls back to
    transitionBias: string;     //   e.g. explainer → "cut" bias
    pacingBias: string;         //   e.g. advertisement → "fast"
    shotDensity: "sparse" | "normal" | "dense";
  }>;
  vocabularies?: {              // per-profile narrowing of the shared catalogs
    framings?: readonly string[];
    cameras?: readonly string[];
    transitions?: readonly string[];
  };
  validation: (plan: DirectorPlan) => string[];  // profile-specific checks,
                                                 // human-readable issues
}
```

Initial seven: `narrative` (today's story behavior — the compatibility
profile), `documentary`, `explainer`, `advertisement`, `animation`, `podcast`,
`social`.

### 2.3 `runDirectorPass` unblocking

- The `format !== "story"` throw (director.ts:137) and its API twin
  (route.ts:59-61) are replaced by a **format → profile** map with an explicit
  user override (request param). Unknown formats default to `narrative`.
- The "faceless YouTube studio" line moves INTO the narrative profile's
  overlay; the base prompt becomes format-neutral.
- Non-story formats still require scenes — the pass errors identically on an
  empty scene list (that check stays).

### 2.4 M1 acceptance tests

| Test | Passes when |
|---|---|
| Legacy plan parsing | all existing fixtures + a persisted-plan snapshot parse byte-identical (no `profile` field) |
| Profile overlay | prompt assembly includes the overlay; vocabularies narrow correctly |
| Validation | an advertisement plan without a product-forward shot 0 returns a readable issue |
| Story regression | narrative profile output ≡ today's output for the same seed input (golden prompt test) |
| Format gate | documentary/explainer formats accepted; empty-scene error unchanged |

---

## 3. Guardrails (both milestones)

- **Inspect before implementing** — M2 touches `render.ts` in exactly one
  place (§1.7); everything else is new pure code in `shots.ts` + one accessor
  in `director-plan.ts`.
- **One source of truth** — shot decisions come from the approved plan; the
  rotation tables remain only as the no-plan fallback.
- **Approval gate is untouched** — every new consumer reads through the same
  `directorState === "approved"` seam as the existing accessors.
- **No silent creative decisions** — the Director still never applies a plan
  itself; the approval card (which already shows shot counts, durations and
  flags) gains shot-level detail in a later milestone, not M2.
- **No unrelated feature work** — billing, voice, auth, storage untouched.

## 4. Open decisions for the owner (blocking M2 start)

1. **Confirm M2-first sequencing** (§0) — or insist on the roadmap's M1→M2
   order and accept validating profiles against a renderer that ignores shots.
2. **Per-shot image budget** — extra images cost AI credits. Default proposal:
   cap extras at `min(planShots − 1, 3)` per scene (MAX_SHOTS=7 stays the hard
   ceiling); configurable per video later.
3. **`needsI2V`/`useStock`** — keep advisory in M2 (recommended), or pull
   per-scene source selection into M2 scope (adds ~1 week + provider risk).

## 5. Definition of done (M2)

Every row of §1.10 green on CI, an approved 4-shot plan demonstrably producing
a 4-shot rendered scene (frame-hash evidence attached to the worklog), and the
97+36 baseline suites still green — then, and only then, M1 starts.
