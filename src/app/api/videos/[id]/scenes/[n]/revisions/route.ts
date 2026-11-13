// GET /api/videos/[id]/scenes/[n]/revisions — S112 (Scene-Level Editing,
// Stage 1): one scene's immutable revision history, newest first.
//
// The response carries the stable sceneId, the head (what a NEW edit should
// base its expectedSceneVersion on), the latest approved revision (the
// render's source of truth once Stage 6 lands), and the full chain with the
// parsed union-slice content (row scene + timeline doc scene) so a client
// can diff any two revisions without extra round-trips.
//
// Read-only: no revision is created, no row is touched. A scene with no
// history yet (never touched by a revision-writing mutator) returns an
// empty chain + head null — the client offers history from the first edit.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { parseScenes } from "@/lib/tubeforge/story";
import {
  headRevision,
  approvedRevision,
  listRevisions,
  headSummary,
  parseRevisionContent,
} from "@/lib/tubeforge/scene-revisions";

type Ctx = { params: Promise<{ id: string; n: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
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

  const scene = parseScenes(video.scenes).find((s) => s.index === index);
  if (!scene)
    return NextResponse.json({ error: `Scene ${index} does not exist` }, { status: 404 });

  // A scene never touched by a revision-writing mutator has no sceneId yet —
  // an honest empty history, not an error (the first edit mints the id).
  if (!scene.id)
    return NextResponse.json({ sceneId: null, head: null, approved: null, revisions: [] });

  const [head, approved, revisions] = await Promise.all([
    headRevision(id, scene.id),
    approvedRevision(id, scene.id),
    listRevisions(id, scene.id),
  ]);

  return NextResponse.json({
    sceneId: scene.id,
    head: head ? headSummary(head) : null,
    approved: approved ? headSummary(approved) : null,
    revisions: revisions.map((r) => ({
      ...headSummary(r),
      parentVersion: r.parentVersion,
      note: r.note,
      createdBy: r.createdBy,
      content: parseRevisionContent(r.content),
    })),
  });
}
