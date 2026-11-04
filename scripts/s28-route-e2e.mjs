// S28 route e2e — "the door the preview couldn't open" against the running
// daemon. The video evidence: a real sign-in inside the chat.z.ai preview
// iframe bounced straight back to an empty form. This suite proves the whole
// arc a phone actually walks, WITH the daemon launched under
// TUBEFORGE_COOKIE_SAMESITE=none (the preview deployment's env):
//   register -> 201, the Set-Cookie carries SameSite=None + Secure (the
//   iframe law), the verification link is RELATIVE (the internal origin is
//   unreachable from the phone) -> GET the relative link -> 307 with a
//   RELATIVE /?verified=ok landing -> status flips verified -> a second
//   device signs in -> its cookie obeys the same law -> the session WORKS
//   (status authenticated) -> the account leaves through the front door ->
//   end state: nothing behind (baseline-relative — the owner's real account
//   lives in this DB now).
// Run after a daemon restart: node scripts/s28-route-e2e.mjs

import { PrismaClient } from "@prisma/client";

const BASE = "http://localhost:3000";
const jar = [];
const feed = (res) => {
  for (const c of res.headers.getSetCookie?.() ?? []) jar.push(c.split(";")[0]);
};
const setCookies = (res) => (res.headers.getSetCookie?.() ?? []).join(" | ");
const H = (extra = {}) => ({
  ...(jar.length ? { cookie: jar.join("; ") } : {}),
  ...extra,
});
let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  ok ? pass++ : fail++;
};
const json = async (res) => res.json().catch(() => ({}));

const prisma = new PrismaClient();
// S28 — baseline-relative end state, captured BEFORE the suite creates
// anything (the owner's real account lives in this DB now).
const BASELINE = {
  users: await prisma.user.count(),
  orgs: await prisma.organization.count(),
};

// ---- 1. register: the cookie law + the relative verification link ----
const tag = `s28-${Date.now()}`;
const email = `${tag}@e2e.local`;
const password = "s28-e2e-pw-0123456789";
const reg = await fetch(`${BASE}/api/auth/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password, name: "S28 Preview" }),
});
feed(reg);
const regBody = await json(reg);
check("1.1  register -> 201", reg.status === 201, reg.status);
const sc = setCookies(reg).toLowerCase();
check("1.2  the session cookie ships SameSite=None (the iframe law)", sc.includes("samesite=none"), sc);
check("1.3  ...and Secure (None without Secure is rejected by browsers)", sc.includes("secure"), sc);
check("1.4  ...and HttpOnly", sc.includes("httponly"), sc);
const verifyUrl = regBody.verification?.url;
check("1.5  the verification link is RELATIVE (the phone can't reach the internal origin)",
  typeof verifyUrl === "string" && verifyUrl.startsWith("/api/auth/verify-email?token="), verifyUrl);
check("1.6  no absolute/internal origin leaks into the link",
  typeof verifyUrl === "string" && !verifyUrl.includes("://"), verifyUrl);

// ---- 2. the auto-verify: the gate fetches the RELATIVE link against its
// own origin — the exact call that silently failed before ----
const landing = await fetch(`${BASE}${verifyUrl}`, { redirect: "manual" });
check("2.1  GET the relative verify link -> 307 (a landing, not raw JSON)",
  landing.status === 307, landing.status);
const loc = landing.headers.get("location") ?? "";
check("2.2  the landing Location is RELATIVE /?verified=ok",
  loc === "/?verified=ok", loc);

// ---- 3. the session works: status flips verified + authenticated ----
const status1 = await fetch(`${BASE}/api/auth/status`, { headers: H(), cache: "no-store" });
const st1 = await json(status1);
check("3.1  status: authenticated", st1.authenticated === true, st1);
check("3.2  status: the account is now emailVerified (the S21 flow, healed)",
  st1.user?.emailVerified === true, st1.user);

// ---- 4. a SECOND device signs in: same cookie law, same session power ----
const jar2 = [];
const login = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password }),
});
for (const c of login.headers.getSetCookie?.() ?? []) jar2.push(c.split(";")[0]);
const sc2 = setCookies(login).toLowerCase();
check("4.1  login -> 200", login.status === 200, login.status);
check("4.2  the login cookie obeys the same None; Secure law",
  sc2.includes("samesite=none") && sc2.includes("secure"), sc2);
const status2 = await fetch(`${BASE}/api/auth/status`, {
  headers: { cookie: jar2.join("; ") },
  cache: "no-store",
});
const st2 = await json(status2);
check("4.3  the second device's session WORKS (authenticated)",
  st2.authenticated === true && st2.user?.email === email, st2);

// ---- 5. the resend route answers by the book (already verified -> 400) ----
const resend = await fetch(`${BASE}/api/auth/verify-email`, {
  method: "POST",
  headers: H({ "content-type": "application/json" }),
});
check("5.1  a resend on a verified account -> 400 (already confirmed)",
  resend.status === 400, resend.status);

// ---- 6. the account leaves through the front door ----
const wipe = await fetch(`${BASE}/api/account/delete`, {
  method: "POST",
  headers: H({ "content-type": "application/json" }),
  body: JSON.stringify({ confirm: "DELETE" }),
});
feed(wipe);
check("6.1  account delete -> 200", wipe.status === 200, wipe.status);
const logoutCheck = await fetch(`${BASE}/api/auth/status`, { headers: H(), cache: "no-store" });
check("6.2  the session died with the account (status anonymous)",
  (await json(logoutCheck)).authenticated === false, null);

await new Promise((r) => setTimeout(r, 500));
const users = await prisma.user.count();
const orgs = await prisma.organization.count();
check("6.3  end state: nothing behind (users/orgs back to baseline)",
  users === BASELINE.users && orgs === BASELINE.orgs, { users, orgs, BASELINE });

console.log(`\n${fail === 0 ? "ALL CHECKS PASS" : `${fail} FAILURE(S)`} (${pass} passed)`);
await prisma.$disconnect();
process.exit(fail === 0 ? 0 : 1);
