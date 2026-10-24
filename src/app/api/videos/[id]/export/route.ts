import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { buildZip, safeZipName } from "@/lib/tubeforge/zip";
import { readMedia, listVariants } from "@/lib/tubeforge/ai";
import { LENGTHS, TONES, VOICES } from "@/lib/tubeforge/types";

type Ctx = { params: Promise<{ id: string }> };

/** GET — download the full upload-ready package as a ZIP. */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const video = await db.video.findUnique({
    where: { id },
    include: {
      channel: { select: { name: true, niche: true } },
      character: { select: { name: true, role: true, identityAnchor: true } },
    },
  });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });

  const files: { name: string; data: Buffer }[] = [];
  const add = (name: string, data: Buffer | string | null) => {
    if (data !== null && data !== undefined) {
      files.push({
        name: safeZipName(name),
        data: Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8"),
      });
    }
  };

  const base = safeZipName(video.title ?? video.topic) || "video-package";

  // Core metadata for manual YouTube upload
  const tags = video.tags ? video.tags.split(",").map((t) => t.trim()).filter(Boolean) : [];
  add(
    `${base}/upload-metadata.txt`,
    [
      `TITLE: ${video.title ?? ""}`,
      ``,
      `TOPIC: ${video.topic}`,
      `NICHE: ${video.niche}`,
      `CHANNEL: ${video.channel?.name ?? "—"}${video.channel ? ` (${video.channel.niche})` : ""}`,
      `TONE: ${TONES.find((t) => t.id === video.tone)?.label ?? video.tone}`,
      `LENGTH: ${LENGTHS.find((l) => l.id === video.length)?.label ?? video.length}`,
      `VOICE: ${VOICES.find((v) => v.id === video.voice)?.label ?? video.voice}`,
      `CAST: ${video.character ? `${video.character.name} — ${video.character.role ?? "recurring host"}` : "—"}`,
      `WORD COUNT: ${video.wordCount ?? "—"}`,
      `AUDIO DURATION: ${video.audioDuration ? `${Math.round(video.audioDuration)} seconds` : "—"}`,
      ``,
      `DESCRIPTION:`,
      video.description ?? "—",
      ``,
      `TAGS (${tags.length}):`,
      tags.join(", ") || "—",
      ``,
      `HOW TO UPLOAD:`,
      `1. Combine the voiceover with visuals (use the thumbnail as cover art).`,
      `2. Paste the description from this file into the YouTube upload form.`,
      `3. Add the tags in YouTube Studio's tag field.`,
      `4. Upload thumbnail.png as the custom thumbnail.`,
    ].join("\n")
  );

  add(`${base}/script.txt`, video.script);
  add(`${base}/description.txt`, video.description);
  add(`${base}/tags.csv`, tags.length ? "tag\n" + tags.join("\n") : null);

  add(
    `${base}/metadata.json`,
    JSON.stringify(
      {
        title: video.title,
        topic: video.topic,
        niche: video.niche,
        tone: video.tone,
        length: video.length,
        voice: video.voice,
        thumbnailStyle: video.thumbStyle,
        cast: video.character
          ? {
              name: video.character.name,
              role: video.character.role,
              identityAnchor: video.character.identityAnchor,
            }
          : null,
        wordCount: video.wordCount,
        audioDurationSec: video.audioDuration,
        description: video.description,
        tags,
        channel: video.channel
          ? { name: video.channel.name, niche: video.channel.niche }
          : null,
        generatedBy: "TubeForge Auto-Pilot",
        exportedAt: new Date().toISOString(),
      },
      null,
      2
    )
  );

  // Media assets
  const voiceover = readMedia(video.id, "voiceover.wav");
  add(`${base}/voiceover.wav`, voiceover);

  const thumb = readMedia(video.id, "thumbnail.png");
  add(`${base}/thumbnail.png`, thumb);

  for (const v of listVariants(video.id)) {
    add(`${base}/thumbnail-variants/${v.style}.png`, readMedia(video.id, v.fileName));
  }

  if (files.length === 0)
    return NextResponse.json(
      { error: "Nothing to export yet — run the Auto-Pilot pipeline first" },
      { status: 400 }
    );

  const zip = buildZip(files);

  return new NextResponse(new Uint8Array(zip), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(zip.length),
      "Content-Disposition": `attachment; filename="${base.replace(/[^\w.-]/g, "_").slice(0, 80)}.zip"`,
      "Cache-Control": "no-store",
    },
  });
}
