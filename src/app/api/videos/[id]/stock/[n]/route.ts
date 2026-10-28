import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { parseScenes } from "@/lib/tubeforge/story";
import { readSceneStock, fetchStockForScenes, readStockKeys } from "@/lib/tubeforge/stock";
import { startJob, isJobRunning, isJobCancelled, lastJobError, setJobProgress, JobCancelledError } from "@/lib/tubeforge/jobs";

type Ctx = { params: Promise<{ id: string; n: string }> };

/** GET — stream one scene's stock clip (drives the filmstrip hover preview). */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id, n } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });

  const index = Number(n);
  const buf = readSceneStock(id, index);
  if (!buf) return NextResponse.json({ error: "No stock clip for this scene" }, { status: 404 });

  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(buf.length),
      "Cache-Control": "private, max-age=60",
    },
  });
}

/**
 * POST — (re)search stock footage for ONE scene as a background job.
 * Used by the per-scene "Find footage" button; replaces any existing clip.
 */
export async function POST(_req: NextRequest, ctx: Ctx) {
  const { id, n } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (video.format !== "story")
    return NextResponse.json({ error: "Not a scene-based video" }, { status: 400 });

  const scenes = parseScenes(video.scenes);
  const index = Number(n);
  const scene = scenes.find((s) => s.index === index);
  if (!scene)
    return NextResponse.json({ error: `Scene ${n} does not exist` }, { status: 400 });

  const keys = await readStockKeys();
  if (!keys.pexels && !keys.pixabay)
    return NextResponse.json(
      { error: "No stock provider configured — add a free Pexels or Pixabay key in Settings → Stock footage" },
      { status: 400 }
    );

  const jobKey = `${id}#scene${index}`;
  const accepted = await startJob(jobKey, "stock", async () => {
    try {
      await fetchStockForScenes({
        videoId: id,
        scenes,
        force: true, // one scene — always refresh its clip
        onlyScene: index,
        shouldCancel: () => isJobCancelled(jobKey, "stock"),
        onProgress: (current, total, label) =>
          setJobProgress(jobKey, "stock", current, total, label),
      });
      await db.video.update({
        where: { id },
        data: { hasVideo: false, videoDuration: null, error: null },
      });
      await db.activity.create({
        data: {
          videoId: id,
          stage: "stock",
          message: scene.stock
            ? `Scene ${index} stock clip re-matched`
            : `Scene ${index} stock clip matched`,
        },
      });
    } catch (err) {
      if (err instanceof JobCancelledError || (err instanceof Error && err.message === "__CANCELLED__"))
        throw new JobCancelledError();
      const message = err instanceof Error ? err.message : "Stock refetch failed";
      await db.video.update({ where: { id }, data: { error: message } }).catch(() => {});
      throw err;
    }
  });

  return NextResponse.json(
    {
      accepted,
      generating: true,
      error: lastJobError(jobKey, "stock"),
      running: isJobRunning(jobKey, "stock"),
    },
    { status: accepted ? 202 : 200 }
  );
}
