import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { serializeScenes, storyboardComplete, parseScenes } from "@/lib/tubeforge/story";
import { startJob, isJobRunning, lastJobError } from "@/lib/tubeforge/jobs";
import { runStoryboardJob, runSceneJob } from "@/lib/tubeforge/video-jobs";

type Ctx = { params: Promise<{ id: string }> };

/** GET — the storyboard (scene list with image availability + per-scene job flags). */
export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (video.format !== "story")
    return NextResponse.json({ error: "Not a scene-based video" }, { status: 400 });

  const scenes = parseScenes(video.scenes);
  return NextResponse.json({
    scenes: await serializeScenes(id, scenes),
    complete: await storyboardComplete(id, scenes),
    generating: isJobRunning(id, "storyboard"),
    error: lastJobError(id, "storyboard"),
  });
}

/**
 * POST — generate the storyboard as a background job (202).
 * Body: {} for the full storyboard, { scene: n } to re-roll one scene from
 * its (Scene Studio-edited) prompt, or { scene: n, instruction: "..." } to
 * AI-edit the EXISTING scene image in place ("make it night", "warmer light").
 *
 * The job bodies (runStoryboardJob / runSceneJob in video-jobs.ts) are the
 * SAME functions the durable queue's crash-recovery handler runs — a restart
 * resumes the storyboard (already-painted scenes are kept) instead of dying
 * as "interrupted".
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
      { error: "Not a scene-based video — the storyboard applies to scene-format videos" },
      { status: 400 }
    );

  const scenes = parseScenes(video.scenes);
  if (scenes.length === 0)
    return NextResponse.json(
      { error: "Video has no scenes — generate the scene script first" },
      { status: 400 }
    );

  const body = await req.json().catch(() => ({}));
  const sceneIndex = Number(body?.scene);

  // Clear any stale error before the job starts.
  await db.video.update({ where: { id }, data: { error: null } });

  if (Number.isInteger(sceneIndex) && sceneIndex >= 1) {
    // Single-scene re-roll OR instruction-based AI edit of the current image.
    const scene = scenes.find((s) => s.index === sceneIndex);
    if (!scene)
      return NextResponse.json({ error: `Scene ${sceneIndex} does not exist` }, { status: 400 });

    const instruction =
      typeof body?.instruction === "string" ? body.instruction.trim() : "";
    if (instruction && instruction.length > 500)
      return NextResponse.json(
        { error: "Instruction too long — keep it under 500 characters" },
        { status: 400 }
      );
    const mode = instruction ? "edit" : "reroll";

    const jobKey = `${id}#scene${sceneIndex}`;
    const accepted = await startJob(
      jobKey,
      "scene",
      () => runSceneJob(jobKey, { sceneIndex, instruction: instruction || undefined }),
      { payload: { sceneIndex, instruction: instruction || undefined } }
    );

    return NextResponse.json(
      { accepted, generating: true, mode },
      { status: accepted ? 202 : 200 }
    );
  }

  // Full storyboard
  const accepted = await startJob(id, "storyboard", () => runStoryboardJob(id));

  return NextResponse.json(
    { accepted, generating: true },
    { status: accepted ? 202 : 200 }
  );
}
