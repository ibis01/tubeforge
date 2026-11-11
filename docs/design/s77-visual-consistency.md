# S77 — Visual Consistency Engine — Phase A design contract

**Status:** Phase A designed and implemented (the deterministic core + the
VLM style layer + the orchestration wiring). Phase B slice 1 — the
dedicated APPEARANCE dimension — implemented in S78. The remaining
Phase B tail is listed, not built. Unit-pinned in
`scripts/test-unit.mts`; the VLM layers ride the budget choke point and
fail open.
**Scope of this document:** the engine's contract only — what a
"consistency score" IS in TubeForge, the data envelope it writes, the
job it runs under, and the laws it must never break. Implementation:
`src/lib/tubeforge/visual-consistency.ts`.
**Mandate:** S75 §0 (quality infrastructure before engine expansion) and
the S76 adoption decision §4.A (the design target) + §6 (acceptance:
cross-scene comparison detects seeded continuity defects) + §8 (every
engine consumes the shared contracts; no isolated pipeline).

---

## 0. Binding constraints

1. **One engine, the existing surfaces.** The engine UNIFIES the three
   disjoint judges that exist today — the per-image quality gate
   (0–10, `quality.ts`), the identity continuity pass (0–100,
   `director.ts`), and the post-render subject scan (`visual-qc.ts`)
   — behind ONE report envelope and ONE verdict vocabulary. It does
   not add a fourth judge.
