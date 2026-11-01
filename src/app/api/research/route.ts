import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { serializeSession, runResearchScan } from "@/lib/tubeforge/research";
import { startJob } from "@/lib/tubeforge/jobs";

/** GET — recent research sessions (newest first). */
export async function GET(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

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
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

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
      organizationId: auth.ctx.organizationId,
      niche,
      query: query || "—",
      ideas: JSON.stringify({ ideas: [], nicheSummary: "" }),
    },
  });

  // Stage 3 (T-3.5): the scan body lives in research.ts (runResearchScan) so
  // the request path and the durable queue execute the SAME code — a restart
  // re-runs it from the session row (niche + query are persisted above).
  const accepted = await startJob(row.id, "research", () => runResearchScan(row.id));

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
