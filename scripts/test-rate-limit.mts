// S102 / P0.4 — the shared rate limiter + trusted-proxy battery
// (docs/production-readiness.md: "multi-instance limits and spoofing tests pass").
//
//   npm run test:rate     (needs the local SQLite DB)
//
//   1. THE SPOOFING LAW (pure) — the client IP is resolved by walking
//      X-Forwarded-For RIGHT to LEFT, skipping trusted proxies: a spoofed
//      leftmost value is ignored whenever a real proxy appended a public
//      IP; private/loopback entries never impersonate a client; the
//      all-trusted chain falls back to its leftmost entry; TUBEFORGE_
//      TRUSTED_PROXIES extends the trusted set (CIDR support).
//   2. THE SHARED LAW (DB) — the fixed-window counter is durable shared
//      state: N concurrent racers on one key admit exactly `limit` of
//      themselves (the DB serializes the upserts), a second INDEPENDENT
//      client sees the same count (there is no in-memory truth), the
//      blocked hit carries an honest retryAfterSec, and the next window
//      admits again.
//   3. THE SPOOF-RESISTANCE OF THE LIMITER — two forged chains resolving
//      to the same victim IP land in the SAME bucket (evading via XFF
//      rotation is dead).
//   4. THE SWEEP — stale windows are pruned, fresh windows survive.

import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

let failed = false;
function ok(cond: unknown, msg: string): asserts cond {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    failed = true;
    console.error(`  ✗ ${msg}`);
  }
}

function headers(map: Record<string, string>): { get(name: string): string | null } {
  const lower = new Map(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lower.get(name.toLowerCase()) ?? null };
}

