// POST /api/billing/checkout — the upgrade door.
//
// Creates a Stripe Checkout Session (mode=subscription) for one paid tier
// and returns { url } — the client redirects to the Stripe-hosted page,
// which is the only place a PRICE is ever named (MASTER_PLAN: the app
// never sets final prices; the Price object in the Stripe dashboard does).
//
// The webhook's checkout.session.completed handler (billing.ts) closes the
// loop: it reads client_reference_id (our userId) + metadata.planTier and
// upserts the Subscription row — the exact shape this route arms. Its
// lifecycle chain (checkout → grant → failure → recovery) is already
// pinned by the billing integration suite.
//
// Laws:
//   * SESSION-ONLY (the S23 account law): money moves on a signed-in
//     browser, never on a bearer — a leaked API token must not be one POST
//     away from spending.
//   * FAIL-CLOSED (the driver law): without TUBEFORGE_STRIPE_SECRET_KEY +
//     the tier's price env the route answers 503 — never a fake success.
//   * POST body: unknown fields are stripped, not rejected (house law).

import { NextRequest, NextResponse } from "next/server";
import { requireUser, sessionIdFromRequest } from "@/lib/tubeforge/tenant";
import {
  isCheckoutTier,
  checkoutReady,
  stripeGate,
  stripeCreate,
  checkoutParams,
} from "@/lib/tubeforge/stripe";
import { resolveUserPlan } from "@/lib/tubeforge/billing";

export async function POST(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();
  const { userId } = auth.ctx;

  // Money is a browser-session affair — the S16/S20/S21/S23 law.
  const sid = await sessionIdFromRequest(req);
  if (!sid)
    return NextResponse.json(
      { error: "Billing is managed from a signed-in browser session only" },
      { status: 403 }
    );

  let tier = "";
  try {
    const body = (await req.json()) as { tier?: unknown };
    tier = String(body?.tier ?? "").trim();
  } catch {
    /* empty body → falls through to the 400 below */
  }
  if (!isCheckoutTier(tier))
    return NextResponse.json(
      { error: 'Send { "tier": "creator" | "studio" } — starter is the free plan.' },
      { status: 400 }
    );

  const gate = stripeGate();
  if (!gate.secret || !checkoutReady(tier)) {
    return NextResponse.json(
      {
        error:
          "Stripe is not configured on this deployment — set TUBEFORGE_STRIPE_SECRET_KEY and the tier's price env to open the checkout.",
      },
      { status: 503 }
    );
  }

  // Already an ACTIVE subscriber to this exact tier → nothing to buy.
  // (A canceled subscriber may re-checkout freely; a past_due one should
  //  use the portal to fix payment, but a fresh checkout is still allowed —
  //  Stripe treats it as a new subscription and the webhook re-binds.)
  const resolved = await resolveUserPlan(userId);
  if (
    resolved.access === "full" &&
    resolved.plan.tier === tier &&
    resolved.subscription
  )
    return NextResponse.json(
      { error: `This account is already on the ${resolved.plan.name} plan.` },
      { status: 409 }
    );

  const origin = new URL(req.url).origin;
  const result = await stripeCreate(
    "/checkout/sessions",
    checkoutParams({
      priceId: gate.prices[tier]!,
      userId,
      tier,
      successUrl: `${origin}/?billing=success`,
      cancelUrl: `${origin}/?billing=canceled`,
    }),
    gate.secret
  );
  // Stripe 4xx here means the OPERATOR's wiring is wrong (bad price id,
  // key without checkout access) — the user can't fix it, so it stays 502.
  if (!result.ok || !result.data || typeof result.data.url !== "string")
    return NextResponse.json(
      { error: result.error ?? "Stripe did not return a checkout URL" },
      { status: 502 }
    );

  return NextResponse.json({ ok: true, url: result.data.url });
}
