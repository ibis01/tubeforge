// S11 route e2e — "the pace": the studio's pacing control through the LIVE
// daemon. Layers:
//   1. the auth gate (no session → 401);
//   2. the fixture: account B + a story video seeded via the REAL doc
//      modules (hasVoiceover set on the row — the pace route re-reads every
//      scene itself, so no stage has to run first);
//   3. cross-tenant invisibility (the stranger cannot even see the video);
//   4. hostile bodies die at the gates — the zod shape gate (missing /
//      junk / out-of-range speeds), the unchanged-pace guard, plus the
//      custom-audio, no-voiceover and classic-format guards on rows the
//      account owns;
//   5. the pace AUDITION surface: the voices preview route accepts a speed
//      and synthesizes the narrator at that tempo (200 + real audio);
//   6. the REAL pace change (1.0 → 1.3) re-reads both scenes through real
//      TTS: 200 with the re-derived doc, fresh wavDurations, the row's
//      ttsSpeed flipped, and per-scene + merged WAVs rebuilt — verified
//      through the PUBLIC surfaces (the same routes the studio's preview
//      player and the export path read), so the probe never guesses the fs
//      layout;
//   7. the TEMPO TELL: a second change (1.3 → 0.7) yields strictly LONGER
//      reads than the 1.3× pass — the pace genuinely reached the synth;
//   8. the factory cleans up: rows removed, the storage prefixes deleted —
//      the probe leaves no litter.
// Run: node --import tsx scripts/s11-route-e2e.mjs
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
const emailA = `s11-e2e-a-${stamp}@example.com`;
const emailB = `s11-e2e-b-${stamp}@example.com`;
const password = "S11RouteE2e!2345";
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

const LEAD_TAIL = 0.35 + 0.85; // the render's per-scene window padding
const MIN_SEG = 2.0;

// ---- 1. the auth gate (no session yet) ----
let res = await call("POST", `/api/videos/x/studio/pace`, { speed: 1.3 });
check("unauthenticated pace change → 401", res.status === 401, res.status);

// ---- 2. the fixture: account B + a story video seeded via the REAL doc
//         modules. hasVoiceover is set on the row — the pace route re-reads
//         every scene itself, so no stage has to run first. ----
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

let FIXTURE = null;
let CUSTOM_ROW = null;
let NOVO_ROW = null;
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
      topic: "S11 pace route e2e fixture",
      niche: "Motivation",
      format: "story",
      status: "draft",
      voice: "jam",
      ttsSpeed: 1.0,
      hasVoiceover: true,
      scenes: scenesJson,
      timeline: serializeTimeline(doc),
    },
  });
  FIXTURE = video.id;
  check("story fixture seeded (2 scenes + a real assembled doc, 1.0×)", !!FIXTURE, FIXTURE);

  // guard-matrix rows the account owns: custom audio + a not-yet-voiced doc
  CUSTOM_ROW = (
    await db.video.create({
      data: {
        organizationId: membership.organizationId,
        topic: "S11 pace custom-audio gate",
        niche: "Motivation",
        format: "story",
        status: "draft",
        voice: "jam",
        ttsSpeed: 1.0,
        voiceSource: "custom",
        hasVoiceover: true,
        scenes: scenesJson,
        timeline: serializeTimeline(doc),
      },
    })
  ).id;
  NOVO_ROW = (
    await db.video.create({
      data: {
        organizationId: membership.organizationId,
        topic: "S11 pace no-voiceover gate",
        niche: "Motivation",
        format: "story",
        status: "draft",
        voice: "jam",
        ttsSpeed: 1.0,
        hasVoiceover: false,
        scenes: scenesJson,
        timeline: serializeTimeline(doc),
      },
    })
  ).id;
}

