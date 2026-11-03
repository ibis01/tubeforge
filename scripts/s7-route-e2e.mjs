// S7 route e2e — "the score" against the LIVE server. Self-contained: it
// builds its OWN fixture (two fresh accounts + a story video seeded through
// the REAL doc modules + two REAL library tracks with audible wav files), so
// a recycled database can never stale it.
//   1. a fresh account gets the auth gate (401) on the music audition;
//   2. a story fixture is seeded for account B with the real
//      assembleTimeline/serializeTimeline modules, and B's library gets two
//      real synthesized tracks (motivation-tagged A, suspense-tagged B);
//   3. the stranger (account A) cannot see the fixture (404, cross-tenant);
//   4. with NO doc pick, the audition streams the auto-matched track
//      (RIFF, non-empty) and X-Music-Why says "auto";
//   5. PUT /assemble with a doc track pick → the audition's X-Music-Why
//      flips to "studio pick" and GET returns the persisted pick;
//   6. a mood pick resolves through the mood tags ("studio mood suspenseful");
//   7. a hostile pick is silently dropped at the doc choke point (audition
//      stays honest), and a bad mode is refused by the save schema (400);
//   8. the "off" pick mutes: the audition answers 400 with the honest reason;
//   9. a classic (non-story) video is refused with the honest 400;
//  10. everything is cleaned up — videos, tracks, wav files, accounts.
// Run: node --import tsx scripts/s7-route-e2e.mjs
import { PrismaClient } from "@prisma/client";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { assembleTimeline, serializeTimeline } from "../src/lib/tubeforge/timeline";
import { parseScenes } from "../src/lib/tubeforge/story";

const execFileAsync = promisify(execFile);
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
const emailA = `s7-e2e-a-${stamp}@example.com`;
const emailB = `s7-e2e-b-${stamp}@example.com`;
const password = "S7RouteE2e!2345";
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};
const whyOf = (res) => decodeURIComponent(res.headers.get("x-music-why") ?? "");

// ---- 1. the auth gate (no session yet) ----
let res = await call("GET", `/api/videos/x/studio/sound?bank=music`);
check("music audition requires a session (401 before any work)", res.status === 401, res.status);

res = await call("POST", "/api/auth/register", { email: emailA, password });
res = await call("POST", "/api/auth/login", { email: emailA, password });
check("stranger account (A) can register + log in", res.status === 200 || res.status === 201, res.status);

// ---- 2. the fixture: account B + a story video + two REAL library tracks ----
res = await call("POST", "/api/auth/register", { email: emailB, password });
check("owner account (B) registers", res.status === 200 || res.status === 201, res.status);

const owner = await db.user.findUnique({ where: { email: emailB }, select: { id: true } });
const membership = owner
  ? await db.membership.findFirst({ where: { userId: owner.id }, select: { organizationId: true } })
  : null;
check("owner's organization resolves (registration created it)", !!membership?.organizationId, owner?.id);

let FIXTURE = null;
let trackA = null;
let trackB = null;

