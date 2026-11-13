-- S115 — Stage 4 of Scene-Level Editing & Repair: the SceneRepair table,
-- Job idempotency keys, and the per-project spend ceiling
-- (docs/design/scene-level-editing-reconciliation.md §9, Stage 4).
--
-- SceneRepair: the durable form of the critic/VCE repair proposals — the
-- propose→approve→run ladder (requirement D: no silent paid calls).
-- Job.idempotencyKey: a retry of the same logical work resolves to the
-- standing row (done rows are never re-enqueued — the double-bill killer).
-- Video.spendCeilingMicro: opt-in per-project ceiling, enforced in the same
-- admission as the credit hold.
-- All additive; no backfill.

CREATE TABLE "SceneRepair" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "sceneId" TEXT,
    "sceneIndex" INTEGER NOT NULL,
    "sourceVersion" INTEGER NOT NULL,
    "targetVersion" INTEGER,
    "instruction" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "estimateMicroUsd" INTEGER NOT NULL DEFAULT 0,
    "affectedAssets" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "jobId" TEXT,
    "idempotencyKey" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SceneRepair_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SceneRepair_videoId_sceneIndex_idx" ON "SceneRepair"("videoId", "sceneIndex");
CREATE INDEX "SceneRepair_organizationId_idx" ON "SceneRepair"("organizationId");

ALTER TABLE "SceneRepair" ADD CONSTRAINT "SceneRepair_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SceneRepair" ADD CONSTRAINT "SceneRepair_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The idempotency law, DB-enforced: one row per logical work item.
ALTER TABLE "Job" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "Job_idempotencyKey_key" ON "Job"("idempotencyKey");

-- The opt-in per-project spend ceiling (null = no ceiling).
ALTER TABLE "Video" ADD COLUMN "spendCeilingMicro" INTEGER;
