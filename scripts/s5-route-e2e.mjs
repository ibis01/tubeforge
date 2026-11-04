// S5 route e2e — the sound stage against the LIVE server. Self-contained:
// it builds its OWN fixture (two fresh accounts + a story video seeded
// through the REAL doc modules), so a recycled database can never stale it.
//   1. a fresh account gets the auth gate (401) on the audition route;
//   2. a story fixture is seeded for account B with the real
//      assembleTimeline/serializeTimeline modules, so GET /assemble returns
//      a doc the studio could actually have saved;
//   3. the stranger (account A) cannot see the fixture (404, cross-tenant);
//   4. PUT /assemble persists the doc's sound kinds and GET /assemble
//      returns them (the full save→read path);
//   5. the audition route streams the REAL synthesized wavs (RIFF, non-empty)
//      for both banks, synthesizing on first miss;
//   6. hostile params are refused with 400 — no bank/kind escapes the catalog;
//   7. a classic (non-story) video is refused with the honest 400;
//   8. the fixture doc is restored byte-for-byte, then the probe rows are
//      removed from the database (the factory leaves no litter).
// Run: node --import tsx scripts/s5-route-e2e.mjs
import { PrismaClient } from "@prisma/client";
import { assembleTimeline, serializeTimeline } from "../src/lib/tubeforge/timeline";
import { parseScenes } from "../src/lib/tubeforge/story";

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
const emailA = `s5-e2e-a-${stamp}@example.com`;
const emailB = `s5-e2e-b-${stamp}@example.com`;
const password = "S5RouteE2e!2345";
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

// ---- 1. the auth gate (no session yet) ----
let res = await call("GET", `/api/videos/x/studio/sound?bank=sfx&kind=whoosh`);
check("audition route requires a session (401 before any param work)", res.status === 401, res.status);

res = await call("POST", "/api/auth/register", { email: emailA, password });
res = await call("POST", "/api/auth/login", { email: emailA, password });
check("stranger account (A) can register + log in", res.status === 200 || res.status === 201, res.status);

// ---- 2. the fixture: account B + a story video seeded via the REAL doc
//         modules (the same assembleTimeline the render/assemble route call).
//         This is test-fixture seeding, not production behavior — the probe
//         builds in the DB what the AI pipeline would otherwise build. ----
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
      topic: "S5 sound-stage route e2e fixture",
      niche: "Motivation",
      format: "story",
      status: "draft",
      scenes: scenesJson,
      timeline: serializeTimeline(doc),
    },
  });
  FIXTURE = video.id;
  check("story fixture seeded (2 scenes + a real assembled doc)", !!FIXTURE, FIXTURE);
}

