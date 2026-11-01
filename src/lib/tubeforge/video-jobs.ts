// Video-stage background job bodies (Stage 3 close-out).
//
// Every function here is the SINGLE implementation of one job kind, called
// from BOTH execution paths:
//   * the route's enqueue closure (the in-process fast path), and
//   * the durable queue's crash-recovery handler (queue-handlers.ts), which
//     re-runs the job after a process death from DB state + Job.payload.
//
// That is the whole point of this module: before it, each route carried its
// own closure capturing request-scoped choices, so a restart marked the job
// "interrupted" and the user re-kicked the stage. Now the choices either live
// on the video row (re-derived below) or in the small JSON payload the route
// stores at enqueue time — and a crash resumes with the SAME choices.
//
// Contract (same as script-job.ts / runStockRefresh):
//   * the function runs under a tenant context (assertCtx) — inherited from
//     the launching request (closure) or restored from the Job row (handler);
//   * a deleted/transformed video ends the job QUIETLY (no error surfaces);
//   * a vanished prerequisite (storyboard, script, …) throws a readable
//     error so the failure lands on the video row where the UI polls it.

import fs from "fs";
import path from "path";
import { db } from "./tenant-db";
import { assertCtx } from "./tenant";
import { errorText } from "@/lib/tubeforge/redact";
import { runDirectorPass, runContinuityCheck } from "./director";
import {
  generateVoiceover,
  generateThumbnail,
  deriveThumbnailConcept,
  readMedia,
  videoDir,
} from "./ai";
import {
  generateSceneVoiceovers,
  generateStoryboard,
  generateSceneImage,
  editSceneImage,
  storyboardComplete,
  parseScenes,
} from "./story";
import type { Scene } from "./types";
import { ingestCustomAudio } from "./voice";
import { deriveStatus } from "./status";
import { runQualityGate } from "./quality";
import { renderVideo, invalidateRenderedArtifacts } from "./render";
import { renderShort } from "./shorts";
import { convertClassicToScenes } from "./convert";
import { verifyNarration } from "./verify";
import { generateEngagementKit } from "./comments";
import {
  resolveMusicForVideo,
  resolveDuckingForVideo,
  getSfxEnabled,
  trackAbsolutePath,
} from "./music";
import { qcForVideo } from "./qc";
import { parsePlan } from "./director-plan";
import { sanitizeTransition, transitionSummary } from "./transitions";
import {
  loadSlideDeck,
  planSlides,
  rerollSlideSpec,
  saveSlideSpecAt,
  renderSlidePngs,
  slideBrandFor,
} from "./slides";
import { get, remove, materialize } from "./storage";
import { promoteVariant, pickVariantStyles } from "./ai";
import {
  JobCancelledError,
  isJobCancelled,
  setJobProgress,
} from "./jobs";

/** Character inputs for scene art — derived from video.characterId. */
async function castOptsFor(video: {
  characterId: string | null;
}): Promise<
  | { id: string; name: string; identityAnchor: string | null; appearance: string | null }
  | null
> {
  const character = video.characterId
    ? await db.character.findUnique({ where: { id: video.characterId } })
    : null;
  return character
    ? {
        id: character.id,
        name: character.name,
        identityAnchor: character.identityAnchor,
        appearance: character.appearance,
      }
    : null;
}

// ---------------------------------------------------------------------------
// voiceover

/** Durable voiceover source spec (JSON-payload safe). */
export type VoiceoverJobSource =
  | { kind: "url"; url: string; label?: string }
  | { kind: "upload"; storageKey: string; label: string };

/**
 * (Re)generate the voiceover. source=null → built-in TTS (scene videos get
 * per-scene TTS). Custom sources: "url" re-downloads; "upload" reads back the
 * bytes the route staged into object storage BEFORE enqueueing (a raw request
 * buffer cannot survive a restart — the storage key can).
 */
