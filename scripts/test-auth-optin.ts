#!/usr/bin/env bun
// Live test for the OPT-IN auth gate (needs the dev server on :3000).
// Contract:
//   1. Gate OFF (default): anonymous API calls are OPEN — no password popup.
//   2. Enabling from Settings (POST /api/auth/lock) locks every API instantly.
//   3. First enable creates the password; a configured studio demands the
//      existing password (a stranger cannot claim it) and re-enabling is
//      rejected without it.
//   4. Wrong password → 401; right password → session cookie.
//   5. Disabling reopens the studio; clearPassword forgets the hash.
// Restores the original state (never leaves a test password behind).

const BASE = "http://localhost:3000";
const TEST_PW = "tf-optin-test-9x7";

let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS ${name}${detail ? ` — ${detail}` : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

const jfetch = async (path, opts: any = {}) => {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.cookie ? { Cookie: opts.cookie } : {}), ...(opts.headers ?? {}) },
  });
  let json: any = null;
  try { json = await res.json(); } catch {}
  const setCookie = res.headers.get("set-cookie");
  const cookie = setCookie?.split(";")[0] ?? null;
  return { status: res.status, json, cookie };
};

const status = async (cookie?: string | null) => (await jfetch("/api/auth/status", { cookie })).json;

console.log("Auth opt-in gate (live)");
const s0 = await status();

if (s0.gateEnabled) {
  // Owner's real lock is active — verify enforcement only, touch nothing.
  const anon = await fetch(`${BASE}/api/stats`);
  check("gate on: anonymous API rejected", anon.status === 401, `status ${anon.status}`);
  check("gate on: status reports enabled", s0.gateEnabled === true);
  console.log(`\n${pass}/${pass + fail} checks — owner lock active, no state changed`);
  process.exit(fail ? 1 : 0);
}

// 1. Default: open studio
const anonOpen = await fetch(`${BASE}/api/stats`);
check("gate off: anonymous API open (no popup by default)", anonOpen.status === 200, `status ${anonOpen.status}`);

if (s0.configured) {
  // A password already exists (owner set one) — enabling MUST demand it.
  const claim = await jfetch("/api/auth/lock", {
    method: "POST",
    body: JSON.stringify({ enabled: true, password: TEST_PW }),
  });
  check("configured studio rejects enable with wrong password", claim.status === 401, `status ${claim.status}`);
  const s1 = await status();
  check("state untouched: gate still off", s1.gateEnabled === false);
  console.log(`\n${pass}/${pass + fail} checks — existing password respected, no state changed`);
  process.exit(fail ? 1 : 0);
}

// 2. First-time enable creates the password and signs the caller in
const enable = await jfetch("/api/auth/lock", {
  method: "POST",
  body: JSON.stringify({ enabled: true, password: TEST_PW }),
});
check("first enable succeeds", enable.status === 200, `status ${enable.status}`);
check("enable response carries a session cookie", Boolean(enable.cookie));

// 3. Gate is live: anonymous blocked, session works, wrong password fails
const anonLocked = await fetch(`${BASE}/api/stats`);
check("gate on: anonymous API now 401", anonLocked.status === 401, `status ${anonLocked.status}`);
const badLogin = await jfetch("/api/auth/login", { method: "POST", body: JSON.stringify({ password: "wrong-password" }) });
check("wrong password rejected", badLogin.status === 401, `status ${badLogin.status}`);
const authed = await jfetch("/api/stats", { cookie: enable.cookie });
check("session cookie accepted", authed.status === 200, `status ${authed.status}`);

// 4. Re-enable without the password is refused (needs the current one)
const reenable = await jfetch("/api/auth/lock", { method: "POST", cookie: enable.cookie, body: JSON.stringify({ enabled: true }) });
check("re-enable without password refused", reenable.status === 400, `status ${reenable.status}`);

// 5. Short password refused on the create path is covered by API validation;
//    disabling reopens the studio and clears the test password.
const disable = await jfetch("/api/auth/lock", {
  method: "POST",
  cookie: enable.cookie,
  body: JSON.stringify({ enabled: false, clearPassword: true }),
});
check("disable succeeds (session caller)", disable.status === 200, `status ${disable.status}`);
const anonFinal = await fetch(`${BASE}/api/stats`);
check("gate off again: anonymous API open", anonFinal.status === 200, `status ${anonFinal.status}`);
const sEnd = await status();
check("password forgotten after clearPassword", sEnd.configured === false);
check("gate reports disabled", sEnd.gateEnabled === false);

console.log(`\n${pass}/${pass + fail} checks`);
process.exit(fail ? 1 : 0);
