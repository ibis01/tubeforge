# Scene-Level Editing & Repair — Stage 0 Reconciliation (S111)

**Status:** READ-ONLY reconciliation of the operator's proposed architecture
("Scene-Level Production Control Layer", delivered 2026-11-13) against the
live tree at HEAD `1379134`. No product code was changed by this stage.

*Progress addendum (2026-11-13): the operator's go arrived with the build
order ("start, don't stop"); the four §10 decision points resolved to their
recommended defaults (keep all revision rows, GC only superseded artifacts;
latest-approved-per-scene render; opt-in per-video spend ceiling; epochs for
whole-script regens/converts). **Stages 1–6 landed as S112–S117** — see
docs/production-readiness.md's feature-track ledger rows and worklog
§S112–§S117. Stage 7 follows. Stage 5's additions to the plan:
the boundary-pair check is MEDIATED (a new render grammar
`POST /render {boundaryAfter}` produces scene-boundary-NN.mp4 — the pair
through the same segment + transition machinery — because the seam cannot
be measured from a single scene's preview), and the scene-duration fold
moved into ONE exported pure function (resolveSceneDuration) so the render
loop and the seam expectation consume the same math. Approval resolves to
the strict reading: a revision is approvable only when a recheck verdict
that PASSED (every check AND every seam measured-and-passed — the
never-silently-clean law at scene scope) exists for the HEAD'S OWN
version. Stage 6 resolved the manifest question the plan left open: the
manifest lives on the Video row (Video.renderManifest — one final per
video; the SceneArtifact registry stays scene-scoped), the render's
per-scene source ladder is latest-approved → v1-baseline → row (the
fallback keeps existing edit-then-render flows working while drafts never
leak into a final), and the ship gates carry NO staleness override —
unlike a QC finding a human may accept, staleness is a fact about WHICH
bytes ship.* This
document is the explicit mapping the plan's Stage 0 exit demands: proposed
design → existing code → precise gaps → file-by-file implementation plan.

**Method.** Full Prisma schema review (936 lines, 34 models) + three
parallel code explorations: (A) scene representation & editing surface,
(B) pipeline infrastructure (queue / budget / storage / QC / render),
(C) existing repair / preview / approval / rollback capabilities. Every
claim below carries a file reference; the load-bearing ones were
spot-verified at HEAD.

---

## 1. Verdict, in one paragraph

The proposal's foundation is real and better than it knows: surgical
scene edits with surgical invalidation already exist
(`PATCH /api/videos/[id]/scenes`), per-scene regeneration exists for art
(storyboard re-roll / AI-edit, `seedVariant` take counters), repair
PROPOSALS already exist in two engines (the S84 critic and the S77
Visual Consistency Engine — both strictly propose-never-auto-edit, fired
by human click), one scene-scoped QC precedent exists (the S79 targeted
consistency re-check), and the whiteboard lane already stores per-scene
encodes explicitly reserved for a future single-scene swap. What is
entirely missing is the TRUST layer the proposal correctly insists on:
scene versioning (scenes are a last-write-wins JSON blob), optimistic
concurrency on that blob, artifact provenance (generation prompts are
discarded; cost records are not linked to scenes or artifacts), job
idempotency keys (a bare `db.job.create`; the only dedup is a racy
check-then-insert), pre-generation cost approval surfaced to the user,
per-project spend ceilings, per-scene approval state, server-side
rollback, and — the biggest render-side gap — any form of partial
re-render (a single scene's visual edit today deletes EVERY scene's
rendered clips). The reconciliation also found two live defects and one
architectural surprise (scene identity is positional and unstable), all
recorded in §8.

## 2. Capability map — proposed → existing

| Proposed capability | Live code | Verdict |
| --- | --- | --- |
| Edit scene (source document) | `PATCH /api/videos/[id]/scenes` (scenes/route.ts:91-138) — 6 fields per scene, writes caption through to the timeline doc, invalidates stale artifacts surgically (:16-49) | **EXISTS** (partial field set; `title/sfx/focal/hostInScene/rehook` have no edit API) |
| Preview scene (scene-scoped) | Whiteboard ONLY: `POST /whiteboard/render {sceneId}` → `whiteboard/preview-<sceneId>.mp4` (video-jobs.ts:1651-1698). Story lane: `sceneLimit` renders the first-N PREFIX (render.ts:1357-1359) — not an arbitrary scene | **PARTIAL** — whiteboard yes; story lane no |
| Repair scene (targeted) | Art: `POST /storyboard {scene:n, instruction}` → AI-edit one scene (video-jobs.ts:403-501). Stock: `POST /stock/[n]`. Voiceover: **all-scene only**. Critic + VCE emit per-scene repair proposals with ready `instruction` strings | **PARTIAL** — art yes, voice no, no durable repair records |
| Recheck scene (QC) | QC battery (qc.ts:222-695) is whole-artifact only; S79 targeted re-check re-judges ONE scene after repaint and merges into the standing report (video-jobs.ts:1246-1259) | **PARTIAL** — precedent exists, not generalized |
| Render final (assembly) | `renderVideo` (render.ts) — full segment→stitch→finalize, per-boundary transitions (transitions.ts), QC ship gate blocks export+publish | **EXISTS** (but rebuilds everything, every time) |
| Scene versioning | Nothing. `Video.scenes` JSON, last-write-wins; whiteboard `rev` is one advisory doc-level counter | **GAP** |
| Dependency invalidation | Implicit, in code: narration edit → delete that scene's WAV/renders; art change → `invalidateRenderedArtifacts` deletes **every** scene's clips (video-jobs.ts:445, render.ts:259-264) | **PARTIAL** — right idea, wrong blast radius; no declarative map |
| Artifact provenance | `UsageRecord` (schema:746-766) logs provider/model/tokens/cost per call but links to NO video/scene/artifact and stores no prompt; `Job.payload` carries `{sceneIndex, instruction}` for resume only; `StockRef` is the one provenance-rich scene field | **GAP** |
| Cost authorization | Credit holds before every AI call (billing.reserveCredits, transactional); token-accurate estimator (spend.ts:554-573); render route pre-gate 402 (render/route.ts:150-178). But the user never sees an estimate-and-approve step; no per-project ceiling | **PARTIAL** — mechanics exist, authorization UX and project ceiling do not |
| Rollback | Client-side undo in the timeline studio (50 steps, resets on every row mutation, timeline-studio.tsx:303-309); no server history anywhere | **GAP** |
| Idempotency | `createPendingJob` = bare insert (queue.ts:228-253); dedup = `startJob`'s racy check-then-insert on (entityId, kind, pending\|running) (jobs.ts:411-428); no unique constraints on Job | **GAP** |
| Cost / spend records | CreditLedger + UsageRecord + board's 30-day cost panel (S91) — org-level, "no per-video attribution" stated on the board itself | **PARTIAL** |
| Queue / storage / budget reuse | Job (leases + fencing, S100), storage facade (+ quota, S101), CreditLedger — the proposal's "reuse, don't rebuild" is exactly the live shape | **CONFIRMED REUSABLE** |

## 3. The five requirements, against reality

**A. Scene versioning — MISSING, and the foundation everything else needs.**
`Video.scenes` is a JSON string overwritten in place by ELEVEN distinct
write paths (inventory in §5). The whiteboard doc's `rev`
(whiteboard-planner.ts:167-200) is a single advisory counter bumped on
every accepted PUT with a 409-and-return-current-doc conflict response
(whiteboard/route.ts:156-177) — the right conflict UX, but doc-level and
history-less. The timeline doc has a schema-stamp overwrite guard
(timeline.ts:694). None of these is a revision history.

**B. Dependency invalidation — the logic exists but over-fires.** The
surgical path (narration edit deletes only that scene's WAV + renders,
scenes/route.ts:16-49) is exactly right. The blunt path (ANY scene's art
change deletes EVERY scene's `scene-NN.mp4` clips + final + preview,
video-jobs.ts:445) is the proposal's core complaint rendered in code: a
one-scene repaint re-pays the whole video's render. The dependency table
the proposal wants (narration → voice/captions/timing; transition →
boundary; etc.) exists only as scattered `if`-branches — it must become
declarative and per-scene.

**C. Artifact provenance — MISSING.** At generation time the composed
prompt (visual + topic-world + style + director addendum + appearance
clauses, story.ts:752-910) is used and discarded; the seed is
deterministic (`sceneGenerationSeed`, story.ts:304-314) but nothing
records which prompt+seed+model produced which `scene-NN.png`. Cost rows
exist but float free of scenes. The ONLY provenance-rich artifact
reference is `StockRef` (source, query, credit, license, verification —
S89). Narration→WAV lineage is positional naming plus a
deletion-on-edit discipline — a repair layer cannot today prove which
WAV matches which text.

**D. Cost authorization — mechanics without consent.** Every paid call
is estimated, held, and settled exactly-once (S47 crash-durable
reservations, serializable admission). But the authorization is a credit
BALANCE check, not a user-facing "this repair will cost ≈X and will
regenerate Y — approve?" The proposal's requirement (estimate → show
affected scene → show what regenerates → explicit approval → enforce
budget) has its first and last pieces built; the middle three are UI +
API surface that does not exist. Per-PROJECT ceiling: nothing keys cost
to videoId today (balance is per-user per-period; the $4.50 operator
door is global, spend.ts:86-90).

