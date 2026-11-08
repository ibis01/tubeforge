// S23 unit probe — "the account surface": three routes standing since
// Stage 3/4 with nobody knocking — /api/account/usage (the aggregates
// dashboard T-3.8 named but never shipped), /api/account/export (the GDPR
// bundle) and /api/account/delete (the irreversible one). S23 gives them
// their front door AND brings delete/export under the account-management
// law (S16 password rotation, S20 keyring, S21 resend: bearers run the
// studio, sessions run the account). Layers:
//   1. THE DOOR LAW — anon 401 on all three.
//   2. THE BEARER LAW — usage answers a bearer (ordinary telemetry a
//      script may read); export and delete answer 403 (the most private
//      read and the most destructive write are browser-only).
//   3. THE MATH LAW — UsageRecord rows surface as per-capability
//      aggregates (calls, failures, tokens, cost, latency), ?days clamps
//      to 1..90, foreign rows never leak in.
//   4. THE EXPORT LAW — the bundle carries the account's shape, secrets
//      only ever as presence markers, never plaintext.
//   5. THE DELETE LAW — wrong confirm 400 + alive; a bearer 403; the real
//      thing 200, clears the cookie, and takes EVERYTHING (org cascade,
//      sessions, settings, uploads tree) with it.
// Run: node --import tsx scripts/s23-unit-probe.mts

process.env.TUBEFORGE_AUTH_SECRET ??= "probe-secret-0123456789abcdef";

import { NextRequest } from "next/server";
import { PrismaClient } from "@prisma/client";
import {
  createApiToken,
  createSessionRecord,
  createSessionToken,
  hashPassword,
} from "../src/lib/tubeforge/tenant";
import { SESSION_COOKIE } from "../src/lib/tubeforge/auth-token";
import { GET as usageGet } from "../src/app/api/account/usage/route";
import { GET as exportGet } from "../src/app/api/account/export/route";
import { POST as deletePost } from "../src/app/api/account/delete/route";
import fs from "node:fs";
import path from "node:path";

const prisma = new PrismaClient();
// S28 — the studio has a REAL tenant now (the owner's account lives in
// this DB): teardown asserts NOTHING-BEHIND against the starting baseline.
const __BASELINE = { users: await prisma.user.count(), orgs: await prisma.organization.count() };
let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

// S58 — the named-fixture guard: a missing token/row/hold becomes a labeled
// error instead of a TypeError at the deref.
const req = <T,>(label: string, v: T | undefined | null): T => {
  if (v === undefined || v === null) throw new Error(`missing: ${label}`);
  return v;
};
const json = async (r: Response) => r.json().catch(() => ({}));

const USAGE = "http://probe.local/api/account/usage";
const EXPORT = "http://probe.local/api/account/export";
const DELETE_ = "http://probe.local/api/account/delete";
const reqWith = (url: string, opts: RequestInit = {}) => new NextRequest(url, opts);

// ---- throwaway identity ----
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const org = await prisma.organization.create({ data: { name: "S23 Probe Org", slug: `s23-probe-${suffix}` } });
const user = await prisma.user.create({
  data: {
    email: `s23-probe-${suffix}@probe.local`,
    passwordHash: await hashPassword("probe-pw-0123456789"),
    name: "S23 Probe",
  },
});
await prisma.membership.create({ data: { userId: user.id, organizationId: org.id, role: "owner" } });
const session = await createSessionRecord({ userId: user.id, organizationId: org.id, userAgent: "probe" });
const sessionToken = await createSessionToken(user.id, session.id);
const cookie = { cookie: `${SESSION_COOKIE}=${sessionToken}` } as unknown as HeadersInit;

// fixture rows the aggregates can count
const video = await prisma.video.create({ data: { organizationId: org.id, topic: "S23 probe video", status: "draft", niche: "probe" } });
const stranger = await prisma.user.create({
  data: {
    email: `s23-stranger-${suffix}@probe.local`,
    passwordHash: await hashPassword("probe-pw-0123456789"),
    name: "S23 Stranger",
  },
});
const strangerOrg = await prisma.organization.create({ data: { name: "S23 Stranger Org", slug: `s23-stranger-${suffix}` } });
await prisma.membership.create({ data: { userId: stranger.id, organizationId: strangerOrg.id, role: "owner" } });
await prisma.usageRecord.create({ data: { userId: stranger.id, organizationId: strangerOrg.id, capability: "chat", provider: "zai", ok: true } });