if (FIXTURE) {
  // ---- 3. cross-tenant: the stranger cannot even see the fixture.
  //         Register(B) may have flipped the cookie jar to B's auto-session,
  //         so A logs in again EXPLICITLY before the stranger write. ----
  res = await call("POST", "/api/auth/login", { email: emailA, password });
  check("stranger session restored (register auto-login is overridden)", res.status === 200 || res.status === 201, res.status);
  res = await call("POST", `/api/videos/${FIXTURE}/studio/pace`, { speed: 1.3 });
  check("cross-tenant pace change is invisible to a stranger (404)", res.status === 404, res.status);

  res = await call("POST", "/api/auth/login", { email: emailB, password });
  check("fixture owner logs in", res.status === 200 || res.status === 201, res.status);

  // ---- 4. hostile bodies die at the gates ----
  res = await call("POST", `/api/videos/${FIXTURE}/studio/pace`, {});
  check("missing speed → 400 (zod shape gate)", res.status === 400, res.status);
  res = await call("POST", `/api/videos/${FIXTURE}/studio/pace`, { speed: "fast" });
  check("junk string speed → 400 (zod shape gate)", res.status === 400, res.status);
  res = await call("POST", `/api/videos/${FIXTURE}/studio/pace`, { speed: 0.3 });
  check("under-range speed → 400 (zod shape gate)", res.status === 400, res.status);
  res = await call("POST", `/api/videos/${FIXTURE}/studio/pace`, { speed: 2.7 });
  check("over-range speed → 400 (zod shape gate)", res.status === 400, res.status);
  res = await call("POST", `/api/videos/${FIXTURE}/studio/pace`, { speed: null });
  check("null speed → 400 (zod shape gate)", res.status === 400, res.status);
  res = await call("POST", `/api/videos/${FIXTURE}/studio/pace`, { speed: 1.0 });
  check("the CURRENT pace → 400 (unchanged guard)", res.status === 400, res.status);

  // ---- 4b. the pipeline guards on rows the account owns ----
  res = await call("POST", `/api/videos/${CUSTOM_ROW}/studio/pace`, { speed: 1.3 });
  check("custom-audio video → honest 400 (re-attach the per-scene voiceover first)", res.status === 400, res.status);
  res = await call("POST", `/api/videos/${NOVO_ROW}/studio/pace`, { speed: 1.3 });
  check("not-yet-voiced video → honest 400 (generate the voiceover first)", res.status === 400, res.status);
  res = await call("POST", "/api/videos", {
    topic: "S11 pace format-gate probe",
    title: "S11 format gate probe",
  });
  const created = await res.json();
  const vid = created?.video?.id ?? created?.id;
  if (vid) {
    res = await call("POST", `/api/videos/${vid}/studio/pace`, { speed: 1.3 });
    check("classic (non-story) video → honest 400", res.status === 400, res.status);
  } else {
    check("classic probe video created", false, JSON.stringify(created).slice(0, 120));
  }

  // ---- 5. the pace AUDITION surface — the preview route synthesizes the
  //         narrator at the staged tempo on the fixture's own opening line. ----
  res = await call("POST", "/api/settings/voices/preview", {
    voice: "jam",
    text: "One short opening line.",
    speed: 1.3,
  });
  const auditionBuf = res.status === 200 ? Buffer.from(await res.arrayBuffer()) : Buffer.alloc(0);
  check(
    "the pace audition synthesizes at the staged tempo (200 + real audio)",
    res.status === 200 && auditionBuf.length > 1000,
    `${res.status} ${auditionBuf.length}B`
  );
  res = await call("POST", "/api/settings/voices/preview", { voice: "jam", text: "line", speed: 3 });
  check("the pace audition refuses an out-of-range tempo (400)", res.status === 400, res.status);

  // ---- 6. THE REAL pace change: 1.0 → 1.3 through live TTS ----
  const started = Date.now();
  res = await call("POST", `/api/videos/${FIXTURE}/studio/pace`, { speed: 1.3 });
  const swapSec = ((Date.now() - started) / 1000).toFixed(1);
  const data = res.status === 200 ? await res.json() : null;
  check(
    `the pace change succeeds through real synthesis (${swapSec}s)`,
    res.status === 200 && data?.ttsSpeed === 1.3,
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
      "the activity line names the new pace and the re-read",
      typeof data.activity === "string" && data.activity.includes("1.3") && data.activity.includes("2 scenes"),
      data.activity
    );

    // the row: ttsSpeed flipped, audioDuration updated, doc persisted
    const row = await db.video.findUnique({ where: { id: FIXTURE } });
    check(
      "the row moves with the pace: ttsSpeed=1.3, audioDuration set, doc saved",
      row?.ttsSpeed === 1.3 &&
        typeof row?.audioDuration === "number" && row.audioDuration > 1 &&
        !!row?.timeline && row.timeline.includes('"sceneCount":2'),
      `${row?.ttsSpeed} ${row?.audioDuration}`
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
      "per-scene WAVs rebuilt at the new pace (200, RIFF, non-trivial, served)",
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

    // ---- 7. the TEMPO TELL: a second change (1.3 → 0.7) yields strictly
    //         LONGER reads — the pace genuinely reached the synth. ----
    res = await call("POST", `/api/videos/${FIXTURE}/studio/pace`, { speed: 0.7 });
    const slow = res.status === 200 ? await res.json() : null;
    check(
      "the second change (1.3 → 0.7) succeeds against the NEW standing pace",
      res.status === 200 && slow?.ttsSpeed === 0.7,
      `${res.status} ${JSON.stringify(slow).slice(0, 120)}`
    );
    if (slow?.wavDurations) {
      const s1 = slow.wavDurations["1"] ?? slow.wavDurations[1];
      const s2 = slow.wavDurations["2"] ?? slow.wavDurations[2];
      check(
        "the tempo tell: 0.7× reads are strictly LONGER than the 1.3× reads",
        typeof s1 === "number" && typeof s2 === "number" && s1 > wav1 && s2 > wav2,
        `0.7×: ${s1}/${s2} vs 1.3×: ${wav1}/${wav2}`
      );
      const slowRow = await db.video.findUnique({ where: { id: FIXTURE } });
      check("the row settles at 0.7× (sequential changes compose)", slowRow?.ttsSpeed === 0.7, slowRow?.ttsSpeed);
    }
  }
}

