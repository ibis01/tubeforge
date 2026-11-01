// Stage 3 completion-gate integration test (T-3.5).
//
// ROADMAP.md Stage 3 gate: "A video job can survive an application restart,
// resume safely where possible, and make its resulting assets available to
// the correct user."
//
// This script PROVES the durable-resume half of that gate end-to-end against
// the real queue + real worker process:
//
//   1. Seed a tenant (org/user/membership/video) + a Job row that looks
//      exactly like a job that died mid-run: status "running", claimed by a
//      provably dead pid, started an hour ago.
//   2. Start the standalone worker (scripts/worker.mts) — a FRESH process,
//      i.e. "the application restarted".
//   3. Boot recovery must (a) recognize the row as stale via the dead-pid
//      claim check, (b) re-enqueue it because "stock" has a registered
//      handler, (c) the worker must then claim it and execute
//      runStockRefresh under the tenant context restored from the row.
//   4. The job lands "done" with the worker's claim stamp.
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

async function main() {
  console.log("◆ Stage 3 — queue restart-recovery integration (completion gate)");

  // ---- 1. seed a tenant + an orphaned running job -------------------------
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
  const video = await db.video.create({
    data: {
      organizationId: org.id,
      topic: `Queue probe ${run}`,
      niche: "Motivation",
      format: "story", // stock is a story-format kind…
      scenes: JSON.stringify({ scenes: [] }), // …with ZERO scenes → handler no-ops cleanly, no AI calls
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

  // A second row WITHOUT a handler kind — must stay interrupted (the honest
  // degradation), never silently re-run.
  const orphanNoHandler = await db.job.create({
    data: {
      organizationId: org.id,
      userId: user.id,
      kind: "voiceover",
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
    env: { ...process.env, TUBEFORGE_LOG_LEVEL: process.env.TUBEFORGE_LOG_LEVEL ?? "info" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let workerLog = "";
  worker.stdout.on("data", (c) => (workerLog += c.toString()));
  worker.stderr.on("data", (c) => (workerLog += c.toString()));

  try {
    // ---- 3. wait for the resume to happen ---------------------------------
    let resumed: { status: string; claimedBy: string | null; attempts: number } | null = null;
    let interrupted: { status: string } | null = null;
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
      if (resumed?.status === "done" && interrupted?.status === "interrupted") break;
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
      interrupted?.status === "interrupted",
      `non-handler kind interrupted honestly, not re-run (got "${interrupted?.status}")`
    );
    const videoAfter = await db.video.findUnique({ where: { id: video.id } });
    ok(
      Boolean(videoAfter?.error?.includes("voiceover")),
      `the visible error is attributed to the INTERRUPTED voiceover stage, not the resumed stock job (got "${videoAfter?.error}")`
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

main().catch((err) => {
  console.error("[test-queue] fatal:", err);
  process.exit(1);
});
