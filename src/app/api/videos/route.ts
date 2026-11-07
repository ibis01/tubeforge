import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { latestStatsMap } from "@/lib/tubeforge/analytics";
import { serializeVideo } from "@/lib/tubeforge/serialize";
import { startJob } from "@/lib/tubeforge/jobs";
import { runScriptJob } from "@/lib/tubeforge/script-job";
import { FORMATS, RENDER_MODES, type VideoDTO } from "@/lib/tubeforge/types";
import { TRANSITIONS, sanitizeTransitionDuration } from "@/lib/tubeforge/transitions";
import { isDuckIntensity } from "@/lib/tubeforge/audiomix";
import { isMusicMoodId } from "@/lib/tubeforge/music";
import { errorText } from "@/lib/tubeforge/redact";

const TRANSITION_IDS = new Set<string>(TRANSITIONS.map((t) => t.id));

export async function GET(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const { searchParams } = new URL(req.url);
  const status = searchParams.get("status");
  const limit = Math.min(Number(searchParams.get("limit") ?? 100), 200);

  const where = status && status !== "all" ? { status } : {};
  // tenant-db injects organizationId into every query below — the caller only
  // ever sees their own organization's videos.
  const videos = await db.video.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      channel: { select: { name: true } },
      character: { select: { name: true, hasPortrait: true } },
    },
  });

  // Latest synced YouTube performance per video (Phase 5) — one query.
  const stats = await latestStatsMap(videos.map((v) => v.id));

  return NextResponse.json({
    videos: await Promise.all(
      videos.map((v) =>
        serializeVideo(v, v.channel?.name, { stats: stats.get(v.id) ?? null })
      )
    ),
  });
}

