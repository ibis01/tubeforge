// S21 route e2e — "the confirmed address" against the running daemon. The
// full arc a real account walks:
//   register (the API alone does NOT verify — the gate's console auto-verify
//   is a client behavior) -> status says unverified -> a bearer may not
//   resend (403, the account-management law) -> a signed-in resend returns
//   the link (console mode) -> the link's GET is a 307 LANDING to
//   /?verified=ok -> status flips verified -> the spent link replays as
//   expired -> further resends answer 400 -> cleanup (zero users).
// Run after a daemon restart: node scripts/s21-route-e2e.mjs

import { PrismaClient } from "@prisma/client";
// S28 — baseline-relative end state, captured BEFORE the suite creates
// anything (the owner's real account lives in this DB now).
const BASELINE_USERS = await new PrismaClient().user.count();

const BASE = "http://localhost:3000";
const jar = [];
const feed = (res) => {
  for (const c of res.headers.getSetCookie?.() ?? []) jar.push(c.split(";")[0]);
};
const H = (extra = {}) => ({
  ...(jar.length ? { cookie: jar.join("; ") } : {}),
  ...extra,
});

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (ok) pass++; else fail++;
};
const json = async (res) => res.json().catch(() => ({}));

// ---- 1. register through the real route ----
const tag = `s21-${Date.now()}`;
const email = `${tag}@e2e.local`;
const reg = await fetch(`${BASE}/api/auth/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "Confirm Probe", email, password: "confirm-pass-1" }),
});
feed(reg);
check("1.1  register -> 201", reg.status === 201, reg.status);
const regBody = await json(reg);
check("1.2  the register response carries the console link", typeof regBody.verification?.url === "string");

const status1 = await json(await fetch(`${BASE}/api/auth/status`, { headers: H() }));
check("1.3  the fresh account is UNVERIFIED (the API verifies nobody)",
  status1.user?.emailVerified === false, status1.user?.emailVerified);

// ---- 2. a bearer may not resend (S20 mint -> S21 resend) ----
const mint = await fetch(`${BASE}/api/auth/token`, {
  method: "POST",
  headers: H({ "content-type": "application/json" }),
  body: JSON.stringify({ name: "s21 bearer" }),
});
const mintBody = await json(mint);
check("2.1  a bearer mints (S20 keyring) -> 201", mint.status === 201, mint.status);
const bearerResend = await fetch(`${BASE}/api/auth/verify-email`, {
  method: "POST",
  headers: { authorization: `Bearer ${mintBody.token}` },
});
check("2.2  the bearer's resend -> 403", bearerResend.status === 403, bearerResend.status);

// ---- 3. the signed-in resend returns the link ----
const resend = await fetch(`${BASE}/api/auth/verify-email`, { method: "POST", headers: H() });
const resendBody = await json(resend);
check("3.1  a signed-in resend -> 200", resend.status === 200, resend.status);
const freshUrl = resendBody.verification?.url;
check("3.2  console mode returns the fresh link", typeof freshUrl === "string");

// the register-time link is now VOID (one live token at a time)
const oldLanding = await fetch(`${BASE}${regBody.verification.url}`, { redirect: "manual" });
check("3.3  the register-time link is voided by the fresh mint -> expired",
  oldLanding.status === 307 && oldLanding.headers.get("location")?.includes("verified=expired"),
  oldLanding.headers.get("location"));

// ---- 4. the landing: a 307 for humans, consumable by the gate ----
const landing = await fetch(`${BASE}${freshUrl}`, { redirect: "manual" });
check("4.1  the fresh link's GET -> 307", landing.status === 307, landing.status);
check("4.2  the landing is /?verified=ok",
  landing.headers.get("location")?.includes("verified=ok"), landing.headers.get("location"));

const status2 = await json(await fetch(`${BASE}/api/auth/status`, { headers: H() }));
check("4.3  the account is VERIFIED now", status2.user?.emailVerified === true, status2.user?.emailVerified);

const replay = await fetch(`${BASE}${freshUrl}`, { redirect: "manual" });
check("4.4  the spent link replays -> expired landing",
  replay.status === 307 && replay.headers.get("location")?.includes("verified=expired"));

// ---- 5. a verified account needs no resend ----
const again = await fetch(`${BASE}/api/auth/verify-email`, { method: "POST", headers: H() });
check("5.1  a resend for a verified account -> 400", again.status === 400, again.status);

// ---- 6. anonymous callers ----
const anon = await fetch(`${BASE}/api/auth/verify-email`, { method: "POST" });
check("6.1  an anonymous resend -> 401", anon.status === 401, anon.status);

// ---- 7. cleanup — the register-mode end state survives ----
const db = new PrismaClient();
const u = await db.user.findUnique({
  where: { email },
  include: { memberships: { select: { organizationId: true } } },
});
if (u) {
  const orgIds = u.memberships.map((m) => m.organizationId);
  await db.session.deleteMany({ where: { userId: u.id } });
  await db.apiToken.deleteMany({ where: { userId: u.id } });
  await db.membership.deleteMany({ where: { userId: u.id } });
  await db.user.delete({ where: { id: u.id } });
  for (const orgId of orgIds) await db.organization.deleteMany({ where: { id: orgId } });
}
const leftover = await db.user.count();
check("7.1  cleanup — nothing behind (user count back to the baseline)", leftover === BASELINE_USERS, { leftover, BASELINE_USERS });
await db.$disconnect();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
