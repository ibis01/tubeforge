import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { parseScenes } from "@/lib/tubeforge/story";
import { readSceneStock, readStockKeys } from "@/lib/tubeforge/stock";
import { startJob, isJobRunning, lastJobError } from "@/lib/tubeforge/jobs";
import { runStockSceneJob } from "@/lib/tubeforge/queue-handlers";

type Ctx = { params: Promise<{ id: string; n: string }> };

// Stage 1 (task T-1.12): `n` must be a positive integer.
const ParamsSchema = z.object({
  id: z.string().min(1),
  n: z.coerce.number().int().positive(),
});

/** GET — stream one scene's stock clip (drives the filmstrip hover preview). */
export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const parsed = ParamsSchema.safeParse(await ctx.params);
  if (!parsed.success)
    return NextResponse.json({ error: "Invalid scene index" }, { status: 400 });
  const { id } = parsed.data;
  const index = parsed.data.n;

  const video = await db.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });

  const buf = await readSceneStock(id, index);
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
export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const parsed = ParamsSchema.safeParse(await ctx.params);
  if (!parsed.success)
    return NextResponse.json({ error: "Invalid scene index" }, { status: 400 });
  const { id } = parsed.data;
  const index = parsed.data.n;
  const n = String(index);

  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (video.format !== "story")
    return NextResponse.json({ error: "Not a scene-based video" }, { status: 400 });

  const scenes = parseScenes(video.scenes);
  const scene = scenes.find((s) => s.index === index);
  if (!scene)
    return NextResponse.json({ error: `Scene ${n} does not exist` }, { status: 400 });

  const keys = await readStockKeys();
  if (!keys.pexels && !keys.pixabay)
    return NextResponse.json(
      { error: "No stock provider configured — add a free Pexels or Pixabay key in Settings → Stock footage" },
      { status: 400 }
    );

  // Job body is runStockSceneJob (queue-handlers.ts) — shared with the
  // crash-recovery handler; the entityId encodes the scene.
  const jobKey = `${id}#scene${index}`;
  const accepted = await startJob(jobKey, "stock", () => runStockSceneJob(jobKey));

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
