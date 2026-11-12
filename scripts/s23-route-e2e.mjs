// S23 route e2e — "the account surface" against the running daemon. The
// full arc a real account walks:
//   register -> anon doors 401 -> a bearer may read usage but never the
//   export bundle nor arm the wipe (403/403, the account-management law)
//   -> a signed-in session reads its (empty) aggregates and pulls the
//   export bundle -> a lowercase confirm is refused, the account lives ->
//   the real DELETE lands, the session cookie dies, the account is gone
//   -> cleanup (zero users, zero orgs).
// Run after a daemon restart: node scripts/s23-route-e2e.mjs

import { PrismaClient } from "@prisma/client";
// S28 — baseline-relative end state, captured BEFORE the suite creates
// anything (the owner's real account lives in this DB now).
const BASELINE = {
  users: await new PrismaClient().user.count(),
  orgs: await new PrismaClient().organization.count(),
};

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
const tag = `s23-${Date.now()}`;
const email = `${tag}@e2e.local`;
const reg = await fetch(`${BASE}/api/auth/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "Account Probe", email, password: "account-pass-1" }),
});
feed(reg);
check("1.1  register -> 201", reg.status === 201, reg.status);

// ---- 2. anonymous doors are shut ----
const anonUsage = await fetch(`${BASE}/api/account/usage`);
const anonExport = await fetch(`${BASE}/api/account/export`);
const anonDelete = await fetch(`${BASE}/api/account/delete`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ confirm: "DELETE" }),
});
check("2.1  an anonymous usage GET -> 401", anonUsage.status === 401, anonUsage.status);
check("2.2  an anonymous export GET -> 401", anonExport.status === 401, anonExport.status);
check("2.3  an anonymous delete POST -> 401", anonDelete.status === 401, anonDelete.status);

// ---- 3. the bearer law ----
const mint = await fetch(`${BASE}/api/auth/token`, {
  method: "POST",
  headers: H({ "content-type": "application/json" }),
  body: JSON.stringify({ name: "s23 bearer" }),
});
const mintBody = await json(mint);
check("3.1  a bearer mints -> 201", mint.status === 201, mint.status);
const BH = { authorization: `Bearer ${mintBody.token}` };

const bearerUsage = await fetch(`${BASE}/api/account/usage`, { headers: BH });
check("3.2  a bearer usage GET -> 200 (ordinary telemetry)", bearerUsage.status === 200, bearerUsage.status);
const bearerExport = await fetch(`${BASE}/api/account/export`, { headers: BH });
check("3.3  a bearer export GET -> 403 (the bundle is browser-only)", bearerExport.status === 403, bearerExport.status);
const bearerDelete = await fetch(`${BASE}/api/account/delete`, {
  method: "POST",
  headers: { ...BH, "content-type": "application/json" },
  body: JSON.stringify({ confirm: "DELETE" }),
});
check("3.4  a bearer delete POST -> 403 (a leaked key never wipes a studio)", bearerDelete.status === 403, bearerDelete.status);

// ---- 4. the signed-in reads ----
const usage = await fetch(`${BASE}/api/account/usage?days=7`, { headers: H() });
check("4.1  a signed-in usage GET -> 200", usage.status === 200, usage.status);
const usageBody = await json(usage);
check("4.2  the window honors ?days=7", usageBody.window?.days === 7, usageBody.window?.days);
check("4.3  a fresh account's totals are zero", usageBody.totals?.calls === 0, usageBody.totals);
check("4.4  the storage block answers", typeof usageBody.storage?.usedBytes === "number", usageBody.storage);

const exp = await fetch(`${BASE}/api/account/export`, { headers: H() });
check("4.5  a signed-in export GET -> 200", exp.status === 200, exp.status);
check("4.6  the bundle downloads as tubeforge-export.json",
  (exp.headers.get("content-disposition") ?? "").includes("tubeforge-export.json"));
const expBody = await json(exp);
check("4.7  the bundle names the account", expBody.account?.email === email, expBody.account?.email);

// ---- 5. the delete arc ----
const wrong = await fetch(`${BASE}/api/account/delete`, {
  method: "POST",
  headers: H({ "content-type": "application/json" }),
  body: JSON.stringify({ confirm: "delete" }),
});
check("5.1  a lowercase confirm -> 400", wrong.status === 400, wrong.status);
const status1 = await json(await fetch(`${BASE}/api/auth/status`, { headers: H() }));
check("5.2  the account survived", status1.authenticated === true, status1.authenticated);

const real = await fetch(`${BASE}/api/account/delete`, {
  method: "POST",
  headers: H({ "content-type": "application/json" }),
  body: JSON.stringify({ confirm: "DELETE" }),
});
check("5.3  the real confirm -> 200", real.status === 200, real.status);
feed(real);
const status2 = await json(await fetch(`${BASE}/api/auth/status`, { headers: H() }));
check("5.4  the session died with the account", status2.authenticated === false, status2);

// ---- 6. cleanup — the register-mode end state survives ----
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
const [leftUsers, leftOrgs] = [await db.user.count(), await db.organization.count()];
check("6.1  cleanup — nothing behind (users/orgs back to baseline)",
  leftUsers === BASELINE.users && leftOrgs === BASELINE.orgs,
  { leftUsers, leftOrgs, BASELINE });
await db.$disconnect();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
