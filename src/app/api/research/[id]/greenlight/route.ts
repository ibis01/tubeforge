import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { generateScriptPackage } from "@/lib/tubeforge/ai";
import { generateSceneScriptPackage } from "@/lib/tubeforge/story";
import { serializeVideo } from "@/lib/tubeforge/serialize";
import { serializeSession } from "@/lib/tubeforge/research";
import {
  FORMATS,
  LENGTHS,
  RENDER_MODES,
  TONES,
  type VideoDTO,
} from "@/lib/tubeforge/types";
import type { ResearchIdea } from "@/lib/tubeforge/types";
import { errorText } from "@/lib/tubeforge/redact";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST — Greenlight a Topic Radar idea straight into a video (Phase 4).
 * Body: { ideaId, format?: "story"|"script", tone?, voice?, ttsSpeed?,
 *         channelId?, characterId?, renderMode? }
 *
 * The research intelligence (angle, keywords, why-it-clicks) is woven into the
 * script prompt, the idea's suggested length sets the video length, and its
 * SEO keywords are unioned into the final tags — one click from radar scan to
 * a fully scripted video (scene-based story by default).
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;

  try {
    const body = await req.json();
    const ideaId = String(body.ideaId ?? "");
    if (!ideaId)
      return NextResponse.json({ error: "ideaId is required" }, { status: 400 });

    // Load + locate the idea inside the stored session payload.
    const session = await db.researchSession.findUnique({ where: { id } });
    if (!session)
      return NextResponse.json({ error: "Research scan not found" }, { status: 404 });

    const parsed = serializeSession(session);
    const idea: ResearchIdea | undefined = parsed.ideas.find(
      (i) => i.id === ideaId
    );
    if (!idea)
      return NextResponse.json(
        { error: "Idea not found in this scan — re-run the Topic Radar" },
        { status: 404 }
      );

    const format = FORMATS.some((f) => f.id === body.format)
      ? String(body.format)
      : "story"; // greenlit ideas default to the scene-based story engine
    const length = LENGTHS.some((l) => l.id === idea.suggestedLength)
      ? idea.suggestedLength
      : "medium";
    const tone = TONES.some((t) => t.id === body.tone)
      ? String(body.tone)
      : "dramatic";
    const voice = String(body.voice ?? "jam");
    const ttsSpeed = Math.min(Math.max(Number(body.ttsSpeed ?? 1.0), 0.5), 2.0);
    const renderMode = RENDER_MODES.some((m) => m.id === body.renderMode)
      ? String(body.renderMode)
      : "kenburns";
    const channelId = body.channelId ? String(body.channelId) : null;
    const characterId = body.characterId ? String(body.characterId) : null;

    // Validate FKs up-front (SQLite throws opaque errors otherwise).
    if (channelId) {
      const channel = await db.channel.findUnique({ where: { id: channelId } });
      if (!channel)
        return NextResponse.json({ error: "Channel not found" }, { status: 400 });
    }
    const character = characterId
      ? await db.character.findUnique({ where: { id: characterId } })
      : null;
    if (characterId && !character)
      return NextResponse.json({ error: "Character not found" }, { status: 400 });

    const topic = idea.title.slice(0, 300);
    const include = {
      channel: { select: { name: true } },
      character: { select: { name: true, hasPortrait: true } },
    };

    // Create the draft first so every later step has a stable id.
    const video = await db.video.create({
      data: {
        topic,
        niche: session.niche,
        tone,
        length,
        voice,
        ttsSpeed,
        channelId,
        characterId,
        format,
        renderMode,
        status: "draft",
      },
      include,
    });

    await db.activity.create({
      data: {
        videoId: video.id,
        stage: "create",
        message: `Greenlit from Topic Radar: "${topic}" (${session.niche} · ${idea.viralScore}/100 viral score) → ${format === "story" ? "scene story" : "narration script"}`,
      },
    });

    try {
      const wordCount = (text: string) =>
        text.split(/\s+/).filter(Boolean).length;

      // The research brief carries the radar's intelligence into the prompt.
      const brief = {
        angle: idea.angle,
        keywords: idea.keywords,
        why: idea.why,
      };

      const pkg =
        format === "story"
          ? await generateSceneScriptPackage({
              topic,
              niche: session.niche,
              tone,
              length,
              brief,
              character: character
                ? {
                    name: character.name,
                    personality: character.personality,
                    identityAnchor: character.identityAnchor,
                  }
                : null,
            })
          : await generateScriptPackage({
              topic,
              niche: session.niche,
              tone,
              length,
              brief,
            });

      // Union the idea's SEO keywords into the tags (research safety net —
      // GLM was asked to weave them in, but never lose radar keywords).
      const modelTags = new Set(pkg.tags.map((t) => t.toLowerCase()));
      for (const k of idea.keywords) {
        if (modelTags.size >= 12) break;
        modelTags.add(k.toLowerCase());
      }
      const tags = [...modelTags].slice(0, 12);

      const updated = await db.video.update({
        where: { id: video.id },
        data: {
          title: pkg.title,
          script: pkg.script,
          description: pkg.description,
          tags: tags.join(", "),
          scenes:
            format === "story" && "scenes" in pkg
              ? JSON.stringify(pkg.scenes)
              : undefined,
          wordCount: wordCount(pkg.script),
          status: "scripted",
          error: null,
        },
        include,
      });

      await db.activity.create({
        data: {
          videoId: video.id,
          stage: "script",
          message: `${format === "story" ? "Scene script" : "Script"} written from the greenlit idea — "${pkg.title}" (${wordCount(pkg.script)} words)`,
        },
      });

      return NextResponse.json({
        video: serializeVideo(updated, updated.channel?.name, {
          includeScenes: true,
        }) as VideoDTO,
      });
    } catch (err) {
      const message = errorText(err, "Script generation failed");
      const failed = await db.video.update({
        where: { id: video.id },
        data: { status: "failed", error: message },
        include,
      });
      await db.activity.create({
        data: {
          videoId: video.id,
          stage: "script",
          level: "error",
          message: `Greenlight script failed: ${message}`,
        },
      });
      return NextResponse.json(
        { error: message, video: serializeVideo(failed, failed.channel?.name) },
        { status: 500 }
      );
    }
  } catch (err) {
    const message = errorText(err, "Invalid request");
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
