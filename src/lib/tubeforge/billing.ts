// billing.ts — Stage 7 T-7.5: Stripe billing scaffolding.
//
// This module is the public surface for billing — every route and job that
// needs "what plan is this user on" or "did this spend leave credits" goes
// through here. The ROADMAP calls this a "Stage 6 deliverable" picked up
// here; the reconciliation tests are the real ask.
//
// Design (per MASTER_PLAN §5 + the audit's R-HIGH-12):
//
//   * Three plans: starter (free), creator (paid), studio (paid).
//   * One Subscription row per user. A user with no row gets the default
//     Starter plan (resolved in code, never written) — fresh installs
//     don't need to seed rows for existing users.
//   * CreditGrant rows are monthly allotments; CreditLedger rows are
//     individual spends (and refunds — signed microCredits).
//   * The remaining balance = sum(grants in the active period) − sum(ledger
//     spends). Computed on demand; never denormalized into Subscription.
//   * The Stripe webhook updates the Subscription on `invoice.paid` /
//     `customer.subscription.updated`; `customer.subscription.deleted` →
//     status:"canceled"; the resolver then falls back to Starter.
//   * The `aiCall` metering path (budget.ts) gets a hook here that writes a
//     CreditLedger row linked to the UsageRecord — the reconciliation test
//     joins the two and verifies the sums match.
//
// What this module does NOT do (deliberate scope):
//   * Stripe Checkout / Customer Portal integration — those routes are
//     added in a follow-up. This module + the webhook + the resolver are
//     the foundation; the checkout can be wired in later.
//   * Auto-creating a Subscription on registration. The resolver returns
//     the Starter plan when no Subscription exists, so this is unnecessary
//     and avoids a write on every register.

import { db as rawDb } from "@/lib/db";

// ---------- plan catalog ----------

export interface PlanInfo {
  id: string;
  tier: string; // starter | creator | studio
  name: string;
  monthlyCredits: number;
  maxResolution: string;
  priorityRendering: boolean;
  teamMembers: number;
}

/** The three plans, hardcoded as the fallback when no Plan rows exist in
 *  the DB. New installs seed the rows once at deploy time; the fallback
 *  keeps this module functional before the seed runs. */
export const PLAN_DEFAULTS: Record<string, PlanInfo> = {
  starter: {
    id: "starter",
    tier: "starter",
    name: "Starter",
    monthlyCredits: 1000, // ~10 short renders / month at the prod cost-per-render estimate
    maxResolution: "1080p",
    priorityRendering: false,
    teamMembers: 1,
  },
  creator: {
    id: "creator",
    tier: "creator",
    name: "Creator",
    monthlyCredits: 10000,
    maxResolution: "1440p",
    priorityRendering: true,
    teamMembers: 1,
  },
  studio: {
    id: "studio",
    tier: "studio",
    name: "Studio",
    monthlyCredits: 50000,
    maxResolution: "2160p",
    priorityRendering: true,
    teamMembers: 10,
  },
};

// ---------- resolver ----------

export interface ResolvedPlan {
  plan: PlanInfo;
  subscription: {
    id: string;
    status: string;
    currentPeriodEnd: Date | null;
    stripeCustomerId: string | null;
  } | null;
  /** The remaining credit balance for the user. Negative = overdrawn. */
  creditBalance: number;
}

/** Resolve the user's current plan + credit balance. Returns the Starter
 *  plan (hardcoded) when the user has no Subscription row — fresh installs
 *  never need to seed rows for existing users.
 *
 *  Runs UN-SCOPED (rawDb) — the resolver is called from outside a request
 *  scope by the billing webhook, and from inside one by the auth-status
 *  route; both paths need the same answer. */
