-- S72 — Creator Intelligence CI-4: the retention report doc column (the
-- eighth JSON doc column on Video). Holds the ingested YouTube Analytics
-- retention curve + the drop-off findings mapped to scenes — null = never
-- synced or not published. Additive, no default, no backfill (the
-- additive chain migration + self-healing deploy law).
ALTER TABLE "Video" ADD COLUMN "retentionReport" TEXT;
