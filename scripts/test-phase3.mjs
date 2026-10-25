// TubeForge Phase 3 E2E — persistent jobs, crash recovery, rate budget,
// VLM quality gate, ASR narration check.
// Run: bun scripts/test-phase3.mjs   (or: node scripts/test-phase3.mjs)

import { PrismaClient } from "@prisma/client";

const API = "http://localhost:3000";
const db = new PrismaClient();

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

const doneStates = (jobs, kind, entityIds) =>
  entityIds.every((id) => jobs.some((x) => x.kind === kind && x.entityId === id && x.status === "done"));

const anyFailed = (jobs, kind, entityIds) =>
  jobs.find((x) => x.kind === kind && entityIds.includes(x.entityId) && x.status === "failed");

// ---------- setup: clean slate ----------
await db.job.deleteMany();
await db.video.updateMany({ data: { verifyReport: null } });
await db.video.updateMany({ where: { error: { not: null } }, data: { error: null } });
step("DB cleaned (jobs wiped, verify reports cleared)");

// ---------- 1. job history starts empty ----------
{
  const { status, data } = await j("GET", "/api/jobs");
  assert(status === 200 && Array.isArray(data.jobs) && data.jobs.length === 0, "GET /api/jobs returns empty list");
}

// ---------- pick subjects ----------
const videos = (await j("GET", "/api/videos")).data.videos;
const storyVideo = videos.find((v) => v.format === "story" && v.hasVoiceover && v.hasStoryboard && v.sceneCount >= 3);
const classics = videos.filter((v) => v.format !== "story" && v.title);
assert(Boolean(storyVideo), "found a rendered story video", storyVideo?.title);
assert(classics.length >= 2, "found classic videos for thumbnail tests", classics.map((v) => v.title).slice(0, 3).join(" | "));
const [classicA, classicB] = classics;
if (!storyVideo || classics.length < 2) { console.log("aborting"); process.exit(1); }

// ---------- 2. crash recovery simulation ----------
{
  const stale = new Date(Date.now() - 24 * 60 * 60 * 1000); // definitely before process boot
  await db.job.create({ data: { kind: "render", entityId: storyVideo.id, status: "running", startedAt: stale } });
  await db.job.create({ data: { kind: "verify", entityId: classicA.id, status: "running", startedAt: stale } });
  step("inserted 2 stale 'running' rows (24h old)");

  // GET /api/jobs triggers ensureRecovered()
  const { status, data } = await j("GET", "/api/jobs");
  assert(status === 200, "GET /api/jobs after crash-sim");
  const interrupted = (data.jobs ?? []).filter((x) => x.status === "interrupted");
  assert(interrupted.length === 2, "both stale rows marked interrupted", `${interrupted.length}/2`);
  assert(
    interrupted.every((x) => x.error && x.error.includes("Server restarted")),
    "interrupted rows carry a restart explanation"
  );
  assert(
    interrupted.every((x) => x.entityTitle && x.entityTitle !== x.entityId),
    "job rows resolve entity titles"
  );

  const a = await db.video.findUnique({ where: { id: classicA.id } });
  assert(Boolean(a?.error && a.error.includes("Server restarted")), "video.error surfaced to the interrupted video", a?.error ?? "");

  // clean the injected error + fake rows so the rest of the test runs clean
  await db.video.update({ where: { id: classicA.id }, data: { error: null } });
  await db.job.deleteMany({ where: { status: "interrupted" } });
  step("recovery verified, injected artifacts cleaned");
}

