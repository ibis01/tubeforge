// S29 route e2e — "the whole hallway": one video through EVERY machine door.
//
// The audit's #1 priority was production reliability of the FULL chain —
// project → assets → render → QC → export → publish — and every battery
// suite to date proves ONE door at a time. This suite walks the whole
// hallway in order, over real HTTP, against the running daemon:
//
//   1.  the auth gate — the machine doors refuse anonymous callers
//   2.  tenants — a throwaway owner (A) + a stranger (B), both through the
//       front door (S28 law: relative links, verified flip)
//   3.  the project — a story video with three real scenes (the script
//       job's OUTPUT shape is this suite's ARRANGEMENT: the machine chain
//       starts where the AI text stages hand off)
//   4.  the storyboard door — render gate fires first (400), then three
//       uploaded artworks (multipart, real cover-crop) flip hasStoryboard
//   5.  the voiceover door — render gate fires again (400), then a
//       bring-your-own-voice WAV (multipart ingest → normalize → per-scene
//       cut) flips hasVoiceover with three scene WAVs
//   6.  the render door — stranger B gets the tenant 404; owner POSTs a
//       kenburns render (202) and the job runs to done: hasVideo, a real
//       duration, no error
//   7.  the delivery door — GET mp4 streams real bytes (h264 + aac via
//       ffprobe), HTTP Range answers 206
//   8.  the QC door — the render's auto-battery left a three-state report;
//       the after-edit re-run (POST /qc) lands a fresh one
//   9.  the export door — GET export streams a ZIP that actually contains
//       final.mp4 and the .srt
//  10.  the publish gate — everything is ready except the external door:
//       POST publish → clean 400 (no connected channel), status confirms
//       it (fail-closed, never a silent no-op)
//  11.  cleanup — the video leaves through its DELETE, both accounts
//       through the front door ({confirm:"DELETE"}), and the end state is
//       asserted against the suite's STARTING baseline (the owner's real
//       account lives in this DB).
//
// Fixtures are generated locally with ffmpeg (art PNGs + an amplitude-
// modulated voice WAV) — zero external AI, zero flaky network deps; the
// chain under test is the machine half, exactly the half a recycle or a
// bad deploy would break.
//
// Run after a daemon restart: node scripts/s29-route-e2e.mjs

import { PrismaClient } from "@prisma/client";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:3000";
const db = new PrismaClient();

const stamp = Date.now().toString(36);
const emailA = `s29-e2e-a-${stamp}@example.com`; // the throwaway owner
const emailB = `s29-e2e-b-${stamp}@example.com`; // the stranger
const PASSWORD = "S29RouteE2e!2345";

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Two cookie jars — owner A walks the chain, stranger B probes the walls.
const jar = { A: null, B: null };
async function call(as, method, p, body, raw = false) {
  const headers = { ...(jar[as] ? { cookie: jar[as] } : {}) };
  let payload;
  if (body instanceof FormData) {
    payload = body; // fetch sets the multipart boundary itself
  } else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + p, { method, headers, body: payload });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie && as) jar[as] = setCookie.split(";")[0];
  if (raw) return res;
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

// ---- fixtures (ffmpeg: deterministic art + a continuous modulated voice) ----
const TMP = `/tmp/s29-fixtures`;
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
const ART = ["0x20344f", "0x513a21", "0x2d4a2d"]; // dusk sea, lamp room, morning harbor
for (let i = 0; i < 3; i++)
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", `color=c=${ART[i]}:s=1600x900:duration=0.04`, "-frames:v", "1", path.join(TMP, `art-${i + 1}.png`)]);
// 15 s of amplitude-modulated 200 Hz — continuous (no dead-air), measurable
// loudness, the shape ingestCustomAudio's normalizer can actually chew.
execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=200:duration=15", "-af", "tremolo=f=2.5:d=0.75,volume=0.9", "-ar", "44100", "-ac", "1", path.join(TMP, "voice.wav")]);

