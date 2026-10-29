import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { parseScenes } from "@/lib/tubeforge/story";
import { renderVideo } from "@/lib/tubeforge/render";
import { resolveMusicForVideo, trackAbsolutePath } from "@/lib/tubeforge/music";
import { qcForVideo } from "@/lib/tubeforge/qc";
import {
  startJob,
  isJobRunning,
  isJobCancelled,
  lastJobError,
  jobProgress,
  setJobProgress,
  JobCancelledError,
} from "@/lib/tubeforge/jobs";
import { errorText } from "@/lib/tubeforge/redact";
import { sanitizeTransition, transitionSummary } from "@/lib/tubeforge/transitions";

type Ctx = { params: Promise<{ id: string }> };

/** GET — render job status (drives the client progress bar). */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (video.format !== "story")
    return NextResponse.json({ error: "Not a scene-based video" }, { status: 400 });

  return NextResponse.json({
    rendering: isJobRunning(id, "render"),
    mode: isJobRunning(id, "render") ? video.renderMode : null,
    progress: jobProgress(id, "render"),
    hasVideo: video.hasVideo,
    videoDuration: video.videoDuration,
    error: lastJobError(id, "render") ?? video.error,
  });
}

/**
 * POST — render the final MP4 as a background job (202).
 * Body: { mode?: "kenburns" | "animated", subtitles?: boolean, music?: boolean,
 *         sceneLimit?: number }  — sceneLimit renders a preview (first N scenes).
 *
 * Music resolution: video-level pin → Settings manual pick → auto mood-match
 * by niche (music.ts); falls back to the inline synthesized drone when the
 * library has no active track. Full renders finish with the QC battery
 * (qc.ts) recorded on the video row.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (video.format !== "story")
    return NextResponse.json(
      { error: "Not a scene-based video — rendering applies to scene-format videos" },
      { status: 400 }
    );

  const scenes = parseScenes(video.scenes);
  if (scenes.length === 0)
    return NextResponse.json(
      { error: "Video has no scenes — generate the scene script first" },
      { status: 400 }
    );

  // Stage interlock FIRST (before the hasVoiceover validation, which trips
  // during a regen because the voiceover route clears its flags upfront):
  // the compositor reads every scene WAV to time the cuts — a concurrent
  // voiceover regen would feed it half-old, half-new narration (seen live:
  // mixed stub-tone + re-spoken audio in one render).
  if (isJobRunning(id, "voiceover"))
    return NextResponse.json(
      { error: "The voiceover is still regenerating — wait for it to finish before rendering" },
      { status: 409 }
    );

  if (!video.hasStoryboard)
    return NextResponse.json(
      { error: "Generate the storyboard first — there is no scene art yet" },
      { status: 400 }
    );
  if (!video.hasVoiceover)
    return NextResponse.json(
      { error: "Generate the voiceover first — narration drives the scene timing" },
      { status: 400 }
    );

  const body = await req.json().catch(() => ({}));
  const mode = ["animated", "stock"].includes(body?.mode) ? body.mode : "kenburns";
  const subtitles = body?.subtitles !== false; // default: burn captions
  const smartCaptions = body?.smartCaptions !== false; // default: ASR-synced cues (Phase 4)
  const music = body?.music !== false; // default: ambient bed
  const sceneLimitRaw = Number(body?.sceneLimit);
  const sceneLimit =
    Number.isInteger(sceneLimitRaw) && sceneLimitRaw >= 1
      ? Math.min(sceneLimitRaw, scenes.length)
      : undefined;

  // Resolve the library track (null → synthesized drone fallback in render.ts).
  const resolved = music ? await resolveMusicForVideo(video) : null;
  const musicTrack = resolved
    ? {
        filePath: trackAbsolutePath(resolved.track),
        gain: resolved.gain,
        fadeInSec: resolved.fadeInSec,
        fadeOutSec: resolved.fadeOutSec,
      }
    : null;

  // Scene transitions: per-video override (null = built-in crossfade 0.5s).
  const transition = sanitizeTransition({
    style: video.transitionStyle,
    durationSec: video.transitionDuration,
  });

  // Clear any stale error before the job starts.
  await db.video.update({ where: { id }, data: { error: null } });

  const accepted = await startJob(id, "render", async () => {
    try {
      const result = await renderVideo({
        videoId: id,
        scenes,
        mode,
        burnSubtitles: subtitles,
        smartCaptions,
        music,
        musicNiche: video.niche,
        musicTrack,
        sceneLimit,
        motion: {
          mode: (video.motionMode ?? "smart") as "smart" | "zoom" | "pan" | "off",
          intensity: video.motionIntensity ?? 12,
          curve: (video.motionCurve ?? "smooth") as "smooth" | "linear",
          vary: video.motionVary ?? true,
        },
        motionContext: { tone: video.tone, niche: video.niche },
        transition,
        onProgress: (current, total, label) => {
          // Cancellation checkpoint: fires between scenes/long steps.
          if (isJobCancelled(id, "render")) throw new JobCancelledError();
          setJobProgress(id, "render", current, total, label);
        },
      });

      if (result.fileName === "final.mp4") {
        // Quality gate — verify the file actually plays, is in sync, on level.
        // Transition-aware: fadeblack dips are designed beats, not defects.
        setJobProgress(id, "render", scenes.length + 1, scenes.length + 1, "Running quality checks");
        const report = await qcForVideo(id, result.durationSec, video.audioDuration, result.blackWindows);
        await db.video.update({
          where: { id },
          data: {
            hasVideo: true,
            videoDuration: Math.round(result.durationSec * 10) / 10,
            qcReport: JSON.stringify(report),
            error: null,
          },
        });
        await db.activity.create({
          data: {
            videoId: id,
            stage: "render",
            level: report.passed ? "info" : "warn",
            message:
              `Video rendered (${mode === "animated" ? "full AI animation" : mode === "stock" ? "stock b-roll" : "Ken Burns"}, ` +
              `${Math.round(result.durationSec)}s) — ` +
              `${music ? (resolved ? `music: ${resolved.why}` : "music: synthesized bed") : "no music"}, ` +
              `${transitionSummary(transition.style, transition.durationSec)}, ` +
              `QC ${report.passed ? "passed" : "flagged " + report.checks.filter((c) => !c.pass).length + " check(s)"}`,
          },
        });
      } else {
        // Preview renders never mark the video as produced (no QC battery).
        await db.video.update({ where: { id }, data: { error: null } });
        await db.activity.create({
          data: {
            videoId: id,
            stage: "render",
            message: `Preview rendered (scene 1, ${mode === "animated" ? "animated" : "Ken Burns"})`,
          },
        });
      }
    } catch (err) {
      if (err instanceof JobCancelledError) {
        // Cancellation is not a failure — keep the previous state, clear error.
        await db.video.update({ where: { id }, data: { error: null } });
        await db.activity.create({
          data: {
            videoId: id,
            stage: "render",
            message: "Render cancelled — completed scenes kept, run render again to restart",
          },
        });
        throw err;
      }
      const message = errorText(err, "Render failed");
      await db.video.update({ where: { id }, data: { error: message } });
      await db.activity.create({
        data: {
          videoId: id,
          stage: "render",
          level: "error",
          message: `Render failed: ${message}`,
        },
      });
      // Re-thrown so startJob records the failure for GET polling + history.
      throw err;
    }
  });

  return NextResponse.json(
    {
      accepted,
      generating: true,
      mode,
      sceneLimit: sceneLimit ?? null,
      transition,
      music: resolved
        ? { track: resolved.track.name, why: resolved.why }
        : music
          ? "synthesized-fallback"
          : false,
    },
    { status: accepted ? 202 : 200 }
  );
}
