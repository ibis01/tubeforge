// POST /api/billing/webhook — Stage 7 T-7.5: Stripe webhook receiver.
//
// Receives Stripe events for subscription lifecycle updates. The webhook
// is the SOLE source of truth for Subscription status — billing writes go
// through this endpoint, never through the user's own session.
//
// The handler logic lives in src/lib/tubeforge/billing.ts (processStripeEvent)
// so the route can be a thin wrapper; routes are forbidden from importing
// @/lib/db directly (the tf/no-raw-db-in-api rule — billing writes are
// global, not per-tenant, so the lib is the right home).
//
// Events handled (in billing.ts):
//   - checkout.session.completed    → create a Subscription row with the
//                                      Stripe customer + subscription ids.
//   - customer.subscription.updated  → update status + currentPeriodEnd.
//   - customer.subscription.deleted   → status:"canceled".
//   - invoice.paid                   → write a CreditGrant row for the period
//                                      (idempotent on the invoice id).
//
// Signature verification (Stage 7.1 fix #1 — FAIL-CLOSED):
//   * TUBEFORGE_STRIPE_WEBHOOK_SECRET set  → the `stripe-signature` header
//     is REQUIRED and verified (HMAC SHA-256 + 300s replay window). A
//     missing or invalid signature is a 401 — the request is never
//     processed. This closes the old hole where a configured secret was
//     silently skipped when the header was absent.
//   * Secret NOT set → the endpoint refuses EVERYWHERE by default. Local
//     development may opt in with TUBEFORGE_ALLOW_UNSIGNED_WEBHOOKS=1 —
//     an explicit, per-environment escape hatch that must never be set in
//     production. In production (NODE_ENV=production) a missing secret is
//     a 500 server misconfiguration; outside production it is a 401.
//
// The endpoint is PUBLIC — no auth. Stripe can't authenticate against our
// session cookie. The signature is the auth.

import { NextRequest, NextResponse } from "next/server";
import { processStripeEvent, verifyStripeSignature } from "@/lib/tubeforge/billing";

export async function POST(req: NextRequest) {
  const sig = req.headers.get("stripe-signature");
  const secret = process.env.TUBEFORGE_STRIPE_WEBHOOK_SECRET?.trim() ?? "";
  const isProduction = process.env.NODE_ENV === "production";
  const raw = await req.clone().text();

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!secret) {
    // Fail-closed: an unconfigured webhook endpoint accepts NOTHING. The
    // only bypass is the explicit dev opt-in — refused outright in
    // production regardless (defence in depth against a copied .env).
    if (isProduction) {
      console.error("[billing/webhook] TUBEFORGE_STRIPE_WEBHOOK_SECRET missing in production — rejecting event");
      return NextResponse.json({ error: "Webhook misconfigured" }, { status: 500 });
    }
    if (process.env.TUBEFORGE_ALLOW_UNSIGNED_WEBHOOKS !== "1") {
      return NextResponse.json(
        { error: "Webhook not configured — set TUBEFORGE_STRIPE_WEBHOOK_SECRET (or TUBEFORGE_ALLOW_UNSIGNED_WEBHOOKS=1 in local dev)" },
        { status: 401 }
      );
    }
    console.warn("[billing/webhook] accepting UNSIGNED event — TUBEFORGE_ALLOW_UNSIGNED_WEBHOOKS=1 (DEV ONLY)");
  } else {
    // Secret configured → the signature header is mandatory, no matter the
    // environment. Missing header and bad signature are both 401.
    if (!sig) {
      return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 401 });
    }
    const verified = await verifyStripeSignature(raw, sig, secret);
    if (!verified) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
  }

  const event = body as { type?: string };
  if (!event?.type) {
    return NextResponse.json({ error: "Missing event type" }, { status: 400 });
  }

  try {
    const outcome = await processStripeEvent(event as Parameters<typeof processStripeEvent>[0]);
    return NextResponse.json({ received: true, ...(outcome === "duplicate" ? { duplicate: true } : {}) });
  } catch (err) {
    console.error("[billing/webhook] handler failed:", err);
    return NextResponse.json({ error: "Handler failed" }, { status: 500 });
  }
}
