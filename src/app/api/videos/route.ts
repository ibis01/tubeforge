import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { generateScriptPackage } from "@/lib/tubeforge/ai";
import { generateSceneScriptPackage } from "@/lib/tubeforge/story";
import { serializeVideo } from "@/lib/tubeforge/serialize";
import { FORMATS, RENDER_MODES, type VideoDTO } from "@/lib/tubeforge/types";

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
    videos: videos.map((v) => serializeVideo(v, v.channel?.name)),
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
    const format = FORMATS.some((f) => f.id === body.format)
      ? String(body.format)
      : "script";
    const renderMode = RENDER_MODES.some((m) => m.id === body.renderMode)
      ? String(body.renderMode)
      : "kenburns";

    // Validate the character exists (avoids dangling FK on SQLite)
    const character = characterId
      ? await db.character.findUnique({ where: { id: characterId } })
      : null;
    if (characterId && !character)
      return NextResponse.json({ error: "Character not found" }, { status: 400 });

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
        format,
        renderMode,
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
        message: `New video queued: "${topic}" (${niche})${format === "story" ? " · scene-based story" : ""}`,
      },
    });

    // Stage 1 — AI script generation (classic narration OR scene-based story)
    try {
      const wordCount = (text: string) =>
        text.split(/\s+/).filter(Boolean).length;

      if (format === "story") {
        const pkg = await generateSceneScriptPackage({
          topic,
          niche,
          tone,
          length,
          character: character
            ? {
                name: character.name,
                personality: character.personality,
                identityAnchor: character.identityAnchor,
              }
            : null,
        });

        const updated = await db.video.update({
          where: { id: video.id },
          data: {
            title: pkg.title,
            script: pkg.script,
            description: pkg.description,
            tags: pkg.tags.join(", "),
            scenes: JSON.stringify(pkg.scenes),
            wordCount: wordCount(pkg.script),
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
            message: `Scene script written — "${pkg.title}" (${pkg.scenes.length} scenes, ${wordCount(pkg.script)} words)`,
          },
        });

        return NextResponse.json({
          video: serializeVideo(updated, updated.channel?.name, {
            includeScenes: true,
          }) as VideoDTO,
        });
      }

      const pkg = await generateScriptPackage({ topic, niche, tone, length });

      const updated = await db.video.update({
        where: { id: video.id },
        data: {
          title: pkg.title,
          script: pkg.script,
          description: pkg.description,
          tags: pkg.tags.join(", "),
          wordCount: wordCount(pkg.script),
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
          message: `Script written by GLM — "${pkg.title}" (${wordCount(pkg.script)} words)`,
        },
      });

      return NextResponse.json({
        video: serializeVideo(updated, updated.channel?.name, {
          includeScenes: true,
        }),
      });
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
        { error: message, video: serializeVideo(failed, failed.channel?.name) },
        { status: 500 }
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
