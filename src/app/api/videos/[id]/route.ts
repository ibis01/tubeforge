import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { latestStatsFor } from "@/lib/tubeforge/analytics";
import { jobSnapshot } from "@/lib/tubeforge/jobs";
import { serializeVideo } from "@/lib/tubeforge/serialize";
import { RENDER_MODES } from "@/lib/tubeforge/types";
import { TRANSITIONS, sanitizeTransitionDuration } from "@/lib/tubeforge/transitions";

const TRANSITION_IDS = new Set(TRANSITIONS.map((t) => t.id));

// Next.js 16: params is a Promise
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
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
  return NextResponse.json({
    video: serializeVideo(video, video.channel?.name, {
      includeScenes: true,
      stats: await latestStatsFor(id),
    }),
    generating: jobSnapshot(id),
  });
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const body = await req.json();

  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });

  const data: Record<string, unknown> = {};
  if (typeof body.title === "string") data.title = body.title.slice(0, 120);
  if (typeof body.script === "string") {
    data.script = body.script;
    data.wordCount = body.script.split(/\s+/).filter(Boolean).length;
  }
  if (typeof body.description === "string") data.description = body.description;
  if (typeof body.tags === "string") data.tags = body.tags;
  if (typeof body.voice === "string") data.voice = body.voice;
  if (typeof body.ttsSpeed === "number")
    data.ttsSpeed = Math.min(Math.max(body.ttsSpeed, 0.5), 2.0);
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

  // Status transitions (publish / mark ready / retry)
  if (typeof body.status === "string") {
    const allowed = ["draft", "scripted", "voiced", "ready", "published", "failed"];
    if (!allowed.includes(body.status))
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    data.status = body.status;

    if (body.status === "published") {
      await db.activity.create({
        data: {
          videoId: id,
          stage: "publish",
          message: `Published to YouTube queue — "${video.title ?? video.topic}"`,
        },
      });
    }
    if (body.status === "ready") {
      await db.activity.create({
        data: {
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
    video: serializeVideo(updated, updated.channel?.name, { includeScenes: true }),
  });
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });

  await db.video.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
