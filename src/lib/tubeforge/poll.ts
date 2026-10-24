// Client-side polling for async AI stage jobs.
// Stage POSTs return 202 + start a server-side background job; the client
// polls the video record until the artifact exists or an error is recorded.

import type { VideoDTO } from "./types";

export interface GeneratingFlags {
  voiceover: boolean;
  thumbnail: boolean;
  variants: boolean;
}

interface VideoResponse {
  video?: VideoDTO;
  generating?: GeneratingFlags;
  error?: string;
}

interface PollOpts {
  intervalMs?: number;
  timeoutMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchVideo(videoId: string): Promise<VideoResponse> {
  const res = await fetch(`/api/videos/${videoId}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Poll a video until `predicate` is satisfied.
 * Rejects with the server-recorded error when `failPredicate` fires.
 */
export async function pollVideo(
  videoId: string,
  predicate: (v: VideoDTO) => boolean,
  failPredicate: (v: VideoDTO) => boolean = (v) => Boolean(v.error),
  opts: PollOpts = {}
): Promise<VideoDTO> {
  const interval = opts.intervalMs ?? 2500;
  const timeout = opts.timeoutMs ?? 6 * 60 * 1000;
  const deadline = Date.now() + timeout;

  for (;;) {
    const data = await fetchVideo(videoId);
    const video = data.video;
    if (!video) throw new Error(data.error ?? "Video not found");

    if (predicate(video)) return video;
    if (failPredicate(video))
      throw new Error(video.error || "Generation failed");

    if (Date.now() > deadline)
      throw new Error(
        "Generation is taking unusually long — check the Library in a minute; the job may still be running."
      );

    await sleep(interval);
  }
}

/** Poll until the voiceover artifact exists. */
export function pollVoiceover(videoId: string, opts?: PollOpts) {
  return pollVideo(
    videoId,
    (v) => v.hasVoiceover,
    (v) => Boolean(v.error) && !v.hasVoiceover,
    opts
  );
}

/** Poll until the thumbnail artifact exists. */
export function pollThumbnail(videoId: string, opts?: PollOpts) {
  return pollVideo(
    videoId,
    (v) => v.hasThumbnail,
    (v) => Boolean(v.error) && !v.hasThumbnail,
    opts
  );
}

/** Poll the variants list until its background job finishes. */
export async function pollVariants(
  videoId: string,
  opts: PollOpts = {}
): Promise<VariantListResponse> {
  const interval = opts.intervalMs ?? 3000;
  const timeout = opts.timeoutMs ?? 6 * 60 * 1000;
  const deadline = Date.now() + timeout;

  for (;;) {
    const res = await fetch(`/api/videos/${videoId}/variants`, {
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: VariantListResponse = await res.json();
    if (!data.generating) {
      if (data.error) throw new Error(data.error);
      return data;
    }
    if (Date.now() > deadline)
      throw new Error("A/B generation is taking unusually long — try again shortly.");
    await sleep(interval);
  }
}

export interface VariantListResponse {
  variants: {
    style: string;
    label: string;
    url: string;
    isPrimary: boolean;
  }[];
  generating?: boolean;
  error?: string | null;
}
