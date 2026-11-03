// POST /api/videos/[id]/studio/voice — S8: the narrator pick.
//
// The last creative decision the studio couldn't make from its own walls:
// WHO narrates. Until S8 the voice lived only on the video row — set at
// creation, changeable through the settings PUT, whose invalidation nukes
// every voice-keyed artifact and resets hasVoiceover, so the voiceover
// stage has to re-run and a fresh assembly rebuilds the doc from scratch.
// This route is the surgical counterpart: it re-reads every scene with the
// NEW voice, re-derives every doc window from the fresh reads (each scene's
// creative fields survive — the same applyRevoiceToDoc the transcript lane
// uses), rebuilds the merged voiceover.wav, and drops only the rendered
// artifacts that are genuinely stale.
//
// Gate order (each layer can only refuse, never select):
//   auth → 404 → zod shape (voiceSwapSchema) → speakable catalog
//   (resolvePreviewVoice — the same truth every voice picker uses) → the
//   orchestrator's pipeline guards → the swap.
//
// Failure posture: like the voiceover stage, per-scene WAVs land one at a
// time and the row only moves on FULL success — a mid-swap TTS failure
// leaves the row honest (old voice) and the next attempt re-reads every
// scene again, healing any partial state.
//
// Response: { timeline, sceneOrder, activity, wavDurations, voice } — the
// studio swaps its doc in whole (history resets: a row mutation is not
// doc-undoable), refreshes its audio pools, and the parent re-fetches the
// row so the picker shows the new narrator.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { parseJson, voiceSwapSchema, ApiValidationError } from "@/lib/tubeforge/validation";
import { performVoiceSwap, sceneWavDurations } from "@/lib/tubeforge/clip-ops";
import { resolvePreviewVoice } from "@/lib/tubeforge/voice-preview";
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
    body = await parseJson(req, voiceSwapSchema);
  } catch (err) {
    if (err instanceof ApiValidationError)
      return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }

  // Catalog truth: the same resolver every voice picker + the preview route
  // use. A hostile or foreign id dies here — before any artifact work.
  const resolved = await resolvePreviewVoice(body.voice);
  if (!resolved.known) {
    return NextResponse.json(
      { error: `Voice "${body.voice}" is not in your speakable catalog` },
      { status: 400 }
    );
  }
  if (resolved.config.provider !== "zai" && !resolved.config.apiKey?.trim()) {
    return NextResponse.json(
      {
        error: `No API key set for the ${resolved.config.provider} voiceover provider (Settings → AI Providers)`,
      },
      { status: 400 }
    );
  }

  // performVoiceSwap validates the pipeline prerequisites (story format,
  // tts source, voiceover exists, doc exists, voice differs) and does the
  // asset work; every failure it throws carries a readable message.
  let result;
  try {
    result = await performVoiceSwap(video, resolved.voice);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Voice swap failed" },
      { status: 400 }
    );
  }

  await db.video.update({
    where: { id },
    data: {
      voice: result.voice,
      scenes: JSON.stringify(result.rowScenes),
      timeline: serializeTimeline(result.timeline),
      ...(result.audioDuration !== null ? { audioDuration: result.audioDuration } : {}),
    },
  });

  return NextResponse.json({
    timeline: result.timeline,
    sceneOrder: result.sceneOrder,
    activity: result.activity,
    voice: result.voice,
    wavDurations: sceneWavDurations(
      videoDir(id),
      result.rowScenes.map((s) => s.index)
    ),
  });
}
