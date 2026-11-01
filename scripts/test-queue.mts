// Stage 3 completion-gate integration test (T-3.5 + close-out).
//
// ROADMAP.md Stage 3 gate: "A video job can survive an application restart,
// resume safely where possible, and make its resulting assets available to
// the correct user."
//
// This script PROVES the durable-resume contract end-to-end against the real
// queue + real worker process:
//
//   A. IN-PROCESS — the handler registry + payload plumbing:
//      registerDefaultHandlers registers every resumable kind (and NOT the
//      unimplemented "upload" kind), and a claimed handler receives the
//      entityId + the PARSED Job.payload the route stored at enqueue time.
//
//   B. WORKER PROCESS (a FRESH process = "the application restarted"):
//      1. Seed tenants + Job rows that look exactly like jobs that died
//         mid-run: status "running", claimed by a provably dead pid.
//      2. Start the standalone worker (scripts/worker.mts).
//      3. Boot recovery must (a) recognize the rows as stale via the
//         dead-pid claim check, (b) re-enqueue handler kinds, (c) the worker
//         claims and executes them under the tenant context restored from
//         the row. The zero-scenes stock job lands "done" (clean no-op);
//         the per-scene stock job DISPATCHES to the scene logic (visible
//         error about missing stock keys — not the old silent no-op where a
//         composite "<videoId>#scene<N>" id made runStockRefresh findUnique
//         null and quietly "finish").
//      4. A kind WITHOUT a handler ("upload" — YouTube publishing is Stage 6
//         and nothing enqueues it yet) stays "interrupted" with a readable
//         error on the video row: the honest degradation, never a silent
//         re-run or a zombie row.
//
// Run: npm run test:queue     (needs the local SQLite DB; not in CI)

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

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

/** A story video row shape with N scenes (parseScenes reads a bare array). */
const scenesJson = (n: number) =>
  JSON.stringify(
    Array.from({ length: n }, (_, i) => ({
      index: i + 1,
      title: `Scene ${i + 1}`,
      narration: "Probe narration.",
      visual: "a probe visual",
      mood: "cinematic",
    }))
  );

// ---------------------------------------------------------------------------
// Phase A — in-process: registry + payload delivery
// ---------------------------------------------------------------------------
async function phaseA(): Promise<void> {
  console.log("◆ Stage 3 close-out — handler registry + payload delivery (in-process)");

  const { registerDefaultHandlers, resumableKinds } = await import(
    "../src/lib/tubeforge/queue-handlers"
  );
  const { registerJobHandler, handlerKinds, createPendingJob, kickQueue, initQueue, setClaiming } =
    await import("../src/lib/tubeforge/queue");

  registerDefaultHandlers();
  initQueue("web");

  // Registry completeness — every kind the routes start must be resumable.
  const kinds = handlerKinds();
  for (const kind of resumableKinds()) {
    ok(kinds.includes(kind), `handler registered for "${kind}"`);
  }
  ok(!kinds.includes("upload"), `"upload" (Stage 6, never enqueued) stays unregistered`);

  // Payload delivery — spy on one kind, enqueue with a payload, claim it.
  const run = `p${Date.now().toString(36)}`;
  const org = await db.organization.create({
    data: { name: `Payload Probe ${run}`, slug: `payload-probe-${run}` },
  });
  const user = await db.user.create({
    data: {
      email: `payload-${run}@tubeforge.test`,
      passwordHash: "pbkdf2$120000$probe$probe",
      name: "Payload Probe",
    },
  });
  await db.membership.create({
    data: { userId: user.id, organizationId: org.id, role: "owner" },
  });

  let spyEntityId = "";
  let spyPayload: unknown = "never-called";
  registerJobHandler("slide", async (entityId, payload) => {
    spyEntityId = entityId;
    spyPayload = payload;
  });

  const { jobId } = await createPendingJob({
    organizationId: org.id,
    userId: user.id,
    kind: "slide",
    entityId: "probe-video#slide2",
    payload: { sceneIndex: 2, instruction: "make it night" },
  });

  let row: { status: string } | null = null;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    kickQueue();
    await sleep(250);
    row = await db.job.findUnique({ where: { id: jobId }, select: { status: true } });
    if (row?.status === "done") break;
  }

  ok(row?.status === "done", `payload job claimed + executed (status="${row?.status}")`);
  ok(spyEntityId === "probe-video#slide2", `handler received the entityId ("${spyEntityId}")`);
  ok(
    JSON.stringify(spyPayload) === JSON.stringify({ sceneIndex: 2, instruction: "make it night" }),
    `handler received the PARSED payload (${JSON.stringify(spyPayload)})`
  );

  // Corrupt payload degrades to null instead of killing the job.
  const corrupt = await db.job.create({
    data: {
      organizationId: org.id,
      userId: user.id,
      kind: "slide",
      entityId: "probe-video#slide3",
      status: "pending",
      payload: "{not json",
    },
  });
  let corruptSeen: unknown = "never-called";
  registerJobHandler("slide", async (_entityId, payload) => {
    corruptSeen = payload;
  });
  const corruptDeadline = Date.now() + 20_000;
  let corruptRow: { status: string } | null = null;
  while (Date.now() < corruptDeadline) {
    kickQueue();
    await sleep(250);
    corruptRow = await db.job.findUnique({ where: { id: corrupt.id }, select: { status: true } });
    if (corruptRow?.status === "done") break;
  }
  ok(corruptRow?.status === "done", `corrupt payload still executes (status="${corruptRow?.status}")`);
  ok(corruptSeen === null, `corrupt payload degrades to null (${JSON.stringify(corruptSeen)})`);

  await db.organization.delete({ where: { id: org.id } }).catch(() => {});
  await db.user.delete({ where: { id: user.id } }).catch(() => {});

  // Hand the queue to the spawned worker in phase B — this process must not
  // race it for the resumed rows (its claim loop would win sometimes).
  setClaiming(false);
  console.log("");
}

