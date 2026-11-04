// S24 route e2e — the money door over real HTTP: register → sign in → the
// full law matrix against the running server (middleware, CSRF, limiter and
// all), then the end-state law (the battery leaves NOTHING).
//   arc 1  register 201 → session cookie (the browser half)
//   arc 2  anon 401 on all three billing surfaces
//   arc 3  the session law: a minted bearer gets 403 on checkout + portal,
//          while the plan read answers 200 (telemetry)
//   arc 4  fail-closed: unconfigured deployment → 503 on both doors
//   arc 5  the tier law: starter/unknown → 400; junk fields stripped → 503
//          (proceeds past validation)
//   arc 6  the plan surface: GET /api/billing/plan carries the honest
//          stripe block (configured false, no checkout tiers)
//   arc 7  cleanup: account + plan rows deleted, zero users/orgs/subs left
// Run: node scripts/s24-route-e2e.mjs
// (daemon must be up on :3000; Stripe envs MUST be unset — the fail-closed
//  law is the point)

const BASE = "http://localhost:3000";
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};
const j = async (r) => r.json().catch(() => ({}));

// ---- arc 1: register → cookie ----
const email = `s24-e2e-${Date.now()}@e2e.local`;
const password = "s24-e2e-pw-0123456789";
const reg = await fetch(`${BASE}/api/auth/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password, name: "S24 E2E" }),
});
check("1.1  register -> 201", reg.status === 201, reg.status);
const regBody = await j(reg);
const setCookie = reg.headers.get("set-cookie") ?? "";
const cookie = setCookie.split(";")[0];
check("1.2  the session cookie arrives", cookie.startsWith("tf_session=") || cookie.length > 20, cookie.slice(0, 24));
const authed = { "content-type": "application/json", cookie };

// ---- arc 2: the door law ----
{
  const a1 = await fetch(`${BASE}/api/billing/checkout`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tier: "creator" }),
  });
  check("2.1  anon checkout -> 401", a1.status === 401, a1.status);
  const a2 = await fetch(`${BASE}/api/billing/portal`, { method: "POST", body: "{}" });
  check("2.2  anon portal -> 401", a2.status === 401, a2.status);
  const a3 = await fetch(`${BASE}/api/billing/plan`);
  check("2.3  anon plan -> 401", a3.status === 401, a3.status);
}

// ---- arc 3: the session law ----
{
  const mint = await fetch(`${BASE}/api/auth/token`, {
    method: "POST", headers: authed, body: JSON.stringify({ label: "s24 e2e key" }),
  });
  const mt = await j(mint);
  check("3.1  bearer mints", mint.status === 201 && typeof mt.token === "string", mint.status);
  const bh = { "content-type": "application/json", authorization: `Bearer ${mt.token}` };

  const p = await fetch(`${BASE}/api/billing/plan`, { headers: bh });
  check("3.2  bearer plan GET -> 200", p.status === 200, p.status);
  const c = await fetch(`${BASE}/api/billing/checkout`, {
    method: "POST", headers: bh, body: JSON.stringify({ tier: "creator" }),
  });
  check("3.3  bearer checkout -> 403", c.status === 403, c.status);
  const po = await fetch(`${BASE}/api/billing/portal`, { method: "POST", headers: bh, body: "{}" });
  check("3.4  bearer portal -> 403", po.status === 403, po.status);
}

// ---- arc 4: fail-closed ----
{
  const c = await fetch(`${BASE}/api/billing/checkout`, {
    method: "POST", headers: authed, body: JSON.stringify({ tier: "creator" }),
  });
  check("4.1  session checkout unconfigured -> 503", c.status === 503, c.status);
  const d = await j(c);
  check("4.2  the 503 names the missing env", typeof d.error === "string" && d.error.includes("TUBEFORGE_STRIPE_SECRET_KEY"), d);
  const po = await fetch(`${BASE}/api/billing/portal`, { method: "POST", headers: authed, body: "{}" });
  check("4.3  session portal unconfigured -> 503", po.status === 503, po.status);
}

// ---- arc 5: the tier law ----
{
  const s = await fetch(`${BASE}/api/billing/checkout`, {
    method: "POST", headers: authed, body: JSON.stringify({ tier: "starter" }),
  });
  check("5.1  starter -> 400", s.status === 400, s.status);
  const u = await fetch(`${BASE}/api/billing/checkout`, {
    method: "POST", headers: authed, body: JSON.stringify({ tier: "galactic" }),
  });
  check("5.2  unknown tier -> 400", u.status === 400, u.status);
  const junk = await fetch(`${BASE}/api/billing/checkout`, {
    method: "POST", headers: authed, body: JSON.stringify({ tier: "creator", junk: "x" }),
  });
  check("5.3  junk fields stripped -> 503 (not 400)", junk.status === 503, junk.status);
  const portalJunk = await fetch(`${BASE}/api/billing/portal`, {
    method: "POST", headers: authed, body: JSON.stringify({ junk: "x" }),
  });
  check("5.4  portal ignores its empty body", portalJunk.status === 503, portalJunk.status);
}

// ---- arc 6: the plan surface ----
{
  const p = await fetch(`${BASE}/api/billing/plan`, { headers: { cookie } });
  const d = await j(p);
  check("6.1  plan GET -> 200", p.status === 200, p.status);
  check("6.2  the stripe block reports the unconfigured truth",
    d.stripe?.configured === false && Array.isArray(d.stripe?.checkoutTiers) && d.stripe.checkoutTiers.length === 0, d.stripe);
  check("6.3  starter plan + free tier badge data", d.plan?.tier === "starter" && d.subscription === null, { plan: d.plan?.tier, sub: d.subscription });
  check("6.4  access none + a credit balance", d.access === "none" && typeof d.creditBalance === "number", { access: d.access, bal: d.creditBalance });
}

// ---- arc 7: cleanup — the end-state law ----
{
  // find our user + orgs directly via the status endpoint's own identity,
  // then delete the account through the front door (the GDPR route) —
  // which ALSO exercises the delete arc against the new code.
  const del = await fetch(`${BASE}/api/account/delete`, {
    method: "POST", headers: authed, body: JSON.stringify({ confirm: "DELETE" }),
  });
  check("7.1  the account deletes through its own door -> 200", del.status === 200, del.status);
  const after = await fetch(`${BASE}/api/auth/status`, { headers: { cookie } });
  const ad = await j(after);
  check("7.2  the session is dead afterwards", after.status === 200 ? ad.authenticated === false : true, ad);
}

// ---- verify zero residue (direct DB) ----
const { PrismaClient } = await import("@prisma/client");
const prisma = new PrismaClient();
{
  const u = await prisma.user.findUnique({ where: { email } });
  check("7.3  the user row is gone", u === null);
  const tokens = await prisma.apiToken.count();
  const subs = await prisma.subscription.count();
  const users = await prisma.user.count();
  const orgs = await prisma.organization.count();
  check("7.4  end state: 0 users / orgs / tokens / subscriptions",
    users === 0 && orgs === 0 && tokens === 0 && subs === 0, { users, orgs, tokens, subs });
}
await prisma.$disconnect();

console.log(`\n${failures === 0 ? "ALL CHECKS PASS" : failures + " FAILURES"}`);
process.exit(failures === 0 ? 0 : 1);