// The track file must exist under the SERVER's UPLOAD_ROOT. The standalone
// daemon chdir's into .next/standalone (Next's server.js does it at boot),
// so its uploads root is .next/standalone/uploads; a `next dev` server uses
// <project>/uploads. Place the wav under BOTH roots — the wrong one is just
// an unused scratch file, cleaned up below.
const UPLOAD_ROOTS = [
  path.join(process.cwd(), "uploads"),
  path.join(process.cwd(), ".next", "standalone", "uploads"),
];
const trackScriptPath = (t) => path.join(UPLOAD_ROOTS[0], t.filePath);
async function placeTrackFile(t, hz) {
  const canonical = trackScriptPath(t);
  fs.mkdirSync(path.dirname(canonical), { recursive: true });
  await execFileAsync(
    "ffmpeg",
    ["-y", "-f", "lavfi", "-i", `sine=frequency=${hz}:duration=5`, "-ar", "44100", "-ac", "2", canonical],
    { timeout: 60_000 }
  );
  for (const root of UPLOAD_ROOTS.slice(1)) {
    const mirror = path.join(root, t.filePath);
    fs.mkdirSync(path.dirname(mirror), { recursive: true });
    fs.copyFileSync(canonical, mirror);
  }
}

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
      topic: "S7 music-pick route e2e fixture",
      niche: "Motivation",
      format: "story",
      status: "draft",
      scenes: scenesJson,
      timeline: serializeTimeline(doc),
    },
  });
  FIXTURE = video.id;

  // Two audible tracks in B's library — the ONLY active tracks in this org,
  // so every resolution below is deterministic. Real files on disk: the
  // audition transcodes the resolved track exactly like the render would.
  trackA = await db.musicTrack.create({
    data: {
      organizationId: membership.organizationId,
      name: `S7 Uplift ${stamp}`, moods: "motivation,uplifting",
      durationSec: 5, filePath: `_music/s7-e2e-a-${stamp}.wav`,
    },
  });
  trackB = await db.musicTrack.create({
    data: {
      organizationId: membership.organizationId,
      name: `S7 Dark ${stamp}`, moods: "mysteries,dark",
      durationSec: 5, filePath: `_music/s7-e2e-b-${stamp}.wav`,
    },
  });
  fs.mkdirSync(path.join(UPLOAD_ROOTS[0], "_music"), { recursive: true });
  await placeTrackFile(trackA, 440);
  await placeTrackFile(trackB, 220);
  check(
    "story fixture + two audible library tracks seeded",
    !!FIXTURE && fs.existsSync(trackScriptPath(trackA)) && fs.existsSync(trackScriptPath(trackB)),
    FIXTURE
  );
}

