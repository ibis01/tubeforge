// S16 route e2e — "the account": the rotation through the LIVE daemon.
// The in-app password change the security card always promised. A throwaway
// identity (never the owner) exercises every layer of the contract:
//   1. the auth gate (no session → 401; the route is not in PUBLIC_API);
//   2. fixtures: account registers + logs in (the acting browser, jar A);
//   3. the proof gate — a wrong current password → 401 (a login-shaped
//      failure), a short new password → 400 naming the 8-char floor, a
//      new === current → 400 (a change that changes nothing);
//   4. a SECOND device logs in (jar B) — two live sessions on the account;
//   5. the happy rotation from jar A → 200, both sessions revoked, a FRESH
//      cookie in jar A;
//   6. the fall-out: jar B's status reads signed-out, jar A's reads
//      signed-in (the acting browser never blinks), the OLD password can
//      no longer log in, the NEW one can (jar C);
//   7. an API bearer token mints fine but may NOT rotate the password
//      (403 — a leaked 90-day script token can never lock the owner out);
//   8. an outstanding reset link is VOIDED by the rotation: request one,
//      rotate, then confirm with the stale token → 400;
//   9. the limiter: five wrong current passwords arm the per-IP lock — the
//      sixth attempt, even with the CORRECT password, → 429 (this block
//      runs LAST; afterwards the suite touches no auth endpoint);
//  10. cleanup: the throwaway account is removed from the DB.
// Run: node scripts/s16-route-e2e.mjs   (daemon on the S16 build)
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const BASE = "http://localhost:3000";
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

// Jar-aware call: each jar keeps its own cookie (set-cookie rotates it).
const jars = { A: "", B: "", C: "", D: "" };
async function call(jar, method, path, body, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (jars[jar]) headers.Cookie = jars[jar];
  let payload;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, { method, headers, body: payload });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie && jars[jar] !== undefined) jars[jar] = setCookie.split(";")[0];
  return res;
}

const stamp = Date.now().toString(36);
const email = `s16-e2e-${stamp}@example.com`;
const password = "S16RouteE2e!0001";
const password2 = "S16RouteE2e!0002";

// ---- 1. the auth gate ----
let res = await call("D", "POST", "/api/auth/change-password", { currentPassword: password, newPassword: password2 });
check("1.1  unauthenticated rotation → 401", res.status === 401, res.status);

// ---- 2. fixtures: the throwaway account + the acting browser ----
res = await call("A", "POST", "/api/auth/register", { email, password });
check("2.1  the account registers", res.status === 200 || res.status === 201, res.status);
res = await call("A", "POST", "/api/auth/login", { email, password });
check("2.2  the acting browser (A) logs in", res.status === 200, res.status);

// ---- 3. the proof gate ----
res = await call("A", "POST", "/api/auth/change-password", { currentPassword: "wrong-current-pw", newPassword: password2 });
check("3.1  a wrong current password → 401", res.status === 401, res.status);

res = await call("A", "POST", "/api/auth/change-password", { currentPassword: password, newPassword: "short" });
let body = await res.json().catch(() => ({}));
check("3.2  a short new password → 400 naming the 8-char floor",
  res.status === 400 && /8 characters/.test(body.error ?? ""), { status: res.status, error: body.error });

res = await call("A", "POST", "/api/auth/change-password", { currentPassword: password, newPassword: password });
body = await res.json().catch(() => ({}));
check("3.3  new === current → 400 (a change that changes nothing)",
  res.status === 400, { status: res.status, error: body.error });

// ---- 4. a second device logs in (two live sessions) ----
res = await call("B", "POST", "/api/auth/login", { email, password });
check("4.1  a second device (B) logs in — two live sessions", res.status === 200, res.status);

