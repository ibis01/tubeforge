// S16 unit probe — "the account": the rotation contract through REAL modules.
// The security card promised "you can change it later from here" since the
// lock shipped; the surface never existed. Layers:
//   1. PURE — the sid law (sessionIdFromRequest): a browser session token
//      yields its Session row id (the row the route rotates FROM), while API
//      bearers, state markers, garbage and no-token callers are all null —
//      the route 403s everyone but a real session, so a leaked 90-day script
//      token can never rotate the password.
//   2. DB — the limiter law (S46): the lockout now lives in the AuthAttempt
//      table (roadmap P1-6) — durable across restarts/deploys, shared across
//      instances, and a TRUE sliding window (the old fixed-window counter
//      could be straddled). Proven here against the real SQLite through the
//      live shell; the pure window math is pinned by the unit suite.
//   3. PURE — the hash law: PBKDF2 round-trip, wrong-password rejection,
//      malformed-hash rejection (verifyPassword is the proof the route runs).
//   4. ROUTE — the real POST handler against the real SQLite: a throwaway
//      user + org + two live sessions (the acting browser + another device).
//      Wrong current → 401; short new → 400; same-as-current → 400; the
//      happy rotation → 200 with EVERY session revoked (both devices), a
//      FRESH cookie that resolves live, the old cookie dead, the new hash
//      verifying, and outstanding reset tokens voided.
// Run: node --import tsx scripts/s16-unit-probe.mts

// The secret must exist before any token is signed (getAuthSecret reads env
// per call — no cache — but set it first anyway so the layer reads cleanly).
process.env.TUBEFORGE_AUTH_SECRET ??= "probe-secret-0123456789abcdef";

import { NextRequest } from "next/server";
import { PrismaClient } from "@prisma/client";
import {
  createSignedToken,
  SESSION_COOKIE,
} from "../src/lib/tubeforge/auth-token";
import {
  MIN_PASSWORD_LEN,
  createApiToken,
  hashPassword,
  resolveRequestUser,
  sessionIdFromRequest,
  createSessionToken,
  verifyPassword,
} from "../src/lib/tubeforge/tenant";
import {
  checkLoginAllowed,
  recordLoginFailure,
  recordLoginSuccess,
} from "../src/lib/tubeforge/auth-throttle";
import { POST as changePassword } from "../src/app/api/auth/change-password/route";

const prisma = new PrismaClient();
let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

const URL_ = "http://probe.local/api/auth/change-password";
const reqWith = (opts: RequestInit) => new NextRequest(URL_, { method: "POST", ...opts });

// =====================================================================
// 1. the sid law — who may rotate (sessionIdFromRequest)
// =====================================================================
{
  const uid = "probe-user-s16";
  const sid = "probe-sid-0123456789";
  const sessionToken = await createSessionToken(uid, sid);
  // S20: createApiToken now persists a registry row (real users only), but
  // the SID law never touches the DB — sign the api-scope token directly so
  // this layer stays pure.
  const apiToken = await createSignedToken("api", 3600, process.env.TUBEFORGE_AUTH_SECRET!, { uid });
  const stateToken = await createSignedToken("state", 60, process.env.TUBEFORGE_AUTH_SECRET!, { uid });

  check("1.1  a browser session token yields its sid", sessionToken !== null && (await sessionIdFromRequest(
    reqWith({ headers: { cookie: `${SESSION_COOKIE}=${sessionToken}` } })
  )) === sid);

  check("1.2  an API bearer token is null (scripts may not rotate)",
    (await sessionIdFromRequest(reqWith({ headers: { authorization: `Bearer ${apiToken}` } }))) === null);

  check("1.3  an OAuth state marker is null (not a credential)",
    (await sessionIdFromRequest(reqWith({ headers: { cookie: `${SESSION_COOKIE}=${stateToken}` } }))) === null);

  check("1.4  garbage in the cookie is null",
    (await sessionIdFromRequest(reqWith({ headers: { cookie: `${SESSION_COOKIE}=not-a-token` } }))) === null);

  check("1.5  no token at all is null",
    (await sessionIdFromRequest(reqWith({ headers: {} }))) === null);
}