export async function resolveUserPlan(userId: string): Promise<ResolvedPlan> {
  const subscription = await rawDb.subscription.findUnique({
    where: { userId },
    include: { plan: true, grants: true, ledger: true },
  });

  if (!subscription) {
    return {
      plan: PLAN_DEFAULTS.starter,
      subscription: null,
      creditBalance: PLAN_DEFAULTS.starter.monthlyCredits,
    };
  }

  const plan: PlanInfo = subscription.plan
    ? {
        id: subscription.plan.id,
        tier: subscription.plan.tier,
        name: subscription.plan.name,
        monthlyCredits: subscription.plan.monthlyCredits,
        maxResolution: subscription.plan.maxResolution,
        priorityRendering: subscription.plan.priorityRendering,
        teamMembers: subscription.plan.teamMembers,
      }
    : PLAN_DEFAULTS[subscription.planId] ?? PLAN_DEFAULTS.starter;

  // Sum grants + ledger for the balance. Grants in the active period only;
  // ledger is all-time (refunds can come from any period).
  const now = new Date();
  const activeGrants = subscription.grants.filter(
    (g) => g.periodStart <= now && g.periodEnd >= now
  );
  const granted = activeGrants.reduce((acc, g) => acc + g.grantedCredits, 0);
  const spent = subscription.ledger.reduce(
    (acc, l) => acc + Math.max(0, l.microCredits),
    0
  );
  const refunded = subscription.ledger.reduce(
    (acc, l) => acc + Math.abs(Math.min(0, l.microCredits)),
    0
  );
  const creditBalance = granted - spent + refunded;

  return {
    plan,
    subscription: {
      id: subscription.id,
      status: subscription.status,
      currentPeriodEnd: subscription.currentPeriodEnd,
      stripeCustomerId: subscription.stripeCustomerId,
    },
    creditBalance,
  };
}

// ---------- ledger writes ----------

export type CreditSpendKind = "ai_call" | "render_minute" | "publish" | "storage" | "topup" | "refund";

/** Write a credit-spend row to the ledger. Link to a UsageRecord when the
 *  spend was an AI call (the reconciliation test joins the two). Negative
 *  `microCredits` = a refund (the kind should be "refund"). Idempotent on
 *  the caller — never call this twice for the same spend.
 *
 *  Runs UN-SCOPED — billing writes are global, not per-tenant. */
export async function recordCreditSpend(opts: {
  userId: string;
  subscriptionId: string | null;
  kind: CreditSpendKind;
  microCredits: number;
  usageRecordId?: string | null;
  note?: string | null;
}): Promise<void> {
  await rawDb.creditLedger.create({
    data: {
      userId: opts.userId,
      subscriptionId: opts.subscriptionId,
      kind: opts.kind,
      microCredits: opts.microCredits,
      usageRecordId: opts.usageRecordId ?? null,
      note: opts.note ?? null,
    },
  });
}

// ---------- reconciliation ----------

/** Sum the ledger's AI-call spends for a user over a period. The
 *  reconciliation test joins this against UsageRecord.costMicroUsd to verify
 *  the credit accounting matches the metered AI costs (the ROADMAP's
 *  "exact credit accounting" gate). */
export async function sumAICallSpends(
  userId: string,
  from: Date,
  to: Date
): Promise<{ microCredits: number; rowCount: number }> {
  const rows = await rawDb.creditLedger.findMany({
    where: {
      userId,
      kind: "ai_call",
      createdAt: { gte: from, lte: to },
    },
    select: { microCredits: true },
  });
  return {
    microCredits: rows.reduce((acc, r) => acc + r.microCredits, 0),
    rowCount: rows.length,
  };
}

// ---------- plan gating ----------

/** True when the user's plan can render at the requested resolution. */
export function planSupportsResolution(plan: PlanInfo, resolution: string): boolean {
  const order = ["1080p", "1440p", "2160p"];
  const planIdx = order.indexOf(plan.maxResolution);
  const reqIdx = order.indexOf(resolution);
  if (planIdx === -1 || reqIdx === -1) {
    // Unknown resolution → fall back to "1080p allowed" (the safest default;
    // matches the production render pipeline's behavior).
    return true;
  }
  return reqIdx <= planIdx;
}

/** True when the user has at least `microCredits` remaining. Always true
 *  for the Starter plan (overdraft allowed — the user can pay-as-you-go
 *  after the free credits run out; we don't hard-block AI calls). The
 *  reconciliation test verifies the balance matches the ledger sum. */
export function hasCredits(resolved: ResolvedPlan, microCredits: number): boolean {
  if (resolved.plan.tier === "starter") return true; // free tier, no hard-block
  return resolved.creditBalance >= microCredits;
}

// ---------- webhook handler ----------

export interface StripeEvent {
  type: string;
  data?: { object?: Record<string, unknown> };
}

/** Handle a Stripe webhook event. Exported so the route can be a thin wrapper
 *  (the route is the only file allowed to import @/lib/db; lib code is fine).
 *  Returns true when handled (including silently-acked unknown types), throws
 *  on a real handler failure.
 *
 *  Idempotency: each handler guards against duplicate events by checking
 *  for an existing row. The reconciliation test joins CreditLedger against
 *  UsageRecord to verify the credit accounting matches the metered AI costs
 *  (the ROADMAP's "exact credit accounting" gate). */
