import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { generateVoiceover, readMedia } from "@/lib/tubeforge/ai";
import { deriveStatus } from "@/lib/tubeforge/status";
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

/** POST — generate the TTS voiceover for this video. */
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

  try {
    const { durationSec } = await generateVoiceover({
      script: video.script,
      voice: video.voice,
      speed: video.ttsSpeed,
      videoId: video.id,
    });

    const nextStatus = deriveStatus(video, { hasVoiceover: true });

    const updated = await db.video.update({
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

    return NextResponse.json({ video: serialize(updated) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Voiceover failed";
    const failed = await db.video.update({
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
    return NextResponse.json(
      { error: message, video: serialize(failed) },
      { status: 500 }
    );
  }
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
