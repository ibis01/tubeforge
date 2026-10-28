// Shared Video -> VideoDTO serializer. One source of truth so every route
// (list, detail, stage jobs) emits the same shape, including story-engine
// fields (format, scenes, storyboard, rendered video) and Phase 5 fields
// (auto-short state + latest synced YouTube performance).

import fs from "fs";
import path from "path";
import type { Video } from "@prisma/client";
import type { VideoDTO, VideoStatus } from "./types";
import { parseScenes, serializeScenes } from "./story";

const UPLOAD_ROOT = path.join(process.cwd(), "uploads");

type VideoWithJoins = Video & {
  character?: { name: string; hasPortrait: boolean } | null;
};

export function serializeVideo(
  v: VideoWithJoins,
  channelName?: string | null,
  opts: {
    includeScenes?: boolean;
    /** Latest synced performance for this video (Phase 5) — avoids N+1s. */
    stats?: { views: number; likes: number; comments: number } | null;
  } = {}
): VideoDTO {
  const isStory = v.format === "story";
  const scenes = isStory ? parseScenes(v.scenes) : [];
  // Serialized scene DTOs when included — image/stock URLs + live job flags.
  const sceneDTOs = isStory && opts.includeScenes ? serializeScenes(v.id, scenes) : undefined;
  const hasFinal = isStory && fs.existsSync(path.join(UPLOAD_ROOT, v.id, "final.mp4"));
  const hasPreview = isStory && fs.existsSync(path.join(UPLOAD_ROOT, v.id, "preview.mp4"));
  const hasShortFile = isStory && v.hasShort && fs.existsSync(path.join(UPLOAD_ROOT, v.id, "short.mp4"));

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
    motionMode: v.motionMode,
    motionIntensity: v.motionIntensity,
    motionCurve: v.motionCurve,
    motionVary: v.motionVary,
    transitionStyle: v.transitionStyle,
    transitionDuration: v.transitionDuration,
    qc: parseQc(v.qcReport),
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
