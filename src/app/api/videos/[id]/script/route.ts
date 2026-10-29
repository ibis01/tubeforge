import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { db } from "@/lib/db";
import { generateScriptPackage } from "@/lib/tubeforge/ai";
import { generateSceneScriptPackage } from "@/lib/tubeforge/story";
import { deriveStatus } from "@/lib/tubeforge/status";
import { startJob, isJobRunning } from "@/lib/tubeforge/jobs";
import { serializeVideo } from "@/lib/tubeforge/serialize";
import { errorText } from "@/lib/tubeforge/redact";

type Ctx = { params: Promise<{ id: string }> };

const UPLOAD_ROOT = path.join(process.cwd(), "uploads");
const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

/**
 * A fresh script changes the story, so a previously generated cover can no
 * longer be trusted to match it — drop the thumbnail + A/B variants and let
 * the UI offer a fresh, script-matched one.
 */
async function invalidateThumbnail(videoId: string): Promise<void> {
  const dir = path.join(UPLOAD_ROOT, videoId);
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f === "thumbnail.png" || /^variant-[\w-]+\.png$/.test(f))
        fs.rmSync(path.join(dir, f), { force: true });
    }
  } catch {
    /* no media dir yet */
  }
  await db.video.update({ where: { id: videoId }, data: { hasThumbnail: false } });
}

/** POST — (re)generate the script package as a background job (202 + poll).
 *
 * Two entry points share one button in the detail dialog:
 *   1. RETRY — script generation failed at create time (status "failed", no
 *      script). Writes the missing script from the stored topic/niche/tone.
 *   2. RE-ROLL — an existing script is replaced with a fresh AI take.
 *      Scene videos reset their scene-bound media (voiceover, storyboard,
 *      renders) because the new scene boundaries invalidate the old cuts.
 */
export async function POST(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const video = await db.video.findUnique({
    where: { id },
    include: {
      channel: { select: { name: true } },
      character: { select: { name: true, hasPortrait: true } },
    },
  });

  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (!video.topic.trim())
    return NextResponse.json(
      { error: "Video has no topic to write a script from" },
      { status: 400 }
    );
  if (isJobRunning(id, "script"))
    return NextResponse.json(
      { error: "Script generation is already running for this video" },
      { status: 409 }
    );

  const isStory = video.format === "story";
  const hadScript = Boolean(video.script);

  // Clear the stale failure so the retry visibly starts fresh. Only a failed
  // first attempt drops back to "draft"; richer statuses (voiced/ready/…)
  // survive until the new script actually lands.
  await db.video.update({
    where: { id },
    data: {
      error: null,
      status: video.status === "failed" ? "draft" : video.status,
    },
  });

  const accepted = await startJob(id, "script", async () => {
    try {
      if (isStory) {
        // ----- Scene-based story: fresh scenes + reset scene-bound media -----
        const character = video.characterId
          ? await db.character.findUnique({ where: { id: video.characterId } })
          : null;

        const pkg = await generateSceneScriptPackage({
          topic: video.topic,
          niche: video.niche,
          tone: video.tone,
          length: video.length,
          character: character
            ? {
                name: character.name,
                personality: character.personality,
                identityAnchor: character.identityAnchor,
              }
            : null,
        });

        // New scene boundaries invalidate per-scene audio/art and old renders.
        const dir = path.join(UPLOAD_ROOT, id);
        try {
          for (const f of fs.readdirSync(dir)) {
            if (
              /^scene-\d+\.(wav|png|mp4)$/.test(f) ||
              [
                "voiceover.wav",
                "final.mp4",
                "preview.mp4",
                "subtitles.srt",
                "short.mp4",
                "short-thumb.png",
              ].includes(f)
            ) {
              fs.rmSync(path.join(dir, f), { force: true });
            }
          }
        } catch {
          /* no media dir yet — nothing to clean */
        }

        // The old cover depicted the old story — invalidate it.
        if (hadScript) await invalidateThumbnail(id);

        await db.video.update({
          where: { id },
          data: {
            title: pkg.title,
            script: pkg.script,
            description: pkg.description,
            tags: pkg.tags.join(", "),
            scenes: JSON.stringify(pkg.scenes),
            wordCount: wordCount(pkg.script),
            hasVoiceover: false,
            audioDuration: null,
            voiceSource: "tts",
            voiceLabel: null,
            hasStoryboard: false,
            hasVideo: false,
            hasShort: false,
            shortDuration: null,
            shortScene: null,
            status: deriveStatus(
              { ...video, script: pkg.script },
              { hasVoiceover: false }
            ),
            error: null,
          },
        });

        await db.activity.create({
          data: {
            videoId: id,
            stage: "script",
            message: `Scene script ${hadScript ? "re-written" : "written"} — "${pkg.title}" (${pkg.scenes.length} scenes, ${wordCount(pkg.script)} words)${
              hadScript
                ? " · previous voiceover, storyboard, renders and thumbnail were reset"
                : ""
            }${
              pkg.verification.fixes > 0
                ? ` · plan audit fixed ${pkg.verification.fixes} scene${pkg.verification.fixes === 1 ? "" : "s"} (script/art mismatch caught before painting)`
                : " · plan audit: every scene matches its narration"
            }`,
          },
        });
      } else {
        // ----- Classic narration package -----
        const pkg = await generateScriptPackage({
          topic: video.topic,
          niche: video.niche,
          tone: video.tone,
          length: video.length,
        });

        // Re-rolled script → the old cover no longer matches the story.
        if (hadScript) await invalidateThumbnail(id);

        await db.video.update({
          where: { id },
          data: {
            title: pkg.title,
            script: pkg.script,
            description: pkg.description,
            tags: pkg.tags.join(", "),
            wordCount: wordCount(pkg.script),
            status: deriveStatus({ ...video, script: pkg.script }),
            error: null,
          },
        });

        await db.activity.create({
          data: {
            videoId: id,
            stage: "script",
            message: `Script ${hadScript ? "re-written" : "written"} — "${pkg.title}" (${wordCount(pkg.script)} words)`,
          },
        });
      }
    } catch (err) {
      const message =
        errorText(err, "Script generation failed");
      // A failed FIRST attempt marks the video failed (matches the create
      // flow); a failed re-roll keeps the old script + status — only the
      // error is surfaced.
      await db.video
        .update({
          where: { id },
          data: hadScript
            ? { error: message }
            : { status: "failed", error: message },
        })
        .catch(() => {});
      await db.activity
        .create({
          data: {
            videoId: id,
            stage: "script",
            level: "error",
            message: `Script generation failed: ${message}`,
          },
        })
        .catch(() => {});
      // Re-thrown so startJob records the failure for polling + history.
      throw err;
    }
  });

  if (!accepted)
    return NextResponse.json(
      { error: "Script generation is already running for this video" },
      { status: 409 }
    );

  // 202 Accepted — the job runs in-process; clients poll GET /api/videos/[id]
  // and watch the `generating.script` flag.
  return NextResponse.json(
    {
      video: serializeVideo(
        { ...video, error: null },
        video.channel?.name,
        { includeScenes: true }
      ),
      accepted: true,
      generating: true,
    },
    { status: 202 }
  );
}
