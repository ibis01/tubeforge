// TubeForge Phase 5 E2E — performance loop (YouTube stats sync guardrails,
// analytics aggregation, Topic Radar performance boost) + auto-Shorts
// (9:16 vertical cut with punch-in + captions).
// Run: bun scripts/test-phase5.mjs   (or: node scripts/test-phase5.mjs)

import { PrismaClient } from "@prisma/client";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";

const API = "http://localhost:3000";
const db = new PrismaClient();
const UPLOAD_ROOT = path.join(process.cwd(), "uploads");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const step = (msg) => console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s] ${msg}`);

let failures = 0;
function assert(cond, label, extra = "") {
  if (cond) {
    step(`PASS  ${label}${extra ? ` — ${extra}` : ""}`);
  } else {
    failures++;
    step(`FAIL  ${label}${extra ? ` — ${extra}` : ""}`);
  }
}

async function j(method, url, body) {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, data };
}

function ffprobeJson(file) {
  const out = execFileSync("ffprobe", [
    "-v", "error",
    "-show_entries", "stream=codec_type,codec_name,width,height",
    "-show_entries", "format=duration",
    "-of", "json",
    file,
  ]).toString();
  return JSON.parse(out);
}

// ---------- setup ----------
await db.setting.deleteMany({ where: { key: { startsWith: "yt" } } }); // unconnected, no sync marker
await db.videoStat.deleteMany({});
await db.video.updateMany({ data: { youtubeUrl: null, publishedAt: null, hasShort: false, shortScene: null, shortDuration: null, error: null } });
// Also wipe short artifacts from prior runs — the stream route keys off file existence.
for (const entry of fs.existsSync(UPLOAD_ROOT) ? fs.readdirSync(UPLOAD_ROOT) : []) {
  for (const f of ["short.mp4", "short-thumb.png"]) {
    const p = path.join(UPLOAD_ROOT, entry, f);
    if (fs.existsSync(p)) fs.rmSync(p);
  }
}
step("DB cleaned (yt settings, stats, shorts flags + short files)");

const videos = (await j("GET", "/api/videos?limit=20")).data.videos;
const classicVideo = videos.find((v) => v.format === "script");
const storyVideo = videos.find((v) => v.format === "story" && v.hasVideo && v.sceneCount >= 3);
assert(Boolean(storyVideo), "found a rendered story video for the Short test", storyVideo?.title);
assert(Boolean(classicVideo), "found a classic-format video for guardrails", classicVideo?.title);

// ---------- 1. guardrails ----------
step("— guardrails —");
{
  const sync = await j("POST", "/api/youtube/sync");
  assert(sync.status === 400 && /not connected/i.test(sync.data.error), "sync rejects when YouTube not connected", `HTTP ${sync.status}`);

  const missing = await j("POST", "/api/videos/nonexistent000/short", {});
  assert(missing.status === 404, "short for unknown video → 404", `HTTP ${missing.status}`);

  const classic = await j("POST", `/api/videos/${classicVideo.id}/short`, {});
  assert(classic.status === 400 && /scene-story/i.test(classic.data.error), "short for classic-format video → 400", classic.data.error?.slice(0, 60));

  const rescore = await j("POST", "/api/analytics/rescore");
  assert(rescore.status === 400 && /Not enough synced performance data/i.test(rescore.data.error), "rescore before stats → 400", rescore.data.error?.slice(0, 60));

  const shortStream = await fetch(`${API}/api/videos/${storyVideo.id}/mp4?variant=short`);
  assert(shortStream.status === 404, "mp4?variant=short before render → 404", `HTTP ${shortStream.status}`);
}

// ---------- 2. seed performance data ----------
step("— seed published videos + stat snapshots —");
const subjects = videos.slice(0, 3).map((v) => v.id);
assert(subjects.length === 3, "3 video subjects available");

const seedTitles = {
  [subjects[0]]: "The 5 Morning Habits That Rewire Your Brain",
  [subjects[1]]: "Why Discipline Beats Motivation Every Time",
  [subjects[2]]: "Unusual Kitchen Gadgets You Never Knew",
};
for (const id of subjects) {
  await db.video.update({
    where: { id },
    data: {
      title: seedTitles[id],
      youtubeUrl: `https://youtu.be/seed${id.slice(-6)}`,
      status: "published",
      publishedAt: new Date(Date.now() - 14 * 24 * 3600 * 1000),
    },
  });
}

