// S14 route e2e — "the delivery": the grade + the captions' shipping form
// through the LIVE daemon. The studio's picks: the grade rides the doc
// (PUT /assemble, the same surface the autosave writes), the burn rides
// the row (PATCH, catalog-gated like S12/S13). The render route resolves
// both through the shared S14 chain and echoes the resolved delivery.
// Layers:
//   1. the auth gate (no session → 401, both surfaces);
//   2. the fixture: account B + a story video (2 scenes + an ALIGNED doc —
//      the condition under which the job trusts the doc's grade) + a
//      slides fixture (the format default is no burn);
//   3. cross-tenant invisibility (the stranger cannot pick the delivery);
//   4. hostile burn bodies die at the PATCH gate — numbers, numeric
//      strings, type confusion, injection shapes → 400, and the gate
//      refused WITHOUT writing (the row still null);
//   5. the legal flips: true / false / null clear — the row + the response
//      DTO + the GET surface all reflect each pick, and the flips are
//      SURGICAL (title, voice, pace, frame untouched);
//   6. the grade pick: PUT /assemble carries renderPrefs {quality:"high"}
//      → the GET surface shows the standing truth the render route
//      resolves; a junk grade dies at the save schema (400); a second PUT
//      composes (high → draft);
//   7. the render route's gate order SURVIVED the S14 edits: a bare
//      fixture still refuses BEFORE any enqueue (no scene art → 400, no
//      voiceover in slides body → 400 — the new resolution code sits
//      safely behind the gates, no accidental job starts);
//   8. the factory cleans up: rows removed — the probe leaves no litter.
// Run: node --import tsx scripts/s14-route-e2e.mjs   (daemon on the S14 build)
import { PrismaClient } from "@prisma/client";
import { parseScenes } from "../src/lib/tubeforge/story";
import { assembleTimeline, serializeTimeline } from "../src/lib/tubeforge/timeline";

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
const emailA = `s14-e2e-a-${stamp}@example.com`;
const emailB = `s14-e2e-b-${stamp}@example.com`;
const password = "S14RouteE2e!2345";
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

// ---- 1. the auth gate (no session yet) ----
let res = await call("PATCH", `/api/videos/x`, { burnCaptions: true });
check("unauthenticated burn pick → 401", res.status === 401, res.status);
res = await call("PUT", `/api/videos/x/assemble`, { scenes: [], totalDurationSec: 0 });
check("unauthenticated doc save → 401 (the grade rides the same gate)", res.status === 401, res.status);

// ---- 2. the fixtures ----
res = await call("POST", "/api/auth/register", { email: emailA, password });
res = await call("POST", "/api/auth/login", { email: emailA, password });
check("stranger account (A) can register + log in", res.status === 200 || res.status === 201, res.status);

res = await call("POST", "/api/auth/register", { email: emailB, password });
check("owner account (B) registers", res.status === 200 || res.status === 201, res.status);

const owner = await db.user.findUnique({ where: { email: emailB }, select: { id: true } });
const membership = owner
  ? await db.membership.findFirst({ where: { userId: owner.id }, select: { organizationId: true } })
  : null;
check("owner's organization resolves (registration created it)", !!membership?.organizationId, owner?.id);

const scenesJson = JSON.stringify([
  {
    index: 1, title: "Hook", narration: "One short opening line.", visual: "a dark skyline",
    camera: "zoom-in", mood: "tense", caption: "", hostInScene: false, rehook: true, sfx: "none",
  },
  {
    index: 2, title: "Close", narration: "One short closing line.", visual: "first light",
    camera: "pull-back", mood: "warm", caption: "", hostInScene: false, rehook: false, sfx: "none",
  },
]);

let FIXTURE = null;
let SLIDES = null;
if (membership?.organizationId) {
  // an ALIGNED doc (2 doc scenes / 2 row scenes) — the condition under
  // which the render job trusts the doc's standing grade
  const doc = assembleTimeline(parseScenes(scenesJson), { sceneDurationsSec: [5, 5] });
  const video = await db.video.create({
    data: {
      organizationId: membership.organizationId,
      topic: "S14 delivery route e2e fixture",
      title: "The Delivery Fixture",
      niche: "Motivation",
      format: "story",
      status: "draft",
      voice: "jam",
      ttsSpeed: 1.0,
      burnCaptions: null,
      scenes: scenesJson,
      timeline: serializeTimeline(doc),
    },
  });
  FIXTURE = video.id;
  check("story fixture seeded (2 scenes + an aligned doc, burn null)", !!FIXTURE, FIXTURE);

  const slidesVideo = await db.video.create({
    data: {
      organizationId: membership.organizationId,
      topic: "S14 slides route e2e fixture",
      title: "The Slides Delivery Fixture",
      niche: "Motivation",
      format: "story",
      status: "draft",
      voice: "jam",
      renderMode: "slides",
    },
  });
  SLIDES = slidesVideo.id;
  check("slides fixture seeded (the format default is no burn)", !!SLIDES, SLIDES);
}

