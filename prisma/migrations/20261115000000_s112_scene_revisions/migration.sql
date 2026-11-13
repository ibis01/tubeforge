-- S112 — Stage 1 of Scene-Level Editing & Repair: the SceneRevision table
-- (docs/design/scene-level-editing-reconciliation.md §9, Stage 1).
--
-- One IMMUTABLE row per (video, scene, version): every scene-content change
-- lands as a new revision (append-only by construction — no UPDATE path
-- exists in the app besides the head→superseded status flip, which never
-- touches content). sceneId is the STABLE Scene.id minted inside the
-- Video.scenes JSON (indices are positional and shift across epochs; ids are
-- not). content snapshots the UNION slice — the row Scene + its timeline-doc
-- scene — because a scene's editable content spans both documents.
--
-- The unique (videoId, sceneId, version) is the concurrency floor: two
-- writers racing the same head version cannot both mint the next one — the
-- second transaction fails whole (the optimistic-concurrency gate above it
-- turns that into a 409 for humans).
--
-- Additive: new table + FKs, no backfill — the additive-chain migration +
-- self-healing deploy law (the postgres CI lane replays the wedge recovery
-- on every push).

CREATE TABLE "SceneRevision" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "sceneId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "parentVersion" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "changeKind" TEXT NOT NULL DEFAULT 'edit',
    "origin" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SceneRevision_pkey" PRIMARY KEY ("id")
);

-- One version per (video, scene): the append-only law, DB-enforced.
CREATE UNIQUE INDEX "SceneRevision_videoId_sceneId_version_key" ON "SceneRevision"("videoId", "sceneId", "version");

-- The head / approved lookups (latest per scene, latest approved per scene).
CREATE INDEX "SceneRevision_videoId_sceneId_status_idx" ON "SceneRevision"("videoId", "sceneId", "status");

-- Tenant scoping (tenant-db.ts ORG_SCOPED_MODELS).
CREATE INDEX "SceneRevision_organizationId_idx" ON "SceneRevision"("organizationId");

-- The epoch scan: fresh-id minting reads every sceneId a video has EVER used
-- so an epoch regen never reuses a retired scene's identity.
CREATE INDEX "SceneRevision_videoId_changeKind_idx" ON "SceneRevision"("videoId", "changeKind");

-- History dies with its project (Video cascade); the org cascade mirrors
-- every other tenant-scoped content row.
ALTER TABLE "SceneRevision" ADD CONSTRAINT "SceneRevision_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SceneRevision" ADD CONSTRAINT "SceneRevision_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
