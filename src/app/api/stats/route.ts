import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import type { ActivityDTO, StatsDTO } from "@/lib/tubeforge/types";

export async function GET() {
  const [videos, channels, activities] = await Promise.all([
    db.video.findMany({
      select: { status: true, audioDuration: true, createdAt: true },
    }),
    db.channel.count(),
    db.activity.findMany({
      orderBy: { createdAt: "desc" },
      take: 12,
      include: { video: { select: { title: true, topic: true } } },
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
  };

  return NextResponse.json({ stats });
}
