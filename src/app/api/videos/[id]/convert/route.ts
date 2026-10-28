import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { convertClassicToScenes } from "@/lib/tubeforge/convert";
import { startJob, isJobRunning, lastJobError } from "@/lib/tubeforge/jobs";
import { errorText } from "@/lib/tubeforge/redact";

type Ctx = { params: Promise<{ id: string }> };

/** GET — conversion status (drives the client spinner). */
export async function GET(_req: NextRequest, ctx: Ctx) {
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
 */
export async function POST(_req: NextRequest, ctx: Ctx) {
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

  const accepted = await startJob(id, "convert", async () => {
    try {
      await convertClassicToScenes({ videoId: id });
    } catch (err) {
      const message = errorText(err, "Conversion failed");
      await db.video.update({ where: { id }, data: { error: message } });
      await db.activity.create({
        data: {
          videoId: id,
          stage: "convert",
          level: "error",
          message: `Scene conversion failed: ${message}`,
        },
      });
      throw err;
    }
  });

  return NextResponse.json({ accepted, converting: true }, { status: accepted ? 202 : 200 });
}