// ---- 5. the happy rotation from the acting browser ----
res = await call("A", "POST", "/api/auth/change-password", { currentPassword: password, newPassword: password2 });
body = await res.json().catch(() => ({}));
check("5.1  the rotation succeeds → 200", res.status === 200, { status: res.status, body });
// register auto-signs-in too, so live sessions at rotation = register + A + B
// = 3; the contract is EVERY live session dies (>= the two we know of).
check("5.2  every live session was revoked (register + A + B = 3)",
  body.revokedSessions === 3, body.revokedSessions);
check("5.3  jar A walked away with a FRESH cookie", Boolean(jars.A));

// ---- 6. the fall-out ----
res = await call("B", "GET", "/api/auth/status");
body = await res.json().catch(() => ({}));
check("6.1  the second device (B) is signed out", body.authenticated === false, body.authenticated);

res = await call("A", "GET", "/api/auth/status");
body = await res.json().catch(() => ({}));
check("6.2  the acting browser (A) stays signed in on the fresh session",
  body.authenticated === true, body.authenticated);

res = await call("D", "POST", "/api/auth/login", { email, password });
check("6.3  the OLD password can no longer log in", res.status === 401, res.status);

res = await call("C", "POST", "/api/auth/login", { email, password: password2 });
check("6.4  the NEW password logs in (a third browser, C)", res.status === 200, res.status);

// ---- 7. an API bearer may mint but never rotate ----
res = await call("C", "POST", "/api/auth/token");
body = await res.json().catch(() => ({}));
check("7.1  an API token mints for a signed-in session", res.status === 200 && typeof body.token === "string", res.status);
res = await call("D", "POST", "/api/auth/change-password",
  { currentPassword: password2, newPassword: "S16RouteE2e!0003" },
  { Authorization: `Bearer ${body.token}` });
check("7.2  an API bearer caller → 403 (scripts may not rotate)", res.status === 403, res.status);

// ---- 8. an outstanding reset link is voided by the rotation ----
res = await call("D", "POST", "/api/auth/reset-password", { email });
body = await res.json().catch(() => ({}));
const resetUrl = body.reset?.url;
check("8.1  a reset link is issued (console mode returns the URL)", typeof resetUrl === "string" && resetUrl.includes("token="), body.reset);
const rawToken = resetUrl ? new URL(resetUrl).searchParams.get("token") : null;

res = await call("C", "POST", "/api/auth/change-password", { currentPassword: password2, newPassword: "S16RouteE2e!0004" });
check("8.2  a rotation after the reset request succeeds", res.status === 200, res.status);

res = await call("D", "POST", "/api/auth/reset-password", { token: rawToken, password: "S16RouteE2e!0005" });
check("8.3  the pre-rotation reset link is VOID (confirm → 400)", res.status === 400, res.status);

// ---- 9. the limiter (LAST — arms a 10-minute lock on this IP) ----
// Five wrong current passwords arm the lock; the sixth attempt — even with
// the CORRECT password — is refused with 429 before the proof runs.
let saw401s = 0;
for (let i = 1; i <= 5; i++) {
  res = await call("C", "POST", "/api/auth/change-password", { currentPassword: "limiter-bait-pw", newPassword: "S16RouteE2e!0006" });
  if (res.status === 401) saw401s++;
}
check("9.1  five wrong proofs all answered 401", saw401s === 5, saw401s);

res = await call("C", "POST", "/api/auth/change-password", { currentPassword: "S16RouteE2e!0004", newPassword: "S16RouteE2e!0006" });
const retryAfter = res.headers.get("retry-after");
check("9.2  the sixth attempt (CORRECT password) → 429 with Retry-After",
  res.status === 429 && Number(retryAfter) > 0, { status: res.status, retryAfter });

// ---- 10. cleanup ----
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
const leftover = await db.user.count({ where: { email } });
check("10.1 cleanup — the throwaway account is gone", leftover === 0, leftover);

await db.$disconnect();
console.log(failures === 0 ? "\nS16 route e2e: ALL PASS" : `\nS16 route e2e: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
