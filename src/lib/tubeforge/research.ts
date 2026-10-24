// Shared serializer for ResearchSession rows (used by API routes).

import type { ResearchSessionDTO, ResearchIdea } from "./types";

interface StoredPayload {
  ideas?: ResearchIdea[];
  nicheSummary?: string;
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
  try {
    const parsed = JSON.parse(row.ideas) as StoredPayload;
    ideas = Array.isArray(parsed.ideas) ? parsed.ideas : [];
    nicheSummary = parsed.nicheSummary ?? "";
  } catch {
    // legacy/corrupt rows degrade to empty ideas
  }
  return {
    id: row.id,
    niche: row.niche,
    query: row.query,
    nicheSummary,
    ideas,
    createdAt: row.createdAt.toISOString(),
  };
}
