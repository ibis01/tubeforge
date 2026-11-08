// The daily-usage sparkline query — ONE source of truth for the SQL behind
// /api/account/usage and for the PostgreSQL CI lane's portability probe
// (scripts/pg-ci-verify.mts imports THIS function, so CI exercises the exact
// production SQL, not a copy that can drift).
//
// S60 portability law — the query must run on BOTH providers:
//   - every identifier double-quoted. Postgres folds unquoted camelCase
//     identifiers to lowercase (42703 "column does not exist"); SQLite
//     accepts the standard double-quoting, so quoting costs nothing there.
//   - the failure predicate is `NOT "ok"`. `ok` is Boolean in the schema —
//     a real boolean on Postgres, 0/1 on SQLite — so `ok = 0` (the original
//     SQLite-only shape) is a type error on Postgres booleans (42883).
//
// Both behaviors are asserted on a real Postgres 17 by the CI `postgres`
// job added in S61; the SQLite suites keep covering the other provider.

import type { PrismaClient } from "@prisma/client";

/** Anything with a raw query channel — the base client and the tenant
 *  $extends wrapper both satisfy it. */
export type RawQueryable = Pick<PrismaClient, "$queryRaw">;

export interface DailyUsagePoint {
  day: string; // YYYY-MM-DD (first 10 chars of the stored timestamp)
  calls: number;
  failures: number;
}

export async function dailyUsageSparkline(
  db: RawQueryable,
  userId: string,
  since: Date
): Promise<DailyUsagePoint[]> {
  const rows = await db.$queryRaw<{ day: string; calls: bigint; failures: bigint }[]>`
    SELECT substr(CAST("createdAt" AS TEXT), 1, 10) AS day, COUNT(*) AS calls,
           SUM(CASE WHEN NOT "ok" THEN 1 ELSE 0 END) AS failures
    FROM "UsageRecord"
    WHERE "userId" = ${userId} AND "createdAt" >= ${since}
    GROUP BY day ORDER BY day ASC`;
  return rows.map((d) => ({
    day: d.day,
    calls: Number(d.calls),
    failures: Number(d.failures),
  }));
}
