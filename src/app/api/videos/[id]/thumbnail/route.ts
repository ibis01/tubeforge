import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { readMedia } from "@/lib/tubeforge/ai";
import { startJob, isJobRunning, lastJobError } from "@/lib/tubeforge/jobs";
import { serializeVideo } from "@/lib/tubeforge/serialize";
import { runThumbnailJob } from "@/lib/tubeforge/video-jobs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST — kick off CogView thumbnail generation as a background job (returns 202 immediately).
 * The job body is runThumbnailJob (video-jobs.ts) — shared with the crash-
 * recovery handler; everything it needs (script-matched concept, style,
 * character) is re-derived from the video row.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const { id } = await ctx.params;
  const video = await db.video.findUnique({
    where: { id },
    include: {
      character: {
        select: { id: true, name: true, identityAnchor: true, appearance: true, hasPortrait: true },
      },
    },
  });

  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (!video.title)
    return NextResponse.json(
      { error: "Video has no title yet — generate the script first" },
      { status: 400 }
    );
  // Clear any stale error from a previous failed attempt before polling starts.
  await db.video.update({ where: { id }, data: { error: null } });

  await startJob(id, "thumbnail", () => runThumbnailJob(id));

  // 202 Accepted — job already running (dedupe) or just started.
  return NextResponse.json(
    { video: await serializeVideo(video, null, { includeScenes: true }), accepted: true, generating: true },
    { status: 202 }
  );
}

/** GET — stream the thumbnail PNG, or `?status=1` for the S9 studio's
 * job-state poll (the same shape the variants route exposes):
 * { generating, hasThumbnail, error }. The pick rides the doc; the CogView
 * pass is the apply — the studio polls this until the arm disarms. */
export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const { id } = await ctx.params;
  // Scoped lookup FIRST — uploads/<id>/thumbnail.png is only streamed after
  // the row is proven to belong to the caller's organization.
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });

  // S9 — job-state poll for the studio's regenerate arm.
  if (new URL(req.url).searchParams.get("status") === "1") {
    return NextResponse.json({
      generating: isJobRunning(id, "thumbnail"),
      hasThumbnail: video.hasThumbnail,
      error: lastJobError(id, "thumbnail") ?? video.error,
    });
  }

  const media = await readMedia(id, "thumbnail.png");
  if (!media)
    return NextResponse.json({ error: "No thumbnail yet" }, { status: 404 });

  return new NextResponse(new Uint8Array(media), {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(media.length),
      "Cache-Control": "private, max-age=3600",
    },
  });
}
