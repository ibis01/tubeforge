import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { parseScenes, sceneWavFile } from "@/lib/tubeforge/story";
import { getApprovedAudioMap } from "@/lib/tubeforge/director-plan";
import { wavDurationSec } from "@/lib/tubeforge/wav";
import * as storage from "@/lib/tubeforge/storage";
import { pacingReport, WPM_BANDS, type PacingHint } from "@/lib/tubeforge/pacing";

/**
 * S92 (ROADMAP #11) — the measured narration pacing report.
 *
 * The pacing targets have always existed (SCENE_COUNTS retention tuning,
 * the approved plan's per-scene hints → pacingSpeedFactor, the video-level
 * ttsSpeed) — this is the first thing that MEASURES the delivered pace:
 * the real scene-XX.wav durations against the real narration word counts,
 * judged against the documented English WPM bands, proposed back in the
 * system's own vocabulary (the plan's slow/normal/fast hints + the
 * projected WPM each hint would deliver).
 *
 * ADVISORY ONLY — it reads, it never re-synthesizes; the tails (one-click
 * apply through the existing speed lanes) are recorded in the design doc.
 */

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (video.format !== "story")
    return NextResponse.json(
      { error: "Pacing measurement is scene-based — classic script videos pace as one read" },
      { status: 400 }
    );

  const scenes = parseScenes(video.scenes);
  if (scenes.length === 0)
    return NextResponse.json({ error: "Video has no scenes yet" }, { status: 400 });

  // The real per-scene durations from the synthesized WAVs (a scene without
  // a WAV yet is "unmeasured" — the report says so, never guesses).
  const durations = await Promise.all(
    scenes.map((s) =>
      storage
        .get(`${id}/${sceneWavFile(s.index)}`)
        .then((buf) => (buf.length > 44 ? wavDurationSec(buf) : null))
        .catch(() => null)
    )
  );

  const report = pacingReport(
    scenes.map((s) => ({ index: s.index, narration: s.narration, rehook: s.rehook })),
    durations
  );

  // What direction the APPROVED plan already gives (absent = "normal").
  const audioMap = await getApprovedAudioMap(id);
  const currentHints: Record<number, PacingHint> = {};
  for (const [idx, hint] of audioMap.pacing) currentHints[idx] = hint;
  const planApproved = video.directorState === "approved";

  return NextResponse.json({
    perScene: report.perScene,
    summary: report.summary,
    currentHints,
    planApproved,
    videoSpeed: video.ttsSpeed,
    bands: WPM_BANDS,
    note: "English-narration bands; CJK narration counts per character — proportional, not absolute",
  });
}
