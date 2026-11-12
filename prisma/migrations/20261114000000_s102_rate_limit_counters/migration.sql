-- S102 / P0.4 — the shared per-IP rate limiter's durable fixed-window
-- counters (docs/production-readiness.md, the multi-instance + spoofing gate).
--
-- One row per (tiered key, 60s window). The admission is a raw upsert that
-- increments atomically and RETURNS the new count — the DB serializes the
-- racers, so two instances cannot both admit the overflow. Survives deploys
-- (in-memory buckets die with the process and are per-instance by nature).
-- key = "<r|w>:<client ip>" — the IP comes from the trusted-proxy law
-- (shared-rate-limit.ts), not the spoofable first X-Forwarded-For value.
-- windowStart is epoch SECONDS in a BIGINT (int32 epoch dies in 2038).

CREATE TABLE "RateLimitCounter" (
    "key" TEXT NOT NULL,
    "windowStart" BIGINT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitCounter_pkey" PRIMARY KEY ("key","windowStart")
);

-- The sweep scan.
CREATE INDEX "RateLimitCounter_updatedAt_idx" ON "RateLimitCounter"("updatedAt");
