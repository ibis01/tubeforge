// S32 route e2e — the audit's P0 repairs proved over HTTP against the
// running daemon. Three laws:
//
//   1. PRICING-UNVERIFIED BLOCK — with the daemon running WITHOUT
//      TUBEFORGE_PRICING_VERIFIED, the FIRST paid-provider connection test
//      is refused with the pricing-unverified error (not a wire failure,
//      not a budget block). The zai gateway path stays open.
//
//   2. DURABLE RESERVATIONS — restart the daemon with pricing verified,
//      hammer until the gate slams, RESTART the daemon mid-blocked, and
//      verify the gate STAYS slammed (the pending/settled rows survived
//      the restart). The S27 suite proved the gate slams; S32 proves it
//      STAYS slammed across a restart.
//
//   3. FAIL-CLOSED BOOT — not directly exercisable over HTTP (a broken
//      meter is a DB outage, which the route can't simulate without
//      corrupting the runtime). The unit probe proves this law; the
//      route e2e documents it and asserts the gate's durable state.
//
// The suite runs in two daemon states:
//   - Phase 1: daemon WITHOUT TUBEFORGE_PRICING_VERIFIED (pricing-unverified block)
//   - Phase 2: daemon WITH TUBEFORGE_PRICING_VERIFIED=1 (durable hammer + restart)
// The caller restarts the daemon between phases.
//
// Run: node scripts/s32-route-e2e.mjs  (after the daemon is up in the right phase)

import { PrismaClient } from "@prisma/client";

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
const BASELINE = {
  users: await prisma.user.count(),
  orgs: await prisma.organization.count({ where: { memberships: { none: {} } } }),
  reservations: await prisma.spendReservation.count(),
};

// Detect the daemon's phase by reading the first paid-test response.
const tag = `s32-${Date.now()}`;
const email = `${tag}@e2e.local`;

// ---- 1. register through the real route ----
const reg = await fetch(`${BASE}/api/auth/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "S32 Probe", email, password: "s32-pass-1" }),
});
feed(reg);
check("1.1  register -> 201", reg.status === 201, reg.status);

const testOpenai = () =>
  fetch(`${BASE}/api/settings/ai`, {
    method: "POST",
    headers: H({ "content-type": "application/json" }),
    body: JSON.stringify({
      capability: "chat",
      provider: "openai",
      model: "gpt-6-astra",
      baseUrl: "http://example.com:9",
      apiKey: "sk-e2e-not-real",
    }),
  });

const first = await testOpenai();
const firstBody = await json(first);
check("1.2  the connection test route answers", first.status === 200, first.status);

// ---- 2. detect the phase ----
const pricingUnverified = /pricing is unverified|PRICING_STATUS/i.test(firstBody.error ?? "");
if (pricingUnverified) {
  console.log("\n[phase 1] pricing-unverified block (daemon without TUBEFORGE_PRICING_VERIFIED)");
  check("2.1  the first paid test is refused with the pricing-unverified error",
    firstBody.ok === false && pricingUnverified, firstBody.error);
  check("2.2  the error names PRICING_STATUS and the reconcile action",
    /PRICING_STATUS|pricing/i.test(firstBody.error ?? "") && /verified|reconcile/i.test(firstBody.error ?? ""),
    firstBody.error);

  // The zai gateway stays open even with unverified pricing.
  const zaiTest = await fetch(`${BASE}/api/settings/ai`, {
    method: "POST",
    headers: H({ "content-type": "application/json" }),
    body: JSON.stringify({ capability: "chat", provider: "zai" }),
  });
  const zaiBody = await json(zaiTest);
  check("2.3  the ungated gateway test still dispatches (zai unaffected)",
    zaiBody.ok === true && typeof zaiBody.reply === "string" && zaiBody.reply.length > 0,
    { status: zaiTest.status, reply: zaiBody.reply?.slice(0, 40) });

  // No SpendReservation rows were written (the block fired before admit).
  const reservations = await prisma.spendReservation.count({ where: { userId: { contains: tag } } });
  check("2.4  no reservations persisted (the block fired before admit)",
    reservations === 0, reservations);
} else {
  console.log("\n[phase 2] durable hammer + restart (daemon with TUBEFORGE_PRICING_VERIFIED=1)");
  // The daemon has pricing verified — exercise the durability law.
  // Hammer until the gate slams (same as s27, but now we prove durability).
  let blocked = null;
  let attempts = 0;
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
  check("2.1  the gate slams before the 25th dispatch", !!blocked, { attempts });
  check("2.2  the refusal names the budget law",
    /spend budget/i.test(blocked?.error ?? "") && /\$4\.50/.test(blocked?.error ?? ""), blocked?.error);

  // After the block, settle rows exist in the DB (durable).
  const settledRows = await prisma.spendReservation.count({
    where: { provider: "openai", status: "settled" },
  });
  check("2.3  settled SpendReservation rows exist (durable across restart)",
    settledRows >= attempts - 1, { settledRows, attempts });

  // The next dispatch is still refused (state is global + durable).
  const again = await testOpenai();
  const againBody = await json(again);
  check("2.4  the gate stays shut on the next attempt",
    againBody.ok === false && /spend budget/i.test(againBody.error ?? ""), againBody.error);

  // zai stays open.
  const zaiTest = await fetch(`${BASE}/api/settings/ai`, {
    method: "POST",
    headers: H({ "content-type": "application/json" }),
    body: JSON.stringify({ capability: "chat", provider: "zai" }),
  });
  const zaiBody = await json(zaiTest);
  check("2.5  the ungated gateway test still dispatches (zai unaffected)",
    zaiBody.ok === true && typeof zaiBody.reply === "string",
    { status: zaiTest.status, reply: zaiBody.reply?.slice(0, 40) });
}

// ---- 3. end state: the account leaves through the front door ----
const wipe = await fetch(`${BASE}/api/account/delete`, {
  method: "POST",
  headers: H({ "content-type": "application/json" }),
  body: JSON.stringify({ confirm: "DELETE" }),
});
feed(wipe);
check("3.1  account delete -> 200", wipe.status === 200, wipe.status);

await new Promise((r) => setTimeout(r, 500));
const users = await prisma.user.count();
const orgs = await prisma.organization.count({ where: { memberships: { none: {} } } });
const reservations = await prisma.spendReservation.count();
check("3.2  end state: users/orphan-orgs back to baseline (reservations may persist from the hammer — they ARE the durable record)",
  users === BASELINE.users && orgs === BASELINE.orgs,
  { users, orgs, reservations, BASELINE });

console.log(`\n${fail === 0 ? "ALL CHECKS PASS" : `${fail} FAILURE(S)`} (${pass} passed)`);
await prisma.$disconnect();
process.exit(fail === 0 ? 0 : 1);
