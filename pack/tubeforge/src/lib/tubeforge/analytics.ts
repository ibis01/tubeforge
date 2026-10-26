// Performance loop (Phase 5) — closes the growth engine's feedback circuit.
//
//   upload -> sync stats (YouTube Data API) -> VideoStat snapshots
//          -> Analytics view (totals, deltas, winners)
//          -> Topic Radar boost (winners' keywords lift similar new ideas)
//
// The boost is deterministic (keyword-overlap scoring, no AI call) so it can
// be re-applied on demand ("Re-boost radar") and tested end-to-end. The
// strategist prompt also receives a performance brief so fresh scans are
// steered by what the real audience rewarded.

import { db } from "@/lib/db";
import type { VideoStat } from "@prisma/client";
import type {
  AnalyticsOverviewDTO,
  AnalyticsRowDTO,
  ResearchIdea,
} from "./types";
import { fetchVideoStats, youtubeIdFromUrl, setSetting } from "./youtube";

// ---------- sync ----------

/**
 * Pull fresh stats for every published video (one batched API call) and
 * persist a VideoStat snapshot per video. Also records the real publish date
 * from the API. Returns a summary for the UI toast.
 */
export async function syncYouTubeStats(): Promise<{
  synced: number;
  skipped: number;
  totals: { views: number; likes: number; comments: number };
  syncedAt: string;
}> {
  const published = await db.video.findMany({
    where: { youtubeUrl: { not: null } },
    select: { id: true, youtubeUrl: true, publishedAt: true },
  });

  const byId = new Map<string, string>(); // youtubeId -> videoId
  for (const v of published) {
    const ytId = v.youtubeUrl ? youtubeIdFromUrl(v.youtubeUrl) : null;
    if (ytId) byId.set(ytId, v.id);
  }

  const youtubeIds = [...byId.keys()];
  if (youtubeIds.length === 0)
    throw new Error("No uploaded videos to sync yet — upload a video first");

  const remote = await fetchVideoStats(youtubeIds);

  let views = 0;
  let likes = 0;
  let comments = 0;
  let synced = 0;
  const now = new Date();

  for (const [ytId, videoId] of byId) {
    const stats = remote.get(ytId);
    if (!stats) continue; // private / deleted / different account — count as skipped

    await db.videoStat.create({
      data: {
        videoId,
        views: stats.views,
        likes: stats.likes,
        comments: stats.comments,
        favorites: stats.favorites,
        snapshotAt: now,
      },
    });

    // Real publish date (only meaningful once; keep the first one we see).
    if (stats.publishedAt) {
      const publishedAt = new Date(stats.publishedAt);
      const current = await db.video.findUnique({
        where: { id: videoId },
        select: { publishedAt: true },
      });
      if (current && !current.publishedAt && !Number.isNaN(publishedAt.getTime())) {
        await db.video.update({ where: { id: videoId }, data: { publishedAt } });
      }
    }

    views += stats.views;
    likes += stats.likes;
    comments += stats.comments;
    synced++;
  }

  const syncedAt = now.toISOString();
  await setSetting("ytStatsSyncedAt", syncedAt);

  await db.activity.create({
    data: {
      stage: "analytics",
      message: `Synced YouTube performance for ${synced} video${synced === 1 ? "" : "s"} — ${views.toLocaleString()} total views`,
    },
  });

  return { synced, skipped: youtubeIds.length - synced, totals: { views, likes, comments }, syncedAt };
}

// ---------- overview ----------

/** Latest snapshot per video, mapped videoId -> row. */
async function latestSnapshots(): Promise<Map<string, VideoStat>> {
  const rows = await db.videoStat.findMany({
    orderBy: { snapshotAt: "desc" },
  });
  const latest = new Map<string, VideoStat>();
  for (const row of rows) {
    if (!latest.has(row.videoId)) latest.set(row.videoId, row);
  }
  return latest;
}

/** All snapshots, ascending — used for series + delta computation. */
async function allSnapshots(): Promise<VideoStat[]> {
  return db.videoStat.findMany({ orderBy: { snapshotAt: "asc" } });
}