const SCENES = [
  { index: 1, title: "The Signal", narration: "Every morning the keeper climbed one hundred and eighty steps to trim the lamp that guarded the strait.", visual: "a lone lighthouse at first light, golden beam sweeping a cold grey sea", camera: "zoom-in", mood: "hopeful", caption: "One hundred eighty steps" },
  { index: 2, title: "The Storm", narration: "On the fourth night a storm rose out of the east, and for nine hours the light had to hold alone.", visual: "monstrous waves breaking against lighthouse rocks under a black sky", camera: "pan-left", mood: "tense", caption: "Nine hours alone" },
  { index: 3, title: "The Keeping", narration: "By dawn the town was still there, every roof and every boat, and the keeper finally slept.", visual: "a calm harbor at sunrise, fishing boats gliding home past the lighthouse", camera: "zoom-out", mood: "warm", caption: "Still there" },
];

// Poll the video DTO (GET wraps it as { video, generating }) until fn(dto)
// is truthy (or timeout with the last observed shape).
async function pollVideo(id, fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const res = await call("A", "GET", `/api/videos/${id}`);
    if (res.status === 200) {
      last = res.json?.video ?? null;
      if (last && fn(last)) return { ok: true, dto: last };
    } else last = res;
    await sleep(700);
  }
  return { ok: false, last, label };
}

// ---- 0. baseline (S28 law: end state is asserted against the START) ----
const baseline = {
  users: await db.user.count(),
  orgs: await db.organization.count(),
  videos: await db.video.count(),
};

// ---- 1. the auth gate ----
let res = await call(null, "POST", "/api/videos/x/render", {});
check("1.1  anonymous render → 401", res.status === 401, res.status);
res = await call(null, "POST", "/api/videos/x/voiceover", {});
check("1.2  anonymous voiceover → 401", res.status === 401, res.status);
res = await call(null, "GET", "/api/videos/x/export");
check("1.3  anonymous export → 401", res.status === 401, res.status);
res = await call(null, "GET", "/api/videos/x/qc");
check("1.4  anonymous QC status → 401", res.status === 401, res.status);

// ---- 2. tenants through the front door ----
await call("A", "POST", "/api/auth/register", { email: emailA, password: PASSWORD });
res = await call("A", "POST", "/api/auth/login", { email: emailA, password: PASSWORD });
check("2.1  owner (A) registers + logs in", res.status === 200, res.status);
res = await call("A", "GET", "/api/auth/status");
check("2.2  A's session carries an organization", res.status === 200 && !!res.json?.organization?.id, res.json?.organization?.id);

await call("B", "POST", "/api/auth/register", { email: emailB, password: PASSWORD });
res = await call("B", "POST", "/api/auth/login", { email: emailB, password: PASSWORD });
check("2.3  stranger (B) registers + logs in", res.status === 200, res.status);

const userA = await db.user.findUnique({ where: { email: emailA }, select: { id: true } });
const orgA = await db.membership.findFirst({ where: { userId: userA?.id }, select: { organizationId: true } });
check("2.4  A's org resolves for arrangement", !!orgA?.organizationId, orgA?.organizationId);

// ---- 3. the project ----
let VIDEO_ID = null;
if (orgA?.organizationId) {
  const video = await db.video.create({
    data: {
      organizationId: orgA.organizationId,
      topic: "The Lighthouse Keeper — S29 full-chain fixture",
      title: "The Keeper",
      niche: "Documentary",
      format: "story",
      status: "draft",
      voice: "jam",
      ttsSpeed: 1.0,
      scenes: JSON.stringify(SCENES),
    },
  });
  VIDEO_ID = video.id;
}
check("3.1  story project seeded (3 scenes, nothing rendered)", !!VIDEO_ID, VIDEO_ID);

