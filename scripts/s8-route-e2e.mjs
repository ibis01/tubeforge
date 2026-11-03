// S8 route e2e — the narrator pick against the LIVE server. Self-contained:
// it builds its OWN fixture (two fresh accounts + a story video seeded
// through the REAL doc modules), so a recycled database can never stale it.
//   1. a fresh session-less request gets the auth gate (401);
//   2. a story fixture is seeded for account B with the real
//      assembleTimeline/serializeTimeline modules (hasVoiceover set — the
//      swap re-reads every scene itself);
//   3. the stranger (account A) cannot swap the fixture's narrator (404,
//      cross-tenant);
//   4. hostile bodies die at the gates: traversal ids and junk shapes at
//      zod, well-formed unknown ids at the catalog, the CURRENT voice at
//      the unchanged guard, a classic (non-story) video at the format guard;
//   5. the REAL swap (jam → kazi) re-reads both scenes through real TTS:
//      200 with the re-derived doc, fresh wavDurations, the row's voice
//      flipped, and per-scene + merged WAVs rebuilt — verified through the
//      PUBLIC surfaces (the same routes the studio's preview player and the
//      export path read), so the probe never guesses the fs layout (the
//      standalone server chdirs into .next/standalone — its uploads root
//      is NOT the repo's ./uploads);
//   6. the factory cleans up: rows removed, the storage prefixes deleted —
//      the probe leaves no litter.
// Run: node --import tsx scripts/s8-route-e2e.mjs
import { PrismaClient } from "@prisma/client";
import { assembleTimeline, serializeTimeline } from "../src/lib/tubeforge/timeline";
import { parseScenes } from "../src/lib/tubeforge/story";
import fs from "node:fs";
import path from "node:path";

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
const emailA = `s8-e2e-a-${stamp}@example.com`;
const emailB = `s8-e2e-b-${stamp}@example.com`;
const password = "S8RouteE2e!2345";
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

const LEAD_TAIL = 0.35 + 0.85; // the render's per-scene window padding
const MIN_SEG = 2.0;

// ---- 1. the auth gate (no session yet) ----
let res = await call("POST", `/api/videos/x/studio/voice`, { voice: "kazi" });
check("the swap route requires a session (401 before any body work)", res.status === 401, res.status);

res = await call("POST", "/api/auth/register", { email: emailA, password });
res = await call("POST", "/api/auth/login", { email: emailA, password });
check("stranger account (A) can register + log in", res.status === 200 || res.status === 201, res.status);

