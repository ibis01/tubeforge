import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { generateCharacterBible } from "@/lib/tubeforge/characters";
import { serializeCharacter } from "@/lib/tubeforge/characters";
import { errorText } from "@/lib/tubeforge/redact";

/**
 * POST — GLM "character bible": expands a name + short concept into a full
 * generation-ready profile. Synchronous (~5-8s) — safely under gateway timeout.
 * Body: { name, concept, niche?, characterId? } — when characterId is given,
 * the bible is applied to that character directly.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const name = String(body.name ?? "").trim();
    if (!name)
      return NextResponse.json({ error: "Name is required" }, { status: 400 });

    const concept = String(body.concept ?? "").slice(0, 600);
    const niche = body.niche ? String(body.niche) : undefined;

    const bible = await generateCharacterBible({ name, concept, niche });

    if (body.characterId) {
      const character = await db.character.findUnique({
        where: { id: String(body.characterId) },
      });
      if (!character)
        return NextResponse.json({ error: "Character not found" }, { status: 404 });

      const updated = await db.character.update({
        where: { id: character.id },
        data: {
          role: bible.role || character.role,
          personality: bible.personality || character.personality,
          appearance: bible.appearance || character.appearance,
          identityAnchor: bible.identityAnchor || character.identityAnchor,
          voice: bible.voice || character.voice,
          artStyle: bible.artStyle || character.artStyle,
        },
        include: { _count: { select: { videos: true } } },
      });
      return NextResponse.json({
        bible,
        character: serializeCharacter(updated, updated._count.videos),
      });
    }

    return NextResponse.json({ bible });
  } catch (err) {
    const message = errorText(err, "Bible generation failed");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
