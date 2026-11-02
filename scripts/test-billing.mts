// Stage 7.1 — Billing Integrity and Security integration suite.
//
// Fixes the five pre-launch billing defects and PINS each one against the
// real SQLite DB + the real webhook route handler (in-process):
//
//   1. Webhook auth is FAIL-CLOSED — every route branch is exercised:
//      secret set + missing header → 401, bad signature → 401, valid
//      signature → 200; secret missing → 401 (dev) / 500 (production);
//      unsigned events ONLY with the explicit dev opt-in env var.
//   2. Canonical credit units — a fresh Creator invoice grant (10,000 UI
//      credits = 10,000,000 microCredits) MUST pass the 50,000-microCredit
//      render pre-check. This is the exact scenario the old mixed-unit
//      resolver failed.
//   3. Ledger linkage — spends attach the user's subscriptionId
//      automatically, and user-scoped balance math counts legacy
//      null-linked rows, so nothing spent can ever resurrect.
//   4. Subscription status rules — active/trialing/past_due/canceled (plus
//      unpaid/unknown) each resolve to the documented access level.
//   5. Idempotent grants — the same invoice/event replayed grants EXACTLY
//      once (event-id table + unique stripeInvoiceId upsert).
//   6. Concurrent spending cannot overspend — parallel transactional
//      check-and-spends against one grant: balance never negative.
//
// Run: npm run test:billing   (needs the local SQLite DB; not in CI)

import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const db = new PrismaClient();

let passed = 0;
let failed = 0;
const failures: string[] = [];
let suite = "";

function suiteStart(name: string) {
  suite = name;
  console.log(`\n◆ ${name}`);
}

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`[${suite}] ${name} — ${msg}`);
    console.error(`  ✗ ${name} — ${msg}`);
  }
}