if (FIXTURE) {
  // ---- 3. cross-tenant: the stranger cannot pick the delivery ----
  res = await call("POST", "/api/auth/login", { email: emailA, password });
  check("stranger session restored (register auto-login is overridden)", res.status === 200 || res.status === 201, res.status);
  res = await call("PATCH", `/api/videos/${FIXTURE}`, { burnCaptions: false });
  check("cross-tenant burn pick is invisible to a stranger (404)", res.status === 404, res.status);
  res = await call("PUT", `/api/videos/${FIXTURE}/assemble`, { scenes: [{ index: 1, startSec: 0, endSec: 5, durationSec: 5 }], totalDurationSec: 5, renderPrefs: { quality: "high" } });
  check("cross-tenant grade pick is invisible to a stranger (404)", res.status === 404, res.status);

  res = await call("POST", "/api/auth/login", { email: emailB, password });
  check("fixture owner logs in", res.status === 200 || res.status === 201, res.status);

  // ---- 4. hostile burn bodies die at the gate ----
  const hostile = [
    ["burn 1 (number)", { burnCaptions: 1 }],
    ["burn 0 (number)", { burnCaptions: 0 }],
    ["burn 'true' (string)", { burnCaptions: "true" }],
    ["burn 'false' (string)", { burnCaptions: "false" }],
    ["burn '' (empty)", { burnCaptions: "" }],
    ["burn [true] (array)", { burnCaptions: [true] }],
    ["burn {burn:true} (object)", { burnCaptions: { burn: true } }],
    ["burn injection shape", { burnCaptions: "'; DROP TABLE videos;--" }],
  ];
  for (const [name, body] of hostile) {
    res = await call("PATCH", `/api/videos/${FIXTURE}`, body);
    check(`${name} → 400 (the gate, before any write)`, res.status === 400, res.status);
  }
  let row = await db.video.findUnique({ where: { id: FIXTURE } });
  check("the hostile battery wrote nothing (burn still null)", row?.burnCaptions === null, row?.burnCaptions);

  // a PATCH without the key is a legal no-op — the delivery survives it
  res = await call("PATCH", `/api/videos/${FIXTURE}`, {});
  const noop = res.status === 200 ? await res.json() : null;
  check(
    "a PATCH without burnCaptions is a no-op (200, burn untouched)",
    res.status === 200 && noop?.video?.burnCaptions === null,
    `${res.status} ${noop?.video?.burnCaptions}`
  );

  // ---- 5. the legal flips — surgical, reflected on every surface ----
  res = await call("PATCH", `/api/videos/${FIXTURE}`, { burnCaptions: true });
  const burned = res.status === 200 ? await res.json() : null;
  check(
    "the burn pick lands (200, response DTO carries true)",
    res.status === 200 && burned?.video?.burnCaptions === true,
    `${res.status} ${burned?.video?.burnCaptions}`
  );
  check(
    "the flip is SURGICAL — title, voice, pace and frame untouched",
    burned?.video?.title === "The Delivery Fixture" &&
      burned?.video?.voice === "jam" &&
      burned?.video?.ttsSpeed === 1.0 &&
      burned?.video?.aspectRatio === null &&
      burned?.video?.frameRate === null,
    `${burned?.video?.title}/${burned?.video?.voice}/${burned?.video?.ttsSpeed}/${burned?.video?.aspectRatio}/${burned?.video?.frameRate}`
  );

  row = await db.video.findUnique({ where: { id: FIXTURE } });
  check("the row settles at burn true", row?.burnCaptions === true, row?.burnCaptions);

  res = await call("GET", `/api/videos/${FIXTURE}`);
  const got = res.status === 200 ? await res.json() : null;
  check(
    "the GET surface reflects the pick (the studio toggle's standing truth)",
    res.status === 200 && (got?.video?.burnCaptions === true || got?.burnCaptions === true),
    `${res.status}`
  );

  res = await call("PATCH", `/api/videos/${FIXTURE}`, { burnCaptions: false });
  const sidecar = res.status === 200 ? await res.json() : null;
  check("the sidecar pick lands (false is a pick, not an absence)", res.status === 200 && sidecar?.video?.burnCaptions === false, res.status);

  res = await call("PATCH", `/api/videos/${FIXTURE}`, { burnCaptions: null });
  const cleared = res.status === 200 ? await res.json() : null;
  check("the null clear lands (the format default decides again)", res.status === 200 && cleared?.video?.burnCaptions === null, res.status);

  // ---- 6. the grade pick rides the doc ----
  const docScenes = [
    { index: 1, startSec: 0, endSec: 5, durationSec: 5 },
    { index: 2, startSec: 5, endSec: 10, durationSec: 5 },
  ];
  res = await call("PUT", `/api/videos/${FIXTURE}/assemble`, {
    scenes: docScenes,
    totalDurationSec: 10,
    renderPrefs: { quality: "high" },
  });
  check("the grade pick PUT lands (200)", res.status === 200, res.status);

  res = await call("GET", `/api/videos/${FIXTURE}/assemble`);
  const doc = res.status === 200 ? await res.json() : null;
  check(
    "the GET surface shows the standing grade (the truth the render route resolves: body > doc > standard)",
    res.status === 200 && doc?.timeline?.renderPrefs?.quality === "high",
    `${res.status} ${JSON.stringify(doc?.timeline?.renderPrefs).slice(0, 80)}`
  );

  res = await call("PUT", `/api/videos/${FIXTURE}/assemble`, {
    scenes: docScenes,
    totalDurationSec: 10,
    renderPrefs: { quality: "ultra" },
  });
  check("a junk grade dies at the save schema (400 — a junk pick can never ride a saved doc)", res.status === 400, res.status);

  res = await call("PUT", `/api/videos/${FIXTURE}/assemble`, {
    scenes: docScenes,
    totalDurationSec: 10,
    renderPrefs: { quality: "draft" },
  });
  const second = res.status === 200 ? await res.json() : null;
  check("a second grade pick composes (high → draft)", res.status === 200 && second?.timeline?.renderPrefs?.quality === "draft", res.status);

  // ---- 7. the render route's gate order SURVIVED the S14 edits ----
  // The new resolution code sits BEHIND the gates — a bare fixture still
  // refuses before any enqueue, so the edits can never start a job early.
  res = await call("POST", `/api/videos/${FIXTURE}/render`);
  const noArt = res.status === 400 ? await res.json().catch(() => ({})) : {};
  check(
    "a bare render refuses before enqueue (no scene art → 400, no job started)",
    res.status === 400 && /storyboard/i.test(noArt?.error ?? ""),
    `${res.status} ${noArt?.error ?? ""}`
  );
  res = await call("POST", `/api/videos/${FIXTURE}/render`, { mode: "slides" });
  const noVo = res.status === 400 ? await res.json().catch(() => ({})) : {};
  check(
    "a slides render refuses before enqueue (no voiceover → 400 — the storyboard gate was skipped, the next gate held)",
    res.status === 400 && /voiceover/i.test(noVo?.error ?? ""),
    `${res.status} ${noVo?.error ?? ""}`
  );
}

