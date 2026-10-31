import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { generateTopicResearch } from "@/lib/tubeforge/ai";
import { applyPerformanceBoost } from "@/lib/tubeforge/analytics";
import { serializeSession } from "@/lib/tubeforge/research";
import { startJob } from "@/lib/tubeforge/jobs";
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

/**
 * POST — run a Topic Radar research pass and store it.
 *
 * Stage 1 of the roadmap (task T-1.10): the LLM scan moved OFF the request
 * path — the session row is created immediately (empty ideas) and the scan
 * runs as a background "research" job. Response is 202; clients poll
 * GET /api/research/[id] until `generating` clears.
 */
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

  // Create the shell row up-front so the job has a stable id to update.
  const row = await db.researchSession.create({
    data: {
      niche,
      query: query || "—",
      ideas: JSON.stringify({ ideas: [], nicheSummary: "" }),
    },
  });

  const accepted = await startJob(row.id, "research", async () => {
    try {
      const result = await generateTopicResearch({ niche, query });

      // Phase 5 — lift/ding the fresh ideas with real channel performance.
      const boosted = await applyPerformanceBoost(result.ideas);
      const finalResult = { ...result, ideas: boosted.ideas };

      await db.researchSession.update({
        where: { id: row.id },
        data: { ideas: JSON.stringify(finalResult) },
      });

      await db.activity.create({
        data: {
          stage: "research",
          message: `Topic Radar scanned "${niche}"${query ? ` for "${query}"` : ""} — ${finalResult.ideas.length} ideas found${boosted.boosted > 0 ? ` (${boosted.boosted} performance-boosted)` : ""}`,
        },
      });
    } catch (err) {
      const message = errorText(err, "Research failed");
      // Persist the failure on the session itself — the job registry's
      // in-memory lastJobError is lost on restart, the row is not.
      await db.researchSession
        .update({
          where: { id: row.id },
          data: { ideas: JSON.stringify({ ideas: [], nicheSummary: "", error: message }) },
        })
        .catch(() => {});
      await db.activity.create({
        data: { stage: "research", level: "error", message: `Topic Radar failed: ${message}` },
      });
      throw err;
    }
  });

  if (!accepted)
    return NextResponse.json(
      { error: "A research scan is already running" },
      { status: 409 }
    );

  return NextResponse.json(
    { session: serializeSession(row), generating: true },
    { status: 202 }
  );
}
