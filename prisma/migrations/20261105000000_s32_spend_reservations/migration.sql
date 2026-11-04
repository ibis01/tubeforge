-- S32 — the $5 door's durable ledger. S27 kept outstanding reservations in
-- process memory and bootstrapped the recorded total from a SUM of
-- UsageRecord rows; a crash mid-call or a connection-test dispatch (outside
-- aiCall, no UsageRecord row) lost spend on restart. This table is the
-- gate's single source of truth: admitDispatch writes a pending row, settle
-- updates it to settled, bootRecorded rebuilds from it, and a DB boot
-- failure blocks paid dispatches (fail-closed).

-- CreateTable
CREATE TABLE "SpendReservation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "estimatedMicroUsd" INTEGER NOT NULL,
    "actualCostMicroUsd" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "usageRecordId" TEXT,
    "admittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settledAt" TIMESTAMP(3),

    CONSTRAINT "SpendReservation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SpendReservation_provider_status_idx" ON "SpendReservation"("provider", "status");

-- CreateIndex
CREATE INDEX "SpendReservation_status_idx" ON "SpendReservation"("status");

-- CreateIndex
CREATE INDEX "SpendReservation_userId_status_idx" ON "SpendReservation"("userId", "status");

-- AddForeignKey
ALTER TABLE "SpendReservation" ADD CONSTRAINT "SpendReservation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpendReservation" ADD CONSTRAINT "SpendReservation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
