// S27 route e2e — "the $5 door" against the running daemon. The gate is a
// GLOBAL, cross-request law, so the proof is a real account hammering the
// real settings test route until the door slams:
//   register -> a paid-provider connection test dispatches and fails on the
//   wire (a dead public endpoint — each failed dispatch settles at its
//   worst-case estimate, the conservative law) -> repeated tests walk the
//   recorded total up the stop line -> the SAME route flips from "connection
//   failed" to the spend-budget refusal — the gate blocked a dispatch that
//   would cross $4.50 -> the zai gateway path stays open (ungated; metered,
//   never priced) -> the account leaves through the account front door ->
//   end state pristine (0 users, 0 orgs, 0 usage rows, 0 reservations).
//
// S32 — the gate now persists reservations (SpendReservation table), so the
// hammering survives a daemon restart. The daemon MUST run with
// TUBEFORGE_PRICING_VERIFIED=1 for this suite (the pricing-unverified block
// is exercised separately by s32-route-e2e). Restart the daemon with that
// env before running.
// The route-level dispatches carry NO UsageRecord rows (the settings test
// calls chatComplete directly, outside aiCall), but S32's SpendReservation
// rows ARE written — the gate's durability no longer depends on UsageRecord.
// Run after a daemon restart with TUBEFORGE_PRICING_VERIFIED=1:
//   node scripts/s27-route-e2e.mjs

import { PrismaClient } from "@prisma/client";
// S28 — baseline-relative end state, captured BEFORE the suite creates
// anything (the owner's real account lives in this DB now).
const BASELINE = {
  users: await new PrismaClient().user.count(),
  orgs: await new PrismaClient().organization.count({ where: { memberships: { none: {} } } }),
  usageRows: await new PrismaClient().usageRecord.count(),
  reservations: await new PrismaClient().spendReservation.count(),
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

const prisma = new PrismaClient();

// ---- 1. register through the real route ----
const tag = `s27-${Date.now()}`;
const email = `${tag}@e2e.local`;
const reg = await fetch(`${BASE}/api/auth/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "Spend Probe", email, password: "spend-pass-1" }),
});
feed(reg);
check("1.1  register -> 201", reg.status === 201, reg.status);

// ---- 2. the gate dispatches and fails on the wire (dead endpoint) ----
// http://example.com:9 — a real, resolvable PUBLIC host on a refused port:
// safeFetch/providerFetch pass the SSRF guard, the TCP RST lands in
// milliseconds, and the conservative law settles the full estimate.
const testOpenai = () =>
  fetch(`${BASE}/api/settings/ai`, {
    method: "POST",
    headers: H({ "content-type": "application/json" }),
    body: JSON.stringify({
      capability: "chat",
      provider: "openai",
      model: "gpt-6-astra", // the fallback-priced flagship: ~$0.41/dispatch
      baseUrl: "http://example.com:9",
      apiKey: "sk-e2e-not-real",
    }),
  });

const first = await testOpenai();
const firstBody = await json(first);
check("2.1  the connection test route answers", first.status === 200, first.status);
check("2.2  a dead-endpoint dispatch reports the wire failure (not the gate)",
  firstBody.ok === false && !/spend budget/i.test(firstBody.error ?? ""), firstBody.error);

// ---- 3. hammer until the door slams ----
// Each dispatch settles ~$0.41 (8192 astra outputs priced in full); the
// $4.50 stop line means ~11 dispatches, asserted bounded by 25.
let blocked = null;
let attempts = 1;
const MAX_ATTEMPTS = 25;
while (attempts < MAX_ATTEMPTS) {
  attempts += 1;
  const res = await testOpenai();
  const body = await json(res);
  if (/spend budget/i.test(body.error ?? "")) {
    blocked = body;
    break;
  }
}
check("3.1  the gate slams before the 25th dispatch", !!blocked, { attempts });
check("3.2  the refusal names the budget law",
  /spend budget/i.test(blocked?.error ?? "") && /\$4\.50/.test(blocked?.error ?? ""), blocked?.error);
check("3.3  the refusal is the route's 200-ok:false shape (the wire error shape, not a 5xx)",
  blocked && blocked.ok === false, blocked);

// after the block, the NEXT dispatch is still refused (state is global)
const again = await testOpenai();
const againBody = await json(again);
check("3.4  the gate stays shut on the next attempt",
  againBody.ok === false && /spend budget/i.test(againBody.error ?? ""), againBody.error);

// ---- 4. the zai gateway path stays open (ungated; metered, never priced) ----
const zaiTest = await fetch(`${BASE}/api/settings/ai`, {
  method: "POST",
  headers: H({ "content-type": "application/json" }),
  body: JSON.stringify({ capability: "chat", provider: "zai" }),
});
const zaiBody = await json(zaiTest);
check("4.1  the ungated gateway test still dispatches (ok:true, a real reply)",
  zaiBody.ok === true && typeof zaiBody.reply === "string" && zaiBody.reply.length > 0,
  { status: zaiTest.status, reply: zaiBody.reply?.slice(0, 40) });

// ---- 5. end state: the account leaves through the front door ----
const wipe = await fetch(`${BASE}/api/account/delete`, {
  method: "POST",
  headers: H({ "content-type": "application/json" }),
  body: JSON.stringify({ confirm: "DELETE" }),
});
feed(wipe);
check("5.1  account delete -> 200", wipe.status === 200, wipe.status);

await new Promise((r) => setTimeout(r, 500));
const users = await prisma.user.count();
const orgs = await prisma.organization.count({ where: { memberships: { none: {} } } });
const usageRows = await prisma.usageRecord.count();
const reservations = await prisma.spendReservation.count();
check("5.2  end state: nothing behind (users/orphan-orgs/usage/reservations back to baseline)",
  users === BASELINE.users && orgs === BASELINE.orgs && usageRows === BASELINE.usageRows && reservations === BASELINE.reservations,
  { users, orgs, usageRows, reservations, BASELINE });

console.log(`\n${fail === 0 ? "ALL CHECKS PASS" : `${fail} FAILURE(S)`} (${pass} passed)`);
await prisma.$disconnect();
process.exit(fail === 0 ? 0 : 1);
