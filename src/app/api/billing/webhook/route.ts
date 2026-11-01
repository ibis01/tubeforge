// POST /api/billing/webhook — Stage 7 T-7.5: Stripe webhook receiver.
//
// Receives Stripe events for subscription lifecycle updates. The webhook
// is the SOLE source of truth for Subscription status — billing writes go
// through this endpoint, never through the user's own session.
//
// The handler logic lives in src/lib/tubeforge/billing.ts (handleStripeEvent)
// so the route can be a thin wrapper; routes are forbidden from importing
// @/lib/db directly (the tf/no-raw-db-in-api rule — billing writes are
// global, not per-tenant, so the lib is the right home).
//
// Events handled (in billing.ts):
//   - checkout.session.completed    → create a Subscription row with the
//                                      Stripe customer + subscription ids.
//   - customer.subscription.updated  → update status + currentPeriodEnd.
//   - customer.subscription.deleted   → status:"canceled".
//   - invoice.paid                   → write a CreditGrant row for the period.
//
// Signature verification: when `TUBEFORGE_STRIPE_WEBHOOK_SECRET` is set,
// the `stripe-signature` header is verified against the raw payload using
// Stripe's HMAC SHA-256 scheme (verifyStripeSignature in billing.ts). When
// the secret is absent (local dev / staging), the event is accepted with a
// console warning so the route can be exercised end-to-end. NEVER run
// production without the secret.
//
// The endpoint is PUBLIC — no auth. Stripe can't authenticate against our
// session cookie. The signature is the auth.

import { NextRequest, NextResponse } from "next/server";
import { handleStripeEvent, verifyStripeSignature } from "@/lib/tubeforge/billing";

export async function POST(req: NextRequest) {
  const sig = req.headers.get("stripe-signature");
  const secret = process.env.TUBEFORGE_STRIPE_WEBHOOK_SECRET?.trim();
  const raw = await req.clone().text();

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (secret && sig) {
    const verified = await verifyStripeSignature(raw, sig, secret);
    if (!verified) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
  } else if (!secret) {
    console.warn("[billing/webhook] TUBEFORGE_STRIPE_WEBHOOK_SECRET not set — accepting unverified event (DEV ONLY)");
  }

  const event = body as { type?: string };
  if (!event?.type) {
    return NextResponse.json({ error: "Missing event type" }, { status: 400 });
  }

  try {
    await handleStripeEvent(event as Parameters<typeof handleStripeEvent>[0]);
  } catch (err) {
    console.error("[billing/webhook] handler failed:", err);
    return NextResponse.json({ error: "Handler failed" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
