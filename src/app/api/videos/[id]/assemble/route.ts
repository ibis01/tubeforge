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
//
// GET/POST also return `wavDurations` — per-scene read lengths off disk — so
// the Timeline Studio's razor guard mirrors clip-ops' splitNarrationAt
// exactly instead of estimating from doc durations (which drift on trims).

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { parseScenes } from "@/lib/tubeforge/story";
import { parsePlan } from "@/lib/tubeforge/director-plan";
import {
  assembleTimeline,
  serializeTimeline,
  parseTimeline,
  deriveTracks,
  guardTimelineOverwrite,
  TIMELINE_OVERWRITE_ERROR,
  type AssembledTimeline,
} from "@/lib/tubeforge/timeline";
import { parseJson, assembleSaveSchema, ApiValidationError } from "@/lib/tubeforge/validation";
import { sceneWavDurations } from "@/lib/tubeforge/clip-ops";
import { videoDir } from "@/lib/tubeforge/ai";

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

  return NextResponse.json({
    timeline: parseTimeline(video.timeline),
    wavDurations: sceneWavDurations(
      videoDir(id),
      parseScenes(video.scenes).map((s) => s.index)
    ),
  });
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

  // S87 slice 1 — the overwrite guard: a stored doc this build cannot parse
  // (an unknown stamp = a newer build's doc) must never be clobbered by a
  // recompute-and-save. DELETE /assemble is the human's explicit escape
  // hatch; everything else refuses here, before any work happens.
  const guard = guardTimelineOverwrite(video.timeline);
  if (guard.blocked)
    return NextResponse.json({ error: TIMELINE_OVERWRITE_ERROR }, { status: 409 });

  const scenes = parseScenes(video.scenes);
  if (scenes.length === 0)
    return NextResponse.json(
      { error: "No scenes — generate the script first" },
      { status: 400 }
    );

  const approvedPlan = video.directorState === "approved" ? parsePlan(video.shotList) : null;

  // Measured read lengths (a few ms of local disk): the assembled doc uses
  // the render's EXACT per-scene segments instead of word-count estimates,
  // so an assembly never silently trims a long read (see timeline.ts note 2).
  const wavDurations = sceneWavDurations(
    videoDir(id),
    scenes.map((s) => s.index)
  );

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
    wavDurations,
  });

  await db.video.update({
    where: { id },
    data: { timeline: serializeTimeline(timeline) },
  });

  return NextResponse.json({ timeline, wavDurations });
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

  // S87 slice 1 — the overwrite guard (same law as POST): a user-edited
  // save must never replace a doc written by a newer build.
  const guard = guardTimelineOverwrite(video.timeline);
  if (guard.blocked)
    return NextResponse.json({ error: TIMELINE_OVERWRITE_ERROR }, { status: 409 });

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
    // The permutation check above guarantees every i resolves; `?? []`
    // keeps the map total anyway (S58/T-58.1).
    const reordered = body.sceneOrder.flatMap((i) => byIdx.get(i) ?? []);
    rowScenes = JSON.stringify(reordered);
  }

  const timeline: AssembledTimeline = {
    // S87 slice 1 — the PUT rebuilds the doc from the client's scenes; the
    // stamp is set HERE (never trusted from the body: the client's copy is
    // a display echo, the server owns the contract version). The tracks
    // projection is derived from the same scenes; serializeTimeline
    // re-derives it at the write anyway (derive-at-serialization — a
    // carried copy could never go stale because it is never carried).
    schema: 2,
    scenes: body.scenes as AssembledTimeline["scenes"],
    tracks: deriveTracks(body.scenes as AssembledTimeline["scenes"]),
    sceneCount: body.scenes.length,
    totalDurationSec: body.totalDurationSec,
    generatedAt: body.generatedAt ?? new Date().toISOString(),
    // S3 — render prefs (quality tier) ride the doc root.
    renderPrefs: body.renderPrefs ?? null,
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

/** DELETE — clear the persisted timeline (the render falls back to recomputing).
 *  S87 slice 1 — deliberately UNGUARDED: this is the human's explicit
 *  escape hatch when a newer build's doc blocks the guarded write paths —
 *  a deliberate decision, not a blind clobber. */
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
