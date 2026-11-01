-- Stage 7 (T-7.5) — billing scaffolding.
--
-- Three plans per the MASTER_PLAN §5 design:
--   starter: free / low monthly credits, 1080p exports, basic templates.
--   creator: paid monthly, advanced AI Director, character consistency,
--            premium voices, advanced editing, priority rendering.
--   studio:  paid monthly, multiple team members, shared projects, higher
--            limits, team management, priority support.
--
-- A Subscription row attaches a user to a plan with a Stripe customer id +
-- subscription id (when paid) and a current period end. The Subscription is
-- the source of truth for "what can this user do right now"; the Stripe
-- webhook updates it on `invoice.paid` / `customer.subscription.updated`.
--
-- CreditGrant rows are monthly credit allotments per Subscription; the
-- remaining balance is the sum of grants minus the CreditLedger's spent rows.
-- The ledger is append-only — every credit spend (AI call, render minute,
-- publish) writes a row with the cost in microcredits (1e-6 USD); the
-- reconciliation test sums the ledger against UsageRecord to verify exact
-- accounting.
--
-- Free tier: a Subscription row with planId="starter" and no Stripe ids is
-- created on registration (T-7.5 does NOT auto-create; the resolver returns
-- the default starter plan when no row exists). This keeps the schema clean
-- and lets the billing integration be added without a migration on existing
-- users.

CREATE TABLE "Plan" (
    "id"          TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "tier"        TEXT NOT NULL, -- starter | creator | studio
    "monthlyCredits"     INTEGER NOT NULL DEFAULT 0,
    "maxResolution"      TEXT NOT NULL DEFAULT '1080p',
    "priorityRendering"  BOOLEAN NOT NULL DEFAULT false,
    "teamMembers"        INTEGER NOT NULL DEFAULT 1,
    "isActive"           BOOLEAN NOT NULL DEFAULT true,
    "createdAt"  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP NOT NULL,
    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Subscription" (
    "id"              TEXT NOT NULL,
    "userId"          TEXT NOT NULL,
    "planId"           TEXT NOT NULL,
    "stripeCustomerId"     TEXT,
    "stripeSubscriptionId" TEXT,
    "status"          TEXT NOT NULL DEFAULT 'active', -- active | past_due | canceled | trialing
    "currentPeriodEnd" TIMESTAMP,
    "createdAt"       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP NOT NULL,
    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Subscription_userId_key" ON "Subscription"("userId");
CREATE INDEX "Subscription_stripeCustomerId_idx" ON "Subscription"("stripeCustomerId");
CREATE INDEX "Subscription_stripeSubscriptionId_idx" ON "Subscription"("stripeSubscriptionId");

CREATE TABLE "CreditGrant" (
    "id"              TEXT NOT NULL,
    "userId"          TEXT NOT NULL,
    "subscriptionId"  TEXT NOT NULL,
    "grantedCredits"  INTEGER NOT NULL, -- credits granted this period
    "periodStart"     TIMESTAMP NOT NULL,
    "periodEnd"       TIMESTAMP NOT NULL,
    "createdAt"       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CreditGrant_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CreditGrant_userId_periodEnd_idx" ON "CreditGrant"("userId", "periodEnd");

CREATE TABLE "CreditLedger" (
    "id"              TEXT NOT NULL,
    "userId"          TEXT NOT NULL,
    "subscriptionId"  TEXT,
    "kind"            TEXT NOT NULL, -- ai_call | render_minute | publish | storage | topup | refund
    "microCredits"    INTEGER NOT NULL, -- signed (positive = spent, negative = refunded)
    "usageRecordId"   TEXT, -- link to UsageRecord for reconciliation
    "note"            TEXT,
    "createdAt"       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CreditLedger_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CreditLedger_userId_createdAt_idx" ON "CreditLedger"("userId", "createdAt");

ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE;
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planId_fkey"
    FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT;
ALTER TABLE "CreditGrant" ADD CONSTRAINT "CreditGrant_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE;
ALTER TABLE "CreditGrant" ADD CONSTRAINT "CreditGrant_subscriptionId_fkey"
    FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE;
ALTER TABLE "CreditLedger" ADD CONSTRAINT "CreditLedger_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE;
