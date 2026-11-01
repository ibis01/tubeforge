import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { startJob, isJobRunning, lastJobError } from "@/lib/tubeforge/jobs";
import { runConvertJob } from "@/lib/tubeforge/video-jobs";

type Ctx = { params: Promise<{ id: string }> };

/** GET — conversion status (drives the client spinner). */
export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });

  return NextResponse.json({
    converting: isJobRunning(id, "convert"),
    converted: video.format === "story",
    error: lastJobError(id, "convert") ?? video.error,
  });
}

/**
 * POST — upgrade a narration-script video to a scene-based story video.
 * Splits the existing script into scenes (GLM, verbatim narration) and cuts
 * the existing voiceover.wav into per-scene WAVs (silence-snapped, no TTS).
 * Afterwards the storyboard + render stages become available.
 *
 * The job body is runConvertJob (video-jobs.ts) — shared with the crash-
 * recovery handler, so a restart resumes the conversion.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (video.format === "story")
    return NextResponse.json(
      { error: "Video is already scene-based — storyboard and render are available" },
      { status: 400 }
    );
  if (!video.script || video.script.trim().length < 80)
    return NextResponse.json(
      { error: "Generate the script first — there is nothing to split into scenes" },
      { status: 400 }
    );

  await db.video.update({ where: { id }, data: { error: null } });

  const accepted = await startJob(id, "convert", () => runConvertJob(id));

  return NextResponse.json({ accepted, converting: true }, { status: accepted ? 202 : 200 });
}
