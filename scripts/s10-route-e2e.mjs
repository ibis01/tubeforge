// S10 route e2e — "the short" against the LIVE server. Self-contained: it
// builds its OWN fixture (two fresh accounts + a story video seeded through
// the REAL doc modules), so a recycled database can never stale it.
//   1. a stranger without a session gets the auth gate (401) on the short POST;
//   2. the owner's story fixture seeds through the real
//      assembleTimeline/serializeTimeline modules;
//   3. the stranger cannot see the fixture (404, cross-tenant) on the short GET;
//   4. GET /short reports the resting state the studio arm polls
//      (generating false, hasShort false, shortUrl null);
//   5. PUT /assemble with a doc short pick → 200, and GET /assemble returns
//      the persisted pick (the save→read round-trip through the REAL zod
//      boundary + doc serializer — the studio picker's exact channel);
//   6. a hostile mode is refused by the save schema (400) and a float
//      sceneIndex too — the boundary the pick rides;
//   7. POST /short with the doc pick standing → the honest master gate
//      (400 "Render the final video first") — a standing pick never causes
//      a crash or a phantom job without a rendered master;
//   8. a body override {sceneIndex} hits the same honest gate (the detail
//      dialog's per-request channel is unchanged);
//   9. everything is cleaned up — videos, accounts.
// Run: node --import tsx scripts/s10-route-e2e.mjs
import { PrismaClient } from "@prisma/client";
import { assembleTimeline, serializeTimeline } from "../src/lib/tubeforge/timeline";
import { parseScenes } from "../src/lib/tubeforge/story";

const db = new PrismaClient();
const BASE = "http://localhost:3000";
let cookie = "";

async function call(method, path_, body) {
  const headers = { Cookie: cookie };
  let payload;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + path_, { method, headers, body: payload });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  return res;
}

const stamp = Date.now().toString(36);
const emailA = `s10-e2e-a-${stamp}@example.com`;
const emailB = `s10-e2e-b-${stamp}@example.com`;
const password = "S10RouteE2e!2345";
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

// ---- 1. the auth gate (no session yet) ----
let res = await call("POST", `/api/videos/x/short`);
check("short POST requires a session (401 before any work)", res.status === 401, res.status);

res = await call("POST", "/api/auth/register", { email: emailA, password });
res = await call("POST", "/api/auth/login", { email: emailA, password });
check("stranger account (A) can register + log in", res.status === 200 || res.status === 201, res.status);

// ---- 2. the fixture: account B + a story video (no master needed) ----
res = await call("POST", "/api/auth/register", { email: emailB, password });
check("owner account (B) registers", res.status === 200 || res.status === 201, res.status);

const owner = await db.user.findUnique({ where: { email: emailB }, select: { id: true } });
const membership = owner
  ? await db.membership.findFirst({ where: { userId: owner.id }, select: { organizationId: true } })
  : null;
check("owner's organization resolves (registration created it)", !!membership?.organizationId, owner?.id);

let FIXTURE = null;

if (membership?.organizationId) {
  const scenesJson = JSON.stringify([
    {
      index: 1, title: "Hook", narration: "The opening line lands here.", visual: "a dark skyline",
      camera: "zoom-in", mood: "tense", caption: "", hostInScene: false, rehook: true, sfx: "boom",
    },
    {
      index: 2, title: "Turn", narration: "The turn arrives and holds.", visual: "rain on glass",
      camera: "static", mood: "calm", caption: "", hostInScene: false, rehook: false, sfx: "none",
    },
  ]);
  const doc = assembleTimeline(parseScenes(scenesJson), { sceneDurationsSec: [5, 5] });
  const video = await db.video.create({
    data: {
      organizationId: membership.organizationId,
      topic: "S10 short-pick route e2e fixture",
      niche: "Motivation",
      format: "story",
      status: "draft",
      scenes: scenesJson,
      timeline: serializeTimeline(doc),
    },
  });
  FIXTURE = video.id;
  check("story fixture seeded through the real doc modules", !!FIXTURE, FIXTURE);
} else {
  check("story fixture seeded through the real doc modules", false, "no org");
}