export async function runVoiceoverJob(
  videoId: string,
  opts: { source?: VoiceoverJobSource | null } = {}
): Promise<void> {
  const ctx = assertCtx("runVoiceoverJob");
  const video = await db.video.findUnique({ where: { id: videoId } });
  if (!video) return; // deleted while queued — end quietly

  const scenes = video.format === "story" ? parseScenes(video.scenes) : [];
  const source = opts.source ?? null;

  try {
    let durationSec: number;
    let voiceSource = "tts";
    let voiceLabel: string | null = null;
    let activityMsg: string;

    if (source) {
      // ----- Bring-your-own-voice: normalize + (scene videos) cut -----
      let buffer: Buffer | null = null;
      if (source.kind === "upload") {
        buffer = await get(source.storageKey).catch(() => null);
        if (!buffer)
          throw new Error(
            "The uploaded audio is no longer available — attach the file again"
          );
      }

      const result = await ingestCustomAudio({
        videoId,
        source:
          source.kind === "upload"
            ? { kind: "upload", buffer: buffer as Buffer, filename: source.label }
            : { kind: "url", url: source.url },
        onProgress: (label) => setJobProgress(videoId, "voiceover", 1, 2, label),
      });
      // The staged copy has served its purpose — drop it (best-effort).
      if (source.kind === "upload") await remove(source.storageKey).catch(() => {});

      durationSec = result.durationSec;
      voiceSource = "custom";
      voiceLabel =
        source.kind === "upload" ? source.label : (source.label ?? result.sourceLabel);
      activityMsg = `Custom voice attached from ${source.kind === "upload" ? "upload" : "web link"} — “${voiceLabel}”, ${Math.round(durationSec)}s${
        result.scenesCut !== null ? `, cut across ${result.scenesCut} scenes` : ""
      }`;
    } else if (video.format === "story" && scenes.length > 0) {
      // Per-scene narration → scene-XX.wav + merged voiceover.wav
      const result = await generateSceneVoiceovers({
        videoId,
        scenes,
        voice: video.voice,
        speed: video.ttsSpeed,
      });
      durationSec = result.durationSec;
      activityMsg = `Scene-by-scene voiceover rendered (${video.voice}, ${video.ttsSpeed}x) — ${Math.round(durationSec)}s across ${scenes.length} scenes`;
    } else if (video.format === "story") {
      throw new Error("Scene video has no scenes — regenerate the scene script");
    } else {
      if (!video.script)
        throw new Error("Video has no script yet — generate the script first");
      const result = await generateVoiceover({
        script: video.script,
        voice: video.voice,
        speed: video.ttsSpeed,
        videoId,
      });
      durationSec = result.durationSec;
      activityMsg = `Voiceover rendered (${video.voice}, ${video.ttsSpeed}x) — ${Math.round(durationSec)}s of audio`;
    }

    if (video.format === "story") {
      // Old renders no longer match the new narration timing.
      // Stage 4a (T-4.0): driver-correct removal (s3-safe, quota-decrementing)
      // + local scratch cleanup for the copies the render pipeline retains.
      for (const f of [
        "final.mp4",
        "preview.mp4",
        "subtitles.srt",
        "short.mp4",
        "short-thumb.png",
      ]) {
        await remove(`${videoId}/${f}`).catch(() => {});
        fs.rmSync(path.join(videoDir(videoId), f), { force: true });
      }
    }

    const fresh = await db.video.findUnique({ where: { id: videoId } });
    const nextStatus = deriveStatus(video, {
      hasVoiceover: true,
      hasThumbnail: fresh?.hasThumbnail ?? video.hasThumbnail,
    });

    await db.video.update({
      where: { id: videoId },
      data: {
        hasVoiceover: true,
        audioDuration: Math.round(durationSec * 10) / 10,
        voiceSource,
        voiceLabel,
        hasVideo: video.format === "story" ? false : video.hasVideo,
        hasShort: video.format === "story" ? false : video.hasShort,
        shortDuration: video.format === "story" ? null : video.shortDuration,
        shortScene: video.format === "story" ? null : video.shortScene,
        status: nextStatus,
        error: null,
      },
    });

    await db.activity.create({
      data: {
        organizationId: video.organizationId,
        userId: ctx.userId,
        videoId,
        stage: "voiceover",
        message: activityMsg,
      },
    });
  } catch (err) {
    const message = errorText(err, "Voiceover failed");
    await db.video.update({
      where: { id: videoId },
      data: { status: "failed", error: message },
    });
    await db.activity.create({
      data: {
        organizationId: video.organizationId,
        userId: ctx.userId,
        videoId,
        stage: "voiceover",
        level: "error",
        message: `Voiceover failed: ${message}`,
      },
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// storyboard (full + single scene)

/** Paint every scene still missing art (resumes: existing images are kept). */
export async function runStoryboardJob(videoId: string): Promise<void> {
  const ctx = assertCtx("runStoryboardJob");
  const video = await db.video.findUnique({ where: { id: videoId } });
  if (!video) return;
  if (video.format !== "story") return; // format changed while queued

  const scenes = parseScenes(video.scenes);
  if (scenes.length === 0) return; // re-scripted to nothing — nothing to paint

  const castOpts = await castOptsFor(video);

  try {
    await generateStoryboard({
      videoId,
      scenes,
      character: castOpts,
      shouldCancel: () => isJobCancelled(videoId, "storyboard"),
      onSceneDone: (i, total) =>
        setJobProgress(videoId, "storyboard", i + 1, total, `Painting scene ${i + 1} of ${total}`),
    });

    await invalidateRenderedArtifacts(videoId, { slidePngs: true });
    await db.video.update({
      where: { id: videoId },
      data: {
        hasStoryboard: true,
        hasVideo: false,
        videoDuration: null,
        error: null,
      },
    });
    await db.activity.create({
      data: {
        organizationId: video.organizationId,
        userId: ctx.userId,
        videoId,
        stage: "storyboard",
        message: `Storyboard painted — ${scenes.length} scenes${castOpts ? ` (host: ${castOpts.name})` : ""}`,
      },
    });
  } catch (err) {
    if (err instanceof Error && err.message === "__CANCELLED__") {
      await db.video.update({
        where: { id: videoId },
        data: {
          hasStoryboard: await storyboardComplete(videoId, scenes),
          error: null,
        },
      });
      await db.activity.create({
        data: {
          organizationId: video.organizationId,
          userId: ctx.userId,
          videoId,
          stage: "storyboard",
          message: `Storyboard cancelled — finished scenes were kept`,
        },
      });
      throw new JobCancelledError();
    }
    const message = errorText(err, "Storyboard failed");
    await db.video.update({
      where: { id: videoId },
      data: {
        hasStoryboard: await storyboardComplete(videoId, scenes),
        error: message,
      },
    });
    await db.activity.create({
      data: {
        organizationId: video.organizationId,
        userId: ctx.userId,
        videoId,
        stage: "storyboard",
        level: "error",
        message: `Storyboard failed: ${message}`,
      },
    });
    throw err;
  }
}

/**
 * Re-roll (or AI-edit) ONE scene image. entityId is "<videoId>#scene<N>";
 * payload carries the instruction (edit mode) — omitted means re-roll.
 * A re-roll resumed after a crash bumps the seed variant again, i.e. it
 * paints a fresh take — never the stale pixels the crash interrupted.
 */
export async function runSceneJob(
  entityId: string,
  opts: { sceneIndex?: number; instruction?: string } = {}
): Promise<void> {
  const ctx = assertCtx("runSceneJob");
  // entityId is the durable encoding — parse it when explicit opts are absent.
  const [videoId, suffix] = splitEntityId(entityId, "#scene");
  const sceneIndex = Number.isInteger(opts.sceneIndex)
    ? (opts.sceneIndex as number)
    : suffix !== null
      ? Number(suffix)
      : NaN;
  if (!Number.isInteger(sceneIndex) || sceneIndex < 1)
    throw new Error("Scene job has no valid scene index");

  const video = await db.video.findUnique({ where: { id: videoId } });
  if (!video) return;
  if (video.format !== "story") return;

  const scenes: Scene[] = parseScenes(video.scenes);
  const scene = scenes.find((s) => s.index === sceneIndex);
  if (!scene) return; // scene vanished (re-scripted) — end quietly

  const instruction =
    typeof opts.instruction === "string" ? opts.instruction.trim() : "";
  const mode = instruction ? "edit" : "reroll";

  try {
    if (mode === "edit") {
      await editSceneImage({ videoId, scene, instruction });
    } else {
      // Re-roll = a NEW take: bump the scene's generation counter BEFORE
      // painting so the pinned seed (identity locking on text-to-image
      // providers) yields a fresh image instead of the same pixels, then
      // persist the bump — a later resume must not reuse the old take.
      scene.seedVariant = Math.min((scene.seedVariant ?? 0) + 1, 999);
      await db.video.update({
        where: { id: videoId },
        data: { scenes: JSON.stringify(scenes) },
      });
      await generateSceneImage({ videoId, scene, character: await castOptsFor(video) });
    }
    await invalidateRenderedArtifacts(videoId, { slidePngs: true });
    await db.video.update({
      where: { id: videoId },
      data: {
        hasStoryboard: await storyboardComplete(videoId, scenes),
        hasVideo: false,
        videoDuration: null,
        error: null,
      },
    });
    await db.activity.create({
      data: {
        organizationId: video.organizationId,
        userId: ctx.userId,
        videoId,
        stage: "storyboard",
        message:
          mode === "edit"
            ? `Scene ${sceneIndex} "${scene.title}" AI-edited: ${instruction.slice(0, 80)}`
            : `Scene ${sceneIndex} "${scene.title}" re-rolled`,
      },
    });
  } catch (err) {
    const message = errorText(err, "Scene edit failed");
    await db.video.update({ where: { id: videoId }, data: { error: message } });
    await db.activity.create({
      data: {
        organizationId: video.organizationId,
        userId: ctx.userId,
        videoId,
        stage: "storyboard",
        level: "error",
        message: `Scene ${sceneIndex} ${mode === "edit" ? "edit" : "re-roll"} failed: ${message}`,
      },
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// render

export interface RenderJobOptions {
  mode?: "kenburns" | "animated" | "stock" | "slides";
  subtitles?: boolean;
  smartCaptions?: boolean;
  music?: boolean;
  sceneLimit?: number;
}

/** Render the final/preview MP4 (+ QC battery on full renders). */
export async function runRenderJob(
  videoId: string,
  opts: RenderJobOptions = {}
): Promise<void> {
  const ctx = assertCtx("runRenderJob");
  const video = await db.video.findUnique({ where: { id: videoId } });
  if (!video) return;
  if (video.format !== "story") return;

  const scenes = parseScenes(video.scenes);
  if (scenes.length === 0)
    throw new Error("Video has no scenes — generate the scene script first");

  // Same defaults the route applies to a missing body field, so a payload-less
  // crash resume renders what the user saw on the button they clicked.
  const mode = ["animated", "stock", "slides"].includes(opts.mode ?? "")
    ? (opts.mode as "animated" | "stock" | "slides")
    : "kenburns";
  const subtitles = opts.subtitles ?? mode !== "slides"; // slides default: no burned captions
  const smartCaptions = opts.smartCaptions !== false; // default: ASR-synced cues
  const music = opts.music !== false; // default: ambient bed
  const sceneLimit =
    Number.isInteger(opts.sceneLimit) && (opts.sceneLimit as number) >= 1
      ? Math.min(opts.sceneLimit as number, scenes.length)
      : undefined;

  if (!video.hasStoryboard && mode !== "slides")
    throw new Error("Generate the storyboard first — there is no scene art yet");
  if (!video.hasVoiceover)
    throw new Error("Generate the voiceover first — narration drives the scene timing");

  // Resolve the library track (null → synthesized drone fallback in render.ts).
  const resolved = music ? await resolveMusicForVideo(video) : null;
  const duckFallback = music ? await resolveDuckingForVideo(video) : "standard";
  const sfx = await getSfxEnabled();
  const musicTrack = resolved
    ? {
        filePath: trackAbsolutePath(resolved.track),
        gain: resolved.gain,
        fadeInSec: resolved.fadeInSec,
        fadeOutSec: resolved.fadeOutSec,
        duckIntensity: resolved.duckIntensity,
      }
    : null;

  // Scene transitions: per-video override (null = built-in crossfade 0.5s).
  const transition = sanitizeTransition(
    mode === "slides" && video.transitionStyle === null
      ? { style: "cut", durationSec: video.transitionDuration }
      : { style: video.transitionStyle, durationSec: video.transitionDuration }
  );

  // Brand kit (keynote slides): accent recolor + corner logo badge.
  const brand = mode === "slides" ? await slideBrandFor(videoId, video.brandAccent, video.brandLogoOn) : null;

  try {
    const result = await renderVideo({
      videoId,
      scenes,
      mode,
      burnSubtitles: subtitles,
      smartCaptions,
      music,
      musicNiche: video.niche,
      musicTrack,
      musicDuck: duckFallback,
      sfx,
      sceneLimit,
      motion: {
        mode: (video.motionMode ?? "smart") as "smart" | "zoom" | "pan" | "off",
        intensity: video.motionIntensity ?? 12,
        curve: (video.motionCurve ?? "smooth") as "smooth" | "linear",
        vary: video.motionVary ?? true,
      },
      motionContext: { tone: video.tone, niche: video.niche },
      topic: video.topic,
      transition,
      brand,
      onProgress: (current, total, label) => {
        if (isJobCancelled(videoId, "render")) throw new JobCancelledError();
        setJobProgress(videoId, "render", current, total, label);
      },
    });

    if (result.fileName === "final.mp4") {
      setJobProgress(videoId, "render", scenes.length + 1, scenes.length + 1, "Running quality checks");
      // Stage 5 pacing gate: only an APPROVED plan shaped this render, so only
      // an approved plan may be judged by it. Render-mode blanket exemptions:
      // "animated" (i2v) and "stock" move every scene whatever the plan says.
      const approvedPlan =
        video.directorState === "approved" ? parsePlan(video.shotList) : null;
      const report = await qcForVideo(
        videoId,
        result.durationSec,
        video.audioDuration,
        result.blackWindows,
        result.aspect,
        approvedPlan,
        {
          i2vEverywhere: mode === "animated",
          stockEverywhere: mode === "stock",
        }
      );
      await db.video.update({
        where: { id: videoId },
        data: {
          hasVideo: true,
          videoDuration: Math.round(result.durationSec * 10) / 10,
          qcReport: JSON.stringify(report),
          error: null,
        },
      });
      await db.activity.create({
        data: {
          organizationId: video.organizationId,
          userId: ctx.userId,
          videoId,
          stage: "render",
          level: report.passed ? "info" : "warn",
          message:
            `Video rendered (${mode === "animated" ? "full AI animation" : mode === "stock" ? "stock b-roll" : mode === "slides" ? "keynote slides" : "Ken Burns"}, ` +
            `${Math.round(result.durationSec)}s) — ` +
            `${music ? (resolved ? `music: ${resolved.why}` : "music: synthesized bed") : "no music"}, ` +
            `${music && resolved ? `ducking ${resolved.duckIntensity}, ` : ""}` +
            `${transitionSummary(transition.style, transition.durationSec)}, ` +
            `QC ${report.passed ? "passed" : "flagged " + report.checks.filter((c) => !c.pass).length + " check(s)"}`,
        },
      });
    } else {
      await db.video.update({ where: { id: videoId }, data: { hasPreview: true, error: null } });
      await db.activity.create({
        data: {
          organizationId: video.organizationId,
          userId: ctx.userId,
          videoId,
          stage: "render",
          message: `Preview rendered (scene 1, ${mode === "animated" ? "animated" : "Ken Burns"})`,
        },
      });
    }
  } catch (err) {
    if (err instanceof JobCancelledError) {
      await db.video.update({ where: { id: videoId }, data: { error: null } });
      await db.activity.create({
        data: {
          organizationId: video.organizationId,
          userId: ctx.userId,
          videoId,
          stage: "render",
          message: "Render cancelled — completed scenes kept, run render again to restart",
        },
      });
      throw err;
    }
    const message = errorText(err, "Render failed");
    await db.video.update({ where: { id: videoId }, data: { error: message } });
    await db.activity.create({
      data: {
        organizationId: video.organizationId,
        userId: ctx.userId,
        videoId,
        stage: "render",
        level: "error",
        message: `Render failed: ${message}`,
      },
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// short / convert / verify / comments

/** Cut the 9:16 vertical Short. sceneIndex omitted/null → auto-pick. */
export async function runShortJob(
  videoId: string,
  opts: { sceneIndex?: number | null } = {}
): Promise<void> {
  const ctx = assertCtx("runShortJob");
  const video = await db.video.findUnique({ where: { id: videoId } });
  if (!video) return;
  if (video.format !== "story") return;

  const scenes = parseScenes(video.scenes);
  if (scenes.length === 0) throw new Error("This video has no scenes");

  // Storage seam (T-3.7): ffmpeg needs the master on local disk.
  const finalPath = await materialize(`${videoId}/final.mp4`);
  if (!fs.existsSync(finalPath))
    throw new Error("Render the final video first — Shorts are cut from the rendered master");

  const sceneIndex =
    Number.isInteger(opts.sceneIndex) && (opts.sceneIndex as number) >= 1
      ? (opts.sceneIndex as number)
      : null;

  try {
    const result = await renderShort({
      videoId,
      scenes,
      sceneIndex,
      motion: {
        mode: (video.motionMode ?? "smart") as "smart" | "zoom" | "pan" | "off",
        intensity: video.motionIntensity ?? 12,
        curve: (video.motionCurve ?? "smooth") as "smooth" | "linear",
        vary: video.motionVary ?? true,
      },
      transition: { style: video.transitionStyle, durationSec: video.transitionDuration },
      onProgress: (label) => setJobProgress(videoId, "short", 1, 2, label),
    });

    await db.video.update({
      where: { id: videoId },
      data: {
        hasShort: true,
        shortScene: result.sceneIndex,
        shortDuration: result.durationSec,
        error: null,
      },
    });

    await db.activity.create({
      data: {
        organizationId: video.organizationId,
        userId: ctx.userId,
        videoId,
        stage: "short",
        message: `Vertical Short cut from scene ${result.sceneIndex}${result.autoPicked ? " (auto-picked)" : ""} — ${result.durationSec.toFixed(1)}s 9:16`,
      },
    });
  } catch (err) {
    const message = errorText(err, "Short render failed");
    await db.video.update({ where: { id: videoId }, data: { error: message } });
    await db.activity.create({
      data: {
        organizationId: video.organizationId,
        userId: ctx.userId,
        videoId,
        stage: "short",
        level: "error",
        message: `Short render failed: ${message}`,
      },
    });
    throw err;
  }
}

/** Upgrade a narration-script video to a scene-based story video. */
export async function runConvertJob(videoId: string): Promise<void> {
  const ctx = assertCtx("runConvertJob");
  const video = await db.video.findUnique({ where: { id: videoId } });
  if (!video) return;
  if (video.format === "story") return; // already converted while queued
  if (!video.script || video.script.trim().length < 80)
    throw new Error("Generate the script first — there is nothing to split into scenes");

  try {
    await convertClassicToScenes({ videoId });
  } catch (err) {
    const message = errorText(err, "Conversion failed");
    await db.video.update({ where: { id: videoId }, data: { error: message } });
    await db.activity.create({
      data: {
        organizationId: video.organizationId,
        userId: ctx.userId,
        videoId,
        stage: "convert",
        level: "error",
        message: `Scene conversion failed: ${message}`,
      },
    });
    throw err;
  }
}

/** ASR-verify the narration against the script. */
export async function runVerifyJob(videoId: string): Promise<void> {
  const ctx = assertCtx("runVerifyJob");
  const video = await db.video.findUnique({ where: { id: videoId } });
  if (!video) return;

  try {
    await verifyNarration(videoId);
  } catch (err) {
    const message = errorText(err, "Narration check failed");
    await db.video.update({ where: { id: videoId }, data: { error: message } });
    await db.activity.create({
      data: {
        organizationId: video.organizationId,
        userId: ctx.userId,
        videoId,
        stage: "verify",
        level: "error",
        message: `Narration check failed: ${message}`,
      },
    });
    throw err;
  }
}

/** Generate the launch-day engagement kit. */
export async function runCommentsJob(videoId: string): Promise<void> {
  const ctx = assertCtx("runCommentsJob");
  const video = await db.video.findUnique({
    where: { id: videoId },
    include: {
      channel: { select: { name: true } },
      character: { select: { name: true } },
    },
  });
  if (!video) return;
  if (!video.script)
    throw new Error("Write the script first — the kit references the video's content");

  try {
    await generateEngagementKit({
      videoId,
      title: video.title ?? video.topic,
      topic: video.topic,
      niche: video.niche,
      tone: video.tone,
      scriptExcerpt: (video.script ?? "").slice(0, 1200),
      channelName: video.channel?.name ?? null,
      characterName: video.character?.name ?? null,
    });
  } catch (err) {
    const message = errorText(err, "Engagement kit failed");
    await db.video.update({ where: { id: videoId }, data: { error: message } });
    await db.activity.create({
      data: {
        organizationId: video.organizationId,
        userId: ctx.userId,
        videoId,
        stage: "comments",
        level: "error",
        message: `Engagement kit failed: ${message}`,
      },
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Stage 5 — AI Director

/** LLM shot-list pass → Video.shotList with directorState "proposed".
 *  The route closure AND the durable-queue handler both call this. */
export async function runDirectorJob(videoId: string): Promise<void> {
  const ctx = assertCtx("runDirectorJob");
  const video = await db.video.findUnique({ where: { id: videoId } });
  if (!video) return;
  try {
    await runDirectorPass(videoId);
  } catch (err) {
    const message = errorText(err, "AI Director pass failed");
    await db.video.update({
      where: { id: videoId },
      data: { error: message, directorState: null },
    });
    await db.activity.create({
      data: {
        organizationId: video.organizationId,
        userId: ctx.userId,
        videoId,
        stage: "director",
        level: "error",
        message: `AI Director pass failed: ${message}`,
      },
    });
    throw err;
  }
}

/** VLM per-scene continuity check → Video.consistency report. */
export async function runContinuityJob(videoId: string): Promise<void> {
  const ctx = assertCtx("runContinuityJob");
  const video = await db.video.findUnique({ where: { id: videoId } });
  if (!video) return;
  try {
    await runContinuityCheck(videoId);
  } catch (err) {
    const message = errorText(err, "Continuity check failed");
    await db.video.update({ where: { id: videoId }, data: { error: message } });
    await db.activity.create({
      data: {
        organizationId: video.organizationId,
        userId: ctx.userId,
        videoId,
        stage: "continuity",
        level: "error",
        message: `Continuity check failed: ${message}`,
      },
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// thumbnail + variants

/** Concept for the cover art, derived from the CONTENT (scene 1 / script). */
export async function thumbnailConceptFor(video: {
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

/** Generate the primary thumbnail (script-matched concept + VLM gate). */
export async function runThumbnailJob(videoId: string): Promise<void> {
  const ctx = assertCtx("runThumbnailJob");
  const video = await db.video.findUnique({
    where: { id: videoId },
    include: {
      character: {
        select: { id: true, name: true, identityAnchor: true, appearance: true, hasPortrait: true },
      },
    },
  });
  if (!video) return;
  if (!video.title)
    throw new Error("Video has no title yet — generate the script first");
  const title = video.title;

  try {
    const concept = await thumbnailConceptFor(video);

    await runQualityGate({
      kind: "thumbnail",
      videoId,
      imagePath: path.join(videoDir(videoId), "thumbnail.png"),
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

    const fresh = await db.video.findUnique({ where: { id: videoId } });
    const nextStatus = deriveStatus(video, {
      hasThumbnail: true,
      hasVoiceover: fresh?.hasVoiceover ?? video.hasVoiceover,
    });

    await db.video.update({
      where: { id: videoId },
      data: { hasThumbnail: true, status: nextStatus, error: null },
    });

    await db.activity.create({
      data: {
        organizationId: video.organizationId,
        userId: ctx.userId,
        videoId,
        stage: "thumbnail",
        message: `Thumbnail generated from the script content (${video.thumbStyle} style)${
          video.character ? ` featuring ${video.character.name}` : ""
        } for "${video.title}"`,
      },
    });
  } catch (err) {
    const message = errorText(err, "Thumbnail failed");
    await db.video.update({
      where: { id: videoId },
      data: { status: "failed", error: message },
    });
    await db.activity.create({
      data: {
        organizationId: video.organizationId,
        userId: ctx.userId,
        videoId,
        stage: "thumbnail",
        level: "error",
        message: `Thumbnail failed: ${message}`,
      },
    });
    throw err;
  }
}

/** Generate the A/B thumbnail set (same concept, three styles). */
export async function runVariantsJob(videoId: string): Promise<void> {
  const ctx = assertCtx("runVariantsJob");
  const video = await db.video.findUnique({ where: { id: videoId } });
  if (!video) return;
  if (!video.title)
    throw new Error("Video has no title yet — generate the script first");
  const title = video.title;

  try {
    const styles = pickVariantStyles(video.thumbStyle, 3);

    // One concept per set — every variant paints the SAME story moment in a
    // different style, so A/B testing compares style, not subject.
    const firstScene = video.format === "story" ? parseScenes(video.scenes)[0] : null;
    const concept = firstScene
      ? `${firstScene.visual}. Mood: ${firstScene.mood || "cinematic"}`
      : await deriveThumbnailConcept({ topic: video.topic, script: video.script });

    for (const style of styles) {
      await generateThumbnail({
        title,
        topic: video.topic,
        style,
        videoId: video.id,
        variant: true,
        concept,
      });
      // Ensure a primary thumbnail exists — promote the first variant
      if (!(await readMedia(video.id, "thumbnail.png"))) {
        await promoteVariant(video.id, style);
      }
    }

    const nextStatus = deriveStatus(video, { hasThumbnail: true });
    await db.video.update({
      where: { id: videoId },
      data: { hasThumbnail: true, status: nextStatus, error: null },
    });

    await db.activity.create({
      data: {
        organizationId: video.organizationId,
        userId: ctx.userId,
        videoId,
        stage: "thumbnail",
        message: `A/B thumbnail set generated for "${video.title}" (${styles.length} styles)`,
      },
    });
  } catch (err) {
    const message = errorText(err, "Variant generation failed");
    await db.activity.create({
      data: {
        organizationId: video.organizationId,
        userId: ctx.userId,
        videoId,
        stage: "thumbnail",
        level: "error",
        message: `A/B thumbnail set failed: ${message}`,
      },
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// keynote slides (single-slide re-roll)

/**
 * Re-design ONE keynote slide. entityId is "<videoId>#slide<N>" — the durable
 * encoding the route already uses, so the payload needs nothing.
 */
export async function runSlideJob(entityId: string): Promise<void> {
  const ctx = assertCtx("runSlideJob");
  const [videoId, suffix] = splitEntityId(entityId, "#slide");
  const sceneIndex = suffix !== null ? Number(suffix) : NaN;
  if (!Number.isInteger(sceneIndex) || sceneIndex < 1)
    throw new Error("Slide job has no valid scene index");

  const video = await db.video.findUnique({ where: { id: videoId } });
  if (!video) return;
  if (video.format !== "story") return;

  const scenes = parseScenes(video.scenes);
  if (scenes.length === 0) return;
  const scene = scenes.find((s) => s.index === sceneIndex);
  if (!scene) return;
  const position = scenes.findIndex((s) => s.index === sceneIndex);

  try {
    // 1) Ensure a deck exists — a video can be re-rolled before its first
    //    slides render (the deck would otherwise only appear at render time).
    let deck = loadSlideDeck(videoId);
    if (!deck || deck.length < scenes.length) {
      const planned = await planSlides(videoId, scenes, {
        topic: video.topic,
        niche: video.niche,
        tone: video.tone,
      });
      deck = planned.specs;
    }
    const previous = deck[position] ?? null;

    // 2) Fresh design for exactly this slide.
    const hasArt = fs.existsSync(
      path.join(videoDir(videoId), `scene-${String(sceneIndex).padStart(2, "0")}.png`)
    );
    const { spec, source } = await rerollSlideSpec(
      scene,
      { topic: video.topic, niche: video.niche, tone: video.tone },
      previous,
      { hasImage: hasArt }
    );
    saveSlideSpecAt(videoId, position, spec);

    // 3) Re-screenshot just this slide with the brand kit applied.
    const brand = await slideBrandFor(videoId, video.brandAccent, video.brandLogoOn);
    await renderSlidePngs(videoId, [{ scene, spec }], { force: true, brand });

    // 4) The rendered video embeds the old slide — it is stale now.
    await invalidateRenderedArtifacts(videoId);
    await db.video.update({
      where: { id: videoId },
      data: { hasVideo: false, videoDuration: null, error: null },
    });
    await db.activity.create({
      data: {
        organizationId: video.organizationId,
        userId: ctx.userId,
        videoId,
        stage: "storyboard",
        message: `Slide ${sceneIndex} re-designed (${source === "llm" ? "fresh AI take" : "deterministic fallback"}): "${spec.headline.slice(0, 60)}"`,
      },
    });
  } catch (err) {
    const message = errorText(err, "Slide redesign failed");
    await db.video.update({ where: { id: videoId }, data: { error: message } });
    await db.activity.create({
      data: {
        organizationId: video.organizationId,
        userId: ctx.userId,
        videoId,
        stage: "storyboard",
        level: "error",
        message: `Slide ${sceneIndex} redesign failed: ${message}`,
      },
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// helpers

/**
 * Split "<videoId>#scene<N>" / "<videoId>#slide<N>" entity ids into
 * [videoId, N-as-string]. Composite ids are the DURABLE encoding of which
 * sub-entity a job targets — parsing them (instead of trusting a payload
 * number) keeps the crash-recovery path honest even when the payload was
 * written by an older route version.
 */
export function splitEntityId(
  entityId: string,
  marker: "#scene" | "#slide"
): [string, string | null] {
  const idx = entityId.indexOf(marker);
  if (idx === -1) return [entityId, null];
  const suffix = entityId.slice(idx + marker.length);
  return [entityId.slice(0, idx), /^\d+$/.test(suffix) ? suffix : null];
}
