// POST /api/videos/[id]/upload — one-click OAuth upload of the rendered
// final.mp4 to the connected YouTube channel (the "Upload to YouTube" button
// in the video detail dialog). Stage POSTs return 202 + start a background
// job (kind "upload" — already registered in jobs.ts, surfaced in the job
// snapshot/history and crash recovery); the client polls the video record
// until youtubeUrl lands or an error is recorded (poll.ts → pollUpload).
//
// Metadata comes from the AI-generated package itself (title / description /
// tags columns — the same fields the export ZIP writes into
// upload-metadata.txt), the privacy status from Settings (ytPrivacyStatus,
// default "unlisted" so nothing goes public by accident), and the rendered
// thumbnail.png is attached when present (best-effort in youtube.ts).

import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { db } from "@/lib/db";
import { startJob, isJobRunning, lastJobError } from "@/lib/tubeforge/jobs";
import { serializeVideo } from "@/lib/tubeforge/serialize";
import { isConnected, uploadToYouTube } from "@/lib/tubeforge/youtube";

type Ctx = { params: Promise<{ id: string }> };

const UPLOAD_ROOT = path.join(process.cwd(), "uploads");

export async function POST(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });

  const finalPath = path.join(UPLOAD_ROOT, id, "final.mp4");
  let fileSize = 0;
  try {
    fileSize = fs.statSync(finalPath).size;
  } catch {
    /* checked below */
  }
  if (!fileSize)
    return NextResponse.json(
      { error: "Render the final video first — the upload streams final.mp4 to YouTube" },
      { status: 400 }
    );

  if (!(await isConnected()))
    return NextResponse.json(
      {
        error:
          "YouTube channel is not connected — add your OAuth client in Settings → YouTube upload and connect the channel",
      },
      { status: 400 }
    );

  // YouTube has no in-place update: a second POST would duplicate the video
  // on the channel. The UI already swaps the button for a "Live on YouTube"
  // link once youtubeUrl is set — this guard is defense in depth.
  if (video.youtubeUrl)
    return NextResponse.json(
      {
        error: `This video is already on YouTube (${video.youtubeUrl}) — YouTube can't replace an upload in place; create a new video for a re-render`,
      },
      { status: 409 }
    );

  // Clear any stale error before the job starts.
  await db.video.update({ where: { id }, data: { error: null } });

  const accepted = await startJob(id, "upload", async () => {
    try {
      const tags = video.tags
        ? video.tags.split(",").map((t) => t.trim()).filter(Boolean)
        : [];
      const thumbnailPath = path.join(UPLOAD_ROOT, id, "thumbnail.png");

      const result = await uploadToYouTube({
        // Same metadata the export ZIP documents for manual uploads.
        title: (video.title || video.topic || "Untitled TubeForge video").trim(),
        description: (video.description ?? "").trim(),
        tags,
        filePath: finalPath,
        fileSize,
        thumbnailPath: fs.existsSync(thumbnailPath) ? thumbnailPath : null,
      });

      await db.video.update({
        where: { id },
        data: {
          youtubeUrl: result.url,
          status: "published",
          error: null,
        },
      });

      await db.activity.create({
        data: {
          videoId: id,
          stage: "upload",
          message: `Uploaded to YouTube — ${result.url}${result.thumbnailSet ? " (custom thumbnail set)" : ""}`,
        },
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "YouTube upload failed";
      await db.video.update({ where: { id }, data: { error: message } });
      await db.activity.create({
        data: {
          videoId: id,
          stage: "upload",
          level: "error",
          message: `YouTube upload failed: ${message}`,
        },
      });
      throw err;
    }
  });

  return NextResponse.json(
    { accepted, generating: true },
    { status: accepted ? 202 : 200 }
  );
}

/** GET — upload state for the detail dialog (drives button + link). */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });

  return NextResponse.json({
    generating: isJobRunning(id, "upload"),
    error: lastJobError(id, "upload") ?? video.error,
    youtubeUrl: video.youtubeUrl ?? null,
    video: serializeVideo(video),
  });
}
