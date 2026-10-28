// TubeForge Phase 4 E2E — engagement kit, greenlight pipeline, ASR-synced
// captions, YouTube OAuth upload guardrails.
// Run: bun scripts/test-phase4.mjs   (or: node scripts/test-phase4.mjs)

import { PrismaClient } from "@prisma/client";
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
  try { data = await res.json(); } catch { /* streams */ }
  return { status: res.status, data };
}

async function poll(url, predicate, timeoutMs, intervalMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { status, data } = await j("GET", url);
    if (status !== 200) throw new Error(`HTTP ${status} on ${url}`);
    if (predicate(data)) return data;
    if (Date.now() > deadline) throw new Error(`timeout polling ${url}`);
    await sleep(intervalMs);
  }
}

// ---------- setup ----------
await db.video.updateMany({ where: { error: { not: null } }, data: { error: null } });
await db.setting.deleteMany({ where: { key: { startsWith: "yt" } } });
await db.video.updateMany({ data: { commentsKit: null, youtubeUrl: null } });
step("DB cleaned (yt settings wiped, kits + youtube urls cleared)");

// ---------- pick subjects ----------
const videos = (await j("GET", "/api/videos")).data.videos;
const storyVideo = videos.find(
  (v) => v.format === "story" && v.hasVoiceover && v.hasStoryboard && v.sceneCount >= 3
);
assert(Boolean(storyVideo), "found a story video with storyboard + voiceover", storyVideo?.title);
if (!storyVideo) { console.log("aborting"); process.exit(1); }

// ============ 1. ENGAGEMENT KIT ============
{
  step("--- 1. Engagement kit (retention comments) ---");
  const started = await j("POST", `/api/videos/${storyVideo.id}/comments`);
  assert(started.status === 202, "POST /comments accepted as 202 background job");

  const res = await poll(`/api/videos/${storyVideo.id}/comments`, (d) => !d.generating, 3 * 60 * 1000);
  const kit = res.error ? null : res.kit;
  assert(Boolean(kit), "kit generated");
  if (kit) {
    assert(
      typeof kit.pinnedComment === "string" && kit.pinnedComment.length > 40,
      "pinned comment is substantive",
      `${kit.pinnedComment.length} chars`
    );
    assert(
      Array.isArray(kit.replies) && kit.replies.length >= 2 &&
        kit.replies.every((r) => r.trigger && r.text.length > 20),
      "reply templates ready",
      `${kit.replies.length} replies`
    );
    assert(
      Array.isArray(kit.heartTargets) && kit.heartTargets.length >= 2,
      "heart targets listed",
      kit.heartTargets.length.toString()
    );
    assert(
      typeof kit.strategy === "string" && kit.strategy.length > 80,
      "playback strategy paragraph present",
      `${kit.strategy.length} chars`
    );
  } else {
    step(`kit error: ${res.error}`);
  }
  const row = await db.video.findUnique({ where: { id: storyVideo.id } });
  assert(Boolean(row.commentsKit), "kit persisted on the video row");
}

