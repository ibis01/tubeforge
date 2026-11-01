import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { parseScenes } from "@/lib/tubeforge/story";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Stage 5 (module C) — the human half of the cast appearance log.
 *
 * The director pass PROPOSES a per-scene outfit/accessory (persisted to
 * CharacterAppearance when the plan is generated); this route lets the human
 * EDIT that log — adjust the outfit, clear the accessory — before or after
 * approving the plan. The logged look weaves into host-scene image prompts
 * under an APPROVED plan (see getApprovedAppearanceClause), so after an edit
 * the user re-rolls the scene to repaint it in the corrected outfit.
 *
 * PUT { sceneIndex, outfit?, accessory? } — upsert the (video, scene,
 * character) row. Empty strings clear the fields; both empty deletes the row.
 */

const putSchema = z.object({
  sceneIndex: z.number().int().min(1),
  outfit: z.string().trim().max(160).optional(),
  accessory: z.string().trim().max(160).optional(),
});

export async function PUT(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (video.format !== "story")
    return NextResponse.json({ error: "Not a scene-based video" }, { status: 400 });
  if (!video.characterId)
    return NextResponse.json(
      { error: "This video has no recurring cast — there is no look to log" },
      { status: 400 }
    );

  const scenes = parseScenes(video.scenes);
  const body = await req.json().catch(() => null);
  const parsed = putSchema.safeParse(body);
  if (!parsed.success)
    return NextResponse.json(
      { error: "sceneIndex (integer ≥1) required; fields ≤ 160 characters" },
      { status: 400 }
    );
  const sceneIndex = parsed.data.sceneIndex;
  const scene = scenes.find((s) => s.index === sceneIndex);
  if (!scene)
    return NextResponse.json({ error: `Scene ${sceneIndex} does not exist` }, { status: 400 });
  if (!scene.hostInScene)
    return NextResponse.json(
      { error: `Scene ${sceneIndex} has no cast on screen — nothing to wear` },
      { status: 400 }
    );

  const outfit = parsed.data.outfit ?? null;
  const accessory = parsed.data.accessory ?? null;
  const where = {
    videoId_sceneIndex_characterId: {
      videoId: id,
      sceneIndex,
      characterId: video.characterId,
    },
  };

  if (!outfit && !accessory) {
    // Both cleared → the row serves no purpose; drop it so the prompt clause
    // disappears cleanly instead of surviving as an empty shell.
    await db.characterAppearance.deleteMany({ where: { videoId: id, sceneIndex } });
    return NextResponse.json({ appearance: null });
  }

  const appearance = await db.characterAppearance.upsert({
    where,
    create: {
      organizationId: video.organizationId,
      characterId: video.characterId,
      videoId: id,
      sceneIndex,
      outfit,
      accessory,
    },
    update: { outfit, accessory },
    select: { sceneIndex: true, outfit: true, accessory: true },
  });
  return NextResponse.json({ appearance });
}
