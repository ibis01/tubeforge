import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import type { ActivityDTO, StatsDTO } from "@/lib/tubeforge/types";

export async function GET(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const [videos, channels, activities, statRows] = await Promise.all([
    db.video.findMany({
      select: { status: true, audioDuration: true, createdAt: true },
    }),
    db.channel.count(),
    db.activity.findMany({
      orderBy: { createdAt: "desc" },
      take: 12,
      include: { video: { select: { title: true, topic: true } } },
    }),
    // Stage 4a (T-4.2): the dashboard's performance KPIs. Snapshots are
    // cumulative per video (what YouTube reported at sync time).
    db.videoStat.findMany({
      select: { videoId: true, views: true, likes: true, comments: true, snapshotAt: true },
      orderBy: { snapshotAt: "asc" },
    }),
  ]);

  const byStatus: Record<string, number> = {};
  let audioMinutes = 0;

  for (const v of videos) {
    byStatus[v.status] = (byStatus[v.status] ?? 0) + 1;
    audioMinutes += (v.audioDuration ?? 0) / 60;
  }

  // Videos created per day, last 7 days
  const perDay: { day: string; count: number }[] = [];
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const label = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const count = videos.filter((v) => v.createdAt.toISOString().slice(0, 10) === key)
      .length;
    perDay.push({ day: label, count });
  }

  const recent: ActivityDTO[] = activities.map((a) => ({
    id: a.id,
    videoId: a.videoId,
    videoTitle: a.video?.title ?? a.video?.topic ?? null,
    stage: a.stage,
    message: a.message,
    level: a.level,
    createdAt: a.createdAt.toISOString(),
  }));

  // ---- Performance aggregates (Stage 4a, T-4.2) -------------------------
  // Latest snapshot per video = that video's current totals. The 7-day delta
  // uses the STABLE COHORT only (videos with a snapshot ≥7 days old), so a
  // freshly-synced back catalog can't masquerade as a week of growth.
  let performance: import("@/lib/tubeforge/types").PerformanceDTO | null = null;
  if (statRows.length > 0) {
    const byVideo = new Map<string, typeof statRows>();
    for (const row of statRows) {
      const list = byVideo.get(row.videoId);
      if (list) list.push(row);
      else byVideo.set(row.videoId, [row]);
    }

    let views = 0;
    let likes = 0;
    let comments = 0;
    let cohortThenViews = 0;
    let cohortNowViews = 0;
    let cohortSize = 0;
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    for (const rows of byVideo.values()) {
      const latest = rows[rows.length - 1];
      views += latest.views;
      likes += latest.likes;
      comments += latest.comments;

      const then = rows.filter((r) => r.snapshotAt.getTime() <= weekAgo).pop();
      if (then) {
        cohortSize += 1;
        cohortThenViews += then.views;
        cohortNowViews += latest.views;
      }
    }

    // 7 daily cumulative totals (oldest → today): per video, the latest
    // snapshot on-or-before each day's end (0 before its first sync).
    const viewsSeries: number[] = [];
    for (let i = 6; i >= 0; i--) {
      const dayEnd = new Date();
      dayEnd.setHours(23, 59, 59, 999);
      dayEnd.setDate(dayEnd.getDate() - i);
      let dayTotal = 0;
      for (const rows of byVideo.values()) {
        for (let j = rows.length - 1; j >= 0; j--) {
          if (rows[j].snapshotAt <= dayEnd) {
            dayTotal += rows[j].views;
            break;
          }
        }
      }
      viewsSeries.push(dayTotal);
    }

    performance = {
      views,
      likes,
      comments,
      viewsDelta7d: cohortSize > 0 ? cohortNowViews - cohortThenViews : null,
      viewsSeries,
      syncedVideos: byVideo.size,
    };
  }

  const stats: StatsDTO = {
    total: videos.length,
    byStatus,
    ready: byStatus["ready"] ?? 0,
    inPipeline:
      (byStatus["draft"] ?? 0) +
      (byStatus["scripted"] ?? 0) +
      (byStatus["voiced"] ?? 0),
    published: byStatus["published"] ?? 0,
    failed: byStatus["failed"] ?? 0,
    audioMinutes: Math.round(audioMinutes * 10) / 10,
    channels,
    perDay,
    recent,
    performance,
  };

  return NextResponse.json({ stats });
}