2. **Propose, never auto-edit.** The engine scores and proposes
   repairs. Nothing regenerates without the human's one-click
   (the storyboard route's existing AI-edit / re-roll modes).
3. **Fail open, never invent.** If a VLM layer errors, its dimension
   is recorded `"unavailable"` with the error text — never a passing
   score, never a fabricated number (S76 §4.B's critical rule, adopted
   for consistency work too).
4. **Shared contracts only.** All model calls go through
   `aiCall` (budget metering, credit reservation, 429 cool-down);
   image bytes through the storage seam (`${videoId}/scene-NN.png`);
   execution under the job registry (new `"consistency"` kind, handler
   registered — resumability and cancel derive from the live registry).
5. **Zero generation-prompt changes in Phase A.** S74's paired
   re-measure renders from the current art prompts; the engine only
   READS painted art. Reconciling the photoreal-suffix contradiction
   in `artPromptRaw` is recorded as Phase B, after S74 closes.
6. **Backwards-compatible envelope.** A V1 `ContinuityReport`
   (identity-only) must still parse and render after this lands, and
   a V2 report must render in the existing director card without
   migration.

## 1. What exists (the fragments being unified)

| Fragment | File | Scale | Gap |
| --- | --- | --- | --- |
| Identity continuity pass | `director.ts` `runContinuityCheck` | 0–100 per host scene | style explicitly ignored; manual-only; result overwritten each run |
| Per-image quality gate | `quality.ts` `runQualityGate` | 0–10 per image | single-image; score not surfaced in any consistency view |
| Duplicate detection | `arthash.ts` | hamming ≤9 bits | near-duplicate only, in-memory, never persisted |
| Post-render subject scan | `visual-qc.ts` | floor 70, report severity | rendered video only, after the fact |
| Style signals | `Scene.style`, director `colorGrade` | free choice per scene | no video-level contract, no drift detection |

## 2. The engine's dimensions and verdict math

Per painted scene, up to three checked dimensions (Phase A: identity,
style; S78 adds appearance):

- **identity** — the EXISTING continuity pass, reused verbatim
  (`runContinuityCheck`): face/hair/age/build/clothing vs the
  character's references. Checked only for cast scenes
  (`hostInScene` + identity present).
- **appearance** (S78) — NEW dedicated pass keyed to the approved
  plan's `CharacterAppearance` rows: the depicted clothing and
  accessories versus the LOGGED outfit/accessory for that scene —
  judged against `buildAppearanceLook`'s clause, which mirrors
  `getApprovedAppearanceClause` exactly, so the judge scores the look
  the pipeline actually paints. Gates: plan `approved` + scene carries
  cast + a look actually logged (whitespace-only = not logged);
  unpainted scenes get no dimension row (the identity pass's own
  convention). One `aiCall("llm", "consistency appearance VLM", …)`
  per target scene — the look is text, so no reference images ride
  along. A missing/garbage score parses to NULL → the scene is
  `unavailable`; it is NEVER defaulted (the legacy pass's silent 50
  was a fabricated number — §0.3 forbids that here). An approved plan
  with cast scenes but zero logged looks reports
  `"appearance: approved plan has no logged looks to judge"` in
  `engine.unavailable` — a dark dimension says why.
- **style** — NEW cross-scene cohesion pass (Phase A): palette,
  rendering technique/medium, lighting language, line
  quality/realism level, grain. Batched (≤6 images per `llmVision`
  call, chunked in scene order), judged ACROSS the batch so drift is
  relative to the video's own look, not an absolute aesthetic.

Verdict vocabulary per dimension: `"consistent" | "drift" | "off" |
"unavailable"`, thresholds shared with the existing pass (≥80
consistent, ≥55 drift, else off — `scoreVerdict` semantics).

Scene-level unification (pure, pinned):

- `sceneScore` = **min** of the checked, non-unavailable dimension
  scores — the binding constraint is the honest single number;
  `null` when nothing was checked.
- scene `verdict` = **worst** dimension verdict (`off` < `drift` <
  `consistent`); `unavailable` dimensions are ignored unless every
  dimension is unavailable (then the scene is `"unavailable"`).
- `overall` = rounded mean of every checked, non-unavailable
  dimension score across scenes; `0` when nothing checked (V1
  parity — the card renders a number), with `checkedCount` exposing
  the honest zero to the UI.

## 3. The data envelope (V2 on `Video.consistency`)

Top-level V1 fields keep their names, shapes and semantics; new
fields are additive and optional:

| Field | Shape | Since | Notes |
| --- | --- | --- | --- |
| `checkedAt` | ISO string | V1 | unchanged |
| `overall` | number 0–100 | V1 | now spans ALL checked dimensions; 0 = nothing checked |
| `scenes[].sceneIndex` | number | V1 | unchanged |
| `scenes[].score` | number \| null | V1 (number) | now the scene min-across-dimensions; `null` = nothing checked |
| `scenes[].verdict` | verdict | V1 | now the worst dimension verdict |
| `scenes[].issues` | string[] | V1 | union of the dimensions' issues (identity first) |
| `schema` | `2` | V2 | absent in V1 rows — the version probe |
| `scenes[].dims` | `{ identity?, appearance?, style? }` per-dimension `{ score, verdict, issues }` | V2 | the raw per-dimension truth; `score`/`verdict` above are derived |
| `styleContract` | `{ styles, majority, outliers, colorGrade }` | V2 | deterministic layer (§4) |
| `proposals` | `{ sceneIndex, dimension, instruction }[]` | V2 | repair proposals (§6), capped at 8 |
| `history` | `{ at, overall, triggered }[]` | V2 | bounded ledger, newest last, cap 12 |
| `checkedCount` | number | V2 | dimensions actually checked (the honest-zero probe) |

`parseConsistency` (director.ts) parses both shapes unchanged — it
already validates only `scenes` being an array; the director card
reads the V1 fields and (Phase A card edit) the dimension chips.

## 4. The deterministic style contract (zero AI, pinned)

`deriveStyleContract(styles, colorGrade)` — input: each painted
scene's `Scene.style` id (`null` = "default" pipeline look, resolved
to `"default"`), plus the approved director plan's `colorGrade` when
the plan state is `approved`:

- `styles` — distinct ids in first-seen order;
- `majority` — the mode; ties break to first-seen;
- `outliers` — scene indexes whose style differs from the majority
  (a CONFIG drift: the operator picked a different style card —
  reported as an issue without spending a VLM call);
- `colorGrade` — passthrough for the repair prompt's wording.

The contract is descriptive, not enforceable: Phase A changes no
generation prompt (constraint §0.5).

## 5. The VLM layers

**Identity** — reused verbatim: the engine calls
`runContinuityCheck(videoId)` (which keeps its own Activity row and
column write), reads the result back, and lifts each scene's score
into the identity dimension. No second pass, no prompt fork.

**Style** — `runStylePass(videoId, sceneIndexes)`:
- `buildStyleBatches(indexes, max = 6)` — pure chunking, order kept;
- per batch, one `aiCall("llm", "consistency style VLM", …)` →
  `llmVision` with every batch image attached and labelled
  ("Scene N of this video's storyboard, in order");
- the system prompt judges ONLY style cohesion and demands STRICT
  JSON `{"scores":{"<sceneIndex>":<0-100>,…},"issues":{"<sceneIndex>":["…"]}}`
  (JSON keys are strings — the parser is pinned for exactly that);
