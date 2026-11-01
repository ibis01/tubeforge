// Durable queue handlers (Stage 3, T-3.5).
//
// Kinds whose ENTIRE work can be rebuilt from DB state register here. A
// registered kind:
//   * survives a process crash — boot recovery flips its stale "running" row
//     back to "pending" and any process re-runs it via the handler;
//   * can be executed by the standalone worker (scripts/worker.mts), which
//     never saw the original request closure.
//
// Kinds NOT registered (their closures capture request-scoped choices) keep
// the Stage-1 behavior: a crash marks them "interrupted" with a readable
// error, and the user re-kicks the stage. Handlers get extracted as their
// routes are refactored — this registry is the growth path.
//
// Registration happens in src/instrumentation.ts (web server boot) and
// scripts/worker.mts (standalone worker) — never from jobs.ts, which keeps
// the import graph acyclic.

import fs from "fs";
import path from "path";
import { db } from "./tenant-db";
import { assertCtx } from "./tenant";
import { registerJobHandler } from "./queue";
import { runScriptJob } from "./script-job";
import { runResearchScan } from "./research";
import { parseScenes } from "./story";
import { fetchStockForScenes } from "./stock";
import { isJobCancelled, setJobProgress, JobCancelledError, type JobKind } from "./jobs";
import { errorText } from "./redact";

const UPLOAD_ROOT = path.join(process.cwd(), "uploads");

/** Renders become stale when the visual track changes (mirrors the stock route). */
function invalidateRenders(videoId: string) {
  const dir = path.join(UPLOAD_ROOT, videoId);
  for (const f of ["final.mp4", "preview.mp4"]) {
    fs.rmSync(path.join(dir, f), { force: true });
  }
}

/**
 * The stock b-roll job body — extracted from POST /api/videos/[id]/stock
 * (Stage 3, T-3.5). Derives everything from the video row so a restart
 * resumes the fetch. `force` defaults to false on re-run (refresh only the
 * scenes still missing a clip — never nukes user-reviewed clips twice).
 */
export async function runStockRefresh(videoId: string, opts: { force?: boolean } = {}): Promise<void> {
  const ctx = assertCtx("runStockRefresh");
  const video = await db.video.findUnique({ where: { id: videoId } });
  if (!video) return; // deleted while queued — end quietly
  if (video.format !== "story") return; // not a scene video (format changed)

  const scenes = parseScenes(video.scenes);
  if (scenes.length === 0) return;

  try {
    const result = await fetchStockForScenes({
      videoId,
      scenes,
      force: opts.force ?? false,
      shouldCancel: () => isJobCancelled(videoId, "stock"),
      onProgress: (current, total, label) => {
        if (isJobCancelled(videoId, "stock")) throw new Error("__CANCELLED__");
        setJobProgress(videoId, "stock", current, total, label);
      },
    });

    invalidateRenders(videoId);
    await db.video.update({
      where: { id: videoId },
      data: { hasVideo: false, videoDuration: null, error: null },
    });
    await db.activity.create({
      data: {
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        videoId,
        stage: "stock",
        message: `Stock b-roll — ${result.fetched} clip${result.fetched === 1 ? "" : "s"} downloaded, ${result.matched}/${scenes.length} scenes covered`,
      },
    });
  } catch (err) {
    if (err instanceof Error && err.message === "__CANCELLED__") {
      await db.video.update({ where: { id: videoId }, data: { error: null } });
      await db.activity
        .create({
          data: {
            organizationId: ctx.organizationId,
            userId: ctx.userId,
            videoId,
            stage: "stock",
            message: "Stock fetch cancelled — matched clips were kept",
          },
        })
        .catch(() => {});
      throw new JobCancelledError();
    }
    const message = errorText(err, "Stock fetch failed");
    await db.video.update({ where: { id: videoId }, data: { error: message } }).catch(() => {});
    await db.activity
      .create({
        data: {
          organizationId: ctx.organizationId,
          userId: ctx.userId,
          videoId,
          stage: "stock",
          level: "error",
          message: `Stock fetch failed: ${message}`,
        },
      })
      .catch(() => {});
    throw err;
  }
}

/**
 * Register the DB-derivable kinds. Called once per process:
 *   web     — src/instrumentation.ts at server boot
 *   worker  — scripts/worker.mts entry
 *
 * script: runScriptJob re-reads the video row each round; the Topic-Radar
 * brief/extraKeywords captured by the original closure are lost on a restart
 * re-run — the documented degradation (see script-job.ts header).
 */
export function registerDefaultHandlers(): void {
  registerJobHandler("script", (videoId) => runScriptJob(videoId));
  registerJobHandler("research", (sessionId) => runResearchScan(sessionId));
  registerJobHandler("stock", (videoId) => runStockRefresh(videoId));
}

/** Test helper — the kinds this build can resume after a crash. */
export function resumableKinds(): JobKind[] {
  return ["script", "research", "stock"];
}
