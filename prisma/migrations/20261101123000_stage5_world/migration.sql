-- Stage 5 (module C) — the World library: recurring LOCATIONS and PROPS.
--
-- The continuity companions to the cast library: the AI Director references
-- these by name in its per-scene plan ("locations" / "props" arrays), and
-- under an approved plan their descriptions weave into scene image prompts so
-- recurring places and objects stay visually consistent across scenes, the
-- same way the cast's identityAnchor + referenceImages do.
--
-- referenceImages mirrors Character.referenceImages: JSON array of storage
-- keys (T-3.7 driver namespace), oldest first. Plain TEXT — no filtering is
-- ever done on it, so SQLite and Postgres behave identically.

-- CreateTable
CREATE TABLE "Location" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "referenceImages" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Location_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Prop" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "referenceImages" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Prop_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Location_organizationId_idx" ON "Location"("organizationId");

-- CreateIndex
CREATE INDEX "Prop_organizationId_idx" ON "Prop"("organizationId");
