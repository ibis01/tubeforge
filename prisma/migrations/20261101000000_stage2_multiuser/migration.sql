-- Stage 2 — multi-user SaaS architecture (R-CRIT-1 + R-CRIT-2).
--
-- Hand-shaped from `prisma migrate diff` (old schema @ Stage 1 -> Stage 2):
--   * organizationId is added with DEFAULT 'default' so Postgres backfills
--     existing rows in the same statement, then the default is DROPPED at the
--     end of the migration — the application must always provide the tenant
--     explicitly (the tenant-db client extension injects it per request).
--   * The single-user Setting table is RENAMED to LegacySetting, never dropped:
--     its rows survive until the first owner claims them via
--     POST /api/auth/register (prove-the-old-password flow), which migrates
--     them into the owner's UserSetting / YouTubeAccount / ProviderCredential /
--     User.passwordHash. Dropped entirely in Stage 3.
--   * The bootstrap organization 'default' parks all legacy content until the
--     claim transfers it to the first owner's personal organization.
--   * A partial unique index guarantees at most ONE owner per organization —
--     Prisma's schema DSL cannot express partial indexes.

-- CreateTable ---------------------------------------------------------------

CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT,
    "avatarUrl" TEXT,
    "emailVerifiedAt" TIMESTAMP(3),
    "emailVerifyTokenHash" TEXT,
    "emailVerifyExpiresAt" TIMESTAMP(3),
    "passwordResetTokenHash" TEXT,
    "passwordResetExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UserSetting" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "UserSetting_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "YouTubeAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "channelTitle" TEXT,
    "channelThumb" TEXT,
    "refreshToken" TEXT NOT NULL,
    "accessToken" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "privacyStatus" TEXT NOT NULL DEFAULT 'unlisted',
    "categoryId" TEXT NOT NULL DEFAULT '27',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "YouTubeAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProviderCredential" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "baseUrl" TEXT,
    "apiKey" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderCredential_pkey" PRIMARY KEY ("id")
);

-- Bootstrap organization — must exist BEFORE the foreign keys below validate
-- the backfilled organizationId='default' rows.
INSERT INTO "Organization" ("id", "name", "slug", "createdAt", "updatedAt")
VALUES ('default', 'Studio', 'studio', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT DO NOTHING;

-- AlterTable ----------------------------------------------------------------
-- DEFAULT 'default' backfills every pre-Stage-2 row into the bootstrap org in
-- the same statement; the default is dropped at the end of this migration.

ALTER TABLE "Channel" ADD COLUMN "organizationId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "Character" ADD COLUMN "organizationId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "Video" ADD COLUMN "organizationId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "Activity" ADD COLUMN "organizationId" TEXT NOT NULL DEFAULT 'default', ADD COLUMN "userId" TEXT;
ALTER TABLE "ResearchSession" ADD COLUMN "organizationId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "ScheduleSlot" ADD COLUMN "organizationId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "VideoStat" ADD COLUMN "organizationId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "VoiceProfile" ADD COLUMN "organizationId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "MusicTrack" ADD COLUMN "organizationId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "Job" ADD COLUMN "organizationId" TEXT NOT NULL DEFAULT 'default', ADD COLUMN "userId" TEXT;

-- Rename, never drop: the single-user Setting rows survive in LegacySetting
-- until the first owner's claim migrates them (see ROADMAP Stage 2).
ALTER TABLE "Setting" RENAME TO "LegacySetting";

-- CreateIndex ---------------------------------------------------------------

CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "User_emailVerifyTokenHash_key" ON "User"("emailVerifyTokenHash");
CREATE UNIQUE INDEX "User_passwordResetTokenHash_key" ON "User"("passwordResetTokenHash");
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");
CREATE INDEX "Membership_organizationId_idx" ON "Membership"("organizationId");
CREATE UNIQUE INDEX "Membership_userId_organizationId_key" ON "Membership"("userId", "organizationId");
CREATE INDEX "Session_userId_idx" ON "Session"("userId");
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");
CREATE UNIQUE INDEX "UserSetting_userId_key_key" ON "UserSetting"("userId", "key");
CREATE UNIQUE INDEX "YouTubeAccount_userId_channelId_key" ON "YouTubeAccount"("userId", "channelId");
CREATE UNIQUE INDEX "ProviderCredential_userId_capability_provider_key" ON "ProviderCredential"("userId", "capability", "provider");
CREATE INDEX "Channel_organizationId_idx" ON "Channel"("organizationId");
CREATE INDEX "Character_organizationId_idx" ON "Character"("organizationId");
CREATE INDEX "Video_organizationId_idx" ON "Video"("organizationId");
CREATE INDEX "Activity_organizationId_idx" ON "Activity"("organizationId");
CREATE INDEX "ResearchSession_organizationId_idx" ON "ResearchSession"("organizationId");
CREATE INDEX "ScheduleSlot_organizationId_idx" ON "ScheduleSlot"("organizationId");
CREATE INDEX "VideoStat_organizationId_idx" ON "VideoStat"("organizationId");
CREATE INDEX "VoiceProfile_organizationId_idx" ON "VoiceProfile"("organizationId");
CREATE INDEX "MusicTrack_organizationId_idx" ON "MusicTrack"("organizationId");
CREATE INDEX "Job_organizationId_idx" ON "Job"("organizationId");

-- AddForeignKey -------------------------------------------------------------

ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UserSetting" ADD CONSTRAINT "UserSetting_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "YouTubeAccount" ADD CONSTRAINT "YouTubeAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderCredential" ADD CONSTRAINT "ProviderCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Channel" ADD CONSTRAINT "Channel_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Character" ADD CONSTRAINT "Character_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Video" ADD CONSTRAINT "Video_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ResearchSession" ADD CONSTRAINT "ResearchSession_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScheduleSlot" ADD CONSTRAINT "ScheduleSlot_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VideoStat" ADD CONSTRAINT "VideoStat_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VoiceProfile" ADD CONSTRAINT "VoiceProfile_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MusicTrack" ADD CONSTRAINT "MusicTrack_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Job" ADD CONSTRAINT "Job_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Job" ADD CONSTRAINT "Job_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- DropDefault ---------------------------------------------------------------
-- The backfill default is removed: every write must state its tenant
-- (injected by the tenant-db client extension from the request context).

ALTER TABLE "Channel" ALTER COLUMN "organizationId" DROP DEFAULT;
ALTER TABLE "Character" ALTER COLUMN "organizationId" DROP DEFAULT;
ALTER TABLE "Video" ALTER COLUMN "organizationId" DROP DEFAULT;
ALTER TABLE "Activity" ALTER COLUMN "organizationId" DROP DEFAULT;
ALTER TABLE "ResearchSession" ALTER COLUMN "organizationId" DROP DEFAULT;
ALTER TABLE "ScheduleSlot" ALTER COLUMN "organizationId" DROP DEFAULT;
ALTER TABLE "VideoStat" ALTER COLUMN "organizationId" DROP DEFAULT;
ALTER TABLE "VoiceProfile" ALTER COLUMN "organizationId" DROP DEFAULT;
ALTER TABLE "MusicTrack" ALTER COLUMN "organizationId" DROP DEFAULT;
ALTER TABLE "Job" ALTER COLUMN "organizationId" DROP DEFAULT;

-- One owner per organization (partial index — not expressible in the Prisma DSL)
CREATE UNIQUE INDEX "Membership_one_owner_per_org" ON "Membership"("organizationId") WHERE "role" = 'owner';