const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600 * 1000);
const round1 = { [subjects[0]]: [500, 40, 6], [subjects[1]]: [220, 18, 2], [subjects[2]]: [80, 4, 1] };
const round2 = { [subjects[0]]: [1200, 92, 15], [subjects[1]]: [300, 25, 3], [subjects[2]]: [90, 5, 1] };
for (const id of subjects) {
  await db.videoStat.create({
    data: { videoId: id, views: round1[id][0], likes: round1[id][1], comments: round1[id][2], snapshotAt: twoDaysAgo },
  });
  await db.videoStat.create({
    data: { videoId: id, views: round2[id][0], likes: round2[id][1], comments: round2[id][2], snapshotAt: new Date() },
  });
}
step("seeded 3 published videos × 2 stat snapshots (views 500/220/80 → 1200/300/90)");

// ---------- 3. analytics aggregation ----------
step("— analytics overview —");
{
  const { status, data } = await j("GET", "/api/analytics");
  assert(status === 200, "GET /api/analytics → 200");
  assert(data.publishedCount === 3, "publishedCount = 3", `got ${data.publishedCount}`);
  assert(data.trackedCount === 3, "trackedCount = 3", `got ${data.trackedCount}`);
  assert(data.totals.views === 1590, "total views = 1590", `got ${data.totals.views}`);
  assert(data.totals.likes === 122, "total likes = 122", `got ${data.totals.likes}`);
  assert(data.totals.comments === 19, "total comments = 19", `got ${data.totals.comments}`);
  assert(data.viewDelta === 790, "viewDelta = 790 (+700/+80/+10)", `got ${data.viewDelta}`);
  assert(data.rows[0].videoId === subjects[0], "rows sorted by views — winner first", data.rows[0].title);
  assert(data.rows[0].views === 1200 && data.rows[0].viewDelta === 700, "winner row views + delta", `${data.rows[0].views} (+${data.rows[0].viewDelta})`);
  assert(data.rows[0].engagementRate > 0.08 && data.rows[0].engagementRate < 0.09, "engagement rate computed", (data.rows[0].engagementRate * 100).toFixed(2) + "%");
  assert(data.series.length === 2 && data.series[0].views === 800 && data.series[1].views === 1590, "cumulative series 800 → 1590", JSON.stringify(data.series.map((s) => s.views)));
  assert(data.feedback.active === true, "feedback loop active");
  assert(data.feedback.winners.length === 1 && data.feedback.winners[0] === seedTitles[subjects[0]], "winner feeds the loop", data.feedback.winners[0]);
  assert(data.feedback.topKeywords.includes("morning") && data.feedback.topKeywords.includes("habits"), "dominant keywords extracted", data.feedback.topKeywords.join(","));
}

step("— stats merged into video DTOs —");
{
  const list = (await j("GET", "/api/videos?limit=50")).data.videos;
  const winner = list.find((v) => v.id === subjects[0]);
  const loser = list.find((v) => v.id === subjects[2]);
  assert(winner?.stats?.views === 1200 && winner?.stats?.likes === 92, "list DTO carries latest stats", JSON.stringify(winner?.stats));
  assert(loser?.stats?.comments === 1, "loser stats merged too", JSON.stringify(loser?.stats));

  const detail = (await j("GET", `/api/videos/${subjects[0]}`)).data.video;
  assert(detail.stats?.views === 1200, "detail DTO carries stats");
  assert(detail.publishedAt !== null && detail.youtubeUrl?.includes("youtu.be"), "detail DTO carries publish state");
}

