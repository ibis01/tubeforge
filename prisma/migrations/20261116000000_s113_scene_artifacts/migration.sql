-- S113 — Stage 2 of Scene-Level Editing & Repair: the SceneArtifact
-- provenance table + the UsageRecord bridge columns
-- (docs/design/scene-level-editing-reconciliation.md §9, Stage 2).
--
-- SceneArtifact: one row per GENERATED scene artifact — the full composed
-- prompt (discarded at generation time before this table existed), the input
-- hash, provider/model, the revision it was built from, and the accumulated
-- cost of producing it. Unique on (videoId, storageKey, inputHash): same
-- inputs at the same key are the same artifact; a new input at the same key
-- supersedes the prior rows (status stale — history stays).
--
-- UsageRecord gains three PLAIN columns (videoId / sceneIndex / artifactId)
-- with deliberately NO foreign keys: usage rows are billing evidence and
-- must survive video deletion. Additive on both sides; no backfill.

CREATE TABLE "SceneArtifact" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "sceneId" TEXT,
    "sceneIndex" INTEGER NOT NULL,
    "revisionVersion" INTEGER,
    "type" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "inputHash" TEXT NOT NULL,
    "provider" TEXT,
    "model" TEXT,
    "prompt" TEXT,
    "costMicroUsd" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "bytes" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SceneArtifact_pkey" PRIMARY KEY ("id")
);

-- One artifact per (key, input): re-generating with the SAME inputs is
-- idempotent; a NEW input at the same key is a new row (the old one stales).
CREATE UNIQUE INDEX "SceneArtifact_videoId_storageKey_inputHash_key" ON "SceneArtifact"("videoId", "storageKey", "inputHash");

-- The per-scene provenance lookups (the history panel + Stage 3's stale check).
CREATE INDEX "SceneArtifact_videoId_sceneIndex_type_idx" ON "SceneArtifact"("videoId", "sceneIndex", "type");

-- Tenant scoping (tenant-db.ts ORG_SCOPED_MODELS).
CREATE INDEX "SceneArtifact_organizationId_idx" ON "SceneArtifact"("organizationId");

-- Provenance dies with its project; the org cascade mirrors every other
-- tenant-scoped content row.
ALTER TABLE "SceneArtifact" ADD CONSTRAINT "SceneArtifact_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SceneArtifact" ADD CONSTRAINT "SceneArtifact_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The UsageRecord bridge: plain columns, NO FK (billing evidence survives
-- video deletion by design — see the schema comment).
ALTER TABLE "UsageRecord" ADD COLUMN "videoId" TEXT;
ALTER TABLE "UsageRecord" ADD COLUMN "sceneIndex" INTEGER;
ALTER TABLE "UsageRecord" ADD COLUMN "artifactId" TEXT;

-- Per-video spend queries (Stage 4's per-project ceiling admission reads
-- this shape: WHERE videoId = ? over a time-ordered scan).
CREATE INDEX "UsageRecord_videoId_createdAt_idx" ON "UsageRecord"("videoId", "createdAt");