function engagementRate(views: number, likes: number, comments: number): number {
  if (views <= 0) return 0;
  return Math.min(1, (likes + comments) / views);
}

/** Aggregate channel performance for the Analytics view. */
export async function getAnalyticsOverview(): Promise<AnalyticsOverviewDTO> {
  const [latest, snapshots, published] = await Promise.all([
    latestSnapshots(),
    allSnapshots(),
    db.video.count({ where: { youtubeUrl: { not: null } } }),
  ]);

  const videos = await db.video.findMany({
    where: { id: { in: [...latest.keys()] } },
    select: {
      id: true,
      title: true,
      topic: true,
      niche: true,
      hasThumbnail: true,
      youtubeUrl: true,
      publishedAt: true,
      tags: true,
    },
  });

  // Previous snapshot per video (for deltas) — walk the ascending history
  // from the end: the newest row per video is skipped, the next one seen is
  // the previous sync's numbers.
  const prev = new Map<string, VideoStat>();
  const newestSeen = new Set<string>();
  for (let i = snapshots.length - 1; i >= 0; i--) {
    const row = snapshots[i];
    if (newestSeen.has(row.videoId)) {
      // already found the newest — this is the previous one (first hit only)
      if (!prev.has(row.videoId)) prev.set(row.videoId, row);
    } else {
      newestSeen.add(row.videoId);
    }
  }

  const countPerVideo = new Map<string, number>();
  for (const row of snapshots)
    countPerVideo.set(row.videoId, (countPerVideo.get(row.videoId) ?? 0) + 1);

  const rows: AnalyticsRowDTO[] = videos.map((v) => {
    const s = latest.get(v.id)!; // keyset came from latest
    const p = prev.get(v.id);
    return {
      videoId: v.id,
      title: v.title ?? v.topic,
      niche: v.niche,
      thumbnailUrl: v.hasThumbnail ? `/api/videos/${v.id}/thumbnail` : null,
      youtubeUrl: v.youtubeUrl,
      publishedAt: v.publishedAt ? v.publishedAt.toISOString() : null,
      views: s.views,
      likes: s.likes,
      comments: s.comments,
      viewDelta: p ? Math.max(0, s.views - p.views) : 0,
      likeDelta: p ? Math.max(0, s.likes - p.likes) : 0,
      snapshots: countPerVideo.get(v.id) ?? 1,
      engagementRate: engagementRate(s.views, s.likes, s.comments),
    };
  });
  rows.sort((a, b) => b.views - a.views);

  const totals = rows.reduce(
    (acc, r) => ({
      views: acc.views + r.views,
      likes: acc.likes + r.likes,
      comments: acc.comments + r.comments,
    }),
    { views: 0, likes: 0, comments: 0 }
  );
  const viewDelta = rows.reduce((sum, r) => sum + r.viewDelta, 0);
  const avgEngagement = rows.length
    ? rows.reduce((sum, r) => sum + r.engagementRate, 0) / rows.length
    : 0;

  // Channel totals per snapshot day — every snapshot's view count is already a
  // LIFETIME total for that video, so the day's channel total is the sum of
  // each video's latest snapshot that day (no further accumulation).
  const byDay = new Map<string, number>();
  const perVideoDay = new Map<string, Map<string, number>>();
  for (const row of snapshots) {
    const day = row.snapshotAt.toISOString().slice(0, 10);
    const inner = perVideoDay.get(row.videoId) ?? new Map<string, number>();
    inner.set(day, row.views); // ascending order — last write of the day wins
    perVideoDay.set(row.videoId, inner);
  }
  for (const inner of perVideoDay.values())
    for (const [day, views] of inner) byDay.set(day, (byDay.get(day) ?? 0) + views);
  const series = [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, views]) => ({ day, views }));

  const settingsRow = await db.setting.findUnique({ where: { key: "ytStatsSyncedAt" } });

  return {
    publishedCount: published,
    trackedCount: rows.length,
    totals,
    viewDelta,
    avgEngagement,
    lastSyncAt: settingsRow?.value ?? null,
    rows,
    series,
    feedback: feedbackState(rows),
  };
}

