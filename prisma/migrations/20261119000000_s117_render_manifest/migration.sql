-- S117 — Stage 6 of Scene-Level Editing & Repair: the render manifest
-- (docs/design/scene-level-editing-reconciliation.md §9, Stage 6).
--
-- Video.renderManifest carries the JSON RenderManifest (render-assembly.ts):
-- the exact revision set final.mp4 was assembled from — per scene, the
-- stable sceneId, the source (approved revision | v1 baseline | row) and
-- the revisionVersion. Render consumes the latest APPROVED revision per
-- scene (draft edits never leak into a final); the manifest is the durable
-- proof of what was assembled, and renderStaleness compares it against the
-- CURRENT assembly source per scene — any newer revision, any new approval,
-- any scene-list change ⇒ the standing final is stale by comparison, and
-- the export/publish ship gates refuse (409) until a re-render refreshes
-- the manifest. null = pre-S117 render (or none): freshness provable only
-- when no scene carries revision history.
--
-- Additive on both sides; no backfill.

ALTER TABLE "Video" ADD COLUMN "renderManifest" TEXT;
