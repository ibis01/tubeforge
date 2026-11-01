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
// summary
// ===========================================================================
console.log(`\n${"─".repeat(56)}`);
console.log(`${passed} passed, ${failed} failed${failures.length ? ":" : ""}`);
for (const f of failures) console.log(`  ✗ ${f}`);
await cleanup();
await db.$disconnect();
process.exit(failed > 0 ? 1 : 0);
