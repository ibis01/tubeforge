-- Stage 5 — AI Director.
--
-- 1. Video.shotList        JSON DirectorPlan from the LLM director pass
--                          (per-scene shot list: framing / camera / lens /
--                          composition / durations / transition-in / motion
--                          hint / visual mood). Plain TEXT like every other
--                          JSON column — SQLite mirror and Postgres behave
--                          identically; no filtering is ever done on it.
-- 2. Video.directorState   null | proposed | approved | dismissed — the
--                          human-approval gate ("AI suggests, human approves").
-- 3. Video.consistency     JSON ContinuityReport from the VLM per-scene
--                          character-continuity check (scores + flags).
-- 4. Character.referenceImages  JSON array of storage keys — the character's
--                          reference image library (identity locking + the
--                          continuity check compares generated scenes to it).
-- 5. CharacterAppearance   per-scene outfit / accessory / mood tracking for
--                          the recurring cast. One row per
--                          (video, scene, character) — unique-indexed so a
--                          re-run of the director pass upserts in place.

ALTER TABLE "Video" ADD COLUMN "shotList" TEXT;
ALTER TABLE "Video" ADD COLUMN "directorState" TEXT;
ALTER TABLE "Video" ADD COLUMN "consistency" TEXT;
ALTER TABLE "Character" ADD COLUMN "referenceImages" TEXT;

-- CreateTable
CREATE TABLE "CharacterAppearance" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "characterId" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "sceneIndex" INTEGER NOT NULL,
    "outfit" TEXT,
    "accessory" TEXT,
    "mood" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "CharacterAppearance_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CharacterAppearance_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CharacterAppearance_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE UNIQUE INDEX "CharacterAppearance_videoId_sceneIndex_characterId_key" ON "CharacterAppearance"("videoId", "sceneIndex", "characterId");

-- CreateIndex
CREATE INDEX "CharacterAppearance_organizationId_idx" ON "CharacterAppearance"("organizationId");

-- CreateIndex
CREATE INDEX "CharacterAppearance_characterId_idx" ON "CharacterAppearance"("characterId");
