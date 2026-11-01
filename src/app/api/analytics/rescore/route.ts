import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { applyPerformanceBoost, getAnalyticsOverview } from "@/lib/tubeforge/analytics";
import { serializeSession } from "@/lib/tubeforge/research";
import type { ResearchIdea } from "@/lib/tubeforge/types";

/**
 * POST — re-apply the performance boost to a Topic Radar session using the
 * latest synced YouTube stats. Body: { sessionId?: string } (defaults to the
 * most recent session). Persists the updated ideas back into the session.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  let body: { sessionId?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body is allowed */
  }

  const session = body.sessionId
    ? await db.researchSession.findUnique({ where: { id: body.sessionId } })
    : await db.researchSession.findFirst({ orderBy: { createdAt: "desc" } });

  if (!session)
    return NextResponse.json(
      { error: "No Topic Radar session to boost yet — run a scan first" },
      { status: 404 }
    );

  // Need a real performance spread before the loop will move scores.
  const overview = await getAnalyticsOverview();
  if (!overview.feedback.active)
    return NextResponse.json(
      {
        error:
          "Not enough synced performance data yet — sync stats for at least 3 published videos first (Analytics view)",
      },
      { status: 400 }
    );

  let ideas: ResearchIdea[];
  try {
    const parsed = JSON.parse(session.ideas) as { ideas?: ResearchIdea[] };
    ideas = Array.isArray(parsed.ideas) ? parsed.ideas : [];
  } catch {
    ideas = [];
  }
  if (ideas.length === 0)
    return NextResponse.json({ error: "This session has no ideas stored" }, { status: 400 });

  const result = await applyPerformanceBoost(ideas);

  // Persist the boosted ideas back into the session row.
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(session.ideas) as Record<string, unknown>;
  } catch {
    /* rebuild from scratch */
  }
  payload.ideas = result.ideas;

  const updated = await db.researchSession.update({
    where: { id: session.id },
    data: { ideas: JSON.stringify(payload) },
  });

  await db.activity.create({
    data: {
      organizationId: auth.ctx.organizationId,
      userId: auth.ctx.userId,
      stage: "analytics",
      message: `Performance boost re-applied to "${session.niche}" radar — ${result.boosted} idea${result.boosted === 1 ? "" : "s"} adjusted by real channel stats`,
    },
  });

  return NextResponse.json({
    sessionId: session.id,
    boosted: result.boosted,
    changed: result.changed,
    ideas: result.ideas,
    session: serializeSession(updated),
  });
}