// ---- 8. the factory cleans up: probe rows + storage leave no litter ----
try {
  if (typeof vid !== "undefined" && vid) await db.video.delete({ where: { id: vid } }).catch(() => {});
  for (const row of [FIXTURE, CUSTOM_ROW, NOVO_ROW]) {
    if (row) {
      await db.video.delete({ where: { id: row } }).catch(() => {});
      // the server may keep uploads under the repo root OR under
      // .next/standalone (the standalone server chdirs) — sweep both.
      const roots = [
        process.env.TUBEFORGE_UPLOAD_ROOT
          ? path.resolve(process.env.TUBEFORGE_UPLOAD_ROOT)
          : path.join(process.cwd(), "uploads"),
        path.join(process.cwd(), ".next", "standalone", "uploads"),
      ];
      for (const root of roots) fs.rmSync(path.join(root, row), { recursive: true, force: true });
    }
  }
  const orgIds = new Set();
  for (const email of [emailA, emailB]) {
    const u = await db.user.findUnique({ where: { email }, select: { id: true } });
    if (!u) continue;
    const ms = await db.membership.findMany({ where: { userId: u.id }, select: { organizationId: true } });
    ms.forEach((m) => orgIds.add(m.organizationId));
    await db.user.delete({ where: { id: u.id } }).catch(() => {});
  }
  for (const orgId of orgIds) await db.organization.delete({ where: { id: orgId } }).catch(() => {});
} finally {
  await db.$disconnect();
}

console.log(failures === 0 ? "\nS11 ROUTE E2E: ALL PASS" : `\nS11 ROUTE E2E: ${failures} FAILURE(S)}`);
process.exit(failures === 0 ? 0 : 1);
