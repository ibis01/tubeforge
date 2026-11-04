// S19 — the quiet door. readLegacyRows() now asks sqlite_master whether the
// LegacySetting table exists before selecting from it, so a fresh install
// (table absent by design since T-3.11) no longer makes Prisma log the
// EXPECTED "no such table" as a prisma:error on every auth-status poll.
//
// This probe pins it live, against the running daemon:
//   1. count the "no such table: LegacySetting" screams in the daemon log
//   2. hammer every readLegacyRows caller: status x3, register (first user —
//      runs claimLegacyForOwner with no table), logout, login, status
//   3. the count must be UNCHANGED (zero new screams)
//   4. the auth cycle stays green and legacyClaim.required stays false —
//      the fix must silence the log, not change the answers.
// Run: node scripts/s19-quiet-door.mjs
import fs from "node:fs";

const LOG = "/tmp/tf-server.log";
const BASE = "http://localhost:3000";

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}`);
  }
}

const screams = () =>
  (fs.readFileSync(LOG, "utf8").match(/no such table: LegacySetting/g) || []).length;

const before = screams();
console.log(`baseline LegacySetting screams in log: ${before}`);

// ---- 1. status x3 — the poll that used to scream on every page load ----
for (let i = 1; i <= 3; i++) {
  const r = await fetch(`${BASE}/api/auth/status`);
  const d = await r.json();
  ok(r.status === 200, `status #${i} -> 200`);
  ok(d.configured === false, `status #${i} configured === false (fresh door)`);
  ok(d.legacyClaim?.required === false, `status #${i} legacyClaim.required === false`);
}

// ---- 2. register the FIRST user (claimLegacyForOwner runs, table absent) ----
const email = `s19-quiet-${Date.now()}@e2e.local`;
const reg = await fetch(`${BASE}/api/auth/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "Quiet Door", email, password: "quietdoor2026" }),
});
ok(reg.status === 201, `register first user -> 201 (got ${reg.status})`);
const cookie = (reg.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
ok(cookie.length > 0, "register sets a session cookie");

// ---- 3. status WITH the session — authenticated ----
const authed = await fetch(`${BASE}/api/auth/status`, { headers: { cookie } });
const ad = await authed.json();
ok(authed.status === 200, "status (signed in) -> 200");
ok(ad.authenticated === true && ad.user?.email === email, "status shows the fresh account");

// ---- 4. logout, then login — the other readLegacyRows-adjacent paths ----
const out = await fetch(`${BASE}/api/auth/logout`, {
  method: "POST",
  headers: { cookie },
});
ok(out.status === 200, "logout -> 200");

const login = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password: "quietdoor2026" }),
});
ok(login.status === 200, `login -> 200 (got ${login.status})`);
const cookie2 = (login.headers.getSetCookie?.() ?? [])
  .map((c) => c.split(";")[0])
  .join("; ");
const reauthed = await fetch(`${BASE}/api/auth/status`, { headers: { cookie: cookie2 } });
ok(reauthed.status === 200, "status after re-login -> 200");

// ---- 5. THE LAW: the log stayed quiet through all of it ----
const after = screams();
ok(after === before, `zero new screams (${before} -> ${after})`);

// ---- 6. cleanup — the end-state law: the battery leaves NOTHING ----
import { PrismaClient } from "@prisma/client";
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
ok(leftover === 0, `cleanup — zero users remain (got ${leftover})`);
await db.$disconnect();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
