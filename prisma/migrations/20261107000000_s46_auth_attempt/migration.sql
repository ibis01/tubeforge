-- S46 — durable auth throttling (roadmap P1-6).
--
-- One row per FAILED credential proof (login wrong-password +
-- change-password wrong-current); the 10-minute sliding window is counted
-- in SQL. Replaces the process-local Map that wiped on every deploy and
-- disagreed across web/worker instances. Additive table — no existing row
-- is touched; the old in-memory state simply ages out (worst case: one IP
-- that was mid-lockout at deploy time gets a fresh window).

-- CreateTable
CREATE TABLE "AuthAttempt" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuthAttempt_key_at_idx" ON "AuthAttempt"("key", "at");
