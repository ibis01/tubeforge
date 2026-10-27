import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { parseScenes } from "@/lib/tubeforge/story";
import { renderVideo } from "@/lib/tubeforge/render";
import {
  startJob,
  isJobRunning,
  lastJobError,
  jobProgress,
  setJobProgress,
} from "@/lib/tubeforge/jobs";

type Ctx = { params: Promise<{ id: string }> };

/** GET — render job status (drives the client progress bar). */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (video.format !== "story")
    return NextResponse.json({ error: "Not a scene-based video" }, { status: 400 });

  return NextResponse.json({
    rendering: isJobRunning(id, "render"),
    mode: isJobRunning(id, "render") ? video.renderMode : null,
    progress: jobProgress(id, "render"),
    hasVideo: video.hasVideo,
    videoDuration: video.videoDuration,
    error: lastJobError(id, "render") ?? video.error,
  });
}

/**
 * POST — render the final MP4 as a background job (202).
 * Body: { mode?: "kenburns" | "animated", subtitles?: boolean, music?: boolean,
 *         sceneLimit?: number }  — sceneLimit renders a preview (first N scenes).
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (video.format !== "story")
    return NextResponse.json(
      { error: "Not a scene-based video — rendering applies to scene-format videos" },
      { status: 400 }
    );

  const scenes = parseScenes(video.scenes);
  if (scenes.length === 0)
    return NextResponse.json(
      { error: "Video has no scenes — generate the scene script first" },
      { status: 400 }
    );
  if (!video.hasStoryboard)
    return NextResponse.json(
      { error: "Generate the storyboard first — there is no scene art yet" },
      { status: 400 }
    );
  if (!video.hasVoiceover)
    return NextResponse.json(
      { error: "Generate the voiceover first — narration drives the scene timing" },
      { status: 400 }
    );

  const body = await req.json().catch(() => ({}));
  const mode = body?.mode === "animated" ? "animated" : "kenburns";
  const subtitles = body?.subtitles !== false; // default: burn captions
  const smartCaptions = body?.smartCaptions !== false; // default: ASR-synced cues (Phase 4)
  const music = body?.music !== false; // default: ambient bed
  const sceneLimitRaw = Number(body?.sceneLimit);
  const sceneLimit =
    Number.isInteger(sceneLimitRaw) && sceneLimitRaw >= 1
      ? Math.min(sceneLimitRaw, scenes.length)
      : undefined;

  // Clear any stale error before the job starts.
  await db.video.update({ where: { id }, data: { error: null } });

  const accepted = await startJob(id, "render", async () => {
    try {
      const result = await renderVideo({
        videoId: id,
        scenes,
        mode,
        burnSubtitles: subtitles,
        smartCaptions,
        music,
        musicNiche: video.niche,
        sceneLimit,
        onProgress: (current, total, label) =>
          setJobProgress(id, "render", current, total, label),
      });

      if (result.fileName === "final.mp4") {
        await db.video.update({
          where: { id },
          data: {
            hasVideo: true,
            videoDuration: Math.round(result.durationSec * 10) / 10,
            error: null,
          },
        });
      } else {
        // Preview renders never mark the video as produced.
        await db.video.update({ where: { id }, data: { error: null } });
      }

      await db.activity.create({
        data: {
          videoId: id,
          stage: "render",
          message:
            result.fileName === "final.mp4"
              ? `Video rendered (${mode === "animated" ? "full AI animation" : "Ken Burns"}) — ${Math.round(result.durationSec)}s MP4`
              : `Preview rendered (scene 1, ${mode === "animated" ? "animated" : "Ken Burns"})`,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Render failed";
      await db.video.update({ where: { id }, data: { error: message } });
      await db.activity.create({
        data: {
          videoId: id,
          stage: "render",
          level: "error",
          message: `Render failed: ${message}`,
        },
      });
      // Re-thrown so startJob records the failure for GET polling + history.
      throw err;
    }
  });

  return NextResponse.json(
    { accepted, generating: true, mode, sceneLimit: sceneLimit ?? null },
    { status: accepted ? 202 : 200 }
  );
}
