// GET/POST /api/videos/[id]/retention — S72 Creator Intelligence CI-4:
// Retention Intelligence, attached to the video row.
//
//   GET  — the standing report (the doc column, tolerantly parsed).
//   POST — INGEST: pull the audience retention curve from the YouTube
//          Analytics API (the NEW yt-analytics.readonly scope; a 403 on a
//          pre-scope connection surfaces as a readable reconnect
//          instruction), map the drop-off moments to scenes / narration /
//          pacing through the SAME timeline projection the assemble route
//          builds, and store the findings as the retentionReport doc
//          column. PROPSES, NEVER AUTO-EDITS — a finding shows its
//          evidence (the cliff, the scene, the words on screen) and waits;
//          every finding is labeled a heuristic.

import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { videoDir } from "@/lib/tubeforge/ai";
import { parseScenes, sceneWavFile } from "@/lib/tubeforge/story";
import { wavDurationSec } from "@/lib/tubeforge/wav";
import { youtubeIdFromUrl, fetchRetentionCurve } from "@/lib/tubeforge/youtube";
import { analyzeRetentionCurve, parseRetentionReport } from "@/lib/tubeforge/retention";
import { errorText } from "@/lib/tubeforge/redact";

type Ctx = { params: Promise<{ id: string }> };

/** The measured scene WAV durations (the assemble route's own source) —
 *  null when no voiceover stands (the projection rides estimates). */
function wavDurationsFor(videoId: string, sceneCount: number): Record<number, number> | null {
  const dir = videoDir(videoId);
  const out: Record<number, number> = {};
  let any = false;
  for (let i = 1; i <= sceneCount; i++) {
    const wav = path.join(dir, sceneWavFile(i));
    if (!fs.existsSync(wav)) continue;
    try {
      const sec = wavDurationSec(fs.readFileSync(wav));
      if (sec > 0) {
        out[i] = sec;
        any = true;
      }
    } catch {
      /* unreadable → that scene rides the estimate */
    }
  }
  return any ? out : null;
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });

  return NextResponse.json({ report: parseRetentionReport(video.retentionReport) });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (!video.youtubeUrl)
    return NextResponse.json(
      { error: "This video is not published yet — retention needs a live YouTube video" },
      { status: 409 }
    );
  const youtubeId = youtubeIdFromUrl(video.youtubeUrl);
  if (!youtubeId)
    return NextResponse.json({ error: "The stored YouTube URL does not carry a video id" }, { status: 400 });

  try {
    const points = await fetchRetentionCurve(youtubeId, video.publishedAt ?? null);
    if (points.length === 0)
      return NextResponse.json(
        { error: "YouTube returned no retention data yet — try again after the video accrues views" },
        { status: 409 }
      );

    // The master's own duration — the curve's tRatio denominator (fall back
    // to the last point's ratio implying the full length when the row lacks
    // a measured duration).
    const durationSec = video.videoDuration && video.videoDuration > 0 ? video.videoDuration : 60;
    const scenes = parseScenes(video.scenes);
    const findings = analyzeRetentionCurve(
      points,
      durationSec,
      scenes,
      scenes.length > 0 ? wavDurationsFor(id, scenes.length) : null
    );

    const report = {
      youtubeId,
      fetchedAt: new Date().toISOString(),
      videoDurationSec: durationSec,
      points,
      averageWatchRatio: findings.averageWatchRatio,
      drops: findings.drops,
      heuristic: true,
    } as const;

    await db.video.update({
      where: { id },
      data: { retentionReport: JSON.stringify(report) },
    });
    await db.activity.create({
      data: {
        organizationId: video.organizationId,
        userId: auth.ctx.userId,
        videoId: id,
        stage: "analytics",
        message: `Retention synced — ${points.length} curve points, ${findings.drops.length} drop-off finding${findings.drops.length === 1 ? "" : "s"} (avg watch ratio ${(findings.averageWatchRatio * 100).toFixed(0)}%, heuristic)`,
      },
    });

    return NextResponse.json({ report });
  } catch (err) {
    const message = errorText(err, "Retention sync failed");
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
