-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Channel" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "niche" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Character" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT,
    "personality" TEXT,
    "appearance" TEXT,
    "identityAnchor" TEXT,
    "voice" TEXT NOT NULL DEFAULT 'jam',
    "artStyle" TEXT NOT NULL DEFAULT 'cinematic',
    "hasPortrait" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Character_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Video" (
    "id" TEXT NOT NULL,
    "title" TEXT,
    "topic" TEXT NOT NULL,
    "niche" TEXT NOT NULL,
    "tone" TEXT NOT NULL DEFAULT 'informative',
    "length" TEXT NOT NULL DEFAULT 'medium',
    "script" TEXT,
    "description" TEXT,
    "tags" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "voice" TEXT NOT NULL DEFAULT 'jam',
    "ttsSpeed" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "thumbStyle" TEXT NOT NULL DEFAULT 'cinematic',
    "voiceSource" TEXT NOT NULL DEFAULT 'tts',
    "voiceLabel" TEXT,
    "format" TEXT NOT NULL DEFAULT 'script',
    "renderMode" TEXT NOT NULL DEFAULT 'kenburns',
    "scenes" TEXT,
    "hasStoryboard" BOOLEAN NOT NULL DEFAULT false,
    "hasVideo" BOOLEAN NOT NULL DEFAULT false,
    "videoDuration" DOUBLE PRECISION,
    "hasVoiceover" BOOLEAN NOT NULL DEFAULT false,
    "hasThumbnail" BOOLEAN NOT NULL DEFAULT false,
    "audioDuration" DOUBLE PRECISION,
    "wordCount" INTEGER,
    "error" TEXT,
    "channelId" TEXT,
    "characterId" TEXT,
    "verifyReport" TEXT,
    "commentsKit" TEXT,
    "youtubeUrl" TEXT,
    "publishedAt" TIMESTAMP(3),
    "hasShort" BOOLEAN NOT NULL DEFAULT false,
    "shortScene" INTEGER,
    "shortDuration" DOUBLE PRECISION DEFAULT 0,
    "musicEnabled" BOOLEAN,
    "musicTrackId" TEXT,
    "musicVolume" DOUBLE PRECISION,
    "musicFadeIn" DOUBLE PRECISION,
    "musicFadeOut" DOUBLE PRECISION,
    "musicDucking" BOOLEAN,
    "musicDuckingIntensity" TEXT,
    "musicMood" TEXT,
    "motionMode" TEXT,
    "motionIntensity" INTEGER,
    "motionCurve" TEXT,
    "motionVary" BOOLEAN,
    "transitionStyle" TEXT,
    "transitionDuration" DOUBLE PRECISION,
    "brandAccent" TEXT,
    "brandLogoOn" BOOLEAN,
    "qcReport" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Video_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Activity" (
    "id" TEXT NOT NULL,
    "videoId" TEXT,
    "stage" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'info',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchSession" (
    "id" TEXT NOT NULL,
    "niche" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "ideas" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResearchSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduleSlot" (
    "id" TEXT NOT NULL,
    "videoId" TEXT,
    "channelId" TEXT,
    "title" TEXT NOT NULL,
    "slotDate" TIMESTAMP(3) NOT NULL,
    "timeOfDay" TEXT NOT NULL DEFAULT '18:00',
    "note" TEXT,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduleSlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VideoStat" (
    "id" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 0,
    "likes" INTEGER NOT NULL DEFAULT 0,
    "comments" INTEGER NOT NULL DEFAULT 0,
    "favorites" INTEGER NOT NULL DEFAULT 0,
    "snapshotAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VideoStat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "VoiceProfile" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'zhipu',
    "providerVoiceId" TEXT NOT NULL,
    "sourceLabel" TEXT,
    "durationSec" DOUBLE PRECISION,
    "auditionWav" TEXT,
    "sampleWav" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VoiceProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MusicTrack" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "moods" TEXT NOT NULL DEFAULT '',
    "genre" TEXT,
    "durationSec" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "filePath" TEXT NOT NULL,
    "fileSizeBytes" INTEGER NOT NULL DEFAULT 0,
    "isOriginal" BOOLEAN NOT NULL DEFAULT false,
    "licenseType" TEXT NOT NULL DEFAULT 'TubeForge Original',
    "sourceUrl" TEXT,
    "commercialUse" BOOLEAN NOT NULL DEFAULT true,
    "attributionRequired" BOOLEAN NOT NULL DEFAULT false,
    "attributionText" TEXT,
    "licenseEvidence" TEXT,
    "downloadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "contentIdNotes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MusicTrack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "progress" DOUBLE PRECISION,
    "label" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Video_status_idx" ON "Video"("status");

-- CreateIndex
CREATE INDEX "Video_createdAt_idx" ON "Video"("createdAt");

-- CreateIndex
CREATE INDEX "Activity_createdAt_idx" ON "Activity"("createdAt");

-- CreateIndex
CREATE INDEX "ResearchSession_createdAt_idx" ON "ResearchSession"("createdAt");

-- CreateIndex
CREATE INDEX "ScheduleSlot_slotDate_idx" ON "ScheduleSlot"("slotDate");

-- CreateIndex
CREATE INDEX "VideoStat_videoId_snapshotAt_idx" ON "VideoStat"("videoId", "snapshotAt");

-- CreateIndex
CREATE INDEX "VoiceProfile_isActive_idx" ON "VoiceProfile"("isActive");

-- CreateIndex
CREATE INDEX "VoiceProfile_provider_idx" ON "VoiceProfile"("provider");

-- CreateIndex
CREATE INDEX "MusicTrack_isActive_idx" ON "MusicTrack"("isActive");

-- CreateIndex
CREATE INDEX "Job_entityId_kind_idx" ON "Job"("entityId", "kind");

-- CreateIndex
CREATE INDEX "Job_status_idx" ON "Job"("status");

-- CreateIndex
CREATE INDEX "Job_startedAt_idx" ON "Job"("startedAt");

-- AddForeignKey
ALTER TABLE "Video" ADD CONSTRAINT "Video_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Video" ADD CONSTRAINT "Video_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleSlot" ADD CONSTRAINT "ScheduleSlot_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VideoStat" ADD CONSTRAINT "VideoStat_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