export async function POST(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  try {
    const body = await req.json();
    const topic = String(body.topic ?? "").trim();
    if (!topic)
      return NextResponse.json({ error: "Topic is required" }, { status: 400 });
    if (topic.length > 300)
      return NextResponse.json({ error: "Topic too long" }, { status: 400 });

    // Optional custom script — when provided (non-empty), Auto-Pilot skips
    // AI generation and stores the user's text verbatim. Classic format only;
    // story format needs AI scene-splitting (we'd lose scene art prompts
    // otherwise) so it falls back to AI generation even if a script is sent.
    //
    // GUARD: a custom script must be ANALYZED + APPROVED first. The client
    // runs POST /api/videos/analyze-script, shows the verdict, and only
    // re-submits here with `approved: true` once the user accepts. This
    // catches quality / TTS / sensitive-content issues before we burn a
    // 30-minute render pipeline on a script that would fail at the end.
    const customScript =
      typeof body.script === "string" ? body.script.trim() : "";
    const useCustomScript =
      customScript.length > 0 &&
      FORMATS.some((f) => f.id === body.format) &&
      String(body.format) !== "story";
    if (typeof body.script === "string" && body.script.length > 50000)
      return NextResponse.json(
        { error: "Script too long (50,000 char max)" },
        { status: 400 }
      );
    if (typeof body.script === "string" && body.script.trim() && String(body.format) === "story")
      return NextResponse.json(
        { error: "Custom script is only supported on the Classic format. Switch to Story for AI scene-splitting." },
        { status: 400 }
      );
    // Approve-gate: custom script + not approved → 422 with a hint.
    if (useCustomScript && body.approved !== true) {
      return NextResponse.json(
        {
          error:
            "Custom script must be analyzed and approved first. POST /api/videos/analyze-script, then re-submit with `approved: true`.",
          needsApproval: true,
        },
        { status: 422 }
      );
    }

    const niche = String(body.niche ?? "Motivation");
    const tone = String(body.tone ?? "informative");
    const length = String(body.length ?? "medium");
    const voice = String(body.voice ?? "jam");
    const ttsSpeed = Math.min(Math.max(Number(body.ttsSpeed ?? 1.0), 0.5), 2.0);
    const thumbStyle = String(body.thumbStyle ?? "cinematic");
    const channelId = body.channelId ? String(body.channelId) : null;
    const characterId = body.characterId ? String(body.characterId) : null;
    const format = FORMATS.some((f) => f.id === body.format)
      ? String(body.format)
      : "script";
    const renderMode = RENDER_MODES.some((m) => m.id === body.renderMode)
      ? String(body.renderMode)
      : "kenburns";

    // S49 — the content policy (Islamic visual protection). Snapped against
    // the real ids; unknown/absent = null (the "standard" policy — today's
    // behavior). Deliberate human choice, recorded on the row, read by every
    // enforcement layer.
    const contentPolicy =
      String(body.contentPolicy ?? "").trim().toLowerCase() === "islamic-history"
        ? "islamic-history"
        : null;

    // Stage 5 (module A) — research sources attached at create (the Classic
    // script path from a radar idea). Same validation as the greenlight
    // snapshot: http(s) URLs only, ≤6, field lengths capped.
    const researchSources = Array.isArray(body.researchSources)
      ? JSON.stringify(
          body.researchSources
            .filter(
              (s: { url?: unknown }) =>
                Boolean(s) &&
                typeof s.url === "string" &&
                /^https?:\/\//.test(s.url)
            )
            .slice(0, 6)
            .map((s: { url: string; name?: unknown; host?: unknown }) => ({
              url: s.url.slice(0, 300),
              name: typeof s.name === "string" ? s.name.slice(0, 160) : s.url,
              host: typeof s.host === "string" ? s.host.slice(0, 100) : "",
            }))
        )
      : null;

    // Background-music overrides (null → Settings defaults at render time)
    const musicEnabled =
      typeof body.musicEnabled === "boolean" ? body.musicEnabled : null;
    const musicTrackId = body.musicTrackId ? String(body.musicTrackId) : null;
    if (musicTrackId) {
      const track = await db.musicTrack.findUnique({ where: { id: musicTrackId } });
      if (!track)
        return NextResponse.json({ error: "Music track not found" }, { status: 400 });
    }
    const musicVolume =
      typeof body.musicVolume === "number"
        ? Math.min(Math.max(body.musicVolume, 0), 1)
        : null;
    const musicFadeIn =
      typeof body.musicFadeIn === "number"
        ? Math.min(Math.max(body.musicFadeIn, 0.5), 8)
        : null;
    const musicFadeOut =
      typeof body.musicFadeOut === "number"
        ? Math.min(Math.max(body.musicFadeOut, 0.5), 8)
        : null;
    // Auto-ducking + story-mood overrides (null → Settings defaults)
    const musicDucking =
      typeof body.musicDucking === "boolean" ? body.musicDucking : null;
    const musicDuckingIntensity = isDuckIntensity(body.musicDuckingIntensity)
      ? body.musicDuckingIntensity
      : null;
    const musicMood = isMusicMoodId(body.musicMood) ? body.musicMood : null;

    // Smart Motion (Ken Burns) overrides (null = built-in defaults)
    const MOTION_MODE_IDS = ["smart", "zoom", "pan", "off"];
    const motionMode = MOTION_MODE_IDS.includes(String(body.motionMode))
      ? String(body.motionMode)
      : null;
    const motionIntensity =
      typeof body.motionIntensity === "number"
        ? Math.round(Math.min(Math.max(body.motionIntensity, 0), 30))
        : null;
    const motionCurve = ["smooth", "linear"].includes(String(body.motionCurve))
      ? String(body.motionCurve)
      : null;
    const motionVary = typeof body.motionVary === "boolean" ? body.motionVary : null;

    // Scene transition overrides (null = built-in default: crossfade 0.5s)
    const transitionStyle = TRANSITION_IDS.has(String(body.transitionStyle))
      ? String(body.transitionStyle)
      : null;
    const transitionDuration =
      typeof body.transitionDuration === "number"
        ? sanitizeTransitionDuration(body.transitionDuration)
        : null;

    // Validate the character exists (avoids dangling FK on SQLite)
    const character = characterId
      ? await db.character.findUnique({ where: { id: characterId } })
      : null;
    if (characterId && !character)
      return NextResponse.json({ error: "Character not found" }, { status: 400 });

    // Create the video record first (draft)
    const video = await db.video.create({
      data: {
        organizationId: auth.ctx.organizationId,
        topic,
        niche,
        tone,
        length,
        voice,
        ttsSpeed,
        thumbStyle,
        channelId,
        characterId,
        format,
        renderMode,
        contentPolicy,
        researchSources,
        musicEnabled,
        musicTrackId,
        musicVolume,
        musicFadeIn,
        musicFadeOut,
        musicDucking,
        musicDuckingIntensity,
        musicMood,
        motionMode,
        motionIntensity,
        motionCurve,
        motionVary,
        transitionStyle,
        transitionDuration,
        status: "draft",
      },
      include: {
        channel: { select: { name: true } },
        character: { select: { name: true, hasPortrait: true } },
      },
    });

    await db.activity.create({
      data: {
        organizationId: auth.ctx.organizationId,
        userId: auth.ctx.userId,
        videoId: video.id,
        stage: "create",
        message: `New video queued: "${topic}" (${niche})${format === "story" ? " · scene-based story" : ""}`,
      },
    });

    // Stage 1 — AI script generation (classic narration OR scene-based story).
    //
    // Stage 1 of the roadmap (task T-1.9): the multi-minute LLM call moved
    // OFF the request path. The route returns 202 with the draft video and
    // the script job runs via startJob + runScriptJob (the same worker the
    // batch route already used) — quota-storm retries included. Clients poll
    // GET /api/videos/[id] (generating.script flag) via pollScript().
    if (useCustomScript) {
      const wordCount = (text: string) =>
        text.split(/\s+/).filter(Boolean).length;
      const title = topic.slice(0, 80);
      const updated = await db.video.update({
        where: { id: video.id },
        data: {
          title,
          script: customScript,
          description: "",
          tags: "",
          wordCount: wordCount(customScript),
          status: "scripted",
          error: null,
        },
        include: {
          channel: { select: { name: true } },
          character: { select: { name: true, hasPortrait: true } },
        },
      });

      await db.activity.create({
        data: {
          organizationId: auth.ctx.organizationId,
          userId: auth.ctx.userId,
          videoId: video.id,
          stage: "script",
          message: `Custom script pasted — "${title}" (${wordCount(customScript)} words, no AI generation)`,
        },
      });

      return NextResponse.json({
        video: (await serializeVideo(updated, updated.channel?.name, {
          includeScenes: true,
        })) as VideoDTO,
      });
    }

    const accepted = await startJob(video.id, "script", () =>
      runScriptJob(video.id)
    );
    if (!accepted) {
      // Practically unreachable for a freshly-created id, but stay honest:
      // surface the dedupe hit instead of silently returning a draft.
      return NextResponse.json(
        { error: "A script job is already running for this video", videoId: video.id },
        { status: 409 }
      );
    }

    return NextResponse.json(
      {
        video: (await serializeVideo(video, video.channel?.name, {
          includeScenes: true,
        })) as VideoDTO,
        queued: true,
      },
      { status: 202 }
    );
  } catch (err) {
    const message = errorText(err, "Invalid request");
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
