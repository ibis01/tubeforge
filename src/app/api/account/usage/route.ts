// GET /api/account/usage — per-user, per-capability AI usage aggregates
// (Stage 3, T-3.8). Backs the account/usage dashboard: call counts, failure
// rate, latency profile, storage footprint. Raw rows stay server-side; this
// endpoint only ever emits aggregates + a capped recent-activity tail.
//
// Query params:
//   ?days=N   — window in days (1..90, default 30)

import { NextRequest, NextResponse } from "next/server";
import { rawDatabase as rawDb } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { usageBytes, storageQuotaBytes, storageDriverKind } from "@/lib/tubeforge/storage";

export async function GET(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();
  const { userId, organizationId } = auth.ctx;

  const daysParam = Number(new URL(req.url).searchParams.get("days") ?? "30");
  const days = Number.isFinite(daysParam) ? Math.min(Math.max(Math.floor(daysParam), 1), 90) : 30;
  const since = new Date(Date.now() - days * 24 * 3600 * 1000);

  // Per-capability aggregates for the acting user (their own usage, not the
  // whole org — the org view arrives with the Stage 5 admin dashboard).
  const grouped = await rawDb.usageRecord.groupBy({
    by: ["capability", "provider", "ok"],
    where: { userId, createdAt: { gte: since } },
    _count: { _all: true },
    _sum: { inputTokens: true, outputTokens: true, costMicroUsd: true },
    _avg: { latencyMs: true },
    _max: { latencyMs: true },
  });

  type Row = (typeof grouped)[number];
  const byCapability = new Map<
    string,
    {
      capability: string;
      calls: number;
      failures: number;
      inputTokens: number;
      outputTokens: number;
      costMicroUsd: number;
      avgLatencyMs: number | null;
      maxLatencyMs: number | null;
      providers: Record<string, number>;
    }
  >();
  for (const row of grouped as Row[]) {
    const entry =
      byCapability.get(row.capability) ??
      {
        capability: row.capability,
        calls: 0,
        failures: 0,
        inputTokens: 0,
        outputTokens: 0,
        costMicroUsd: 0,
        avgLatencyMs: null as number | null,
        maxLatencyMs: null as number | null,
        providers: {} as Record<string, number>,
      };
    const n = row._count._all;
    const prevCalls = entry.calls;
    entry.calls += n;
    if (!row.ok) entry.failures += n;
    entry.inputTokens += Number(row._sum.inputTokens ?? 0);
    entry.outputTokens += Number(row._sum.outputTokens ?? 0);
    entry.costMicroUsd += Number(row._sum.costMicroUsd ?? 0);
    // weighted merge of averages
    const avg = row._avg.latencyMs;
    if (avg != null) {
      entry.avgLatencyMs =
        prevCalls === 0 ? avg : ((entry.avgLatencyMs ?? 0) * prevCalls + avg * n) / (prevCalls + n);
    }
    entry.maxLatencyMs = Math.max(entry.maxLatencyMs ?? 0, row._max.latencyMs ?? 0);
    entry.providers[row.provider] = (entry.providers[row.provider] ?? 0) + n;
    byCapability.set(row.capability, entry);
  }

  // Daily call volume for the sparkline (portable SQL — date() exists in
  // SQLite and is a no-op passthrough on Postgres TEXT timestamps; the CI
  // Postgres job pins the schema, this query shape is the SQLite path).
  const daily = await rawDb.$queryRaw<{ day: string; calls: bigint; failures: bigint }[]>`
    SELECT substr(CAST(createdAt AS TEXT), 1, 10) AS day, COUNT(*) AS calls,
           SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failures
    FROM UsageRecord
    WHERE userId = ${userId} AND createdAt >= ${since}
    GROUP BY day ORDER BY day ASC`;

  const totalCalls = [...byCapability.values()].reduce((a, c) => a + c.calls, 0);
  const totalCostMicroUsd = [...byCapability.values()].reduce((a, c) => a + c.costMicroUsd, 0);

  // Storage footprint (org-level — quotas are per organization).
  const storageUsed = await usageBytes(organizationId);

  return NextResponse.json({
    window: { days, since: since.toISOString() },
    totals: {
      calls: totalCalls,
      costMicroUsd: totalCostMicroUsd,
      costUsd: totalCostMicroUsd / 1e6,
    },
    capabilities: [...byCapability.values()].sort((a, b) => b.calls - a.calls),
    daily: daily.map((d) => ({
      day: d.day,
      calls: Number(d.calls),
      failures: Number(d.failures),
    })),
    storage: {
      driver: storageDriverKind(),
      usedBytes: storageUsed,
      quotaBytes: storageQuotaBytes(),
    },
  });
}
