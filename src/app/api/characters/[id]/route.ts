import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import {
  serializeCharacter,
  buildAnchorFallback,
  deleteCharacterFiles,
} from "@/lib/tubeforge/characters";

type Ctx = { params: Promise<{ id: string }> };

// Stage 1 (task T-1.11, audit gap R-HIGH-28): the PATCH path previously wrote
// role/personality/appearance verbatim (the POST path had caps, PATCH did
// not) — zod now bounds every text field to the same limits as POST.
const PatchCharacterSchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    role: z.string().max(200).nullable().optional(),
    personality: z.string().max(2000).nullable().optional(),
    appearance: z.string().max(2000).nullable().optional(),
    voice: z.string().min(1).max(100).optional(),
    artStyle: z.string().min(1).max(60).optional(),
    identityAnchor: z.string().max(2000).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const { id } = await ctx.params;
  // tenant-db injects organizationId — a foreign tenant's id resolves to
  // null here, exactly the 404 cross-tenant access must produce.
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
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const { id } = await ctx.params;
  const parsed = PatchCharacterSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json(
      { error: "Invalid character fields", details: parsed.error.flatten().fieldErrors },
      { status: 400 }
    );
  const body = parsed.data;

  const character = await db.character.findUnique({ where: { id } });
  if (!character)
    return NextResponse.json({ error: "Character not found" }, { status: 404 });

  const data: Record<string, unknown> = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.role !== undefined) data.role = body.role;
  if (body.personality !== undefined) data.personality = body.personality;
  if (body.appearance !== undefined) data.appearance = body.appearance;
  if (body.voice !== undefined) data.voice = body.voice;
  if (body.artStyle !== undefined) data.artStyle = body.artStyle;
  if (body.identityAnchor !== undefined) data.identityAnchor = body.identityAnchor;
  // Re-derive a fallback anchor if visuals changed and no explicit anchor given
  else if (
    (body.appearance !== undefined || body.artStyle !== undefined) &&
    !body.identityAnchor
  ) {
    const appearance =
      body.appearance !== undefined ? body.appearance : character.appearance;
    const artStyle =
      body.artStyle !== undefined ? body.artStyle : character.artStyle;
    if (appearance || artStyle)
      data.identityAnchor = buildAnchorFallback(appearance ?? null, artStyle);
  }
  if (body.isActive !== undefined) data.isActive = body.isActive;

  const updated = await db.character.update({
    where: { id },
    data,
    include: { _count: { select: { videos: true } } },
  });
  return NextResponse.json({
    character: serializeCharacter(updated, updated._count.videos),
  });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const { id } = await ctx.params;
  // Scoped lookup FIRST — the uploads/characters/<id>/ tree is only removed
  // after the row is proven to belong to the caller's organization.
  const character = await db.character.findUnique({ where: { id } });
  if (!character)
    return NextResponse.json({ error: "Character not found" }, { status: 404 });

  await db.character.delete({ where: { id } });
  deleteCharacterFiles(id);
  return NextResponse.json({ success: true });
}
