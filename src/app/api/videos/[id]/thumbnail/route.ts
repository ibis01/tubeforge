import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { db } from "@/lib/db";
import { generateThumbnail, deriveThumbnailConcept, readMedia, videoDir } from "@/lib/tubeforge/ai";
import { parseScenes } from "@/lib/tubeforge/story";
import { runQualityGate } from "@/lib/tubeforge/quality";
import { deriveStatus } from "@/lib/tubeforge/status";
import { startJob } from "@/lib/tubeforge/jobs";
import { serializeVideo } from "@/lib/tubeforge/serialize";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Concept for the cover art, derived from the CONTENT so the thumbnail always
 * matches the story: scene videos paint their opening scene; classic videos
 * distill the script's most striking moment via a cheap LLM call.
 */
async function conceptFor(video: {
  format: string;
  scenes: string | null;
  script: string | null;
  topic: string;
}): Promise<string> {
  if (video.format === "story") {
    const first = parseScenes(video.scenes)[0];
    if (first) return `${first.visual}. Mood: ${first.mood || "cinematic"}`;
  }
  return deriveThumbnailConcept({ topic: video.topic, script: video.script });
}

/** POST — kick off CogView thumbnail generation as a background job (returns 202 immediately). */
export async function POST(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const video = await db.video.findUnique({
    where: { id },
    include: {
      character: {
        select: { id: true, name: true, identityAnchor: true, appearance: true, hasPortrait: true },
      },
    },
  });

  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (!video.title)
    return NextResponse.json(
      { error: "Video has no title yet — generate the script first" },
      { status: 400 }
    );
  const title = video.title; // narrowed — safe to use inside the job closure

  // Clear any stale error from a previous failed attempt before polling starts.
  await db.video.update({ where: { id }, data: { error: null } });

  await startJob(id, "thumbnail", async () => {
    try {
      // Script-derived concept keeps the cover matched to the story.
      const concept = await conceptFor(video);

      // Phase 3: VLM quality gate — inspect the thumbnail and re-roll once
      // when it scores below the configured threshold (default mode: on).
      await runQualityGate({
        kind: "thumbnail",
        videoId: id,
        imagePath: path.join(videoDir(id), "thumbnail.png"),
        context: `YouTube thumbnail (${video.thumbStyle} style) for the video "${video.title}" — it should depict: ${concept}`,
        generate: () =>
          generateThumbnail({
            title,
            topic: video.topic,
            style: video.thumbStyle,
            videoId: video.id,
            concept,
            character: video.character ?? null,
          }),
      });

      const fresh = await db.video.findUnique({ where: { id } });
      const nextStatus = deriveStatus(video, {
        hasThumbnail: true,
        hasVoiceover: fresh?.hasVoiceover ?? video.hasVoiceover,
      });

      await db.video.update({
        where: { id },
        data: { hasThumbnail: true, status: nextStatus, error: null },
      });

      await db.activity.create({
        data: {
          videoId: id,
          stage: "thumbnail",
          message: `Thumbnail generated from the script content (${video.thumbStyle} style)${
            video.character ? ` featuring ${video.character.name}` : ""
          } for "${video.title}"`,
        },
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Thumbnail failed";
      await db.video.update({
        where: { id },
        data: { status: "failed", error: message },
      });
      await db.activity.create({
        data: {
          videoId: id,
          stage: "thumbnail",
          level: "error",
          message: `Thumbnail failed: ${message}`,
        },
      });
      // Re-thrown so startJob records the failure for GET polling + history.
      throw err;
    }
  });

  // 202 Accepted — job already running (dedupe) or just started.
  return NextResponse.json(
    { video: serializeVideo(video, null, { includeScenes: true }), accepted: true, generating: true },
    { status: 202 }
  );
}

/** GET — stream the thumbnail PNG. */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const media = readMedia(id, "thumbnail.png");
  if (!media)
    return NextResponse.json({ error: "No thumbnail yet" }, { status: 404 });

  return new NextResponse(new Uint8Array(media), {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(media.length),
      "Cache-Control": "private, max-age=3600",
    },
  });
}
