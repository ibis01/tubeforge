import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { latestStatsFor } from "@/lib/tubeforge/analytics";
import { jobSnapshot } from "@/lib/tubeforge/jobs";
import { serializeVideo } from "@/lib/tubeforge/serialize";
import {
  RENDER_MODES,
  THUMB_STYLES,
  RENDER_ASPECT_IDS,
  RENDER_FPS,
} from "@/lib/tubeforge/types";
import { TRANSITIONS, sanitizeTransitionDuration } from "@/lib/tubeforge/transitions";
import { isDuckIntensity } from "@/lib/tubeforge/audiomix";
import { isMusicMoodId } from "@/lib/tubeforge/music";
import * as storage from "@/lib/tubeforge/storage";

const TRANSITION_IDS = new Set(TRANSITIONS.map((t) => t.id));

/** Every artifact keyed off the voice/narration — used when the SCRIPT or
 *  the VOICE/SPEED changes, i.e. when EVERY scene's read is stale. (A
 *  single-scene narration edit invalidates surgically in /scenes.) */
const VOICE_STALE =
  /\/(voiceover\.wav|voice-source\.\w+|final\.mp4|preview\.mp4|subtitles\.srt|short\.mp4|short-thumb\.png|scene-\d{2}\.(wav|mp4))$/;

/** Drop every voice-keyed artifact + reset the stage flags. Returns whether
 *  anything was removed (the client surfaces `invalidated` for a refresh). */
async function invalidateVoiceArtifacts(
  videoId: string,
  data: Record<string, unknown>
): Promise<boolean> {
  let removed = false;
  try {
    const keys = await storage.list(videoId);
    const stale = keys.filter((k) => VOICE_STALE.test(k));
    await Promise.all(stale.map((k) => storage.remove(k).catch(() => {})));
    removed = stale.length > 0;
  } catch {
    /* prefix may not exist yet — non-fatal */
  }
  data.hasVoiceover = false;
  data.audioDuration = null;
  data.voiceSource = "tts";
  data.voiceLabel = null;
  data.hasVideo = false;
  data.hasShort = false;
  data.shortDuration = null;
  data.shortScene = null;
  return removed;
}