// ---------- 3. concurrent thumbnails through the budget + quality gate ----------
{
  const [ra, rb] = await Promise.all([
    j("POST", `/api/videos/${classicA.id}/thumbnail`),
    j("POST", `/api/videos/${classicB.id}/thumbnail`),
  ]);
  assert(ra.status === 202 && rb.status === 202, "both thumbnail jobs accepted (202)");

  const t = Date.now();
  const watched = [classicA.id, classicB.id];
  let failure = null;
  await poll(
    "/api/jobs",
    (data) => {
      const jobs = data.jobs ?? [];
      const failed = anyFailed(jobs, "thumbnail", watched);
      if (failed) { failure = failed.error ?? "thumbnail job failed"; return true; }
      return doneStates(jobs, "thumbnail", watched);
    },
    6 * 60 * 1000,
    4000
  );
  if (failure) throw new Error(failure);
  const secs = Math.round((Date.now() - t) / 1000);
  const { data } = await j("GET", "/api/jobs");
  const rows = (data.jobs ?? []).filter((x) => x.kind === "thumbnail" && watched.includes(x.entityId));
  assert(rows.length === 2 && rows.every((r) => r.status === "done"), "both thumbnail jobs completed (serialized by budget)", `${secs}s`);
  assert(rows.every((r) => r.durationMs > 10_000), "job rows carry durations");

  // quality gate ran (activity feed gets a "quality" stage entry)
  const stats = (await j("GET", "/api/stats")).data.stats ?? {};
  const qualityEntries = (stats.recent ?? []).filter((a) => a.stage === "quality");
  assert(qualityEntries.length >= 1, "VLM quality gate logged to the activity feed", qualityEntries.map((q) => q.message).join(" /// "));
}

// ---------- 4. ASR narration check on the story video ----------
{
  const { status } = await j("POST", `/api/videos/${storyVideo.id}/verify`);
  assert(status === 202, "verify job accepted (202)");

  const final = await poll(
    `/api/videos/${storyVideo.id}/verify`,
    (data) => !data.generating,
    8 * 60 * 1000,
    3000
  );
  if (final.error) throw new Error(`narration check errored: ${final.error}`);
  const report = final.report;

  assert(Boolean(report), "narration check produced a report");
  if (report) {
    assert(["excellent", "good", "needs-review"].includes(report.verdict), "report has a verdict", report.verdict);
    assert(report.similarity >= 0.7, `script-to-audio similarity ${Math.round(report.similarity * 100)}%`);
    assert(report.scriptWords > 80, "script word count sane", String(report.scriptWords));
    assert(Array.isArray(report.scenes) && report.scenes.length >= 3, "per-scene scores present", report.scenes.map((s) => `${s.index}:${Math.round(s.similarity * 100)}%`).join(" "));
    assert(report.transcriptPreview.length > 50, "transcript preview captured");
  }

  // the report persists + the job row is recorded
  const again = (await j("GET", `/api/videos/${storyVideo.id}/verify`)).data;
  assert(again.report?.similarity === report?.similarity, "report persisted on GET");
}

// ---------- 5. job history reflects the live runs ----------
{
  const { data } = await j("GET", "/api/jobs");
  const jobs = data.jobs ?? [];
  assert(jobs.filter((x) => x.status === "done").length >= 3, "history shows done jobs (2 thumbnails + verify)");
  assert(jobs.every((x) => x.status !== "running"), "no jobs stuck in running");
}

// ---------- 6. settings round-trip ----------
{
  const put = await j("PUT", "/api/settings", {
    qualityGate: "all",
    qualityThreshold: 5,
    aiBudgetEnabled: true,
    aiTtsPerMin: 10,
  });
  const s = put.data.settings ?? {};
  assert(s.qualityGate === "all" && s.qualityThreshold === "5", "quality gate settings persist");
  assert(s.aiBudgetEnabled === "true" && s.aiTtsPerMin === "10", "budget settings persist");

  // restore defaults
  await j("PUT", "/api/settings", { qualityGate: "thumbnails", qualityThreshold: "6", aiTtsPerMin: "12" });
  step("settings restored to defaults");
}

console.log("");
if (failures === 0) {
  console.log(`ALL PHASE 3 E2E CHECKS PASSED (${Math.round((Date.now() - t0) / 1000)}s)`);
} else {
  console.log(`${failures} CHECK(S) FAILED`);
  process.exitCode = 1;
}
await db.$disconnect();