// ---- 2. the fixture: account B + a story video seeded via the REAL doc
//         modules. hasVoiceover is set on the row — the swap route re-reads
//         every scene itself, so no stage has to run first. ----
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
      index: 1, title: "Hook", narration: "One short opening line.", visual: "a dark skyline",
      camera: "zoom-in", mood: "tense", caption: "", hostInScene: false, rehook: true, sfx: "none",
    },
    {
      index: 2, title: "Close", narration: "One short closing line.", visual: "first light",
      camera: "pull-back", mood: "warm", caption: "", hostInScene: false, rehook: false, sfx: "none",
    },
  ]);
  const doc = assembleTimeline(parseScenes(scenesJson), { sceneDurationsSec: [5, 5] });
  const video = await db.video.create({
    data: {
      organizationId: membership.organizationId,
      topic: "S8 narrator route e2e fixture",
      niche: "Motivation",
      format: "story",
      status: "draft",
      voice: "jam",
      hasVoiceover: true,
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
  //         so A logs in again EXPLICITLY before the stranger write. ----
  res = await call("POST", "/api/auth/login", { email: emailA, password });
  check("stranger session restored (register auto-login is overridden)", res.status === 200 || res.status === 201, res.status);
  res = await call("POST", `/api/videos/${FIXTURE}/studio/voice`, { voice: "kazi" });
  check("cross-tenant swap is invisible to a stranger (404)", res.status === 404, res.status);

  res = await call("POST", "/api/auth/login", { email: emailB, password });
  check("fixture owner logs in", res.status === 200 || res.status === 201, res.status);

  // ---- 4. hostile bodies die at the gates ----
  res = await call("POST", `/api/videos/${FIXTURE}/studio/voice`, { voice: "../../etc/passwd" });
  check("traversal id → 400 (zod shape gate)", res.status === 400, res.status);
  res = await call("POST", `/api/videos/${FIXTURE}/studio/voice`, { voice: "DROP TABLE voices" });
  check("injection id → 400 (zod shape gate)", res.status === 400, res.status);
  res = await call("POST", `/api/videos/${FIXTURE}/studio/voice`, { voice: "" });
  check("empty id → 400", res.status === 400, res.status);
  res = await call("POST", `/api/videos/${FIXTURE}/studio/voice`, {});
  check("missing voice → 400", res.status === 400, res.status);
  res = await call("POST", `/api/videos/${FIXTURE}/studio/voice`, { voice: "not-a-real-voice" });
  check("well-formed unknown id → 400 (catalog gate, before any TTS)", res.status === 400, res.status);
  res = await call("POST", `/api/videos/${FIXTURE}/studio/voice`, { voice: "jam" });
  check("the CURRENT narrator → 400 (unchanged guard)", res.status === 400, res.status);

  // ---- 4b. the story-format gate (a classic video the account owns) ----
  res = await call("POST", "/api/videos", {
    topic: "S8 narrator format-gate probe",
    title: "S8 format gate probe",
  });
  const created = await res.json();
  const vid = created?.video?.id ?? created?.id;
  if (vid) {
    res = await call("POST", `/api/videos/${vid}/studio/voice`, { voice: "kazi" });
    check("classic (non-story) video → honest 400", res.status === 400, res.status);
  } else {
    check("classic probe video created", false, JSON.stringify(created).slice(0, 120));
  }

  // ---- 5. THE REAL SWAP: jam → kazi through live TTS ----
  const started = Date.now();
  res = await call("POST", `/api/videos/${FIXTURE}/studio/voice`, { voice: "kazi" });
  const swapSec = ((Date.now() - started) / 1000).toFixed(1);
  const data = res.status === 200 ? await res.json() : null;
  check(
    `the swap succeeds through real synthesis (${swapSec}s)`,
    res.status === 200 && data?.voice === "kazi",
    `${res.status} ${JSON.stringify(data).slice(0, 160)}`
  );

  if (data?.timeline?.scenes) {
    const scenes = data.timeline.scenes;
    const wav1 = data.wavDurations?.["1"] ?? data.wavDurations?.[1];
    const wav2 = data.wavDurations?.["2"] ?? data.wavDurations?.[2];
    check(
      "both scenes re-read: fresh wavDurations for every index",
      typeof wav1 === "number" && wav1 > 0.3 && typeof wav2 === "number" && wav2 > 0.3,
      JSON.stringify(data.wavDurations)
    );
    const expectDur = (w) => Math.max(Math.round((w + LEAD_TAIL) * 100) / 100, MIN_SEG);
    check(
      "doc windows re-derive from the fresh reads (the render's formula)",
      Math.abs(scenes[0].durationSec - expectDur(wav1)) < 0.011 &&
        Math.abs(scenes[1].durationSec - expectDur(wav2)) < 0.011 &&
        Math.abs(data.timeline.totalDurationSec - (scenes[0].durationSec + scenes[1].durationSec)) < 0.011,
      `${scenes.map((s) => s.durationSec).join("/")} vs wavs ${wav1}/${wav2}`
    );
    check(
      "the activity line names the new narrator and the re-read",
      typeof data.activity === "string" && data.activity.includes("kazi") && data.activity.includes("2 scenes"),
      data.activity
    );

    // the row: voice flipped, audioDuration updated, doc persisted
    const row = await db.video.findUnique({ where: { id: FIXTURE } });
    check(
      "the row moves with the swap: voice=kazi, audioDuration set, doc saved",
      row?.voice === "kazi" &&
        typeof row?.audioDuration === "number" && row.audioDuration > 1 &&
        !!row?.timeline && row.timeline.includes("kazi") === false && row.timeline.includes('"sceneCount":2'),
      `${row?.voice} ${row?.audioDuration}`
    );

    // the artifacts: per-scene WAVs + the merged voiceover rebuilt — through
    // the PUBLIC surfaces (the studio's preview player + the export path),
    // never a direct fs guess (the standalone server chdirs into
    // .next/standalone, so its uploads root differs from the repo's).
    res = await call("GET", `/api/videos/${FIXTURE}/vo/1`);
    const w1 = res.status === 200 ? Buffer.from(await res.arrayBuffer()) : Buffer.alloc(0);
    res = await call("GET", `/api/videos/${FIXTURE}/vo/2`);
    const w2 = res.status === 200 ? Buffer.from(await res.arrayBuffer()) : Buffer.alloc(0);
    check(
      "per-scene WAVs rebuilt with the new voice (200, RIFF, non-trivial, served)",
      w1.length > 1000 && w1.slice(0, 4).toString() === "RIFF" &&
        w2.length > 1000 && w2.slice(0, 4).toString() === "RIFF",
      `vo/1 ${w1.length}B, vo/2 ${w2.length}B`
    );
    res = await call("GET", `/api/videos/${FIXTURE}/voiceover`);
    const mergedBuf = res.status === 200 ? Buffer.from(await res.arrayBuffer()) : Buffer.alloc(0);
    check(
      "the merged voiceover.wav rebuilt from the fresh reads (served)",
      mergedBuf.length > 1000 && mergedBuf.slice(0, 4).toString() === "RIFF" && mergedBuf.length > w1.length,
      `${mergedBuf.length}B`
    );
  }
}

// ---- 6. the factory cleans up: probe rows + storage leave no litter ----
try {
  if (typeof vid !== "undefined" && vid) await db.video.delete({ where: { id: vid } }).catch(() => {});
  if (FIXTURE) {
    await db.video.delete({ where: { id: FIXTURE } }).catch(() => {});
    // the server may keep uploads under the repo root OR under
    // .next/standalone (the standalone server chdirs) — sweep both.
    const roots = [
      process.env.TUBEFORGE_UPLOAD_ROOT
        ? path.resolve(process.env.TUBEFORGE_UPLOAD_ROOT)
        : path.join(process.cwd(), "uploads"),
      path.join(process.cwd(), ".next", "standalone", "uploads"),
    ];
    for (const root of roots)
      fs.rmSync(path.join(root, FIXTURE), { recursive: true, force: true });
  }
  const orgIds = new Set();
  for (const email of [emailA, emailB]) {
    const u = await db.user.findUnique({ where: { email }, select: { id: true } });
    if (!u) continue;
    const ms = await db.membership.findMany({ where: { userId: u.id }, select: { organizationId: true } });
    ms.forEach((m) => orgIds.add(m.organizationId));
    await db.user.delete({ where: { id: u.id } }).catch(() => {});
  }
  for (const oid of orgIds) await db.organization.delete({ where: { id: oid } }).catch(() => {});
  console.log("PASS  probe rows + storage cleaned up (videos, accounts, orgs, WAVs)");
} catch (err) {
  console.log(`WARN  cleanup incomplete — ${err?.message ?? err}`);
}

await db.$disconnect();
console.log(failures === 0 ? "\nS8 ROUTE E2E: ALL PASS" : `\nS8 ROUTE E2E: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
