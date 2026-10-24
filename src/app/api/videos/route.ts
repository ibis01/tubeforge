import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { generateScriptPackage } from "@/lib/tubeforge/ai";
import type { VideoDTO, VideoStatus } from "@/lib/tubeforge/types";
import type { Video } from "@prisma/client";

const serialize = (
  v: Video & { character?: { name: string; hasPortrait: boolean } | null },
  channelName?: string | null
): VideoDTO => ({
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
  characterId: v.characterId,
  characterName: v.character?.name ?? null,
  characterPortraitUrl:
    v.characterId && v.character?.hasPortrait
      ? `/api/characters/${v.characterId}/portrait`
      : null,
  createdAt: v.createdAt.toISOString(),
  updatedAt: v.updatedAt.toISOString(),
});

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status");
  const limit = Math.min(Number(searchParams.get("limit") ?? 100), 200);

  const where = status && status !== "all" ? { status } : {};
  const videos = await db.video.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      channel: { select: { name: true } },
      character: { select: { name: true, hasPortrait: true } },
    },
  });

  return NextResponse.json({
    videos: videos.map((v) => serialize(v, v.channel?.name)),
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const topic = String(body.topic ?? "").trim();
    if (!topic)
      return NextResponse.json({ error: "Topic is required" }, { status: 400 });
    if (topic.length > 300)
      return NextResponse.json({ error: "Topic too long" }, { status: 400 });

    const niche = String(body.niche ?? "Motivation");
    const tone = String(body.tone ?? "informative");
    const length = String(body.length ?? "medium");
    const voice = String(body.voice ?? "jam");
    const ttsSpeed = Math.min(Math.max(Number(body.ttsSpeed ?? 1.0), 0.5), 2.0);
    const thumbStyle = String(body.thumbStyle ?? "cinematic");
    const channelId = body.channelId ? String(body.channelId) : null;
    const characterId = body.characterId ? String(body.characterId) : null;

    // Validate the character exists (avoids dangling FK on SQLite)
    if (characterId) {
      const character = await db.character.findUnique({ where: { id: characterId } });
      if (!character)
        return NextResponse.json({ error: "Character not found" }, { status: 400 });
    }

    // Create the video record first (draft)
    const video = await db.video.create({
      data: {
        topic,
        niche,
        tone,
        length,
        voice,
        ttsSpeed,
        thumbStyle,
        channelId,
        characterId,
        status: "draft",
      },
      include: {
        channel: { select: { name: true } },
        character: { select: { name: true, hasPortrait: true } },
      },
    });

    await db.activity.create({
      data: {
        videoId: video.id,
        stage: "create",
        message: `New video queued: "${topic}" (${niche})`,
      },
    });

    // Stage 1 — AI script generation
    try {
      const pkg = await generateScriptPackage({ topic, niche, tone, length });
      const wordCount = pkg.script.split(/\s+/).filter(Boolean).length;

      const updated = await db.video.update({
        where: { id: video.id },
        data: {
          title: pkg.title,
          script: pkg.script,
          description: pkg.description,
          tags: pkg.tags.join(", "),
          wordCount,
          status: "scripted",
          error: null,
        },
        include: {
          channel: { select: { name: true } },
          character: { select: { name: true, hasPortrait: true } },
        },
      });

      await db.activity.create({
        data: {
          videoId: video.id,
          stage: "script",
          message: `Script written by GLM — "${pkg.title}" (${wordCount} words)`,
        },
      });

      return NextResponse.json({ video: serialize(updated, updated.channel?.name) });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Script generation failed";
      const failed = await db.video.update({
        where: { id: video.id },
        data: { status: "failed", error: message },
        include: {
          channel: { select: { name: true } },
          character: { select: { name: true, hasPortrait: true } },
        },
      });
      await db.activity.create({
        data: {
          videoId: video.id,
          stage: "script",
          level: "error",
          message: `Script generation failed: ${message}`,
        },
      });
      return NextResponse.json(
        { error: message, video: serialize(failed, failed.channel?.name) },
        { status: 500 }
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
