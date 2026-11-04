import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { startJob, isJobRunning, lastJobError } from "@/lib/tubeforge/jobs";
import { parseScenes } from "@/lib/tubeforge/story";
import { serializeVideo } from "@/lib/tubeforge/serialize";
import { runShortJob } from "@/lib/tubeforge/video-jobs";

import { materialize } from "@/lib/tubeforge/storage";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST — cut a 9:16 vertical Short out of the rendered final video as a
 * background job (202). Body: { sceneIndex?: number } — an explicit
 * this-request override (the detail dialog's channel); omit and the job
 * follows the doc's standing pick (S10, renderPrefs.short) or, absent
 * that, the auto-pick heuristic. The job body is runShortJob
 * (video-jobs.ts) — shared with the crash-recovery handler, so a restart
 * resumes the cut.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });

  if (video.format !== "story")
    return NextResponse.json(
      { error: "Shorts are cut from scene-story videos — classic formats have no rendered MP4" },
      { status: 400 }
    );

  // Storage seam (T-3.7): ffmpeg needs the master on local disk — materialize
  // returns the uploads path locally, a cached download under s3.
  const finalPath = await materialize(`${id}/final.mp4`);
  if (!fs.existsSync(finalPath))
    return NextResponse.json(
      { error: "Render the final video first — Shorts are cut from the rendered master" },
      { status: 400 }
    );

  let sceneIndex: number | null = null;
  try {
    const body = (await req.json()) as { sceneIndex?: number | null };
    if (body && Number.isInteger(body.sceneIndex))
      sceneIndex = Number(body.sceneIndex);
  } catch {
    /* no body = auto-pick */
  }

  const scenes = parseScenes(video.scenes);
  if (scenes.length === 0)
    return NextResponse.json({ error: "This video has no scenes" }, { status: 400 });

  // Clear any stale error before the job starts.
  await db.video.update({ where: { id }, data: { error: null } });

  const accepted = await startJob(
    id,
    "short",
    () => runShortJob(id, { sceneIndex }),
    { payload: { sceneIndex } }
  );

  return NextResponse.json(
    { accepted, generating: true },
    { status: accepted ? 202 : 200 }
  );
}

/** GET — short state for the detail dialog (drives button + preview). */
export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });

  const hasFile = video.hasShort; // DB flag — correct on both drivers (T-3.7)

  return NextResponse.json({
    generating: isJobRunning(id, "short"),
    error: lastJobError(id, "short") ?? video.error,
    hasShort: hasFile,
    shortUrl: hasFile ? `/api/videos/${id}/mp4?variant=short` : null,
    durationSec: hasFile ? video.shortDuration : null,
    sceneIndex: hasFile ? video.shortScene : null,
    video: await serializeVideo(video),
  });
}
