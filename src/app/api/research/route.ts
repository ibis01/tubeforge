import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { generateTopicResearch } from "@/lib/tubeforge/ai";
import { serializeSession } from "@/lib/tubeforge/research";

/** GET — recent research sessions (newest first). */
export async function GET(req: NextRequest) {
  const limit = Math.min(
    20,
    Math.max(1, Number(req.nextUrl.searchParams.get("limit") ?? 10) || 10)
  );
  const sessions = await db.researchSession.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return NextResponse.json({
    sessions: sessions.map(serializeSession),
  });
}

/** POST — run a Topic Radar research pass and store it. */
export async function POST(req: NextRequest) {
  let body: { niche?: string; query?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const niche = (body.niche ?? "").trim();
  const query = (body.query ?? "").trim();
  if (!niche)
    return NextResponse.json({ error: "Pick a niche first" }, { status: 400 });

  try {
    const result = await generateTopicResearch({ niche, query });

    const row = await db.researchSession.create({
      data: {
        niche,
        query: query || "—",
        ideas: JSON.stringify(result),
      },
    });

    await db.activity.create({
      data: {
        stage: "research",
        message: `Topic Radar scanned "${niche}"${query ? ` for "${query}"` : ""} — ${result.ideas.length} ideas found`,
      },
    });

    return NextResponse.json({ session: serializeSession(row) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Research failed";
    await db.activity.create({
      data: { stage: "research", level: "error", message: `Topic Radar failed: ${message}` },
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
