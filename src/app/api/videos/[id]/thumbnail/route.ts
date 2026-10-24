import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { generateThumbnail, readMedia } from "@/lib/tubeforge/ai";
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

/** POST — generate a thumbnail with CogView. */
export async function POST(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });

  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (!video.title)
    return NextResponse.json(
      { error: "Video has no title yet — generate the script first" },
      { status: 400 }
    );

  try {
    await generateThumbnail({
      title: video.title,
      topic: video.topic,
      style: video.thumbStyle,
      videoId: video.id,
    });

    const nextStatus = deriveStatus(video, { hasThumbnail: true });

    const updated = await db.video.update({
      where: { id },
      data: { hasThumbnail: true, status: nextStatus, error: null },
    });

    await db.activity.create({
      data: {
        videoId: id,
        stage: "thumbnail",
        message: `Thumbnail generated (${video.thumbStyle} style) for "${video.title}"`,
      },
    });

    return NextResponse.json({ video: serialize(updated) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Thumbnail failed";
    const failed = await db.video.update({
      where: { id },
      data: { status: "failed", error: message },
    });
    await db.activity.create({
      data: {
        videoId: id,
        stage: "thumbnail",
        level: "error",
        message: `Thumbnail failed: ${message}`,
      },
    });
    return NextResponse.json(
      { error: message, video: serialize(failed) },
      { status: 500 }
    );
  }
}

/** GET — stream the thumbnail PNG. */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const media = readMedia(id, "thumbnail.png");
  if (!media)
    return NextResponse.json({ error: "No thumbnail yet" }, { status: 404 });

  return new NextResponse(new Uint8Array(media), {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(media.length),
      "Cache-Control": "private, max-age=3600",
    },
  });
}
