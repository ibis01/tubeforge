// POST /api/videos/[id]/assemble — Stage 6 T-6.1: produce the preview timeline.
//
// Builds a JSON view of the render's plan — per-scene start/end times,
// transitions, audio levels, caption cues, shot metadata — from the video
// row's scenes + shotList + audio settings. The Editing Studio (Stage 6
// UX) edits this; the render job (T-6.10) consumes the SAVED version
// instead of recomputing inline.
//
// GET — return the persisted timeline (null until first assembled).
// POST — compute fresh from current video state and persist (idempotent;
//        re-assembling after a re-render or director re-approve refreshes it).
// PUT  — save a user-edited timeline body (assembleSaveSchema validates
//        structure; deep content stays the video row's responsibility).
// DELETE — clear the persisted timeline (the render falls back to recomputing).

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { parseScenes } from "@/lib/tubeforge/story";
import { parsePlan } from "@/lib/tubeforge/director-plan";
import {
  assembleTimeline,
  serializeTimeline,
  parseTimeline,
  type AssembledTimeline,
} from "@/lib/tubeforge/timeline";
import { parseJson, assembleSaveSchema, ApiValidationError } from "@/lib/tubeforge/validation";

type Ctx = { params: Promise<{ id: string }> };

/** GET — the persisted timeline (null until first assembled). */
export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (video.format !== "story")
    return NextResponse.json(
      { error: "Timeline assembly is for scene-format videos" },
      { status: 400 }
    );

  return NextResponse.json({ timeline: parseTimeline(video.timeline) });
}

/** POST — compute fresh from current state and persist (idempotent). */
export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (video.format !== "story")
    return NextResponse.json(
      { error: "Timeline assembly is for scene-format videos" },
      { status: 400 }
    );

  const scenes = parseScenes(video.scenes);
  if (scenes.length === 0)
    return NextResponse.json(
      { error: "No scenes — generate the script first" },
      { status: 400 }
    );

  const approvedPlan = video.directorState === "approved" ? parsePlan(video.shotList) : null;

  const timeline: AssembledTimeline = assembleTimeline(scenes, {
    shotPlan: approvedPlan,
    transitionStyle: video.transitionStyle,
    transitionDuration: video.transitionDuration,
    audioDurationSec: video.audioDuration,
    ttsSpeed: video.ttsSpeed,
    renderMode: video.renderMode,
    musicEnabled: video.musicEnabled,
    musicVolume: video.musicVolume,
    musicDucking: video.musicDucking,
  });

  await db.video.update({
    where: { id },
    data: { timeline: serializeTimeline(timeline) },
  });

  return NextResponse.json({ timeline });
}

/** PUT — save a user-edited timeline body (assembleSaveSchema). The route is
 *  permissive on deep content (the schema only validates the per-scene index
 *  + start/end + duration shape); the Timeline Studio is the source of truth
 *  for those edits.
 *
 *  sceneOrder: when present, the row's scenes array is rewritten into the
 *  SAME play order (validated as an exact permutation). The render maps
 *  timeline durations onto the row's scenes BY POSITION, so the row must
 *  move with the doc — one db update, never two sources of truth. */
export async function PUT(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (video.format !== "story")
    return NextResponse.json(
      { error: "Timeline assembly is for scene-format videos" },
      { status: 400 }
    );

  let body;
  try {
    body = await parseJson(req, assembleSaveSchema);
  } catch (err) {
    if (err instanceof ApiValidationError)
      return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }

  // Optional row reorder — an exact permutation of the current scene
  // indices, or the save is rejected whole (no partial reorders).
  let rowScenes: string | null = null;
  if (body.sceneOrder) {
    const current = parseScenes(video.scenes);
    const currentIdx = new Set(current.map((s) => s.index));
    const orderIdx = new Set(body.sceneOrder);
    const sameSet =
      currentIdx.size === orderIdx.size &&
      body.sceneOrder.length === current.length &&
      body.sceneOrder.every((i) => currentIdx.has(i));
    if (!sameSet)
      return NextResponse.json(
        { error: "sceneOrder must be a permutation of the current scene indices" },
        { status: 400 }
      );
    const byIdx = new Map(current.map((s) => [s.index, s]));
    const reordered = body.sceneOrder.map((i) => byIdx.get(i)!);
    rowScenes = JSON.stringify(reordered);
  }

  const timeline: AssembledTimeline = {
    scenes: body.scenes as AssembledTimeline["scenes"],
    sceneCount: body.scenes.length,
    totalDurationSec: body.totalDurationSec,
    generatedAt: body.generatedAt ?? new Date().toISOString(),
  };

  await db.video.update({
    where: { id },
    data: {
      timeline: serializeTimeline(timeline),
      ...(rowScenes !== null ? { scenes: rowScenes } : {}),
    },
  });

  return NextResponse.json({ timeline });
}

/** DELETE — clear the persisted timeline (the render falls back to recomputing). */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });

  await db.video.update({ where: { id }, data: { timeline: null } });
  return NextResponse.json({ cleared: true });
}