// =====================================================================
// 2. the limiter law — DB-backed since S46 (roadmap P1-6). The window
//    lives in the AuthAttempt table: it survives restarts and deploys
//    (the process-local Map wiped on every one), and every web/worker
//    instance counts the same failures. The pure math is pinned by the
//    unit suite; this layer proves the REAL shell against the real DB.
// =====================================================================
{
  const ip = "10.46.0.46"; // probe-synthetic, unique to this layer
  await recordLoginSuccess(ip); // start clean (clearing an empty key is a no-op)

  check("2.1  a fresh key is allowed", (await checkLoginAllowed(ip)).allowed === true);

  for (let i = 1; i <= 4; i++) await recordLoginFailure(ip);
  check("2.2  four failures still allowed (the lock arms on the 5th)", (await checkLoginAllowed(ip)).allowed === true);

  // DURABILITY — the S46 point: the failures are visible through a
  // DIFFERENT PrismaClient than the module's singleton, i.e. the state
  // is in the DATABASE. A second process — or this one restarted — reads
  // the same window instead of starting from zero.
  const rows = await prisma.authAttempt.count({ where: { key: ip } });
  check("2.3  the four failures are AuthAttempt ROWS (state a restart keeps)", rows === 4, rows);

  await recordLoginFailure(ip); // the 5th — arms the lock
  const afterLock = await checkLoginAllowed(ip);
  check("2.4  the 5th failure locks the key for ~10 minutes",
    afterLock.allowed === false && afterLock.retryAfterSec > 9 * 60 && afterLock.retryAfterSec <= 600,
    afterLock);

  // PRUNE — rows older than the window can never affect a decision
  // again; the next failure anywhere sweeps them. An 11-minute-old row
  // for another key must vanish while the fresh row (and the locked
  // key's window) survives.
  await prisma.authAttempt.create({
    data: { key: `${ip}-ancient`, at: new Date(Date.now() - 11 * 60_000) },
  });
  await recordLoginFailure(`${ip}-ancient`); // a fresh failure triggers the opportunistic prune
  const survivors = await prisma.authAttempt.count({ where: { key: `${ip}-ancient` } });
  check("2.5  the opportunistic prune drops out-of-window rows (1 fresh survivor)", survivors === 1, survivors);
  check("2.6  another key's prune leaves the locked window untouched",
    (await checkLoginAllowed(ip)).allowed === false);

  await recordLoginSuccess(ip);
  check("2.7  a success clears the window", (await checkLoginAllowed(ip)).allowed === true);

  // layer residue — never leak probe rows into the dev DB
  await prisma.authAttempt.deleteMany({ where: { key: { in: [ip, `${ip}-ancient`] } } });
}

// =====================================================================
// 3. the hash law — the proof itself
// =====================================================================
{
  check("3.1  MIN_PASSWORD_LEN is 8 (the route's floor)", MIN_PASSWORD_LEN === 8);

  const stored = await hashPassword("probe-old-password");
  check("3.2  round-trip: the right password verifies", await verifyPassword("probe-old-password", stored));
  check("3.3  the wrong password is rejected", !(await verifyPassword("probe-wrong", stored)));
  check("3.4  a malformed stored hash is rejected, not thrown", !(await verifyPassword("x", "not-a-hash")));
  check("3.5  each hash gets a fresh salt (no deterministic rows)",
    (await hashPassword("same-input")) !== (await hashPassword("same-input")));
}

