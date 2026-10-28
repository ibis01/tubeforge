import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import type { Video } from "@prisma/client";
import { parseJsonLoose, generateScriptPackage } from "@/lib/tubeforge/ai";
import { aiCall } from "@/lib/tubeforge/budget";
import { generateSceneScriptPackage } from "@/lib/tubeforge/story";
import { deriveStatus } from "@/lib/tubeforge/status";
import { startJob } from "@/lib/tubeforge/jobs";
import { serializeVideo } from "@/lib/tubeforge/serialize";
import { chatComplete } from "@/lib/tubeforge/providers/chat";
import { FORMATS, RENDER_MODES } from "@/lib/tubeforge/types";
import { errorText } from "@/lib/tubeforge/redact";

const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

interface Angle {
  title: string;
  topic: string;
}

/**
 * One cheap LLM call — turn a seed topic into N distinct, non-overlapping
 * video angles (the "batch" in Series batch). Falls back to numbered takes
 * of the seed topic if the model misbehaves, so the pipeline never dies here.
 */
async function brainstormAngles(opts: {
  topic: string;
  niche: string;
  count: number;
}): Promise<Angle[]> {
  const fallback: Angle[] = Array.from({ length: opts.count }, (_, i) => ({
    title: `${opts.topic} — Part ${i + 1}`,
    topic: opts.topic,
  }));

  try {
    const raw = await aiCall("llm", "batch angle brainstorm", () =>
      chatComplete({
        system:
          "You are a senior YouTube content strategist who builds bingeable series. You respond with STRICT JSON only — no markdown, no commentary.",
        user: `Seed topic: "${opts.topic}"
Niche: ${opts.niche}

Brainstorm exactly ${opts.count} DISTINCT video angles that together form a cohesive series around this seed. Each angle must:
- stand alone (a viewer who watches only that video gets full value)
- overlap as little as possible with the other angles (different sub-question, different story, different controversy)
- be equally click-worthy — no filler like "Part 2"

Return JSON: { "angles": [ { "title": "click-worthy title under 70 chars", "topic": "one-sentence specific brief for the writer" } ] }`,
      })
    );
    const parsed = parseJsonLoose(raw) as { angles?: unknown };
    const list = Array.isArray(parsed?.angles) ? parsed.angles : [];
    const angles = list
      .map((a: unknown) => {
        const o = (a ?? {}) as Record<string, unknown>;
        return {
          title: String(o.title ?? "").trim().slice(0, 90),
          topic: String(o.topic ?? "").trim().slice(0, 300) || opts.topic,
        };
      })
      .filter((a: Angle) => a.title && a.topic)
      .slice(0, opts.count);

    // Pad in the rare case the model returned fewer than asked.
    while (angles.length < opts.count) {
      const i = angles.length;
      angles.push({ title: `${opts.topic} — Part ${i + 1}`, topic: opts.topic });
    }
    return angles;
  } catch (err) {
    console.warn("[batch] angle brainstorm failed — using fallback takes:", err instanceof Error ? err.message : err);
    return fallback;
  }
}

/**
 * POST — create a series: one seed topic → N videos with distinct angles,
 * each queued straight into script generation as its own background job.
 * Body mirrors POST /api/videos plus `count` (2-6).
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const topic = String(body.topic ?? "").trim();
    if (!topic)
      return NextResponse.json({ error: "Topic is required" }, { status: 400 });
    if (topic.length > 300)
      return NextResponse.json({ error: "Topic too long" }, { status: 400 });

    const count = Math.min(Math.max(Number(body.count ?? 3), 2), 6);
    const niche = String(body.niche ?? "Motivation");
    const tone = String(body.tone ?? "informative");
    const length = String(body.length ?? "medium");
    const voice = String(body.voice ?? "jam");
    const ttsSpeed = Math.min(Math.max(Number(body.ttsSpeed ?? 1.0), 0.5), 2.0);
    const thumbStyle = String(body.thumbStyle ?? "cinematic");
    const channelId = body.channelId ? String(body.channelId) : null;
    const characterId = body.characterId ? String(body.characterId) : null;
    const format = FORMATS.some((f) => f.id === body.format) ? String(body.format) : "story";
    const renderMode = RENDER_MODES.some((m) => m.id === body.renderMode)
      ? String(body.renderMode)
      : "kenburns";

    const character = characterId
      ? await db.character.findUnique({ where: { id: characterId } })
      : null;
    if (characterId && !character)
      return NextResponse.json({ error: "Character not found" }, { status: 400 });

    // 1) Distinct angles — one shared LLM call for the whole series.
    const angles = await brainstormAngles({ topic, niche, count });

    // 2) Create the rows.
    const videos: (Video & {
      channel: { name: string } | null;
      character: { name: string; hasPortrait: boolean } | null;
    })[] = [];
    for (const angle of angles) {
      const video = await db.video.create({
        data: {
          topic: angle.topic,
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
      videos.push(video);
    }

    await db.activity.create({
      data: {
        videoId: videos[0].id,
        stage: "create",
        message: `Series batch queued — ${videos.length} videos from "${topic}" (${format === "story" ? "scene-based" : "narration"} format)`,
      },
    });

    // 3) Queue script generation per video. Each runs as its own tracked
    // "script" job so Library polling, job history and crash recovery work
    // exactly like a single-video create.
    for (const video of videos) {
      const isStory = video.format === "story";
      await startJob(video.id, "script", async () => {
        try {
          if (isStory) {
            const pkg = await generateSceneScriptPackage({
              topic: video.topic,
              niche: video.niche,
              tone: video.tone,
              length: video.length,
              character: character
                ? {
                    name: character.name,
                    personality: character.personality,
                    identityAnchor: character.identityAnchor,
                  }
                : null,
            });
            await db.video.update({
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
            });
            await db.activity.create({
              data: {
                videoId: video.id,
                stage: "script",
                message: `Scene script written — "${pkg.title}" (${pkg.scenes.length} scenes, ${wordCount(pkg.script)} words)`,
              },
            });
          } else {
            const pkg = await generateScriptPackage({
              topic: video.topic,
              niche: video.niche,
              tone: video.tone,
              length: video.length,
            });
            await db.video.update({
              where: { id: video.id },
              data: {
                title: pkg.title,
                script: pkg.script,
                description: pkg.description,
                tags: pkg.tags.join(", "),
                wordCount: wordCount(pkg.script),
                status: deriveStatus({ ...video, script: pkg.script }),
                error: null,
              },
            });
            await db.activity.create({
              data: {
                videoId: video.id,
                stage: "script",
                message: `Script written — "${pkg.title}" (${wordCount(pkg.script)} words)`,
              },
            });
          }
        } catch (err) {
          const message = errorText(err, "Script generation failed");
          await db.video
            .update({ where: { id: video.id }, data: { status: "failed", error: message } })
            .catch(() => {});
          await db.activity
            .create({
              data: {
                videoId: video.id,
                stage: "script",
                level: "error",
                message: `Script generation failed: ${message}`,
              },
            })
            .catch(() => {});
          throw err;
        }
      });
    }

    return NextResponse.json(
      {
        queued: videos.length,
        angles: angles.map((a) => a.title),
        videos: videos.map((v) => serializeVideo(v, v.channel?.name)),
      },
      { status: 202 }
    );
  } catch (err) {
    const message = errorText(err, "Invalid request");
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