function ok(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function eq<T>(actual: T, expected: T, label = "value") {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}: expected ${b}, got ${a}`);
}

// --- fixtures -------------------------------------------------------------

const MARK = `s71_${Date.now().toString(36)}`;
const EVENT_IDS: string[] = [];
const USER_IDS: string[] = [];
const PLAN_IDS: string[] = [];
const ORG_IDS: string[] = [];

async function makePaidUser(email: string, status: string, planTier: "creator" | "studio" = "creator") {
  const user = await db.user.create({
    data: { email, passwordHash: `pbkdf2$1$s$${MARK}`, name: "Stage 7.1 fixture" },
  });
  USER_IDS.push(user.id);
  let plan = await db.plan.findUnique({ where: { tier: planTier } });
  if (!plan) {
    plan = await db.plan.create({
      data: {
        name: planTier === "creator" ? "Creator" : "Studio",
        tier: planTier,
        monthlyCredits: planTier === "creator" ? 10000 : 50000,
        maxResolution: planTier === "creator" ? "1440p" : "2160p",
        priorityRendering: true,
        teamMembers: 1,
      },
    });
    PLAN_IDS.push(plan.id);
  }
  const sub = await db.subscription.create({
    data: {
      userId: user.id,
      planId: plan.id,
      stripeCustomerId: `cus_${MARK}_${user.id.slice(-6)}`,
      stripeSubscriptionId: `sub_${MARK}_${user.id.slice(-6)}`,
      status,
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });
  return { user, plan, sub };
}

async function cleanup() {
  for (const id of USER_IDS) await db.user.delete({ where: { id } }).catch(() => {});
  for (const id of ORG_IDS) await db.organization.delete({ where: { id } }).catch(() => {});
  for (const id of PLAN_IDS) await db.plan.delete({ where: { id } }).catch(() => {});
  if (EVENT_IDS.length) {
    await db.processedWebhookEvent.deleteMany({ where: { id: { in: EVENT_IDS } } });
  }
}

/** POST to the REAL route handler in-process. */
async function postWebhook(
  body: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; json: Record<string, unknown> }> {
  const { POST } = await import("../src/app/api/billing/webhook/route");
  const req = new NextRequest("http://localhost:3000/api/billing/webhook", {
    method: "POST",
    body,
    headers: { "content-type": "application/json", ...headers },
  });
  const res = await POST(req);
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    /* error bodies may be empty */
  }
  return { status: res.status, json };
}

/** Build a Stripe-signed payload with node crypto (mirrors the SDK). */
function stripeSign(secret: string, body: string): string {
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

const billing = await import("../src/lib/tubeforge/billing");
const {
  processStripeEvent,
  creditsToMicro,
  microToCredits,
  hasCredits,
  RENDER_ESTIMATE_MICRO,
  PLAN_DEFAULTS,
} = billing;

// ===========================================================================
// Phase 1 — webhook authentication is fail-closed (defect #1)
// ===========================================================================
suiteStart("Stage 7.1 #1 — webhook authentication fail-closed");

const SECRET = "whsec_s71_test";
const EVENT_BODY = JSON.stringify({
  id: `evt_${MARK}_auth`,
  type: "customer.subscription.updated",
  data: { object: { id: "sub_does_not_matter_for_auth", status: "active", current_period_end: 0 } },
});
EVENT_IDS.push(`evt_${MARK}_auth`);

await test("secret set + signature header MISSING → 401, event not processed", async () => {
  process.env.TUBEFORGE_STRIPE_WEBHOOK_SECRET = SECRET;
  const res = await postWebhook(EVENT_BODY); // no stripe-signature header
  eq(res.status, 401, "missing signature is unauthorized");
  eq(
    await db.processedWebhookEvent.findUnique({ where: { id: `evt_${MARK}_auth` } }),
    null,
    "unauthenticated event left no trace"
  );
});

await test("secret set + INVALID signature → 401", async () => {
  const res = await postWebhook(EVENT_BODY, { "stripe-signature": "t=1,v1=deadbeef" });
  eq(res.status, 401, "bad signature is unauthorized");
});

await test("secret set + tampered payload with a valid-looking header → 401", async () => {
  const sig = stripeSign(SECRET, EVENT_BODY);
  const res = await postWebhook(EVENT_BODY.replace("active", "canceled"), { "stripe-signature": sig });
  eq(res.status, 401, "signed-then-modified payload is unauthorized");
});

await test("secret set + VALID signature → 200 and the event is processed", async () => {
  const res = await postWebhook(EVENT_BODY, { "stripe-signature": stripeSign(SECRET, EVENT_BODY) });
  eq(res.status, 200, "signed event accepted");
  eq(res.json.received, true, "route acks");
  ok(
    await db.processedWebhookEvent.findUnique({ where: { id: `evt_${MARK}_auth` } }),
    "event id recorded in ProcessedWebhookEvent"
  );
});

await test("secret MISSING + no dev opt-in → 401 (fail-closed even outside production)", async () => {
  delete process.env.TUBEFORGE_STRIPE_WEBHOOK_SECRET;
  delete process.env.TUBEFORGE_ALLOW_UNSIGNED_WEBHOOKS;
  const res = await postWebhook(EVENT_BODY);
  eq(res.status, 401, "unconfigured webhook accepts nothing by default");
});

await test("secret MISSING + NODE_ENV=production → 500 misconfiguration", async () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const res = await postWebhook(EVENT_BODY);
    eq(res.status, 500, "production without a secret refuses loudly");
  } finally {
    process.env.NODE_ENV = prev;
  }
});

await test("secret MISSING + explicit dev opt-in → 200 (the ONLY unsigned path)", async () => {
  process.env.TUBEFORGE_ALLOW_UNSIGNED_WEBHOOKS = "1";
  try {
    const res = await postWebhook(EVENT_BODY);
    eq(res.status, 200, "explicit dev bypass works");
  } finally {
    delete process.env.TUBEFORGE_ALLOW_UNSIGNED_WEBHOOKS;
  }
});

await test("malformed JSON → 400 regardless of auth state", async () => {
  process.env.TUBEFORGE_STRIPE_WEBHOOK_SECRET = SECRET;
  const res = await postWebhook("{not json", { "stripe-signature": stripeSign(SECRET, "{not json") });
  eq(res.status, 400, "invalid JSON rejected");
  delete process.env.TUBEFORGE_STRIPE_WEBHOOK_SECRET;
});

// ===========================================================================
// Phase 2 — canonical units: a paid allowance covers the render gate (defect #2)
// ===========================================================================
suiteStart("Stage 7.1 #2 — canonical credit units");

await test("invoice.paid grants the plan allowance in MICROCREDITS and the render pre-check passes", async () => {
  const { user, sub } = await makePaidUser(`${MARK}.units@t.test`, "active");
  // The old resolver: granted 10,000 (UI credits) − spent 50,000 (micro) in
  // one sum → a FULL allowance failed the render gate. The fix: grants are
  // converted to the canonical microCredit unit at grant time.
  await processStripeEvent({
    id: `evt_${MARK}_grant`,
    type: "invoice.paid",
    data: {
      object: {
        id: `in_${MARK}_1`,
        subscription: sub.stripeSubscriptionId,
        period_start: Math.floor(Date.now() / 1000),
        period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
      },
    },
  });
  EVENT_IDS.push(`evt_${MARK}_grant`);

  const resolved = await billing.resolveUserPlan(user.id);
  eq(resolved.plan.tier, "creator", "paid plan resolves");
  eq(resolved.creditBalance, creditsToMicro(10000), "full Creator allowance = 10,000,000 microCredits");
  ok(
    hasCredits(resolved, RENDER_ESTIMATE_MICRO),
    "THE regression: a full Creator allowance passes the 50,000-micro render pre-check"
  );
  eq(microToCredits(resolved.creditBalance), 10000, "display conversion shows 10,000 credits");
});

// ===========================================================================
// Phase 3 — idempotent grants (defect #5)
// ===========================================================================
suiteStart("Stage 7.1 #5 — idempotent invoice grants");

await test("the SAME event id replayed → duplicate, still exactly one grant", async () => {
  const { user, sub } = await makePaidUser(`${MARK}.idem@t.test`, "active");
  const event = {
    id: `evt_${MARK}_idem`,
    type: "invoice.paid" as const,
    data: {
      object: {
        id: `in_${MARK}_idem`,
        subscription: sub.stripeSubscriptionId,
        period_start: Math.floor(Date.now() / 1000),
        period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
      },
    },
  };
  eq(await processStripeEvent(event), "processed", "first delivery processed");
  eq(await processStripeEvent(event), "duplicate", "replay acked as duplicate");
  EVENT_IDS.push(event.id!);
  eq(await db.creditGrant.count({ where: { userId: user.id } }), 1, "exactly one grant row");
});

await test("SAME invoice under a DIFFERENT event id → upsert no-op, still one grant", async () => {
  const { user, sub } = await makePaidUser(`${MARK}.idem2@t.test`, "active");
  const object = {
    id: `in_${MARK}_idem2`,
    subscription: sub.stripeSubscriptionId,
    period_start: Math.floor(Date.now() / 1000),
    period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
  };
  await processStripeEvent({ id: `evt_${MARK}_idem2a`, type: "invoice.paid", data: { object } });
  await processStripeEvent({ id: `evt_${MARK}_idem2b`, type: "invoice.paid", data: { object } });
  EVENT_IDS.push(`evt_${MARK}_idem2a`, `evt_${MARK}_idem2b`);
  eq(await db.creditGrant.count({ where: { userId: user.id } }), 1, "unique stripeInvoiceId blocks the double grant");
  const resolved = await billing.resolveUserPlan(user.id);
  eq(resolved.creditBalance, creditsToMicro(10000), "balance counted once");
});

// ===========================================================================
// Phase 4 — ledger linkage (defect #3)
// ===========================================================================
suiteStart("Stage 7.1 #3 — ledger-to-subscription linkage");

await test("spendCredits auto-links the ledger row to the user's subscription", async () => {
  const { user, sub } = await makePaidUser(`${MARK}.link@t.test`, "active");
  await db.creditGrant.create({
    data: {
      userId: user.id,
      subscriptionId: sub.id,
      grantedMicroCredits: creditsToMicro(10000),
      periodStart: new Date(Date.now() - 60_000),
      periodEnd: new Date(Date.now() + 30 * 86400_000),
    },
  });
  const result = await billing.spendCredits({
    userId: user.id,
    kind: "ai_call",
    microCredits: billing.getEstimatedCostMicro("video"),
    note: "s71 linkage probe (video = 40,000 micro)",
  });
  ok(result.recorded, "video-call spend recorded");
  const row = await db.creditLedger.findFirst({ where: { userId: user.id, kind: "ai_call" } });
  ok(row, "ledger row exists");
  eq(row!.subscriptionId, sub.id, "THE regression: spend is LINKED to the subscription (never null)");
  const resolved = await billing.resolveUserPlan(user.id);
  eq(resolved.creditBalance, creditsToMicro(10000) - 40000, "subscription balance counts the linked spend");
});

await test("user-scoped balance counts LEGACY null-linked spend rows", async () => {
  const { user, sub } = await makePaidUser(`${MARK}.legacy@t.test`, "active");
  await db.creditGrant.create({
    data: {
      userId: user.id,
      subscriptionId: sub.id,
      grantedMicroCredits: creditsToMicro(10000),
      periodStart: new Date(Date.now() - 60_000),
      periodEnd: new Date(Date.now() + 30 * 86400_000),
    },
  });
  // A row written by the OLD code (subscriptionId: null).
  await db.creditLedger.create({
    data: { userId: user.id, subscriptionId: null, kind: "render_minute", microCredits: 30000 },
  });
  const resolved = await billing.resolveUserPlan(user.id);
  eq(
    resolved.creditBalance,
    creditsToMicro(10000) - 30000,
    "legacy null-linked spend still reduces the balance (no resurrected credits)"
  );
});

// ===========================================================================
// Phase 5 — subscription status rules (defect #4)
// ===========================================================================
suiteStart("Stage 7.1 #4 — subscription status enforcement");

await test("status matrix: active/trialing → paid plan; past_due → paid plan (grace); canceled/unpaid/unknown → Starter", async () => {
  const { user, sub } = await makePaidUser(`${MARK}.status@t.test`, "active");
  await db.creditGrant.create({
    data: {
      userId: user.id,
      subscriptionId: sub.id,
      grantedMicroCredits: creditsToMicro(10000),
      periodStart: new Date(Date.now() - 60_000),
      periodEnd: new Date(Date.now() + 30 * 86400_000),
    },
  });

  const expect = (status: string, planTier: string, access: string) => async () => {
    await db.subscription.update({ where: { id: sub.id }, data: { status } });
    const resolved = await billing.resolveUserPlan(user.id);
    eq(resolved.plan.tier, planTier, `${status}: plan tier`);
    eq(resolved.access, access, `${status}: access`);
  };

  await expect("active", "creator", "full")();
  await expect("trialing", "creator", "full")();
  await expect("past_due", "creator", "grace")();
  await expect("canceled", "starter", "none")();
  await expect("unpaid", "starter", "none")();
  await expect("incomplete", "starter", "none")();
  await expect("brand_new_stripe_status", "starter", "none")(); // fail-closed

  // Renewal: a paid invoice clears past_due back to active.
  await db.subscription.update({ where: { id: sub.id }, data: { status: "past_due" } });
  await processStripeEvent({
    id: `evt_${MARK}_renew`,
    type: "invoice.paid",
    data: {
      object: {
        id: `in_${MARK}_renew`,
        subscription: sub.stripeSubscriptionId,
        period_start: Math.floor(Date.now() / 1000),
        period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
      },
    },
  });
  EVENT_IDS.push(`evt_${MARK}_renew`);
  const after = await billing.resolveUserPlan(user.id);
  eq(after.access, "full", "invoice.paid clears past_due → active");
  eq(after.plan.tier, "creator", "renewal restores the paid plan");
});

await test("canceled subscription cannot collect new linked spends (stays null-linked, no entitlement)", async () => {
  const { user, sub } = await makePaidUser(`${MARK}.cancel@t.test`, "canceled");
  const result = await billing.spendCredits({ userId: user.id, kind: "ai_call", microCredits: 3000 });
  ok(result.recorded, "free-tier overdraft still records the row (documented design)");
  const row = await db.creditLedger.findFirst({ where: { userId: user.id } });
  eq(row!.subscriptionId, null, "canceled subscription collects no linked rows");
});

// ===========================================================================
// Phase 6 — concurrent spending cannot overspend (review item #6)
// ===========================================================================
suiteStart("Stage 7.1 #6 — concurrent spend / overspend prevention");

await test("10 parallel spends of 30,000 micro against a 100,000-micro grant → exactly 3 recorded, balance ≥ 0", async () => {
  const { user, sub } = await makePaidUser(`${MARK}.conc@t.test`, "active");
  await db.creditGrant.create({
    data: {
      userId: user.id,
      subscriptionId: sub.id,
      grantedMicroCredits: 100_000,
      periodStart: new Date(Date.now() - 60_000),
      periodEnd: new Date(Date.now() + 30 * 86400_000),
    },
  });
  const COST = 30_000;
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      billing.spendCredits({ userId: user.id, kind: "ai_call", microCredits: COST, note: "s71 concurrency probe" })
    )
  );
  const recorded = results.filter((r) => r.recorded);
  const rejected = results.filter((r) => !r.recorded);
  eq(recorded.length, 3, "exactly floor(100,000 / 30,000) = 3 spends recorded");
  eq(rejected.length, 7, "the rest rejected as insufficient_credits");
  ok(rejected.every((r) => r.reason === "insufficient_credits"), "rejections carry the right reason");

  const ledgerSum = (await db.creditLedger.findMany({ where: { userId: user.id }, select: { microCredits: true } }))
    .reduce((acc, r) => acc + Math.max(0, r.microCredits), 0);
  eq(ledgerSum, recorded.length * COST, "ledger total matches recorded spends");

  const resolved = await billing.resolveUserPlan(user.id);
  ok(resolved.creditBalance >= 0, `balance never negative (${resolved.creditBalance} micro)`);
  eq(resolved.creditBalance, 100_000 - ledgerSum, "resolver balance matches grant − ledger");
});

// ===========================================================================
// Phase 7 — full subscription lifecycle through the REAL event handlers
// (review item #7: payment / renewal / cancellation / refund / payment
// failure as END-TO-END event sequences, not just resolver states)
// ===========================================================================
suiteStart("Stage 7.1 #7 — Stripe lifecycle integration (checkout → failure → recovery → cancel → refund)");

/** Ensure the paid plan row exists (the checkout handler reuses it). */
async function ensurePlan(tier: "creator" | "studio") {
  let plan = await db.plan.findUnique({ where: { tier } });
  if (!plan) {
    plan = await db.plan.create({
      data: {
        name: tier === "creator" ? "Creator" : "Studio",
        tier,
        monthlyCredits: tier === "creator" ? 10000 : 50000,
        maxResolution: tier === "creator" ? "1440p" : "2160p",
        priorityRendering: true,
        teamMembers: 1,
      },
    });
    PLAN_IDS.push(plan.id);
  }
  return plan;
}

await test("checkout.session.completed via the SIGNED route → Subscription row created, active, paid plan", async () => {
  await ensurePlan("creator");
  const user = await db.user.create({
    data: { email: `${MARK}.lifecycle@t.test`, passwordHash: `pbkdf2$1$s$${MARK}`, name: "Stage 7.1 lifecycle" },
  });
  USER_IDS.push(user.id);

  // Before checkout: no Subscription row → Starter.
  const before = await billing.resolveUserPlan(user.id);
  eq(before.plan.tier, "starter", "pre-checkout user is Starter");
  eq(before.subscription, null, "no Subscription row yet");

  // The checkout event, delivered through the REAL route with a REAL
  // signature — the exact path Stripe production traffic takes.
  process.env.TUBEFORGE_STRIPE_WEBHOOK_SECRET = SECRET;
  const checkoutEventId = `evt_${MARK}_checkout`;
  EVENT_IDS.push(checkoutEventId);
  const body = JSON.stringify({
    id: checkoutEventId,
    type: "checkout.session.completed",
    data: {
      object: {
        client_reference_id: user.id,
        customer: `cus_${MARK}_lc`,
        subscription: `sub_${MARK}_lc`,
        metadata: { planTier: "creator" },
      },
    },
  });
  const res = await postWebhook(body, { "stripe-signature": stripeSign(SECRET, body) });
  eq(res.status, 200, "signed checkout event accepted");
  eq(res.json.received, true, "route acks the checkout");

  const row = await db.subscription.findUnique({ where: { userId: user.id } });
  ok(row, "checkout created the Subscription row");
  eq(row!.status, "active", "checkout subscription is active");
  eq(row!.stripeCustomerId, `cus_${MARK}_lc`, "stripe customer id persisted");
  eq(row!.stripeSubscriptionId, `sub_${MARK}_lc`, "stripe subscription id persisted");

  const after = await billing.resolveUserPlan(user.id);
  eq(after.plan.tier, "creator", "post-checkout user resolves to the paid plan");
  eq(after.access, "full", "post-checkout access is full");
});

await test("payment failure: subscription.updated status=past_due → grace (paid plan kept while dunning runs)", async () => {
  const { user, sub } = await makePaidUser(`${MARK}.dunning@t.test`, "active");
  const future = Math.floor(Date.now() / 1000) + 14 * 86400;
  const evtId = `evt_${MARK}_dunfail`;
  EVENT_IDS.push(evtId);
  await processStripeEvent({
    id: evtId,
    type: "customer.subscription.updated",
    data: { object: { id: sub.stripeSubscriptionId, status: "past_due", current_period_end: future } },
  });
  const resolved = await billing.resolveUserPlan(user.id);
  eq(resolved.plan.tier, "creator", "past_due keeps the paid plan (grace)");
  eq(resolved.access, "grace", "past_due access is grace — not full, not none");
  eq(
    (await db.subscription.findUnique({ where: { id: sub.id } }))!.currentPeriodEnd?.getTime(),
    future * 1000,
    "period end tracked from the Stripe payload"
  );
});

await test("cancellation: subscription.deleted → Starter fallback, no access, subscription record kept for the UI", async () => {
  const { user, sub } = await makePaidUser(`${MARK}.term@t.test`, "active");
  const evtId = `evt_${MARK}_term`;
  EVENT_IDS.push(evtId);
  await processStripeEvent({
    id: evtId,
    type: "customer.subscription.deleted",
    data: { object: { id: sub.stripeSubscriptionId } },
  });
  eq((await db.subscription.findUnique({ where: { id: sub.id } }))!.status, "canceled", "status flipped to canceled");
  const resolved = await billing.resolveUserPlan(user.id);
  eq(resolved.plan.tier, "starter", "canceled user resolves to Starter");
  eq(resolved.access, "none", "canceled access is none");
  ok(resolved.subscription, "the subscription record survives for the UI");
  eq(resolved.subscription!.status, "canceled", "UI can render the canceled state");
});

await test("refund: unknown charge.refunded event is safely acked; credit refunds flow through the refund ledger kind", async () => {
  const { user, sub } = await makePaidUser(`${MARK}.refund@t.test`, "active");
  await db.creditGrant.create({
    data: {
      userId: user.id,
      subscriptionId: sub.id,
      grantedMicroCredits: creditsToMicro(10000),
      periodStart: new Date(Date.now() - 60_000),
      periodEnd: new Date(Date.now() + 30 * 86400_000),
    },
  });
  // Consume 40,000 micro (one video call).
  await billing.spendCredits({ userId: user.id, kind: "ai_call", microCredits: 40_000, note: "s71 refund probe spend" });
  const afterSpend = await billing.resolveUserPlan(user.id);
  eq(afterSpend.creditBalance, creditsToMicro(10000) - 40_000, "balance after the spend");

  // A Stripe charge refund arrives — the handler must ack it WITHOUT
  // corrupting the ledger (metered usage is not clawed back automatically;
  // credit refunds are an explicit operator action, see below).
  const evtId = `evt_${MARK}_refund`;
  EVENT_IDS.push(evtId);
  eq(
    await processStripeEvent({ id: evtId, type: "charge.refunded", data: { object: { id: `ch_${MARK}` } } }),
    "processed",
    "charge.refunded is acked (default case — no 500 retry loop)"
  );
  const afterEvent = await billing.resolveUserPlan(user.id);
  eq(afterEvent.creditBalance, afterSpend.creditBalance, "the refund event itself does not touch the balance");

  // The DOCUMENTED credit-refund path: a negative ledger row of kind
  // "refund" (resolver math: granted − spent + refunded).
  await db.creditLedger.create({
    data: { userId: user.id, subscriptionId: sub.id, kind: "refund", microCredits: -40_000, note: "operator credit refund" },
  });
  const afterRefund = await billing.resolveUserPlan(user.id);
  eq(afterRefund.creditBalance, creditsToMicro(10000), "refund ledger row restores the spent credits exactly");
});

await test("FULL lifecycle chain: checkout → grant → failure → recovery grant → cancel, all event-driven", async () => {
  await ensurePlan("creator");
  const user = await db.user.create({
    data: { email: `${MARK}.chain@t.test`, passwordHash: `pbkdf2$1$s$${MARK}`, name: "Stage 7.1 chain" },
  });
  USER_IDS.push(user.id);
  const STRIPE_SUB = `sub_${MARK}_chain`;
  const periodEnd = () => Math.floor(Date.now() / 1000) + 30 * 86400;

  // 1. checkout.session.completed → subscription row (active).
  await processStripeEvent({
    id: `evt_${MARK}_c1`,
    type: "checkout.session.completed",
    data: {
      object: {
        client_reference_id: user.id,
        customer: `cus_${MARK}_chain`,
        subscription: STRIPE_SUB,
        metadata: { planTier: "creator" },
      },
    },
  });
  EVENT_IDS.push(`evt_${MARK}_c1`);
  eq((await billing.resolveUserPlan(user.id)).access, "full", "step 1: checkout → full access");

  // 2. first invoice.paid → the monthly grant lands.
  await processStripeEvent({
    id: `evt_${MARK}_c2`,
    type: "invoice.paid",
    data: {
      object: { id: `in_${MARK}_c1`, subscription: STRIPE_SUB, period_start: Math.floor(Date.now() / 1000), period_end: periodEnd() },
    },
  });
  EVENT_IDS.push(`evt_${MARK}_c2`);
  let resolved = await billing.resolveUserPlan(user.id);
  eq(resolved.creditBalance, creditsToMicro(10000), "step 2: first invoice grants the full allowance");

  // 3. consume some credits, then the payment FAILS next period.
  await billing.spendCredits({ userId: user.id, kind: "ai_call", microCredits: 40_000, note: "s71 chain spend" });
  await processStripeEvent({
    id: `evt_${MARK}_c3`,
    type: "customer.subscription.updated",
    data: { object: { id: STRIPE_SUB, status: "past_due", current_period_end: periodEnd() } },
  });
  EVENT_IDS.push(`evt_${MARK}_c3`);
  resolved = await billing.resolveUserPlan(user.id);
  eq(resolved.access, "grace", "step 3: payment failure → grace");
  eq(resolved.creditBalance, creditsToMicro(10000) - 40_000, "step 3: spend counted during dunning");

  // 4. the customer fixes their card — Stripe sends a NEW invoice (new id!).
  await processStripeEvent({
    id: `evt_${MARK}_c4`,
    type: "invoice.paid",
    data: {
      object: { id: `in_${MARK}_c2`, subscription: STRIPE_SUB, period_start: Math.floor(Date.now() / 1000), period_end: periodEnd() },
    },
  });
  EVENT_IDS.push(`evt_${MARK}_c4`);
  resolved = await billing.resolveUserPlan(user.id);
  eq(resolved.access, "full", "step 4: recovery invoice re-activates the subscription");
  eq(await db.creditGrant.count({ where: { userId: user.id } }), 2, "step 4: recovery invoice is a SECOND grant (new invoice id)");
  eq(resolved.creditBalance, 2 * creditsToMicro(10000) - 40_000, "step 4: balance spans both periods minus the spend");

  // 5. the customer cancels — access ends, grants stop, record survives.
  await processStripeEvent({
    id: `evt_${MARK}_c5`,
    type: "customer.subscription.deleted",
    data: { object: { id: STRIPE_SUB } },
  });
  EVENT_IDS.push(`evt_${MARK}_c5`);
  resolved = await billing.resolveUserPlan(user.id);
  eq(resolved.access, "none", "step 5: cancellation ends access");
  eq(resolved.plan.tier, "starter", "step 5: back to Starter");
  eq(resolved.subscription!.status, "canceled", "step 5: record kept for the UI");

  // 6. a late invoice for the canceled sub grants NOTHING (no resurrection).
  await processStripeEvent({
    id: `evt_${MARK}_c6`,
    type: "invoice.paid",
    data: {
      object: { id: `in_${MARK}_c3`, subscription: STRIPE_SUB, period_start: Math.floor(Date.now() / 1000), period_end: periodEnd() },
    },
  });
  EVENT_IDS.push(`evt_${MARK}_c6`);
  eq(await db.creditGrant.count({ where: { userId: user.id } }), 2, "step 6: canceled sub collects no new grant");
  eq((await db.subscription.findUnique({ where: { userId: user.id } }))!.status, "canceled", "step 6: late invoice cannot resurrect the subscription");
});

// ===========================================================================
// Stage 7.2 — Problem A: billing period accuracy (review fix A)
//
// The old resolver/spend math subtracted the user's ALL-TIME ledger from the
// CURRENT period's grants — after a renewal the customer saw
// grant2 − (month-1 + month-2 spending). The fix scopes the ledger to the
// grants' window; the rollover rule is explicit: credits do NOT roll over,
// each period starts fresh, and a refund benefits the period it is
// RECORDED in.
// ===========================================================================
suiteStart("Stage 7.2 A — period-scoped balances (no lifetime subtraction)");

await test("consecutive periods: month-2 balance is the fresh allowance (the review's exact table)", async () => {
  const { user, sub } = await makePaidUser(`${MARK}.p8a@t.test`, "active");
  // Month 1: a 10,000-credit grant, already CLOSED (ended 1s ago).
  await db.creditGrant.create({
    data: {
      userId: user.id,
      subscriptionId: sub.id,
      grantedMicroCredits: creditsToMicro(10000),
      periodStart: new Date(Date.now() - 30 * 86400_000),
      periodEnd: new Date(Date.now() - 1000),
    },
  });
  // Month-1 spending: 9,000 credits, recorded mid-month-1 (backdated).
  await db.creditLedger.create({
    data: {
      userId: user.id,
      subscriptionId: sub.id,
      kind: "ai_call",
      microCredits: creditsToMicro(9000),
      createdAt: new Date(Date.now() - 15 * 86400_000),
      note: "s72 month-1 spend (backdated into the closed period)",
    },
  });

  // Before the renewal grant arrives there is NO covering grant — the
  // fail-closed answer is 0 (never negative, never last month's leftover).
  const between = await billing.resolveUserPlan(user.id);
  eq(between.creditBalance, 0, "between periods: no covering grant → balance 0");

  // Month 2 opens (the renewal grant covers now).
  await db.creditGrant.create({
    data: {
      userId: user.id,
      subscriptionId: sub.id,
      grantedMicroCredits: creditsToMicro(10000),
      periodStart: new Date(Date.now() - 500),
      periodEnd: new Date(Date.now() + 30 * 86400_000),
    },
  });

  // THE review table, pinned: Month 2 = 10,000, NOT 10,000 − 9,000.
  const renewed = await billing.resolveUserPlan(user.id);
  eq(
    renewed.creditBalance,
    creditsToMicro(10000),
    "month-2 balance is the fresh 10,000 (month-1 spending stays in month 1)"
  );

  // Month-2 spending subtracts from month 2 only — through the REAL
  // transactional path.
  const r = await billing.spendCredits({
    userId: user.id,
    kind: "ai_call",
    microCredits: 40_000,
    note: "s72 month-2 spend (live)",
  });
  ok(r.recorded, "month-2 spend recorded");
  const after = await billing.resolveUserPlan(user.id);
  eq(after.creditBalance, creditsToMicro(10000) - 40_000, "month-2 spending reduces month 2 only");
});

await test("webhook-driven renewal: invoice.paid with a NEW period opens a fresh window", async () => {
  const { user, sub } = await makePaidUser(`${MARK}.p8b@t.test`, "active");
  // First period granted through the REAL webhook — it CLOSED yesterday.
  await processStripeEvent({
    id: `evt_${MARK}_r1`,
    type: "invoice.paid",
    data: {
      object: {
        id: `in_${MARK}_r1`,
        subscription: sub.stripeSubscriptionId,
        period_start: Math.floor(Date.now() / 1000) - 30 * 86400,
        period_end: Math.floor(Date.now() / 1000) - 86400,
      },
    },
  });
  EVENT_IDS.push(`evt_${MARK}_r1`);

  // Last month's spending — the live path records it NOW (inside neither
  // period's wall-clock), so backdate the row into the closed period.
  await db.creditLedger.create({
    data: {
      userId: user.id,
      subscriptionId: sub.id,
      kind: "ai_call",
      microCredits: creditsToMicro(9000),
      createdAt: new Date(Date.now() - 15 * 86400_000),
      note: "s72 p1 spend (backdated)",
    },
  });

  // The renewal invoice arrives — REAL event path, NEW invoice id + period.
  await processStripeEvent({
    id: `evt_${MARK}_r2`,
    type: "invoice.paid",
    data: {
      object: {
        id: `in_${MARK}_r2`,
        subscription: sub.stripeSubscriptionId,
        period_start: Math.floor(Date.now() / 1000),
        period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
      },
    },
  });
  EVENT_IDS.push(`evt_${MARK}_r2`);

  const renewed = await billing.resolveUserPlan(user.id);
  eq(await db.creditGrant.count({ where: { userId: user.id } }), 2, "two invoices → two grants");
  eq(
    renewed.creditBalance,
    creditsToMicro(10000),
    "renewal grants a FRESH 10,000 — last month's 9,000 stay in last month"
  );
});

await test("a refund recorded in the new period benefits the new period (explicit rule)", async () => {
  const { user, sub } = await makePaidUser(`${MARK}.p8c@t.test`, "active");
  await db.creditGrant.create({
    data: {
      userId: user.id,
      subscriptionId: sub.id,
      grantedMicroCredits: creditsToMicro(10000),
      periodStart: new Date(Date.now() - 86400_000),
      periodEnd: new Date(Date.now() + 30 * 86400_000),
    },
  });
  // An operator refunds 2,000 credits for last month's overcharge — the
  // row lands NOW, inside the current period.
  await db.creditLedger.create({
    data: {
      userId: user.id,
      kind: "refund",
      microCredits: -creditsToMicro(2000),
      note: "s72 operator refund recorded this period",
    },
  });
  const resolved = await billing.resolveUserPlan(user.id);
  eq(resolved.creditBalance, creditsToMicro(12000), "refund recorded this period adds back this period");
});

await test("no rollover: an exhausted period blocks spending even though last month ended with surplus", async () => {
  const { user, sub } = await makePaidUser(`${MARK}.p8d@t.test`, "active");
  // Last month: 10,000 granted, only 3,000 used — a 7,000 surplus that
  // EXPIRED with the period.
  await db.creditGrant.create({
    data: {
      userId: user.id,
      subscriptionId: sub.id,
      grantedMicroCredits: creditsToMicro(10000),
      periodStart: new Date(Date.now() - 30 * 86400_000),
      periodEnd: new Date(Date.now() - 1000),
    },
  });
  await db.creditLedger.create({
    data: {
      userId: user.id,
      kind: "ai_call",
      microCredits: creditsToMicro(3000),
      createdAt: new Date(Date.now() - 15 * 86400_000),
    },
  });
  // This month: a 5,000 grant, fully spent.
  await db.creditGrant.create({
    data: {
      userId: user.id,
      subscriptionId: sub.id,
      grantedMicroCredits: creditsToMicro(5000),
      periodStart: new Date(Date.now() - 500),
      periodEnd: new Date(Date.now() + 30 * 86400_000),
    },
  });
  await db.creditLedger.create({
    data: {
      userId: user.id,
      subscriptionId: sub.id,
      kind: "render_minute",
      microCredits: creditsToMicro(5000),
      note: "s72 this period fully spent",
    },
  });

  const resolved = await billing.resolveUserPlan(user.id);
  eq(resolved.creditBalance, 0, "this period is exhausted — last month's 7,000 surplus did NOT roll over");
  const r = await billing.spendCredits({ userId: user.id, kind: "ai_call", microCredits: 1 });
  ok(!r.recorded, "enforcement blocks a spent-out period");
  eq(r.reason, "insufficient_credits", "rejection reason");
});

// ===========================================================================
// Stage 7.2 — Problem B: pre-call credit reservations (review fix B)
//
// The old path ran the AI provider call FIRST and then spendCredits() could
// only refuse to RECORD an unaffordable call that had already executed. The
// fix: reserve the estimated cost BEFORE the call, settle the reservation
// against the actual after, release it on failure. Double settlement is
// impossible — the settlement row's reconcilesId is UNIQUE.
// ===========================================================================
suiteStart("Stage 7.2 B — credit reservations (hold → execute → settle/release)");

const H = () => ({ periodStart: new Date(Date.now() - 60_000), periodEnd: new Date(Date.now() + 30 * 86400_000) });

async function grantMicro(userId: string, subId: string, micro: number) {
  await db.creditGrant.create({
    data: { userId, subscriptionId: subId, grantedMicroCredits: micro, ...H() },
  });
}

await test("reserveCredits holds the estimate and the open hold already counts against the balance", async () => {
  const { user, sub } = await makePaidUser(`${MARK}.p9a@t.test`, "active");
  await grantMicro(user.id, sub.id, 100_000);
  const hold = await billing.reserveCredits({ userId: user.id, estimatedMicro: 30_000, capability: "chat" });
  if (hold.mode !== "held") throw new Error(`expected held, got ${hold.mode}`);
  eq(hold.balanceMicro, 70_000, "hold result reports the post-hold balance");
  const holdRow = await db.creditLedger.findUnique({ where: { id: hold.holdId } });
  ok(holdRow, "hold ledger row exists");
  eq(holdRow!.kind, "hold", "row kind is hold");
  eq(holdRow!.microCredits, 30_000, "row amount is the estimate");
  eq(holdRow!.subscriptionId, sub.id, "hold links the subscription");
  const resolved = await billing.resolveUserPlan(user.id);
  eq(resolved.creditBalance, 70_000, "THE open hold counts against the balance");
});

await test("settle at estimate → zero marker row; net AI spend = estimate", async () => {
  const { user, sub } = await makePaidUser(`${MARK}.p9b@t.test`, "active");
  await grantMicro(user.id, sub.id, 100_000);
  const hold = await billing.reserveCredits({ userId: user.id, estimatedMicro: 40_000, capability: "video" });
  if (hold.mode !== "held") throw new Error(`expected held, got ${hold.mode}`);
  const settled = await billing.settleCreditHold({ holdId: hold.holdId, ok: true });
  if (!settled.settled) throw new Error(`expected settled, got ${settled.reason}`);
  eq(settled.kind, "adjustment", "settlement kind");
  eq(settled.deltaMicro, 0, "actual = estimate → zero marker");
  eq(settled.balanceMicro, 60_000, "balance = grant − estimate");
  const marker = await db.creditLedger.findFirst({ where: { reconcilesId: hold.holdId } });
  ok(marker, "settlement marker row exists");
  eq(marker!.kind, "adjustment", "marker kind");
  eq(marker!.microCredits, 0, "marker amount");
  const net = await billing.sumAICallSpends(user.id, new Date(Date.now() - 60_000), new Date(Date.now() + 60_000));
  eq(net.microCredits, 40_000, "net metered AI spend = actual (= estimate)");
});

await test("settle actual < estimate refunds the delta; actual > estimate charges it", async () => {
  const { user, sub } = await makePaidUser(`${MARK}.p9c@t.test`, "active");
  await grantMicro(user.id, sub.id, 200_000);
  // Cheaper than estimated → the difference comes back.
  const h1 = await billing.reserveCredits({ userId: user.id, estimatedMicro: 40_000, capability: "video" });
  if (h1.mode !== "held") throw new Error(`expected held, got ${h1.mode}`);
  const s1 = await billing.settleCreditHold({ holdId: h1.holdId, ok: true, actualMicro: 30_000 });
  if (!s1.settled) throw new Error(`expected settled, got ${s1.reason}`);
  eq(s1.deltaMicro, -10_000, "over-estimate → negative adjustment");
  eq(s1.balanceMicro, 170_000, "balance = grant − ACTUAL 30,000");
  // Pricier than estimated → the difference is charged.
  const h2 = await billing.reserveCredits({ userId: user.id, estimatedMicro: 3_000, capability: "chat" });
  if (h2.mode !== "held") throw new Error(`expected held, got ${h2.mode}`);
  const s2 = await billing.settleCreditHold({ holdId: h2.holdId, ok: true, actualMicro: 5_000 });
  if (!s2.settled) throw new Error(`expected settled, got ${s2.reason}`);
  eq(s2.deltaMicro, 2_000, "under-estimate → positive adjustment");
  const resolved = await billing.resolveUserPlan(user.id);
  eq(resolved.creditBalance, 165_000, "grant − 30,000 − 5,000 (reservations never double-deduct)");
  const net = await billing.sumAICallSpends(user.id, new Date(Date.now() - 60_000), new Date(Date.now() + 60_000));
  eq(net.microCredits, 35_000, "net metered AI spend = 30,000 + 5,000");
});

await test("failed call RELEASES the reservation — net 0 (failed calls no longer charge)", async () => {
  const { user, sub } = await makePaidUser(`${MARK}.p9d@t.test`, "active");
  await grantMicro(user.id, sub.id, 100_000);
  const hold = await billing.reserveCredits({ userId: user.id, estimatedMicro: 40_000, capability: "video" });
  if (hold.mode !== "held") throw new Error(`expected held, got ${hold.mode}`);
  const settled = await billing.settleCreditHold({
    holdId: hold.holdId,
    ok: false,
    note: "provider timeout after retries",
  });
  if (!settled.settled) throw new Error(`expected settled, got ${settled.reason}`);
  eq(settled.kind, "hold_release", "release kind");
  eq(settled.deltaMicro, -40_000, "full release");
  eq(settled.balanceMicro, 100_000, "balance fully restored");
  const net = await billing.sumAICallSpends(user.id, new Date(Date.now() - 60_000), new Date(Date.now() + 60_000));
  eq(net.microCredits, 0, "a failed call nets to 0 (hold + release)");
});

await test("double settle is a no-op — UNIQUE reconcilesId makes double-deduction impossible", async () => {
  const { user, sub } = await makePaidUser(`${MARK}.p9e@t.test`, "active");
  await grantMicro(user.id, sub.id, 100_000);
  const hold = await billing.reserveCredits({ userId: user.id, estimatedMicro: 40_000, capability: "video" });
  if (hold.mode !== "held") throw new Error(`expected held, got ${hold.mode}`);
  const first = await billing.settleCreditHold({ holdId: hold.holdId, ok: true, actualMicro: 30_000 });
  ok(first.settled, "first settle wins");
  // A duplicate delivery / retried reconciliation must not adjust twice.
  const second = await billing.settleCreditHold({ holdId: hold.holdId, ok: true, actualMicro: 50_000 });
  if (second.settled) throw new Error("double settle was accepted — double deduction!");
  eq(second.reason, "already_settled", "duplicate rejected with the right reason");
  const rows = await db.creditLedger.findMany({ where: { reconcilesId: hold.holdId } });
  eq(rows.length, 1, "exactly ONE settlement row per hold");
  const resolved = await billing.resolveUserPlan(user.id);
  eq(resolved.creditBalance, 70_000, "balance reflects ONLY the first settle (grant − 30,000)");
});

await test("insufficient balance BLOCKS the reservation — and writes no ledger row", async () => {
  const { user, sub } = await makePaidUser(`${MARK}.p9f@t.test`, "active");
  await grantMicro(user.id, sub.id, 5_000);
  const hold = await billing.reserveCredits({ userId: user.id, estimatedMicro: 40_000, capability: "video" });
  if (hold.mode !== "blocked") throw new Error(`expected blocked, got ${hold.mode}`);
  eq(hold.balanceMicro, 5_000, "blocked carries the observed balance");
  eq(hold.estimatedMicro, 40_000, "blocked carries the requested estimate");
  eq(await db.creditLedger.count({ where: { userId: user.id } }), 0, "no rows written for a blocked hold");
  const resolved = await billing.resolveUserPlan(user.id);
  eq(resolved.creditBalance, 5_000, "balance untouched by the rejected reservation");
});

await test("concurrent reservations cannot overspend (mirror of the spendCredits guard)", async () => {
  const { user, sub } = await makePaidUser(`${MARK}.p9g@t.test`, "active");
  await grantMicro(user.id, sub.id, 100_000);
  const results = await Promise.all(
    Array.from({ length: 10 }, () => billing.reserveCredits({ userId: user.id, estimatedMicro: 30_000 }))
  );
  const held = results.filter((r) => r.mode === "held");
  const blocked = results.filter((r) => r.mode === "blocked");
  eq(held.length, 3, "exactly 3 holds fit the 100,000 grant");
  eq(blocked.length, 7, "the rest blocked");
  for (const h of held) {
    if (h.mode !== "held") throw new Error("narrow");
    const s = await billing.settleCreditHold({ holdId: h.holdId, ok: true });
    ok(s.settled, "every held reservation settles");
  }
  const resolved = await billing.resolveUserPlan(user.id);
  eq(resolved.creditBalance, 10_000, "balance = 100,000 − 3 × 30,000, never negative");
});

await test("starter and canceled-subscription users never reserve (unmetered overdraft path)", async () => {
  const free = await db.user.create({
    data: { email: `${MARK}.p9free@t.test`, passwordHash: `pbkdf2$1$s$${MARK}`, name: "s72 free" },
  });
  USER_IDS.push(free.id);
  const h1 = await billing.reserveCredits({ userId: free.id, estimatedMicro: 40_000 });
  if (h1.mode !== "unmetered") throw new Error(`expected unmetered, got ${h1.mode}`);
  eq(await db.creditLedger.count({ where: { userId: free.id } }), 0, "no hold rows for the free tier");

  const { user: canceled } = await makePaidUser(`${MARK}.p9cxl@t.test`, "canceled");
  const h2 = await billing.reserveCredits({ userId: canceled.id, estimatedMicro: 40_000 });
  if (h2.mode !== "unmetered") throw new Error(`expected unmetered, got ${h2.mode}`);
  eq(await db.creditLedger.count({ where: { userId: canceled.id } }), 0, "no hold rows for a canceled sub");
});

// ---- END-TO-END through the REAL aiCall (reserve before, settle/release after) ----

const { withCtx } = await import("../src/lib/tubeforge/tenant");
const budget = await import("../src/lib/tubeforge/budget");

/** A real org row — UsageRecord.organizationId is an FK. */
async function makeOrg(memberId: string) {
  const org = await db.organization.create({
    data: {
      name: `s72 org ${MARK}`,
      slug: `s72-${MARK}-${memberId.slice(-6)}`,
      memberships: { create: { userId: memberId, role: "owner" } },
    },
  });
  ORG_IDS.push(org.id);
  return org;
}

await test("E2E aiCall: a BLOCKED reservation throws BEFORE the provider function runs", async () => {
  const { user, sub } = await makePaidUser(`${MARK}.p9blk@t.test`, "active");
  await grantMicro(user.id, sub.id, 1_000); // image estimate = 4,000 → cannot cover it
  let ran = false;
  const err = await withCtx(
    { userId: user.id, organizationId: "unused-blocked", role: "owner" },
    () =>
      budget.aiCall(
        "image",
        "s72 blocked probe",
        async () => {
          ran = true;
          return "should-never-happen";
        },
        { attempts: 1 }
      )
  ).then(
    () => null,
    (e) => e
  );
  ok(err, "blocked call rejects");
  ok(err instanceof billing.CreditBlockedError, "typed CreditBlockedError");
  ok(/insufficient credits/i.test((err as Error).message), "readable message");
  eq(ran, false, "THE FIX: the provider function NEVER ran");
  eq(await db.usageRecord.count({ where: { userId: user.id } }), 0, "no UsageRecord (nothing ran)");
  eq(await db.creditLedger.count({ where: { userId: user.id } }), 0, "no ledger rows (blocked pre-write)");
});

await test("E2E aiCall: success settles the hold — balance = grant − estimate, usage linked", async () => {
  const { user, sub } = await makePaidUser(`${MARK}.p9ok@t.test`, "active");
  await grantMicro(user.id, sub.id, 100_000);
  const org = await makeOrg(user.id);
  const result = await withCtx({ userId: user.id, organizationId: org.id, role: "owner" }, () =>
    budget.aiCall("tts", "s72 ok probe", async () => "wav-bytes", { attempts: 1 })
  );
  eq(result, "wav-bytes", "the call result flows through");
  const resolved = await billing.resolveUserPlan(user.id);
  eq(resolved.creditBalance, 98_000, "balance = grant − tts estimate (2,000)");
  const usage = await db.usageRecord.findFirst({ where: { userId: user.id } });
  ok(usage, "UsageRecord written");
  eq(usage!.ok, true, "usage ok=true");
  const rows = await db.creditLedger.findMany({ where: { userId: user.id } });
  eq(rows.length, 2, "hold + settlement marker");
  ok(rows.every((r) => r.usageRecordId === usage!.id), "both rows carry the UsageRecord link");
  const net = await billing.sumAICallSpends(user.id, new Date(Date.now() - 60_000), new Date(Date.now() + 60_000));
  eq(net.microCredits, 2_000, "net AI spend = estimate");
});

await test("E2E aiCall: provider failure/timeout RELEASES the hold — balance fully restored", async () => {
  const { user, sub } = await makePaidUser(`${MARK}.p9fail@t.test`, "active");
  await grantMicro(user.id, sub.id, 100_000);
  const org = await makeOrg(user.id);
  const err = await withCtx({ userId: user.id, organizationId: org.id, role: "owner" }, () =>
    budget.aiCall(
      "llm",
      "s72 timeout probe",
      async () => {
        throw new Error("provider timeout");
      },
      { attempts: 1 }
    )
  ).then(
    () => null,
    (e) => e
  );
  ok(err, "failed call rejects");
  ok(/provider timeout/.test((err as Error).message), "original error propagates");
  const resolved = await billing.resolveUserPlan(user.id);
  eq(resolved.creditBalance, 100_000, "THE hold was released — balance fully restored");
  const usage = await db.usageRecord.findFirst({ where: { userId: user.id } });
  ok(usage, "failed call still metered (UsageRecord ok=false)");
  eq(usage!.ok, false, "usage ok=false");
  const net = await billing.sumAICallSpends(user.id, new Date(Date.now() - 60_000), new Date(Date.now() + 60_000));
  eq(net.microCredits, 0, "net AI spend for the failed call = 0");
});

// ===========================================================================
// Phase 0 audit follow-ups (docs/audits/phase0-architecture-audit.md):
// stale-hold sweep (R-10) · CreditBlockedError→402 (C7) · startJob running-
// row dedupe (R-01)
// ===========================================================================

await test("stale-hold sweep: releases an old unsettled hold and restores the balance", async () => {
  const { user, sub } = await makePaidUser(`${MARK}.p10sweep@t.test`, "active");
  await grantMicro(user.id, sub.id, 100_000);
  const hold = await billing.reserveCredits({ userId: user.id, estimatedMicro: 40_000, capability: "video" });
  if (hold.mode !== "held") throw new Error(`expected held, got ${hold.mode}`);
  // Simulate a process death that outlived the period boundary: widen the
  // grant window so the backdated hold stays INSIDE it (a real stale hold is
  // always inside some grant's window — it was taken after a grant existed),
  // then backdate the hold beyond the stale cutoff.
  await db.creditGrant.updateMany({
    where: { userId: user.id },
    data: { periodStart: new Date(Date.now() - 4 * 60 * 60 * 1000) },
  });
  await db.creditLedger.update({
    where: { id: hold.holdId },
    data: { createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000) },
  });
  const result = await billing.releaseStaleHolds({ olderThanMs: 2 * 60 * 60 * 1000 });
  eq(result.released, 1, "the stale hold was released");
  eq(result.alreadySettled, 0, "nothing else interfered");
  const resolved = await billing.resolveUserPlan(user.id);
  eq(resolved.creditBalance, 100_000, "balance fully restored (hold + release cancel inside the window)");
  const rows = await db.creditLedger.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } });
  eq(rows.length, 2, "hold + hold_release");
  eq(rows[1].kind, "hold_release", "release kind");
  eq(rows[1].reconcilesId, rows[0].id, "release reconciles the hold");
});

await test("stale-hold sweep: fresh holds and settled holds are never touched", async () => {
  const { user, sub } = await makePaidUser(`${MARK}.p10safe@t.test`, "active");
  await grantMicro(user.id, sub.id, 100_000);
  const fresh = await billing.reserveCredits({ userId: user.id, estimatedMicro: 4_000, capability: "image" });
  if (fresh.mode !== "held") throw new Error(`expected held, got ${fresh.mode}`);
  const settledHold = await billing.reserveCredits({ userId: user.id, estimatedMicro: 2_000, capability: "tts" });
  if (settledHold.mode !== "held") throw new Error(`expected held, got ${settledHold.mode}`);
  const settled = await billing.settleCreditHold({ holdId: settledHold.holdId, ok: true });
  eq(settled.settled, true, "settled normally");
  const result = await billing.releaseStaleHolds({ olderThanMs: 2 * 60 * 60 * 1000 });
  eq(result.released, 0, "fresh holds untouched");
  eq(result.scanned, 0, "fresh + settled holds not even scanned (cutoff / anti-join)");
  const rows = await db.creditLedger.findMany({ where: { userId: user.id } });
  eq(rows.length, 3, "hold + hold + zero-delta adjustment — unchanged");
  const resolved = await billing.resolveUserPlan(user.id);
  eq(resolved.creditBalance, 94_000, "balance = 100k − 4k image hold − 2k tts actual");
});

await test("CreditBlockedError maps to a JSON 402 (Phase 0 audit C7)", async () => {
  const err = new billing.CreditBlockedError("video", 40_000, 1_000);
  const res = billing.creditBlockResponse(err);
  ok(res, "mapped to a Response");
  eq((res as Response).status, 402, "status 402");
  const body = (await (res as Response).json()) as { code?: string; capability?: string };
  eq(body.code, "insufficient_credits", "machine-readable code");
  eq(body.capability, "video", "capability echoed");
  ok(billing.creditBlockResponse(new Error("nope")) === null, "other errors fall through");
});

await test("startJob refuses while a pending OR running row exists for the same entityId+kind (audit R-01)", async () => {
  const { user } = await makePaidUser(`${MARK}.p10dedupe@t.test`, "active");
  const org = await makeOrg(user.id);
  const videoId = `s72dedupe-${MARK}-1`;
  const jobs = await import("../src/lib/tubeforge/jobs");

  // A running row claimed by ANOTHER process (the worker) — invisible to
  // this process's in-memory state, and previously to the dedupe too.
  await db.job.create({
    data: { organizationId: org.id, userId: user.id, kind: "render", entityId: videoId, status: "running", attempts: 1 },
  });
  let started = await withCtx({ userId: user.id, organizationId: org.id, role: "owner" }, () =>
    jobs.startJob(videoId, "render", async () => {})
  );
  eq(started, false, "running row blocks the duplicate enqueue");
  eq(await db.job.count({ where: { entityId: videoId, kind: "render" } }), 1, "no second job row was created");

  await db.job.updateMany({ where: { entityId: videoId, kind: "render" }, data: { status: "pending" } });
  started = await withCtx({ userId: user.id, organizationId: org.id, role: "owner" }, () =>
    jobs.startJob(videoId, "render", async () => {})
  );
  eq(started, false, "pending row blocks too (regression guard)");
  eq(await db.job.count({ where: { entityId: videoId, kind: "render" } }), 1, "still exactly one row");
});

// ===========================================================================
// summary
// ===========================================================================
console.log(`\n${"─".repeat(56)}`);
console.log(`${passed} passed, ${failed} failed${failures.length ? ":" : ""}`);
for (const f of failures) console.log(`  ✗ ${f}`);
await cleanup();
await db.$disconnect();
process.exit(failed > 0 ? 1 : 0);