// ---------------------------------------------------------------------------
// Phase B — worker process: restart recovery
// ---------------------------------------------------------------------------
async function phaseB(): Promise<void> {
  console.log("◆ Stage 3 — queue restart-recovery integration (completion gate)");

  // ---- 1. seed tenants + orphaned running jobs ----------------------------
  const run = `q${Date.now().toString(36)}`;
  const org = await db.organization.create({
    data: { name: `Queue Probe ${run}`, slug: `queue-probe-${run}` },
  });
  const user = await db.user.create({
    data: {
      email: `queue-${run}@tubeforge.test`,
      passwordHash: "pbkdf2$120000$probe$probe",
      name: "Queue Probe",
    },
  });
  await db.membership.create({
    data: { userId: user.id, organizationId: org.id, role: "owner" },
  });

  // Video 1 — zero scenes: the stock handler no-ops cleanly (no AI calls).
  const video = await db.video.create({
    data: {
      organizationId: org.id,
      topic: `Queue probe ${run}`,
      niche: "Motivation",
      format: "story",
      scenes: scenesJson(0),
    },
  });

  // The orphan: "running", claimed by a process that is provably dead
  // (pid 4194304 is never allocated on Linux), started an hour ago.
  // attempts=1 mirrors a real claim cycle by the dead process.
  const orphan = await db.job.create({
    data: {
      organizationId: org.id,
      userId: user.id,
      kind: "stock",
      entityId: video.id,
      status: "running",
      claimedBy: "web:4194304:deadbeef",
      claimedAt: new Date(Date.now() - 3_600_000),
      startedAt: new Date(Date.now() - 3_600_000),
      attempts: 1,
    },
  });
  console.log(`  seeded org=${org.id} video=${video.id} orphanJob=${orphan.id}`);

  // Video 2 — one real scene: a PER-SCENE stock job (entityId "<id>#scene1").
  // Pre-close-out this resumed as a silent no-op (runStockRefresh got the
  // composite id, findUnique came back null, job "finished" doing nothing).
  // Now the handler must dispatch to runStockSceneJob — observable as the
  // missing-stock-keys error landing on the video row.
  const video2 = await db.video.create({
    data: {
      organizationId: org.id,
      topic: `Queue probe scenes ${run}`,
      niche: "Motivation",
      format: "story",
      scenes: scenesJson(1),
    },
  });
  const orphanPerScene = await db.job.create({
    data: {
      organizationId: org.id,
      userId: user.id,
      kind: "stock",
      entityId: `${video2.id}#scene1`,
      status: "running",
      claimedBy: "web:4194304:deadbeef",
      claimedAt: new Date(Date.now() - 3_600_000),
      startedAt: new Date(Date.now() - 3_600_000),
      attempts: 1,
    },
  });

  // A third row WITHOUT a handler kind — must stay interrupted (the honest
  // degradation), never silently re-run. "upload" (YouTube publishing,
  // Stage 6) is the only kind nothing registers today.
  const orphanNoHandler = await db.job.create({
    data: {
      organizationId: org.id,
      userId: user.id,
      kind: "upload",
      entityId: video.id,
      status: "running",
      claimedBy: "web:4194304:deadbeef",
      startedAt: new Date(Date.now() - 3_600_000),
      attempts: 1,
    },
  });

  // ---- 2. start the worker (the "restart") --------------------------------
  const worker = spawn("node", ["--import", "tsx", "scripts/worker.mts"], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "production", // quiet the Prisma query log in the worker output
      TUBEFORGE_LOG_LEVEL: process.env.TUBEFORGE_LOG_LEVEL ?? "info",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let workerLog = "";
  worker.stdout.on("data", (c) => (workerLog += c.toString()));
  worker.stderr.on("data", (c) => (workerLog += c.toString()));

  try {
    // ---- 3. wait for the resume to happen ---------------------------------
    let resumed: { status: string; claimedBy: string | null; attempts: number } | null = null;
    let interrupted: { status: string } | null = null;
    let perScene: { status: string; error: string | null } | null = null;
    let perSceneVideoError: string | null = null;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await sleep(500);
      resumed = await db.job.findUnique({
        where: { id: orphan.id },
        select: { status: true, claimedBy: true, attempts: true },
      });
      interrupted = await db.job.findUnique({
        where: { id: orphanNoHandler.id },
        select: { status: true },
      });
      perScene = await db.job.findUnique({
        where: { id: orphanPerScene.id },
        select: { status: true, error: true },
      });
      perSceneVideoError = (await db.video.findUnique({
        where: { id: video2.id },
        select: { error: true },
      }))?.error ?? null;
      if (
        resumed?.status === "done" &&
        interrupted?.status === "interrupted" &&
        (perSceneVideoError?.includes("No stock provider") || perScene?.status === "failed")
      )
        break;
    }

    // ---- 4. assertions -----------------------------------------------------
    ok(resumed?.status === "done", `handler-kind job resumed to done (got "${resumed?.status}")`);
    ok(
      resumed !== null && Boolean(resumed.claimedBy?.startsWith("worker:")),
      `executed by the worker process (claimedBy="${resumed?.claimedBy}")`
    );
    ok(
      resumed !== null && resumed.attempts >= 2,
      `attempts counted the original claim + the resume (attempts=${resumed?.attempts})`
    );
    ok(
      perSceneVideoError?.includes("No stock provider") || perScene?.error?.includes("No stock provider"),
      `per-scene stock job DISPATCHED to the scene handler (video error: "${perSceneVideoError}")`
    );
    ok(
      interrupted?.status === "interrupted",
      `non-handler kind interrupted honestly, not re-run (got "${interrupted?.status}")`
    );
    const videoAfter = await db.video.findUnique({ where: { id: video.id } });
    ok(
      Boolean(videoAfter?.error?.includes("YouTube upload")),
      `the visible error is attributed to the INTERRUPTED upload stage, not the resumed stock job (got "${videoAfter?.error}")`
    );
  } finally {
    worker.kill("SIGTERM");
    await sleep(1_000);
    worker.kill("SIGKILL");

    // ---- cleanup: cascade removes video + jobs + membership ----------------
    await db.organization.delete({ where: { id: org.id } }).catch(() => {});
    await db.user.delete({ where: { id: user.id } }).catch(() => {});
    await db.$disconnect();
  }

  if (failed) {
    console.error("\nworker log tail:\n" + workerLog.split("\n").slice(-15).join("\n"));
    process.exit(1);
  }
  console.log("\nqueue restart-recovery: PASS");
}

async function main() {
  await phaseA();
  await phaseB();
}

main().catch((err) => {
  console.error("[test-queue] fatal:", err);
  process.exit(1);
});
