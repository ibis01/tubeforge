// GET /api/videos/[id]/captions?format=srt|vtt — Stage 6 T-6.7: subtitle export.
//
// The render job already writes `subtitles.srt` to the video's storage folder
// (qc.ts reads it; the export bundle zips it). This endpoint serves the
// captions in the user's chosen format:
//
//   ?format=srt (default) — the original SRT, served verbatim
//   ?format=vtt          — WebVTT (HTML5 <track>, video players, social platforms)
//
// VTT conversion is a trivial syntactic transform: a "WEBVTT" header, a
// blank line, then the same cues with `.` instead of `,` as the timestamp
// fractional separator. No semantic re-timing — VTT and SRT use the same
// HH:MM:SS.mmm|,mmm format.
//
// Returns 404 when the SRT isn't present (render hasn't completed or the
// video has no captions). Content-Type is text/srt or text/vtt so the
// browser doesn't try to render it as HTML.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { materialize } from "@/lib/tubeforge/storage";
import { srtToVtt, looksLikeSrt } from "@/lib/tubeforge/subtitle-export";
import { readFile } from "fs/promises";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });

  const url = new URL(req.url);
  const format = url.searchParams.get("format") === "vtt" ? "vtt" : "srt";

  let srt: string;
  try {
    const srtPath = await materialize(`${id}/subtitles.srt`);
    srt = await readFile(srtPath, "utf8");
  } catch {
    return NextResponse.json(
      { error: "Captions not available — render the video first (or this video has no spoken narration)" },
      { status: 404 }
    );
  }
  if (!looksLikeSrt(srt)) {
    return NextResponse.json(
      { error: "Stored caption file is unreadable — re-render to regenerate it" },
      { status: 500 }
    );
  }

  if (format === "srt") {
    return new NextResponse(srt, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="${id}.srt"`,
        "Cache-Control": "no-store",
      },
    });
  }

  // VTT — convert and serve.
  const vtt = srtToVtt(srt);
  return new NextResponse(vtt, {
    status: 200,
    headers: {
      "Content-Type": "text/vtt; charset=utf-8",
      "Content-Disposition": `attachment; filename="${id}.vtt"`,
      "Cache-Control": "no-store",
    },
  });
}