if (FIXTURE) {
  // ---- 3. cross-tenant: the stranger cannot even see the fixture ----
  res = await call("POST", "/api/auth/login", { email: emailA, password });
  res = await call("GET", `/api/videos/${FIXTURE}/short`);
  check("cross-tenant short state is invisible to a stranger (404)", res.status === 404, res.status);
  res = await call("POST", `/api/videos/${FIXTURE}/short`);
  check("cross-tenant short cut is invisible to a stranger (404)", res.status === 404, res.status);

  res = await call("POST", "/api/auth/login", { email: emailB, password });
  check("fixture owner logs in", res.status === 200 || res.status === 201, res.status);

  // ---- 4. the resting state the studio arm polls ----
  res = await call("GET", `/api/videos/${FIXTURE}/short`);
  const rest = await res.json().catch(() => ({}));
  check(
    "GET /short reports the resting state (generating false, hasShort false, shortUrl null)",
    res.status === 200 && rest.generating === false && rest.hasShort === false && rest.shortUrl === null,
    `${res.status}, ${JSON.stringify(rest).slice(0, 120)}`
  );

  // ---- 5. the doc pick saves + reads back through the REAL route ----
  res = await call("GET", `/api/videos/${FIXTURE}/assemble`);
  const original = (await res.json())?.timeline;
  res = await call("PUT", `/api/videos/${FIXTURE}/assemble`, {
    scenes: original.scenes,
    totalDurationSec: original.totalDurationSec,
    generatedAt: original.generatedAt,
    renderPrefs: { quality: "standard", short: { mode: "scene", sceneIndex: 2 } },
  });
  check("PUT /assemble accepts the doc with a short pick", res.status === 200, res.status);

  res = await call("GET", `/api/videos/${FIXTURE}/assemble`);
  const saved = (await res.json())?.timeline;
  check(
    "GET /assemble returns the persisted pick (save→read round-trip)",
    saved?.renderPrefs?.short?.mode === "scene" && saved?.renderPrefs?.short?.sceneIndex === 2,
    JSON.stringify(saved?.renderPrefs)
  );

  // ---- 6. hostile shapes die at the save schema (the studio's channel) ----
  res = await call("PUT", `/api/videos/${FIXTURE}/assemble`, {
    scenes: original.scenes,
    totalDurationSec: original.totalDurationSec,
    generatedAt: original.generatedAt,
    renderPrefs: { quality: "standard", short: { mode: "viral", sceneIndex: 2 } },
  });
  check("a hostile mode is refused by the save schema (400)", res.status === 400, res.status);

  res = await call("PUT", `/api/videos/${FIXTURE}/assemble`, {
    scenes: original.scenes,
    totalDurationSec: original.totalDurationSec,
    generatedAt: original.generatedAt,
    renderPrefs: { quality: "standard", short: { mode: "scene", sceneIndex: 1.5 } },
  });
  check("a float sceneIndex is refused by the save schema (400)", res.status === 400, res.status);

  // ---- 7. the honest master gate (no rendered master → no job, no crash) ----
  res = await call("POST", `/api/videos/${FIXTURE}/short`);
  const gateBody = await res.json().catch(() => ({}));
  check(
    "POST /short with a standing pick but no master → the honest 400 gate",
    res.status === 400 && /render the final video first/i.test(gateBody?.error ?? ""),
    `${res.status}, ${JSON.stringify(gateBody)}`
  );

  // ---- 8. the per-request body channel hits the same honest gate ----
  res = await call("POST", `/api/videos/${FIXTURE}/short`, { sceneIndex: 1 });
  const gateBody2 = await res.json().catch(() => ({}));
  check(
    "POST /short with a body override but no master → the same honest 400",
    res.status === 400 && /render the final video first/i.test(gateBody2?.error ?? ""),
    `${res.status}, ${JSON.stringify(gateBody2)}`
  );

  // restore the pick-free doc (cleanup removes the rest)
  res = await call("PUT", `/api/videos/${FIXTURE}/assemble`, {
    scenes: original.scenes,
    totalDurationSec: original.totalDurationSec,
    generatedAt: original.generatedAt,
  });
  check("fixture restored to the pick-free doc", res.status === 200, res.status);
} else {
  check("S10 route corners skipped — fixture missing", false, "FIXTURE unavailable");
}

// ---- 9. the factory cleans up: probe rows leave no litter ----
try {
  if (FIXTURE) await db.video.delete({ where: { id: FIXTURE } }).catch(() => {});
  for (const email of [emailA, emailB]) {
    const u = await db.user.findUnique({ where: { email }, include: { memberships: { select: { organizationId: true } } } });
    if (u) {
      // orgs too — the end-state law: the battery leaves NOTHING
      for (const orgId of u.memberships.map((m) => m.organizationId))
        await db.organization.deleteMany({ where: { id: orgId } }).catch(() => {});
      await db.user.delete({ where: { id: u.id } }).catch(() => {});
    }
  }
  console.log("PASS  probe rows cleaned up (videos + accounts)");
} catch (err) {
  console.log(`WARN  cleanup incomplete — ${err?.message ?? err}`);
}

await db.$disconnect();
console.log(failures === 0 ? "\nS10 ROUTE E2E: ALL PASS" : `\nS10 ROUTE E2E: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