// ---------- feedback loop ----------

interface WinnerContext {
  rows: AnalyticsRowDTO[]; // sorted by views desc
  top: AnalyticsRowDTO[];
  topKeywords: string[];
  avgViews: number;
}

/** Channel winners (top third by views, min 1, needs 3+ tracked videos). */
function feedbackState(rows: AnalyticsRowDTO[]): AnalyticsOverviewDTO["feedback"] {
  if (rows.length === 0)
    return { active: false, winners: [], topKeywords: [] };

  const topCount = Math.max(1, Math.floor(rows.length / 3));
  const top = rows.slice(0, topCount);

  return {
    active: true,
    winners: top.map((r) => r.title),
    topKeywords: dominantKeywords(top),
  };
}

/** Words that appear in multiple winning titles (lowercased, stop-worded). */
function dominantKeywords(rows: AnalyticsRowDTO[]): string[] {
  const STOP = new Set([
    "the", "a", "an", "of", "in", "on", "to", "for", "and", "or", "is",
    "are", "was", "were", "how", "why", "what", "your", "you", "it",
    "this", "that", "with", "at", "by", "from", "be", "as",
  ]);
  const freq = new Map<string, number>();
  for (const row of rows) {
    const words = new Set(
      row.title
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOP.has(w))
    );
    for (const w of words) freq.set(w, (freq.get(w) ?? 0) + 1);
  }
  return [...freq.entries()]
    .filter(([, count]) => count >= Math.max(1, Math.ceil(rows.length / 2)))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([w]) => w);
}

async function winnerContext(): Promise<WinnerContext | null> {
  const { rows } = await getAnalyticsOverview();
  if (rows.length < 3) return null; // need a real spread to judge winners
  const topCount = Math.max(1, Math.floor(rows.length / 3));
  const top = rows.slice(0, topCount);
  const avgViews = rows.reduce((s, r) => s + r.views, 0) / rows.length;
  return { rows, top, topKeywords: dominantKeywords(top), avgViews };
}

/**
 * Prompt block for the Topic Radar strategist — real channel evidence so new
 * scans are steered by what the actual audience rewarded (or ignored).
 */
export async function performanceBriefBlock(): Promise<string> {
  const ctx = await winnerContext();
  if (!ctx) return "";

  const winners = ctx.top
    .slice(0, 3)
    .map((r) => `"${r.title}" (${r.views.toLocaleString()} views, ${(r.engagementRate * 100).toFixed(1)}% engagement)`)
    .join("; ");
  const losers = ctx.rows
    .slice(-2)
    .map((r) => `"${r.title}" (${r.views.toLocaleString()} views)`)
    .join("; ");
  const keywords = ctx.topKeywords.length ? ctx.topKeywords.join(", ") : "";

  return `
PERFORMANCE INTELLIGENCE (real stats from this channel's published videos — weight these heavily):
- Average views per video: ${Math.round(ctx.avgViews).toLocaleString()}
- Top performers that over-delivered: ${winners}
- Underperformers to learn from (avoid copying their angles): ${losers}
${keywords ? `- Words/themes that recur across the winners: ${keywords}` : ""}
- Favor ideas that share DNA with the winners (topics, formats, emotional hooks) and avoid the losers' angles.
`;
}

/**
 * Deterministic performance boost — lift ideas whose title/keywords overlap
 * with channel winners, ding ideas that resemble underperformers. No AI call
 * so it is instant, explainable and re-runnable. Mutates copies and returns
 * them (callers persist).
 */
