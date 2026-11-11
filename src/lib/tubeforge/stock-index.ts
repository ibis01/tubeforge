// S89 (ROADMAP #8, S76 §5 P2) — the stock source adapter contract + the
// per-scene candidate index.
//
// The pre-S89 lane hard-coded two provider searches inside stock.ts and
// scored candidates on resolution/duration alone. The spec asks for:
//   • a SOURCE ADAPTER CONTRACT — every source implements the same shape,
//     so Pexels/Pixabay become the first two adapters and any future source
//     (Wikimedia/NASA/Internet Archive/NOAA — evaluated INDIVIDUALLY, never
//     batched in) is a one-file addition plus its key wiring
//   • a searchable INDEX — candidates from ALL of a scene's queries gather
//     into one pool, deduped by their source-scoped id, so ranking sees the
//     whole field instead of per-query fragments
//
// THE LICENSE LAW: a candidate without a license label never enters the
// index. "No unverified footage silently accepted" starts here — an adapter
// that cannot state the license terms its results carry contributes nothing.
// Both current adapters attach their platform's known license constant.
//
// The pure parts (provider JSON normalization, index merge/dedupe) are
// exported for the offline unit suite; only fetchJson does I/O.

import { log } from "./log";

const indexLog = log.child({ mod: "stock-index" });

/** One normalized candidate clip, provider-agnostic. */
export interface StockCandidate {
  source: "pexels" | "pixabay"; // widens the day a third adapter lands
  /** The clip's id at its source — the dedupe key half (`source:id`). */
  id: string;
  /** Direct downloadable video file URL (mp4). */
  url: string;
  width: number;
  height: number;
  durationSec: number;
  author: string;
  pageUrl: string;
  /** REQUIRED — the license every result from this source carries. */
  license: string;
  /** Pixabay returns tags; Pexels video search does not (factor stays neutral). */
  tags?: string[];
}

/** The source adapter contract (S76 §5 P2). */
export interface StockSourceAdapter {
  id: StockCandidate["source"];
  label: string;
  /** The license label stamped on every candidate this adapter returns. */
  license: string;
  keyUrl: string;
  search(query: string, apiKey: string): Promise<StockCandidate[]>;
}

/** One indexed candidate: the clip + every scene query that surfaced it. */
export interface SceneIndexEntry {
  candidate: StockCandidate;
  matchedQueries: string[];
}

/** The stock keys shape (readStockKeys). */
export type StockKeys = { pexels: string; pixabay: string };

/** The stable dedupe key for a candidate (`pexels:1234`). */
export function clipKey(c: Pick<StockCandidate, "source" | "id">): string {
  return `${c.source}:${c.id}`;
}

// ---------- fetch plumbing (the only I/O in this module) ----------

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs = 20000
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403)
        throw new Error("invalid API key (check it in Settings → Stock footage)");
      if (res.status === 429) throw new Error("rate limited — try again in a minute");
      throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 160)}` : ""}`);
    }
    return await res.json();
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError")
      throw new Error("provider timed out");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Pexels (video search) ----------
// https://www.pexels.com/api/documentation/#videos

interface PexelsVideoFile {
  link?: string;
  width?: number;
  height?: number;
  file_type?: string;
}

/** Pure: normalize a Pexels video-search response into candidates. */
export function pexelsParse(data: unknown): StockCandidate[] {
  const d = data as {
    videos?: {
      id: number;
      duration: number;
      width: number;
      height: number;
      url?: string;
      user?: { name?: string };
      video_files?: PexelsVideoFile[];
    }[];
  };
  const out: StockCandidate[] = [];
  for (const v of d.videos ?? []) {
    // Prefer the largest landscape mp4 file for this video.
    const files = (v.video_files ?? [])
      .filter(
        (f) =>
          f.file_type === "video/mp4" &&
          (f.width ?? 0) >= 1280 &&
          (f.width ?? 0) > (f.height ?? 1)
      )
      .sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
    const best = files[0];
    if (!best?.link) continue;
    out.push({
      source: "pexels",
      id: String(v.id ?? ""),
      url: best.link,
      width: best.width ?? v.width ?? 0,
      height: best.height ?? v.height ?? 0,
      durationSec: v.duration ?? 0,
      author: v.user?.name?.trim() || "Pexels creator",
      pageUrl: v.url || "https://www.pexels.com/videos/",
      license: "Pexels License",
    });
  }
  return out;
}

