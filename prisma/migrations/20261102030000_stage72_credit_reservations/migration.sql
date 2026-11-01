-- Stage 7.2 — credit reservations (pre-call AI spend holds).
--
-- Problem B (external review): AI provider calls executed BEFORE the credit
-- check, so an unaffordable call still ran — the ledger merely refused to
-- record it. The fix reserves the estimated cost BEFORE the call:
--
--   reserveCredits()   → one positive `hold` row (transactional check)
--   settleCreditHold() → ONE settlement row per hold, signed:
--        `adjustment`   — actual vs estimate delta (ok calls)
--        `hold_release` — full release (failed calls)
--
-- `reconcilesId` carries the hold's ledger id and is UNIQUE: the database
-- itself makes a double settlement (double-deduct) physically impossible,
-- the same way stripeInvoiceId's unique index pins grants to one invoice.

ALTER TABLE "CreditLedger" ADD COLUMN "reconcilesId" TEXT;

CREATE UNIQUE INDEX "CreditLedger_reconcilesId_key" ON "CreditLedger"("reconcilesId");