if (FIXTURE) {
  // ---- 3. cross-tenant: the stranger cannot even see the fixture ----
  res = await call("POST", "/api/auth/login", { email: emailA, password });
  res = await call("GET", `/api/videos/${FIXTURE}/studio/sound?bank=music`);
  check("cross-tenant music audition is invisible to a stranger (404)", res.status === 404, res.status);

  res = await call("POST", "/api/auth/login", { email: emailB, password });
  check("fixture owner logs in", res.status === 200 || res.status === 201, res.status);

  // ---- 4. NO doc pick → the pre-S7 chain (auto-match) ----
  res = await call("GET", `/api/videos/${FIXTURE}/studio/sound?bank=music`);
  const autoWav = Buffer.from(await res.arrayBuffer());
  check(
    "no pick: audition streams the auto-matched track (RIFF) and X-Music-Why says auto",
    res.status === 200 &&
      res.headers.get("content-type") === "audio/wav" &&
      autoWav.length > 100000 &&
      autoWav.slice(0, 4).toString() === "RIFF" &&
      whyOf(res).includes("auto mood-match"),
    `${res.status}, ${autoWav.length} bytes, why="${whyOf(res)}"`
  );

  // ---- 5. a doc TRACK pick re-tops the chain ----
  res = await call("GET", `/api/videos/${FIXTURE}/assemble`);
  const original = (await res.json())?.timeline;
  const doc = original;
  doc.renderPrefs = { quality: "standard", music: { mode: "track", trackId: trackB.id } };
  res = await call("PUT", `/api/videos/${FIXTURE}/assemble`, {
    scenes: doc.scenes,
    totalDurationSec: doc.totalDurationSec,
    generatedAt: doc.generatedAt,
    renderPrefs: doc.renderPrefs,
  });
  check("PUT /assemble accepts the doc with a track pick", res.status === 200, res.status);

  res = await call("GET", `/api/videos/${FIXTURE}/studio/sound?bank=music`);
  const pickedWav = Buffer.from(await res.arrayBuffer());
  check(
    "with the pick: the audition plays THE pinned track (X-Music-Why says studio pick)",
    res.status === 200 &&
      pickedWav.length > 100000 &&
      pickedWav.slice(0, 4).toString() === "RIFF" &&
      whyOf(res).startsWith("studio pick"),
    `${res.status}, why="${whyOf(res)}"`
  );

  res = await call("GET", `/api/videos/${FIXTURE}/assemble`);
  const saved = (await res.json())?.timeline;
  check(
    "GET /assemble returns the persisted pick (save→read round-trip)",
    saved?.renderPrefs?.music?.mode === "track" && saved?.renderPrefs?.music?.trackId === trackB.id,
    JSON.stringify(saved?.renderPrefs)
  );

  // ---- 6. a doc MOOD pick resolves through the mood tags ----
  res = await call("PUT", `/api/videos/${FIXTURE}/assemble`, {
    scenes: doc.scenes,
    totalDurationSec: doc.totalDurationSec,
    generatedAt: doc.generatedAt,
    renderPrefs: { quality: "standard", music: { mode: "mood", moodId: "suspenseful" } },
  });
  res = await call("GET", `/api/videos/${FIXTURE}/studio/sound?bank=music`);
  await res.arrayBuffer();
  check(
    "mood pick: the audition explains the studio mood → the dark track",
    res.status === 200 && whyOf(res).startsWith("studio mood suspenseful"),
    whyOf(res)
  );

  // ---- 7. hostile picks die at the doc choke point / the save schema ----
  res = await call("PUT", `/api/videos/${FIXTURE}/assemble`, {
    scenes: doc.scenes,
    totalDurationSec: doc.totalDurationSec,
    generatedAt: doc.generatedAt,
    renderPrefs: { quality: "standard", music: { mode: "track", trackId: "../../etc/passwd" } },
  });
  check("a path-ish trackId passes the permissive save schema", res.status === 200, res.status);
  res = await call("GET", `/api/videos/${FIXTURE}/assemble`);
  const dropped = (await res.json())?.timeline;
  check(
    "but the doc choke point DROPS it — the persisted pick is gone",
    dropped?.renderPrefs?.music === undefined || dropped?.renderPrefs?.music === null,
    JSON.stringify(dropped?.renderPrefs)
  );
  res = await call("GET", `/api/videos/${FIXTURE}/studio/sound?bank=music`);
  await res.arrayBuffer();
  check("and the audition stays honest (auto-match again)", res.status === 200 && whyOf(res).includes("auto mood-match"), whyOf(res));

  res = await call("PUT", `/api/videos/${FIXTURE}/assemble`, {
    scenes: doc.scenes,
    totalDurationSec: doc.totalDurationSec,
    generatedAt: doc.generatedAt,
    renderPrefs: { quality: "standard", music: { mode: "earblast" } },
  });
  check("an unknown mode is refused by the save schema (400)", res.status === 400, res.status);

  // ---- 8. the off pick mutes — the honest 400 ----
  res = await call("PUT", `/api/videos/${FIXTURE}/assemble`, {
    scenes: doc.scenes,
    totalDurationSec: doc.totalDurationSec,
    generatedAt: doc.generatedAt,
    renderPrefs: { quality: "standard", music: { mode: "off" } },
  });
  res = await call("GET", `/api/videos/${FIXTURE}/studio/sound?bank=music`);
  const offBody = await res.json().catch(() => ({}));
  check(
    "off pick: the audition refuses with the mute reason",
    res.status === 400 && /mute/i.test(offBody?.error ?? ""),
    `${res.status}, ${JSON.stringify(offBody)}`
  );

  // ---- restore the fixture doc exactly as it was ----
  res = await call("PUT", `/api/videos/${FIXTURE}/assemble`, {
    scenes: original.scenes,
    totalDurationSec: original.totalDurationSec,
    generatedAt: original.generatedAt,
  });
  check("fixture doc restored", res.status === 200, res.status);
}

// ---- 9. the story-format gate (a classic video the account owns) ----
res = await call("POST", "/api/videos", {
  topic: "S7 music-pick route gate probe",
  title: "S7 route gate probe",
});
const created = await res.json();
const vid = created?.video?.id ?? created?.id;
if (vid) {
  res = await call("GET", `/api/videos/${vid}/studio/sound?bank=music`);
  check("classic (non-story) video → honest 400", res.status === 400, res.status);
} else {
  check("classic probe video created", false, JSON.stringify(created).slice(0, 120));
}