- a scene missing from the reply is `unavailable` ("no verdict
  returned"), NOT a fail; malformed reply → whole batch
  `unavailable` with the parse error; thrown call → batch
  `unavailable` with `errorText`. Fail-open, never invented.

## 6. Repair proposals (propose-never-auto-edit)

`buildRepairProposals(scenes, styleContract)` — for every scene whose
unified verdict is `drift`/`off`, at most one proposal per dimension,
whole report capped at 8:

- **style** → `"Repaint this scene to match the video's dominant look (…majority…): <first style issue>. Keep the composition and subject."`
- **appearance** (S78) → `"Redress this scene to match the logged look: <first appearance issue>. Keep the pose, face and framing."`
- **identity** → the VLM's own first issue, passed through — the
  director card's Fix affordance already pre-fills the constraint
  box with it and the human edits before firing.

The proposals are TEXT on the report. Firing one is the existing
`POST /api/videos/[id]/storyboard` `{ scene, instruction }` flow —
no new regeneration path exists in this engine.

## 7. Orchestration and job wiring

- Job kind `"consistency"` (label "consistency check"), handler
  registered in `queue-handlers.ts` — resumability, boot recovery and
  cancel derive from the live registry (`handlerKinds()`), so no
  other list needs touching.
- **Auto-chain: full storyboard completion only.** After
  `runStoryboardJob` succeeds (≥2 painted scenes), the storyboard job
  enqueues the consistency check (`triggered: "storyboard"`).
- **Targeted re-check after repaints (S79).** A single-scene repaint
  (`runSceneJob`, edit or re-roll) makes every verdict that judged the
  OLD art obsolete for THAT scene — so it auto-enqueues the TARGETED
  re-check (`triggered: "repaint"`, payload `{ sceneIndex }`, fail-open
  enqueue; the manual full Check remains the fallback). The targeted
  check (`runTargetedRecheck`) re-judges ONLY that scene — identity via
  the continuity pass's dry single-scene mode (no column write, no
  Activity row of its own), appearance if a look is logged, style
  against `buildTargetBatch`'s window (target + nearest painted
  neighbours, cap 6, deterministic nearest-first with lower-index tie
  break) — and MERGES via `mergeTargetedRow`: every other scene's last
  full-check verdict stands untouched. A thrown sub-check replaces the
  stale verdict with "unavailable" (the old number judged art that no
  longer exists); no prior V2 report → the full engine runs instead;
  proposals and the ledger rebuild on the merged list; the style
  contract recomputes from config (zero AI). The payload rides the job
  row, so a RESUME re-lands targeted, not full.
- **Manual run** — `POST /api/videos/[id]/consistency` (202, job
  start); `GET` returns `{ consistency, generating, error }`. The
  director route's existing `action: "check"` now starts the
  consistency job (the unified check) instead of the identity-only
  continuity job; the `"continuity"` kind and handler remain for
  in-flight rows' resume.
