-- P0 raster-to-stroke: the trace provenance column on the upload manifest.
-- Additive + nullable (pre-P0 rows carry NULL); JSON TEXT per the house law
-- (SQLite mirror and Postgres behave identically). See
-- docs/design/whiteboard-production-system-audit-and-p0-plan.md P0-4/P0-7.
ALTER TABLE "WhiteboardAssetUpload" ADD COLUMN "traced" TEXT;
