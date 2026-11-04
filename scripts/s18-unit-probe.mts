// S18 unit probe — "the recovery": the reset contract through REAL modules.
// The two-step route existed since Stage 2 with NO caller; S18 gives the
// login screen the flow and the EMAILED link a landing. Layers:
//   1. GET law (the emailed link's landing): a well-formed token 302s into
//      the studio with /?reset=<token> (the AuthGate picks it up); missing /
//      too-short / too-long tokens die at the door with 400 — no redirect,
//      no information leak.
//   2. POST shape law (both steps, through the real handler): a non-email
//      "email" dies; a confirm with a 9-char token dies; a confirm with a
//      7-char password dies — all 400, none touching the DB with a write.
//      A well-shaped confirm with a GARBAGE token reads the DB, finds no
//      row and answers 400 "invalid or expired".
//   3. Blind law: the request step for an address with no account must
//      answer 200 with NO link — account enumeration stays blind.
// Run: node --import tsx scripts/s18-unit-probe.mts

import { NextRequest } from "next/server";
import { GET, POST } from "../src/app/api/auth/reset-password/route";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

const req = (method: "GET" | "POST", url: string, body?: unknown) =>
  new NextRequest(`http://probe.local${url}`, {
    method,
    ...(body !== undefined
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
      : {}),
  });

// =====================================================================
// 1. the GET law — the emailed link lands in the gate
// =====================================================================
{
  const token = "probe-reset-token-0123456789abcdef";
  const res = await GET(req("GET", `/api/auth/reset-password?token=${encodeURIComponent(token)}`));
  const loc = res.headers.get("location");
  check("1.1  a well-formed token redirects into the studio", res.status === 302 || res.status === 307, res.status);
  check("1.2  the Location carries /?reset=<token> for the gate to pick up (S28: relative)",
    loc === `/?reset=${token}`, loc);

  const noToken = await GET(req("GET", "/api/auth/reset-password"));
  check("1.3  no token → 400 (not a redirect)", noToken.status === 400, noToken.status);

  const short = await GET(req("GET", "/api/auth/reset-password?token=short"));
  check("1.4  a 5-char token → 400", short.status === 400, short.status);

  const long = await GET(req("GET", `/api/auth/reset-password?token=${"x".repeat(201)}`));
  check("1.5  a 201-char token → 400", long.status === 400, long.status);
}

// =====================================================================
// 2. the POST shape law — hostile bodies die at the schema
// =====================================================================
{
  const badEmail = await POST(req("POST", "/api/auth/reset-password", { email: "not-an-address" }));
  check("2.1  a non-email address → 400", badEmail.status === 400, badEmail.status);

  const shortToken = await POST(req("POST", "/api/auth/reset-password", { token: "ninechars", password: "long-enough-pw" }));
  check("2.2  a 9-char token → 400", shortToken.status === 400, shortToken.status);

  const shortPw = await POST(req("POST", "/api/auth/reset-password", { token: "a-token-of-ten-chars", password: "seven77" }));
  check("2.3  a 7-char password → 400", shortPw.status === 400, shortPw.status);

  const garbageToken = await POST(req("POST", "/api/auth/reset-password", { token: "garbage-token-0123456789", password: "a-fresh-password" }));
  const body = await garbageToken.json().catch(() => ({}));
  check("2.4  a well-shaped confirm with a garbage token → 400 (invalid or expired)",
    garbageToken.status === 400 && /invalid|expired/i.test(body.error ?? ""), { status: garbageToken.status, error: body.error });
}

// =====================================================================
// 3. the blind law — unknown addresses look identical
// =====================================================================
{
  const unknown = await POST(req("POST", "/api/auth/reset-password", { email: "nobody-here-9999@probe.local" }));
  const body = await unknown.json().catch(() => ({}));
  check("3.1  an unknown address answers 200 (blind)", unknown.status === 200, unknown.status);
  check("3.2  and hands back NO link", (body as { reset?: { url?: string } }).reset?.url === undefined, body);
}

// =====================================================================
// 4. the module shape — both handlers exported
// =====================================================================
{
  check("4.1  the route exports GET + POST", typeof GET === "function" && typeof POST === "function");
}

console.log(failures === 0 ? "\nS18 unit probe: ALL PASS" : `\nS18 unit probe: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