if (VIDEO_ID) {
  // ---- 4. the storyboard door ----
  res = await call("A", "POST", `/api/videos/${VIDEO_ID}/render`, { mode: "kenburns" });
  check("4.1  render without storyboard art → 400 with the actionable gate", res.status === 400 && /storyboard/i.test(res.json?.error ?? ""), { status: res.status, error: res.json?.error });

  let uploaded = 0;
  for (let i = 1; i <= 3; i++) {
    const bytes = fs.readFileSync(path.join(TMP, `art-${i}.png`));
    const form = new FormData();
    form.append("scene", String(i));
    form.append("file", new File([bytes], `art-${i}.png`, { type: "image/png" }));
    const up = await call("A", "POST", `/api/videos/${VIDEO_ID}/storyboard/upload`, form);
    if (up.status === 200) uploaded++;
    else check(`4.${i + 1}  scene ${i} artwork upload → 200`, false, `${up.status} ${up.json?.error}`);
  }
  check("4.4  all three artworks uploaded through the door", uploaded === 3, uploaded);

  res = await call("A", "GET", `/api/videos/${VIDEO_ID}`);
  const afterArt = res.json?.video;
  check("4.5  hasStoryboard flips true (cover-crop accepted all three)", afterArt?.hasStoryboard === true, afterArt?.hasStoryboard);
  check("4.6  hasVideo stays false — nothing rendered yet", afterArt?.hasVideo === false, afterArt?.hasVideo);

  // ---- 5. the voiceover door ----
  res = await call("A", "POST", `/api/videos/${VIDEO_ID}/render`, { mode: "kenburns" });
  check("5.1  render without voiceover → 400 with the actionable gate", res.status === 400 && /voiceover/i.test(res.json?.error ?? ""), { status: res.status, error: res.json?.error });

  const voiceBytes = fs.readFileSync(path.join(TMP, "voice.wav"));
  const vform = new FormData();
  vform.append("file", new File([voiceBytes], "keeper-voice.wav", { type: "audio/wav" }));
  vform.append("label", "keeper narration (s29 fixture)");
  res = await call("A", "POST", `/api/videos/${VIDEO_ID}/voiceover`, vform);
  check("5.2  bring-your-own-voice upload accepted (202 job)", res.status === 202 || res.status === 200, { status: res.status, error: res.json?.error });

  const vo = await pollVideo(VIDEO_ID, (d) => d.hasVoiceover === true, 120_000, "voiceover job");
  check("5.3  voiceover job completes → hasVoiceover true", vo.ok, vo.ok ? "" : JSON.stringify(vo.last?.json?.error ?? vo.last?.error ?? vo.last ?? "timeout").slice(0, 200));
  if (vo.ok) {
    check("5.4  custom voice source + label recorded", vo.dto.voiceSource === "custom" && /keeper narration/.test(vo.dto.voiceLabel ?? ""), `${vo.dto.voiceSource} / ${vo.dto.voiceLabel}`);
    check("5.5  audio duration measured from the real WAV", (vo.dto.audioDuration ?? 0) > 10, vo.dto.audioDuration);
  }

  // ---- 6. the render door ----
  res = await call("B", "POST", `/api/videos/${VIDEO_ID}/render`, { mode: "kenburns" });
  check("6.1  stranger B cannot render A's video → 404 (tenant wall)", res.status === 404, res.status);
  res = await call("B", "GET", `/api/videos/${VIDEO_ID}/mp4`);
  check("6.2  stranger B cannot fetch A's mp4 → 404 (tenant wall)", res.status === 404, res.status);

  res = await call("A", "POST", `/api/videos/${VIDEO_ID}/render`, { mode: "kenburns", subtitles: true, music: true });
  check("6.3  render accepted (202 — gates passed, job enqueued)", res.status === 202, { status: res.status, error: res.json?.error });

  const ren = await pollVideo(VIDEO_ID, (d) => d.hasVideo === true, 300_000, "render job");
  check("6.4  render job completes → hasVideo true", ren.ok, ren.ok ? "" : JSON.stringify(ren.last?.json?.error ?? ren.last?.error ?? ren.last ?? "timeout").slice(0, 200));
  if (ren.ok) {
    check("6.5  a real duration was measured on the row", (ren.dto.videoDuration ?? 0) > 10, ren.dto.videoDuration);
    check("6.6  videoUrl points at the delivery door", ren.dto.videoUrl === `/api/videos/${VIDEO_ID}/mp4`, ren.dto.videoUrl);
    check("6.7  no error left on the row", !ren.dto.error, ren.dto.error);

    // ---- 7. the delivery door ----
    const mp4 = await call("A", "GET", `/api/videos/${VIDEO_ID}/mp4`, undefined, true);
    const mp4Bytes = Buffer.from(await mp4.arrayBuffer());
    check("7.1  GET mp4 → 200 video/mp4 with real bytes", mp4.status === 200 && (mp4.headers.get("content-type") ?? "").includes("video/mp4") && mp4Bytes.length > 50_000, `${mp4.status} ${mp4.headers.get("content-type")} ${mp4Bytes.length}B`);

    const probePath = path.join(TMP, "final.mp4");
    fs.writeFileSync(probePath, mp4Bytes);
    let codecs = null;
    try {
      const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,codec_type", "-of", "json", probePath]).toString();
      codecs = JSON.parse(out).streams ?? [];
    } catch { codecs = null; }
    check("7.2  the delivered file is a real H.264 + AAC video", !!codecs && codecs.some((s) => s.codec_type === "video" && s.codec_name === "h264") && codecs.some((s) => s.codec_type === "audio" && s.codec_name === "aac"), JSON.stringify(codecs));

    const rangeRes = await fetch(`${BASE}/api/videos/${VIDEO_ID}/mp4`, { headers: { cookie: jar.A, range: "bytes=0-1023" } });
    const rangeBody = Buffer.from(await rangeRes.arrayBuffer());
    check("7.3  HTTP Range seek answers 206 with a content-range and exactly 1024 bytes", rangeRes.status === 206 && /^bytes 0-1023\//.test(rangeRes.headers.get("content-range") ?? "") && rangeBody.length === 1024, `${rangeRes.status} ${rangeRes.headers.get("content-range")} ${rangeBody.length}B`);

    // ---- 8. the QC door ----
    const autoQc = ren.dto.qc;
    check("8.1  the render left an auto QC report on the row", !!autoQc && Array.isArray(autoQc.checks) && autoQc.checks.length >= 8, autoQc ? `${autoQc.checks?.length} checks` : "missing");
    if (autoQc?.checks?.length) {
      const states = new Set(autoQc.checks.map((c) => c.status));
      check("8.2  every QC check is three-state (pass/fail/unmeasured — never blank)", [...states].every((s) => ["pass", "fail", "unmeasured"].includes(s)), [...states].join(","));
    }

    res = await call("A", "POST", `/api/videos/${VIDEO_ID}/qc`);
    check("8.3  after-edit QC re-run accepted (202)", res.status === 202, { status: res.status, error: res.json?.error });
    // The re-run is its OWN Job row (the auto-pass ran inside the render
    // job) — poll the durable row to a terminal status, then read the
    // report the job was supposed to leave behind.
    let qcOutcome = "timeout";
    const qcDeadline = Date.now() + 120_000;
    while (Date.now() < qcDeadline) {
      const top = await db.job.findFirst({
        where: { entityId: VIDEO_ID, kind: "qc" },
        orderBy: { startedAt: "desc" },
        select: { status: true, error: true },
      });
      if (top && ["done", "failed", "cancelled", "interrupted"].includes(top.status)) {
        qcOutcome = top.status;
        break;
      }
      await sleep(700);
    }
    check("8.4  the re-run job reaches done (after-edit path)", qcOutcome === "done", qcOutcome);
    const qcRow = await db.video.findUnique({ where: { id: VIDEO_ID }, select: { qcReport: true } });
    let qcFresh = null;
    try { qcFresh = JSON.parse(qcRow?.qcReport ?? "null"); } catch { qcFresh = null; }
    check("8.5  the re-run lands a fresh report on the row", !!qcFresh && Array.isArray(qcFresh.checks) && qcFresh.checks.length >= 8, qcFresh ? `${qcFresh.checks.length} checks` : "missing");

    // ---- 9. the export door ----
    const exp = await call("A", "GET", `/api/videos/${VIDEO_ID}/export`, undefined, true);
    const zipBytes = Buffer.from(await exp.arrayBuffer());
    const zipText = zipBytes.toString("latin1");
    check("9.1  GET export → 200 a real ZIP (PK magic)", exp.status === 200 && zipBytes.subarray(0, 2).toString("latin1") === "PK" && zipBytes.length > 100_000, `${exp.status} ${zipBytes.length}B`);
    check("9.2  the package carries the rendered video", zipText.includes("final.mp4"), "final.mp4 not in the archive");
    check("9.3  the package carries the subtitles", /\.srt/.test(zipText), "no .srt in the archive");

    // ---- 10. the publish gate ----
    res = await call("A", "POST", `/api/videos/${VIDEO_ID}/publish`, { title: "The Keeper", privacy: "public" });
    check("10.1 publish with everything ready but no channel → clean 400 (fail-closed)", res.status === 400 && /channel/i.test(res.json?.error ?? ""), { status: res.status, error: res.json?.error });
    res = await call("A", "GET", `/api/youtube/status`);
    check("10.2 YouTube status confirms: not connected", res.status === 200 && res.json?.status?.connected === false, { status: res.status, body: res.json?.status ?? res.json });

    // ---- 11. cleanup ----
    res = await call("A", "DELETE", `/api/videos/${VIDEO_ID}`);
    check("11.1 the video leaves through its DELETE", res.status === 200 || res.status === 204, res.status);
  }
}

// Both accounts out through the front door (session-gated, confirm-locked).
res = await call("A", "POST", "/api/account/delete", { confirm: "DELETE" });
check("11.2 owner A's account deletes through the front door", res.status === 200 && res.json?.deleted === true, { status: res.status, error: res.json?.error });
res = await call("B", "POST", "/api/account/delete", { confirm: "DELETE" });
check("11.3 stranger B's account deletes through the front door", res.status === 200 && res.json?.deleted === true, { status: res.status, error: res.json?.error });

// End state vs baseline — nothing behind, the real owner untouched.
const sweep = {
  users: await db.user.count(),
  orgs: await db.organization.count(),
  videos: await db.video.count(),
  s29users: await db.user.count({ where: { email: { contains: "s29-e2e-" } } }),
  jobs: await db.job.count({ where: { organizationId: orgA?.organizationId ?? "none" } }),
  acts: await db.activity.count({ where: { organizationId: orgA?.organizationId ?? "none" } }),
};
check("11.4 user/org/video counts back to baseline", sweep.users === baseline.users && sweep.orgs === baseline.orgs && sweep.videos === baseline.videos, JSON.stringify({ baseline, sweep }));
check("11.5 zero s29 accounts remain", sweep.s29users === 0, sweep.s29users);
check("11.6 the throwaway org's jobs and activities cascaded", sweep.jobs === 0 && sweep.acts === 0, `${sweep.jobs} jobs / ${sweep.acts} acts`);
if (VIDEO_ID) {
  check("11.7 the uploads tree for the fixture video is gone", !fs.existsSync(path.join(process.cwd(), "uploads", VIDEO_ID)), VIDEO_ID);
}
const orphanOrgs = await db.organization.findMany({ where: { memberships: { none: {} } }, select: { id: true } });
check("11.8 no orphan organizations", orphanOrgs.length === 0, orphanOrgs.map((o) => o.id).join(","));

await db.$disconnect();
console.log(failures === 0 ? "S29 ROUTE E2E: ALL PASS" : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
