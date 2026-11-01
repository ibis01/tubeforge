import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { safeZipName, streamZip, zipMethodFor, type StreamZipEntry } from "@/lib/tubeforge/zip";
import { listVariants } from "@/lib/tubeforge/ai";
import { parseScenes, sceneImageFile } from "@/lib/tubeforge/story";
import { LENGTHS, TONES, VOICES } from "@/lib/tubeforge/types";
import { resolveMusicForVideo, isMusicEnabledForVideo } from "@/lib/tubeforge/music";
import { Readable } from "stream";

type Ctx = { params: Promise<{ id: string }> };

const UPLOAD_ROOT = path.join(process.cwd(), "uploads");

/** GET — download the full upload-ready package as a ZIP. */
export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const { id } = await ctx.params;
  const video = await db.video.findUnique({
    where: { id },
    include: {
      channel: { select: { name: true, niche: true } },
      character: { select: { name: true, role: true, identityAnchor: true } },
    },
  });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });

  // Stage 3 (T-3.6, closes D-24): media assets STREAM from disk through the
  // data-descriptor ZIP builder — the whole package flows through a few MB of
  // memory instead of buffering every asset plus the archive. Text metadata
  // stays in memory (KBs) and uses the same stream with a one-shot source.
  const entries: StreamZipEntry[] = [];
  const addText = (name: string, data: Buffer | string | null) => {
    if (data !== null && data !== undefined) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
      entries.push({
        name: safeZipName(name),
        stream: () => Readable.from([buf]),
        method: 8,
      });
    }
  };
  const hasFile = (rel: string): boolean => {
    try {
      return fs.statSync(path.join(UPLOAD_ROOT, video.id, rel)).isFile();
    } catch {
      return false;
    }
  };
  const addFile = (name: string, rel: string) => {
    const p = path.join(UPLOAD_ROOT, video.id, rel);
    if (hasFile(rel)) {
      entries.push({
        name: safeZipName(name),
        stream: () => fs.createReadStream(p),
        method: zipMethodFor(name),
      });
    }
  };

  const base = safeZipName(video.title ?? video.topic) || "video-package";
  const scenes = video.format === "story" ? parseScenes(video.scenes) : [];

  // Core metadata for manual YouTube upload
  const tags = video.tags ? video.tags.split(",").map((t) => t.trim()).filter(Boolean) : [];
  addText(
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

  addText(`${base}/script.txt`, video.script);
  addText(`${base}/description.txt`, video.description);
  addText(`${base}/tags.csv`, tags.length ? "tag\n" + tags.join("\n") : null);

  // Engagement kit (Phase 4) — paste into the comment section right after upload.
  let kit: { pinnedComment?: string; replies?: { trigger: string; text: string }[]; heartTargets?: string[]; strategy?: string } | null = null;
  try {
    kit = video.commentsKit ? JSON.parse(video.commentsKit) : null;
  } catch {
    kit = null;
  }
  if (kit?.pinnedComment) {
    addText(
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

  addText(
    `${base}/metadata.json`,
    JSON.stringify(
      {
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

  // CREDITS.txt — every music + footage license in one paste-ready file, so a
  // monetized upload can always prove its soundtrack and b-roll are safe.
  // ("a technically good video does not create copyright problems later")
  try {
    const musicEnabled = await isMusicEnabledForVideo(video);
    const resolvedMusic = musicEnabled ? await resolveMusicForVideo(video) : null;
    const creditLines: string[] = [
      `CREDITS & LICENSES — "${video.title ?? video.topic}"`,
      `Exported ${new Date().toISOString()}`,
      ``,
      `== BACKGROUND MUSIC ==`,
    ];
    if (!musicEnabled) {
      creditLines.push("Music disabled for this video — no soundtrack license needed.");
    } else if (resolvedMusic) {
      const t = resolvedMusic.track;
      creditLines.push(
        `Track: "${t.name}"${t.genre ? ` (${t.genre})` : ""}`,
        `License: ${t.licenseType}`,
        t.sourceUrl ? `Source: ${t.sourceUrl}` : `Source: TubeForge in-app library`,
        `Commercial use: ${t.commercialUse ? "allowed" : "NOT allowed — check before monetizing"}`,
        `Attribution required: ${t.attributionRequired ? "YES" : "no"}`,
        t.attributionRequired && t.attributionText ? `Credit line: ${t.attributionText}` : ``,
        t.licenseEvidence ? `License evidence: ${t.licenseEvidence}` : ``,
        t.contentIdNotes ? `Content ID notes: ${t.contentIdNotes}` : ``
      );
    } else {
      creditLines.push(
        "Synthesized in-app ambient bed (TubeForge original — generated from pure sine synthesis,",
        "no third-party samples; no attribution needed, cannot match any Content ID fingerprint)."
      );
    }
    const stockScenes = scenes.filter((s) => s.stock);
    creditLines.push(``, `== STOCK FOOTAGE ==`);
    if (stockScenes.length === 0) {
      creditLines.push("None — all visuals are generated storyboard art.");
    } else {
      for (const s of stockScenes) {
        creditLines.push(`Scene ${s.index}: ${s.stock!.credit} — ${s.stock!.pageUrl}`);
      }
    }
    creditLines.push(
      ``,
      `== SOUND EFFECTS ==`,
      "All accents are synthesized in-app (royalty-free by construction — no sampled SFX).",
      ``,
      `Paste the attribution lines above into your YouTube description when the license requires it.`
    );
    addText(`${base}/CREDITS.txt`, creditLines.join("\n").replace(/\n==/g, "\n\n=="));
  } catch {
    // Credits must never block an export — a resolveMusicForVideo failure
    // (e.g. deleted pinned track) just omits the file.
  }

  // Media assets — streamed from disk (no whole-file buffers)
  addFile(`${base}/voiceover.wav`, "voiceover.wav");
  addFile(`${base}/thumbnail.png`, "thumbnail.png");

  for (const v of listVariants(video.id)) {
    addFile(`${base}/thumbnail-variants/${v.style}.png`, v.fileName);
  }

  // Story engine artifacts — storyboard art, captions, rendered video
  for (const scene of scenes) {
    addFile(`${base}/storyboard/scene-${String(scene.index).padStart(2, "0")}.png`, sceneImageFile(scene.index));
  }
  addFile(`${base}/subtitles.srt`, "subtitles.srt");
  addFile(`${base}/final.mp4`, "final.mp4");

  if (entries.length === 0)
    return NextResponse.json(
      { error: "Nothing to export yet — run the Auto-Pilot pipeline first" },
      { status: 400 }
    );

  // Chunked transfer (no Content-Length — the ZIP is composed on the fly).
  // Browsers handle attachment downloads over chunked responses fine.
  return new NextResponse(streamZip(entries), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${base.replace(/[^\w.-]/g, "_").slice(0, 80)}.zip"`,
      "Cache-Control": "no-store",
    },
  });
}
