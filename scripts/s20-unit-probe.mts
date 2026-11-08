// S20 unit probe — "the keyring": the API token registry contract through
// REAL modules. Bearer tokens were pure HMAC payloads since Stage 2 —
// nothing listed them, nothing revoked them; a leaked one was live for 90
// days and the only defense was rotating the global secret. S20 gives them
// the Session treatment: every mint persists a registry row keyed by the
// token's jti, and resolution refuses revoked/unknown/expired jtis.
// Layers:
//   1. THE MINT LAW — createApiToken returns a token AND persists a row
//      (label stored, expiry = 90 days, live), two mints carry distinct jtis.
//   2. THE GATE LAW — resolveRequestUser: a registry-backed bearer resolves;
//      an unknown jti (valid signature, no row) is NULL — deny-by-default;
//      a revoked token is NULL instantly; an expired row is NULL.
//   3. THE OWNERSHIP LAW — revokeApiToken: second revoke false, a foreign
//      user's revoke false (id-scoped to the owner).
//   4. THE LIST LAW — listApiTokens: newest first, metadata only (the jti
//      and the token itself can never appear — the secret is not stored).
//   5. THE USAGE LAW — a resolve stamps lastUsedAt (fire-and-forget), and a
//      second resolve within the minute does NOT bump it (one write/min).
// Run: node --import tsx scripts/s20-unit-probe.mts

process.env.TUBEFORGE_AUTH_SECRET ??= "probe-secret-0123456789abcdef";

import { NextRequest } from "next/server";
import { PrismaClient } from "@prisma/client";
import { createSignedToken, } from "../src/lib/tubeforge/auth-token";import { randomToken } from "../src/lib/tubeforge/crypto";
import {
  createApiToken,
  hashPassword,
  listApiTokens,
  resolveRequestUser,
  revokeApiToken,
} from "../src/lib/tubeforge/tenant";

const prisma = new PrismaClient();
// S28 — the studio has a REAL tenant now (the owner's account lives in
// this DB): teardown asserts NOTHING-BEHIND against the starting baseline.
const __BASELINE = { tokens: await prisma.apiToken.count() };
let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

const reqWith = (opts: RequestInit) => new NextRequest("http://probe.local/api/anything", opts);
const bearerReq = (token: string) =>
  reqWith({ headers: { authorization: `Bearer ${token}` } });

// ---- throwaway identity ----
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const org = await prisma.organization.create({
  data: { name: "S20 Probe Org", slug: `s20-probe-${suffix}` },
});
const user = await prisma.user.create({
  data: {
    email: `s20-probe-${suffix}@probe.local`,
    passwordHash: await hashPassword("probe-pw-0123456789"),
    name: "S20 Probe",
  },
});
await prisma.membership.create({
  data: { userId: user.id, organizationId: org.id, role: "owner" },
});

// =====================================================================
// 1. the mint law
// =====================================================================
{
  const token = await createApiToken(user.id, "probe token");
  check("1.1  the mint returns a signed token", typeof token === "string" && token.length > 20);

  const rows = await prisma.apiToken.findMany({ where: { userId: user.id } });
  check("1.2  the mint persists exactly one registry row", rows.length === 1, rows.length);
  const row = rows[0];
  check("1.3  the row carries the label", row?.name === "probe token", row?.name);
  check("1.4  the row is live (no revokedAt)", !row?.revokedAt);
  const ninetyDays = 90 * 24 * 60 * 60 * 1000;
  const skew = Math.abs(row.expiresAt.getTime() - (Date.now() + ninetyDays));
  check("1.5  the row expires in ~90 days", skew < 5 * 60 * 1000, skew);
  check("1.6  the row's jti is set (the registry key)", typeof row?.jti === "string" && row.jti.length >= 20);

  const token2 = await createApiToken(user.id);
  check("1.7  a second mint also returns a token", typeof token2 === "string" && token2 !== token);
  const rows2 = await prisma.apiToken.findMany({ where: { userId: user.id } });
  check("1.8  two rows, distinct jtis", rows2.length === 2 && new Set(rows2.map((r) => r.jti)).size === 2);
  check("1.9  an omitted label lands as null", rows2.find((r) => r.jti !== row?.jti)?.name === null);
}

