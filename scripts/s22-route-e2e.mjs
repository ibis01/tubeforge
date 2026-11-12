// S22 route e2e — "the world gets a door" against the running daemon. The
// full arc a real account walks:
//   register -> create a location + a prop through the real POST routes ->
//   the lists answer them back -> PATCH renames and pauses (paused entries
//   drop from the active list) -> DELETE removes them outright -> a second
//   account sees none of it (tenant law over HTTP) -> a bearer may run the
//   whole studio arc but a stranger's session may not touch it -> cleanup
//   (zero users, zero orgs, zero locations, zero props).
// Run after a daemon restart: node scripts/s22-route-e2e.mjs

import { PrismaClient } from "@prisma/client";
// S28 — baseline-relative end state, captured BEFORE the suite creates
// anything (the owner's real account lives in this DB now).
const BASELINE = {
  users: await new PrismaClient().user.count(),
  orgs: await new PrismaClient().organization.count(),
  locations: await new PrismaClient().location.count(),
  props: await new PrismaClient().prop.count(),
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
const tag = `s22-${Date.now()}`;
const email = `${tag}@e2e.local`;
const reg = await fetch(`${BASE}/api/auth/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "World Probe", email, password: "world-pass-1" }),
});
feed(reg);
check("1.1  register -> 201", reg.status === 201, reg.status);

// ---- 2. anonymous doors are shut ----
const anonGet = await fetch(`${BASE}/api/locations`);
check("2.1  an anonymous GET -> 401", anonGet.status === 401, anonGet.status);
const anonPost = await fetch(`${BASE}/api/props`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "sneaky" }),
});
check("2.2  an anonymous POST -> 401", anonPost.status === 401, anonPost.status);

// ---- 3. the signed-in studio arc ----
const mkLoc = await fetch(`${BASE}/api/locations`, {
  method: "POST",
  headers: H({ "content-type": "application/json" }),
  body: JSON.stringify({ name: "The midnight diner", description: "Neon, rain, the last booth." }),
});
const mkLocBody = await json(mkLoc);
check("3.1  POST /api/locations -> 201", mkLoc.status === 201, mkLoc.status);
const locId = mkLocBody.location?.id;
check("3.2  the response carries the row", typeof locId === "string");

const mkProp = await fetch(`${BASE}/api/props`, {
  method: "POST",
  headers: H({ "content-type": "application/json" }),
  body: JSON.stringify({ name: "The red umbrella" }),
});
check("3.3  POST /api/props -> 201", mkProp.status === 201, mkProp.status);
const propId = (await json(mkProp)).prop?.id;

const list = await json(await fetch(`${BASE}/api/locations`, { headers: H() }));
check("3.4  the location is listed back",
  (list.locations ?? []).some((l) => l.id === locId));
const propList = await json(await fetch(`${BASE}/api/props`, { headers: H() }));
check("3.5  the prop is listed back",
  (propList.props ?? []).some((p) => p.id === propId));

const renamed = await fetch(`${BASE}/api/locations/${locId}`, {
  method: "PATCH",
  headers: H({ "content-type": "application/json" }),
  body: JSON.stringify({ name: "The diner at the end of the street" }),
});
check("3.6  a PATCH renames -> 200", renamed.status === 200, renamed.status);
const renamedBody = await json(renamed);
check("3.7  the rename landed", renamedBody.location?.name === "The diner at the end of the street", renamedBody.location?.name);

const pause = await fetch(`${BASE}/api/locations/${locId}`, {
  method: "PATCH",
  headers: H({ "content-type": "application/json" }),
  body: JSON.stringify({ isActive: false }),
});
check("3.8  pausing -> 200", pause.status === 200, pause.status);
const afterPause = await json(await fetch(`${BASE}/api/locations`, { headers: H() }));
check("3.9  the paused location drops from the active list",
  !(afterPause.locations ?? []).some((l) => l.id === locId));

const del = await fetch(`${BASE}/api/locations/${locId}`, { method: "DELETE", headers: H() });
check("3.10 DELETE -> 200", del.status === 200, del.status);
const delAgain = await fetch(`${BASE}/api/locations/${locId}`, { method: "DELETE", headers: H() });
check("3.11 a second DELETE -> 404 (already gone)", delAgain.status === 404, delAgain.status);

// ---- 4. a bearer runs the studio arc (ordinary APIs are not account mgmt) ----
const mint = await fetch(`${BASE}/api/auth/token`, {
  method: "POST",
  headers: H({ "content-type": "application/json" }),
  body: JSON.stringify({ name: "s22 bearer" }),
});
const mintBody = await json(mint);
check("4.1  a bearer mints -> 201", mint.status === 201, mint.status);
const bearerLoc = await fetch(`${BASE}/api/locations`, {
  method: "POST",
  headers: { authorization: `Bearer ${mintBody.token}`, "content-type": "application/json" },
  body: JSON.stringify({ name: "Bearer's rooftop" }),
});
check("4.2  a bearer creates a location -> 201", bearerLoc.status === 201, bearerLoc.status);
const bearerLocId = (await json(bearerLoc)).location?.id;
const bearerDel = await fetch(`${BASE}/api/locations/${bearerLocId}`, {
  method: "DELETE",
  headers: { authorization: `Bearer ${mintBody.token}` },
});
check("4.3  the bearer deletes its own -> 200", bearerDel.status === 200, bearerDel.status);

// ---- 5. the tenant law over HTTP ----
// A stranger's account: no cookies, no token — but let's also prove a SECOND
// REGISTERED account sees none of org A's world.
const jar2 = [];
const reg2 = await fetch(`${BASE}/api/auth/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "Stranger", email: `${tag}-b@e2e.local`, password: "world-pass-2" }),
});
for (const c of reg2.headers.getSetCookie?.() ?? []) jar2.push(c.split(";")[0]);
const H2 = { cookie: jar2.join("; ") };
const foreignList = await json(await fetch(`${BASE}/api/props`, { headers: H2 }));
check("5.1  the stranger's prop list has none of org A's",
  !(foreignList.props ?? []).some((p) => p.id === propId));
