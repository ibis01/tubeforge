// S24 unit probe — "the money door": the plan card has been read-only since
// Stage 7 with its own header admitting it ("once a checkout route exists
// the Upgrade button wires straight into it"), and the payment-failed
// banner has told users to fix payment in a Customer Portal that did not
// exist anywhere. S24 opens both doors: POST /api/billing/checkout (a
// Stripe-hosted subscription checkout) and POST /api/billing/portal (the
// customer portal), wired to the webhook's checkout.session.completed
// handler via client_reference_id + metadata.planTier. Layers:
//   1. THE DOOR LAW — anon 401 on both routes + the plan read.
//   2. THE SESSION LAW — a bearer runs the studio, never the wallet:
//      checkout/portal answer 403; the plan read stays bearer-friendly
//      (ordinary telemetry, same ruling as S23's usage).
//   3. THE FAIL-CLOSED LAW — no key/price env → 503 on both doors, never a
//      fake success (the Stage 3 driver law).
//   4. THE TIER LAW — starter/unknown 400; unknown body fields stripped,
//      not rejected (house law).
//   5. THE CONTRACT LAW — with the env set, the route builds the exact
//      checkout Stripe + the webhook agree on (mode=subscription, price,
//      client_reference_id=userId, metadata.planTier, success/cancel) and
//      the portal binds the caller's Stripe customer. Proved against a
//      fetch fake — no network, no SDK.
//   6. THE 409 LAW — no customer → portal 409; already on the tier (an
//      active subscription) → checkout 409; a DIFFERENT tier still opens.
//   7. THE PLAN SURFACE — GET /api/billing/plan reports the deployment's
//      stripe wiring honestly in every state (off / key-only / wired).
// Run: node --import tsx scripts/s24-unit-probe.mts

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
import { POST as checkoutPost } from "../src/app/api/billing/checkout/route";
import { POST as portalPost } from "../src/app/api/billing/portal/route";
import { GET as planGet } from "../src/app/api/billing/plan/route";

const prisma = new PrismaClient();
// S28 — the studio has a REAL tenant now (the owner's account lives in
// this DB): teardown asserts NOTHING-BEHIND against the starting baseline.
const __BASELINE = { users: await prisma.user.count(), orgs: await prisma.organization.count() };
let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};
const json = async (r: Response) => r.json().catch(() => ({}));

const CHECKOUT = "http://probe.local/api/billing/checkout";
const PORTAL = "http://probe.local/api/billing/portal";
const PLAN = "http://probe.local/api/billing/plan";
const reqWith = (url: string, opts: RequestInit = {}) => new NextRequest(url, opts);
const post = (url: string, body: unknown, headers: HeadersInit = {}) =>
  new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

// ---- throwaway identity ----
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const org = await prisma.organization.create({ data: { name: "S24 Probe Org", slug: `s24-probe-${suffix}` } });
const user = await prisma.user.create({
  data: {
    email: `s24-probe-${suffix}@probe.local`,
    passwordHash: await hashPassword("probe-pw-0123456789"),
    name: "S24 Probe",
  },
});
await prisma.membership.create({ data: { userId: user.id, organizationId: org.id, role: "owner" } });
const session = await createSessionRecord({ userId: user.id, organizationId: org.id, userAgent: "probe" });
const sessionToken = await createSessionToken(user.id, session.id);
const cookie = { cookie: `${SESSION_COOKIE}=${sessionToken}` } as unknown as HeadersInit;

// make sure the deployment's real env never leaks into the probe
const savedEnv = { key: process.env.TUBEFORGE_STRIPE_SECRET_KEY, c: process.env.TUBEFORGE_STRIPE_PRICE_CREATOR, s: process.env.TUBEFORGE_STRIPE_PRICE_STUDIO };
delete process.env.TUBEFORGE_STRIPE_SECRET_KEY;
delete process.env.TUBEFORGE_STRIPE_PRICE_CREATOR;
delete process.env.TUBEFORGE_STRIPE_PRICE_STUDIO;

// =====================================================================
// 1. the door law
// =====================================================================
{
  const a1 = await checkoutPost(post(CHECKOUT, { tier: "creator" }));
  const a2 = await portalPost(post(PORTAL, {}));
  const a3 = await planGet(reqWith(PLAN));
  check("1.1  an anonymous checkout POST -> 401", a1.status === 401, a1.status);
  check("1.2  an anonymous portal POST -> 401", a2.status === 401, a2.status);
  check("1.3  an anonymous plan GET -> 401", a3.status === 401, a3.status);
}