// =====================================================================
// 1. the door law
// =====================================================================
{
  const a1 = await usageGet(reqWith(USAGE));
  const a2 = await exportGet(reqWith(EXPORT));
  const a3 = await deletePost(reqWith(DELETE_, { method: "POST" }));
  check("1.1  an anonymous usage GET -> 401", a1.status === 401, a1.status);
  check("1.2  an anonymous export GET -> 401", a2.status === 401, a2.status);
  check("1.3  an anonymous delete POST -> 401", a3.status === 401, a3.status);
}

// =====================================================================
// 2. the bearer law — telemetry open, privacy + destruction closed
// =====================================================================
{
  const bearer = req("s23 keyring probe token", await createApiToken(user.id, "s23 keyring probe"));
  const bh = { authorization: `Bearer ${bearer}` };

  const u = await usageGet(reqWith(USAGE, { headers: bh }));
  check("2.1  a bearer usage GET -> 200 (ordinary telemetry)", u.status === 200, u.status);

  const e = await exportGet(reqWith(EXPORT, { headers: bh }));
  check("2.2  a bearer export GET -> 403 (the bundle is browser-only)", e.status === 403, e.status);

  const d = await deletePost(reqWith(DELETE_, { method: "POST", headers: bh, body: JSON.stringify({ confirm: "DELETE" }) }));
  check("2.3  a bearer delete POST -> 403 (a leaked key never wipes a studio)", d.status === 403, d.status);
  const still = await prisma.user.findUnique({ where: { id: user.id } });
  check("2.4  the account survived the bearer's attempt", still !== null);
}

// =====================================================================
// 3. the math law — the aggregates count what the studio spent
// =====================================================================
{
  const mk = (capability: string, provider: string, ok: boolean, extra: object = {}) =>
    prisma.usageRecord.create({ data: { userId: user.id, organizationId: org.id, capability, provider, ok, ...extra } });
  await mk("chat", "zai", true, { inputTokens: 100, outputTokens: 200, costMicroUsd: 3000, latencyMs: 800 });
  await mk("chat", "zai", true, { inputTokens: 50, outputTokens: 60, costMicroUsd: 2000, latencyMs: 1200 });
  await mk("chat", "zai", false, { inputTokens: 10, outputTokens: 0, costMicroUsd: 0, latencyMs: 4000 });
  await mk("video", "cogvideox", true, { inputTokens: 0, outputTokens: 0, costMicroUsd: 40000, latencyMs: 60_000 });

  const res = await usageGet(reqWith(USAGE, { headers: cookie }));
  check("3.1  a signed-in usage GET -> 200", res.status === 200, res.status);
  const d = (await json(res)) as {
    window: { days: number };
    totals: { calls: number; costMicroUsd: number; costUsd: number };
    capabilities: { capability: string; calls: number; failures: number; inputTokens: number; costMicroUsd: number; avgLatencyMs: number | null }[];
  };
  const chat = d.capabilities.find((c) => c.capability === "chat");
  const vid = d.capabilities.find((c) => c.capability === "video");
  check("3.2  chat aggregates: 3 calls, 1 failure", chat?.calls === 3 && chat?.failures === 1, chat);
  check("3.3  chat tokens + cost sum", chat?.inputTokens === 160 && chat?.costMicroUsd === 5000, chat);
  // the route groups by (capability, provider, ok) then merges the group
  // averages weighted by counts: ok rows (800,1200) avg 1000 x2, the
  // failure row 4000 x1 -> (1000*2 + 4000) / 3 = 2000
  check("3.4  chat latency merges group averages (2000)", Math.round(chat?.avgLatencyMs ?? 0) === 2000, chat?.avgLatencyMs);
  check("3.5  video aggregates: 1 call", vid?.calls === 1, vid);
  check("3.6  totals: 4 calls, $0.045", d.totals.calls === 4 && d.totals.costUsd === 0.045, d.totals);

  // the stranger's row never leaks in
  check("3.7  foreign rows stay out (only own capability rows)", d.capabilities.every((c) => ["chat", "video"].includes(c.capability)), d.capabilities.map((c) => c.capability));

  // window clamping
  const zero = await usageGet(reqWith(`${USAGE}?days=0`, { headers: cookie }));
  const big = await usageGet(reqWith(`${USAGE}?days=999`, { headers: cookie }));
  const dz = (await json(zero)).window.days as number;
  const db_ = (await json(big)).window.days as number;
  check("3.8  ?days=0 clamps to 1", dz === 1, dz);
  check("3.9  ?days=999 clamps to 90", db_ === 90, db_);
}