// ---- 9b. S7-audit: the Settings master switch is REAL everywhere ----
// The pre-audit render only consulted the body option + the doc pick for its
// music flag, so a Settings-off resolver-null was conflated with "no match"
// and the finalizer droned over a bed the user had switched off. The flag
// now flows through musicBedActive (the same truth the render, the mix
// preview and the export credits use). The audition is the probe's window
// into that truth: a disabled bed must REFUSE, not drone — and an explicit
// doc pick must still override the switch.
if (FIXTURE && trackB) {
  // no doc pick on the fixture (restored in 8) + master switch OFF
  res = await call("PUT", "/api/settings", { "music.enabled": false });
  check("Settings: the music master switch flips off", res.status === 200, res.status);
  res = await call("GET", `/api/videos/${FIXTURE}/studio/sound?bank=music`);
  const offSettingsBody = await res.json().catch(() => ({}));
  check(
    "Settings music off + no doc pick → the audition refuses (silence, not the drone)",
    res.status === 400 && /off for this video/i.test(offSettingsBody?.error ?? ""),
    `${res.status}, ${JSON.stringify(offSettingsBody)}`
  );

  // an explicit doc pick overrides the master switch — the bed plays
  res = await call("GET", `/api/videos/${FIXTURE}/assemble`);
  const doc9 = (await res.json())?.timeline;
  res = await call("PUT", `/api/videos/${FIXTURE}/assemble`, {
    scenes: doc9.scenes,
    totalDurationSec: doc9.totalDurationSec,
    generatedAt: doc9.generatedAt,
    renderPrefs: { quality: "standard", music: { mode: "track", trackId: trackB.id } },
  });
  res = await call("GET", `/api/videos/${FIXTURE}/studio/sound?bank=music`);
  const overrideWav = Buffer.from(await res.arrayBuffer());
  check(
    "an explicit doc pick plays even with the master switch off (the override)",
    res.status === 200 &&
      overrideWav.slice(0, 4).toString() === "RIFF" &&
      whyOf(res).startsWith("studio pick"),
    `${res.status}, why="${whyOf(res)}"`
  );

  // restore: pick cleared + master switch back on (cleanup removes the rest)
  res = await call("PUT", `/api/videos/${FIXTURE}/assemble`, {
    scenes: doc9.scenes,
    totalDurationSec: doc9.totalDurationSec,
    generatedAt: doc9.generatedAt,
  });
  const restoredPick = res.status === 200;
  res = await call("PUT", "/api/settings", { "music.enabled": true });
  check("fixture restored: no doc pick + master switch back on", restoredPick && res.status === 200, res.status);
} else {
  check("S7-audit corners skipped — fixture missing", false, "FIXTURE/trackB unavailable");
}

// ---- 10. the factory cleans up: probe rows + files leave no litter ----
try {
  if (vid) await db.video.delete({ where: { id: vid } }).catch(() => {});
  if (FIXTURE) await db.video.delete({ where: { id: FIXTURE } }).catch(() => {});
  for (const t of [trackA, trackB]) {
    if (!t) continue;
    for (const root of UPLOAD_ROOTS) fs.rmSync(path.join(root, t.filePath), { force: true });
    await db.musicTrack.delete({ where: { id: t.id } }).catch(() => {});
  }
  for (const email of [emailA, emailB]) {
    const u = await db.user.findUnique({ where: { email }, select: { id: true } });
    if (u) await db.user.delete({ where: { id: u.id } }).catch(() => {});
  }
  console.log("PASS  probe rows cleaned up (videos + tracks + files + accounts)");
} catch (err) {
  console.log(`WARN  cleanup incomplete — ${err?.message ?? err}`);
}

await db.$disconnect();
console.log(failures === 0 ? "\nS7 ROUTE E2E: ALL PASS" : `\nS7 ROUTE E2E: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