const pexelsAdapter: StockSourceAdapter = {
  id: "pexels",
  label: "Pexels",
  license: "Pexels License",
  keyUrl: "https://www.pexels.com/api/",
  async search(query, apiKey) {
    const url =
      `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}` +
      `&orientation=landscape&size=medium&per_page=15`;
    return pexelsParse(await fetchJson(url, { Authorization: apiKey }));
  },
};

// ---------- Pixabay (film = live-action footage, not animations) ----------
// https://pixabay.com/api/docs/#api_videos

/** Pure: normalize a Pixabay video-search response into candidates. */
export function pixabayParse(data: unknown): StockCandidate[] {
  const d = data as {
    hits?: {
      id?: number;
      pageURL?: string;
      tags?: string;
      duration: number;
      videos?: Record<string, { url?: string; width?: number; height?: number } | undefined>;
      user?: string;
    }[];
  };
  const out: StockCandidate[] = [];
  for (const hit of d.hits ?? []) {
    const entries = Object.values(hit.videos ?? {}).filter(
      (f): f is { url: string; width: number; height: number } =>
        Boolean(f?.url) && (f?.width ?? 0) >= 1280 && (f?.width ?? 0) > (f?.height ?? 1)
    );
    const best = entries.sort((a, b) => b.width - a.width)[0];
    if (!best) continue;
    out.push({
      source: "pixabay",
      id: String(hit.id ?? ""),
      url: best.url,
      width: best.width,
      height: best.height,
      durationSec: hit.duration ?? 0,
      author: hit.user?.trim() || "Pixabay creator",
      pageUrl: hit.pageURL || "https://pixabay.com/videos/",
      license: "Pixabay Content License",
      tags: (hit.tags ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 12),
    });
  }
  return out;
}

const pixabayAdapter: StockSourceAdapter = {
  id: "pixabay",
  label: "Pixabay",
  license: "Pixabay Content License",
  keyUrl: "https://pixabay.com/api/docs/#api_key",
  async search(query, apiKey) {
    const url =
      `https://pixabay.com/api/videos/?key=${encodeURIComponent(apiKey)}` +
      `&q=${encodeURIComponent(query)}&video_type=film&safesearch=true&per_page=24`;
    return pixabayParse(await fetchJson(url, {}));
  },
};

// ---------- the registry ----------

/** The registered adapters, in stable order. */
export const STOCK_SOURCES: readonly StockSourceAdapter[] = [pexelsAdapter, pixabayAdapter];

/**
 * The adapters with a configured key. Zero configured → the pinned operator
 * error (byte-identical to the pre-S89 message: the queue suite and the
 * POST /stock gate assert it).
 */
export function configuredSources(keys: StockKeys): StockSourceAdapter[] {
  const out = STOCK_SOURCES.filter((s) => keys[s.id].trim() !== "");
  if (out.length === 0)
    throw new Error(
      "No stock provider is configured — add a free Pexels or Pixabay key in Settings → Stock footage"
    );
  return out;
}

// ---------- the index ----------

/**
 * Pure: merge one query's candidates into the index. Same `source:id`
 * surfacing again under another query UNIONS its matchedQueries (the
 * strongest relevance signal we have pre-download) instead of duplicating
 * the row. Insertion order is preserved (first sighting wins the position).
 */
export function mergeIntoIndex(
  index: Map<string, SceneIndexEntry>,
  query: string,
  candidates: StockCandidate[]
): Map<string, SceneIndexEntry> {
  for (const c of candidates) {
    // THE LICENSE LAW — no license, no entry (see module header).
    if (!c.license || !c.id || !c.url) continue;
    const key = clipKey(c);
    const existing = index.get(key);
    if (existing) {
      if (!existing.matchedQueries.includes(query)) existing.matchedQueries.push(query);
    } else {
      index.set(key, { candidate: c, matchedQueries: [query] });
    }
  }
  return index;
}

/**
 * Build one scene's candidate index: every query × every configured source,
 * fail-soft per (source, query) — a misbehaving source or a dead query never
 * blocks the others (the pre-S89 per-provider semantics, kept). Only the
 * zero-configured-providers error propagates.
 */
export async function buildSceneIndex(opts: {
  queries: string[];
  keys: StockKeys;
}): Promise<SceneIndexEntry[]> {
  const sources = configuredSources(opts.keys);
  const index = new Map<string, SceneIndexEntry>();
  for (const query of opts.queries) {
    for (const source of sources) {
      try {
        const candidates = await source.search(query, opts.keys[source.id]);
        mergeIntoIndex(index, query, candidates);
      } catch (err) {
        indexLog.warn("source search failed (skipped)", {
          source: source.id,
          query,
          err: err instanceof Error ? err.message : err,
        });
      }
    }
  }
  return [...index.values()];
}
