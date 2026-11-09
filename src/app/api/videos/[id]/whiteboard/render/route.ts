import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { startJob } from "@/lib/tubeforge/jobs";
import { runWhiteboardJob } from "@/lib/tubeforge/video-jobs";
import { loadLibrary } from "@/lib/tubeforge/whiteboard/assets";
import { validateWhiteboardProject, validWhiteboardId } from "@/lib/tubeforge/whiteboard/storyboard";
import { parseWhiteboardDoc } from "@/lib/tubeforge/whiteboard/whiteboard-planner";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST — enqueue a whiteboard render (E9 Phase A, E1 design §4).
 * Body `{ sceneId?: string }` — absent = FULL render (job on the videoId,
 * the standard final.mp4 artifact); present = single-scene preview at
 * 720p/24fps without the music bed (job on `<videoId>#wb<sceneId>`, artifact
 * `whiteboard/preview-<sceneId>.mp4`, sets `hasPreview`).
 *
 * Rejects when the project is missing or invalid with the engine's verbatim
 * errors; the frame-budget wall hits at the job's own pre-flight, where the
 * exact VO-measured math lives.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (video.format !== "story")
    return NextResponse.json({ error: "Not a scene-based video" }, { status: 400 });
  if (video.renderMode !== "whiteboard")
    return NextResponse.json(
      { error: "Switch this video's render mode to Whiteboard first" },
      { status: 409 }
    );

  const doc = parseWhiteboardDoc(video.whiteboardProject);
  if (!doc)
    return NextResponse.json(
      { error: "No whiteboard project yet — scaffold one in the Whiteboard Studio first" },
      { status: 409 }
    );

  // Same gate the job will apply — refuse BEFORE the queue so the user sees
  // the validator's errors on click, not in a failed job card.
  const lib = loadLibrary();
  const { project, errors } = validateWhiteboardProject(doc.project, lib.libraryIndex);
  if (!project)
    return NextResponse.json(
      { error: "The whiteboard project is invalid — fix it in the Studio first", errors },
      { status: 400 }
    );

  const body = await req.json().catch(() => ({}));
  const rawSceneId = (body as Record<string, unknown> | null)?.sceneId;
  let jobKey = id;
  let sceneId: string | null = null;
  if (typeof rawSceneId === "string" && rawSceneId.trim()) {
    sceneId = rawSceneId.trim().slice(0, 64);
    // The composite entity id is the DURABLE encoding — an id that breaks
    // the charset law would corrupt the #wb split, so it dies here.
    if (!validWhiteboardId(sceneId) || sceneId.includes("#"))
      return NextResponse.json({ error: `Illegal whiteboard scene id "${sceneId}"` }, { status: 400 });
    if (!project.scenes.some((s) => s.id === sceneId))
      return NextResponse.json({ error: `Scene "${sceneId}" does not exist in this project` }, { status: 400 });
    jobKey = `${id}#wb${sceneId}`;
  }

  // Clear any stale error before the job starts (the house convention).
  await db.video.update({ where: { id }, data: { error: null } });

  const accepted = await startJob(
    jobKey,
    "whiteboard",
    () => runWhiteboardJob(jobKey, sceneId ? { sceneId } : {})
  );

  return NextResponse.json(
    { accepted, generating: true, scope: sceneId ? "preview" : "full", sceneId },
    { status: accepted ? 202 : 200 }
  );
}
