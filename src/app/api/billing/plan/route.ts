// GET /api/billing/plan — Stage 7 T-7.5: returns the user's current plan
// and credit balance. Used by the Settings UI to render "Plan: Creator,
// credits remaining: 8423 / 10000".
//
// This is the only billing surface exposed to the user's session. The
// webhook is public (Stripe can't auth); the plan endpoint requires auth.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/tubeforge/tenant";
import { resolveUserPlan } from "@/lib/tubeforge/billing";

export async function GET(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const resolved = await resolveUserPlan(auth.ctx.userId);
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
    creditBalance: resolved.creditBalance,
  });
}
