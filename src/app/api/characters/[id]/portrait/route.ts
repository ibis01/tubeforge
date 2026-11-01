import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { startJob, lastJobError } from "@/lib/tubeforge/jobs";
import {
  generateCharacterPortrait,
  readPortrait,
  serializeCharacter,
} from "@/lib/tubeforge/characters";

type Ctx = { params: Promise<{ id: string }> };

/** POST — kick off portrait generation as a 202 background job (gateway-proof). */
export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const { id } = await ctx.params;
  const character = await db.character.findUnique({ where: { id } });
  if (!character)
    return NextResponse.json({ error: "Character not found" }, { status: 404 });

  if (!character.appearance && !character.identityAnchor)
    return NextResponse.json(
      { error: "Add an appearance description (or run the AI bible) first" },
      { status: 400 }
    );

  const started = await startJob(id, "portrait", async () => {
    const result = await generateCharacterPortrait({
      characterId: id,
      name: character.name,
      appearance: character.appearance,
      identityAnchor: character.identityAnchor,
      artStyle: character.artStyle,
    });
    await db.character.update({
      where: { id },
      data: { hasPortrait: true },
    });
    await db.activity.create({
      data: {
        organizationId: auth.ctx.organizationId,
        userId: auth.ctx.userId,
        stage: "character",
        message: `Reference portrait generated for ${character.name} (${Math.round(
          result.fileBytes / 1024
        )} KB)`,
      },
    });
  });

  if (!started)
    return NextResponse.json({ error: "Portrait generation already running" }, { status: 409 });

  return NextResponse.json({ started: true }, { status: 202 });
}

/** GET — stream the portrait PNG (or 404 when not generated yet). */
export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const { id } = await ctx.params;
  // Scoped lookup FIRST — uploads/characters/<id>/portrait.png is only read
  // after the row is proven to belong to the caller's organization.
  const character = await db.character.findUnique({ where: { id } });
  if (!character)
    return NextResponse.json({ error: "Character not found" }, { status: 404 });

  const png = readPortrait(id);
  if (!png)
    return NextResponse.json({ error: "Portrait not generated yet" }, { status: 404 });
  return new NextResponse(new Uint8Array(png), {
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(png.length),
      "Cache-Control": "no-store",
    },
  });
}

/** PATCH — clear a failed portrait job error (used by the client after showing it). */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const { id } = await ctx.params;
  const error = lastJobError(id, "portrait");
  const character = await db.character.findUnique({ where: { id } });
  if (!character)
    return NextResponse.json({ error: "Character not found" }, { status: 404 });
  return NextResponse.json({
    character: serializeCharacter(character, 0),
    lastError: error,
  });
}
