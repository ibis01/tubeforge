-- S69 — Whiteboard Engine (E9 Phase C / E11 §7): the uploaded-asset
-- manifest. One row per user-uploaded SVG registered into a video's
-- whiteboard library (the storage object itself lives at
-- <videoId>/whiteboard/assets/<assetId>.svg through storage.ts). Additive:
-- new table + FK, no backfill, cascade-on-video-delete — the additive chain
-- migration + self-healing deploy law (the postgres CI lane replays the
-- wedge recovery on every push).
CREATE TABLE "WhiteboardAssetUpload" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "viewBoxW" INTEGER NOT NULL,
    "viewBoxH" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL DEFAULT 0,
    "uploadedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhiteboardAssetUpload_pkey" PRIMARY KEY ("id")
);

-- One library id per video: a duplicate registration would corrupt the
-- loadLibrary merge (which throws on collision by design).
CREATE UNIQUE INDEX "WhiteboardAssetUpload_videoId_assetId_key" ON "WhiteboardAssetUpload"("videoId", "assetId");

CREATE INDEX "WhiteboardAssetUpload_organizationId_idx" ON "WhiteboardAssetUpload"("organizationId");

ALTER TABLE "WhiteboardAssetUpload" ADD CONSTRAINT "WhiteboardAssetUpload_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;
