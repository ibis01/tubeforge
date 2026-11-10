# S77 — Visual Consistency Engine, Phase A record

Opened and closed 2026-11-11 UTC. This is the first work item of the
S76 adoption decision's **Phase 1 — shared quality systems** (§3), the
user's final priority order row 4 (P0). The design contract lives at
`docs/design/s77-visual-consistency.md` and governs everything below;
this record is the implementation receipt, verified against the tree.

## 0. What landed

The engine turns three disjoint judges into one platform service on
`Video.consistency` — **without a migration, without touching a
generation prompt, and without a fourth scoring scale**:

1. **`src/lib/tubeforge/visual-consistency.ts`** (new) — the engine.
   Pure + pinned: verdict math (`verdictFromScore` on the family's
   80/55 thresholds, `worstVerdict`, `sceneScoreOf` = min-across,
   `sceneVerdictOf` = worst-of, `overallScoreOf` with an honest
   zero), the deterministic style contract (`deriveStyleContract`,
   `approvedColorGrade`), batching (`buildStyleBatches`), the
   strict-JSON reply parser (`parseStyleVerdicts`), repair proposals
   (`buildRepairProposals`, capped at 8), the history ledger
   (`pushHistory`, cap 12), and the versioned parse
   (`parseConsistencyReport` — V1 rows normalize with EMPTY additive
   fields, never fabricated ones). The VLM layer: identity reused
   verbatim from `runContinuityCheck`, style judged in ≤6-image
   batches through `aiCall("llm", "consistency style VLM")` →
   `llmVision`, failing OPEN into `"unavailable"` — never a passing
   score.
2. **Job `"consistency"`** — `jobs.ts` kind + label, handler
   registered in `queue-handlers.ts` (resumability, boot recovery and
   cancel derive from the live registry — the exhaustive-pins test
   now holds 22 kinds), `runConsistencyJob` in `video-jobs.ts`.
3. **Auto-chain** — `runStoryboardJob` enqueues the check after a
   successful paint of ≥2 scenes (`triggered: "storyboard"`), fail-
   open on enqueue. Single-scene repaints do NOT auto-chain the full
   pass (spend discipline — design §7); the manual route is the
   fallback.
4. **Routes** — new `POST/GET /api/videos/[id]/consistency` (202 job
   start / report + flags); the director route's `action: "check"`
   now starts the UNIFIED engine and its gate relaxed to
   "scenes exist" (style needs no cast).
5. **UI** — the director card renders "Consistency" with a neutral
   `unavailable` badge, a `—` empty bar for unchecked scenes (never a
   fake red zero), identity/style dimension chips on flagged scenes,
   and the Check button is no longer cast-gated. `attention-panel`
   gained the consistency resume entry.

## 1. Verification

- **370/370 unit** (356 + 14 new S77 pins), typecheck 0 errors, lint
  0 errors on touched files (one pre-existing unrelated warning).
- The exhaustive-pins test (`resumableKinds covers every kind the
  routes start`) caught the new kind by design and was updated — the
  exact drift-enshrinement failure mode it exists to prevent.
- Back-compat proven by pin: a legacy V1 `ContinuityReport` parses
  into the V2 shape with the identity dimension mapped and every
  additive field EMPTY; the director card's V1 render path is
  untouched.

## 2. What is NOT claimed (honesty ledger)

- **No live VLM judgement has been exercised yet.** The style pass
  rides the same one-probe gateway discipline as S74; its contract is
  pinned offline via the parser and prompt-law tests. The first live
  report lands as a real artifact when the gateway window allows —
  unit tests alone never claim visual quality (S76 §6).
- **No generation prompt changed.** The photoreal-suffix
  contradiction in `artPromptRaw` is recorded (design §8 Phase B),
  frozen until S74's paired measurement closes.
- **Phase B tail, recorded not built:** dedicated appearance pass on
  approved `CharacterAppearance` rows; targeted single-scene
  re-checks; a `consistencyCheck` user setting; shot-art lock
  coverage (`ensureShotImages` still bypasses every identity lock);
  org-wide cross-video scoring; pose identity rows.

## 3. Governing-rule compliance (S76 §8)

Shared contracts consumed: `aiCall`/`aiCallJson` choke point, storage
seam (`${videoId}/scene-NN.png`), the job registry (new kind, handler
derived surfaces), `parsePlan`/`getApprovedAppearanceClause` patterns,
`llmVision` as the single multimodal path. No new pipeline, no new
provider seam, no parallel queue.
