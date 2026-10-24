import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { db } from "@/lib/db";
import { generateVoiceover, readMedia } from "@/lib/tubeforge/ai";
import { generateSceneVoiceovers, parseScenes } from "@/lib/tubeforge/story";
import { deriveStatus } from "@/lib/tubeforge/status";
import { startJob } from "@/lib/tubeforge/jobs";
import { serializeVideo } from "@/lib/tubeforge/serialize";

type Ctx = { params: Promise<{ id: string }> };

const UPLOAD_ROOT = path.join(process.cwd(), "uploads");

/** POST — kick off TTS voiceover generation as a background job (returns 202 immediately).
 * Long synchronous requests were killed by the gateway with 502; the job runs
 * in-process and the client polls GET /api/videos/[id] for completion.
 * Scene-format videos get PER-SCENE TTS so the video timeline maps 1:1 to scenes. */
export async function POST(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });

  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (!video.script)
    return NextResponse.json(
      { error: "Video has no script yet — generate the script first" },
      { status: 400 }
    );

  const scenes = video.format === "story" ? parseScenes(video.scenes) : [];
  if (video.format === "story" && scenes.length === 0)
    return NextResponse.json(
      { error: "Scene video has no scenes — regenerate the scene script" },
      { status: 400 }
    );

  // Clear any stale error from a previous failed attempt before polling starts.
  await db.video.update({ where: { id }, data: { error: null } });

  const accepted = await startJob(id, "voiceover", async () => {
    try {
      let durationSec: number;

      if (video.format === "story" && scenes.length > 0) {
        // Per-scene narration → scene-XX.wav + merged voiceover.wav
        const result = await generateSceneVoiceovers({
          videoId: id,
          scenes,
          voice: video.voice,
          speed: video.ttsSpeed,
        });
        durationSec = result.durationSec;

        // Old renders no longer match the new narration timing.
        for (const f of ["final.mp4", "preview.mp4", "subtitles.srt"]) {
          fs.rmSync(path.join(UPLOAD_ROOT, id, f), { force: true });
        }
        await db.video.update({
          where: { id },
          data: { hasVideo: false, videoDuration: null },
        });
      } else {
        const result = await generateVoiceover({
          script: video.script ?? "",
          voice: video.voice,
          speed: video.ttsSpeed,
          videoId: id,
        });
        durationSec = result.durationSec;
      }

      const fresh = await db.video.findUnique({ where: { id } });
      const nextStatus = deriveStatus(video, {
        hasVoiceover: true,
        hasThumbnail: fresh?.hasThumbnail ?? video.hasThumbnail,
      });

      await db.video.update({
        where: { id },
        data: {
          hasVoiceover: true,
          audioDuration: Math.round(durationSec * 10) / 10,
          status: nextStatus,
          error: null,
        },
      });

      await db.activity.create({
        data: {
          videoId: id,
          stage: "voiceover",
          message:
            video.format === "story"
              ? `Scene-by-scene voiceover rendered (${video.voice}, ${video.ttsSpeed}x) — ${Math.round(durationSec)}s across ${scenes.length} scenes`
              : `Voiceover rendered (${video.voice}, ${video.ttsSpeed}x) — ${Math.round(durationSec)}s of audio`,
        },
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Voiceover failed";
      await db.video.update({
        where: { id },
        data: { status: "failed", error: message },
      });
      await db.activity.create({
        data: {
          videoId: id,
          stage: "voiceover",
          level: "error",
          message: `Voiceover failed: ${message}`,
        },
      });
      // Re-thrown so startJob records the failure for GET polling + history.
      throw err;
    }
  });

  // 202 Accepted — job already running (dedupe) or just started.
  return NextResponse.json(
    {
      video: serializeVideo(video, null, { includeScenes: true }),
      accepted: true,
      generating: true,
    },
    { status: 202 }
  );
}

/** GET — stream the voiceover WAV file. */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const media = readMedia(id, "voiceover.wav");
  if (!media)
    return NextResponse.json({ error: "No voiceover yet" }, { status: 404 });

  return new NextResponse(new Uint8Array(media), {
    status: 200,
    headers: {
      "Content-Type": "audio/wav",
      "Content-Length": String(media.length),
      "Cache-Control": "private, max-age=3600",
    },
  });
}
