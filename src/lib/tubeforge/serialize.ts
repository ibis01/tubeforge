// Shared Video -> VideoDTO serializer. One source of truth so every route
// (list, detail, stage jobs) emits the same shape, including story-engine
// fields (format, scenes, storyboard, rendered video) and Phase 5 fields
// (auto-short state + latest synced YouTube performance).

import type { Video } from "@prisma/client";
import type { VideoDTO, VideoStatus } from "./types";
import { parseScenes, serializeScenes } from "./story";
import { hasBrandLogo } from "./slides";

// Storage seam (T-3.7): asset presence now comes from DB flags
// (hasVideo/hasPreview/hasShort) — correct on BOTH storage drivers. The old
// fs.existsSync probes silently lied under the s3 driver and cost one stat
// per video row on every list request.

type VideoWithJoins = Video & {
  character?: { name: string; hasPortrait: boolean } | null;
};

export async function serializeVideo(
  v: VideoWithJoins,
  channelName?: string | null,
  opts: {
    includeScenes?: boolean;
    /** Latest synced performance for this video (Phase 5) — avoids N+1s. */
    stats?: { views: number; likes: number; comments: number } | null;
  } = {}
): Promise<VideoDTO> {
  const isStory = v.format === "story";
  const scenes = isStory ? parseScenes(v.scenes) : [];
  // Serialized scene DTOs when included — image/stock URLs + live job flags.
  const sceneDTOs = isStory && opts.includeScenes ? await serializeScenes(v.id, scenes) : undefined;
  const hasFinal = isStory && v.hasVideo;
  const hasPreview = isStory && v.hasPreview;
  const hasShortFile = isStory && v.hasShort;

  return {
    id: v.id,
    title: v.title,
    topic: v.topic,
    niche: v.niche,
    tone: v.tone,
    length: v.length,
    script: v.script,
    description: v.description,
    tags: v.tags,
    status: v.status as VideoStatus,
    voice: v.voice,
    ttsSpeed: v.ttsSpeed,
    thumbStyle: v.thumbStyle,
    voiceSource: v.voiceSource,
    voiceLabel: v.voiceLabel,
    hasVoiceover: v.hasVoiceover,
    hasThumbnail: v.hasThumbnail,
    audioDuration: v.audioDuration,
    wordCount: v.wordCount,
    error: v.error,
    channelId: v.channelId,
    channelName: channelName ?? null,
    characterId: v.characterId,
    characterName: v.character?.name ?? null,
    characterPortraitUrl:
      v.characterId && v.character?.hasPortrait
        ? `/api/characters/${v.characterId}/portrait`
        : null,
    format: v.format,
    renderMode: v.renderMode,
    scenes: sceneDTOs,
    sceneCount: scenes.length,
    hasStoryboard: isStory && v.hasStoryboard,
    hasVideo: isStory && v.hasVideo,
    videoDuration: v.videoDuration,
    videoUrl: hasFinal ? `/api/videos/${v.id}/mp4` : null,
    previewUrl: hasPreview ? `/api/videos/${v.id}/mp4?variant=preview` : null,
    hasComments: Boolean(v.commentsKit),
    youtubeUrl: v.youtubeUrl ?? null,
    publishedAt: v.publishedAt ? v.publishedAt.toISOString() : null,
    hasShort: hasShortFile,
    shortUrl: hasShortFile ? `/api/videos/${v.id}/mp4?variant=short` : null,
    shortDuration: hasShortFile ? v.shortDuration : null,
    shortScene: hasShortFile ? v.shortScene : null,
    musicEnabled: v.musicEnabled,
    musicTrackId: v.musicTrackId,
    musicVolume: v.musicVolume,
    musicFadeIn: v.musicFadeIn,
    musicFadeOut: v.musicFadeOut,
    musicDucking: v.musicDucking,
    musicDuckingIntensity: v.musicDuckingIntensity,
    musicMood: v.musicMood,
    motionMode: v.motionMode,
    motionIntensity: v.motionIntensity,
    motionCurve: v.motionCurve,
    motionVary: v.motionVary,
    transitionStyle: v.transitionStyle,
    transitionDuration: v.transitionDuration,
    brandAccent: v.brandAccent,
    brandHasLogo: isStory && (await hasBrandLogo(v.id)),
    brandLogoOn: v.brandLogoOn ?? true,
    qc: parseQc(v.qcReport),
    // Stage 5 (module A) — the research-source snapshot (legacy rows → []).
    researchSources: parseResearchSources(
      (v as { researchSources?: string | null }).researchSources
    ),
    stats: opts.stats ?? null,
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
  };
}

/** Parse the stored QC JSON safely (bad/legacy payloads → null). */
function parseQc(raw: string | null): import("./types").QcReportDTO | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as import("./types").QcReportDTO;
    return parsed && typeof parsed.passed === "boolean" && Array.isArray(parsed.checks) ? parsed : null;
  } catch {
    return null;
  }
}

/** Parse the research-source snapshot safely (bad/legacy payloads → []).
 * Only http(s) URLs survive — the panel links out, so nothing else is safe
 * to render as a href. */
function parseResearchSources(raw: string | null | undefined): import("./types").ResearchSource[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (s): s is import("./types").ResearchSource =>
          Boolean(s) &&
          typeof (s as { url?: unknown }).url === "string" &&
          /^https?:\/\//.test((s as { url: string }).url)
      )
      .slice(0, 6)
      .map((s) => ({
        url: s.url.slice(0, 300),
        name: typeof s.name === "string" ? s.name.slice(0, 160) : s.url,
        host: typeof s.host === "string" ? s.host.slice(0, 100) : "",
      }));
  } catch {
    return [];
  }
}
