// Shared serializer for ResearchSession rows (used by API routes) + the
// durable research-scan job body (Stage 3, T-3.5).

import { db } from "./tenant-db";
import { assertCtx } from "./tenant";
import { generateTopicResearch } from "./ai";
import { applyPerformanceBoost } from "./analytics";
import { errorText } from "./redact";
import { aiCall } from "./budget";
import { llmWebSearch } from "./llm";
import type { ResearchSessionDTO, ResearchIdea, ResearchSource } from "./types";

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
 * Stage 5 (module A) — attach REAL web sources to the LLM-synthesized ideas.
 *
 * One web search per scan (the niche + query the user asked about); results
 * are matched to ideas by keyword overlap — a source is relevant to an idea
 * when the idea's keywords appear in the source's title/snippet. Pure +
 * unit-tested: the scan is the only caller, but the matching policy (what
 * earns a citation) deserves a pin.
 */
export function matchSourcesToIdeas(
  ideas: ResearchIdea[],
  results: { url: string; name: string; snippet: string; host: string }[],
  maxPerIdea = 3
): Map<string, ResearchSource[]> {
  const byIdea = new Map<string, ResearchSource[]>();
  if (results.length === 0) return byIdea;

  // Tokenize a source's text once: lowercase words ≥3 chars.
  const tokenize = (text: string): Set<string> =>
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 3)
    );

  const tokenized = results.map((r) => ({
    result: r,
    tokens: tokenize(`${r.name} ${r.snippet} ${r.host}`),
  }));

  for (const idea of ideas) {
    const scored = tokenized
      .map(({ result, tokens }) => {
        const hits = idea.keywords.filter((k) =>
          k
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter(Boolean)
            .some((w) => tokens.has(w))
        ).length;
        return { result, score: hits };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxPerIdea)
      .map((x) => ({
        url: x.result.url,
        name: x.result.name,
        host: x.result.host,
      }));
    if (scored.length > 0) byIdea.set(idea.id, scored);
  }
  return byIdea;
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
    let ideas = boosted.ideas;

    // Stage 5 (module A) — ground the scan with one real web search. Fail-open
    // by contract (llmWebSearch returns [] on any failure): ideas without
    // sources are still shipped, exactly as before.
    const searchQuery =
      `${session.niche}${session.query && session.query !== "—" ? ` ${session.query}` : ""}`.trim();
    const results = await aiCall("search", "research web grounding", () =>
      llmWebSearch(searchQuery, 10)
    ).catch(() => []);
    if (results.length > 0) {
      const sources = matchSourcesToIdeas(ideas, results);
      ideas = ideas.map((idea) =>
        sources.has(idea.id) ? { ...idea, sources: sources.get(idea.id) } : idea
      );
    }

    const finalResult = { ...result, ideas };

    await db.researchSession.update({
      where: { id: sessionId },
      data: { ideas: JSON.stringify(finalResult) },
    });
    await db.activity.create({
      data: {
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        stage: "research",
        message: `Topic Radar scanned "${session.niche}"${session.query && session.query !== "—" ? ` for "${session.query}"` : ""} — ${ideas.length} ideas found${boosted.boosted > 0 ? ` (${boosted.boosted} performance-boosted)` : ""}${results.length > 0 ? ` · ${ideas.filter((i) => i.sources?.length).length} source-grounded` : ""}`,
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
