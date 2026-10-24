import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import type { VideoDTO, VideoStatus } from "@/lib/tubeforge/types";
import type { Video } from "@prisma/client";

const serialize = (v: Video, channelName?: string | null): VideoDTO => ({
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
  channelName: channelName ?? null,
  createdAt: v.createdAt.toISOString(),
  updatedAt: v.updatedAt.toISOString(),
});

// Next.js 16: params is a Promise
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const video = await db.video.findUnique({
    where: { id },
    include: { channel: { select: { name: true } } },
  });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });
  return NextResponse.json({ video: serialize(video, video.channel?.name) });
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const body = await req.json();

  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });

  const data: Record<string, unknown> = {};
  if (typeof body.title === "string") data.title = body.title.slice(0, 120);
  if (typeof body.script === "string") {
    data.script = body.script;
    data.wordCount = body.script.split(/\s+/).filter(Boolean).length;
  }
  if (typeof body.description === "string") data.description = body.description;
  if (typeof body.tags === "string") data.tags = body.tags;
  if (typeof body.voice === "string") data.voice = body.voice;
  if (typeof body.ttsSpeed === "number")
    data.ttsSpeed = Math.min(Math.max(body.ttsSpeed, 0.5), 2.0);
  if (typeof body.channelId === "string" || body.channelId === null)
    data.channelId = body.channelId;

  // Status transitions (publish / mark ready / retry)
  if (typeof body.status === "string") {
    const allowed = ["draft", "scripted", "voiced", "ready", "published", "failed"];
    if (!allowed.includes(body.status))
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    data.status = body.status;

    if (body.status === "published") {
      await db.activity.create({
        data: {
          videoId: id,
          stage: "publish",
          message: `Published to YouTube queue — "${video.title ?? video.topic}"`,
        },
      });
    }
    if (body.status === "ready") {
      await db.activity.create({
        data: {
          videoId: id,
          stage: "ready",
          message: `Package complete — "${video.title ?? video.topic}" is ready to upload`,
        },
      });
    }
  }

  const updated = await db.video.update({
    where: { id },
    data,
    include: { channel: { select: { name: true } } },
  });
  return NextResponse.json({ video: serialize(updated, updated.channel?.name) });
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });

  await db.video.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