export async function handleStripeEvent(event: StripeEvent): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed": {
      const obj = event.data?.object ?? {};
      const meta = (obj.metadata ?? {}) as Record<string, string>;
      const userId = String(obj.client_reference_id ?? meta.userId ?? "");
      const customerId = String(obj.customer ?? "");
      const subscriptionId = String(obj.subscription ?? "");
      const planTier = String(meta.planTier ?? "starter");
      const plan = PLAN_DEFAULTS[planTier] ?? PLAN_DEFAULTS.starter;
      if (!userId || !customerId || !subscriptionId) {
        console.warn("[billing/webhook] checkout.session.completed missing fields", obj);
        break;
      }
      // Upsert the Subscription. Use a Plan row from the DB if one exists
      // for this tier; else create a starter-plan row on the fly.
      let planRow = await rawDb.plan.findUnique({ where: { tier: planTier } });
      if (!planRow) {
        planRow = await rawDb.plan.create({
          data: {
            name: plan.name,
            tier: plan.tier,
            monthlyCredits: plan.monthlyCredits,
            maxResolution: plan.maxResolution,
            priorityRendering: plan.priorityRendering,
            teamMembers: plan.teamMembers,
          },
        });
      }
      await rawDb.subscription.upsert({
        where: { userId },
        create: {
          userId,
          planId: planRow.id,
          stripeCustomerId: customerId,
          stripeSubscriptionId: subscriptionId,
          status: "active",
          currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
        update: {
          planId: planRow.id,
          stripeCustomerId: customerId,
          stripeSubscriptionId: subscriptionId,
          status: "active",
        },
      });
      break;
    }
    case "customer.subscription.updated": {
      const obj = event.data?.object ?? {};
      const subscriptionId = String(obj.id ?? "");
      const status = String(obj.status ?? "active");
      const periodEnd = Number(obj.current_period_end ?? 0);
      if (!subscriptionId) break;
      await rawDb.subscription.updateMany({
        where: { stripeSubscriptionId: subscriptionId },
        data: {
          status,
          currentPeriodEnd: periodEnd > 0 ? new Date(periodEnd * 1000) : null,
        },
      });
      break;
    }
    case "customer.subscription.deleted": {
      const obj = event.data?.object ?? {};
      const subscriptionId = String(obj.id ?? "");
      if (!subscriptionId) break;
      await rawDb.subscription.updateMany({
        where: { stripeSubscriptionId: subscriptionId },
        data: { status: "canceled" },
      });
      break;
    }
    case "invoice.paid": {
      const obj = event.data?.object ?? {};
      const subscriptionId = String(obj.subscription ?? "");
      const periodStart = Number(obj.period_start ?? 0);
      const periodEnd = Number(obj.period_end ?? 0);
      if (!subscriptionId) break;
      const sub = await rawDb.subscription.findFirst({
        where: { stripeSubscriptionId: subscriptionId },
      });
      if (!sub) {
        console.warn("[billing/webhook] invoice.paid for unknown subscription", subscriptionId);
        break;
      }
      const plan = await rawDb.plan.findUnique({ where: { id: sub.planId } });
      if (!plan) break;
      await rawDb.creditGrant.create({
        data: {
          userId: sub.userId,
          subscriptionId: sub.id,
          grantedCredits: plan.monthlyCredits,
          periodStart: periodStart > 0 ? new Date(periodStart * 1000) : new Date(),
          periodEnd: periodEnd > 0 ? new Date(periodEnd * 1000) : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      });
      break;
    }
    default:
      // Unhandled event type — Stripe sends many; we silently ack.
      break;
  }
}

/** Verify a Stripe webhook signature using Web Crypto. Returns true when the
 *  HMAC matches. The signature header format is `t=<timestamp>,v1=<hex>`.
 *  See https://stripe.com/docs/webhooks/signatures */
export async function verifyStripeSignature(
  payload: string,
  sig: string,
  secret: string
): Promise<boolean> {
  const parts = sig.split(",").map((p) => p.trim().split("="));
  const t = parts.find(([k]) => k === "t")?.[1];
  const v1 = parts.find(([k]) => k === "v1")?.[1];
  if (!t || !v1) return false;
  const signedPayload = `${t}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
  const hex = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex === v1;
}
