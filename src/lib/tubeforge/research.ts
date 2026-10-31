// Shared serializer for ResearchSession rows (used by API routes).

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
