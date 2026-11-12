-- S101 / P0.3 — atomic storage quota admission with durable in-flight holds
-- (docs/production-readiness.md, the concurrent-uploads-cannot-exceed-quota gate).
--
-- StorageUsage.bytes keeps counting COMMITTED bytes only. A StorageReservation
-- row is the durable record of IN-FLIGHT bytes: admission reads the committed
-- counter + sums the org's live holds + checks the ceiling + inserts this
-- upload's hold inside ONE serializable transaction, so two concurrent
-- uploads can never both pass (the DB serializes the racers — the loser sees
-- the winner's hold and is refused).
--
-- Settle (object landed) deletes the hold and moves the real delta
-- (actual - replaces) into the counter. Release on a failed upload deletes
-- the hold. The expiry sweep (TUBEFORGE_STORAGE_RESERVATION_TTL_MS, default
-- 1h) drops holds a crashed process left behind — a hold never moved the
-- committed counter, so dropping one frees exactly the bytes it reserved.

CREATE TABLE "StorageReservation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "bytes" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StorageReservation_pkey" PRIMARY KEY ("id")
);

-- The admission's in-flight SUM scan.
CREATE INDEX "StorageReservation_organizationId_idx" ON "StorageReservation"("organizationId");

-- The expiry sweep scan.
CREATE INDEX "StorageReservation_expiresAt_idx" ON "StorageReservation"("expiresAt");

ALTER TABLE "StorageReservation" ADD CONSTRAINT "StorageReservation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
