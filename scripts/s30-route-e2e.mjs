// S30 route e2e — "the wire-up": the door the AI kept bouncing off.
//
// The phone evidence (two screenshots): Auto-Pilot's step 4 "AI Script +
// Metadata failed" and Topic Radar's "Scan failed", both "Cross-origin
// request rejected". The forensics: steps 1–3 are client-side (no API
// calls), the owner was signed in (S28's cookie law holds), and the FIRST
// real API call died at the middleware — the preview deployment's proxy
// rewrites the Host header, so the Stage-2 CSRF guard (origin === host)
// 403'd every cookie-authenticated mutation from the preview browser. The
// z-ai SDK (the app's out-of-box default provider, credential-free in this
// sandbox) was never even reached.
//
// This suite proves the whole story against the running daemon:
//
//   1. the auth gate (unchanged law — anonymous mutations still 401)
//   2. a throwaway owner through the front door
//   3. THE ORIGIN LAWS — with the daemon launched under
//      TUBEFORGE_ALLOWED_ORIGINS=.space-z.ai (the preview deployment's env):
//        · no Origin (curl/scripts/API clients)      → allowed (Stage-2 law)
//        · preview origin (preview-x.space-z.ai)     → allowed (THE FIX —
//          what the phone browser sends behind the rewriting proxy)
//        · evil origin (evil.example.com)            → 403 (the wall stands)
//        · hyphen lookalike (evil-space-z.ai)        → 403 (the dot is
//          load-bearing)
//        · path lookalike (space-z.ai.attacker.com)  → 403
//        · localhost origin matching host            → allowed (direct law)
//   4. THE WIRE-UP, proof #1 — a Topic Radar scan ("Scan failed" in the
//      screenshots) runs to completion THROUGH THE DAEMON on the z-ai SDK:
//      202 → poll → real ideas with titles (not the persisted error shape)
//   5. THE WIRE-UP, proof #2 — the Auto-Pilot script path ("AI Script +
//      Metadata failed") : POST /api/videos with a topic → 202 → the script
//      job runs on the SDK → poll → a real script AND its metadata
//      (description + tags + wordCount + status "scripted")
//   6. cleanup — the video and the account leave; end state vs the suite's
//      STARTING baseline (the owner's real account lives in this DB).
//
// Run after a daemon restart UNDER THE PREVIEW ENV:
//   TUBEFORGE_COOKIE_SAMESITE=none TUBEFORGE_ALLOWED_ORIGINS=.space-z.ai
//   node scripts/s30-route-e2e.mjs

import { PrismaClient } from "@prisma/client";

const BASE = "http://localhost:3000";
const db = new PrismaClient();

const stamp = Date.now().toString(36);
const email = `s30-e2e-${stamp}@example.com`;
const PASSWORD = "S30RouteE2e!2345";

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cookie = null;
async function call(method, p, body, extraHeaders = {}) {
  const headers = { ...(cookie ? { cookie } : {}), ...extraHeaders };
  let payload;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + p, { method, headers, body: payload });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json };
}
/** A mutating call with a spoofed browser Origin (no cookie capture). */
async function callWithOrigin(origin, p, body) {
  const res = await fetch(BASE + p, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json };
}

// ---- 0. baseline ----
const baseline = {
  users: await db.user.count(),
  orgs: await db.organization.count(),
  videos: await db.video.count(),
};

// ---- 1. the auth gate ----
let res = await fetch(BASE + "/api/research", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ niche: "test" }),
});
check("1.1  anonymous scan → 401", res.status === 401, res.status);
res = await fetch(BASE + "/api/videos", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ topic: "test" }),
});
check("1.2  anonymous video create → 401", res.status === 401, res.status);

// ---- 2. a throwaway owner ----
await call("POST", "/api/auth/register", { email, password: PASSWORD });
res = await call("POST", "/api/auth/login", { email, password: PASSWORD });
check("2.1  throwaway owner registers + logs in", res.status === 200, res.status);

// ---- 3. the origin laws ----
// (a) API clients send no Origin — always allowed (Stage-2 law).
res = await call("POST", "/api/research", { niche: "s30-probe", query: "origin law (no Origin header)" });
check("3.1  no Origin header (API client) → accepted", res.status === 202, { status: res.status, error: res.json?.error });
const SCAN_ID = res.json?.id ?? res.json?.session?.id ?? null;

// (b) THE FIX — the preview origin behind the rewriting proxy.
res = await callWithOrigin("https://preview-s30probe.space-z.ai", "/api/research", { niche: "s30-probe", query: "preview origin" });
check("3.2  preview origin (preview-s30probe.space-z.ai) → accepted (THE FIX)", res.status === 202, { status: res.status, error: res.json?.error });