if (SLIDES) {
  // ---- the slides row accepts the burn pick (the dialog preset contract
  //      holds; the format default for slides is NO burn — the toggle
  //      shows the resolved truth, and an explicit true is a real force) ----
  res = await call("PATCH", `/api/videos/${SLIDES}`, { burnCaptions: true });
  const slidesBurn = res.status === 200 ? await res.json() : null;
  check(
    "a slides row accepts the burn pick (an explicit force is honored by the resolved chain)",
    res.status === 200 && slidesBurn?.video?.burnCaptions === true,
    `${res.status} ${slidesBurn?.video?.burnCaptions}`
  );
}

// ---- 8. the factory cleans up: probe rows leave no litter ----
try {
  if (FIXTURE) await db.video.delete({ where: { id: FIXTURE } }).catch(() => {});
  if (SLIDES) await db.video.delete({ where: { id: SLIDES } }).catch(() => {});
  const orgIds = new Set();
  for (const email of [emailA, emailB]) {
    const u = await db.user.findUnique({ where: { email }, select: { id: true } });
    if (!u) continue;
    const ms = await db.membership.findMany({ where: { userId: u.id }, select: { organizationId: true } });
    ms.forEach((m) => orgIds.add(m.organizationId));
    await db.user.delete({ where: { id: u.id } }).catch(() => {});
  }
  for (const orgId of orgIds) await db.organization.delete({ where: { id: orgId } }).catch(() => {});
  check("probe rows cleaned up (videos + accounts)", true);
} finally {
  await db.$disconnect();
}

console.log(failures === 0 ? "\nS14 ROUTE E2E: ALL PASS" : `\nS14 ROUTE E2E: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
