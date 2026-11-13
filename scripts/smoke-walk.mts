#!/usr/bin/env node
/**
 * P0.6 docker-smoke walk phase (docs/production-readiness.md).
 *
 *   docker compose exec -T web node --import tsx scripts/smoke-walk.mts --phase 1|2|3
 *
 * Runs INSIDE the web container of the composed production topology — real
 * Postgres, real MinIO (s3 driver), real worker container. Phases:
 *
 *   1  the topology reality: migration chain complete on the live Postgres,
 *      S100/S101 column projections, the HTTP-registered user's rows exist,
 *      a REAL mp4 (ffmpeg, in-image) round-trips put→get through the s3
 *      driver into MinIO with the S101 reservation lifecycle settled, a
 *      stock job is enqueued for the WORKER container to execute, and a
 *      REAL whiteboard project renders IN-CONTAINER through the worker's
 *      chromium (DEPLOYMENT §5.1's ask — the engine lane, $0 AI: planner
 *      scaffold over the built-in library, final.mp4 + ffprobe'd duration)
 *   2  (worker stopped by the host) seeds the recovery scenario: an
 *      expired-lease RUNNING job (the S100 dead-worker fingerprint) and a
 *      pending job — both waiting for a live reaper
 *   3  (worker started by the host) the recovery landed: the pending job
 *      executed and the expired-lease job was reaped (leaseToken bumped)
 *      and executed to done — in the WORKER process, cross-container
 *
 * Exit 0 = the phase held. Any failure exits 1 (the smoke is the gate).
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const phase = (() => {
  const i = process.argv.indexOf("--phase");
  const v = i > -1 ? process.argv[i + 1] : "1";
  if (v !== "1" && v !== "2" && v !== "3") throw new Error(`unknown phase ${v}`);
  return v;
})();

const db = new PrismaClient();
let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const SMOKE_EMAIL = "smoke@example.com";
const SMOKE_TOPIC = "Docker smoke";
const POLL_MS = 1_000;
const POLL_DEADLINE_MS = 90_000;

async function pollUntil(
  name: string,
  fn: () => Promise<boolean>,
  deadlineMs: number = POLL_DEADLINE_MS,
): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await fn()) {
      check(name, true);
      return true;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  check(name, false, "deadline reached");
  return false;
}

async function smokeCtx() {
  const user = await db.user.findUniqueOrThrow({ where: { email: SMOKE_EMAIL } });
  const membership = await db.membership.findFirstOrThrow({ where: { userId: user.id } });
  return { userId: user.id, organizationId: membership.organizationId, role: membership.role as "owner" };
}

async function phase1(): Promise<void> {
  // --- the migration chain is complete on the REAL Postgres ---
  const chainDir = path.join(process.cwd(), "prisma", "migrations");
  const dirs = existsSync(chainDir)
    ? (await import("node:fs")).readdirSync(chainDir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).length
    : -1;
  const applied = (await db.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL`,
  ))[0];
  check(
    "the migration chain deployed COMPLETELY on the composed Postgres",
    dirs > 0 && Number(applied?.n ?? 0) >= dirs,
    `${applied?.n ?? 0} applied / ${dirs} in the chain`,
  );

  // --- the S100/S101 column reality (the P2022 guard, on the real DB) ---
  await db.job.findMany({ take: 1 });
  check("Job projects the lease columns (S100 deployed on the topology)", true);
  await db.storageReservation.findMany({ take: 1 });
  check("StorageReservation projects (S101 deployed on the topology)", true);

  // --- the HTTP-registered user's rows exist (register → org → membership) ---
  const user = await db.user.findUnique({ where: { email: SMOKE_EMAIL } });
  check("the HTTP-registered user landed", !!user, user ? user.email : "(missing)");
  const ctx = await smokeCtx();

  // --- the video created through POST /api/videos exists ---
  const video = await db.video.findFirst({ where: { topic: SMOKE_TOPIC }, orderBy: { createdAt: "desc" } });
  check("the video created through the API landed", !!video, video ? video.id : "(missing)");
  if (!video) throw new Error("the API-created video is missing — the walk cannot continue");

  // --- the object store must exist before the first put: CreateBucket IS a
  // plain PUT /bucket in S3 — done here through the PRODUCTION SigV4 signer
  // from inside the container (also proves the host-gateway route). Works on
  // MinIO AND SeaweedFS; 409 = already exists on a re-run. ---
  const { s3Config, s3Fetch } = await import("../src/lib/tubeforge/storage-s3");
  const s3cfg = s3Config();
  if (!s3cfg) throw new Error("the s3 driver env is missing in the smoke container");
  const mkBucket = await s3Fetch("PUT", "", s3cfg);
  check(
    "the artifact bucket exists (CreateBucket through the SigV4 signer)",
    mkBucket.ok || mkBucket.status === 409,
    `status ${mkBucket.status}`,
  );

  // --- a REAL mp4 round-trips through the s3 driver into MinIO ---
  const scratch = "/tmp/smoke-render.mp4";
  execSync(
    "ffmpeg -y -f lavfi -i color=c=black:s=128x128:d=0.3 -r 24 -c:v libx264 -pix_fmt yuv420p /tmp/smoke-render.mp4",
    { stdio: "ignore" },
  );
  const bytes = readFileSync(scratch);
  check("ffmpeg (in-image) rendered a real mp4", bytes.length > 0, `${bytes.length} bytes`);

  const { put, get, usageBytes } = await import("../src/lib/tubeforge/storage");
  const { withCtx } = await import("../src/lib/tubeforge/tenant");
  await withCtx(ctx, () => put("smoke/smoke-render.mp4", bytes));
  const back = await withCtx(ctx, () => get("smoke/smoke-render.mp4"));
  check("the artifact round-tripped put→get through MinIO (s3 driver)", back.equals(bytes), `${back.length} bytes back`);
  const usage = await withCtx(ctx, () => usageBytes(ctx.organizationId));
  check("the S101 counter settled the committed bytes", usage >= bytes.length, `${usage} committed`);
  const holds = await db.storageReservation.count({ where: { organizationId: ctx.organizationId } });
  check("the S101 hold settled (0 in-flight after commit)", holds === 0, `${holds} left`);

  // --- enqueue a stock job for the WORKER container (zero scenes → done) ---
  await db.job.create({
    data: {
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      kind: "stock",
      entityId: video.id,
      status: "pending",
      maxAttempts: 2,
      nextRunAt: new Date(),
      startedAt: new Date(),
    },
  });
  await pollUntil("the WORKER container claimed + finished the cross-process job", async () => {
    const row = await db.job.findFirst({ where: { kind: "stock", entityId: video.id, status: "done" } });
    return row !== null;
  });

  // --- the WORKER's chromium contract (DEPLOYMENT §5.1 — the one tail the
  // topology smoke had not walked): a REAL whiteboard render IN-CONTAINER,
  // through the job lane, executed by the worker process. $0 AI — the
  // planner scaffold places assets from the BUILT-IN library (module-
  // constant SVGs, bundled by construction); one scene at 640×360@24 with
  // an explicit 4000ms window (96 frames — the acceptance battery's fast
  // shape); no VO (a silent draft is a legal render); music off for a
  // deterministic silence. The worker launches chromium, rasterizes the
  // frames, encodes with ffmpeg, and ships final.mp4 through the s3 driver
  // — every layer of §5.1's launch-args + per-scene-memory contract on the
  // real image. ---
  const { scaffoldWhiteboardProject, serializeWhiteboardDoc, parseWhiteboardDoc } =
    await import("../src/lib/tubeforge/whiteboard/whiteboard-planner");
  const wbTopic = "Docker smoke whiteboard";
  const wbProject = scaffoldWhiteboardProject({
    scenes: [{ index: 1, title: "The smoke", narration: "the container renders this whiteboard scene" }],
    topic: wbTopic,
    width: 640,
    height: 360,
    fps: 24,
  });
  wbProject.scenes[0].durationMs = 4000; // explicit window — 96 frames
  const wbVideo = await db.video.create({
    data: {
      organizationId: ctx.organizationId,
      topic: wbTopic,
      niche: "demo",
      renderMode: "whiteboard",
      musicEnabled: false, // deterministic silence — no Settings dependency
      whiteboardProject: serializeWhiteboardDoc({ rev: 1, project: wbProject }),
    },
  });
  check(
    "the whiteboard video seeded (renderMode + a parseable doc column)",
    parseWhiteboardDoc(wbVideo.whiteboardProject) !== null,
  );

  const { createPendingJob } = await import("../src/lib/tubeforge/queue");
  await createPendingJob({
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    kind: "whiteboard",
    entityId: wbVideo.id,
  });

  // The render poll is fail-FAST on a terminal row (a broken image reports
  // its error immediately instead of burning the deadline), and generous
  // when it must wait: chromium boot + 96 frames + encode inside the worker
  // container is minutes on a CI runner, not seconds.
  const wbDeadline = Date.now() + 300_000;
  let wbTerminal: { status: string; error: string | null } | null = null;
  while (Date.now() < wbDeadline && wbTerminal === null) {
    const row = await db.job.findFirst({
      where: { kind: "whiteboard", entityId: wbVideo.id },
      orderBy: { createdAt: "desc" },
      select: { status: true, error: true },
    });
    if (row && (row.status === "done" || row.status === "failed")) wbTerminal = row;
    else await new Promise((r) => setTimeout(r, POLL_MS));
  }
  check(
    "the WORKER container rendered the whiteboard video IN-CONTAINER (chromium + ffmpeg)",
    wbTerminal?.status === "done",
    wbTerminal
      ? `${wbTerminal.status}${wbTerminal.error ? " — " + wbTerminal.error.slice(0, 200) : ""}`
      : "deadline reached (300s)",
  );
  if (wbTerminal?.status !== "done") return; // the artifact asserts below depend on the render

  const wbFinal = await withCtx(ctx, () => get(`${wbVideo.id}/final.mp4`));
  check("the whiteboard final.mp4 landed in the object store", wbFinal.length > 0, `${wbFinal.length} bytes`);
  const wbScratch = "/tmp/smoke-wb-final.mp4";
  writeFileSync(wbScratch, wbFinal);
  const wbProbe = execSync(
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1 ${wbScratch}`,
    { encoding: "utf8" },
  ).trim();
  const wbDur = Number(/duration=([\d.]+)/.exec(wbProbe)?.[1] ?? 0);
  check("ffprobe: the whiteboard final is a real video (duration > 0)", wbDur > 0, `${wbDur}s`);
  const wbRow = await db.video.findUnique({
    where: { id: wbVideo.id },
    select: { hasVideo: true, videoDuration: true },
  });
  check(
    "the video row recorded the render (hasVideo + duration)",
    wbRow?.hasVideo === true && (wbRow?.videoDuration ?? 0) > 0,
    `${wbRow?.videoDuration ?? 0}s`,
  );
}

async function phase2(): Promise<void> {
  const ctx = await smokeCtx();
  const video = await db.video.findFirstOrThrow({ where: { topic: SMOKE_TOPIC }, orderBy: { createdAt: "desc" } });

  // The S100 dead-worker fingerprint: a RUNNING row whose lease expired —
  // seeded while the worker is DOWN; the live reaper must reclaim it.
  await db.job.create({
    data: {
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      kind: "stock",
      entityId: `${video.id}#recovery`,
      status: "running",
      maxAttempts: 2,
      attempts: 1,
      claimedBy: "worker:0:deadbeef",
      claimedAt: new Date(Date.now() - 120_000),
      leaseToken: 5,
      leaseExpiresAt: new Date(Date.now() - 60_000),
      nextRunAt: new Date(),
      startedAt: new Date(Date.now() - 120_000),
    },
  });
  // And the plain restart case: a pending job enqueued while the worker is down.
  await db.job.create({
    data: {
      organizationId: ctx.organizationId,
      userId: ctx.userId,
      kind: "stock",
      entityId: `${video.id}#restart`,
      status: "pending",
      maxAttempts: 2,
      nextRunAt: new Date(),
      startedAt: new Date(),
    },
  });
  check("recovery scenario seeded (expired-lease running + pending) with the worker down", true);
}

async function phase3(): Promise<void> {
  const video = await db.video.findFirstOrThrow({ where: { topic: SMOKE_TOPIC }, orderBy: { createdAt: "desc" } });

  await pollUntil("the worker-RESTART pending job executed to done", async () => {
    const row = await db.job.findFirst({ where: { entityId: `${video.id}#restart`, status: "done" } });
    return row !== null;
  });

  await pollUntil("the EXPIRED-LEASE job was reaped and executed to done (the S100 law on the real topology)", async () => {
    const row = await db.job.findFirst({
      where: { entityId: `${video.id}#recovery`, status: "done" },
      select: { status: true, leaseToken: true },
    });
    return row !== null;
  });
  // Re-read after the poll (the closure stash TS cannot see through was a
  // latent type error the explicit scripts typecheck surfaced — S108).
  const recovered = await db.job.findFirst({
    where: { entityId: `${video.id}#recovery`, status: "done" },
    select: { status: true, leaseToken: true },
  });
  if (recovered) {
    check(
      "the reaper BUMPED the fencing token before reclaiming (5 → ≥6)",
      recovered.leaseToken >= 6,
      `leaseToken ${recovered.leaseToken}`,
    );
  }
}

const phases: Record<string, () => Promise<void>> = { "1": phase1, "2": phase2, "3": phase3 };

try {
  await phases[phase]();
  console.log("");
  if (failures > 0) {
    console.error(`smoke-walk phase ${phase}: ${failures} assertion(s) FAILED`);
    process.exit(1);
  }
  console.log(`smoke-walk phase ${phase}: held`);
} catch (err) {
  console.error(`smoke-walk phase ${phase}: crashed —`, err instanceof Error ? err.message : String(err));
  process.exit(1);
} finally {
  await db.$disconnect().catch(() => {});
}
