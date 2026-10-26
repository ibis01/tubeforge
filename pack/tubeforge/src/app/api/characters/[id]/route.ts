import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  serializeCharacter,
  buildAnchorFallback,
  deleteCharacterFiles,
} from "@/lib/tubeforge/characters";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const character = await db.character.findUnique({
    where: { id },
    include: { _count: { select: { videos: true } } },
  });
  if (!character)
    return NextResponse.json({ error: "Character not found" }, { status: 404 });
  return NextResponse.json({
    character: serializeCharacter(character, character._count.videos),
  });
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const body = await req.json();

  const character = await db.character.findUnique({ where: { id } });
  if (!character)
    return NextResponse.json({ error: "Character not found" }, { status: 404 });

  const data: Record<string, unknown> = {};
  if (typeof body.name === "string" && body.name.trim())
    data.name = body.name.trim().slice(0, 60);
  if (typeof body.role === "string" || body.role === null)
    data.role = body.role;
  if (typeof body.personality === "string" || body.personality === null)
    data.personality = body.personality;
  if (typeof body.appearance === "string" || body.appearance === null)
    data.appearance = body.appearance;
  if (typeof body.voice === "string") data.voice = body.voice;
  if (typeof body.artStyle === "string") data.artStyle = body.artStyle;
  if (typeof body.identityAnchor === "string" || body.identityAnchor === null)
    data.identityAnchor = body.identityAnchor;
  // Re-derive a fallback anchor if visuals changed and no explicit anchor given
  else if (
    (typeof body.appearance === "string" || typeof body.artStyle === "string") &&
    !body.identityAnchor
  ) {
    const appearance =
      typeof body.appearance === "string" ? body.appearance : character.appearance;
    const artStyle =
      typeof body.artStyle === "string" ? body.artStyle : character.artStyle;
    if (appearance || artStyle)
      data.identityAnchor = buildAnchorFallback(appearance ?? null, artStyle);
  }
  if (typeof body.isActive === "boolean") data.isActive = body.isActive;

  const updated = await db.character.update({
    where: { id },
    data,
    include: { _count: { select: { videos: true } } },
  });
  return NextResponse.json({
    character: serializeCharacter(updated, updated._count.videos),
  });
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const character = await db.character.findUnique({ where: { id } });
  if (!character)
    return NextResponse.json({ error: "Character not found" }, { status: 404 });

  await db.character.delete({ where: { id } });
  deleteCharacterFiles(id);
  return NextResponse.json({ success: true });
}