// ============ 2. GREENLIGHT PIPELINE ============
{
  step("--- 2. Greenlight: Topic Radar idea -> scene story ---");
  let sessions = (await j("GET", "/api/research?limit=10")).data.sessions;
  if (!sessions.length) {
    step("no scans stored — running a fresh Topic Radar scan…");
    const scan = await j("POST", "/api/research", { niche: "Mysteries", query: "ancient mysteries" });
    assert(scan.status === 200 && scan.data.session?.ideas?.length, "fresh research scan succeeded",
      scan.data.session?.ideas?.length + " ideas");
    sessions = [scan.data.session];
  }
  const session = sessions[0];
  const idea = session.ideas.find((i) => i.keywords.length > 0) ?? session.ideas[0];
  assert(Boolean(idea), "picked a radar idea", idea.title);

  const greenlit = await j("POST", `/api/research/${session.id}/greenlight`, {
    ideaId: idea.id,
    format: "story",
  });
  assert(
    greenlit.status === 200 && greenlit.data.video?.id,
    "greenlight created a scripted video",
    greenlit.data.video?.title ?? greenlit.data.error
  );
  const gv = greenlit.data.video;
  if (gv) {
    assert(gv.format === "story", "video is scene-based story format");
    assert((gv.sceneCount ?? 0) >= 3, "scene outline written", `${gv.sceneCount} scenes`);
    assert(gv.status === "scripted", "video landed in scripted state");
    assert(gv.length === idea.suggestedLength, "idea's suggested length adopted",
      `${gv.length} (idea: ${idea.suggestedLength})`);
    const tagList = (gv.tags ?? "").split(",").map((t) => t.trim().toLowerCase());
    const keptKeywords = idea.keywords.filter((k) => tagList.includes(k.toLowerCase()));
    assert(
      keptKeywords.length > 0,
      "radar SEO keywords unioned into tags",
      `${keptKeywords.length}/${idea.keywords.length}: ${keptKeywords.slice(0, 3).join(", ")}`
    );
    // cleanup: delete the greenlit draft so the library stays tidy
    await db.video.delete({ where: { id: gv.id } });
    step(`greenlit draft "${gv.title}" deleted after verification`);
  }
}

