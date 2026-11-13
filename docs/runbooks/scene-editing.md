# Runbook — Scene-Level Editing & Repair (S111–S118)

**Audience:** the operator and anyone operating a TubeForge production
instance. This is the trust layer's user manual and incident guide — what
the layer does, how to walk the ladder, what the gates refuse and why, and
where every behavior is pinned.

**Status:** feature track complete (Stages 0–6 landed as S111–S117; the UX
+ hardening stage S118 closed the track). Design:
`docs/design/scene-level-editing-reconciliation.md` (the Stage 0
reconciliation + the progress addendum). Evidence: `worklog.md` §S111–§S118.

---

## 1. The model in one paragraph

Every edit to a scene is an **immutable revision** (`SceneRevision`): the
row scene AND its timeline-doc slice snapshot together, keyed on a stable
scene id that survives reorders. Nothing is ever overwritten and nothing is
ever erased — **rollback restores old content as a NEW revision**, and an
**approved** revision stays addressable under any number of newer drafts.
Paid repairs follow a **propose → approve** ladder: the proposal stores the
cost estimate and the exact list of what regenerates BEFORE anything can
spend; approval runs the ceiling admission, stamps who approved it, and
enqueues the job idempotently (approving twice cannot spend twice). A
final render assembles, per scene, the **latest approved revision** (or the
pre-draft baseline when nothing is approved) — draft edits never leak into
a final — and records the assembly as a **render manifest**; if anything
moves afterwards (a new draft, a new approval), the final is **stale** and
both ship gates (export, publish) refuse until a re-render.

## 2. The operator's walk

1. **Edit** the scene (Scene Studio → text fields, or the timeline doc).
   Text edits land as revisions; narration edits sweep only that scene's
   audio + the renders (every other scene's assets survive).
2. **Preview the scene**: Scene Studio → *History, checks & approval* →
   **Preview scene** (or `POST /api/videos/[id]/render {"sceneIndex": n}`).
   Renders `scene-preview-NN.mp4` — nothing else moves.
3. **Re-check**: **Re-check** button (`POST .../scenes/[n]/recheck`). Runs
   the QC battery scoped to the scene (playable, black/frozen frames,
   aspect, loudness family, dead air, static, flicker, stutter, duration,
   captions-in-window when an SRT stands, the restricted-visual scan under
   a restricted policy) plus the **seam verdicts** for the scene's
   boundaries. Verdict lands on the head revision.
4. **Seams**: each unmeasured seam carries a **Render the pair** button
   (`POST .../render {"boundaryAfter": n}`) — renders scenes n and n+1 with
   their transition as `scene-boundary-NN.mp4`. Re-run the recheck after
   the pairs land.
5. **Approve**: when the verdict passes for the head's own version,
   **Approve** flips the status (idempotent; refusal reasons are always
   shown, never hidden).
6. **Render** the final. Drafts stay out; the manifest records the assembly.
7. **Ship**. Export/publish refuse a stale or unprovable final with the
   reasons; re-render to refresh.

## 3. The gates (and why there is no override for staleness)

| Gate | Refuses with | Override? |
| --- | --- | --- |
| Optimistic concurrency (`expectedSceneVersion`) | 409 + the current head | — (reload and re-apply) |
| Repair approval ladder | 409 until `approvedBy` stamps | — (the proposal is the ask) |
| Per-project spend ceiling | 402 with the numbers | — (raise or clear the ceiling) |
| Scene recheck → approval | 409 with the blocker reason | — (fix, or approve an older revision after rollback) |
| QC ship gate | 409 with the blocking findings | YES — accept findings (a judgment about quality) |
| **Render staleness ship gate** | 409 with the stale reasons | **NO — staleness is a fact about WHICH bytes ship, not a judgment** |

## 4. The repair inbox

`GET /api/videos/[id]/scenes/[n]/repair` — proposals from the Visual
Consistency Engine (origin `vce`, persisted since S118), the critic's
scene-scoped actions, and manual proposals. Each row carries the estimate
(the admission's own cost table), the affected-asset list, and the approval
state. Approve = spend (ceiling-admitted, idempotent); reject = keep the
estimate as a record. The per-scene spend and the ceiling headroom show on
the production board ("$X on this video / $Y cap").

## 5. The QA scenario table — where each is pinned

The operator's twelve scenarios, mapped to their executable pins:

| # | Scenario | Pinned by |
| --- | --- | --- |
| 1 | Unauthorized user on scene routes | tenancy suites + `e2e/scene-editing.spec.ts` (401) |
| 2 | Version conflict on concurrent edits | battery: "stale expectedVersion conflicts" (409 + P2002 floor) |
| 3 | Rollback restores (never erases) | battery: rollback-as-new-revision |
| 4 | Duplicate generation / double bill | battery: the double-bill killer (idempotency keys) |
| 5 | Budget exceeded | battery: the ceiling's 402 shape; render route gates |
| 6 | Repair without approval | battery: the ladder (no job, no cost before the stamp) |
| 7 | Failed repair keeps prior state | S112 approved-never-destroyed + resume/cancel drills |
| 8 | Broken transition at a seam | battery: the boundary lens (missing cut / stray fails) |
| 9 | Repaired scene checked before approval | battery: the approval gate (verdict-tied) |
| 10 | Stale preview displayed as such | battery: artifactStaleness + preview-freshness |
| 11 | Stale final render detected | battery: the manifest ladder (fresh → approval stales) |
| 12 | Final QC blocks publishing | QC ship gate suites + `e2e/pipeline.spec.ts` |

## 6. Incident notes

- **"Export on hold — the final is stale"**: expected after any post-render
  edit or approval. Re-render; the manifest refreshes. If the reasons look
  wrong, check `renderStaleness`'s inputs: the manifest on the video row +
  the per-scene approved/baseline sources.
- **"unknown" staleness on an old video**: the final predates S117 while
  the video carries revision history — one re-render proves the assembly.
- **A scene won't approve**: the GET `/scenes/[n]/recheck` feed names the
  blocker (no verdict / verdict for an older version / verdict failed) and
  lists which seam media is missing.
- **Approvals and the render**: approving a revision immediately stales any
  standing final assembled from older content — that is the point (the
  operator asked for the approved bytes). Render again.

## 7. API quick reference

| Route | Purpose |
| --- | --- |
| `GET /api/videos/[id]/scenes/[n]/revisions` | the immutable chain + head + approved |
| `POST /api/videos/[id]/scenes/[n]/rollback` `{toVersion}` | restore as a new revision |
| `GET/POST /api/videos/[id]/scenes/[n]/recheck` | the verdict feed / run the battery; `{approve:true}` approves |
| `GET/POST /api/videos/[id]/scenes/[n]/repair` | the approval inbox / propose-approve-reject |
| `GET /api/videos/[id]/scenes/[n]/artifacts` | the provenance feed (prompt, provider, cost, staleness) |
| `POST /api/videos/[id]/render` `{sceneIndex}` / `{boundaryAfter}` | the scene preview / the seam pair |
| `GET /api/videos/[id]/render` | render status + manifest + the live staleness verdict |
| `POST /api/videos/[id]/storyboard/upload` | per-scene art upload (multipart `scene` + `file`) |