// =====================================================================
// 2. the gate law — resolveRequestUser through the registry
// =====================================================================
let liveToken: string | null = null;
{
  liveToken = await createApiToken(user.id, "gate probe");
  const ctx = await resolveRequestUser(bearerReq(liveToken!));
  check("2.1  a registry-backed bearer resolves the caller", ctx?.userId === user.id && ctx?.organizationId === org.id, ctx);

  // valid signature, UNKNOWN jti — the pre-registry stateless token shape
  const forged = await createSignedToken("api", 3600, process.env.TUBEFORGE_AUTH_SECRET!, {
    uid: user.id,
    jti: randomToken(),
  });
  const forgedCtx = await resolveRequestUser(bearerReq(forged!));
  check("2.2  a signed but unregistered jti is NULL (deny-by-default)", forgedCtx === null, forgedCtx);

  // a jti registered to a DIFFERENT user must not resolve for this payload
  const stranger = await createSignedToken("api", 3600, process.env.TUBEFORGE_AUTH_SECRET!, {
    uid: user.id,
    jti: "not-a-real-jti-anywhere",
  });
  check("2.3  an unknown-jti bearer with an arbitrary id is NULL",
    (await resolveRequestUser(bearerReq(stranger!))) === null);

  // revoked → instant death
  const row = await prisma.apiToken.findFirst({ where: { userId: user.id, name: "gate probe" } });
  await prisma.apiToken.update({ where: { id: row!.id }, data: { revokedAt: new Date() } });
  check("2.4  a REVOKED bearer is NULL on its next request",
    (await resolveRequestUser(bearerReq(liveToken!))) === null);

  // expired row → dead even with a live signature
  const expToken = await createApiToken(user.id, "expired probe");
  const expRow = await prisma.apiToken.findFirst({ where: { userId: user.id, name: "expired probe" } });
  await prisma.apiToken.update({ where: { id: expRow!.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  check("2.5  an EXPIRED row is NULL despite a valid signature",
    (await resolveRequestUser(bearerReq(expToken!))) === null);
}

// =====================================================================
// 3. the ownership law — revokeApiToken
// =====================================================================
{
  const t = await createApiToken(user.id, "revoke probe");
  const row = await prisma.apiToken.findFirst({ where: { userId: user.id, name: "revoke probe" } });

  check("3.1  revoking a live row → true", (await revokeApiToken(user.id, row!.id)) === true);
  check("3.2  the bearer is dead immediately", (await resolveRequestUser(bearerReq(t!))) === null);
  check("3.3  revoking it again → false (already dead)", (await revokeApiToken(user.id, row!.id)) === false);
  check("3.4  a foreign user's revoke → false (owner-scoped)",
    (await revokeApiToken("someone-else", row!.id)) === false);
  check("3.5  revoking a nonexistent id → false", (await revokeApiToken(user.id, "no-such-row")) === false);
}

// =====================================================================
// 4. the list law — metadata only, newest first
// =====================================================================
{
  await createApiToken(user.id, "list probe A");
  await createApiToken(user.id, "list probe B");
  const list = await listApiTokens(user.id);
  const names = list.map((r) => r.name);
  check("4.1  the list is newest first (B before A)",
    names.indexOf("list probe B") < names.indexOf("list probe A"), names);
  const keys = list.length ? Object.keys(list[0]) : [];
  check("4.2  rows expose metadata only — no jti, no token material",
    !keys.includes("jti") && !keys.includes("token"), keys);
  const revokedNames = list.filter((r) => r.revokedAt).map((r) => r.name);
  check("4.3  revoked rows stay listed with their revokedAt", revokedNames.includes("revoke probe"), revokedNames);
  check("4.4  a foreign user's list is empty", (await listApiTokens("someone-else")).length === 0);
}

// =====================================================================
// 5. the usage law — lastUsedAt stamps, throttled to one write a minute
// =====================================================================
{
  const t = await createApiToken(user.id, "usage probe");
  const before = await prisma.apiToken.findFirst({ where: { userId: user.id, name: "usage probe" } });
  check("5.1  a fresh row has no lastUsedAt", !before?.lastUsedAt);

  await resolveRequestUser(bearerReq(t!));
  await new Promise((r) => setTimeout(r, 200)); // fire-and-forget stamp lands
  const after1 = await prisma.apiToken.findFirst({ where: { userId: user.id, name: "usage probe" } });
  check("5.2  the first resolve stamps lastUsedAt", Boolean(after1?.lastUsedAt));

  const stampedAt = after1!.lastUsedAt!.getTime();
  await new Promise((r) => setTimeout(r, 120));
  await resolveRequestUser(bearerReq(t!));
  await new Promise((r) => setTimeout(r, 200));
  const after2 = await prisma.apiToken.findFirst({ where: { userId: user.id, name: "usage probe" } });
  check("5.3  a resolve within the minute does NOT bump the stamp (throttle)",
    after2?.lastUsedAt?.getTime() === stampedAt);
}

// ---- teardown ----
await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
const leftovers = await prisma.apiToken.count();
check("teardown  cascade wiped the suite's registry rows (back to baseline)", leftovers === __BASELINE.tokens, { leftovers, baseline: __BASELINE.tokens });

console.log(`\n${failures === 0 ? "ALL CHECKS PASS" : failures + " FAILURES"}`);
await prisma.$disconnect();
process.exit(failures === 0 ? 0 : 1);
