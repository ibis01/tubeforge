import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { generateTopicResearch } from "@/lib/tubeforge/ai";
import { applyPerformanceBoost } from "@/lib/tubeforge/analytics";
import { serializeSession } from "@/lib/tubeforge/research";
import { errorText } from "@/lib/tubeforge/redact";

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

    // Phase 5 — lift/ding the fresh ideas with real channel performance.
    const boosted = await applyPerformanceBoost(result.ideas);
    const finalResult = { ...result, ideas: boosted.ideas };

    const row = await db.researchSession.create({
      data: {
        niche,
        query: query || "—",
        ideas: JSON.stringify(finalResult),
      },
    });

    await db.activity.create({
      data: {
        stage: "research",
        message: `Topic Radar scanned "${niche}"${query ? ` for "${query}"` : ""} — ${finalResult.ideas.length} ideas found${boosted.boosted > 0 ? ` (${boosted.boosted} performance-boosted)` : ""}`,
      },
    });

    return NextResponse.json({ session: serializeSession(row) });
  } catch (err) {
    const message = errorText(err, "Research failed");
    await db.activity.create({
      data: { stage: "research", level: "error", message: `Topic Radar failed: ${message}` },
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
