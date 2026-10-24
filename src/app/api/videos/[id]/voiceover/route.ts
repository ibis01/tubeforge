import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { generateVoiceover, readMedia } from "@/lib/tubeforge/ai";
import { deriveStatus } from "@/lib/tubeforge/status";
import { isJobRunning, startJob } from "@/lib/tubeforge/jobs";
import type { VideoDTO, VideoStatus } from "@/lib/tubeforge/types";
import type { Video } from "@prisma/client";

type Ctx = { params: Promise<{ id: string }> };

const serialize = (v: Video): VideoDTO => ({
  id: v.id,
  title: v.title,
  topic: v.topic,
  niche: v.niche,
  tone: v.tone,
  length: v.length,
  script: v.script,
  description: v.description,
  tags: v.tags,
  status: v.status as VideoStatus,
  voice: v.voice,
  ttsSpeed: v.ttsSpeed,
  thumbStyle: v.thumbStyle,
  hasVoiceover: v.hasVoiceover,
  hasThumbnail: v.hasThumbnail,
  audioDuration: v.audioDuration,
  wordCount: v.wordCount,
  error: v.error,
  channelId: v.channelId,
  createdAt: v.createdAt.toISOString(),
  updatedAt: v.updatedAt.toISOString(),
});

/** POST — kick off TTS voiceover generation as a background job (returns 202 immediately).
 * Long synchronous requests were killed by the gateway with 502; the job runs
 * in-process and the client polls GET /api/videos/[id] for completion. */
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

  // Clear any stale error from a previous failed attempt before polling starts.
  await db.video.update({ where: { id }, data: { error: null } });

  const accepted = startJob(id, "voiceover", async () => {
    try {
      const { durationSec } = await generateVoiceover({
        script: video.script,
        voice: video.voice,
        speed: video.ttsSpeed,
        videoId: video.id,
      });

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
          message: `Voiceover rendered (${video.voice}, ${video.ttsSpeed}x) — ${Math.round(durationSec)}s of audio`,
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
    }
  });

  // 202 Accepted — job already running (dedupe) or just started.
  return NextResponse.json(
    { video: serialize(video), accepted: true, generating: true },
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