// =====================================================================
// 2. the session law — bearers run the studio, never the wallet
// =====================================================================
{
  const bearer = (await createApiToken(user.id, "s24 keyring probe"))!;
  const bh = { authorization: `Bearer ${bearer}` };

  const p = await planGet(reqWith(PLAN, { headers: bh }));
  check("2.1  a bearer plan GET -> 200 (read-only telemetry)", p.status === 200, p.status);

  const c = await checkoutPost(post(CHECKOUT, { tier: "creator" }, bh));
  check("2.2  a bearer checkout POST -> 403 (money is browser-only)", c.status === 403, c.status);

  const po = await portalPost(post(PORTAL, {}, bh));
  check("2.3  a bearer portal POST -> 403", po.status === 403, po.status);

  const c2 = await checkoutPost(post(CHECKOUT, { tier: "creator" }, cookie));
  check("2.4  a session checkout POST passes the gate -> not 401/403", ![401, 403].includes(c2.status), c2.status);
}

// =====================================================================
// 3. the fail-closed law — no env, no checkout, no portal
// =====================================================================
{
  const c = await checkoutPost(post(CHECKOUT, { tier: "creator" }, cookie));
  check("3.1  unconfigured checkout -> 503", c.status === 503, c.status);
  const p = await portalPost(post(PORTAL, {}, cookie));
  check("3.2  unconfigured portal -> 503", p.status === 503, p.status);
  const d = (await json(c)) as { error?: string };
  check("3.3  the 503 says what the operator must set", typeof d.error === "string" && d.error.includes("TUBEFORGE_STRIPE_SECRET_KEY"), d);
}

// =====================================================================
// 4. the tier law — validation precedes the gate
// =====================================================================
{
  const s = await checkoutPost(post(CHECKOUT, { tier: "starter" }, cookie));
  check("4.1  starter is the free plan -> 400", s.status === 400, s.status);
  const u = await checkoutPost(post(CHECKOUT, { tier: "empire" }, cookie));
  check("4.2  an unknown tier -> 400", u.status === 400, u.status);
  const e = await checkoutPost(post(CHECKOUT, {}, cookie));
  check("4.3  an empty body -> 400", e.status === 400, e.status);
  // unknown fields are stripped, not rejected: the junk key must not turn
  // into a 400 — the request proceeds to the (unconfigured) 503 instead.
  const j = await checkoutPost(post(CHECKOUT, { tier: "creator", junk: "x", coupon: "FREE" }, cookie));
  check("4.4  unknown body fields are stripped (503, not 400)", j.status === 503, j.status);
}

// =====================================================================
// 5. the plan surface — the card learns the truth in every env state
// =====================================================================
{
  const off = (await json(await planGet(reqWith(PLAN, { headers: cookie })))) as { stripe?: { configured: boolean; checkoutTiers: string[] } };
  check("5.1  unconfigured: stripe.configured false, no tiers", off.stripe?.configured === false && off.stripe.checkoutTiers.length === 0, off.stripe);

  process.env.TUBEFORGE_STRIPE_SECRET_KEY = "sk_test_probe_0123456789";
  const keyOnly = (await json(await planGet(reqWith(PLAN, { headers: cookie })))) as { stripe?: { configured: boolean; checkoutTiers: string[] } };
  check("5.2  key-only: configured true, still no checkout tiers", keyOnly.stripe?.configured === true && keyOnly.stripe.checkoutTiers.length === 0, keyOnly.stripe);

  process.env.TUBEFORGE_STRIPE_PRICE_CREATOR = "price_creator_probe";
  const half = (await json(await planGet(reqWith(PLAN, { headers: cookie })))) as { stripe?: { checkoutTiers: string[] } };
  check("5.3  creator price only: exactly [creator]", JSON.stringify(half.stripe?.checkoutTiers) === JSON.stringify(["creator"]), half.stripe);

  process.env.TUBEFORGE_STRIPE_PRICE_STUDIO = "price_studio_probe";
}