export async function applyPerformanceBoost(ideas: ResearchIdea[]): Promise<{
  ideas: ResearchIdea[];
  boosted: number;
  changed: number;
}> {
  const ctx = await winnerContext();
  if (!ctx) return { ideas, boosted: 0, changed: 0 };

  const normalize = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const STOP = new Set([
    "the", "a", "an", "of", "in", "on", "to", "for", "and", "or", "is",
    "are", "how", "why", "what", "your", "you", "with", "at", "by", "from", "be", "as",
  ]);

  const winnerWords = new Set(
    ctx.top.flatMap((r) => normalize(r.title)).filter((w) => w.length > 2 && !STOP.has(w))
  );
  const winnerKeywords = new Set(
    ctx.top.flatMap((r) => normalize(r.title + " " + r.niche)).filter((w) => w.length > 2 && !STOP.has(w))
  );
  const loserTitles = ctx.rows.slice(-Math.max(1, Math.floor(ctx.rows.length / 3)));

  let boosted = 0;
  let changed = 0;

  const out = ideas.map((idea) => {
    // Overlap ratio with winner vocabulary (title words count double).
    let hits = 0;
    let total = 0;
    for (const w of normalize(idea.title)) {
      if (w.length <= 2 || STOP.has(w)) continue;
      total += 2;
      if (winnerWords.has(w) || winnerKeywords.has(w)) hits += 2;
    }
    for (const w of idea.keywords.flatMap(normalize)) {
      if (w.length <= 2 || STOP.has(w)) continue;
      total += 1;
      if (winnerWords.has(w) || winnerKeywords.has(w)) hits += 1;
    }

    const overlap = total > 0 ? hits / total : 0;
    let boost = 0;
    let reason = "";

    if (overlap >= 0.55) {
      boost = 15;
      reason = `Strong overlap with your top performers (${Math.round(overlap * 100)}% of this idea's vocabulary appears in winning videos)`;
    } else if (overlap >= 0.35) {
      boost = 10;
      reason = `Clear DNA shared with winning videos (${Math.round(overlap * 100)}% vocabulary overlap)`;
    } else if (overlap >= 0.18) {
      boost = 5;
      reason = `Some overlap with winners (${Math.round(overlap * 100)}% vocabulary overlap)`;
    }

    // Small ding for closely resembling an underperformer (word-overlap >= 50%).
    const ideaNorm = normalize(idea.title).filter((w) => !STOP.has(w) && w.length > 2);
    for (const loser of loserTitles) {
      const loserWords = new Set(normalize(loser.title).filter((w) => !STOP.has(w) && w.length > 2));
      const shared = ideaNorm.filter((w) => loserWords.has(w)).length;
      if (ideaNorm.length > 0 && shared / ideaNorm.length >= 0.5) {
        boost = Math.min(boost, 0) - 4;
        reason = `Resembles an underperforming video ("${loser.title}") — angle it differently`;
        break;
      }
    }

    const newScore = Math.max(1, Math.min(100, idea.viralScore + boost));
    if (boost !== 0) boosted++;
    if (newScore !== idea.viralScore) changed++;

    return {
      ...idea,
      viralScore: newScore,
      perfBoost: boost,
      boostReason:
        boost === 0
          ? undefined
          : reason || `Adjusted by channel performance (${boost > 0 ? "+" : ""}${boost})`,
    };
  });

  return { ideas: out, boosted, changed };
}

/** Latest stats for one video (merged into video detail responses). */
export async function latestStatsFor(
  videoId: string
): Promise<{ views: number; likes: number; comments: number } | null> {
  const row = await db.videoStat.findFirst({
    where: { videoId },
    orderBy: { snapshotAt: "desc" },
  });
  if (!row) return null;
  return { views: row.views, likes: row.likes, comments: row.comments };
}

/** Latest stats for many videos without N+1s (detail lists + serializers). */
export async function latestStatsMap(
  videoIds: string[]
): Promise<Map<string, { views: number; likes: number; comments: number }>> {
  if (videoIds.length === 0) return new Map();
  const rows: VideoStat[] = await db.videoStat.findMany({
    where: { videoId: { in: videoIds } },
    orderBy: { snapshotAt: "desc" },
  });
  const map = new Map<string, { views: number; likes: number; comments: number }>();
  for (const row of rows) {
    if (!map.has(row.videoId))
      map.set(row.videoId, { views: row.views, likes: row.likes, comments: row.comments });
  }
  return map;
}