const foreignDel = await fetch(`${BASE}/api/props/${propId}`, { method: "DELETE", headers: H2 });
check("5.2  the stranger's DELETE -> 404", foreignDel.status === 404, foreignDel.status);
const foreignPatch = await fetch(`${BASE}/api/props/${propId}`, {
  method: "PATCH",
  headers: { ...H2, "content-type": "application/json" },
  body: JSON.stringify({ name: "stolen" }),
});
check("5.3  the stranger's PATCH -> 404", foreignPatch.status === 404, foreignPatch.status);

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
const u2 = await db.user.findUnique({
  where: { email: `${tag}-b@e2e.local` },
  include: { memberships: { select: { organizationId: true } } },
});
if (u2) {
  const orgIds = u2.memberships.map((m) => m.organizationId);
  await db.session.deleteMany({ where: { userId: u2.id } });
  await db.apiToken.deleteMany({ where: { userId: u2.id } });
  await db.membership.deleteMany({ where: { userId: u2.id } });
  await db.user.delete({ where: { id: u2.id } });
  for (const orgId of orgIds) await db.organization.deleteMany({ where: { id: orgId } });
}
const [leftUsers, leftOrgs, leftLocs, leftProps] = [
  await db.user.count(),
  await db.organization.count(),
  await db.location.count(),
  await db.prop.count(),
];
check("6.1  cleanup — nothing behind (users/orgs/locations/props back to baseline)",
  leftUsers === BASELINE.users && leftOrgs === BASELINE.orgs &&
  leftLocs === BASELINE.locations && leftProps === BASELINE.props,
  { leftUsers, leftOrgs, leftLocs, leftProps, BASELINE });
await db.$disconnect();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
