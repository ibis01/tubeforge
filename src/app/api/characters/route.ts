import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serializeCharacter, buildAnchorFallback } from "@/lib/tubeforge/characters";
import { errorText } from "@/lib/tubeforge/redact";

export async function GET() {
  const characters = await db.character.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { videos: true } } },
  });
  return NextResponse.json({
    characters: characters.map((c) => serializeCharacter(c, c._count.videos)),
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const name = String(body.name ?? "").trim();
    if (!name)
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    if (name.length > 60)
      return NextResponse.json({ error: "Name too long" }, { status: 400 });

    const role = body.role != null ? String(body.role).slice(0, 200) : null;
    const personality =
      body.personality != null ? String(body.personality).slice(0, 2000) : null;
    const appearance =
      body.appearance != null ? String(body.appearance).slice(0, 2000) : null;
    const voice = String(body.voice ?? "jam");
    const artStyle = String(body.artStyle ?? "cinematic");
    // Seed an initial anchor from manual fields so portrait generation works
    // even before GLM has crafted the canonical identity anchor.
    const identityAnchor =
      body.identityAnchor != null && String(body.identityAnchor).trim()
        ? String(body.identityAnchor).slice(0, 1000)
        : buildAnchorFallback(appearance, artStyle);

    const character = await db.character.create({
      data: { name, role, personality, appearance, voice, artStyle, identityAnchor },
      include: { _count: { select: { videos: true } } },
    });

    return NextResponse.json(
      { character: serializeCharacter(character, character._count.videos) },
      { status: 201 }
    );
  } catch (err) {
    const message = errorText(err, "Invalid request");
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
