// POST /api/videos/[id]/studio/clip — the Timeline Studio's clip operations.
//
// Split / duplicate / delete are the three edits that change the video ROW
// itself (a new scene, a removed scene), so they run server-side: the row's
// scenes array, the per-scene art/WAV assets, the merged voiceover.wav and
// the saved timeline doc all move together in ONE update — the same
// one-source-of-truth rule the assemble PUT follows with sceneOrder.
//
// The client flushes pending timeline edits (PUT /assemble) BEFORE calling
// this — the op reads the SAVED doc and the SAVED row, never a half-edit.
//
// Response: { timeline, sceneOrder, newIndex, activity, wavDurations } — the
// studio swaps its doc in whole (history resets: a row mutation is not
// doc-undoable), selects newIndex, and refreshes its preview pools.
// wavDurations re-reads the per-scene WAVs AFTER the op (a split re-voices
// both halves; a duplicate adds a file) so the razor guard stays exact.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { parseJson, clipOpSchema, ApiValidationError } from "@/lib/tubeforge/validation";
import { performClipOp, sceneWavDurations } from "@/lib/tubeforge/clip-ops";
import { serializeTimeline } from "@/lib/tubeforge/timeline";
import { videoDir } from "@/lib/tubeforge/ai";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });

  let body;
  try {
    body = await parseJson(req, clipOpSchema);
  } catch (err) {
    if (err instanceof ApiValidationError)
      return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }

  // performClipOp validates the pipeline prerequisites (doc exists, art +
  // WAV on disk, voice source) and does the asset work; every failure it
  // throws carries a readable, actionable message.
  let result;
  try {
    result = await performClipOp(video, body);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Clip operation failed" },
      { status: 400 }
    );
  }

  await db.video.update({
    where: { id },
    data: {
      scenes: JSON.stringify(result.rowScenes),
      timeline: serializeTimeline(result.timeline),
      ...(result.audioDuration !== null ? { audioDuration: result.audioDuration } : {}),
    },
  });

  return NextResponse.json({
    timeline: result.timeline,
    sceneOrder: result.sceneOrder,
    newIndex: result.newIndex,
    activity: result.activity,
    wavDurations: sceneWavDurations(
      videoDir(id),
      result.rowScenes.map((s) => s.index)
    ),
  });
}
