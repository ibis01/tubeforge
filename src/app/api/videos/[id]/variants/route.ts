import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { listVariants, promoteVariant } from "@/lib/tubeforge/ai";
import { isJobRunning, lastJobError, startJob } from "@/lib/tubeforge/jobs";
import { runVariantsJob } from "@/lib/tubeforge/video-jobs";
import { THUMB_STYLES, type VariantDTO } from "@/lib/tubeforge/types";

type Ctx = { params: Promise<{ id: string }> };

/** Build the variant list DTO for a video. */
async function variantDTOs(videoId: string, primaryStyle: string): Promise<VariantDTO[]> {
  return (await listVariants(videoId)).map((v) => ({
    style: v.style,
    label:
      THUMB_STYLES.find((s) => s.id === v.style)?.label ?? v.style,
    url: `/api/videos/${videoId}/variants/${v.style}`,
    isPrimary: v.style === primaryStyle,
  }));
}

/** GET — list A/B thumbnail variants (+ job state for polling). */
export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id }, select: { thumbStyle: true } });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });
  const generating = isJobRunning(id, "variants");
  return NextResponse.json({
    variants: await variantDTOs(id, video.thumbStyle),
    generating,
    error: generating ? null : lastJobError(id, "variants"),
  });
}

/** POST — kick off A/B variant set generation as a background job (returns 202 immediately). */
export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (!video.title)
    return NextResponse.json(
      { error: "Video has no title yet — generate the script first" },
      { status: 400 }
    );
  await startJob(id, "variants", () => runVariantsJob(id));

  return NextResponse.json({ accepted: true, generating: true }, { status: 202 });
}

/** PATCH — promote a variant to be the primary thumbnail. */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

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
    await promoteVariant(id, style);
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
      organizationId: auth.ctx.organizationId,
      userId: auth.ctx.userId,
      videoId: id,
      stage: "thumbnail",
      message: `"${video.title ?? video.topic}" thumbnail switched to the ${style} variant`,
    },
  });

  return NextResponse.json({
    variants: await variantDTOs(id, style),
    thumbStyle: updated.thumbStyle,
  });
}
