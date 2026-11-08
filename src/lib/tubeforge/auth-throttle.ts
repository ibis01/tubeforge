// S46 — durable login throttling (roadmap P1-6): the credential-failure
// lockout that used to live in a process-local Map (tenant.ts) and a dead
// duplicate nobody imported (auth.ts). Both are gone; this module is the
// one law, and its state lives in the AuthAttempt TABLE so it survives
// restarts and deploys, and is shared by every web/worker instance (the
// Fly topology of DEPLOYMENT.md is multi-process — an in-process Map gave
// each instance its own idea of "too many attempts", and a deploy wiped
// the lot).
//
// THE LAW (unchanged from the in-memory era, minus its blind spot):
//   a key (the caller's IP) is locked while ≥ LOGIN_MAX_FAILURES failed
//   credential proofs sit inside a rolling LOGIN_WINDOW_MS window. The
//   unlock instant is the oldest in-window failure + the window — an
//   attacker gets at most 5 attempts per rolling 10 minutes, forever.
//   The old fixed-window COUNTER could be straddled: 4 failures at
//   T−9:59 + 4 more at T+0:01 = 8 failures in 2 minutes without ever
//   tripping it, because each burst sat in its own window. One row per
//   failure closes that hole (and makes concurrent failures impossible
//   to lose — the counter's read-modify-write could).
//
// SURFACES: POST /api/auth/login (wrong password) and
// POST /api/auth/change-password (wrong CURRENT password — a login
// attempt wearing a different coat). A success clears the key's whole
// window, exactly as before.
//
// FAILURE POSTURE — fail OPEN, loudly. The throttle is a brute-force
// damper, not an authentication control: allowing an ATTEMPT never
// authenticates anyone (the password proof stays the gate, and if the DB
// is truly down that proof cannot succeed either). A throttle-table error
// (e.g. a deploy that skipped the S46 migration on one instance)
// therefore degrades to "no lockout" with a once-per-process stderr
// announcement — the spendOverrides() observability pattern — instead of
// turning every sign-in into a 500. Silent fail-open is the one outcome
// this design refuses.
//
// NOT STATEFUL, DELIBERATELY: the middleware's per-IP read/write buckets
// (rate-limit.ts) stay in-memory — middleware is architecture-banned from
// the DB (see src/middleware.ts), and its 600/90-per-minute tiers are
// coarse shedding, not security state. The durable tier is exactly the
// credential surfaces above, where an attacker needs thousands of tries
// and every try must count.

import { rawDatabase as rawDb } from "./tenant-db";
import { log } from "./log";

// S57/T-57.2 — the module's logger (the old [TubeForge] auth-throttle
// prefix became a binding).
const throttleLog = log.child({ mod: "auth-throttle" });

/** Rolling window a failure counts inside (10 minutes, the S16-era law). */
export const LOGIN_WINDOW_MS = 10 * 60 * 1000;
/** Failures inside the window that trip the lock. */
export const LOGIN_MAX_FAILURES = 5;

export interface LoginWindowDecision {
  allowed: boolean;
  retryAfterSec: number;
}

/**
 * PURE — the sliding-window law, clock-injectable. `hits` are the key's
 * recorded failure instants (ms, any order, any age — stale hits are
 * ignored by the cutoff, not pre-filtered). ≥5 in-window hits block until
 * the OLDEST of them ages out; fewer allow. This is the single decision
 * point for every caller (the DB shell feeds it straight), so the window
 * math can never disagree with itself between routes.
 */
export function loginWindowDecision(hits: number[], now: number): LoginWindowDecision {
  const cutoff = now - LOGIN_WINDOW_MS;
  const inWindow = hits.filter((t) => t > cutoff).sort((a, b) => a - b);
  const oldest = inWindow[0];
  if (oldest === undefined || inWindow.length < LOGIN_MAX_FAILURES)
    return { allowed: true, retryAfterSec: 0 };
  const retryAfterSec = Math.max(
    1,
    Math.ceil((oldest + LOGIN_WINDOW_MS - now) / 1000)
  );
  return { allowed: false, retryAfterSec };
}

// Once-per-process announcements (fail-open must be loud, not spammy —
// the same broken table announcing on every request helps nobody).
const g = globalThis as typeof globalThis & {
  __tfThrottleWarnedCheck?: boolean;
  __tfThrottleWarnedRecord?: boolean;
};

/**
 * May this key attempt a credential proof right now? Reads the failure
 * rows inside the window and applies `loginWindowDecision`. DB errors
 * fail OPEN (see the failure posture above) — never a silent open.
 */
export async function checkLoginAllowed(
  key: string,
  now: number = Date.now()
): Promise<LoginWindowDecision> {
  let rows: { at: Date }[];
  try {
    rows = await rawDb.authAttempt.findMany({
      where: { key, at: { gt: new Date(now - LOGIN_WINDOW_MS) } },
      orderBy: { at: "asc" },
      select: { at: true },
    });
  } catch (err) {
    if (!g.__tfThrottleWarnedCheck) {
      g.__tfThrottleWarnedCheck = true;
      throttleLog.error(
        "AuthAttempt read failed — login lockout is OFF until this is fixed (apply the S46 migration).",
        { err }
      );
    }
    return { allowed: true, retryAfterSec: 0 };
  }
  return loginWindowDecision(rows.map((r) => r.at.getTime()), now);
}

/**
 * Record one failed credential proof, then opportunistically prune rows
 * too old to ever affect a decision again. Recording errors are swallowed
 * (a lost row degrades the lockout by one attempt; the proof itself
 * still failed) but announced once per process.
 */
export async function recordLoginFailure(
  key: string,
  now: number = Date.now()
): Promise<void> {
  try {
    await rawDb.authAttempt.create({ data: { key, at: new Date(now) } });
  } catch (err) {
    if (!g.__tfThrottleWarnedRecord) {
      g.__tfThrottleWarnedRecord = true;
      throttleLog.error(
        "AuthAttempt write failed — failures are NOT being counted (apply the S46 migration).",
        { err }
      );
    }
    return;
  }
  // Rows at/before the cutoff cannot change any future decision (the
  // window filter already excludes them) — safe to drop, keeps the table
  // the size of the active attack surface, not the attack history.
  await rawDb.authAttempt
    .deleteMany({ where: { at: { lt: new Date(now - LOGIN_WINDOW_MS) } } })
    .catch(() => {});
}

/** A successful proof clears the key's whole failure history. */
export async function recordLoginSuccess(key: string): Promise<void> {
  await rawDb.authAttempt.deleteMany({ where: { key } }).catch(() => {});
}
