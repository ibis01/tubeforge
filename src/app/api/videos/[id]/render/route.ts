import { createHash } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { parseScenes } from "@/lib/tubeforge/story";
import { isJobRunning, lastJobError, jobProgress, startJob } from "@/lib/tubeforge/jobs";
import { assertWithinVideoCeiling, CostCeilingExceededError } from "@/lib/tubeforge/cost-guard";

const digestOf = (input: string) =>
  createHash("sha256").update(input, "utf8").digest("hex").slice(0, 16);
import { runRenderJob, runWhiteboardJob, type RenderJobOptions } from "@/lib/tubeforge/video-jobs";
import { resolveMusicForVideo, isMusicEnabledForVideo, musicBedActive } from "@/lib/tubeforge/music";
import { docMusicPick, resolveDeliveryQuality, resolveBurnSubtitles } from "@/lib/tubeforge/studio-doc";
import { parseTimeline } from "@/lib/tubeforge/timeline";
import { getApprovedAudioMap } from "@/lib/tubeforge/director-plan";
import { sanitizeTransition } from "@/lib/tubeforge/transitions";
import { resolveUserPlan, hasCredits, RENDER_ESTIMATE_MICRO, planSupportsResolution, microToCredits } from "@/lib/tubeforge/billing";
import { parseWhiteboardDoc } from "@/lib/tubeforge/whiteboard/whiteboard-planner";
import { validateWhiteboardProject } from "@/lib/tubeforge/whiteboard/storyboard";
import { loadVideoLibrary } from "@/lib/tubeforge/whiteboard/asset-store";

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

  // S87 slice 3 — the shared status surface sees BOTH lanes: a whiteboard
  // video renders through the "whiteboard" job kind (the engine lane), so
  // the compositor's "render" kind reads empty and the honest answer comes
  // from the lane that is actually running.
  const wb = video.renderMode === "whiteboard";
  const rendering = isJobRunning(id, "render") || (wb && isJobRunning(id, "whiteboard"));
  return NextResponse.json({
    rendering,
    mode: rendering ? video.renderMode : null,
    progress:
      jobProgress(id, "render") ??
      (wb ? jobProgress(id, "whiteboard") : null),
    hasVideo: video.hasVideo,
    videoDuration: video.videoDuration,
    error:
      lastJobError(id, "render") ??
      (wb ? lastJobError(id, "whiteboard") : null) ??
      video.error,
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
  // mixed stub-tone + re-spoken audio in one render). The whiteboard lane
  // reads the SAME WAVs (its VO slots), so the interlock guards both lanes.
  if (isJobRunning(id, "voiceover"))
    return NextResponse.json(
      { error: "The voiceover is still regenerating — wait for it to finish before rendering" },
      { status: 409 }
    );

  // S87 slice 3 — THE SHARED PATH. A whiteboard video renders through its
  // ENGINE lane: peer at the engine level (own planner, own renderer, own
  // Studio), unified at the contract level (the engine emits timeline
  // tracks; its render composes on the shared frame-quantized clock). The
  // story-lane gates below do NOT apply — the whiteboard scaffold needs
  // neither storyboard art nor the hasVoiceover flag (silent drafts are a
  // legal render), and the engine renders natively at $0 (no generation
  // API, so no credit gate). Scene previews stay on the Whiteboard
  // Studio's own route (a full render is what "the render button" means).
  if (video.renderMode === "whiteboard") {
    const doc = parseWhiteboardDoc(video.whiteboardProject);
    if (!doc)
      return NextResponse.json(
        { error: "No whiteboard project yet — scaffold one in the Whiteboard Studio first" },
        { status: 409 }
      );
    // Same gate the lane's own route applies — the validator's verbatim
    // errors on click, not in a failed job card (and the SAME merged
    // library the render will see, per S69).
    const { lib } = await loadVideoLibrary(id);
    const { project, errors } = validateWhiteboardProject(doc.project, lib.libraryIndex);
    if (!project)
      return NextResponse.json(
        { error: "The whiteboard project is invalid — fix it in the Studio first", errors },
        { status: 400 }
      );

    await db.video.update({ where: { id }, data: { error: null } });
    const accepted = await startJob(id, "whiteboard", () => runWhiteboardJob(id, {}));
    return NextResponse.json(
      { accepted, generating: true, mode: "whiteboard", scope: "full" },
      { status: accepted ? 202 : 200 }
    );
  }

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

  // Stage 7 (T-7.5 wiring) — plan gate. Resolution gating by tier + credit
  // check for paid plans (the Starter/free tier never hard-blocks). Runs
  // BEFORE the enqueue so an overdrawn paid account gets a 402 with a
  // readable message instead of a failed job row after the queue claims it.
  // The render pipeline is 1080p in every geometry today (aspect ≠
  // resolution); when 1440p/2160p rendering lands, `requestedResolution`
  // reads from the body and this gate starts differentiating by tier.
  const resolvedPlan = await resolveUserPlan(auth.ctx.userId);
  const requestedResolution = "1080p";
  if (!planSupportsResolution(resolvedPlan.plan, requestedResolution)) {
    return NextResponse.json(
      {
        error: `Your ${resolvedPlan.plan.name} plan renders up to ${resolvedPlan.plan.maxResolution} — upgrade to render ${requestedResolution}`,
        plan: resolvedPlan.plan.tier,
      },
      { status: 402 }
    );
  }
  if (!hasCredits(resolvedPlan, RENDER_ESTIMATE_MICRO)) {
    return NextResponse.json(
      {
        error: "Not enough credits for this render — upgrade your plan or wait for the next monthly grant",
        // creditBalance is microCredits (canonical); display in UI credits.
        creditBalance: microToCredits(resolvedPlan.creditBalance),
        plan: resolvedPlan.plan.tier,
      },
      { status: 402 }
    );
  }

  // S115 — the per-PROJECT ceiling (opt-in, Video.spendCeilingMicro),
  // enforced in the same admission window as the credit hold: the video's
  // recorded spend + this render's estimate must fit, else 402 with the
  // numbers. The org's credit balance gates the USER; this gates the
  // PROJECT ("enforce remaining budget", the operator's requirement D).
  try {
    await assertWithinVideoCeiling(video, RENDER_ESTIMATE_MICRO);
  } catch (err) {
    if (err instanceof CostCeilingExceededError)
      return NextResponse.json(
        {
          error: err.message,
          spentMicroUsd: err.spentMicroUsd,
          ceilingMicroUsd: err.ceilingMicroUsd,
          estimateMicroUsd: err.estimateMicroUsd,
        },
        { status: 402 }
      );
    throw err;
  }

  // Keynote slides: captions duplicate the slide headlines — default OFF.
  const mode = ["animated", "stock", "slides"].includes(body?.mode) ? body.mode : "kenburns";
  // S14 — the delivery: the caption's shipping form resolves through the
  // ONE chain (a per-render body override > the row's standing pick > the
  // format default) so a bare render honors the studio's pick. Before S14
  // the row's burnCaptions was written by the dialog's presets and read by
  // NOBODY — the route fell straight to `mode !== "slides"`.
  const subtitles = resolveBurnSubtitles(body?.subtitles, video.burnCaptions, mode);
  const smartCaptions = body?.smartCaptions !== false; // default: ASR-synced cues (Phase 4)
  const music = body?.music !== false; // default: ambient bed
  const sceneLimitRaw = Number(body?.sceneLimit);
  const sceneLimit =
    Number.isInteger(sceneLimitRaw) && sceneLimitRaw >= 1
      ? Math.min(sceneLimitRaw, scenes.length)
      : undefined;

  // S114 — Scene-Level Editing, Stage 3: render ONE scene as
  // scene-preview-NN.mp4 (the story-lane twin of the whiteboard lane's
  // per-scene preview). Mutually exclusive with sceneLimit — the prefix
  // grammar and the arbitrary-scene grammar are different requests.
  const sceneIndexRaw = Number(body?.sceneIndex);
  const sceneIndex =
    Number.isInteger(sceneIndexRaw) && sceneIndexRaw >= 1 ? sceneIndexRaw : undefined;
  if (sceneIndex != null && sceneLimit != null)
    return NextResponse.json(
      { error: "sceneIndex and sceneLimit are mutually exclusive — preview ONE scene or the first N" },
      { status: 400 }
    );
  if (sceneIndex != null && !scenes.some((s) => s.index === sceneIndex))
    return NextResponse.json({ error: `Scene ${sceneIndex} does not exist` }, { status: 404 });

  // Stage 6 (T-6.8) — per-render aspect + frame-rate overrides (optional).
  // When absent, the job falls back to the per-PROJECT defaults on the video
  // row (video.aspectRatio / video.frameRate); 30 fps + 16:9 otherwise.
  // Slides mode is always 9:16; an explicit 1:1 is honored only for the
  // other modes (the slide deck's PNG is 1080x1920).
  const aspectRatio: "16:9" | "9:16" | "1:1" | undefined =
    body?.aspectRatio === "16:9" || body?.aspectRatio === "9:16" || body?.aspectRatio === "1:1"
      ? body.aspectRatio
      : undefined;
  const frameRate: 24 | 30 | 60 | undefined =
    body?.frameRate === 24 || body?.frameRate === 30 || body?.frameRate === 60
      ? body.frameRate
      : undefined;
  // S3 — the delivery encode tier, resolved through the ONE chain (S14): a
  // per-render body override (the export-preset picker) > the timeline
  // doc's standing renderPrefs.quality pick > standard. Before S14 this
  // route passed the body tier through verbatim and let the JOB resolve
  // the doc fallback one layer down (its own comment promised a chain its
  // code never ran) — now the chain runs here, and the response echoes
  // what the job will honor.
  const quality = resolveDeliveryQuality(body?.quality, parseTimeline(video.timeline)?.renderPrefs ?? null);

  // Stage 6 (T-6.10) — when the user explicitly clicks "render without
  // timeline" (the route body carries `ignoreTimeline: true`), pass an empty
  // array so the job skips timeline consumption. Otherwise the job reads
  // Video.timeline itself. Per-scene durations in the body are NOT honored
  // here — the timeline is the source of truth for trims; the body's role
  // is to disable timeline consumption, not to override it ad hoc.
  const sceneDurationsSec: number[] | undefined = body?.ignoreTimeline === true ? [] : undefined;

  // Durable render options — the job re-derives scenes/motion/transition/
  // brand/music from the video row; the payload preserves the user's picks.
  const renderOpts: RenderJobOptions = {
    mode,
    subtitles,
    smartCaptions,
    music,
    sceneLimit,
    sceneIndex,
    aspectRatio,
    frameRate,
    quality,
    sceneDurationsSec,
  };
  // Response-time music resolution (the job re-resolves for itself) — the
  // SAME flag truth the job applies (musicBedActive): the doc pick re-tops
  // the chain and a disabled bed is silence, so the response never promises
  // a bed — or a drone — the job will not lay.
  const docPick = docMusicPick(parseTimeline(video.timeline)?.renderPrefs ?? null);
  const musicOn = music && musicBedActive(docPick, await isMusicEnabledForVideo(video));
  const planAudio = await getApprovedAudioMap(id);
  const resolved = musicOn ? await resolveMusicForVideo(video, planAudio.musicMood, docPick) : null;

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

  // S115 — the idempotent enqueue: the key is deterministic per (video row
  // state, options) — a retried request or double-click resolves to the
  // standing job (done rows are never re-billed); ANY content change bumps
  // updatedAt and mints a fresh key, so a re-render after an edit is never
  // blocked. The unique index is the race floor.
  const renderIdempotencyKey = `render:${id}:${video.updatedAt.getTime()}:${digestOf(
    JSON.stringify(renderOpts)
  )}`;
  const accepted = await startJob(
    id,
    "render",
    () => runRenderJob(id, renderOpts),
    { payload: renderOpts, idempotencyKey: renderIdempotencyKey }
  );

  return NextResponse.json(
    {
      accepted,
      generating: true,
      mode,
      sceneIndex: sceneIndex ?? null,
      sceneLimit: sceneLimit ?? null,
      transition,
      music: resolved
        ? { track: resolved.track.name, why: resolved.why }
        : musicOn
          ? "synthesized-fallback"
          : false,
      // S14 — the resolved delivery, echoed so the response never promises
      // a grade or a caption form the job will not honor (the S7 doctrine,
      // now covering the whole export contract).
      quality,
      subtitles,
    },
    { status: accepted ? 202 : 200 }
  );
}
