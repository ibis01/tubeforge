import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { parseScenes, sceneImageFile } from "@/lib/tubeforge/story";
import { jobSnapshot, lastJobError } from "@/lib/tubeforge/jobs";
import * as storage from "@/lib/tubeforge/storage";
import { criticReportKey } from "@/lib/tubeforge/video-critic";
import {
  deriveBoardStages,
  deriveCheckpoints,
  type BoardInput,
} from "@/lib/tubeforge/production-board";
import { videoSpendMicroUsd } from "@/lib/tubeforge/cost-guard";

/**
 * S91 (ROADMAP #10) — the living production board, I/O half. One composed
 * snapshot for the project studio, backed ENTIRELY by the existing
 * database, storage and job system (the S76 §5 P4 law: no new pipeline,
 * no new tables — read what production already records):
 *
 *   stages      — script / storyboard / voice / render / publish, derived
 *                 (pure module, pinned) from DB flags, probed artifact
 *                 counts and the running-job snapshot
 *   jobs        — what is generating NOW + the last error per kind
 *   checkpoints — director plan approval, the QC ship gate, narration
 *                 verify, continuity, the critic verdict
 *   costs       — ORG-level usage context (30 days, capability ×
 *                 provider). Per-VIDEO cost attribution is a recorded
 *                 tail: UsageRecord has no videoId (the honest limit of
 *                 today's metering), and the board says so.
 *   history     — the Activity tail (production history, video-scoped)
 */

const HISTORY_LIMIT = 40;
const COST_WINDOW_DAYS = 30;
const COST_ROW_CAP = 2000;

/** Minimal critic verdict read — the report's own parse stays in the
 *  critic module; the board only needs the verdict field. */
function criticVerdictOf(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const v = (JSON.parse(raw) as { verdict?: unknown }).verdict;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });

  const scenes = parseScenes(video.scenes);
  const running = jobSnapshot(id);

  // ---- storyboard progress (lane-appropriate) ----
  let boardDone = 0;
  let boardTotal = 0;
  if (video.renderMode === "whiteboard") {
    // The whiteboard lane's "storyboard" IS the project doc.
    boardTotal = 1;
    try {
      const doc = video.whiteboardProject ? JSON.parse(video.whiteboardProject) : null;
      const sceneList = Array.isArray(doc?.scenes) ? doc.scenes.length : 0;
      if (sceneList > 0) {
        boardTotal = sceneList;
        boardDone = sceneList; // the scaffold is authored, not painted per-scene
      }
    } catch {
      /* corrupt doc — 0/1 stays */
    }
  } else if (scenes.length > 0) {
    // Image lanes: the scene-art files (storage stats — driver-safe).
    boardTotal = scenes.length;
    for (const s of scenes) {
      const st = await storage
        .stat(`${id}/${sceneImageFile(s.index)}`)
        .catch(() => null);
      if (st) boardDone++;
    }
  } else {
    boardTotal = 1;
    boardDone = video.hasStoryboard ? 1 : 0;
  }

  const input: BoardInput = {
    sceneCount: scenes.length,
    wordCount: video.wordCount,
    boardDone,
    boardTotal,
    stockMatched: scenes.filter((s) => s.stock != null).length,
    hasVoiceover: video.hasVoiceover,
    voiceSource: video.voiceSource,
    hasVideo: video.hasVideo,
    hasPreview: video.hasPreview,
    renderMode: video.renderMode,
    hasShort: video.hasShort,
    youtubeUrl: video.youtubeUrl,
    running: {
      script: running.script,
      storyboard: running.storyboard,
      stock: running.stock,
      voiceover: running.voiceover,
      render: running.render,
      whiteboard: running.whiteboard,
      qc: running.qc,
      upload: running.upload,
    },
  };

  // ---- checkpoints (report presence + the human gates) ----
  const criticRaw = await storage
    .get(criticReportKey(id))
    .then((b) => Buffer.from(b).toString("utf8"))
    .catch(() => null);
  const checkpoints = deriveCheckpoints({
    directorState: video.directorState,
    hasQcReport: Boolean(video.qcReport),
    qcOverrideAt: video.qcOverrideAt ? video.qcOverrideAt.toISOString() : null,
    hasVerifyReport: Boolean(video.verifyReport),
    hasConsistencyReport: Boolean(video.consistency),
    criticVerdict: criticVerdictOf(criticRaw),
  });

  // ---- costs: the video's own spend (the S113 UsageRecord bridge closed
  // the old "no per-video attribution" tail) + the org-level context ----
  const videoMicro = await videoSpendMicroUsd(id);
  const since = new Date(Date.now() - COST_WINDOW_DAYS * 86_400_000);
  const usageRows = await db.usageRecord.findMany({
    where: { organizationId: auth.ctx.organizationId, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
    take: COST_ROW_CAP,
    select: { capability: true, provider: true, costMicroUsd: true, ok: true },
  });
  const byLane = new Map<string, { capability: string; provider: string; calls: number; costMicroUsd: number }>();
  let totalMicro = 0;
  let totalCalls = 0;
  let failedCalls = 0;
  for (const r of usageRows) {
    const key = `${r.capability}::${r.provider}`;
    const lane = byLane.get(key) ?? { capability: r.capability, provider: r.provider, calls: 0, costMicroUsd: 0 };
    lane.calls++;
    lane.costMicroUsd += r.costMicroUsd;
    byLane.set(key, lane);
    totalMicro += r.costMicroUsd;
    totalCalls++;
    if (!r.ok) failedCalls++;
  }

  // ---- production history ----
  const history = await db.activity.findMany({
    where: { videoId: id },
    orderBy: { createdAt: "desc" },
    take: HISTORY_LIMIT,
    select: { id: true, stage: true, message: true, level: true, createdAt: true },
  });

  const lastErrors: Record<string, string> = {};
  for (const kind of ["script", "storyboard", "voiceover", "render", "whiteboard", "stock", "qc", "upload"] as const) {
    const err = lastJobError(id, kind);
    if (err) lastErrors[kind] = err;
  }

  return NextResponse.json({
    stages: deriveBoardStages(input),
    jobs: { ...running, lastErrors },
    checkpoints,
    costs: {
      scope: "organization",
      windowDays: COST_WINDOW_DAYS,
      // S118 — the per-video column the board always said it lacked: the
      // UsageRecord bridge (S113) + the ceiling (S115) make the number
      // first-class, with the ceiling's headroom when one is set.
      video: {
        spendMicroUsd: videoMicro,
        ceilingMicroUsd: video.spendCeilingMicro ?? null,
      },
      totalMicroUsd: totalMicro,
      totalCalls,
      failedCalls,
      byLane: [...byLane.values()].sort((a, b) => b.costMicroUsd - a.costMicroUsd).slice(0, 8),
    },
    history,
  });
}
