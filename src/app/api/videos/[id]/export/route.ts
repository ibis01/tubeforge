import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { db } from "@/lib/db";
import { buildZip, safeZipName } from "@/lib/tubeforge/zip";
import { readMedia, listVariants } from "@/lib/tubeforge/ai";
import { parseScenes, sceneImageFile } from "@/lib/tubeforge/story";
import { LENGTHS, TONES, VOICES } from "@/lib/tubeforge/types";

type Ctx = { params: Promise<{ id: string }> };

const UPLOAD_ROOT = path.join(process.cwd(), "uploads");

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
  const readFile = (rel: string): Buffer | null => {
    const p = path.join(UPLOAD_ROOT, video.id, rel);
    return fs.existsSync(p) ? fs.readFileSync(p) : null;
  };

  const base = safeZipName(video.title ?? video.topic) || "video-package";
  const scenes = video.format === "story" ? parseScenes(video.scenes) : [];

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
      `FORMAT: ${video.format === "story" ? `Scene-based story (${scenes.length} scenes)` : "Narration script"}`,
      `VOICE: ${VOICES.find((v) => v.id === video.voice)?.label ?? video.voice}`,
      `CAST: ${video.character ? `${video.character.name} — ${video.character.role ?? "recurring host"}` : "—"}`,
      `WORD COUNT: ${video.wordCount ?? "—"}`,
      `AUDIO DURATION: ${video.audioDuration ? `${Math.round(video.audioDuration)} seconds` : "—"}`,
      video.hasVideo && video.videoDuration
        ? `RENDERED VIDEO: final.mp4 (${Math.round(video.videoDuration)} seconds, ${video.renderMode})`
        : ``,
      video.youtubeUrl ? `UPLOADED TO YOUTUBE: ${video.youtubeUrl}` : ``,
      ``,
      `DESCRIPTION:`,
      video.description ?? "—",
      ``,
      `TAGS (${tags.length}):`,
      tags.join(", ") || "—",
      ``,
      `HOW TO UPLOAD:`,
      video.hasVideo
        ? [
            `1. Upload final.mp4 as the video file.`,
            `2. Paste the description from this file into the YouTube upload form.`,
            `3. Add the tags in YouTube Studio's tag field.`,
            `4. Upload thumbnail.png as the custom thumbnail.`,
            `5. subtitles.srt can be uploaded as the caption track.`,
            `6. After publishing, post engagement-kit.txt's pinned comment and pin it.`,
          ].join("\n")
        : [
            `1. Combine the voiceover with visuals (use the thumbnail as cover art).`,
            `2. Paste the description from this file into the YouTube upload form.`,
            `3. Add the tags in YouTube Studio's tag field.`,
            `4. Upload thumbnail.png as the custom thumbnail.`,
          ].join("\n"),
    ].join("\n")
  );

  add(`${base}/script.txt`, video.script);
  add(`${base}/description.txt`, video.description);
  add(`${base}/tags.csv`, tags.length ? "tag\n" + tags.join("\n") : null);

  // Engagement kit (Phase 4) — paste into the comment section right after upload.
  let kit: { pinnedComment?: string; replies?: { trigger: string; text: string }[]; heartTargets?: string[]; strategy?: string } | null = null;
  try {
    kit = video.commentsKit ? JSON.parse(video.commentsKit) : null;
  } catch {
    kit = null;
  }
  if (kit?.pinnedComment) {
    add(
      `${base}/engagement-kit.txt`,
      [
        `ENGAGEMENT KIT — post these in the first golden hour after upload.`,
        ``,
        `=== PINNED COMMENT (post this first, then pin it) ===`,
        kit.pinnedComment,
        ``,
        `=== REPLY TEMPLATES ===`,
        ...(kit.replies ?? []).map(
          (r, i) => `${i + 1}) WHEN: ${r.trigger}\n   REPLY: ${r.text}`
        ),
        ``,
        `=== HEART THESE EARLY COMMENTS ===`,
        ...(kit.heartTargets ?? []).map((t) => `- ${t}`),
        ``,
        `=== PLAYBOOK ===`,
        kit.strategy ?? "",
      ].join("\n")
    );
  }

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
        format: video.format,
        renderMode: video.renderMode,
        scenes: scenes.length
          ? scenes.map((s) => ({
              index: s.index,
              title: s.title,
              narration: s.narration,
              camera: s.camera,
              mood: s.mood,
              caption: s.caption,
            }))
          : undefined,
        cast: video.character
          ? {
              name: video.character.name,
              role: video.character.role,
              identityAnchor: video.character.identityAnchor,
            }
          : null,
        wordCount: video.wordCount,
        audioDurationSec: video.audioDuration,
        videoDurationSec: video.hasVideo ? video.videoDuration : undefined,
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
    add(`${base}/thumbnail-variants/${v.style}.png`, readMedia(video.id, v.fileName as `variant-${string}.png`));
  }

  // Story engine artifacts — storyboard art, captions, rendered video
  for (const scene of scenes) {
    add(`${base}/storyboard/scene-${String(scene.index).padStart(2, "0")}.png`, readFile(sceneImageFile(scene.index)));
  }
  add(`${base}/subtitles.srt`, readFile("subtitles.srt"));
  add(`${base}/final.mp4`, readFile("final.mp4"));

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