// ============ 3. ASR-SYNCED CAPTIONS ============
{
  step("--- 3. Smart captions (silence + ASR aligned) ---");
  // Wait out any render already in flight (a stale job would 200-dedupe our POST).
  await poll(`/api/videos/${storyVideo.id}/render`, (d) => !d.rendering, 10 * 60 * 1000, 5000)
    .catch((e) => step(`pre-render drain warning: ${e.message}`));

  const beforeSrt = fs.existsSync(path.join(UPLOAD_ROOT, storyVideo.id, "subtitles.srt"))
    ? fs.readFileSync(path.join(UPLOAD_ROOT, storyVideo.id, "subtitles.srt"), "utf8")
    : "";
  const beforeCues = (beforeSrt.match(/^\d+$/gm) ?? []).length;

  const started = await j("POST", `/api/videos/${storyVideo.id}/render`, {
    mode: "kenburns",
    subtitles: true,
    smartCaptions: true,
    music: true,
  });
  assert(started.status === 202, "render with smartCaptions accepted (202)");

  const renderRes = await poll(
    `/api/videos/${storyVideo.id}/render`,
    (d) => !d.rendering,
    10 * 60 * 1000,
    5000
  );
  assert(!renderRes.error, "render completed without error", renderRes.error ?? "clean");

  const srtPath = path.join(UPLOAD_ROOT, storyVideo.id, "subtitles.srt");
  assert(fs.existsSync(srtPath), "subtitles.srt exported");
  const srt = fs.existsSync(srtPath) ? fs.readFileSync(srtPath, "utf8") : "";
  const cueCount = (srt.match(/^\d+$/gm) ?? []).length;
  assert(
    cueCount > (storyVideo.sceneCount ?? 0) * 2,
    "cue count exploded vs one-caption-per-scene",
    `${beforeCues} -> ${cueCount} cues (${storyVideo.sceneCount} scenes)`
  );

  // Cues must carry narration words, not the old static scene captions.
  const full = (await j("GET", `/api/videos/${storyVideo.id}`)).data.video;
  const narrationWords = new Set(
    (full.script ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 3)
  );
  const cueText = srt.split(/\n\n/).map((b) => b.split("\n").slice(2).join(" ")).join(" ").toLowerCase();
  const covered = [...narrationWords].filter((w) => cueText.includes(w)).length;
  assert(
    narrationWords.size > 0 && covered / narrationWords.size > 0.7,
    "cue text carries the actual narration",
    `${Math.round((covered / Math.max(narrationWords.size, 1)) * 100)}% of narration words appear in cues`
  );

  // Monotonic timeline check: every cue starts after the previous one.
  const times = [...srt.matchAll(/(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> /g)].map(
    (m) => +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000
  );
  const monotonic = times.every((t, i) => i === 0 || t > times[i - 1]);
  assert(monotonic, "cue timeline is monotonic", `${times.length} cue start times`);
  assert(
    times.length > 0 && times[times.length - 1] <= (full.videoDuration ?? 0) + 1,
    "cues end within the video duration",
    `last cue starts ${times[times.length - 1]?.toFixed(1)}s, video ${full.videoDuration}s`
  );
}

// ============ 4. YOUTUBE UPLOAD GUARDRAILS ============
{
  step("--- 4. YouTube OAuth upload guardrails ---");
  let status = (await j("GET", "/api/youtube/status")).data.status;
  assert(status.configured === false, "starts unconfigured");
  assert(status.callbackUrl.endsWith("/api/youtube/callback"), "callback URL exposed", status.callbackUrl);

  const res1 = await j("POST", `/api/videos/${storyVideo.id}/upload`);
  assert(res1.status === 400, "upload without connection rejected (400)", res1.data.error ?? "");

  const saved = await j("PUT", "/api/youtube/config", {
    clientId: "test-apps.googleusercontent.com",
    clientSecret: "GOCSPX-test-secret",
    privacyStatus: "unlisted",
  });
  assert(saved.status === 200, "OAuth credentials save");

  status = (await j("GET", "/api/youtube/status")).data.status;
  assert(status.configured === true, "status flips to configured");
  assert(status.connected === false, "…but still not connected (no refresh token)");
  assert(status.clientId === "test-apps.googleusercontent.com", "client id echoed for the edit form");

  const res2 = await j("POST", `/api/videos/${storyVideo.id}/upload`);
  assert(res2.status === 400, "upload with configured-but-not-connected rejected (400)", res2.data.error ?? "");

  const consent = await j("POST", "/api/youtube/connect");
  assert(consent.status === 200 && String(consent.data.authUrl ?? "").startsWith("https://accounts.google.com/"),
    "consent URL built", String(consent.data.authUrl ?? consent.data.error).slice(0, 60));

  const cb = await j("GET", "/api/youtube/callback?code=x&state=wrong");
  assert(cb.status === 400, "callback rejects mismatched CSRF state", "state guard works");

  const disc = await j("POST", "/api/youtube/disconnect");
  assert(disc.status === 200, "disconnect endpoint responds");
  status = (await j("GET", "/api/youtube/status")).data.status;
  assert(status.connected === false, "status stays disconnected after disconnect");

  const cleared = await j("PUT", "/api/youtube/config", { clientId: "keep", privacyStatus: "private" });
  assert(cleared.status === 200, "privacy-only config update accepted");
  status = (await j("GET", "/api/youtube/status")).data.status;
  assert(status.privacyStatus === "private", "privacy setting round-trips", status.privacyStatus);
}

// ============ 5. ZIP EXPORT INCLUDES THE KIT ============
{
  step("--- 5. ZIP export ships the engagement kit ---");
  const res = await fetch(`${API}/api/videos/${storyVideo.id}/export`);
  assert(res.ok, "export endpoint 200");
  const buf = Buffer.from(await res.arrayBuffer());
  // Scan the raw zip for the entry name (stored/deflated central directory text is enough)
  const names = ["engagement-kit.txt", "upload-metadata.txt", "final.mp4"];
  for (const name of names) {
    assert(buf.includes(Buffer.from(name)), `zip contains ${name}`);
  }
}

// ---------- summary ----------
console.log("");
if (failures === 0) {
  console.log(`ALL PASS — Phase 4 growth engine verified in ${Math.round((Date.now() - t0) / 1000)}s`);
} else {
  console.log(`${failures} FAILURE(S)`);
  process.exitCode = 1;
}
await db.$disconnect();