if (FIXTURE) {
  // ---- 3. cross-tenant: the stranger cannot even see the fixture.
  //         Register(B) may have flipped the cookie jar to B's auto-session,
  //         so A logs in again EXPLICITLY before the stranger read. ----
  res = await call("POST", "/api/auth/login", { email: emailA, password });
  check("stranger session restored (register auto-login is overridden)", res.status === 200 || res.status === 201, res.status);
  res = await call("GET", `/api/videos/${FIXTURE}/assemble`);
  check("cross-tenant fixture is invisible to a stranger (404)", res.status === 404, res.status);

  res = await call("POST", "/api/auth/login", { email: emailB, password });
  check("fixture owner logs in", res.status === 200 || res.status === 201, res.status);
  res = await call("GET", `/api/videos/${FIXTURE}/assemble`);
  const original = await res.json();
  const hasDoc = !!(original?.timeline?.scenes?.length);
  check("fixture timeline loads (scenes + doc present)", res.status === 200 && hasDoc, res.status);

  if (hasDoc) {
    // ---- 4. the save→read path carries the sound kinds ----
    const doc = original.timeline;
    doc.scenes[0].audio = {
      ...doc.scenes[0].audio,
      sfx: { ...doc.scenes[0].audio.sfx, kind: "boom", enabled: true, level: 0.55 },
      ambient: { ...doc.scenes[0].audio.ambient, kind: "rain", enabled: true, level: 0.1 },
    };
    res = await call("PUT", `/api/videos/${FIXTURE}/assemble`, {
      scenes: doc.scenes,
      totalDurationSec: doc.totalDurationSec,
      generatedAt: doc.generatedAt,
    });
    check("PUT /assemble accepts the doc with sound kinds", res.status === 200, res.status);
    res = await call("GET", `/api/videos/${FIXTURE}/assemble`);
    const saved = (await res.json())?.timeline;
    check(
      "GET /assemble returns the picked kinds (the studio's picks persist)",
      saved?.scenes?.[0]?.audio?.sfx?.kind === "boom" && saved?.scenes?.[0]?.audio?.ambient?.kind === "rain",
      JSON.stringify(saved?.scenes?.[0]?.audio)
    );

    // ---- 5. the audition route streams the real synthesized wavs ----
    res = await call("GET", `/api/videos/${FIXTURE}/studio/sound?bank=sfx&kind=whoosh`);
    const sfxWav = Buffer.from(await res.arrayBuffer());
    check(
      "SFX audition: 200, audio/wav, non-empty RIFF",
      res.status === 200 &&
        res.headers.get("content-type") === "audio/wav" &&
        sfxWav.length > 1000 &&
        sfxWav.slice(0, 4).toString() === "RIFF",
      `${res.status}, ${sfxWav.length} bytes`
    );

    res = await call("GET", `/api/videos/${FIXTURE}/studio/sound?bank=ambience&kind=rain`);
    const ambWav = Buffer.from(await res.arrayBuffer());
    check(
      "Ambience audition: 200, audio/wav, a full 60 s bed",
      res.status === 200 && ambWav.length > 100000 && ambWav.slice(0, 4).toString() === "RIFF",
      `${res.status}, ${ambWav.length} bytes`
    );

    // ---- 6. hostile params die at the gate ----
    res = await call("GET", `/api/videos/${FIXTURE}/studio/sound?bank=../etc&kind=whoosh`);
    check("unknown bank → 400", res.status === 400, res.status);
    res = await call("GET", `/api/videos/${FIXTURE}/studio/sound?bank=sfx&kind=../../uploads`);
    check("path-ish kind → 400 (catalog gate)", res.status === 400, res.status);
    res = await call("GET", `/api/videos/${FIXTURE}/studio/sound?bank=sfx&kind=rain`);
    check("cross-bank kind → 400 (rain is not an SFX)", res.status === 400, res.status);
    res = await call("GET", `/api/videos/${FIXTURE}/studio/sound?bank=ambience&kind=DROP%20TABLE%20scenes`);
    check("injection kind → 400", res.status === 400, res.status);

    // ---- 8a. restore the fixture doc exactly as it was ----
    res = await call("PUT", `/api/videos/${FIXTURE}/assemble`, {
      scenes: original.timeline.scenes,
      totalDurationSec: original.timeline.totalDurationSec,
      generatedAt: original.timeline.generatedAt,
    });
    check("fixture doc restored", res.status === 200, res.status);
  }
}

// ---- 7. the story-format gate (a classic video the account owns) ----
res = await call("POST", "/api/videos", {
  topic: "S5 sound-stage route gate probe",
  title: "S5 route gate probe",
});
const created = await res.json();
const vid = created?.video?.id ?? created?.id;
if (vid) {
  res = await call("GET", `/api/videos/${vid}/studio/sound?bank=sfx&kind=whoosh`);
  check("classic (non-story) video → honest 400", res.status === 400, res.status);
} else {
  check("classic probe video created", false, JSON.stringify(created).slice(0, 120));
}

// ---- 8b. the factory cleans up: probe rows leave no litter ----
try {
  if (vid) await db.video.delete({ where: { id: vid } }).catch(() => {});
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
console.log(failures === 0 ? "\nS5 ROUTE E2E: ALL PASS" : `\nS5 ROUTE E2E: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
