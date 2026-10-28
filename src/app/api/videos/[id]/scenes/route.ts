import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { parseScenes, serializeScenes } from "@/lib/tubeforge/story";
import { CAMERAS, sanitizeSceneStyle } from "@/lib/tubeforge/types";

type Ctx = { params: Promise<{ id: string }> };

/**
 * PATCH — Scene Studio text edits for ONE scene (index-keyed).
 * Body: { index, visual?, mood?, caption?, camera?, style? }
 *
 * Only the scene JSON is touched — the storyboard image and any rendered MP4
 * stay valid, so this is safe to call while a video exists. The new prompt
 * takes effect on the next Regenerate (POST storyboard { scene }).
 */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (video.format !== "story")
    return NextResponse.json(
      { error: "Not a scene-based video — scene editing applies to scene-format videos" },
      { status: 400 }
    );

  const body = await req.json().catch(() => null);
  const index = Number(body?.index);
  if (!Number.isInteger(index) || index < 1)
    return NextResponse.json({ error: "A valid scene index is required" }, { status: 400 });

  const scenes = parseScenes(video.scenes);
  const scene = scenes.find((s) => s.index === index);
  if (!scene)
    return NextResponse.json({ error: `Scene ${index} does not exist` }, { status: 404 });

  // Field-by-field validation — every present field must earn its way in.
  let changed = false;

  if (body?.visual !== undefined) {
    const visual = String(body.visual).trim();
    if (visual.length < 3)
      return NextResponse.json({ error: "The visual prompt needs at least 3 characters" }, { status: 400 });
    if (visual.length > 1200)
      return NextResponse.json({ error: "Visual prompt too long — keep it under 1200 characters" }, { status: 400 });
    scene.visual = visual;
    changed = true;
  }
  if (body?.mood !== undefined) {
    const mood = String(body.mood).trim().slice(0, 200);
    scene.mood = mood;
    changed = true;
  }
  if (body?.caption !== undefined) {
    scene.caption = String(body.caption).trim().slice(0, 60);
    changed = true;
  }
  if (body?.camera !== undefined) {
    const camera = String(body.camera);
    if (!CAMERAS.some((c) => c.id === camera))
      return NextResponse.json({ error: `Unknown camera move "${camera}"` }, { status: 400 });
    scene.camera = camera;
    changed = true;
  }
  if (body?.style !== undefined) {
    scene.style = sanitizeSceneStyle(body.style);
    changed = true;
  }

  if (!changed)
    return NextResponse.json({ error: "Nothing to update — send at least one scene field" }, { status: 400 });

  const updated = scenes.map((s) => (s.index === index ? scene : s));
  await db.video.update({ where: { id }, data: { scenes: JSON.stringify(updated) } });

  return NextResponse.json({
    scene: serializeScenes(id, updated).find((s) => s.index === index) ?? null,
  });
}
