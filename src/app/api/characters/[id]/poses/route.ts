import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { startJob } from "@/lib/tubeforge/jobs";
import {
  generateCharacterPoses,
  listPoses,
  portraitExists,
} from "@/lib/tubeforge/characters";
import { POSES } from "@/lib/tubeforge/types";

type Ctx = { params: Promise<{ id: string }> };

/** GET — which poses exist so far. */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const character = await db.character.findUnique({ where: { id } });
  if (!character)
    return NextResponse.json({ error: "Character not found" }, { status: 404 });

  const existing = new Set(listPoses(id));
  return NextResponse.json({
    poses: POSES.filter((p) => existing.has(p.id)).map((p) => ({
      pose: p.id,
      label: p.label,
      url: `/api/characters/${id}/poses/${p.id}`,
    })),
    generating: false,
  });
}

/** POST — generate the full consistency sheet (3 poses) as a 202 background job. */
export async function POST(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const character = await db.character.findUnique({ where: { id } });
  if (!character)
    return NextResponse.json({ error: "Character not found" }, { status: 404 });

  if (!portraitExists(id))
    return NextResponse.json(
      { error: "Generate the reference portrait first" },
      { status: 400 }
    );

  const started = startJob(id, "poses", async () => {
    const result = await generateCharacterPoses({
      characterId: id,
      identityAnchor: character.identityAnchor,
    });
    await db.activity.create({
      data: {
        stage: "character",
        message: `Consistency sheet complete for ${character.name} — ${result.generated.length} identity-locked poses`,
      },
    });
  });

  if (!started)
    return NextResponse.json({ error: "Pose generation already running" }, { status: 409 });

  return NextResponse.json({ started: true }, { status: 202 });
}
