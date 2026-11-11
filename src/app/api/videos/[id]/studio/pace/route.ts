// POST /api/videos/[id]/studio/pace — S11: the pacing pick.
//
// The voice's sibling axis: HOW FAST the narrator reads. Until S11 the
// pace lived only on the video row — set once at the create form's
// slider, and changeable solely through the settings-style PATCH, whose
// invalidation nukes every voice-keyed artifact and resets hasVoiceover,
// so the voiceover stage has to re-run and a fresh assembly rebuilds the
// doc from scratch. This route is the surgical counterpart (the same
// escape performVoiceSwap gave the narrator in S8): it re-reads every
// scene with the SAME voice at the NEW speed, re-derives every doc window
// from the fresh reads (each scene's creative fields survive — the same
// applyRevoiceToDoc the transcript lane and the voice swap use), rebuilds
// the merged voiceover.wav, and drops only the rendered artifacts that
// are genuinely stale.
//
// Gate order (each layer can only refuse, never select):
//   auth → 404 → zod shape (paceChangeSchema) → the orchestrator's
//   pipeline guards (format, voice source, voiceover exists, doc exists,
//   scenes exist, pace differs — all inside performPaceChange, where the
//   row's standing speed is known) → the re-read.
//
// Failure posture: like the voiceover stage, per-scene WAVs land one at a
// time and the row only moves on FULL success — a mid-run TTS failure
// leaves the row honest (old pace) and the next attempt re-reads every
// scene again, healing any partial state.
//
// Response: { timeline, sceneOrder, activity, wavDurations, ttsSpeed } —
// the studio swaps its doc in whole (history resets: a row mutation is
// not doc-undoable), refreshes its audio pools, and the parent re-fetches
// the row so every ttsSpeed reader (the detail dialog's readout, the
// create form's prefill) shows the new pace.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { parseJson, paceChangeSchema, ApiValidationError } from "@/lib/tubeforge/validation";
import { performPaceChange, sceneWavDurations } from "@/lib/tubeforge/clip-ops";
import { serializeTimeline, guardTimelineOverwrite, TIMELINE_OVERWRITE_ERROR } from "@/lib/tubeforge/timeline";
import { videoDir } from "@/lib/tubeforge/ai";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });

  // S87 slice 1 — the overwrite guard, BEFORE the op's asset work: an
  // unknown-stamp stored doc is a newer build's doc, and this op saves the
  // row + doc in ONE update — so the whole op is refused (a re-voice must
  // never spend paid TTS into a write that would clobber it).
  const guard = guardTimelineOverwrite(video.timeline);
  if (guard.blocked)
    return NextResponse.json({ error: TIMELINE_OVERWRITE_ERROR }, { status: 409 });

  let body;
  try {
    body = await parseJson(req, paceChangeSchema);
  } catch (err) {
    if (err instanceof ApiValidationError)
      return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }

  // performPaceChange validates the pipeline prerequisites (story format,
  // tts source, voiceover exists, doc exists, scenes exist, pace differs)
  // and does the asset work; every failure it throws carries a readable
  // message. No catalog gate is needed — the re-read uses the row's OWN
  // narrator, the voice the voiceover was already spoken in.
  let result;
  try {
    result = await performPaceChange(video, body.speed);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Pace change failed" },
      { status: 400 }
    );
  }

  await db.video.update({
    where: { id },
    data: {
      ttsSpeed: result.ttsSpeed,
      scenes: JSON.stringify(result.rowScenes),
      timeline: serializeTimeline(result.timeline),
      ...(result.audioDuration !== null ? { audioDuration: result.audioDuration } : {}),
    },
  });

  return NextResponse.json({
    timeline: result.timeline,
    sceneOrder: result.sceneOrder,
    activity: result.activity,
    ttsSpeed: result.ttsSpeed,
    wavDurations: sceneWavDurations(
      videoDir(id),
      result.rowScenes.map((s) => s.index)
    ),
  });
}
