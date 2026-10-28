import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { db } from "@/lib/db";
import { parseScenes } from "@/lib/tubeforge/story";
import {
  fetchStockForScenes,
  clearStock,
  readStockKeys,
} from "@/lib/tubeforge/stock";
import {
  startJob,
  isJobRunning,
  isJobCancelled,
  lastJobError,
  jobProgress,
  setJobProgress,
  JobCancelledError,
} from "@/lib/tubeforge/jobs";

type Ctx = { params: Promise<{ id: string }> };

const UPLOAD_ROOT = path.join(process.cwd(), "uploads");

/** Renders become stale when the visual track changes. */
function invalidateRenders(videoId: string) {
  const dir = path.join(UPLOAD_ROOT, videoId);
  for (const f of ["final.mp4", "preview.mp4"]) {
    fs.rmSync(path.join(dir, f), { force: true });
  }
}

/** GET — stock status for the video (per-scene refs live on the scenes). */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (video.format !== "story")
    return NextResponse.json({ error: "Not a scene-based video" }, { status: 400 });

  const scenes = parseScenes(video.scenes);
  const keys = await readStockKeys();

  return NextResponse.json({
    generating: isJobRunning(id, "stock"),
    progress: jobProgress(id, "stock"),
    error: lastJobError(id, "stock"),
    matched: scenes.filter((s) => s.stock).length,
    total: scenes.length,
    providersConfigured: {
      pexels: Boolean(keys.pexels),
      pixabay: Boolean(keys.pixabay),
    },
    scenes: scenes.map((s) => ({
      index: s.index,
      hasStock: Boolean(s.stock),
      source: s.stock?.source ?? null,
      query: s.stock?.query ?? null,
      credit: s.stock?.credit ?? null,
      pageUrl: s.stock?.pageUrl ?? null,
    })),
  });
}

/**
 * POST — find + download stock footage for scenes that lack a clip (202 job).
 * Body: { force?: boolean } — force re-searches every scene, replacing clips.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (video.format !== "story")
    return NextResponse.json(
      { error: "Not a scene-based video — stock b-roll applies to scene-format videos" },
      { status: 400 }
    );

  const scenes = parseScenes(video.scenes);
  if (scenes.length === 0)
    return NextResponse.json(
      { error: "Video has no scenes — generate the scene script first" },
      { status: 400 }
    );

  const keys = await readStockKeys();
  if (!keys.pexels && !keys.pixabay)
    return NextResponse.json(
      { error: "No stock provider configured — add a free Pexels or Pixabay key in Settings → Stock footage" },
      { status: 400 }
    );

  const body = await req.json().catch(() => ({}));
  const force = Boolean(body?.force);

  await db.video.update({ where: { id }, data: { error: null } });

  const accepted = await startJob(id, "stock", async () => {
    try {
      const result = await fetchStockForScenes({
        videoId: id,
        scenes,
        force,
        shouldCancel: () => isJobCancelled(id, "stock"),
        onProgress: (current, total, label) => {
          if (isJobCancelled(id, "stock")) throw new Error("__CANCELLED__");
          setJobProgress(id, "stock", current, total, label);
        },
      });

      invalidateRenders(id);
      await db.video.update({
        where: { id },
        data: { hasVideo: false, videoDuration: null, error: null },
      });
      await db.activity.create({
        data: {
          videoId: id,
          stage: "stock",
          message: `Stock b-roll — ${result.fetched} clip${result.fetched === 1 ? "" : "s"} downloaded, ${result.matched}/${scenes.length} scenes covered`,
        },
      });
    } catch (err) {
      if (err instanceof Error && err.message === "__CANCELLED__") {
        await db.video.update({ where: { id }, data: { error: null } });
        await db.activity.create({
          data: {
            videoId: id,
            stage: "stock",
            message: "Stock fetch cancelled — matched clips were kept",
          },
        });
        throw new JobCancelledError();
      }
      const message = err instanceof Error ? err.message : "Stock fetch failed";
      await db.video.update({ where: { id }, data: { error: message } });
      await db.activity.create({
        data: {
          videoId: id,
          stage: "stock",
          level: "error",
          message: `Stock fetch failed: ${message}`,
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

/** DELETE — remove every stock clip + ref (storyboard art is untouched). */
export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (video.format !== "story")
    return NextResponse.json({ error: "Not a scene-based video" }, { status: 400 });

  const scenes = parseScenes(video.scenes);
  const cleared = await clearStock(id, scenes);
  invalidateRenders(id);
  await db.video.update({
    where: { id },
    data: { hasVideo: false, videoDuration: null },
  });
  await db.activity.create({
    data: {
      videoId: id,
      stage: "stock",
      message: `Stock b-roll cleared — ${cleared} clip${cleared === 1 ? "" : "s"} removed`,
    },
  });

  return NextResponse.json({ cleared });
}
