import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { buildAudioPreview } from "@/lib/tubeforge/audio-preview";
import { errorText } from "@/lib/tubeforge/redact";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET — a short window of the FINAL audio mix (narration + ducked music,
 * loudness-normalized) rendered on demand from the per-scene voiceover WAVs.
 * ?start=12&duration=10 — start clamped into the narration timeline,
 * duration clamped to [3, 20] s. Serves audio/mpeg for an <audio> element.
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (video.format !== "story")
    return NextResponse.json(
      { error: "Mix previews apply to scene-based videos" },
      { status: 400 }
    );

  const params = new URL(req.url).searchParams;
  const startRaw = Number(params.get("start"));
  const durRaw = Number(params.get("duration"));
  const startSec = Number.isFinite(startRaw) && startRaw > 0 ? startRaw : 0;
  const durationSec = Number.isFinite(durRaw) && durRaw > 0 ? durRaw : undefined;

  try {
    const preview = await buildAudioPreview(video, { startSec, durationSec });
    return new NextResponse(new Uint8Array(preview.buffer), {
      status: 200,
      headers: {
        "Content-Type": preview.contentType,
        "Content-Length": String(preview.buffer.length),
        "Content-Disposition": `inline; filename="mix-preview-${id}.mp3"`,
        // X-headers let the UI show WHY it sounds like it does (track, duck).
        "X-Music-Why": encodeURIComponent(preview.musicWhy ?? ""),
        "X-Music-Duck": preview.duckIntensity,
        "X-Window": `${preview.startSec}-${preview.startSec + preview.durationSec}`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return NextResponse.json({ error: errorText(err, "Mix preview failed") }, { status: 400 });
  }
}

export const dynamic = "force-dynamic";
