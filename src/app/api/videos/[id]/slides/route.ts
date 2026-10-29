import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { db } from "@/lib/db";
import { parseScenes } from "@/lib/tubeforge/story";
import { startJob, isJobRunning } from "@/lib/tubeforge/jobs";
import { errorText } from "@/lib/tubeforge/redact";
import { invalidateRenderedArtifacts } from "@/lib/tubeforge/render";
import {
  loadSlideDeck,
  planSlides,
  rerollSlideSpec,
  saveSlideSpecAt,
  renderSlidePngs,
  slideBrandFor,
  type SlideSpec,
} from "@/lib/tubeforge/slides";
import type { SlideDTO } from "@/lib/tubeforge/types";

type Ctx = { params: Promise<{ id: string }> };

const uploadPath = (id: string, ...parts: string[]) =>
  path.join(process.cwd(), "uploads", id, ...parts);

/** GET — the designed deck (one DTO per scene, scene order) or null. */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (video.format !== "story")
    return NextResponse.json({ error: "Not a scene-based video" }, { status: 400 });

  const scenes = parseScenes(video.scenes);
  const deck: SlideSpec[] | null = loadSlideDeck(id);
  const slides: SlideDTO[] | null = deck
    ? scenes.map((s, i) => {
        const spec = deck[i] ?? null;
        const hasPng = Boolean(spec && fs.existsSync(uploadPath(id, `slide-${String(s.index).padStart(2, "0")}.png`)));
        return {
          index: s.index,
          layout: spec?.layout ?? "statement",
          accent: spec?.accent ?? "yellow",
          badge: spec?.badge ?? null,
          headline: spec?.headline ?? "",
          useImage: spec?.useImage ?? false,
          hasPng,
          pngUrl: hasPng ? `/api/videos/${id}/slides/${s.index}` : null,
          generating: isJobRunning(`${id}#slide${s.index}`, "slide"),
        };
      })
    : null;

  return NextResponse.json({ slides });
}

/**
 * POST — re-roll ONE slide's design as a background job (202).
 * Body: { scene: n } — the scene whose keynote slide should get a fresh
 * LLM take. The deck is designed first when it doesn't exist yet (the video
 * may never have rendered), then only this slide is re-designed and
 * re-screenshotted with the brand kit applied. Renders become stale.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (video.format !== "story")
    return NextResponse.json(
      { error: "Not a scene-based video — slides apply to scene-format videos" },
      { status: 400 }
    );

  const scenes = parseScenes(video.scenes);
  if (scenes.length === 0)
    return NextResponse.json(
      { error: "Video has no scenes — generate the scene script first" },
      { status: 400 }
    );

  const body = await req.json().catch(() => ({}));
  const sceneIndex = Number(body?.scene);
  if (!Number.isInteger(sceneIndex) || sceneIndex < 1)
    return NextResponse.json({ error: "A valid scene index is required" }, { status: 400 });

  const scene = scenes.find((s) => s.index === sceneIndex);
  if (!scene)
    return NextResponse.json({ error: `Scene ${sceneIndex} does not exist` }, { status: 400 });
  const position = scenes.findIndex((s) => s.index === sceneIndex);

  // Clear any stale error before the job starts.
  await db.video.update({ where: { id }, data: { error: null } });

  const accepted = await startJob(`${id}#slide${sceneIndex}`, "slide", async () => {
    try {
      // 1) Ensure a deck exists — a video can be re-rolled before its first
      //    slides render (the deck would otherwise only appear at render time).
      let deck = loadSlideDeck(id);
      if (!deck || deck.length < scenes.length) {
        const planned = await planSlides(id, scenes, {
          topic: video.topic,
          niche: video.niche,
          tone: video.tone,
        });
        deck = planned.specs;
      }
      const previous = deck[position] ?? null;

      // 2) Fresh design for exactly this slide.
      const hasArt = fs.existsSync(uploadPath(id, `scene-${String(sceneIndex).padStart(2, "0")}.png`));
      const { spec, source } = await rerollSlideSpec(
        scene,
        { topic: video.topic, niche: video.niche, tone: video.tone },
        previous,
        { hasImage: hasArt }
      );
      saveSlideSpecAt(id, position, spec);

      // 3) Re-screenshot just this slide with the brand kit applied.
      const brand = slideBrandFor(id, video.brandAccent, video.brandLogoOn);
      await renderSlidePngs(id, [{ scene, spec }], { force: true, brand });

      // 4) The rendered video embeds the old slide — it is stale now.
      invalidateRenderedArtifacts(id);
      await db.video.update({
        where: { id },
        data: { hasVideo: false, videoDuration: null, error: null },
      });
      await db.activity.create({
        data: {
          videoId: id,
          stage: "storyboard",
          message: `Slide ${sceneIndex} re-designed (${source === "llm" ? "fresh AI take" : "deterministic fallback"}): "${spec.headline.slice(0, 60)}"`,
        },
      });
    } catch (err) {
      const message = errorText(err, "Slide redesign failed");
      await db.video.update({ where: { id }, data: { error: message } });
      await db.activity.create({
        data: {
          videoId: id,
          stage: "storyboard",
          level: "error",
          message: `Slide ${sceneIndex} redesign failed: ${message}`,
        },
      });
      throw err;
    }
  });

  return NextResponse.json(
    { accepted, generating: true },
    { status: accepted ? 202 : 200 }
  );
}
