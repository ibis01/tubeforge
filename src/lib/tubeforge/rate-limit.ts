// Per-IP sliding-window API rate limiting — the coarse public gate that sits
// in front of auth (wired into src/middleware.ts): a flood gets 429'd whether
// or not it carries a session, while the finer protections (login lockout in
// auth.ts, the AI-provider budget in budget.ts) layer on top untouched.
//
// In-memory by design — the studio is a single self-hosted process, and the
// registry lives on globalThis so dev HMR / route recompiles share one state
// (same pattern as jobs.ts and auth.ts). Pure + clock-injectable so the
// offline unit suite can regression-test the window math (no next/server
// import — middleware builds the 429 response itself).

export interface RateHit {
  ok: boolean;
  retryAfterSec: number;
  remaining: number;
}

const g = globalThis as typeof globalThis & {
  __tfRateBuckets?: Map<string, number[]>;
};
const buckets: Map<string, number[]> = (g.__tfRateBuckets ??= new Map());

function envInt(name: string, dflt: number): number {
  const raw = process.env[name];
  if (!raw) return dflt;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

/** Requests per minute per IP — GET/HEAD tier. 0 disables the tier. */
export const READ_LIMIT = envInt("TUBEFORGE_RATE_READ", 600);
/** Requests per minute per IP — POST/PUT/PATCH/DELETE tier. 0 disables it. */
export const WRITE_LIMIT = envInt("TUBEFORGE_RATE_WRITE", 90);

const WINDOW_MS = 60_000;

function prune(now: number): void {
  for (const [key, hits] of buckets) {
    const newest = hits[hits.length - 1];
    if (newest === undefined || newest <= now - WINDOW_MS) buckets.delete(key);
  }
}

/**
 * Record one hit against `key` inside a sliding 60s window and report
 * whether it is allowed. `now` is injectable for deterministic tests.
 */
export function hitBucket(
  key: string,
  limit: number,
  now: number = Date.now()
): RateHit {
  // limit ≤ 0 = tier disabled — unlimited, and no bookkeeping.
  if (limit <= 0)
    return { ok: true, retryAfterSec: 0, remaining: Number.MAX_SAFE_INTEGER };

  if (buckets.size > 4096) prune(now);

  const windowStart = now - WINDOW_MS;
  const hits = buckets.get(key) ?? [];
  while (hits.length > 0 && hits[0] <= windowStart) hits.shift();

  if (hits.length >= limit) {
    const retryAfterSec = Math.max(
      1,
      Math.ceil((hits[0] + WINDOW_MS - now) / 1000)
    );
    return { ok: false, retryAfterSec, remaining: 0 };
  }

  hits.push(now);
  buckets.set(key, hits);
  return { ok: true, retryAfterSec: 0, remaining: limit - hits.length };
}

/** Reset all buckets (tests + admin tooling). */
export function resetBuckets(): void {
  buckets.clear();
}

/** Best-effort client IP behind the preview proxy (mirrors auth.ts). */
export function clientIpFrom(headers: {
  get(name: string): string | null;
}): string {
  return (
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headers.get("x-real-ip") ||
    "local"
  );
}
