// POST /api/videos/[id]/scenes/[n]/rollback — S112 (Scene-Level Editing,
// Stage 1): restore a previous revision's content as a NEW revision.
//
// The proposal's requirement E, made real: rollback never deletes or
// rewinds — it APPENDS a revision carrying the old content (changeKind
// "rollback", note "Rollback to v<N>"), so history is never erased and the
// rollback itself is rollback-able. The restored state is the UNION slice
// (row scene + timeline doc scene) — never half a scene.
//
// Staleness: the same sweeps PATCH /scenes applies (a restored narration
// kills the old read's artifacts; a restored caption kills renders), so a
// rollback can never leave newer artifacts claiming older content.
//
// Body: { toVersion: number } — the revision to restore (from GET
// .../revisions). 404 when the scene or the revision is missing; 409 when
// the scene is already at that content (nothing to restore).

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { parseJson, sceneRollbackSchema, ApiValidationError } from "@/lib/tubeforge/validation";
import { serializeScenes } from "@/lib/tubeforge/story";
import { rollbackScene } from "@/lib/tubeforge/scene-revisions";

type Ctx = { params: Promise<{ id: string; n: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const { id, n } = await ctx.params;
  const index = Number(n);
  if (!Number.isInteger(index) || index < 1)
    return NextResponse.json({ error: "A valid scene index is required" }, { status: 400 });

  const video = await db.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (video.format !== "story")
    return NextResponse.json(
      { error: "Not a scene-based video — scene editing applies to scene-format videos" },
      { status: 400 }
    );

  let body;
  try {
    body = await parseJson(req, sceneRollbackSchema);
  } catch (err) {
    if (err instanceof ApiValidationError)
      return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }

  const result = await rollbackScene({
    video,
    sceneIndex: index,
    toVersion: body.toVersion,
    userId: auth.ctx.userId,
  });

  if (!result.ok) {
    const status =
      result.reason === "no-scene" || result.reason === "no-target"
        ? 404
        : result.reason === "no-history"
          ? 409
          : 409;
    return NextResponse.json({ error: result.message }, { status: status });
  }

  return NextResponse.json({
    scene: (await serializeScenes(id, result.scenes)).find((s) => s.index === index) ?? null,
    revision: {
      sceneId: result.revision.sceneId,
      version: result.revision.version,
      status: result.revision.status,
      changeKind: result.revision.changeKind,
      origin: result.revision.origin,
      note: result.revision.note,
    },
    narrationChanged: result.narrationChanged,
    captionChanged: result.captionChanged,
    invalidated: result.invalidated,
    timeline: result.timeline,
  });
}
