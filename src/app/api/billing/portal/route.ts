// POST /api/billing/portal — the manage-subscription door.
//
// Creates a Stripe Customer Portal session for the caller's Stripe customer
// id and returns { url }. This is the door the plan card's payment-failed
// banner has been promising since Stage 7.1 ("update your payment method in
// the customer portal") — until now that portal did not exist anywhere.
// Through it the user updates payment methods, cancels, or (per the Stripe
// dashboard's portal configuration) switches plans; every resulting event
// (customer.subscription.updated/deleted, invoice.paid) already has a
// handler in billing.ts.
//
// Laws (mirroring the checkout route):
//   * SESSION-ONLY — the S23 account law.
//   * FAIL-CLOSED — 503 without TUBEFORGE_STRIPE_SECRET_KEY.
//   * 409 when the account has no Stripe customer to manage — the portal
//     manages an EXISTING billing relationship, checkout creates one.

import { NextRequest, NextResponse } from "next/server";
import { requireUser, sessionIdFromRequest } from "@/lib/tubeforge/tenant";
import { portalReady, stripeGate, stripeCreate, portalParams } from "@/lib/tubeforge/stripe";
import { resolveUserPlan } from "@/lib/tubeforge/billing";

export async function POST(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();
  const { userId } = auth.ctx;

  const sid = await sessionIdFromRequest(req);
  if (!sid)
    return NextResponse.json(
      { error: "Billing is managed from a signed-in browser session only" },
      { status: 403 }
    );

  if (!portalReady())
    return NextResponse.json(
      {
        error:
          "Stripe is not configured on this deployment — set TUBEFORGE_STRIPE_SECRET_KEY to open the customer portal.",
      },
      { status: 503 }
    );

  const resolved = await resolveUserPlan(userId);
  const customerId = resolved.subscription?.stripeCustomerId ?? null;
  if (!customerId)
    return NextResponse.json(
      { error: "No subscription to manage — upgrade first, then manage it here." },
      { status: 409 }
    );

  const origin = new URL(req.url).origin;
  const result = await stripeCreate(
    "/billing_portal/sessions",
    portalParams({ customerId, returnUrl: `${origin}/?billing=portal` }),
    stripeGate().secret!
  );
  // Same operator-wiring rule as checkout: a Stripe 4xx (portal not enabled
  // for this account, bad customer id) is a deployment problem → 502.
  if (!result.ok || !result.data || typeof result.data.url !== "string")
    return NextResponse.json(
      { error: result.error ?? "Stripe did not return a portal URL" },
      { status: 502 }
    );

  return NextResponse.json({ ok: true, url: result.data.url });
}
