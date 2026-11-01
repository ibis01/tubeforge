"use client";

// plan-card.tsx — Stage 7 (T-7.5 wiring): the Settings plan card.
//
// Surfaces the user's current plan + credit balance (GET /api/billing/plan).
// Read-only for now — the Stripe Checkout upgrade flow is a follow-up (the
// webhook already handles checkout.session.completed, so once a checkout
// route exists the "Upgrade" button wires straight into it).
//
// Design: matches the settings cards (glass rounded-2xl, hairline rows).
// Shows: tier badge, credits remaining / monthly allotment with a progress
// bar, resolution cap, priority-rendering flag, and (when a paid
// subscription exists) its status + renewal date.

import { useEffect, useState } from "react";
import { CreditCard, Sparkles, Gauge, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { clsx } from "clsx";

interface PlanResponse {
  plan: {
    tier: string;
    name: string;
    monthlyCredits: number;
    maxResolution: string;
    priorityRendering: boolean;
    teamMembers: number;
  };
  subscription: {
    id: string;
    status: string;
    currentPeriodEnd: string | null;
    stripeCustomerId: string | null;
  } | null;
  // Stage 7.1: "full" (active/trialing) | "grace" (past_due — dunning) |
  // "none" (canceled/etc. — the plan already fell back to Starter).
  access: "full" | "grace" | "none";
  creditBalance: number;
  creditBalanceMicro: number;
}

const TIER_BADGE: Record<string, string> = {
  starter: "border-white/15 bg-white/5 text-muted-foreground",
  creator: "border-primary/40 bg-primary/10 text-primary",
  studio: "border-violet-500/40 bg-violet-500/10 text-violet-300",
};

export function PlanCard() {
  const { toast } = useToast();
  const [data, setData] = useState<PlanResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/billing/plan", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as PlanResponse);
    } catch (err) {
      toast({
        title: "Could not load plan",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const used = data ? Math.max(0, data.plan.monthlyCredits - data.creditBalance) : 0;
  const pct = data && data.plan.monthlyCredits > 0
    ? Math.min(100, Math.round((used / data.plan.monthlyCredits) * 100))
    : 0;

  return (
    <div className="glass rounded-2xl p-5 sm:p-6 space-y-4">
      <div className="flex items-center gap-2.5">
        <div className="h-9 w-9 rounded-xl bg-brand-gradient flex items-center justify-center glow-red-soft shrink-0">
          <CreditCard className="h-4.5 w-4.5 text-white" />
        </div>
        <div className="min-w-0">
          <h3 className="font-semibold leading-tight">Plan &amp; Credits</h3>
          <p className="text-xs text-muted-foreground">
            Your subscription and monthly AI credit balance
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-8 w-8 p-0"
          onClick={() => void load()}
          disabled={loading}
          title="Refresh"
        >
          <RefreshCw className={clsx("h-3.5 w-3.5", loading && "animate-spin")} />
        </Button>
      </div>

      {loading && !data ? (
        <div className="py-6 text-center text-xs text-muted-foreground">Loading plan…</div>
      ) : !data ? (
        <div className="py-6 text-center text-xs text-muted-foreground">
          Plan unavailable — try again in a moment.
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className={TIER_BADGE[data.plan.tier] ?? TIER_BADGE.starter}>
              <Sparkles className="h-3 w-3 mr-1" />
              {data.plan.name}
            </Badge>
            {data.subscription ? (
              <Badge
                variant="outline"
                className={clsx(
                  "text-[10px]",
                  data.subscription.status === "active"
                    ? "border-emerald-500/25 bg-emerald-500/8 text-emerald-300"
                    : "border-amber-500/25 bg-amber-500/8 text-amber-300"
                )}
              >
                {data.subscription.status}
              </Badge>
            ) : (
              <Badge variant="outline" className="border-white/15 bg-white/5 text-muted-foreground text-[10px]">
                free tier
              </Badge>
            )}
            <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground">
              <Gauge className="h-3 w-3" />
              up to {data.plan.maxResolution}
              {data.plan.priorityRendering ? " · priority rendering" : ""}
            </span>
          </div>

          {/* Stage 7.1 — payment-failed banner while a paid subscription is
              in dunning (past_due): plan still works, but the card must say
              why the next invoice matters. */}
          {data.access === "grace" && (
            <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300">
              The last payment failed — your plan keeps working for now, but update your payment method in the
              customer portal to avoid losing paid features.
            </p>
          )}

          {/* Credit balance — bar + numbers (1 credit = $0.001 placeholder unit) */}
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between">
              <span className="text-xs text-muted-foreground">Credits remaining</span>
              <span className="text-xs font-mono">
                {data.creditBalance.toLocaleString()} / {data.plan.monthlyCredits.toLocaleString()}
              </span>
            </div>
            <div className="h-2 rounded-full bg-white/8 overflow-hidden">
              <div
                className={clsx(
                  "h-full rounded-full transition-all",
                  pct >= 90 ? "bg-red-500/80" : pct >= 70 ? "bg-amber-500/80" : "bg-primary/80"
                )}
                style={{ width: `${pct}%` }}
                role="progressbar"
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Credits used this period"
              />
            </div>
            <p className="text-[10px] text-muted-foreground">
              {used.toLocaleString()} used this period · AI calls spend credits automatically
              {data.plan.tier === "starter" ? " · the free tier never hard-blocks a render" : ""}
            </p>
          </div>

          {data.subscription?.currentPeriodEnd && (
            <p className="text-[10px] text-muted-foreground">
              Renews{" "}
              {new Date(data.subscription.currentPeriodEnd).toLocaleDateString(undefined, {
                year: "numeric",
                month: "short",
                day: "numeric",
              })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
