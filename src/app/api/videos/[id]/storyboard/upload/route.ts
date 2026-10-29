import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { parseScenes, storyboardComplete, replaceSceneImage } from "@/lib/tubeforge/story";
import { invalidateRenderedArtifacts } from "@/lib/tubeforge/render";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST — Scene Studio upload: replace ONE scene's storyboard image with the
 * user's own artwork (multipart: scene + file). The file is cover-cropped to
 * the pipeline canvas (1344x768) so renders treat it like generated art.
 * Renders become stale and are removed; voiceover is untouched.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (video.format !== "story")
    return NextResponse.json(
      { error: "Not a scene-based video — scene images apply to scene-format videos" },
      { status: 400 }
    );

  const scenes = parseScenes(video.scenes);
  if (scenes.length === 0)
    return NextResponse.json(
      { error: "Video has no scenes — generate the scene script first" },
      { status: 400 }
    );

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected a multipart form with a scene and an image file" }, { status: 400 });
  }

  const index = Number(form.get("scene"));
  const file = form.get("file");
  if (!Number.isInteger(index) || index < 1)
    return NextResponse.json({ error: "A valid scene number is required" }, { status: 400 });
  if (!(file instanceof File))
    return NextResponse.json({ error: "Attach the image as the 'file' field" }, { status: 400 });

  if (!scenes.some((s) => s.index === index))
    return NextResponse.json({ error: `Scene ${index} does not exist` }, { status: 404 });

  const buffer = Buffer.from(await file.arrayBuffer());
  try {
    await replaceSceneImage(id, index, buffer);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Image upload failed";
    const status = message.includes("exceeds") ? 413 : 400;
    return NextResponse.json({ error: message }, { status });
  }

  // The uploaded art IS the storyboard frame now — derived artifacts are stale
  // (slide PNGs too: photo-layout slides embed the scene art).
  invalidateRenderedArtifacts(id, { slidePngs: true });
  await db.video.update({
    where: { id },
    data: {
      hasStoryboard: storyboardComplete(id, scenes),
      hasVideo: false,
      videoDuration: null,
      error: null,
    },
  });
  await db.activity.create({
    data: {
      videoId: id,
      stage: "storyboard",
      message: `Scene ${index} image replaced with an uploaded artwork`,
    },
  });

  return NextResponse.json({ ok: true, scene: index });
}
