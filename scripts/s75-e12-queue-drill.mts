// S75 E12 — the LIVE queue drill for the WHITEBOARD JobKind (the deferred
// E12 ledger row, executed). The durable-resume contract is already proven
// generically by scripts/test-queue.mts; this drill proves the WHITEBOARD
// kind inherits it, against the real queue, the real worker process and a
// REAL chromium+ffmpeg render:
//
//   A. REGISTRY TRUTH (in-process) — resumableKinds() (the live handler
//      registry) is the source of truth; the /api/jobs/cancel route's
//      cancellable-kind list must equal it. This caught a REAL production
//      defect on 2026-11-10: the route's hand-maintained literal was
//      missing "whiteboard" (and six other registered kinds), so the Stop
//      button 400'd on a running whiteboard render — an UNCANCELLABLE
//      render. Fixed this stage: the route now derives its list from the
//      registry; this act re-proves the equality against the live module.
//
//   B. RESTART RECOVERY → REAL RENDER (fresh worker process) — seed a
//      video (renderMode "whiteboard") carrying a real scaffolded project
//      doc + a Job row that looks exactly like a whiteboard render that
//      DIED MID-RUN ("running", claimed by a provably dead pid). Boot the
//      standalone worker: it must (a) recognize the stale claim, (b)
//      re-enqueue the whiteboard kind, (c) claim and EXECUTE it under the
//      tenant context restored from the row — and the render must actually
//      LAND (video.hasVideo, a probed duration, final.mp4 on the storage
//      driver, the "Whiteboard rendered" activity row). Never a silent
//      no-op, never "No tenant context (runWhiteboardJob)".
//
//   C. COOPERATIVE CANCEL MID-RENDER (in-process, real render) — enqueue a
//      long whiteboard render through startJob (the route's exact path,
//      under a real tenant context), let it pass at least one progress
//      checkpoint, then requestJobCancel(entityId, "whiteboard") — the
//      exact call the fixed route makes. The engine must unwind at the
//      next frame-batch checkpoint, the Job row must land "cancelled"
//      (never "failed", never a retry), the entity error stays null and
//      the activity row records the design's promise: "completed scenes
//      kept, run it again to restart".
//
// Run:  node --import tsx scripts/s75-e12-queue-drill.mts
// Needs the local SQLite DB + the local storage driver. Not in CI — this
// is the recorded E12 receipt; test-queue.mts remains the standing suite.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";
import { scaffoldWhiteboardProject } from "../src/lib/tubeforge/whiteboard/whiteboard-planner";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const db = new PrismaClient();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failed = false;
function ok(cond: unknown, msg: string): asserts cond {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    failed = true;
    console.error(`  ✗ ${msg}`);
  }
}

const DEAD_CLAIM = "web:4194304:deadbeef"; // pid 4194304 is never allocated on Linux

/** A long-enough narration to keep a render busy; words → estimated scene
 *  duration via the timing law (~2.6 wps + the 350ms tail). */
const narration = (words: number) =>
  Array.from({ length: words }, (_, i) => `word${i + 1}`).join(" ") + ".";

function projectDoc(words: number) {
  // The native scaffold (the planner's own builder — the same code the
  // Studio scaffolds with): real scenes, real placements, deterministic.
  return JSON.stringify({
    rev: 1,
    project: scaffoldWhiteboardProject({
      topic: "E12 drill",
      scenes: [{ index: 1, title: "The drill scene", narration: narration(words) }],
    }),
  });
}

async function seedTenants(run: string) {
  const org = await db.organization.create({
    data: { name: `E12 Drill ${run}`, slug: `e12-drill-${run}` },
  });
  const user = await db.user.create({
    data: {
      email: `e12-drill-${run}@tubeforge.test`,
      passwordHash: "pbkdf2$120000$probe$probe",
      name: "E12 Drill",
    },
  });
  await db.membership.create({
    data: { userId: user.id, organizationId: org.id, role: "owner" },
  });
  return { org, user };
}

async function seedWhiteboardVideo(orgId: string, topic: string, doc: string) {
  return db.video.create({
    data: {
      organizationId: orgId,
      topic,
      niche: "Motivation",
      format: "story",
      renderMode: "whiteboard",
      scenes: JSON.stringify([
        {
          index: 1,
          title: "The drill scene",
          narration: narration(8),
          visual: "probe",
          mood: "cinematic",
        },
      ]),
      whiteboardProject: doc,
    },
  });
}

