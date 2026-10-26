import type { Video } from "@prisma/client";

/**
 * Derive the pipeline status from which artifacts exist.
 * draft -> scripted -> voiced -> ready (-> published, preserved).
 */
export function deriveStatus(
  video: Pick<Video, "status" | "script" | "hasVoiceover" | "hasThumbnail">,
  overrides: Partial<
    Pick<Video, "hasVoiceover" | "hasThumbnail">
  > = {}
): string {
  if (video.status === "published") return "published";

  const hasScript = Boolean(video.script);
  const hasVoice = overrides.hasVoiceover ?? video.hasVoiceover;
  const hasThumb = overrides.hasThumbnail ?? video.hasThumbnail;

  if (hasScript && hasVoice && hasThumb) return "ready";
  if (hasScript && hasVoice) return "voiced";
  if (hasScript) return "scripted";
  return "draft";
}
