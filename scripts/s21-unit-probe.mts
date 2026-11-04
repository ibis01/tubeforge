// S21 unit probe — "the confirmed address": email verification's missing
// half. The route's own error promised "sign in and request a new one" with
// nothing to request FROM; the emailed link answered raw JSON to a human;
// and the gate's console auto-verify was a fire-and-forget fetch that the
// very next window.location.reload() could abort — accounts staying
// unverified forever. Layers:
//   1. THE LANDING LAW — GET ?token is a redirect for humans now:
//      valid -> /?verified=ok (and the account flips verified), expired /
//      unknown -> /?verified=expired, missing -> /?verified=missing, and a
//      consumed token cannot replay (single-use, like the reset token).
//   2. THE RESEND LAW — POST: anon 401, bearer 403 (account management is
//      browser-only, the S16/S20 law), a signed-in session gets a FRESH
//      link that VOIDS the old one (one live token at a time), and an
//      already-verified account answers 400.
// Run: node --import tsx scripts/s21-unit-probe.mts

process.env.TUBEFORGE_AUTH_SECRET ??= "probe-secret-0123456789abcdef";

import { NextRequest } from "next/server";
import { PrismaClient } from "@prisma/client";
import { createApiToken, createSessionRecord, createSessionToken, hashPassword } from "../src/lib/tubeforge/tenant";
import { SESSION_COOKIE } from "../src/lib/tubeforge/auth-token";
import { GET as verifyGet, POST as verifyPost } from "../src/app/api/auth/verify-email/route";
import { sha256Hex } from "../src/lib/tubeforge/crypto";

const prisma = new PrismaClient();
let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

const URL_ = "http://probe.local/api/auth/verify-email";
const reqWith = (opts: RequestInit) => new NextRequest(URL_, opts);

const cookieOf = (t: string) => ({ cookie: `${SESSION_COOKIE}=${t}` });

// ---- throwaway identity (with a real Session row so the cookie resolves) ----
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const org = await prisma.organization.create({ data: { name: "S21 Probe Org", slug: `s21-probe-${suffix}` } });
const user = await prisma.user.create({
  data: {
    email: `s21-probe-${suffix}@probe.local`,
    passwordHash: await hashPassword("probe-pw-0123456789"),
    name: "S21 Probe",
  },
});
await prisma.membership.create({ data: { userId: user.id, organizationId: org.id, role: "owner" } });
const session = await createSessionRecord({ userId: user.id, organizationId: org.id, userAgent: "probe" });
const sessionToken = await createSessionToken(user.id, session.id);

// park a verification token on the account (register's shape)
const { randomToken } = await import("../src/lib/tubeforge/crypto");
const rawToken = randomToken();
await prisma.user.update({
  where: { id: user.id },
  data: {
    emailVerifyTokenHash: sha256Hex(rawToken),
    emailVerifyExpiresAt: new Date(Date.now() + 24 * 3600_000),
  },
});

// =====================================================================
// 1. the landing law — GET is a redirect for humans
// =====================================================================
{
  const ok = await verifyGet(reqWith({ headers: {} }) && new NextRequest(`${URL_}?token=${rawToken}`));
  check("1.1  a valid token -> 307", ok.status === 307, ok.status);
  check("1.2  the landing is /?verified=ok", ok.headers.get("location")?.includes("verified=ok"), ok.headers.get("location"));

  const after = await prisma.user.findUnique({ where: { id: user.id } });
  check("1.3  the account flipped verified", Boolean(after?.emailVerifiedAt) && !after?.emailVerifyTokenHash);

  const replay = await verifyGet(new NextRequest(`${URL_}?token=${rawToken}`));
  check("1.4  the consumed token cannot replay -> expired landing",
    replay.status === 307 && replay.headers.get("location")?.includes("verified=expired"),
    replay.headers.get("location"));

  const junk = await verifyGet(new NextRequest(`${URL_}?token=not-a-real-token-anything`));
  check("1.5  an unknown token -> expired landing",
    junk.status === 307 && junk.headers.get("location")?.includes("verified=expired"));

  const none = await verifyGet(new NextRequest(URL_));
  check("1.6  a missing token -> missing landing",
    none.status === 307 && none.headers.get("location")?.includes("verified=missing"));

  // reset to unverified + park an EXPIRED token
  await prisma.user.update({
    where: { id: user.id },
    data: {
      emailVerifiedAt: null,
      emailVerifyTokenHash: sha256Hex("expired-token-probe"),
      emailVerifyExpiresAt: new Date(Date.now() - 1000),
    },
  });
  const stale = await verifyGet(new NextRequest(`${URL_}?token=expired-token-probe`));
  check("1.7  an expired token -> expired landing",
    stale.status === 307 && stale.headers.get("location")?.includes("verified=expired"));
}

// =====================================================================
// 2. the resend law — POST mints a fresh link, voids the old
// =====================================================================
{
  const anon = await verifyPost(reqWith({ method: "POST" }));
  check("2.1  an anonymous resend -> 401", anon.status === 401, anon.status);

  const apiToken = await createApiToken(user.id, "s21 bearer probe");
  const bearer = await verifyPost(reqWith({ method: "POST", headers: { authorization: `Bearer ${apiToken!}` } }));
  check("2.2  a bearer resend -> 403 (browser-only account management)", bearer.status === 403, bearer.status);

  const ok = await verifyPost(reqWith({ method: "POST", headers: cookieOf(sessionToken!) }));
  const body = (await ok.json().catch(() => ({}))) as { ok?: boolean; verification?: { url?: string; expiresHours?: number } };
  check("2.3  a signed-in resend -> 200", ok.status === 200, ok.status);
  check("2.4  console mode returns the link", typeof body.verification?.url === "string" && body.verification.url.includes("token="));
  check("2.5  the link names its 24h expiry", body.verification?.expiresHours === 24, body.verification?.expiresHours);

  // the OLD parked token was voided by the fresh mint
  const oldRow = await prisma.user.findUnique({ where: { id: user.id } });
  check("2.6  the fresh mint replaced the stored hash (old link voided)",
    oldRow?.emailVerifyTokenHash === sha256Hex(body.verification!.url!.split("token=")[1]!),
    { stored: oldRow?.emailVerifyTokenHash?.slice(0, 8) });

  const freshUrl = body.verification!.url!;
  // S28 — the link is RELATIVE on the wire now (the register law): resolve it
  // against the probe origin the way a browser resolves it against the page.
  const consume = await verifyGet(new NextRequest(new URL(freshUrl, URL_).toString()));
  check("2.7  the fresh link consumes -> ok landing",
    consume.status === 307 && consume.headers.get("location")?.includes("verified=ok"));

  const after = await prisma.user.findUnique({ where: { id: user.id } });
  check("2.8  the account is verified now", Boolean(after?.emailVerifiedAt));

  const again = await verifyPost(reqWith({ method: "POST", headers: cookieOf(sessionToken!) }));
  check("2.9  a resend for an already-verified account -> 400", again.status === 400, again.status);
}

// ---- teardown ----
await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});

console.log(`\n${failures === 0 ? "ALL CHECKS PASS" : failures + " FAILURES"}`);
await prisma.$disconnect();
process.exit(failures === 0 ? 0 : 1);