// (c) the wall still stands.
res = await callWithOrigin("https://evil.example.com", "/api/research", { niche: "x" });
check("3.3  unlisted origin (evil.example.com) → 403", res.status === 403, { status: res.status, error: res.json?.error });
res = await callWithOrigin("https://evil-space-z.ai", "/api/research", { niche: "x" });
check("3.4  hyphen lookalike (evil-space-z.ai) → 403 (the dot is load-bearing)", res.status === 403, res.status);
res = await callWithOrigin("https://space-z.ai.attacker.com", "/api/research", { niche: "x" });
check("3.5  path lookalike (space-z.ai.attacker.com) → 403", res.status === 403, res.status);

// (d) the direct-connection law survives.
res = await callWithOrigin("http://localhost:3000", "/api/research", { niche: "s30-probe", query: "direct origin" });
check("3.6  origin matching the request host → accepted (direct law)", res.status === 202, { status: res.status, error: res.json?.error });

// ---- 4. THE WIRE-UP, proof #1 — the Topic Radar scan on the SDK ----
let scan = null;
if (SCAN_ID) {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    const r = await call("GET", `/api/research/${SCAN_ID}`);
    if (r.status === 200 && r.json?.session && r.json.session.error === null && r.json.session.ideas?.length > 0) {
      scan = r.json.session;
      break;
    }
    if (r.status === 200 && r.json?.session?.error) { scan = r.json.session; break; }
    await sleep(1500);
  }
  check("4.1  the scan completes (no 'Scan failed')", !!scan && !scan.error, scan?.error ?? "timeout");
  if (scan && !scan.error) {
    check("4.2  the SDK produced real ideas with titles", scan.ideas.length >= 1 && scan.ideas.every((i) => typeof i.title === "string" && i.title.length > 0), scan.ideas?.length);
    check("4.3  the scan left a niche summary", typeof scan.nicheSummary === "string" && scan.nicheSummary.length > 0, (scan.nicheSummary ?? "").slice(0, 60));
  }
} else {
  check("4.1  the scan completed (no 'Scan failed')", false, "no scan id captured");
}

// ---- 5. THE WIRE-UP, proof #2 — the Auto-Pilot script path on the SDK ----
res = await call("POST", "/api/videos", {
  topic: "Why lighthouses still matter in the GPS age",
  niche: "Documentary",
  tone: "informative",
  length: "short",
  format: "script",
});
check("5.1  video create accepted (202 — the script job auto-starts)", res.status === 202 || res.status === 201, { status: res.status, error: res.json?.error });
const VIDEO_ID = res.json?.video?.id ?? res.json?.id ?? null;

let scriptDto = null;
if (VIDEO_ID) {
  const deadline = Date.now() + 420_000; // the storm-patient script job
  while (Date.now() < deadline) {
    const r = await call("GET", `/api/videos/${VIDEO_ID}`);
    const v = r.json?.video;
    if (v && (v.script || v.error)) { scriptDto = v; break; }
    await sleep(2000);
  }
  check("5.2  the script job completes (no 'AI Script + Metadata failed')", !!scriptDto?.script && !scriptDto.error, scriptDto?.error ?? (scriptDto?.script ? "" : "timeout"));
  if (scriptDto?.script) {
    const words = scriptDto.script.split(/\s+/).filter(Boolean).length;
    check("5.3  a real narration script landed (100+ words for a short)", words >= 100, words);
    check("5.4  the metadata landed too (description + tags)", (scriptDto.description ?? "").length > 0 && (scriptDto.tags ?? "").length > 0, `${(scriptDto.description ?? "").length}ch desc / ${(scriptDto.tags ?? "").length}ch tags`);
    check("5.5  wordCount recorded on the row", (scriptDto.wordCount ?? 0) >= 100, scriptDto.wordCount);
    check("5.6  status advanced past draft", scriptDto.status !== "draft", scriptDto.status);
  }
}

// ---- 6. cleanup ----
if (VIDEO_ID) {
  res = await call("DELETE", `/api/videos/${VIDEO_ID}`);
  check("6.1  the video leaves through its DELETE", res.status === 200 || res.status === 204, res.status);
}
res = await call("POST", "/api/account/delete", { confirm: "DELETE" });
check("6.2  the throwaway account deletes through the front door", res.status === 200 && res.json?.deleted === true, { status: res.status, error: res.json?.error });

const sweep = {
  users: await db.user.count(),
  orgs: await db.organization.count(),
  videos: await db.video.count(),
  s30users: await db.user.count({ where: { email: { contains: "s30-e2e-" } } }),
  orphans: await db.organization.findMany({ where: { memberships: { none: {} } }, select: { id: true } }),
};
check("6.3  user/org/video counts back to baseline", sweep.users === baseline.users && sweep.orgs === baseline.orgs && sweep.videos === baseline.videos, JSON.stringify({ baseline, sweep: { users: sweep.users, orgs: sweep.orgs, videos: sweep.videos } }));
check("6.4  zero s30 accounts remain", sweep.s30users === 0, sweep.s30users);
check("6.5  no orphan organizations", sweep.orphans.length === 0, sweep.orphans.map((o) => o.id).join(","));

await db.$disconnect();
console.log(failures === 0 ? "S30 ROUTE E2E: ALL PASS" : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