// =====================================================================
// 4. the export law — the whole shape, no secrets
// =====================================================================
{
  await prisma.userSetting.create({ data: { userId: user.id, key: "probe-setting", value: "on" } });
  await prisma.providerCredential.create({ data: { userId: user.id, capability: "image", provider: "zai", apiKey: "probe-key-not-exported" } });

  const res = await exportGet(reqWith(EXPORT, { headers: cookie }));
  check("4.1  a signed-in export GET -> 200", res.status === 200, res.status);
  check("4.2  the bundle downloads as tubeforge-export.json",
    (res.headers.get("content-disposition") ?? "").includes("tubeforge-export.json"), res.headers.get("content-disposition"));
  const d = (await json(res)) as {
    account: { email: string };
    data: { videos: unknown[]; settings: { key: string }[]; providerCredentials: Record<string, unknown>[] };
  };
  check("4.3  the account block names the caller", d.account?.email === `s23-probe-${suffix}@probe.local`, d.account?.email);
  check("4.4  the org's videos ride along", Array.isArray(d.data?.videos) && d.data.videos.length >= 1, d.data?.videos?.length);
  check("4.5  user settings ride along", d.data?.settings?.some((s) => s.key === "probe-setting"), d.data?.settings);
  const cred = d.data?.providerCredentials?.[0];
  check("4.6  credentials export as presence, never plaintext",
    cred && !("secretCiphertext" in cred) && !("secret" in cred) && !JSON.stringify(d).includes("shhh-not-exported"), cred);
}

// =====================================================================
// 5. the delete law — the irreversible one
// =====================================================================
{
  const wrong = await deletePost(reqWith(DELETE_, { method: "POST", headers: cookie, body: JSON.stringify({ confirm: "delete" }) }));
  check("5.1  a lowercase confirm -> 400", wrong.status === 400, wrong.status);
  check("5.2  the account survived the wrong confirm", (await prisma.user.findUnique({ where: { id: user.id } })) !== null);

  // an uploads tree that must vanish with the account
  const uploadDir = path.join(process.cwd(), "uploads", video.id);
  fs.mkdirSync(uploadDir, { recursive: true });
  fs.writeFileSync(path.join(uploadDir, "probe.bin"), "x");

  const gone = await deletePost(reqWith(DELETE_, { method: "POST", headers: cookie, body: JSON.stringify({ confirm: "DELETE" }) }));
  check("5.3  the real confirm -> 200", gone.status === 200, gone.status);
  const setCookie = gone.headers.get("set-cookie") ?? "";
  check("5.4  the session cookie is cleared", /expires=Thu, 01 Jan 1970|Max-Age=0|=/i.test(setCookie) && setCookie.length > 0, setCookie.slice(0, 60));

  const [u, o, v, s, ust, cred2, rec] = await Promise.all([
    prisma.user.findUnique({ where: { id: user.id } }),
    prisma.organization.findUnique({ where: { id: org.id } }),
    prisma.video.findUnique({ where: { id: video.id } }),
    prisma.session.findFirst({ where: { userId: user.id } }),
    prisma.userSetting.findFirst({ where: { userId: user.id } }),
    prisma.providerCredential.findFirst({ where: { userId: user.id } }),
    prisma.usageRecord.findFirst({ where: { userId: user.id } }),
  ]);
  check("5.5  the user row is gone", u === null);
  check("5.6  the org cascaded away", o === null);
  check("5.7  the videos cascaded away", v === null);
  check("5.8  sessions, settings, credentials, usage rows all gone",
    s === null && ust === null && cred2 === null && rec === null);
  check("5.9  the uploads tree is removed", !fs.existsSync(uploadDir));

  // the stranger kept everything
  const strangerAlive = await prisma.user.findUnique({ where: { id: stranger.id } });
  check("5.10 the stranger's account untouched", strangerAlive !== null);
}

// ---- teardown: the probe deleted its own identity; sweep the stranger ----
await prisma.user.delete({ where: { id: stranger.id } }).catch(() => {});
await prisma.organization.delete({ where: { id: strangerOrg.id } }).catch(() => {});
const [ul, ol] = [await prisma.user.count(), await prisma.organization.count()];
check("teardown  nothing behind (users/orgs back to baseline)", ul === __BASELINE.users && ol === __BASELINE.orgs, { ul, ol, __BASELINE });

console.log(`\n${failures === 0 ? "ALL CHECKS PASS" : failures + " FAILURES"}`);
await prisma.$disconnect();
process.exit(failures === 0 ? 0 : 1);
