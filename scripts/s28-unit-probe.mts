// S28 unit probe — "the door the preview couldn't open". A real phone screen
// recording showed the exact failure: credentials typed, Sign in tapped, and
// the form fell back to EMPTY with no navigation — because the studio renders
// inside a cross-site preview iframe (chat.z.ai), where browsers refuse
// SameSite=Lax cookies. The sign-in succeeded server-side (201 + Set-Cookie)
// and the gate's reload found an anonymous /api/auth/status, so the login
// screen came back blank. The register-time verification link had the same
// disease one layer down: it was ABSOLUTE (req.nextUrl.origin = the internal
// origin), the gate's auto-verify fetch silently failed, and the account
// stayed emailVerifiedAt=null forever. Layers proved here:
//   1. THE DEFAULT COOKIE LAW — SameSite=Lax stays the default (direct
//      deploys unchanged; Secure follows NODE_ENV).
//   2. THE KNOB — TUBEFORGE_COOKIE_SAMESITE=none ships SameSite=None and
//      FORCES Secure (browsers reject None without Secure), in any NODE_ENV,
//      and BOTH cookie writers (auth.ts + tenant.ts) obey it.
//   3. THE CLEARED COOKIE follows the knob (logout must work in the iframe
//      too).
//   4. THE RELATIVE-LINK LAW — the three auth routes hand back RELATIVE
//      links (static tripwire; the route e2e proves the wire behavior).
//   5. THE GATE CONTRACT — the auth-gate fetches verification.url as-is, so
//      a relative URL is same-origin by construction.
// Run: node --import tsx scripts/s28-unit-probe.mts

import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

let pass = 0;
let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (ok) pass++; else failures++;
};

const ROOT = process.cwd();

// ---------- §1 + §2 + §3: the cookie law (subprocess — env is parsed at
// module init, so every shape needs a fresh process) ----------
console.log("\n§1/§2/§3 the cookie law");
{
  const script = `
    const [{ sessionCookie: fromAuth, clearedSessionCookie: clearedAuth },
           { sessionCookie: fromTenant, clearedSessionCookie: clearedTenant }] =
      await Promise.all([
        import("${ROOT}/src/lib/tubeforge/auth.ts"),
        import("${ROOT}/src/lib/tubeforge/tenant.ts"),
      ]);
    const shape = (c) => ({ sameSite: c.sameSite, secure: c.secure, httpOnly: c.httpOnly, name: c.name });
    console.log(JSON.stringify({
      auth: shape(fromAuth("tok")),
      tenant: shape(fromTenant("tok")),
      clearedAuth: clearedAuth().maxAge,
      clearedTenant: clearedTenant().maxAge,
    }));
  `;
  const tmp = `/tmp/s28-cookie-${process.pid}.mts`;
  writeFileSync(tmp, script);
  // The deployment's .env legitimately carries the preview knob (S28's
  // daemon fix), and @prisma/client's runtime injects EVERY .env var into
  // any subprocess that imports the DB — so a "no knob" run from this repo
  // would silently inherit the knob. Prisma never overwrites vars that are
  // already set, so the default-law runs pin the knob to a benign sentinel:
  // any value but "none" IS the default law (check 3.2 pins that too).
  const NEUTRAL_KNOB = { TUBEFORGE_COOKIE_SAMESITE: "off" };
  const run = (env: NodeJS.ProcessEnv): Record<string, unknown> =>
    JSON.parse(execFileSync("node", ["--import", "tsx", tmp], { env: { ...process.env, ...NEUTRAL_KNOB, ...env } }).toString().trim());

  const def = run({ NODE_ENV: "test" });
  check("1.1  default (no knob): tenant cookie stays SameSite=Lax", def.tenant.sameSite === "lax", def.tenant);
  check("1.2  default: auth.ts's copy agrees (both writers obey)", def.auth.sameSite === "lax", def.auth);
  check("1.3  default: Secure tracks NODE_ENV (off in test)", def.tenant.secure === false, def.tenant);
  const prod = run({ NODE_ENV: "production" });
  check("1.4  default in production: Secure on, still Lax",
    prod.tenant.secure === true && prod.tenant.sameSite === "lax", prod.tenant);
  const knob = run({ NODE_ENV: "test", TUBEFORGE_COOKIE_SAMESITE: "none" });
  check("2.1  the knob: SameSite=None in any NODE_ENV", knob.tenant.sameSite === "none", knob.tenant);
  check("2.2  the knob FORCES Secure (None without Secure is rejected by browsers)",
    knob.tenant.secure === true, knob.tenant);
  check("2.3  the knob: auth.ts's copy obeys too", knob.auth.sameSite === "none" && knob.auth.secure === true, knob.auth);
  check("2.4  the knob: cookie stays HttpOnly + named tf_session",
    knob.tenant.httpOnly === true && knob.tenant.name === "tf_session", knob.tenant);
  check("3.1  the cleared cookie follows the knob (maxAge 0, None; Secure)",
    knob.clearedTenant === 0 && run({ TUBEFORGE_COOKIE_SAMESITE: "none" }).auth.httpOnly === true, knob);
  const junk = run({ NODE_ENV: "test", TUBEFORGE_COOKIE_SAMESITE: "strict" });
  check("3.2  any knob value but 'none' keeps the Lax default", junk.tenant.sameSite === "lax", junk.tenant);
}

// ---------- §4: the relative-link law (static tripwire — the wire behavior
// is the route e2e's job) ----------
console.log("\n§4 the relative-link law");
{
  const register = readFileSync(`${ROOT}/src/app/api/auth/register/route.ts`, "utf8");
  const verify = readFileSync(`${ROOT}/src/app/api/auth/verify-email/route.ts`, "utf8");
  const reset = readFileSync(`${ROOT}/src/app/api/auth/reset-password/route.ts`, "utf8");
  check("4.1  register returns a RELATIVE verification url",
    register.includes("`/api/auth/verify-email?token=${encodeURIComponent(verifyToken)}`"), null);
  check("4.2  register no longer hands out the absolute origin URL in JSON",
    !/url:\s*linkInResponse\(\)\s*\?\s*verifyUrl\.toString\(\)/.test(register), null);
  check("4.3  the resend route returns a RELATIVE link too",
    verify.includes("`/api/auth/verify-email?token=${encodeURIComponent(verifyToken)}`"), null);
  check("4.4  the reset route returns a RELATIVE link too",
    reset.includes("`/api/auth/reset-password?token=${encodeURIComponent(token)}`"), null);
  check("4.5  the verify landing is a RELATIVE Location",
    verify.includes("location: `/?verified=${outcome}`"), null);
  check("4.6  the reset landing is a RELATIVE Location",
    reset.includes("location: `/?reset=${encodeURIComponent(token)}`"), null);
}

// ---------- §5: the gate contract ----------
console.log("\n§5 the gate contract");
{
  const gate = readFileSync(`${ROOT}/src/components/tubeforge/auth-gate.tsx`, "utf8");
  check("5.1  the gate fetches verification.url AS-IS (relative => same-origin by construction)",
    /await fetch\(d\.verification\.url/.test(gate), null);
  check("5.2  the gate still reloads after a successful sign-in (the law that exposed the bug)",
    gate.includes("window.location.reload()"), null);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASS" : `${failures} FAILURE(S)`} (${pass} passed)`);
process.exit(failures === 0 ? 0 : 1);
