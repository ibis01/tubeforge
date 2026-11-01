-- Stage 7.1 — Billing Integrity and Security.
--
-- Fixes the five billing defects found in the pre-launch review:
--   (2) mixed credit units   → CreditGrant.grantedCredits renamed to
--       grantedMicroCredits: ALL ledger math is in microCredits
--       (1 UI credit = 1,000 microCredits, billing.ts MICROS_PER_CREDIT).
--   (5) duplicate credit grants → CreditGrant.stripeInvoiceId (unique) is
--       the invoice.paid idempotency key; invoice grants upsert on it, so
--       a retried delivery can never grant twice. ProcessedWebhookEvent
--       additionally records every handled Stripe event id (create-then-
--       handle) so ANY handler replay is a no-op ack.
--
-- Pre-production data note: the dev grant rows written before this change
-- carried UI credits in the old column; production has none (billing was
-- never live). The rename (drop + add) intentionally resets dev grants —
-- the next invoice.paid re-grants in the correct unit.

-- (2) canonical credit unit: microCredits everywhere
ALTER TABLE "CreditGrant" RENAME COLUMN "grantedCredits" TO "grantedMicroCredits";

-- (5) invoice-level idempotency for credit grants
ALTER TABLE "CreditGrant" ADD COLUMN "stripeInvoiceId" TEXT;
CREATE UNIQUE INDEX "CreditGrant_stripeInvoiceId_key" ON "CreditGrant"("stripeInvoiceId");

-- (5) event-level idempotency for the whole webhook handler
CREATE TABLE "ProcessedWebhookEvent" (
    "id"         TEXT NOT NULL, -- Stripe event id (evt_…)
    "type"       TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProcessedWebhookEvent_pkey" PRIMARY KEY ("id")
);