// =====================================================================
// 6. the contract law — the exact Stripe calls, against a fetch fake
// =====================================================================
let captured: { url: string; params: URLSearchParams } | null = null;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (!url.startsWith("https://api.stripe.com")) return realFetch(input as never, init);
  captured = { url, params: new URLSearchParams(init?.body as string) };
  return new Response(JSON.stringify({ id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/test" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

{
  const c = await checkoutPost(post(CHECKOUT, { tier: "creator" }, cookie));
  const d = (await json(c)) as { ok?: boolean; url?: string };
  check("6.1  wired checkout -> 200 with a hosted url", c.status === 200 && d.ok === true && typeof d.url === "string" && d.url.startsWith("https://checkout.stripe.com"), d);
  const cap = captured as { url: string; params: URLSearchParams } | null;
  check("6.2  the call went to /checkout/sessions", cap?.url.endsWith("/v1/checkout/sessions"), cap?.url);
  const p = cap?.params;
  check("6.3  mode=subscription + the tier's price", p?.get("mode") === "subscription" && p?.get("line_items[0][price]") === "price_creator_probe", p?.toString());
  check("6.4  client_reference_id carries OUR userId (the webhook's handle)", p?.get("client_reference_id") === user.id, p?.get("client_reference_id"));
  check("6.5  metadata.planTier rides along", p?.get("metadata[planTier]") === "creator" && p?.get("subscription_data[metadata][planTier]") === "creator", p?.get("metadata[planTier]"));
  check("6.6  success/cancel come back to the app origin", (p?.get("success_url") ?? "").startsWith("http://probe.local/?billing=success") && (p?.get("cancel_url") ?? "").startsWith("http://probe.local/?billing=canceled"), { s: p?.get("success_url"), c: p?.get("cancel_url") });

  // the portal without any billing history -> 409 (nothing to manage)
  const po0 = await portalPost(post(PORTAL, {}, cookie));
  check("6.7  portal with no Stripe customer -> 409", po0.status === 409, po0.status);
}

// ---- a subscription appears (the webhook's own shape) → portal + 409 laws ----
{
  const planRow = await prisma.plan.create({
    data: { name: "Creator", tier: "creator", monthlyCredits: 10000, maxResolution: "1440p", priorityRendering: true, teamMembers: 1 },
  });
  const sub = await prisma.subscription.create({
    data: {
      userId: user.id,
      planId: planRow.id,
      stripeCustomerId: "cus_test_probe",
      stripeSubscriptionId: "sub_test_probe",
      status: "active",
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });

  // checkout for the tier you already hold -> 409 (nothing to buy)
  const dup = await checkoutPost(post(CHECKOUT, { tier: "creator" }, cookie));
  check("6.8  checkout while already on creator -> 409", dup.status === 409, dup.status);

  // a DIFFERENT tier still opens (upgrade path)
  captured = null;
  const up = await checkoutPost(post(CHECKOUT, { tier: "studio" }, cookie));
  const cap = captured as { params: URLSearchParams } | null;
  check("6.9  checkout for a different tier -> 200", up.status === 200, up.status);
  check("6.10 the upgrade call carries the studio price", cap?.params.get("line_items[0][price]") === "price_studio_probe", cap?.params.get("line_items[0][price]"));

  // the portal binds the caller's OWN stripe customer
  captured = null;
  const po = await portalPost(post(PORTAL, {}, cookie));
  const d = (await json(po)) as { url?: string };
  const cap2 = captured as { url: string; params: URLSearchParams } | null;
  check("6.11 portal -> 200 with a hosted url", po.status === 200 && typeof d.url === "string", d);
  check("6.12 the call went to /billing_portal/sessions", cap2?.url.endsWith("/v1/billing_portal/sessions"), cap2?.url);
  check("6.13 the portal binds OUR stripe customer", cap2?.params.get("customer") === "cus_test_probe", cap2?.params.get("customer"));
  check("6.14 return_url comes back to the app", (cap2?.params.get("return_url") ?? "").startsWith("http://probe.local/?billing=portal"), cap2?.params.get("return_url"));

  // the plan surface now shows the subscription + wiring truth
  const plan = (await json(await planGet(reqWith(PLAN, { headers: cookie })))) as { plan: { tier: string }; stripe: { configured: boolean; checkoutTiers: string[] } };
  check("6.15 the plan card reads creator + both checkout tiers", plan.plan.tier === "creator" && plan.stripe.configured === true && plan.stripe.checkoutTiers.length === 2, plan);

  await prisma.subscription.delete({ where: { id: sub.id } });
  await prisma.plan.delete({ where: { id: planRow.id } });
}

globalThis.fetch = realFetch;

// =====================================================================
// teardown — the end-state law
// =====================================================================
delete process.env.TUBEFORGE_STRIPE_SECRET_KEY;
delete process.env.TUBEFORGE_STRIPE_PRICE_CREATOR;
delete process.env.TUBEFORGE_STRIPE_PRICE_STUDIO;
if (savedEnv.key) process.env.TUBEFORGE_STRIPE_SECRET_KEY = savedEnv.key;
if (savedEnv.c) process.env.TUBEFORGE_STRIPE_PRICE_CREATOR = savedEnv.c;
if (savedEnv.s) process.env.TUBEFORGE_STRIPE_PRICE_STUDIO = savedEnv.s;

await prisma.apiToken.deleteMany({ where: { userId: user.id } });
await prisma.session.deleteMany({ where: { userId: user.id } });
await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
const [ul, ol] = [await prisma.user.count(), await prisma.organization.count()];
check("teardown  nothing behind (users/orgs back to baseline)", ul === __BASELINE.users && ol === __BASELINE.orgs, { ul, ol, __BASELINE });

console.log(`\n${failures === 0 ? "ALL CHECKS PASS" : failures + " FAILURES"}`);
await prisma.$disconnect();
process.exit(failures === 0 ? 0 : 1);