// Next.js 16: params is a Promise
type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const { id } = await ctx.params;
  // tenant-db injects organizationId — a guessed id from ANOTHER tenant
  // resolves to null here, exactly the 404 cross-tenant access must produce.
  const video = await db.video.findUnique({
    where: { id },
    include: {
      channel: { select: { name: true } },
      character: { select: { name: true, hasPortrait: true } },
    },
  });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });
  return NextResponse.json({
    video: await serializeVideo(video, video.channel?.name, {
      includeScenes: true,
      stats: await latestStatsFor(id),
    }),
    generating: jobSnapshot(id),
  });
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const { id } = await ctx.params;
  const body = await req.json();

  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });

  const data: Record<string, unknown> = {};
  if (typeof body.title === "string") data.title = body.title.slice(0, 120);
  if (typeof body.script === "string") {
    const newScript = body.script;
    const oldScript = video.script ?? "";
    const newWordCount = newScript.split(/\s+/).filter(Boolean).length;
    data.script = newScript;
    data.wordCount = newWordCount;

    // When the script meaningfully changes, downstream artifacts built from
    // the old text no longer match. Drop the voiceover (and any rendered
    // MP4/short that contained it) so the UI re-offers those stages. The
    // thumbnail stays — it depends on the topic, not the script.
    //
    // `body.preserveArtifacts` opt-out: when the user explicitly says they're
    // only fixing typos and want to keep everything, we skip invalidation.
    const preserveArtifacts = body.preserveArtifacts === true;
    const changedEnough =
      Math.abs(newWordCount - (video.wordCount ?? 0)) > 5 ||
      newScript.trim() !== oldScript.trim();

    if (changedEnough && !preserveArtifacts && oldScript.trim()) {
      // Stage 4a (T-4.0): storage-backed invalidation. The old raw-fs pass
      // both bypassed the s3 driver AND matched stale pre-T-3.7 file names
      // (render.mp4, scene-N-clip.*) — under local it silently missed
      // final/preview/scene-NN clips, under s3 it removed nothing at all.
      // Artifacts keyed off the OLD narration die; scene art PNGs, stock
      // clips and thumbnails stay (they depend on visuals, not narration).
      await invalidateVoiceArtifacts(id, data);
    }
  }
  if (typeof body.description === "string")
    data.description = body.description.slice(0, 5000);
  if (typeof body.tags === "string") data.tags = body.tags.slice(0, 500);
  if (typeof body.voice === "string") data.voice = body.voice;
  if (typeof body.ttsSpeed === "number")
    data.ttsSpeed = Math.min(Math.max(body.ttsSpeed, 0.5), 2.0);

  // A voice or speed change makes EVERY scene's read stale — and the
  // voiceover stage now KEEPS existing per-scene WAVs (resume semantics in
  // story.ts), so they must be dropped here or the next voiceover job would
  // silently keep the old voice for every scene it skips.
  const voiceChanged =
    (typeof body.voice === "string" && body.voice !== video.voice) ||
    (typeof body.ttsSpeed === "number" &&
      Math.min(Math.max(body.ttsSpeed, 0.5), 2.0) !== video.ttsSpeed);
  if (voiceChanged && video.hasVoiceover) {
    await invalidateVoiceArtifacts(id, data);
  }
  if (typeof body.channelId === "string" || body.channelId === null)
    data.channelId = body.channelId;
  if (typeof body.characterId === "string" || body.characterId === null) {
    if (body.characterId) {
      const character = await db.character.findUnique({
        where: { id: String(body.characterId) },
      });
      if (!character)
        return NextResponse.json({ error: "Character not found" }, { status: 400 });
    }
    data.characterId = body.characterId;
  }
  if (RENDER_MODES.some((m) => m.id === body.renderMode))
    data.renderMode = String(body.renderMode);

  // S12 — the cover's STYLE (the subject's sibling axis: S9 picked WHICH
  // moment the cover depicts, this picks WHAT the art looks like). The
  // style feeds the thumbnail job's art direction AND leads the A/B
  // variants set at GENERATION time, so a flip invalidates nothing — the
  // standing cover stays until the studio's Regenerate arm repaints it.
  // Catalog-gated like every pick: a hostile or foreign id dies here with
  // a readable 400, never reaching the row.
  if (typeof body.thumbStyle === "string") {
    const style = body.thumbStyle.trim();
    if (!THUMB_STYLES.some((t) => t.id === style)) {
      return NextResponse.json(
        { error: `Unknown thumbnail style "${style.slice(0, 40)}" — pick one from the style catalog` },
        { status: 400 }
      );
    }
    data.thumbStyle = style;
  }

  // Background-music overrides (null = follow Settings defaults)
  if (typeof body.musicEnabled === "boolean" || body.musicEnabled === null)
    data.musicEnabled = body.musicEnabled;
  if (typeof body.musicTrackId === "string" || body.musicTrackId === null) {
    if (body.musicTrackId) {
      const track = await db.musicTrack.findUnique({
        where: { id: String(body.musicTrackId) },
      });
      if (!track)
        return NextResponse.json({ error: "Music track not found" }, { status: 400 });
    }
    data.musicTrackId = body.musicTrackId;
  }
  if (typeof body.musicVolume === "number")
    data.musicVolume = Math.min(Math.max(body.musicVolume, 0), 1);
  if (typeof body.musicFadeIn === "number")
    data.musicFadeIn = Math.min(Math.max(body.musicFadeIn, 0.5), 8);
  if (typeof body.musicFadeOut === "number")
    data.musicFadeOut = Math.min(Math.max(body.musicFadeOut, 0.5), 8);
  // Auto-ducking + story-mood overrides (null = follow Settings defaults)
  if (typeof body.musicDucking === "boolean" || body.musicDucking === null)
    data.musicDucking = body.musicDucking;
  if (isDuckIntensity(body.musicDuckingIntensity) || body.musicDuckingIntensity === null)
    data.musicDuckingIntensity = body.musicDuckingIntensity;
  if (isMusicMoodId(body.musicMood) || body.musicMood === null)
    data.musicMood = body.musicMood;

  // Smart Motion (Ken Burns) overrides (null = built-in defaults)
  if (typeof body.motionMode === "string" && ["smart", "zoom", "pan", "off"].includes(body.motionMode))
    data.motionMode = body.motionMode;
  if (body.motionMode === null) data.motionMode = null;
  if (typeof body.motionIntensity === "number")
    data.motionIntensity = Math.round(Math.min(Math.max(body.motionIntensity, 0), 30));
  if (body.motionIntensity === null) data.motionIntensity = null;
  if (typeof body.motionCurve === "string" && ["smooth", "linear"].includes(body.motionCurve))
    data.motionCurve = body.motionCurve;
  if (body.motionCurve === null) data.motionCurve = null;
  if (typeof body.motionVary === "boolean") data.motionVary = body.motionVary;
  if (body.motionVary === null) data.motionVary = null;

  // Scene transition overrides (null = built-in default: crossfade 0.5s)
  if (typeof body.transitionStyle === "string" && TRANSITION_IDS.has(body.transitionStyle))
    data.transitionStyle = body.transitionStyle;
  if (body.transitionStyle === null) data.transitionStyle = null;
  if (typeof body.transitionDuration === "number")
    data.transitionDuration = sanitizeTransitionDuration(body.transitionDuration);
  if (body.transitionDuration === null) data.transitionDuration = null;

  // Stage 6 render defaults — per-project aspect ratio, frame rate, caption
  // burn-in (T-6.7/T-6.8). These ride alongside the existing overrides; the
  // render job reads them from the video row when no per-render override
  // is supplied in the POST /render body. null = "16:9" / 30 fps / sidecar SRT.
  //
  // S13 — the frame's gate (the S12 catalog-gate law): a PRESENT but
  // illegal value dies with a readable 400 before any write — junk
  // strings, off-catalog numbers, type confusion — instead of the old
  // silent drop (a hostile PATCH must not look like it worked). null
  // clears to the default; an absent key stays untouched. The membership
  // lists are the SHARED catalog (types.ts) the studio picker shows, so
  // the gate and the dropdown can never disagree. Slides rows keep the
  // permissive write (the export presets PATCH blindly; the render job
  // forces 9:16 there — the row value is inert, the studio's picker is
  // what stays honest by locking vertical for slides).
  if (body.aspectRatio !== undefined) {
    if (body.aspectRatio === null) {
      data.aspectRatio = null;
    } else if (
      typeof body.aspectRatio === "string" &&
      (RENDER_ASPECT_IDS as readonly string[]).includes(body.aspectRatio)
    ) {
      data.aspectRatio = body.aspectRatio;
    } else {
      return NextResponse.json(
        {
          error: `Invalid aspectRatio — pick one of ${RENDER_ASPECT_IDS.join(
            ", "
          )}, or null for the 16:9 default`,
        },
        { status: 400 }
      );
    }
  }
  if (body.frameRate !== undefined) {
    if (body.frameRate === null) {
      data.frameRate = null;
    } else if (
      typeof body.frameRate === "number" &&
      Number.isInteger(body.frameRate) &&
      (RENDER_FPS as readonly number[]).includes(body.frameRate)
    ) {
      data.frameRate = body.frameRate;
    } else {
      return NextResponse.json(
        {
          error: `Invalid frameRate — pick one of ${RENDER_FPS.join(
            ", "
          )}, or null for the 30 fps default`,
        },
        { status: 400 }
      );
    }
  }
  if (typeof body.burnCaptions === "boolean") data.burnCaptions = body.burnCaptions;
  if (body.burnCaptions === null) data.burnCaptions = null;

  // Status transitions (publish / mark ready / retry)
  if (typeof body.status === "string") {
    const allowed = ["draft", "scripted", "voiced", "ready", "published", "failed"];
    if (!allowed.includes(body.status))
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    data.status = body.status;

    if (body.status === "published") {
      await db.activity.create({
        data: {
          organizationId: auth.ctx.organizationId,
          userId: auth.ctx.userId,
          videoId: id,
          stage: "publish",
          message: `Published to YouTube queue — "${video.title ?? video.topic}"`,
        },
      });
    }
    if (body.status === "ready") {
      await db.activity.create({
        data: {
          organizationId: auth.ctx.organizationId,
          userId: auth.ctx.userId,
          videoId: id,
          stage: "ready",
          message: `Package complete — "${video.title ?? video.topic}" is ready to upload`,
        },
      });
    }
  }

  const updated = await db.video.update({
    where: { id },
    data,
    include: {
      channel: { select: { name: true } },
      character: { select: { name: true, hasPortrait: true } },
    },
  });
  return NextResponse.json({
    video: await serializeVideo(updated, updated.channel?.name, { includeScenes: true }),
  });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const { id } = await ctx.params;
  // Scoped lookup FIRST — the uploads/<id>/ tree is only touched after the
  // row is proven to belong to the caller's organization (no path-traversal
  // style cross-tenant deletes).
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });

  await db.video.delete({ where: { id } });

  // Stage 1 (task T-1.13, audit defect D-05): the DB row cascade no longer
  // orphans the media tree. Stage 4a (T-4.0): the wipe goes through the
  // storage driver — removePrefix works under local AND s3, and decrements
  // the org quota (the old raw-fs rmSync was a silent no-op under s3).
  try {
    await storage.removePrefix(id);
  } catch {
    // best-effort — a stuck object must not fail the delete; a periodic
    // orphan sweep can clean strays later.
  }

  return NextResponse.json({ success: true });
}
