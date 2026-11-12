-- S100 / P0.2 — renewable leases + fencing tokens for the durable queue
-- (docs/production-readiness.md, the concurrent-worker + stale-worker gate).
--
-- leaseToken is MONOTONIC per job: incremented on every claim and on every
-- expired-lease reap. Terminal writes are conditional on the current token,
-- so a worker that lost its lease physically cannot overwrite the newer
-- claimant — its results are discarded (the fencing law).
--
-- leaseExpiresAt is the lease deadline. The executing process renews it at
-- TTL/3 (TUBEFORGE_LEASE_TTL_MS, default 90s); any process may reap rows
-- whose deadline passed back to pending, bumping the token.
--
-- NULL leaseExpiresAt = a pre-lease legacy row (or a pending row): legacy
-- rows keep the boot-recovery contract (claimIsStale / pid checks), and the
-- reap scan never matches NULL — the two recovery paths compose.

ALTER TABLE "Job" ADD COLUMN "leaseToken" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Job" ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);

-- The reap scan: running rows whose lease expired.
CREATE INDEX "Job_status_leaseExpiresAt_idx" ON "Job"("status", "leaseExpiresAt");
