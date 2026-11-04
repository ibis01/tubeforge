// S18 route e2e — "the recovery": the forgotten half of the login screen
// through the LIVE daemon. The full arc a locked-out owner walks:
//   1. the public gate: every recovery endpoint answers WITHOUT a session;
//   2. fixtures: a throwaway account, registered + a second device signed
//      in (two live sessions);
//   3. the link request from a SESSION-LESS browser (the locked-out case):
//      200 + reset.url in console mode; an UNKNOWN address answers the
//      same 200 with no link (enumeration stays blind);
//   4. the EMAILED link's landing: GET the reset.url → 307 into the studio
//      with /?reset=<token> (the AuthGate picks it up on mount);
//   5. a WRONG token confirm → 400;
//   6. the real confirm → 200: the new password verifies, the OLD password
//      is dead, EVERY session died (both jars read signed-out), and the
//      token is single-use (a replay → 400);
//   7. the gate's first-run law still holds after cleanup: zero users →
//      configured:false (the register screen — the S18 prelude's promise);
//   8. cleanup: the throwaway account + org removed.
// Run: node scripts/s18-route-e2e.mjs   (daemon on the S18 build)
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const BASE = "http://localhost:3000";
let cookie = "";

async function call(method, path, body) {
  const headers = { Cookie: cookie };
  let payload;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, { method, headers, body: payload });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  return res;
}

const stamp = Date.now().toString(36);
const email = `s18-e2e-${stamp}@example.com`;
const password = "S18RouteE2e!0001";
const password2 = "S18RouteE2e!0002";
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

// ---- 1. the public gate (no session anywhere yet) ----
let res = await call("POST", "/api/auth/reset-password", { email: "anyone@example.com" });
check("1.1  the link request needs no session (public)", res.status === 200, res.status);
res = await call("POST", "/api/auth/reset-password", { token: "garbage-token-0123456789", password: "some-fresh-password" });
check("1.2  the confirm needs no session (public)", res.status === 400, res.status); // garbage token, but PUBLIC — not 401

// ---- 2. fixtures: the account + two devices ----
res = await call("POST", "/api/auth/register", { email, password });
check("2.1  the throwaway account registers (device A auto-signed-in)", res.status === 200 || res.status === 201, res.status);
const jarA = cookie;
cookie = ""; // device B signs in fresh
res = await call("POST", "/api/auth/login", { email, password });
check("2.2  a second device (B) signs in", res.status === 200, res.status);
const jarB = cookie;

// ---- 3. the link request from a SESSION-LESS browser (the locked-out case) ----
cookie = ""; // the locked-out browser has nothing
res = await call("POST", "/api/auth/reset-password", { email });
let body = await res.json().catch(() => ({}));
check("3.1  the request succeeds for a real account", res.status === 200, res.status);
check("3.2  console mode hands the link straight back", typeof body.reset?.url === "string" && body.reset.url.includes("token="), body.reset);
const resetUrl = body.reset?.url ?? "";
const rawToken = resetUrl ? new URL(resetUrl).searchParams.get("token") : null;
check("3.3  the token extracts from the link", typeof rawToken === "string" && rawToken.length >= 10, rawToken?.length);

res = await call("POST", "/api/auth/reset-password", { email: `no-such-user-${stamp}@example.com` });
body = await res.json().catch(() => ({}));
check("3.4  an UNKNOWN address answers the same 200 (blind)", res.status === 200, res.status);
check("3.5  with NO link", body.reset?.url === undefined, body);

// ---- 4. the EMAILED link's landing ----
const landing = await fetch(resetUrl, { redirect: "manual" });
check("4.1  GET the emailed link → 307 (a redirect, not a 405)", landing.status === 302 || landing.status === 307, landing.status);
const loc = landing.headers.get("location") ?? "";
check("4.2  the Location lands in the studio with /?reset=<token>",
  loc.includes("/?reset=") && loc.includes(encodeURIComponent(rawToken ?? "")), loc);

// ---- 5. a WRONG token confirm ----
res = await call("POST", "/api/auth/reset-password", { token: `wrong-${rawToken}`, password: password2 });
check("5.1  a wrong token → 400 invalid/expired", res.status === 400, res.status);

// ---- 6. the real confirm ----
res = await call("POST", "/api/auth/reset-password", { token: rawToken, password: password2 });
body = await res.json().catch(() => ({}));
check("6.1  the confirm succeeds → 200 + the email back", res.status === 200 && body.email === email, { status: res.status, body });

cookie = jarA;
res = await call("GET", "/api/auth/status");
body = await res.json().catch(() => ({}));
check("6.2  device A's session died", body.authenticated === false, body.authenticated);

cookie = jarB;
res = await call("GET", "/api/auth/status");
body = await res.json().catch(() => ({}));
check("6.3  device B's session died", body.authenticated === false, body.authenticated);

cookie = "";
res = await call("POST", "/api/auth/login", { email, password });
check("6.4  the OLD password is dead (401)", res.status === 401, res.status);
res = await call("POST", "/api/auth/login", { email, password: password2 });
check("6.5  the NEW password signs in", res.status === 200, res.status);

// token is single-use: the hash was cleared at confirm
res = await call("POST", "/api/auth/logout", {});
res = await call("POST", "/api/auth/reset-password", { token: rawToken, password: "S18RouteE2e!0003" });
check("6.6  the spent token cannot replay (400)", res.status === 400, res.status);

// ---- 7. cleanup (keep the register-mode promise intact) ----
const user = await db.user.findUnique({
  where: { email },
  include: { memberships: { select: { organizationId: true } } },
});
if (user) {
  const orgIds = user.memberships.map((m) => m.organizationId);
  await db.session.deleteMany({ where: { userId: user.id } });
  await db.membership.deleteMany({ where: { userId: user.id } });
  await db.user.delete({ where: { id: user.id } });
  for (const orgId of orgIds) await db.organization.deleteMany({ where: { id: orgId } });
}
const leftover = await db.user.count();
check("7.1  cleanup — zero users remain (the register screen stands)", leftover === 0, leftover);

await db.$disconnect();
console.log(failures === 0 ? "\nS18 route e2e: ALL PASS" : `\nS18 route e2e: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
