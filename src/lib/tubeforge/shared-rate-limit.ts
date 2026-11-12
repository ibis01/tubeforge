// S102 / P0.4 — the SHARED per-IP rate limiter
// (docs/production-readiness.md, gate P0.4).
//
// The middleware's in-memory buckets are coarse PER-INSTANCE shedding and
// architecture-correct (edge runtime, DB-banned — see src/middleware.ts).
// The AUTHORITATIVE law is the DB-backed fixed-window counter below:
// enforced at requireUser (every protected route funnels through it),
// shared by every instance, surviving deploys. The admission is a raw
// upsert that increments and RETURNS the count in one statement — the DB
// serializes the racers, so two instances cannot both admit the overflow.
// Quoted identifiers and no boolean literals (the S60 Postgres-portability
// lesson). The client IP comes from proxy-trust.ts's trusted law — never
// the spoofable first X-Forwarded-For value.
//
// FAILURE POSTURE — fail OPEN, loudly (the auth-throttle pattern): the
// limiter is a damper, not a security control; a DB error degrades to
// "no shared limit" with a once-per-process announcement, while the
// middleware's cheap per-instance gate keeps shedding floods.

import { rawDatabase as rawDb } from "./tenant-db";
import { log } from "./log";

const rateLog = log.child({ mod: "shared-rate-limit" });

export interface SharedRateHit {
  ok: boolean;
  retryAfterSec: number;
}

export const SHARED_WINDOW_SEC = 60;

function envInt(name: string, dflt: number): number {
  const raw = process.env[name];
  if (!raw) return dflt;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

/** Shared per-IP tiers — mirror the middleware's coarse tiers. 0 disables. */
export const SHARED_READ_LIMIT = envInt("TUBEFORGE_RATE_READ", 600);
export const SHARED_WRITE_LIMIT = envInt("TUBEFORGE_RATE_WRITE", 90);

// Once-per-process fail-open announcements (auth-throttle's posture).
const g = globalThis as typeof globalThis & { __tfSharedRateWarned?: boolean };
function warnFailOpen(err: unknown): void {
  if (g.__tfSharedRateWarned) return;
  g.__tfSharedRateWarned = true;
  rateLog.error(
    "RateLimitCounter write failed — the SHARED limiter is OFF (per-instance middleware shedding continues; apply the S102 migration).",
    { err },
  );
}

/**
 * Record one hit for `key` in the CURRENT fixed 60s window and report the
 * shared decision. Atomic: the upsert increments and returns the count in
 * one statement, so concurrent instances serialize on the row.
 */
export async function hitSharedBucket(key: string, limit: number, now: number = Date.now()): Promise<SharedRateHit> {
  if (limit <= 0) return { ok: true, retryAfterSec: 0 };
  const windowStart = Math.floor(now / (SHARED_WINDOW_SEC * 1000)); // epoch seconds
  try {
    const rows = await rawDb.$queryRaw<{ count: number }[]>`
      INSERT INTO "RateLimitCounter" ("key", "windowStart", "count", "updatedAt")
      VALUES (${key}, ${windowStart}, 1, ${new Date(now)})
      ON CONFLICT ("key", "windowStart")
      DO UPDATE SET "count" = "RateLimitCounter"."count" + 1, "updatedAt" = ${new Date(now)}
      RETURNING "count"
    `;
    const count = Number(rows[0]?.count ?? 0);
    if (count > limit) {
      const windowEndSec = (windowStart + 1) * SHARED_WINDOW_SEC;
      return { ok: false, retryAfterSec: Math.max(1, windowEndSec - Math.floor(now / 1000)) };
    }
    return { ok: true, retryAfterSec: 0 };
  } catch (err) {
    warnFailOpen(err);
    return { ok: true, retryAfterSec: 0 }; // fail OPEN, loudly (see the header)
  }
}

/**
 * The shared limiter as requireUser consumes it: tier the request, key it
 * by the TRUSTED client IP, apply the shared ceiling. Returns ok=false with
 * the 429 posture when the IP is over the shared ceiling.
 */
export async function enforceSharedRateLimit(
  headers: { get(name: string): string | null },
  mutating: boolean,
  now: number = Date.now()
): Promise<SharedRateHit> {
  const { trustedClientIp } = await import("./proxy-trust");
  const limit = mutating ? SHARED_WRITE_LIMIT : SHARED_READ_LIMIT;
  if (limit <= 0) return { ok: true, retryAfterSec: 0 };
  return hitSharedBucket(`${mutating ? "w" : "r"}:${trustedClientIp(headers)}`, limit, now);
}

/** Drop window rows too old to matter again (kept 5 windows for forensics). */
export async function sweepRateLimitCounters(now: number = Date.now()): Promise<number> {
  const cutoff = new Date(now - 5 * SHARED_WINDOW_SEC * 1000);
  const gone = await rawDb.rateLimitCounter.deleteMany({ where: { updatedAt: { lt: cutoff } } });
  return gone.count;
}
