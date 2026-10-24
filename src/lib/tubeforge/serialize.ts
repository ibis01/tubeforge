// Shared Video -> VideoDTO serializer. One source of truth so every route
// (list, detail, stage jobs) emits the same shape, including story-engine
// fields (format, scenes, storyboard, rendered video).

import fs from "fs";
import path from "path";
import type { Video } from "@prisma/client";
import type { VideoDTO, VideoStatus } from "./types";
import { parseScenes } from "./story";

const UPLOAD_ROOT = path.join(process.cwd(), "uploads");

type VideoWithJoins = Video & {
  character?: { name: string; hasPortrait: boolean } | null;
};

export function serializeVideo(
  v: VideoWithJoins,
  channelName?: string | null,
  opts: { includeScenes?: boolean } = {}
): VideoDTO {
  const isStory = v.format === "story";
  const scenes = isStory ? parseScenes(v.scenes) : [];
  const hasFinal = isStory && fs.existsSync(path.join(UPLOAD_ROOT, v.id, "final.mp4"));
  const hasPreview = isStory && fs.existsSync(path.join(UPLOAD_ROOT, v.id, "preview.mp4"));

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
    scenes: opts.includeScenes ? scenes : undefined,
    sceneCount: scenes.length,
    hasStoryboard: isStory && v.hasStoryboard,
    hasVideo: isStory && v.hasVideo,
    videoDuration: v.videoDuration,
    videoUrl: hasFinal ? `/api/videos/${v.id}/mp4` : null,
    previewUrl: hasPreview ? `/api/videos/${v.id}/mp4?variant=preview` : null,
    hasComments: Boolean(v.commentsKit),
    youtubeUrl: v.youtubeUrl ?? null,
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
  };
}
