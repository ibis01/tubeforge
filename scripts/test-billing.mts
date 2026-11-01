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
// summary
// ===========================================================================
console.log(`\n${"─".repeat(56)}`);
console.log(`${passed} passed, ${failed} failed${failures.length ? ":" : ""}`);
for (const f of failures) console.log(`  ✗ ${f}`);
await cleanup();
await db.$disconnect();
process.exit(failed > 0 ? 1 : 0);
