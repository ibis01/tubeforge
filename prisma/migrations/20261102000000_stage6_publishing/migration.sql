-- Stage 6 — Editing, rendering & publishing.
--
-- Video.timeline: JSON "assembled timeline" produced by POST /api/videos/[id]/assemble.
-- Per-scene start/end times, transitions, audio levels, caption cues. The
-- render job consumes this if present (T-6.10) so the user can edit the
-- timeline in the Editing Studio before the final render commits. Plain
-- TEXT — SQLite mirror and Postgres behave identically (the pattern set by
-- shotList/qcReport/researchSources).
--
-- Video.aspectRatio / Video.frameRate / Video.burnCaptions — per-project
-- defaults the Stage 6 Rendering Engine reads. aspectRatio: "16:9" | "9:16"
-- | "1:1"; frameRate: 24 | 30 | 60; burnCaptions: true → captions drawn into
-- the video frame, false (default) → captions ride as a sidecar SRT only.

ALTER TABLE "Video" ADD COLUMN "timeline" TEXT;
ALTER TABLE "Video" ADD COLUMN "aspectRatio" TEXT;
ALTER TABLE "Video" ADD COLUMN "frameRate" INTEGER;
ALTER TABLE "Video" ADD COLUMN "burnCaptions" BOOLEAN;