// =====================================================================
// 4. the route law — the real POST handler, the real SQLite
// =====================================================================
{
  // A throwaway identity: user + org + membership + two live sessions
  // (the acting browser, and a second device that must die on rotation).
  const org = await prisma.organization.create({ data: { name: "S16 Probe Org", slug: `s16-probe-${Date.now()}` } });
  const email = `s16-probe-${Date.now()}@probe.local`;
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: await hashPassword("probe-current-pw"),
      memberships: { create: { organizationId: org.id, role: "owner" } },
    },
  });

  const { createSessionRecord } = await import("../src/lib/tubeforge/tenant");
  const sessionA = await createSessionRecord({ userId: user.id, organizationId: org.id, userAgent: "probe-A" });
  const sessionB = await createSessionRecord({ userId: user.id, organizationId: org.id, userAgent: "probe-B" });
  const tokenA = await createSessionToken(user.id, sessionA.id);
  const cookieA = `${SESSION_COOKIE}=${tokenA}`;
  // An outstanding reset link — the rotation must void it (the owner just
  // proved the current password; stale links are dead links).
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordResetTokenHash: "stale-hash", passwordResetExpiresAt: new Date(Date.now() + 3600_000) },
  });

  const ipHeader = { "x-forwarded-for": "10.16.1.16", cookie: cookieA };
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    changePassword(reqWith({ headers: { "content-type": "application/json", ...ipHeader, ...headers }, body: JSON.stringify(body) }));

  // 4.1 wrong current password → 401 (the proof failed)
  const wrongCurrent = await post({ currentPassword: "not-the-pw", newPassword: "probe-new-pw-1" });
  check("4.1  a wrong current password → 401", wrongCurrent.status === 401, wrongCurrent.status);

  // 4.2 short new password → 400, message names the floor
  const shortNew = await post({ currentPassword: "probe-current-pw", newPassword: "short" });
  const shortBody = await shortNew.json().catch(() => ({}));
  check("4.2  a short new password → 400 naming the 8-char floor",
    shortNew.status === 400 && /8 characters/.test(shortBody.error ?? ""), { status: shortNew.status, body: shortBody });

  // 4.3 same-as-current → 400 (a change that changes nothing)
  const sameNew = await post({ currentPassword: "probe-current-pw", newPassword: "probe-current-pw" });
  check("4.3  new === current → 400", sameNew.status === 400, sameNew.status);

  // 4.4 not signed in → 401
  const anon = await changePassword(reqWith({
    headers: { "content-type": "application/json", "x-forwarded-for": "10.16.1.16" },
    body: JSON.stringify({ currentPassword: "probe-current-pw", newPassword: "probe-new-pw-1" }),
  }));
  check("4.4  a caller with no session → 401", anon.status === 401, anon.status);

  // 4.5 API bearer caller → 403 (a leaked script token may not rotate)
  const apiToken = await createApiToken(user.id);
  const bearer = await changePassword(reqWith({
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "10.16.1.16",
      authorization: `Bearer ${apiToken}`,
    },
    body: JSON.stringify({ currentPassword: "probe-current-pw", newPassword: "probe-new-pw-1" }),
  }));
  check("4.5  an API bearer caller → 403", bearer.status === 403, bearer.status);

  // 4.6 the happy rotation → 200, every session revoked, a fresh cookie
  const ok = await post({ currentPassword: "probe-current-pw", newPassword: "probe-new-pw-1" });
  const okBody = await ok.json().catch(() => ({}));
  check("4.6  the rotation succeeds → 200", ok.status === 200, { status: ok.status, body: okBody });
  check("4.7  both live sessions were revoked (count = 2)",
    okBody.revokedSessions === 2, okBody.revokedSessions);

  const freshCookie = ok.cookies.get(SESSION_COOKIE)?.value;
  check("4.8  the response sets a FRESH session cookie", Boolean(freshCookie));

  const rowA = await prisma.session.findUnique({ where: { id: sessionA.id } });
  const rowB = await prisma.session.findUnique({ where: { id: sessionB.id } });
  check("4.9  the acting session row is revoked (rotated, not kept)", Boolean(rowA?.revokedAt));
  check("4.10 the other device's session row is revoked", Boolean(rowB?.revokedAt));

  const freshCtx = await resolveRequestUser(reqWith({ headers: { cookie: `${SESSION_COOKIE}=${freshCookie}` } }));
  check("4.11 the fresh cookie resolves LIVE (the acting browser never blinks)", Boolean(freshCtx?.userId === user.id));

  const oldCtx = await resolveRequestUser(reqWith({ headers: { cookie: cookieA } }));
  check("4.12 the pre-rotation cookie is DEAD", oldCtx === null);

  const afterRow = await prisma.user.findUnique({ where: { id: user.id } });
  check("4.13 the new password verifies against the stored hash",
    afterRow ? await verifyPassword("probe-new-pw-1", afterRow.passwordHash) : false);
  check("4.14 the outstanding reset link is voided",
    afterRow?.passwordResetTokenHash === null && afterRow?.passwordResetExpiresAt === null);

  // 4.15 the limiter window cleared (the success proof resets the IP) — a
  // second rotation from the same IP is not locked out.
  const again = await changePassword(reqWith({
    headers: { "content-type": "application/json", "x-forwarded-for": "10.16.1.16", cookie: `${SESSION_COOKIE}=${freshCookie}` },
    body: JSON.stringify({ currentPassword: "probe-new-pw-1", newPassword: "probe-new-pw-2" }),
  }));
  check("4.15 a follow-up rotation succeeds (window cleared by the prior success)", again.status === 200, again.status);

  // cleanup the throwaway identity (sessions cascade from user; org removed by hand)
  await prisma.user.delete({ where: { id: user.id } });
  await prisma.organization.delete({ where: { id: org.id } });
  const leftover = await prisma.session.count({ where: { userId: user.id } });
  check("4.16 cleanup — no probe sessions linger", leftover === 0, leftover);
  // the route law burned AuthAttempt rows for the probe IP (4.1's wrong
  // current password, cleared by 4.6's success) — clear them regardless of
  // how far the layer got, so no probe residue throttles a synthetic IP.
  await prisma.authAttempt.deleteMany({ where: { key: "10.16.1.16" } });
  check("4.17 cleanup — no probe throttle rows linger",
    (await prisma.authAttempt.count({ where: { key: "10.16.1.16" } })) === 0);
}

await prisma.$disconnect();
console.log(failures === 0 ? "\nS16 unit probe: ALL PASS" : `\nS16 unit probe: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
