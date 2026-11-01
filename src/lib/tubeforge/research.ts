// Shared serializer for ResearchSession rows (used by API routes) + the
// durable research-scan job body (Stage 3, T-3.5).

import { db } from "./tenant-db";
import { assertCtx } from "./tenant";
import { generateTopicResearch } from "./ai";
import { applyPerformanceBoost } from "./analytics";
import { errorText } from "./redact";
import type { ResearchSessionDTO, ResearchIdea } from "./types";

interface StoredPayload {
  ideas?: ResearchIdea[];
  nicheSummary?: string;
  // Persisted by the jobbed research scan (Stage 1, T-1.10) when generation
  // fails — survives restarts, unlike the job registry's in-memory error.
  error?: string;
}

export function serializeSession(row: {
  id: string;
  niche: string;
  query: string;
  ideas: string;
  createdAt: Date;
}): ResearchSessionDTO {
  let ideas: ResearchIdea[] = [];
  let nicheSummary = "";
  let error: string | null = null;
  try {
    const parsed = JSON.parse(row.ideas) as StoredPayload;
    ideas = Array.isArray(parsed.ideas) ? parsed.ideas : [];
    nicheSummary = parsed.nicheSummary ?? "";
    error = typeof parsed.error === "string" ? parsed.error : null;
  } catch {
    // legacy/corrupt rows degrade to empty ideas
  }
  return {
    id: row.id,
    niche: row.niche,
    query: row.query,
    nicheSummary,
    ideas,
    error,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The research-scan job body — extracted from the POST /api/research closure
 * (Stage 3, T-3.5) so the SAME code runs from the request path and from the
 * durable queue (boot re-enqueue / standalone worker). Everything derives
 * from the session row (niche, query), so a restart resumes the scan.
 * Must run inside a tenant ctx (the queue restores it from the Job row).
 */
export async function runResearchScan(sessionId: string): Promise<void> {
  const ctx = assertCtx("runResearchScan");
  const session = await db.researchSession.findUnique({ where: { id: sessionId } });
  if (!session) return; // deleted while queued — end quietly

  try {
    const result = await generateTopicResearch({ niche: session.niche, query: session.query });
    const boosted = await applyPerformanceBoost(result.ideas);
    const finalResult = { ...result, ideas: boosted.ideas };

    await db.researchSession.update({
      where: { id: sessionId },
      data: { ideas: JSON.stringify(finalResult) },
    });
    await db.activity.create({
      data: {
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        stage: "research",
        message: `Topic Radar scanned "${session.niche}"${session.query && session.query !== "—" ? ` for "${session.query}"` : ""} — ${finalResult.ideas.length} ideas found${boosted.boosted > 0 ? ` (${boosted.boosted} performance-boosted)` : ""}`,
      },
    });
  } catch (err) {
    const message = errorText(err, "Research failed");
    // Persist the failure on the session itself — the job registry's
    // in-memory lastJobError is lost on restart, the row is not.
    await db.researchSession
      .update({
        where: { id: sessionId },
        data: { ideas: JSON.stringify({ ideas: [], nicheSummary: "", error: message }) },
      })
      .catch(() => {});
    await db.activity
      .create({
        data: {
          organizationId: ctx.organizationId,
          userId: ctx.userId,
          stage: "research",
          level: "error",
          message: `Topic Radar failed: ${message}`,
        },
      })
      .catch(() => {});
    throw err;
  }
}
