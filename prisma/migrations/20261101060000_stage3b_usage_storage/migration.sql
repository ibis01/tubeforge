-- Stage 3 (T-3.7 + T-3.8): storage quota counter + AI cost tracking.

-- AlterTable (T-3.7 — preview artifact flag so the DTO stops probing the FS,
-- which would lie under the s3 driver)
ALTER TABLE "Video" ADD COLUMN "hasPreview" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable (T-3.7 — per-org byte counter backing storage.ts quotas)
CREATE TABLE "StorageUsage" (
    "organizationId" TEXT NOT NULL,
    "bytes" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StorageUsage_pkey" PRIMARY KEY ("organizationId")
);

-- CreateTable (T-3.8 — per-user, per-capability AI usage/cost rows)
CREATE TABLE "UsageRecord" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costMicroUsd" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StorageUsage_organizationId_key" ON "StorageUsage"("organizationId");

-- CreateIndex
CREATE INDEX "UsageRecord_organizationId_createdAt_idx" ON "UsageRecord"("organizationId", "createdAt");
CREATE INDEX "UsageRecord_userId_createdAt_idx" ON "UsageRecord"("userId", "createdAt");
CREATE INDEX "UsageRecord_organizationId_capability_createdAt_idx" ON "UsageRecord"("organizationId", "capability", "createdAt");

-- AddForeignKey
ALTER TABLE "StorageUsage" ADD CONSTRAINT "StorageUsage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UsageRecord" ADD CONSTRAINT "UsageRecord_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UsageRecord" ADD CONSTRAINT "UsageRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