async function main(): Promise<void> {
  console.log("◆ S102 / P0.4 — shared rate limiter + trusted proxy (spoofing + multi-instance battery)");
  const { trustedClientIp, isTrustedProxyIp } = await import("../src/lib/tubeforge/proxy-trust");
  const { hitSharedBucket, sweepRateLimitCounters } = await import(
    "../src/lib/tubeforge/shared-rate-limit"
  );

  // ---- 1. THE SPOOFING LAW -------------------------------------------------
  ok(
    trustedClientIp(headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" })) === "203.0.113.9",
    "a spoofed leftmost entry is IGNORED when a proxy appended a public IP (rightmost untrusted wins)"
  );
  ok(
    trustedClientIp(headers({ "x-forwarded-for": "1.2.3.4, 10.0.0.5, 198.51.100.7" })) === "198.51.100.7",
    "private hops in the middle of the chain are skipped (the proxy tiers)"
  );
  ok(
    trustedClientIp(headers({ "x-forwarded-for": "10.0.0.5" })) === "10.0.0.5",
    "an all-trusted chain falls back to its leftmost entry (direct private traffic)"
  );
  ok(
    trustedClientIp(headers({ "x-forwarded-for": "::1, 2001:db8::9" })) === "2001:db8::9",
    "IPv6: loopback is trusted, a public v6 client wins"
  );
  ok(
    trustedClientIp(headers({ "x-real-ip": "198.51.100.4" })) === "198.51.100.4",
    "no XFF → x-real-ip (proxy-set)"
  );
  ok(trustedClientIp(headers({})) === "local", "no proxy headers at all → local");
  ok(isTrustedProxyIp("172.20.3.4") && isTrustedProxyIp("100.100.1.2") && isTrustedProxyIp("fe80::1"),
    "private/CGNAT/link-local ranges are trusted proxies by default");
  ok(!isTrustedProxyIp("203.0.113.9") && !isTrustedProxyIp("2001:db8::9"), "public IPs are never trusted proxies");
  process.env.TUBEFORGE_TRUSTED_PROXIES = "100.64.0.0/10, 198.18.0.1";
  ok(isTrustedProxyIp("100.64.5.5") && isTrustedProxyIp("198.18.0.1"), "TUBEFORGE_TRUSTED_PROXIES extends the trusted set (CIDR + exact)");
  ok(!isTrustedProxyIp("100.128.0.1"), "the CIDR honors its mask (100.128/10 is OUTSIDE 100.64/10)");
  delete process.env.TUBEFORGE_TRUSTED_PROXIES;

  // ---- 2. THE SHARED LAW (DB) ----------------------------------------------
  const run = `rl${Date.now().toString(36)}`;
  const victim = `198.51.100.${Math.floor(Math.random() * 200) + 10}`;
  const key = `w:${victim}:${run}`;
  try {
    const results = await Promise.all(
      Array.from({ length: 12 }, () => hitSharedBucket(key, 5))
    );
    const allowed = results.filter((r) => r.ok).length;
    const blocked = results.filter((r) => !r.ok);
    ok(allowed === 5, `12 concurrent racers against a 5-hit shared window: exactly 5 admitted (got ${allowed})`);
    ok(
      blocked.length === 7 && blocked.every((r) => r.retryAfterSec >= 1 && r.retryAfterSec <= 60),
      "every blocked hit carries an honest retryAfterSec inside the window"
    );
    // The state is the TABLE — an independent client sees the same count.
    const windowStart = Math.floor(Date.now() / 60_000);
    const row = await db.$queryRaw<{ count: number }[]>`
      SELECT "count" FROM "RateLimitCounter" WHERE "key" = ${key} AND "windowStart" = ${windowStart}
    `;
    ok(Number(row[0]?.count ?? 0) === 12, `an INDEPENDENT client reads the same counter (count=${Number(row[0]?.count ?? 0)}) — there is no in-memory truth`);

    // Next window admits again (fixed-window semantics).
    const nextWindow = (windowStart + 1) * 60_000 + 500;
    const fresh = await hitSharedBucket(key, 5, nextWindow);
    ok(fresh.ok, "the NEXT window admits again");

    // ---- 3. SPOOF RESISTANCE OF THE LIMITER — forged chains converge on the victim
    const { enforceSharedRateLimit } = await import("../src/lib/tubeforge/shared-rate-limit");
    const forge1 = headers({ "x-forwarded-for": `9.9.9.9, ${victim}` });
    const forge2 = headers({ "x-forwarded-for": `8.8.8.8, ${victim}` });
    const r1 = await enforceSharedRateLimit(forge1, true);
    const r2 = await enforceSharedRateLimit(forge2, true);
    ok(r1.ok && r2.ok, "two forged chains from 'different' attackers both resolve to the victim IP");
    const victimKey = `w:${victim}`;
    const victimRow = await db.$queryRaw<{ count: number }[]>`
      SELECT "count" FROM "RateLimitCounter" WHERE "key" = ${victimKey} AND "windowStart" = ${windowStart}
    `;
    ok(
      Number(victimRow[0]?.count ?? 0) >= 2,
      `both forged hits landed in the VICTIM's bucket (count=${Number(victimRow[0]?.count ?? 0)}) — XFF rotation cannot evade the shared limiter`
    );

    // ---- 4. THE SWEEP ---------------------------------------------------------
    await db.$executeRaw`
      INSERT INTO "RateLimitCounter" ("key", "windowStart", "count", "updatedAt")
      VALUES (${"stale:" + run}, 1, 3, ${new Date(Date.now() - 10 * 60_000)})
      ON CONFLICT ("key", "windowStart") DO NOTHING
    `;
    const swept = await sweepRateLimitCounters();
    ok(swept >= 1, `the sweep prunes stale windows (${swept})`);
    const survived = await db.$queryRaw<{ n: number }[]>`
      SELECT COUNT(*) AS n FROM "RateLimitCounter" WHERE "key" = ${key}
    `;
    ok(Number(survived[0]?.n ?? 0) >= 1, "fresh windows survive the sweep (5-window forensics horizon)");
  } finally {
    // cleanup — the battery's rows only
    await db.rateLimitCounter.deleteMany({ where: { key: { contains: run } } }).catch(() => {});
    await db.rateLimitCounter.deleteMany({ where: { key: `w:${victim}` } }).catch(() => {});
    await db.rateLimitCounter.deleteMany({ where: { key: { startsWith: "stale:" } } }).catch(() => {});
    await db.$disconnect();
  }

  if (failed) {
    console.error("\nrate limiter battery: FAIL");
    process.exit(1);
  }
  console.log("\nrate limiter battery: PASS");
}

main().catch((err) => {
  console.error("[test-rate-limit] fatal:", err);
  process.exit(1);
});
