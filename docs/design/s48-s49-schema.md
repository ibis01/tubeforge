# S48 + S49 — joint schema design (Director v2 × content policy)

**Status:** approved working design for the Cinematic Video Quality Transformation sprints.
**Scope of this document:** the ONE schema decision both sprints share, so neither
sprints twice over `Video.shotList`. S48 = the 19-field cinematic Director.
S49 = Islamic visual protection (restricted subjects, system-level, verified).
S50–S54 build on these foundations and are out of scope here.

---

## 1. The schema decision (why one design doc)

- **S48 shot schema v2 lives in the `Video.shotList` JSON, not in new columns.**
  The plan is a versioned JSON document with a tolerant parser
  (`parsePlan` snaps every field); a relational re-shape would buy nothing the
  render pipeline reads and would cost a data migration over user plans.
- **S49 needs exactly one DB column: `Video.contentPolicy`** (nullable string;
  `null`/absent = `"standard"`, i.e. today's behavior). It is the single
  enforcement switch the whole pipeline reads — script pass, director pass,
  image prompts, image-edit seeds, and the QC visual gate.
- **Therefore: one migration total** (`20261107000000_s48_s49_director_v2_content_policy`),
  owned by S49 (S48 ships zero DB changes). `shotList` is NEVER migrated:
  v1 plans parse and render exactly as before (§3).

## 2. S48 — the 19-field cinematic shot (schema v2)

### 2.1 The fields

| # | Field | Vocabulary / shape | Executes as |
|---|---|---|---|
| 1 | `shotIndex` | int, 0-based in scene | shot order (existing) |
| 2 | `framing` | `FRAMINGS` (7) | image-prompt clause (existing) |
| 3 | `camera` | **`CAMERA_MOVES` v2 — engine-verbatim (10, §2.2)** | motion.ts MoveKind, identity-mapped |
| 4 | `lens` | free text ("85mm f/1.8") | image-prompt clause (existing) |
| 5 | `composition` | `COMPOSITIONS` (7) | image-prompt clause (existing) |
| 6 | `duration` | 0.5–10 s, clamped | shot timing (existing) |
| 7 | `imagePrompt` | one sentence | extra-shot generation lead (existing) |
| 8 | `subject` | free text — who/what fills the frame | prompt lead + blocking anchor |
| 9 | `subjectAction` | free text — what they are doing | prompt clause + i2v/stock merit |
| 10 | `cameraHeight` | `eye-level · low-angle · high-angle · overhead · ground-level` | prompt clause |
| 11 | `angle` | `front · three-quarter · profile · back` | prompt clause |
| 12 | `depthOfField` | `deep · shallow · rack` | prompt clause |
| 13 | `lighting` | free text ("golden hour rim light") | prompt clause |
| 14 | `colorGrade` | free text ("teal-orange") | prompt clause; S51 continuity anchor |
| 15 | `focal` | `center · left · right · upper · lower · upper-left · upper-right · lower-left · lower-right` (motion.ts tokens) | zoompan focal anchor (per shot — replaces the scene-level heuristic when set) |
| 16 | `moveSpeed` | `slow · normal · fast` | Ken Burns intensity multiplier (0.7 / 1.0 / 1.35) |
| 17 | `transitionOut` | `cut · fade` | `cut` = today's hard cut (executes now); `fade` executes when S50 lands the per-shot xfade — the ONE deliberately deferred field, defaulting to `cut` so nothing waits on it |
| 18 | `purpose` | `establish · contextualize · detail · reaction · reveal · payoff` | approval-card badge; S53 QC hooks |
| 19 | `notes` | free text, ≤200 chars | human-review note only |

TS typing: the 12 new fields are **optional on the interface** (v1 plans,
hand-built fixtures, human edits) but **always filled by `parsePlan`** with
the documented defaults; the LLM-facing JSON schema demands all 19. The scene
and plan levels keep their existing fields; `version` becomes `1 | 2`
(provenance only — the in-memory shape is uniformly complete).

### 2.2 The camera vocabulary — verbatim, not approximated

v2 `CAMERA_MOVES` (what the Director may ask for) is **the engine's own move
set**: `static, zoom-in, zoom-out, pan-left, pan-right, tilt-up, tilt-down,
diag-tl, diag-br, punch-in`. `shots.ts CAMERA_TO_MOVE` gains identity rows for
every v2 id (`static→hold` and `punch-in→punch` are the only renames —
documented, 1:1, no creative loss). The pre-S48 verbs
(`push-in, pull-out, dolly-in, handheld, crane-up, drone`) stay parseable
through a **legacy table** marked v1-compat, so old plans render byte-identical
(approximations there are frozen history, not new requests). Cinematic
language that Ken Burns cannot honor (crane, drone, dolly, handheld, tracking)
moves to where it belongs: the prompt fields (`lens`, `cameraHeight`, `angle`,
`subjectAction`, `imagePrompt`) that steer the IMAGE models — and the i2v
prompt, which CAN honor it, for `needsI2V` scenes.

### 2.3 Model hardening (the S47 finding)

The platform default `glm-4.5-flash` failed the director narrative re-run 3/3
(S47 benchmark). The director pass now passes a **model hint** (`glm-4.6`)
through `llmChat(body, { modelHint })`: the hint applies ONLY when the
operator has not pinned an explicit chat model in Settings (operator choice
always wins); `resolveChatModel` is a pure, unit-tested resolver.

### 2.4 Compatibility contract (pinned by tests)

1. A v1 plan parses to a complete v2 shape with defaulted new fields; its
   `camera` values and rendered MoveKinds are unchanged.
2. `planStaticRuns`, pacing gate, audio map, appearance/world clauses — all
   v1 behaviors preserved (additive fields only).
3. `CAMERA_TO_MOVE` covers every v2 id (identity/renames) AND every legacy id.
4. The director user-prompt lists the v2 vocabulary (the one golden line that
   changes, updated deliberately).

## 3. S49 — Islamic visual protection (restricted subjects)

### 3.1 Doctrine

In `islamic-history` policy mode, TubeForge must NEVER paint a face (or
figure) of the restricted subjects — the Prophet Muhammad ﷺ first, plus the
Ten Promised Paradise, the Prophet's family, the Quranic prophets, the
angels, and God. Enforcement is **system-level and layered**: no single layer
is trusted alone, and the human keeps the existing approval/override gates.

### 3.2 The layers (each fail-visible; the QC gate is fail-closed)

| Layer | Where | What it does |
|---|---|---|
| L1 compose | story.ts script pass | policy rules appended to the VISUAL RULES: compose around restricted subjects (calligraphy, architecture, artifacts, light, landscape, POV) — never describe them on screen |
| L2 direct | director.ts pass | policy overlay in the system prompt; `imagePrompt`/`subject` naming a restricted figure is a BLOCKING advisory (activity feed) before approval |
| L3 paint | story.ts `generateSceneImage` + shots.ts `ensureShotImages` | last line before pixels: `sanitizePromptForPolicy` replaces any sentence naming a restricted figure with an alternative-composition clause and appends the hard negative clause; `ImageRequest.negativePrompt` rides providers that support one (ignored elsewhere — prompt clauses carry the weight for all) |
| L4 verify | restricted visual scan after full render | N frames sampled from final.mp4 (ffmpeg), VLM asked whether any frame presents a prophet/companion/angel/divine figure; emitted as QC check `restricted-visual` |
| L5 gate | qc-policy.ts | `restricted-visual` is severity **block** — a fail OR unmeasured result holds export/publish exactly like the other blocking checks; the existing audited human override remains the escape hatch |

`Video.contentPolicy` is set at create time (`POST /api/videos`, validated
snap) and read by every layer; the `islamic-history` production profile
(S52 UI picker) defaults the policy on, but the policy never derives from the
profile at runtime — the column is the one truth.

### 3.3 The registry (conservative default)

Matching is word-boundary, case-insensitive, on a curated alias list
(transliterations + honorifics + definite references like "the Prophet" —
safe because every Quranic prophet is itself restricted in this mode). The
asymmetric-risk rule governs false positives: over-matching costs a
substituted composition (visible, human-reviewable); under-matching costs
exactly the harm the policy exists to prevent. Depicting the mushaf, mosques,
calligraphy and anonymous distant crowds remains allowed.

## 4. What this design deliberately does NOT do

- No relational shot tables; no `shotList` rewrite of existing rows.
- No silent camera-verb rewriting of persisted v1 plans.
- No provider paid-tier activation (the Z.ai/free path is the only tested
  path, per the standing constraint).
- No QC threshold tuning or benchmark scoring (S53/S54 own those).
