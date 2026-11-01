// POST /api/videos/[id]/qc — Stage 6 T-6.2: re-run the QC battery against the
// existing final.mp4 WITHOUT re-rendering.
//
// Why a separate endpoint: the render job already runs QC after every full
// render. This endpoint exists for the after-edit case — the user trimmed a
// scene's narration, edited a caption, replaced a stock clip — and wants a
// fresh QC report against the existing render without paying for a re-render.
//
// Returns 202 + { accepted, generating } so the client polls the standard
// video/job polling endpoints (jobSnapshot already includes `qc` as of T-6.2).
// 400 when there is no final.mp4 to QC (the user must render first).

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { isJobRunning, lastJobError, jobProgress, startJob } from "@/lib/tubeforge/jobs";
import { runQcJob } from "@/lib/tubeforge/video-jobs";

type Ctx = { params: Promise<{ id: string }> };

/** GET — QC re-run job status. */
export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });

  return NextResponse.json({
    running: isJobRunning(id, "qc"),
    progress: jobProgress(id, "qc"),
    qcReport: video.qcReport ? JSON.parse(video.qcReport) : null,
    error: lastJobError(id, "qc") ?? video.error,
  });
}

/** POST — enqueue a QC re-run job (202). The body is empty — the job re-derives
 *  everything from the video row. */
export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (!video.hasVideo || video.videoDuration == null)
    return NextResponse.json(
      { error: "Cannot re-run QC — render the video first" },
      { status: 400 }
    );
  if (isJobRunning(id, "render"))
    return NextResponse.json(
      { error: "A render is in progress — wait for it to finish before re-running QC" },
      { status: 409 }
    );

  await db.video.update({ where: { id }, data: { error: null } });

  const accepted = await startJob(id, "qc", () => runQcJob(id), { payload: null });

  return NextResponse.json(
    { accepted, generating: accepted, kind: "qc" },
    { status: accepted ? 202 : 200 }
  );
}
