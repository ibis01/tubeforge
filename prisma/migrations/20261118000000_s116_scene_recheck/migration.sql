-- S116 — Stage 5 of Scene-Level Editing & Repair: the scene-scoped QC
-- verdict column (docs/design/scene-level-editing-reconciliation.md §9,
-- Stage 5).
--
-- SceneRevision.recheck carries the JSON SceneRecheckReport (scene-qc.ts):
-- the scene-segment probes (playable, black/frozen frames, aspect, the
-- loudness family, dead air, static runs, flicker, stutter, duration vs the
-- render's own timing math, scene-sliced caption cues, the S49
-- restricted-visual scan at scene scope) plus the boundary-pair seam
-- verdicts — stored ON the revision it judged, as an ANNOTATION: content is
-- never rewritten (law 1); the verdict's revisionVersion is what makes a
-- newer head's verdict stale (by comparison, never by mutation).
-- Approval (status → approved) requires a PASSING verdict for the head's
-- own version — the "repaired scenes are checked before approval" gate.
--
-- Additive on both sides; no backfill (pre-S116 revisions simply carry no
-- verdict — approval refuses until a recheck runs).

ALTER TABLE "SceneRevision" ADD COLUMN "recheck" TEXT;