// ---------------------------------------------------------------------------
// Act A — registry truth: the cancel route derives from the live registry
// ---------------------------------------------------------------------------
async function actA(): Promise<void> {
  console.log("◆ Act A — registry truth: cancellable kinds == resumable kinds");

  const { resumableKinds } = await import("../src/lib/tubeforge/queue-handlers");
  const registry = resumableKinds();

  ok(
    registry.includes("whiteboard"),
    "the whiteboard kind is in the live resumable registry"
  );

  // The fixed route must carry NO hand-maintained literal — source-level
  // tripwire in the same style the S75 unit pins use.
  const routeSrc = fs.readFileSync("src/app/api/jobs/cancel/route.ts", "utf8");
  ok(
    routeSrc.includes("resumableKinds()"),
    "the cancel route derives KINDS from resumableKinds() (the registry)"
  );
  ok(
    !/const KINDS: JobKind\[\] = \[\s*"/.test(routeSrc),
    "the cancel route carries no hand-maintained kind literal"
  );

  console.log(`  registry kinds (${registry.length}): ${registry.join(", ")}`);
}

// ---------------------------------------------------------------------------
// Act B — restart recovery → a REAL whiteboard render by a fresh worker
// ---------------------------------------------------------------------------
async function actB(): Promise<void> {
  console.log("◆ Act B — restart recovery: a dead worker's whiteboard render lands");
  const run = `b${Date.now().toString(36)}`;
  const { org, user } = await seedTenants(run);
  const video = await seedWhiteboardVideo(
    org.id,
    `E12 recovery probe ${run}`,
    projectDoc(14) // ~6s estimated scene — a small but REAL render
  );
  const orphan = await db.job.create({
    data: {
      organizationId: org.id,
      userId: user.id,
      kind: "whiteboard",
      entityId: video.id,
      status: "running",
      claimedBy: DEAD_CLAIM,
      claimedAt: new Date(Date.now() - 3_600_000),
      startedAt: new Date(Date.now() - 3_600_000),
      attempts: 1,
    },
  });
  console.log(`  seeded org=${org.id} video=${video.id} orphanJob=${orphan.id}`);

  // The fresh worker (the "application restarted").
  const worker = spawn("node", ["--import", "tsx", "scripts/worker.mts"], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "production", // quiet the Prisma query log in worker output
      TUBEFORGE_LOG_LEVEL: process.env.TUBEFORGE_LOG_LEVEL ?? "info",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let workerLog = "";
  worker.stdout.on("data", (c) => (workerLog += c.toString()));
  worker.stderr.on("data", (c) => (workerLog += c.toString()));

  try {
    let row: {
      status: string;
      claimedBy: string | null;
      attempts: number;
      error: string | null;
    } | null = null;
    const deadline = Date.now() + 300_000; // a real render — 5 minutes
    while (Date.now() < deadline) {
      await sleep(1_000);
      row = await db.job.findUnique({
        where: { id: orphan.id },
        select: { status: true, claimedBy: true, attempts: true, error: true },
      });
      if (row && ["done", "failed", "cancelled", "interrupted"].includes(row.status)) break;
    }

    ok(
      row?.status === "done",
      `the orphaned whiteboard job resumed to done (got "${row?.status}"${row?.error ? `: ${row.error.slice(0, 140)}` : ""})`
    );
    ok(
      Boolean(row?.claimedBy?.startsWith("worker:")),
      `executed by the fresh worker process (claimedBy="${row?.claimedBy}")`
    );
    ok(
      (row?.attempts ?? 0) >= 2,
      `attempts counted the dead claim + the resume (attempts=${row?.attempts})`
    );

    const v = await db.video.findUnique({
      where: { id: video.id },
      select: { hasVideo: true, videoDuration: true, error: true },
    });
    ok(v?.hasVideo === true, "video.hasVideo landed (the standard player key)");
    ok(
      (v?.videoDuration ?? 0) >= 3,
      `videoDuration probed from the real file (${v?.videoDuration}s — the probe must run BEFORE putFromPath renames the output away)`
    );
    ok(!v?.error, `the video row carries no error ("${v?.error ?? "null"}")`);

    // The artifact exists on the local storage driver.
    const { videoDir } = await import("../src/lib/tubeforge/ai");
    const finalPath = path.join(videoDir(video.id), "final.mp4");
    ok(fs.existsSync(finalPath), `final.mp4 exists on the storage driver (${finalPath})`);

    const activity = await db.activity.findFirst({
      where: { videoId: video.id, stage: "render" },
      orderBy: { createdAt: "desc" },
      select: { message: true },
    });
    ok(
      Boolean(activity?.message.startsWith("Whiteboard rendered")),
      `the activity row records the render ("${activity?.message ?? "none"}")`
    );
  } finally {
    worker.kill("SIGTERM");
    await sleep(2_000);
    worker.kill("SIGKILL");
    if (failed) console.log(`  [worker log tail] ${workerLog.slice(-600).replace(/\n+/g, " | ")}`);
  }
}

// ---------------------------------------------------------------------------
// Act C — cooperative cancel mid-render (in-process, real render)
// ---------------------------------------------------------------------------
async function actC(): Promise<void> {
  console.log("◆ Act C — cooperative cancel: Stop on a running whiteboard render");
  const run = `c${Date.now().toString(36)}`;
  const { org, user } = await seedTenants(run);
  const video = await seedWhiteboardVideo(
    org.id,
    `E12 cancel probe ${run}`,
    projectDoc(70) // ~30s estimated scene — many frame-batch checkpoints
  );

  const { registerDefaultHandlers } = await import("../src/lib/tubeforge/queue-handlers");
  const { initQueue } = await import("../src/lib/tubeforge/queue");
  const { startJob, requestJobCancel } = await import("../src/lib/tubeforge/jobs");
  const { runWhiteboardJob } = await import("../src/lib/tubeforge/video-jobs");
  const { withCtx } = await import("../src/lib/tubeforge/tenant");

  registerDefaultHandlers();
  initQueue("web"); // this process plays the web role: enqueue + local claim

  // The route's exact enqueue: startJob under a real tenant context.
  const accepted = await withCtx(
    { userId: user.id, organizationId: org.id, role: "owner" },
    () => startJob(video.id, "whiteboard", () => runWhiteboardJob(video.id))
  );
  ok(accepted, "startJob accepted the whiteboard render (the route's 202 path)");

  // Wait for the claim + at least one frame-batch checkpoint (progress
  // fires every 24 frames — the guard's cancel check runs BEFORE each
  // progress write, so one progress write = one checkpoint survived).
  let claimed = false;
  let progress: number | null = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 120_000) {
    await sleep(500);
    const row = await db.job.findFirst({
      where: { entityId: video.id, kind: "whiteboard" },
      orderBy: { createdAt: "desc" },
      select: { status: true, progress: true },
    });
    if (row?.status === "running" && row.progress !== null) {
      claimed = true;
      progress = row.progress;
      break;
    }
    if (row && ["done", "failed", "cancelled", "interrupted"].includes(row.status)) break;
  }
  ok(claimed, `the render claimed and passed ≥1 progress checkpoint (progress=${progress})`);

  // The fixed route's exact call.
  const stopped = await requestJobCancel(video.id, "whiteboard");
  ok(
    stopped.includes("whiteboard"),
    `requestJobCancel(entityId, "whiteboard") flags the running render (stopped=${JSON.stringify(stopped)})`
  );

  // The engine unwinds at the next checkpoint; the row lands "cancelled".
  let finalStatus: string | null = null;
  const t1 = Date.now();
  while (Date.now() - t1 < 120_000) {
    await sleep(500);
    const row = await db.job.findFirst({
      where: { entityId: video.id, kind: "whiteboard" },
      orderBy: { createdAt: "desc" },
      select: { status: true, error: true },
    });
    if (row && ["done", "failed", "cancelled", "interrupted"].includes(row.status)) {
      finalStatus = row.status;
      break;
    }
  }
  ok(
    finalStatus === "cancelled",
    `the Job row lands "cancelled" (got "${finalStatus}") — never failed, never retried`
  );

  const v = await db.video.findUnique({
    where: { id: video.id },
    select: { error: true },
  });
  ok(!v?.error, `the video row's error stays null ("${v?.error ?? "null"}")`);

  const activity = await db.activity.findFirst({
    where: { videoId: video.id, stage: "render" },
    orderBy: { createdAt: "desc" },
    select: { message: true },
  });
  ok(
    Boolean(activity?.message.includes("completed scenes kept")),
    `the activity row records the design's promise ("${activity?.message ?? "none"}")`
  );
}

// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log("═ S75 E12 — the live whiteboard queue drill ═");
  const t0 = Date.now();

  try {
    await actA();
    await actB();
    await actC();
  } finally {
    // Cleanup: the org delete cascades videos/jobs/activities; the render
    // artifacts ride the local storage driver's videoDir.
    const orgs = await db.organization.findMany({
      where: { slug: { startsWith: "e12-drill-" } },
      select: { id: true },
    });
    for (const o of orgs) {
      const vids = await db.video.findMany({
        where: { organizationId: o.id },
        select: { id: true },
      });
      for (const v of vids) {
        try {
          const { videoDir } = await import("../src/lib/tubeforge/ai");
          fs.rmSync(videoDir(v.id), { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
      await db.organization.delete({ where: { id: o.id } }).catch(() => {});
    }
    await db.$disconnect();
  }

  const secs = Math.round((Date.now() - t0) / 1000);
  if (failed) {
    console.error(`\nE12 QUEUE DRILL: FAIL (${secs}s)`);
    process.exit(1);
  }
  console.log(`\nE12 QUEUE DRILL: PASS (${secs}s) — recovery renders for real; Stop really stops`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[e12-drill] fatal:", err);
  process.exit(1);
});
