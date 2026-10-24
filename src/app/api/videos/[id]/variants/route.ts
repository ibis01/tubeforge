import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  generateThumbnail,
  listVariants,
  promoteVariant,
  pickVariantStyles,
  readMedia,
} from "@/lib/tubeforge/ai";
import { deriveStatus } from "@/lib/tubeforge/status";
import { THUMB_STYLES, type VariantDTO } from "@/lib/tubeforge/types";

type Ctx = { params: Promise<{ id: string }> };

/** Build the variant list DTO for a video. */
function variantDTOs(videoId: string, primaryStyle: string): VariantDTO[] {
  return listVariants(videoId).map((v) => ({
    style: v.style,
    label:
      THUMB_STYLES.find((s) => s.id === v.style)?.label ?? v.style,
    url: `/api/videos/${videoId}/variants/${v.style}`,
    isPrimary: v.style === primaryStyle,
  }));
}

/** GET — list A/B thumbnail variants. */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id }, select: { thumbStyle: true } });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });
  return NextResponse.json({ variants: variantDTOs(id, video.thumbStyle) });
}

/** POST — generate an A/B variant set (3 styles: the current one + 2 others). */
export async function POST(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (!video.title)
    return NextResponse.json(
      { error: "Video has no title yet — generate the script first" },
      { status: 400 }
    );

  try {
    const styles = pickVariantStyles(video.thumbStyle, 3);

    for (const style of styles) {
      await generateThumbnail({
        title: video.title,
        topic: video.topic,
        style,
        videoId: video.id,
        variant: true,
      });
      // Ensure a primary thumbnail exists — promote the first variant
      if (!readMedia(video.id, "thumbnail.png")) {
        promoteVariant(video.id, style);
      }
    }

    const nextStatus = deriveStatus(video, { hasThumbnail: true });
    const updated = await db.video.update({
      where: { id },
      data: { hasThumbnail: true, status: nextStatus, error: null },
    });

    await db.activity.create({
      data: {
        videoId: id,
        stage: "thumbnail",
        message: `A/B thumbnail set generated for "${video.title}" (${styles.length} styles)`,
      },
    });

    return NextResponse.json({
      variants: variantDTOs(id, updated.thumbStyle),
      styles,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Variant generation failed";
    await db.activity.create({
      data: {
        videoId: id,
        stage: "thumbnail",
        level: "error",
        message: `A/B thumbnail set failed: ${message}`,
      },
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** PATCH — promote a variant to be the primary thumbnail. */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  let body: { style?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const style = (body.style ?? "").trim();
  if (!style)
    return NextResponse.json({ error: "Pick a style to promote" }, { status: 400 });

  const video = await db.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });

  try {
    promoteVariant(id, style);
  } catch {
    return NextResponse.json(
      { error: `No variant named "${style}" — generate the A/B set first` },
      { status: 404 }
    );
  }

  const updated = await db.video.update({
    where: { id },
    data: { thumbStyle: style, hasThumbnail: true },
  });

  await db.activity.create({
    data: {
      videoId: id,
      stage: "thumbnail",
      message: `"${video.title ?? video.topic}" thumbnail switched to the ${style} variant`,
    },
  });

  return NextResponse.json({
    variants: variantDTOs(id, style),
    thumbStyle: updated.thumbStyle,
  });
}