// ---------- 4. performance boost (rescore) ----------
step("— Topic Radar performance boost —");
const baseIdeas = [
  {
    id: "idea-1",
    title: "5 Morning Habits That Rewire Your Brain Fast",
    angle: "Same winners' DNA", keywords: ["morning habits", "brain", "rewire", "routine"],
    searchVolume: "High", competition: "Low", viralScore: 95, suggestedLength: "medium",
    why: "mirror of the channel's winner",
  },
  {
    id: "idea-2",
    title: "Morning Routines of Top Performers",
    angle: "Partial overlap", keywords: ["morning routine", "productivity", "habits"],
    searchVolume: "High", competition: "Medium", viralScore: 60, suggestedLength: "short",
    why: "some overlap",
  },
  {
    id: "idea-3",
    title: "Deep Sea Creatures That Glow in the Dark",
    angle: "No overlap", keywords: ["deep sea", "ocean", "bioluminescence"],
    searchVolume: "Medium", competition: "Low", viralScore: 70, suggestedLength: "medium",
    why: "unrelated",
  },
  {
    id: "idea-4",
    title: "Unusual Kitchen Gadgets You Never Knew About",
    angle: "Loser clone", keywords: ["kitchen", "gadgets"],
    searchVolume: "Low", competition: "High", viralScore: 50, suggestedLength: "short",
    why: "mirrors an underperformer",
  },
];
{
  const session = await db.researchSession.create({
    data: {
      niche: "Motivation",
      query: "phase-5 boost test",
      ideas: JSON.stringify({ ideas: baseIdeas, nicheSummary: "test" }),
    },
  });

  const res = await j("POST", "/api/analytics/rescore", { sessionId: session.id });
  assert(res.status === 200, "rescore → 200", res.data.error);
  const byId = Object.fromEntries(res.data.ideas.map((i) => [i.id, i]));

  assert(byId["idea-1"].perfBoost === 15, "winner clone boosted +15", `got ${byId["idea-1"].perfBoost}`);
  assert(byId["idea-1"].viralScore === 100, "score capped at 100", `got ${byId["idea-1"].viralScore}`);
  assert(/overlap/i.test(byId["idea-1"].boostReason), "boost reason explains the overlap");
  assert(byId["idea-2"].perfBoost >= 5, "partial overlap boosted +5", `got ${byId["idea-2"].perfBoost}`);
  assert((byId["idea-3"].perfBoost ?? 0) === 0, "unrelated idea untouched", `got ${byId["idea-3"].perfBoost}`);
  assert(byId["idea-4"].perfBoost === -4, "loser clone dinged -4", `got ${byId["idea-4"].perfBoost}`);
  assert(byId["idea-4"].viralScore === 46, "ding lowered the score", `got ${byId["idea-4"].viralScore}`);
  assert(res.data.boosted >= 3, "boosted count ≥ 3", `got ${res.data.boosted}`);
  assert(res.data.changed >= 3, "changed count ≥ 3", `got ${res.data.changed}`);

  // Persisted back into the session
  const stored = await db.researchSession.findUnique({ where: { id: session.id } });
  const storedIdeas = JSON.parse(stored.ideas).ideas;
  assert(storedIdeas.find((i) => i.id === "idea-1").viralScore === 100, "boost persisted into the session row");
}

// ---------- 5. fresh research scan carries the loop (real GLM) ----------
step("— fresh Topic Radar scan (GLM + performance brief) —");
{
  const res = await j("POST", "/api/research", { niche: "Motivation", query: "morning habits" });
  assert(res.status === 200 && res.data.session?.ideas?.length >= 4, "research POST → session with ideas", `${res.data.session?.ideas?.length} ideas`);
  const scores = res.data.session?.ideas?.map((i) => i.viralScore) ?? [];
  assert(scores.every((s) => s >= 1 && s <= 100), "all scores within 1..100");
  const boosted = res.data.session?.ideas?.filter((i) => i.perfBoost) ?? [];
  assert(boosted.every((i) => typeof i.boostReason === "string"), "boosted ideas carry a reason", `${boosted.length} boosted`);
}

