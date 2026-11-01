import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { parseScenes } from "@/lib/tubeforge/story";
import { isJobRunning, lastJobError, jobProgress, startJob } from "@/lib/tubeforge/jobs";
import { runRenderJob, type RenderJobOptions } from "@/lib/tubeforge/video-jobs";
import { resolveMusicForVideo } from "@/lib/tubeforge/music";
import { sanitizeTransition } from "@/lib/tubeforge/transitions";

type Ctx = { params: Promise<{ id: string }> };

/** GET — render job status (drives the client progress bar). */
export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

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
 * The job body is runRenderJob (video-jobs.ts) — the SAME function the durable
 * queue's crash-recovery handler runs, with the request options persisted on
 * the Job row so a restart re-renders what the user asked for.
 *
 * Music resolution: video-level pin → Settings manual pick → auto mood-match
 * by niche (music.ts); falls back to the inline synthesized drone when the
 * library has no active track. Full renders finish with the QC battery
 * (qc.ts) recorded on the video row.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

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

  const body = await req.json().catch(() => ({}));

  // Keynote slides design their own deck — storyboard art is optional there.
  if (!video.hasStoryboard && body?.mode !== "slides")
    return NextResponse.json(
      { error: "Generate the storyboard first — there is no scene art yet" },
      { status: 400 }
    );
  if (!video.hasVoiceover)
    return NextResponse.json(
      { error: "Generate the voiceover first — narration drives the scene timing" },
      { status: 400 }
    );

  // Keynote slides: captions duplicate the slide headlines — default OFF.
  const mode = ["animated", "stock", "slides"].includes(body?.mode) ? body.mode : "kenburns";
  const subtitles = body?.subtitles ?? mode !== "slides"; // slides default: no burned captions
  const smartCaptions = body?.smartCaptions !== false; // default: ASR-synced cues (Phase 4)
  const music = body?.music !== false; // default: ambient bed
  const sceneLimitRaw = Number(body?.sceneLimit);
  const sceneLimit =
    Number.isInteger(sceneLimitRaw) && sceneLimitRaw >= 1
      ? Math.min(sceneLimitRaw, scenes.length)
      : undefined;

  // Durable render options — the job re-derives scenes/motion/transition/
  // brand/music from the video row; the payload preserves the user's picks.
  const renderOpts: RenderJobOptions = {
    mode,
    subtitles,
    smartCaptions,
    music,
    sceneLimit,
  };

  // Response-time music resolution (the job re-resolves for itself).
  const resolved = music ? await resolveMusicForVideo(video) : null;

  // Scene transitions: per-video override (null = built-in crossfade 0.5s).
  // Slides beats read like slide changes — hard cuts are the format's native
  // grammar, so an unset transition defaults to "cut" for this mode.
  const transition = sanitizeTransition(
    mode === "slides" && video.transitionStyle === null
      ? { style: "cut", durationSec: video.transitionDuration }
      : {
          style: video.transitionStyle,
          durationSec: video.transitionDuration,
        }
  );

  // Clear any stale error before the job starts.
  await db.video.update({ where: { id }, data: { error: null } });

  const accepted = await startJob(
    id,
    "render",
    () => runRenderJob(id, renderOpts),
    { payload: renderOpts }
  );

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
