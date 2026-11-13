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
//      registerDefaultHandlers registers every resumable kind — ALL 20
//      JobKind values, exhaustively ("upload" joined in Stage 6; the old
//      "!upload" assertion predated it) — and a claimed handler receives
//      the entityId + the PARSED Job.payload the route stored at enqueue
//      time.
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
//         null and quietly "finish"). The RENDER job (S39) proves the
//         ctx-restore for a job body that calls assertCtx FIRST: it must
//         fail at the storyboard gate ("Generate the storyboard first"),
//         NEVER at "No tenant context (runRenderJob)" — the S37 live
//         failure on a render re-run after a daemon restart.
//      4. A kind WITHOUT a handler — probed with a SYNTHETIC "legacy-probe"
//         kind, since Stage 6 registered "upload" and no real JobKind is
//         unregistered anymore — stays "interrupted" with a readable error
//         on the job row: the honest degradation, never a silent re-run or
//         a zombie row. (Pre-S33-fix this probe used "upload" and had
//         silently rotted: the suite is not in CI, so the Stage 6
//         registration never updated it.)
//
// Run: npm run test:queue     (needs the local SQLite DB)
//
// NOTE (S88 follow-up, 2026-11-11): this suite IS in CI — the check job
// (since the 2026-11-05 external-audit response) and the money-path coverage
// job both run it. The stale "not in CI" claim here is what let the S88
// "reference" kind land without updating the Phase A ledger — CI caught it
// (twice), this local run did not. The ledger below is a PIN: a new JobKind
// that registers a handler must be added here in the same slice.

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
  // resumableKinds() is registry-derived (S33 contract fix), so the loop is
  // a tautology by construction; the real pin is exhaustiveness — all 25
  // JobKind values registered, no strays (whiteboard joined in S67,
  // consistency in S77, reference in S88, scene3d in S94, scene-recheck in
  // S116).
  const kinds = handlerKinds();
  for (const kind of resumableKinds()) {
    ok(kinds.includes(kind), `handler registered for "${kind}"`);
  }
  const allKinds = [
    "script", "research", "stock", "voiceover", "storyboard", "scene",
    "render", "short", "convert", "verify", "comments", "director",
    "continuity", "thumbnail", "variants", "slide", "qc", "upload",
    "portrait", "poses", "whiteboard", "consistency", "reference", "scene3d",
    "scene-recheck",
  ];
  ok(
    allKinds.every((k) => kinds.includes(k)),
    "all 25 JobKind values are handler-registered (upload since Stage 6, whiteboard since S67, consistency since S77, reference since S88, scene3d since S94, scene-recheck since S116)"
  );
  ok(kinds.length === allKinds.length, `no stray handler kinds (got ${kinds.length})`);

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
// Phase C — S100 / P0.2: leases + fencing (concurrent-worker + stale-worker
// battery). Runs BEFORE phase B (whose finally disconnects the shared client)
// and function-level, against the REAL database: claimJob/renewLease/
// reapExpiredLeases/writeOutcomeIfLeased are the primitives the tick and the
// executor use — exercising them directly IS the two-worker simulation.
// setClaiming(false) already ran at the end of phase A, so this process
// cannot race the probe rows.
// ---------------------------------------------------------------------------
async function phaseC(): Promise<void> {
  console.log("◆ S100 / P0.2 — leases + fencing (concurrent-worker + stale-worker battery)");
  const { claimJob, renewLease, reapExpiredLeases, writeOutcomeIfLeased, LEASE_TTL_MS } = await import(
    "../src/lib/tubeforge/queue"
  );

  const run = `l${Date.now().toString(36)}`;
  const org = await db.organization.create({
    data: { name: `Lease Probe ${run}`, slug: `lease-probe-${run}` },
  });

  try {
    ok(LEASE_TTL_MS >= 30_000, `the lease TTL is long enough for real renders (${LEASE_TTL_MS}ms)`);

    const job = await db.job.create({
      data: {
        organizationId: org.id,
        kind: "stock", // handler-registered — inside the reap scope
        entityId: "lease-probe-entity",
        status: "pending",
        maxAttempts: 5,
      },
    });

    // 1. Worker A claims — the row is LEASED with a monotonic fencing token.
    const a = await claimJob(job.id, "workerA:1:x");
    ok(a.claimed, "worker A claims the pending job");
    ok(a.leaseToken >= 1, `the claim stamps a monotonic fencing token (token=${a.leaseToken})`);
    const row1 = await db.job.findUnique({
      where: { id: job.id },
      select: { leaseExpiresAt: true, claimedBy: true, attempts: true },
    });
    ok(row1?.claimedBy === "workerA:1:x", "the claim stamps the claimant");
    ok(
      row1?.leaseExpiresAt !== null && row1 !== null && (row1.leaseExpiresAt as Date).getTime() > Date.now(),
      "the lease expires in the future (TTL honored)"
    );
    ok(row1?.attempts === 1, `the claim counted an attempt (attempts=${row1?.attempts})`);

    // 2. THE CONCURRENT-WORKER LAW: worker B cannot claim a LIVE lease.
    const b = await claimJob(job.id, "workerB:1:x");
    ok(!b.claimed, "worker B cannot claim a LIVE lease (0 rows affected)");

    // 3. Renewal extends the deadline for the current token only.
    const deadlineBefore = (row1?.leaseExpiresAt as Date).getTime();
    await sleep(20);
    ok(await renewLease(job.id, a.leaseToken), "renewLease extends the CURRENT token's lease");
    ok(!(await renewLease(job.id, 999)), "renewLease refuses a FOREIGN token");
    const row2 = await db.job.findUnique({ where: { id: job.id }, select: { leaseExpiresAt: true } });
    ok(
      (row2?.leaseExpiresAt as Date).getTime() > deadlineBefore,
      "the deadline moved forward after renewal"
    );

    // 4. Worker A "dies" (the lease stops being renewed) — force it past,
    //    then reap. The reap is scoped to handler kinds: a non-handler row
    //    must be untouched (boot recovery owns that story).
    await db.job.update({ where: { id: job.id }, data: { leaseExpiresAt: new Date(Date.now() - 1_000) } });
    const stranger = await db.job.create({
      data: {
        organizationId: org.id,
        kind: "legacy-probe", // NOT handler-registered
        entityId: "lease-probe-entity",
        status: "running",
        claimedBy: "web:4194304:deadbeef",
        claimedAt: new Date(Date.now() - 3_600_000),
        leaseExpiresAt: new Date(Date.now() - 1_000),
        startedAt: new Date(Date.now() - 3_600_000),
        attempts: 1,
      },
    });
    const reaped = await reapExpiredLeases();
    ok(reaped >= 1, `the reap pass reclaimed expired handler-kind leases (${reaped})`);
    const row3 = await db.job.findUnique({ where: { id: job.id } });
    ok(row3?.status === "pending", `expired lease reaped → pending (got "${row3?.status}")`);
    ok(row3?.claimedBy === null, "the reap clears the dead claimant");
    ok(
      row3?.leaseToken === a.leaseToken + 1,
      `the reap BUMPED the fencing token (${a.leaseToken} → ${row3?.leaseToken}) — the stale worker is now write-blind`
    );
    const strangerRow = await db.job.findUnique({ where: { id: stranger.id }, select: { status: true } });
    ok(
      strangerRow?.status === "running",
      "a NON-handler kind is not reaped — boot recovery owns that row (the honest interrupted path)"
    );

    // 5. THE STALE-WORKER FENCE — the heart of P0.2. Worker B claims the
    //    reaped row; worker A's in-flight completion must hit 0 rows.
    const b2 = await claimJob(job.id, "workerB:2:x");
    ok(
      b2.claimed && b2.leaseToken > a.leaseToken,
      `worker B claims the reaped row with a NEWER token (${b2.leaseToken})`
    );
    const fenced = await writeOutcomeIfLeased(job.id, a.leaseToken, {
      status: "done",
      endedAt: new Date(),
      progress: 1,
      error: null,
    });
    ok(!fenced, "the STALE worker's completion is FENCED (0 rows affected)");
    const row4 = await db.job.findUnique({
      where: { id: job.id },
      select: { status: true, claimedBy: true },
    });
    ok(
      row4?.status === "running" && row4?.claimedBy === "workerB:2:x",
      `the row still belongs to worker B — the stale write did NOT land (status=${row4?.status}, claimedBy=${row4?.claimedBy})`
    );
    const won = await writeOutcomeIfLeased(job.id, b2.leaseToken, {
      status: "done",
      endedAt: new Date(),
      progress: 1,
      error: null,
    });
    ok(won, "the CURRENT token holder completes");
    const row5 = await db.job.findUnique({ where: { id: job.id }, select: { status: true } });
    ok(row5?.status === "done", "the job lands done — exactly ONE worker's write wins");

    // 6. Attempts counted both claim cycles (the reap itself adds none).
    const row6 = await db.job.findUnique({ where: { id: job.id }, select: { attempts: true } });
    ok(row6 !== null && row6.attempts >= 2, `attempts counted both claim cycles (attempts=${row6?.attempts})`);

    await db.job.delete({ where: { id: stranger.id } });
  } finally {
    await db.organization.delete({ where: { id: org.id } }).catch(() => {});
  }
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
  // degradation), never silently re-run. Since Stage 6 registered "upload"
  // (a crashed publish now resumes with the user's title/privacy picks), no
  // real JobKind is unregistered anymore — so the no-handler branch is
  // probed with a SYNTHETIC kind a real route could never enqueue.
  const orphanNoHandler = await db.job.create({
    data: {
      organizationId: org.id,
      userId: user.id,
      kind: "legacy-probe",
      entityId: video.id,
      status: "running",
      claimedBy: "web:4194304:deadbeef",
      startedAt: new Date(Date.now() - 3_600_000),
      attempts: 1,
    },
  });

  // S39 — a stale RENDER row. The render handler's FIRST act is
  // assertCtx("runRenderJob"), so this row is the ctx-restore probe: it
  // must fail at the storyboard gate (the video has scenes but no art),
  // proving the worker restored the tenant scope from the row — never the
  // S37 live failure ("No tenant context (runRenderJob)"). Two scenes and
  // a persisted payload mirror what the render route enqueues.
  const videoRender = await db.video.create({
    data: {
      organizationId: org.id,
      topic: `Queue probe render ${run}`,
      niche: "Motivation",
      format: "story",
      scenes: scenesJson(2),
    },
  });
  const orphanRender = await db.job.create({
    data: {
      organizationId: org.id,
      userId: user.id,
      kind: "render",
      entityId: videoRender.id,
      status: "running",
      claimedBy: "web:4194304:deadbeef",
      claimedAt: new Date(Date.now() - 3_600_000),
      startedAt: new Date(Date.now() - 3_600_000),
      attempts: 1,
      payload: JSON.stringify({ mode: "kenburns" }),
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
    let interrupted: { status: string; error: string | null } | null = null;
    let perScene: { status: string; error: string | null } | null = null;
    let perSceneVideoError: string | null = null;
    let renderRow: { status: string; error: string | null; claimedBy: string | null; attempts: number } | null = null;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await sleep(500);
      resumed = await db.job.findUnique({
        where: { id: orphan.id },
        select: { status: true, claimedBy: true, attempts: true },
      });
      interrupted = await db.job.findUnique({
        where: { id: orphanNoHandler.id },
        select: { status: true, error: true },
      });
      perScene = await db.job.findUnique({
        where: { id: orphanPerScene.id },
        select: { status: true, error: true },
      });
      perSceneVideoError = (await db.video.findUnique({
        where: { id: video2.id },
        select: { error: true },
      }))?.error ?? null;
      renderRow = await db.job.findUnique({
        where: { id: orphanRender.id },
        select: { status: true, error: true, claimedBy: true, attempts: true },
      });
      const renderSettled =
        renderRow !== null &&
        (renderRow.status === "failed" || renderRow.status === "done" || renderRow.status === "interrupted");
      if (
        resumed?.status === "done" &&
        interrupted?.status === "interrupted" &&
        (perSceneVideoError?.includes("No stock provider") || perScene?.status === "failed") &&
        renderSettled
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
    ok(
      typeof interrupted?.error === "string" &&
        interrupted.error.includes("legacy-probe") &&
        interrupted.error.includes("restarted"),
      `the interrupted row carries the readable restart message (got "${interrupted?.error}")`
    );
    const videoAfter = await db.video.findUnique({ where: { id: video.id } });
    ok(
      videoAfter?.error == null,
      `the synthetic kind has no video surface — the video row stays clean (got "${videoAfter?.error}")`
    );

    // S39 — the render recovery ran under a RESTORED tenant context.
    ok(
      renderRow?.status === "failed",
      `recovered render job executed to a terminal state (got "${renderRow?.status}")`
    );
    ok(
      typeof renderRow?.error === "string" && renderRow.error.includes("storyboard"),
      `the render job failed at the storyboard gate — ctx restored (got "${renderRow?.error}")`
    );
    ok(
      typeof renderRow?.error === "string" && !renderRow.error.includes("No tenant context"),
      `the render job NEVER hit "No tenant context" (got "${renderRow?.error}")`
    );
    ok(
      renderRow !== null && Boolean(renderRow.claimedBy?.startsWith("worker:")),
      `the render job was executed by the worker (claimedBy="${renderRow?.claimedBy}")`
    );
    ok(
      renderRow !== null && renderRow.attempts >= 2,
      `the render attempts counted the original claim + the resume (attempts=${renderRow?.attempts})`
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
  await phaseC();
  await phaseB();
}

main().catch((err) => {
  console.error("[test-queue] fatal:", err);
  process.exit(1);
});
