import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { getUserSettings, setUserSetting } from "@/lib/tubeforge/settings";
import { getCapability } from "@/lib/tubeforge/providers/settings";
import type { CapabilityId } from "@/lib/tubeforge/providers/registry";
import {
  parseScoreWeights,
  scoreProviders,
  type ProviderObservation,
  type ScoredProvider,
  type ScoreWeights,
} from "@/lib/tubeforge/provider-score";
import { errorText } from "@/lib/tubeforge/redact";

/**
 * S90 (ROADMAP #9) — the provider selection intelligence surface.
 *
 * GET: every capability's registry providers, scored with the configurable
 * weighted sum (quality / reliability / cost efficiency / latency / task
 * fit). Reliability, latency and (outside chat) cost come from the ORG'S
 * OWN UsageRecords — the last 90 days, capped rows — blended with the
 * documented priors. ADVISORY ONLY: dispatch keeps reading the user's
 * capability config; the paid-dispatch safety rules in spend.ts stand
 * unchanged.
 *
 * PUT { weights }: persist the user's weight override (tolerantly parsed
 * and clamped — junk falls back to the production-calibrated defaults).
 */

const CAPS: CapabilityId[] = ["chat", "tts", "image", "video"];
const WEIGHTS_KEY = "ai.scoreWeights";
const OBSERVATION_WINDOW_DAYS = 90;
const OBSERVATION_ROW_CAP = 4000;

function parseWeightsSetting(raw: string | undefined): ScoreWeights {
  if (!raw) return parseScoreWeights(undefined);
  try {
    return parseScoreWeights(JSON.parse(raw));
  } catch {
    return parseScoreWeights(undefined);
  }
}

export async function GET(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const since = new Date(Date.now() - OBSERVATION_WINDOW_DAYS * 86_400_000);
  const [rows, settings] = await Promise.all([
    db.usageRecord.findMany({
      where: {
        organizationId: auth.ctx.organizationId,
        createdAt: { gte: since },
        capability: { in: CAPS },
      },
      orderBy: { createdAt: "desc" },
      take: OBSERVATION_ROW_CAP,
      select: {
        capability: true,
        provider: true,
        ok: true,
        latencyMs: true,
        costMicroUsd: true,
      },
    }),
    getUserSettings([WEIGHTS_KEY]),
  ]);
  const weights = parseWeightsSetting(settings.get(WEIGHTS_KEY));

  // Aggregate per capability × provider (failures count toward reliability
  // and toward the per-call cost average — an attempt that billed and
  // errored is real spend).
  const agg = new Map<
    string,
    { calls: number; ok: number; latSum: number; latN: number; costSum: number }
  >();
  for (const r of rows) {
    const key = `${r.capability}::${r.provider}`;
    const a = agg.get(key) ?? { calls: 0, ok: 0, latSum: 0, latN: 0, costSum: 0 };
    a.calls++;
    if (r.ok) a.ok++;
    if (r.latencyMs != null) {
      a.latSum += r.latencyMs;
      a.latN++;
    }
    a.costSum += r.costMicroUsd;
    agg.set(key, a);
  }
  const observationsFor = (cap: string): Record<string, ProviderObservation> => {
    const out: Record<string, ProviderObservation> = {};
    for (const [key, a] of agg) {
      const [c, provider] = key.split("::");
      if (c !== cap || a.calls === 0) continue;
      out[provider] = {
        calls: a.calls,
        okCount: a.ok,
        meanLatencyMs: a.latN > 0 ? Math.round(a.latSum / a.latN) : null,
        meanCostMicroUsd: Math.round(a.costSum / a.calls),
      };
    }
    return out;
  };

  const capabilities: Partial<Record<CapabilityId, ScoredProvider[]>> = {};
  for (const cap of CAPS) {
    const cfg = await getCapability(cap);
    capabilities[cap] = scoreProviders(cap, {
      // `configured` marks the user's CURRENT pick for this capability.
      models: { [cfg.provider]: cfg.model },
      observations: observationsFor(cap),
      weights,
    });
  }

  return NextResponse.json({ weights, capabilities });
}

/** PUT { weights } — save the user's weight override (clamped, junk → defaults). */
export async function PUT(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  try {
    const body = (await req.json().catch(() => ({}))) as { weights?: unknown };
    const weights = parseScoreWeights(body?.weights);
    await setUserSetting(WEIGHTS_KEY, JSON.stringify(weights));
    return NextResponse.json({ weights });
  } catch (err) {
    const message = errorText(err, "Invalid request");
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