// ---------- 6. auto-Short ----------
step("— auto-Short (9:16 vertical cut) —");
{
  const started = await j("POST", `/api/videos/${storyVideo.id}/short`, {});
  assert(started.status === 202 && started.data.accepted, "short job accepted (202)", `HTTP ${started.status}`);

  const deadline = Date.now() + 8 * 60 * 1000;
  let shortState = null;
  for (;;) {
    const { data } = await j("GET", `/api/videos/${storyVideo.id}/short`);
    if (!data.generating && (data.hasShort || data.error)) { shortState = data; break; }
    if (Date.now() > deadline) throw new Error("short render timed out");
    await sleep(4000);
  }
  assert(shortState.hasShort, "short rendered", shortState.error ?? "");
  assert(Number.isFinite(shortState.durationSec) && shortState.durationSec > 0, "short duration recorded", `${shortState.durationSec?.toFixed(1)}s`);

  const file = path.join(UPLOAD_ROOT, storyVideo.id, "short.mp4");
  assert(fs.existsSync(file) && fs.statSync(file).size > 100_000, "short.mp4 on disk", `${(fs.statSync(file).size / 1e6).toFixed(1)} MB`);

  const probe = ffprobeJson(file);
  const videoStream = probe.streams.find((s) => s.codec_type === "video");
  const audioStream = probe.streams.find((s) => s.codec_type === "audio");
  assert(videoStream.width === 1080 && videoStream.height === 1920, "9:16 1080x1920 frame", `${videoStream.width}x${videoStream.height}`);
  assert(videoStream.codec_name === "h264", "h264 encoded");
  assert(Number(probe.format.duration) <= 45.5, "capped at ≤ 45s", `${Number(probe.format.duration).toFixed(1)}s`);
  assert(Number(probe.format.duration) >= 3, "at least 3s long");
  assert(Boolean(audioStream) && audioStream.codec_name === "aac", "audio track present (aac)");
  assert(fs.existsSync(path.join(UPLOAD_ROOT, storyVideo.id, "short-thumb.png")), "vertical cover frame saved");

  const stream = await fetch(`${API}/api/videos/${storyVideo.id}/mp4?variant=short`);
  assert(stream.status === 200 && stream.headers.get("content-type") === "video/mp4", "short streams via mp4?variant=short", `HTTP ${stream.status}`);
  const buf = Buffer.from(await stream.arrayBuffer());
  assert(buf.length > 100_000, "short bytes stream end-to-end", `${(buf.length / 1e6).toFixed(1)} MB`);

  const detail = (await j("GET", `/api/videos/${storyVideo.id}`)).data.video;
  assert(detail.hasShort && detail.shortUrl?.includes("variant=short"), "detail DTO exposes the short", detail.shortUrl);
  assert(detail.shortScene >= 1 && detail.shortScene <= detail.sceneCount, "short scene recorded", `scene ${detail.shortScene} of ${detail.sceneCount}`);

  // Re-cut with a pinned scene (job dedupe + re-roll path)
  const reCut = await j("POST", `/api/videos/${storyVideo.id}/short`, { sceneIndex: 2 });
  assert(reCut.status === 202 || reCut.status === 200, "pinned-scene re-cut accepted", `HTTP ${reCut.status}`);
  const deadline2 = Date.now() + 8 * 60 * 1000;
  let pinned = null;
  for (;;) {
    const { data } = await j("GET", `/api/videos/${storyVideo.id}/short`);
    if (!data.generating && (data.sceneIndex === 2 || data.error)) { pinned = data; break; }
    if (Date.now() > deadline2) throw new Error("re-cut timed out");
    await sleep(4000);
  }
  assert(pinned.sceneIndex === 2, "re-cut used the pinned scene", `scene ${pinned.sceneIndex}`);
  assert(pinned.hasShort, "re-cut landed");
}

// ---------- summary ----------
console.log("");
if (failures === 0) {
  step("ALL PASS — Phase 5 performance loop + auto-Shorts verified");
} else {
  step(`${failures} FAILURES — see above`);
  process.exitCode = 1;
}
await db.$disconnect();