- **The user setting (S80)** — `consistencyCheck` (`auto | manual | off`,
  default `auto`, a `UserSetting` row behind the settings allow-list):
  `auto` runs BOTH chains (storyboard full check, repaint targeted
  re-check); `manual` suppresses both chains, the Check button still
  works; `off` refuses even the manual POST (403 "Consistency checks
  are disabled in Settings"). The normalizer (`normalizeConsistency
  CheckMode`) falls junk/blank/legacy values to `auto` — a corrupt
  setting must never silently disable the quality system. The
  preference read is fail-open (a settings-store error also lands on
  `auto`). Settings → Pipeline Robustness exposes the control.
- Spend control: every call rides `aiCall` — pacing, concurrency
  caps, credit reservation (a `CreditBlockedError` surfaces as
  dimension `unavailable`, the pipeline never breaks), UsageRecord
  rows with the labels above.

## 8. Phase plan

**Phase A (implemented):** unified envelope + deterministic
style contract + batched VLM style pass + identity reuse + repair
proposals + history ledger + storyboard auto-chain + manual route +
director-card dimension chips.

**Phase B slice 1 (S78 — implemented):** the dedicated appearance
dimension keyed to the approved plan's `CharacterAppearance` rows —
target gates, the mirrored look clause, the per-scene VLM pass, the
third dimension in the verdict math/proposals/parser, the card's
appearance chip, eight unit pins.

**Phase B slice 2 (S79 — implemented):** the targeted single-scene
re-check after repaints — the continuity pass's dry `onlyScene` mode,
the `buildTargetBatch` neighbour window, `mergeTargetedRow`, the
repaint auto-chain with a scene payload (resume-safe), the full-engine
fallback when no prior report exists.

**Phase B slice 3 (S80 — implemented):** the `consistencyCheck` user
setting (`off|manual|auto`) — the settings allow-list entry, the pure
normalizer (junk → auto, never silently disabled), both auto-chains
gated to `auto`, the manual POST refused at `off`, the Settings →
Pipeline Robustness control.

**Phase B slice 4 (S81 — implemented):** shot-art lock coverage —
`ensureShotImages` now paints extra shots under the same identity locks
as scene art: `composeLockedShotPrompt` weaves the topic-world anchor,
the per-scene art style and the approved plan's continuity clauses
(logged outfit + set pieces) after the shot's own prompt (anchor-only
stays BYTE-IDENTICAL to the pre-S81 composition — an unlocked video
renders exactly as before); `readShotLocks` gathers the locks once per
scene, fail-open on every read; host scenes with a cast portrait seed
the shot through a portrait-anchored `imageEdit`
(`shotLikenessEditPrompt` — the scene-art likeness sentence re-aimed at
the shot), set-piece scenes without a portrait seed through the
location reference (`shotLocationEditPrompt`), cast likeness > set
piece (`pickShotEditSeed` — the scene-art priority law inherited);
every seed failure falls through to the fresh generation, then the
existing pseudo demotion — coverage never blocks the lane. All
metered via aiCall; no scene-art prompt touched (S74's frozen
measurement is insulated — it renders committed scene-art prompts
only). Six unit pins.

**Phase B slice 5 (S82 — implemented):** org-wide cross-video
character identity — `src/lib/tubeforge/character-identity.ts`. ONE
batched VLM call per run: the character's reference set (portrait + up
to 3 library refs, the same refs the per-video pass judges against)
plus the character's LATEST painted host-scene frame from each video
that casts them (`buildCrossVideoBatch`: newest-first, capped at
`CROSS_VIDEO_MAX = 6`, frame-less and beyond-cap videos reported
skipped with honest reasons). Clothing is DISCLAIMED (outfits
legitimately change between videos — the appearance dimension owns
them) and art style is disclaimed; only the PERSON is on trial
(`CROSS_VIDEO_SYSTEM`). `parseCrossVideoVerdict`: index-aligned, a
missing/non-numeric score stays null (never a fabricated 50), clamped,
issues capped. `crossVideoOverall`: min-across — the library is as
consistent as its worst video; honest zero. The report persists in the
character's storage namespace
(`characters/<id>/cross-video-identity.json`, `parseCrossVideoReport`
for the GET surface) and an Activity row lands. Surface:
`/api/characters/[id]/cross-video-identity` (GET stored report, POST
runs it as job kind "identity" — manual-only, no auto-chain ever fires
it; the consistencyCheck setting's "off" refuses it, S80's law
inherited). Propose-never-auto-edit: the report names drifting videos;
fixing them is each video's existing storyboard affordance.

**Phase B slice 6 (S83 — implemented):** pose-level identity rows —
the character's OWN reference library judged against itself. One extra
VLM call inside the same run/surface/report (no new route, no new kind
— the S77 grow-inside law): the portrait leads as the identity anchor,
then every existing pose-sheet image (`buildPoseTargets`: POSES
declaration order, capped 3) is judged — same person? same signature
outfit? (`POSE_IDENTITY_SYSTEM`: the sheet IS the reference library,
drift propagates into every scene painted from it; the pose itself,
gesture, expression, framing are disclaimed — they are supposed to
vary). Rows ride the report's additive `poses[]` (a pre-S83 report
parses with none — never invented); the reply shares the
index-aligned STRICT-JSON parser with the cross-video pass. Fail-open
throughout: no sheet / no portrait / unreadable bytes / a failed call
are honest `engine.unavailable` notes or per-row unavailable entries,
never fabricated scores. The Activity row gains "pose sheet N/M
consistent".

## 9. Acceptance mapping (S76 §4.A / §6)

| Required proof | Phase A answer |
| --- | --- |
| Same character across scenes stays consistent | identity dimension = the existing pass, now auto-run after storyboard |
| Same location does not randomly change | style dimension's cohesion judgement includes background world consistency via the batch framing (location refs feed prompts already); deeper location scoring is Phase B |
| Clothing persists unless the script requires it | identity pass judges "clothing vs the stated outfit"; the approved plan's appearance clause feeds prompts (pre-existing) |
| A deliberately inconsistent image is detected | style batch pass flags the outlier scene; deterministic config outliers flagged without AI |
| A failed check produces a repair proposal, not silent approval | every flagged scene lands in `proposals` + the card's Fix affordance; unavailable layers say so explicitly |

Unit tests alone never claim visual quality (S76 §6): the deterministic
layer is pinned offline; the VLM layers are pinned for CONTRACT (prompt
laws, parse tolerance, fail-open) via injectable call seams, and their
live judgement lands as real artifacts when the gateway window allows
(smoke-script discipline, same as the continuity benchmarks).

## 10. Pinned-by-tests contract

`deriveStyleContract` (mode/tie-break/outliers/null-handling) ·
`buildStyleBatches` (chunking, order) · `parseStyleVerdicts` (string
keys, clamping, missing scene → unavailable, malformed → batch
unavailable) · `worstVerdict`/`sceneScore`/`overallScore` (min-across,
worst-of, unavailable ignored, honest zero) · `buildRepairProposals`
(flagged-only, caps, passthrough) · `appendHistory` (cap 12) ·
`parseConsistencyReport` (V1 rows still parse; V2 roundtrip) ·
`STYLE_SYSTEM` + identity-law pins ("ignore identity" in the style
prompt; "judge ONLY identity" stays in the continuity prompt).

S78 additions: `buildAppearanceTargets` (approved/cast/logged-look
gates, ascending, deduped) · `buildAppearanceLook` (mirrors
`getApprovedAppearanceClause` — trimmed, ", "-joined) ·
`parseAppearanceVerdict` (clamping, issues filter, missing score →
null — NEVER a fabricated 50) · the three-dimension math (min-across
identity/appearance/style, unavailable ignored, honest zero) · the
appearance proposal branch (redress template, cap holds) · the V2
appearance-dim roundtrip (V1 rows still map with none) ·
`APPEARANCE_SYSTEM` law pins ("Judge ONLY appearance continuity";
identity AND style both disclaimed; STRICT JSON).

S79 additions: `buildTargetBatch` (nearest-first window, cap,
dedupe, target always in — unpainted target joins and is reported
unavailable, never fabricated) · `mergeTargetedRow` (replace-or-insert,
order kept, other rows reference-untouched) · the dry `onlyScene`
continuity mode's contract (scoped loop, no column write, no Activity
row).

S80 additions: `normalizeConsistencyCheckMode` (the two valid
non-defaults pass; junk/blank/null → `auto` — never silently
disabled) · the settings allow-list entry · both chains gated to
`auto` · the POST refusal at `off`.

S81 additions: `composeLockedShotPrompt` (anchor-only
BYTE-IDENTICAL to the pre-S81 composition; no locks → base
untouched; full stack order shot → anchor → style → continuity,
falsy clauses filtered) · `shotLikenessEditPrompt` /
`shotLocationEditPrompt` (the scene-art edit sentences re-aimed at
the shot, "Shot:" marks the framing prompt) · `pickShotEditSeed`
(cast likeness outranks the set piece; neither → fresh generation,
exactly as before S81).

S82 additions: `buildCrossVideoBatch` (newest-first sort the caller
cannot subvert, cap 6, frame-less + beyond-cap skips carry honest
reasons) · `parseCrossVideoVerdict` (index-aligned; missing /
non-numeric score → null, NEVER a fabricated 50; clamping; issues
cap; malformed reply → every frame unavailable) · `crossVideoOverall`
(min-across not mean, nulls ignored, honest zero) · `CROSS_VIDEO_SYSTEM`
law pins ("Judge ONLY identity"; clothing AND art style disclaimed;
STRICT JSON, one entry per frame in order) · `crossVideoReportKey` +
`parseCrossVideoReport` (the namespace key; roundtrip; corrupt /
wrong-schema JSON → null).

S83 additions: `buildPoseTargets` (POSES declaration order, unknown
ids dropped, capped) · `POSE_IDENTITY_SYSTEM` law pins (portrait is
the anchor; "Judge ONLY identity"; signature outfit rides the
judgement; the pose itself disclaimed; STRICT JSON, index-aligned) ·
the additive `poses[]` parse (a pre-S83 report parses with NO pose
rows; unavailable rows stay unavailable through the roundtrip).
