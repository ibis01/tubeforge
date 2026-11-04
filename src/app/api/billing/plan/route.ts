// GET /api/billing/plan — Stage 7 T-7.5: returns the user's current plan
// and credit balance. Used by the Settings UI to render "Plan: Creator,
// credits remaining: 8423 / 10000".
//
// This is the only billing surface exposed to the user's session. The
// webhook is public (Stripe can't auth); the plan endpoint requires auth.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/tubeforge/tenant";
import { resolveUserPlan, microToCredits } from "@/lib/tubeforge/billing";
import { stripeGate, CHECKOUT_TIERS } from "@/lib/tubeforge/stripe";

export async function GET(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const resolved = await resolveUserPlan(auth.ctx.userId);
  // Display unit = UI credits (the plan's monthlyCredits unit). The ledger's
  // canonical microCredits stay internal; creditBalanceMicro carries the
  // exact remainder for anything that needs sub-credit precision.
  //
  // S24: the stripe block tells the plan card which doors exist on THIS
  // deployment — checkout only where the key + that tier's price env are
  // set, portal wherever the key is set. The card renders honest buttons
  // (or an "operator hasn't wired Stripe" hint) from this, never guessing.
  const gate = stripeGate();
  return NextResponse.json({
    plan: {
      tier: resolved.plan.tier,
      name: resolved.plan.name,
      monthlyCredits: resolved.plan.monthlyCredits,
      maxResolution: resolved.plan.maxResolution,
      priorityRendering: resolved.plan.priorityRendering,
      teamMembers: resolved.plan.teamMembers,
    },
    subscription: resolved.subscription,
    // Stage 7.1: paid-plan access level — "grace" (past_due) renders the
    // payment-failed banner in the UI, "none" means the plan already fell
    // back to Starter.
    access: resolved.access,
    creditBalance: microToCredits(resolved.creditBalance),
    creditBalanceMicro: resolved.creditBalance,
    stripe: {
      configured: Boolean(gate.secret),
      checkoutTiers: CHECKOUT_TIERS.filter((t) =>
        Boolean(gate.secret && gate.prices[t])
      ),
    },
  });
}
