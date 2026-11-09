import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { loadLibrary } from "@/lib/tubeforge/whiteboard/assets";
import { validateWhiteboardProject, WB_BUDGETS } from "@/lib/tubeforge/whiteboard/storyboard";
import { WB_PATH_COMMAND_BUDGET } from "@/lib/tubeforge/whiteboard/assets";
import { WB_RENDER_FRAME_BUDGET } from "@/lib/tubeforge/whiteboard/timing";
import {
  parseWhiteboardDoc,
  serializeWhiteboardDoc,
} from "@/lib/tubeforge/whiteboard/whiteboard-planner";
import { invalidateRenderedArtifacts } from "@/lib/tubeforge/render";

type Ctx = { params: Promise<{ id: string }> };

/**
 * S67 — the Whiteboard Engine's document routes (E9 Phase A, E1 design §4).
 *
 * GET  — the doc (validated server-side before return), the editor palette
 *        (asset ids, viewBoxes, tags, drawable summaries — NOT raw SVG) and
 *        the resource budgets for client-side enforcement.
 * PUT  — save the whole doc. Validation is the engine validator; its error
 *        strings are returned verbatim (no second error vocabulary). 409 on
 *        a rev mismatch with the current doc in the response. A save
 *        invalidates the stale renders exactly the way slide edits do.
 */

export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (video.format !== "story")
    return NextResponse.json({ error: "Not a scene-based video" }, { status: 400 });

  const doc = parseWhiteboardDoc(video.whiteboardProject);
  let project = doc?.project ?? null;
  if (project) {
    // Server-side validation before return: a doc the live library can no
    // longer satisfy (an asset renamed, a path gone) reads as "no project"
    // rather than poisoning the editor with an unrenderable one.
    const lib = loadLibrary();
    const validated = validateWhiteboardProject(project, lib.libraryIndex);
    project = validated.project;
  }

  // The editor palette: ids + geometry + drawables, never raw markup —
  // the editor draws shapes from the packaged library it ships with.
  const lib = loadLibrary();
  const library = [...lib.assets.values()].map((a) => {
    const ex = lib.extracted.get(a.id);
    return {
      id: a.id,
      w: a.viewBox.w,
      h: a.viewBox.h,
      tags: a.tags,
      paths: ex ? ex.paths.map((p) => p.id) : [],
      texts: ex ? ex.texts.map((t) => t.id) : [],
    };
  });

  return NextResponse.json({
    project,
    rev: doc?.rev ?? 0,
    library,
    budgets: {
      ...WB_BUDGETS,
      pathCommandsPerPath: WB_PATH_COMMAND_BUDGET,
      renderFrames: WB_RENDER_FRAME_BUDGET,
    },
  });
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (video.format !== "story")
    return NextResponse.json({ error: "Not a scene-based video" }, { status: 400 });

  const body = await req.json().catch(() => null);
  const rawProject = (body as Record<string, unknown> | null)?.project;
  if (!rawProject)
    return NextResponse.json({ error: "A whiteboard project is required" }, { status: 400 });

  // The engine validator — its error strings go back verbatim (design §4).
  const lib = loadLibrary();
  const { project, errors } = validateWhiteboardProject(rawProject, lib.libraryIndex);
  if (!project)
    return NextResponse.json({ errors }, { status: 400 });

  // Advisory concurrency: the editor echoes the rev it read; a mismatch
  // returns 409 WITH the server's current doc so the editor can offer a
  // diff. LWW stays the final law — rev is UX, not a guarantee (design §2.1).
  const current = parseWhiteboardDoc(video.whiteboardProject);
  const bodyRev = (body as Record<string, unknown> | null)?.rev;
  if (
    current &&
    typeof bodyRev === "number" &&
    Number.isInteger(bodyRev) &&
    bodyRev !== current.rev
  ) {
    return NextResponse.json(
      {
        error: `This whiteboard changed under you — server rev ${current.rev}, you saved against ${bodyRev}`,
        current: { rev: current.rev, project: current.project },
      },
      { status: 409 }
    );
  }

  const rev = (current?.rev ?? 0) + 1;
  await db.video.update({
    where: { id },
    data: { whiteboardProject: serializeWhiteboardDoc({ rev, project }) },
  });

  // A project edit stales the rendered artifacts (design §2.3) — same
  // invalidation discipline as every other visual mutation.
  await invalidateRenderedArtifacts(id);
  await db.video.update({
    where: { id },
    data: { hasVideo: false, videoDuration: null },
  });

  return NextResponse.json({ rev, project });
}