**E. Rollback — MISSING.** Client-only undo that hard-resets on every
row mutation ("a deleted scene cannot be un-deleted by a client-side
undo", timeline-studio.tsx:32-34). Rollback-as-new-revision does not
exist because revisions do not exist.

## 4. Risk table vs live protections

| Risk | Required protection | Live state |
| --- | --- | --- |
| Stale preview | Display the producing version | PARTIAL — art URLs carry `?v=<mtime>-<size>` (story.ts:51-54); QC reports carry `scope`+`checkedAt`; but `preview.mp4`/`final.mp4` record no content identity |
| Duplicate generation | Idempotency keys | **GAP** — bare insert; racy dedup; retry-after-done re-enqueues freely |
| Failed repair | Keep previous approved version | PARTIAL — presence-equals-current + deletion discipline + "completed scenes kept" cancel semantics; no version pinning |
| Concurrent editing | Version conflict detection | PARTIAL — timeline schema-stamp + whiteboard advisory rev; `scenes` column itself is LWW |
| Broken transitions | Recheck adjacent scenes | **GAP** — `cut-alignment` is a whole-file probe; no boundary-scoped check |
| Stale final render | Freeze a project revision per render | PARTIAL — wholesale invalidation deletes final on any art change (right outcome, blunt mechanism); no render manifest |
| Storage waste | Retention / cleanup policy | PARTIAL — S101 quota ceilings; orphan cleanup on delete; no superseded-revision artifact retention policy |
| Unauthorized publishing | Human approval + publishing controls | **EXISTS** — QC ship gate blocks export+publish (409), restricted-visual L1–L5 (S49) blocks at the gate, audited override anchored to one report, publish is an explicit single POST |

## 5. Data-model reconciliation (the proposal's §6 vs the live schema)

Five findings that reshape the proposed schema:

1. **Scene identity is positional and UNSTABLE.** The proposal assumes a
   permanent `scene_id`. Live scenes carry a 1-based `index` whose
   meaning shifts under structural ops: split mints a new index and
   re-numbers the tail (clip-ops.ts:303-409), delete re-numbers, reorder
   (assemble) permutes. The queue's composite entity id
   `<videoId>#scene<N>` inherits that instability. **Stage 1 must mint a
   stable `Scene.id`** (backfill `s<N>` for existing rows) and preserve
   it across reorder/edit; split mints a new id for the new scene.
2. **Scene content spans TWO documents (three in whiteboard mode).** The
   proposal's `SceneRevision.content` bundles narration + captions +
   audioMix + transition. Live: text fields live in `Video.scenes`;
   transitions, per-scene audio mix, trims, caption timing live in the
   timeline doc (`TimelineScene`, timeline.ts:234-259); whiteboard state
   lives in `Video.whiteboardProject`. **A scene revision must snapshot
   the scene-scoped slice of the union**, or rollback restores half a
   scene. The existing lockstep updater (clip ops write row + timeline +
   audioDuration in one update) is the pattern to generalize.
3. **Eleven mutators must converge.** Write paths to `Video.scenes`:
   script regen (route + job), batch, PATCH /scenes, storyboard re-roll
   (seedVariant only), stock matching, convert, assemble (reorder),
   clip ops, studio/voice, studio/pace. Retrofitting all eleven with
   revision writes in Stage 1 is the plan's largest risk. **Recommended
   split:** Stage 1 revisions cover the four interactive edit surfaces
   (PATCH /scenes, assemble, clip, voice/pace); whole-script regens and
   convert create a structural EPOCH (one revision for all scenes,
   parent = prior epoch head) instead of per-scene diffs.
4. **The proposed `SceneArtifact` needs a UsageRecord bridge, not a
   replacement.** UsageRecord already captures provider/model/tokens/
   cost/latency per call (schema:746-766) — it lacks the linkage columns.
   Add `videoId?/sceneIndex?/artifactId?` and persist the prompt at the
   generation site; do not duplicate cost tracking in a new table.
5. **`SceneRepair` is the durable form of what the critic and VCE
   already emit.** Both engines produce per-scene proposals with ready
   `instruction` strings today (video-critic.ts:249-285,
   visual-consistency.ts:367-404) — ephemeral report JSON. The repair
   table is those proposals, persisted, with the approval + job linkage
   the proposals currently lack. Schema addition, aligned to the
   proposal's status ladder, plus `estimateMicroUsd` for requirement D.

Migration law reminder: the chain is Postgres-owned
(`migration_lock.toml`) with the SQLite mirror DERIVED
(`scripts/sync-sqlite-schema.mjs`, byte-identical by the S99 verifier) —
every Stage-1+ migration lands in both, with the clean-clone and
determinism gates re-proving it.

## 6. API reconciliation

The proposal's flat `/scenes/:id` does not fit the live tenancy model
(every route is org-scoped through `requireUser` + video ownership,
under `/api/videos/[id]/...`). Reconciled contracts, following house
conventions (and the whiteboard scene-preview precedent):

| Proposed | Reconciled (house convention) | New? |
| --- | --- | --- |
| GET /scenes/:id | `GET /api/videos/[id]` (scenes + DTO join today) | exists |
| GET /scenes/:id/revisions | `GET /api/videos/[id]/scenes/[n]/revisions` | new |
| POST /scenes/:id/revisions | `PATCH /api/videos/[id]/scenes` + `expectedSceneVersion` (conflict → 409 + current) | extends existing |
| POST /scenes/:id/preview | `POST /api/videos/[id]/render {sceneIndex}` — the `sceneLimit` grammar generalized to an arbitrary scene (whiteboard precedent: `{sceneId}`) | extends existing |
| POST /scenes/:id/repair | `POST /api/videos/[id]/scenes/[n]/repair` (proposal-sourced or freeform, estimate attached) | new |
| POST /scenes/:id/recheck | `POST /api/videos/[id]/scenes/[n]/recheck` (generalizes the S79 targeted re-check) | new |
| POST /scenes/:id/rollback | `POST /api/videos/[id]/scenes/[n]/rollback {toVersion}` | new |
| GET /scenes/:id/artifacts | `GET /api/videos/[id]/scenes/[n]/artifacts` | new |
| POST /projects/:id/render | `POST /api/videos/[id]/render` | exists |

Every write enforces `requireUser`, video ownership, `expectedSceneVersion`
optimistic concurrency, and (for paid kinds) the estimate→approval gate.

## 7. QA requirements mapping

The proposal's "special quality requirements" map almost one-to-one onto
live systems — the gap is that they run at PROJECT scope, not scene
scope: visual continuity across adjacent scenes (VCE `subject-continuity`
check + per-scene verdicts), consistent characters/costumes
(CharacterAppearance per-scene log + approved-director prompt weaving),
narration sync (word-synced captions, captions.ts:335+), loudness +
transition continuity (loudness/true-peak/loudness-range/cut-alignment
checks), caption readability (captions check), aspect + frame-rate
(aspect check; geometry per project), black/frozen frames (checks),
camera movement over static (static-shots check + S35 Smart Motion),
and the Islamic-history face restriction (the S49 L1–L5 chain — prompt
substitution through post-render scan to the blocking ship gate — which
already exceeds the proposal's requirement). **Stage 5's work is
scoping, not inventing: run these per scene-segment + boundary-pair.**
The QA table's twelve scenarios (§9 of the proposal) become the new
e2e/unit battery; four are already pinned today (unauthorized user →
tenancy suites; budget exceeded → 402 gates; final render QC → ship
gate; failed generation keeps prior state → resume/cancel drills).

## 8. Defects found by the reconciliation (fix regardless of the track)

1. **DEAD ROUTE — art upload 404s.** `scene-editor.tsx` and
   `timeline-studio.tsx` both POST to `/api/videos/[id]/storyboard/upload`
   (backed by an existing `replaceSceneImage`, story.ts:1062-1106), but
   `src/app/api/videos/[id]/storyboard/` contains only `route.ts` and
   `[n]/` — the per-scene art-upload button is broken in the live tree.
2. **Unaudited edits.** Scene text edits (PATCH /scenes) and timeline
   saves (PUT /assemble) write no `Activity` row — the two MOST
   human-facing mutations are the only unaudited ones (job bodies all
   write Activity).
3. **Over-invalidation is a cost bug today.** One scene's repaint
   deletes every scene's rendered clips (video-jobs.ts:445 +
   render.ts:259-264) — measurable re-render cost on a 20-scene video
   for a one-scene fix. Fixing this is Stage 2's core and pays for
   itself before any other stage lands.

## 9. Stage plan (file-by-file) — the Stage-0 exit deliverable

Each stage lands as a numbered worklog stage with unit pins, full gates,
and a CI-green push; exit criteria are the proposal's own, restated as
tests. Order follows the proposal (1→7); the reconciliation moved
nothing, it only sized it.

**Stage 1 — Scene revision foundation** (exit: editing cannot overwrite
another revision or destroy approved work)
- `prisma/schema.prisma`: `Scene.id` (stable, backfilled `s<N>`);
  `SceneRevision` model — `(videoId, sceneId, version)` unique,
  `parentVersion`, `content` (the §5.2 union slice), `status`
  (draft/previewing/needs_repair/approved/superseded), `createdBy`,
  `createdAt`; Postgres migration + SQLite mirror via the sync law.
- `src/lib/tubeforge/scene-revisions.ts` (new): `createRevision` (tx:
  verify expectedVersion → write row → supersede parent), `current`,
  `rollback` (new revision from old content, never a delete), conflict
  type → 409 shape matching the whiteboard precedent.
- Retrofit, in order: `scenes/route.ts` (PATCH gains
  `expectedSceneVersion`), `assemble/route.ts` (reorder snapshots),
  `clip-ops.ts` (split/dup/delete/revoice → revisions + new ids),
  `studio/voice` + `studio/pace` (epoch-style per-scene revisions).
  `script/route.ts` + `convert` → structural EPOCH revisions (§5.3).
- Pins: revision immutability; optimistic conflict; rollback-as-new-
  revision; split mints fresh id; the eleven-mutator inventory as a
  source pin (every mutator calls `createRevision` or is
  epoch-classified).

**Stage 2 — Dependency + artifact tracking** (exit: changing one scene
does not invalidate unrelated assets)
- `src/lib/tubeforge/scene-deps.ts` (new): the declarative dependency
  map (the proposal's table, encoded: narration→{voice,captions,timing},
  visual→{art}, transition→{boundary}, audioMix→{mix}, …) with
  `planInvalidation(change) → {sceneArtifactKeys}`.
- `SceneArtifact` model (id, sceneId, revisionVersion, type, storageKey,
  inputHash, provider?, model?, promptDigest?, costMicroUsd?, status);
  registry writes at the four generation sites (scene image
  story.ts:897/1043/1106, scene WAV story.ts:1165+, i2v clip
  render.ts:316+, whiteboard scene encode video-jobs.ts:1733).
- `UsageRecord` gains `videoId?/sceneIndex?/artifactId?` (§5.4); prompt
  text persisted (digest + full text into the artifact row).
- **Fix the over-invalidation**: `invalidateRenderedArtifacts` becomes
  dependency-scoped (only the changed scene's clips + the final render,
  which is invalidated by ANY scene change — the final is the union).
- Pins: narration change stales voice+captions ONLY; visual change
  keeps narration audio; the §8.3 cost bug measured (clips deleted
  before/after).

**Stage 3 — Scene preview** (exit: preview generation does not trigger
whole-project regeneration)
- `render.ts`: generalize the `sceneLimit` prefix grammar to
  `{sceneIndex}` — render one scene's segment + its boundary handles via
  the existing `buildSegment` + transition graph, land
  `scene-preview-<n>.mp4` (story-lane twin of the whiteboard
  `preview-<sceneId>.mp4`).
- Route: `POST /api/videos/[id]/render {sceneIndex}` → scene-scoped job
  (entity `<videoId>#scene<N>` — the existing convention); the artifact
  row records the revision it was built from (stale detection =
  artifact.revisionVersion ≠ current approved).
- Pins: preview of scene N touches no other scene's artifacts; stale
  preview is detectable and labeled.

**Stage 4 — Repair + cost authorization** (exit: failed or repeated
requests cannot silently incur duplicate costs)
- `SceneRepair` model (§5.5) + `POST .../scenes/[n]/repair`; the critic
  and VCE proposal emitters gain "persist as SceneRepair" so the S86
  one-click lane becomes an approve-repair flow carrying an estimate.
- Cost surface: per-action estimate from the live estimators
  (`estimateDispatchMicroUsd` for chat/vision, `ESTIMATED_COST_MICRO`
  for image/tts) + the repair's affected-asset list from Stage 2 →
  approval UI + `approvedBy` stamp → enqueue.
- **Idempotency**: `Job.idempotencyKey` (unique, org-scoped);
  `createPendingJob` becomes insert-on-key (upsert semantics), killing
  the racy `startJob` check-then-insert (jobs.ts:411-428) and the
  retry-after-done double-bill path.
- Per-project ceiling: `Video.spendCeilingMicro?` enforced in the same
  admission as the credit hold (video-scoped UsageRecord sum + estimate
  ≤ ceiling, else 402).
- Pins: retry same job = one paid generation (the double-bill test);
  ceiling exceeded → 402; repair without approval → 409.

**Stage 5 — Scene QC + boundary validation** (exit: repaired scenes are
checked before approval)
- `src/lib/tubeforge/scene-qc.ts` (new): scope the whole-file probes to
  a scene segment (black/frozen frames, loudness, static-shots,
  captions timing) + a boundary-pair check (cut-alignment generalized
  from whole-file to the seam); generalize the S79 targeted re-check
  pattern (`runTargetedRecheck` is the template).
- `POST .../scenes/[n]/recheck` → verdict rows stored on the revision;
  approval (revision → approved) requires a passing recheck.
- Pins: adjacent-scene boundary check; verdict tied to revisionVersion;
  restricted-visual scoped to the scene segment (the S49 chain holds at
  scene scope).

**Stage 6 — Final assembly from approved revisions** (exit: final video
cannot be published from stale or unapproved assets)
- Render manifest: `final.mp4`'s artifact row records the exact
  revision set it assembled; any newer revision ⇒ final stale (replaces
  the blunt wholesale-delete with a labeled staleness state).
- Render consumes the latest APPROVED revision per scene (draft edits
  never leak into a final); the ship gate refuses a final assembled
  from superseded/unapproved revisions.
- Pins: unapproved-edit render refused; stale-final detection; publish
  blocked on stale (extends the existing 409 gates).

**Stage 7 — UX + production hardening** (exit: end-to-end tests + docs)
- Revision history panel, before/after diff, repair flow with estimate
  + affected assets, per-scene status chips on the board (S91), cost
  column per video (fixing the board's "no per-video attribution" note).
- Fix §8.1 (the dead upload route) and §8.2 (Activity rows on PATCH
  /scenes + PUT /assemble).
- The proposal's twelve-scenario QA table as an e2e suite; runbook
  (`docs/runbooks/scene-editing.md`); front-doc reconciliation
  (README/ARCHITECTURE/ROADMAP).

## 10. Decision points for the operator (before Stage 1)

1. **Revision retention** — keep all revisions forever, or cap per scene
   (e.g. last 20) with superseded-artifact GC? (Storage-waste row, §4.)
2. **Approval semantics for render** — "latest approved per scene"
   (recommended; matches the proposal) vs "pinned project revision"
   (stronger freeze, worse UX for last-minute fixes)?
3. **Per-project ceiling default** — opt-in per video, or a org-wide
   default with per-video override?
4. **Structural-epoch boundary** — agree that whole-script regens and
   convert are EPOCHS (one revision for all scenes) rather than
   per-scene diffs (§5.3) — or demand full per-scene diffs there too
   (roughly 3× the Stage-1 surface).

## 11. What will NOT be built (confirmed against the live tree)

No second timeline engine (the S87 universal timeline stays the one
doc); no separate job queue (Job + leases + fencing + the `#scene<N>`
entity convention carry everything); no independent storage (the facade
+ quota + keys stay); no parallel budget system (CreditLedger +
SpendReservation + UsageRecord extended, not forked); no separate
publishing pipeline (the ship gate + publish route stay the only doors).
The layer rides the existing infrastructure — which is what the live
tree was already shaped for.
