// Client-side polling for async AI stage jobs.
// Stage POSTs return 202 + start a server-side background job; the client
// polls the video record until the artifact exists or an error is recorded.

import type { VideoDTO, CharacterDTO, VerifyReportDTO } from "./types";

export interface GeneratingFlags {
  voiceover: boolean;
  thumbnail: boolean;
  variants: boolean;
  storyboard: boolean;
  render: boolean;
  verify: boolean;
}

export interface RenderStatus {
  rendering: boolean;
  mode: string | null;
  progress: { current: number; total: number; label: string } | null;
  hasVideo: boolean;
  videoDuration: number | null;
  error: string | null;
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

// ---------- Character polling ----------

/** Poll until the storyboard job finishes (watches the job flag so re-rolls work). */
export function pollStoryboard(videoId: string, opts?: PollOpts) {
  return pollVideo(
    videoId,
    (v) => v.hasStoryboard,
    (v) => Boolean(v.error) && !v.hasStoryboard,
    { ...opts, timeoutMs: opts?.timeoutMs ?? 15 * 60 * 1000 }
  );
}

/**
 * Poll the render endpoint until the job finishes. Resolves with the final
 * status payload. Renders can take minutes (Ken Burns) to tens of minutes
 * (full i2v animation), so pass a generous timeout for animated mode.
 */
export async function pollRender(
  videoId: string,
  onTick?: (status: RenderStatus) => void,
  opts: PollOpts = {}
): Promise<RenderStatus> {
  const interval = opts.intervalMs ?? 5000;
  const timeout = opts.timeoutMs ?? 50 * 60 * 1000; // animated: ~4 min/scene
  const deadline = Date.now() + timeout;

  for (;;) {
    const res = await fetch(`/api/videos/${videoId}/render`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: RenderStatus = await res.json();
    onTick?.(data);

    if (!data.rendering) {
      if (data.error) throw new Error(data.error);
      return data;
    }

    if (Date.now() > deadline)
      throw new Error(
        "Rendering is taking unusually long — it may still be running in the background; check back in a few minutes."
      );

    await sleep(interval);
  }
}

/** Poll a single-scene re-roll until its job flag clears. */
export async function pollScene(
  videoId: string,
  sceneIndex: number,
  opts: PollOpts = {}
): Promise<void> {
  const interval = opts.intervalMs ?? 3000;
  const timeout = opts.timeoutMs ?? 8 * 60 * 1000;
  const deadline = Date.now() + timeout;

  for (;;) {
    const res = await fetch(`/api/videos/${videoId}/storyboard`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const scene = (data.scenes ?? []).find(
      (s: { index: number; generating: boolean }) => s.index === sceneIndex
    );
    if (!scene || !scene.generating) return;

    if (Date.now() > deadline)
      throw new Error("Scene re-roll is taking unusually long — check back shortly.");

    await sleep(interval);
  }
}

interface CharacterResponse {
  character?: CharacterDTO;
  error?: string;
}

interface VerifyResponse {
  generating?: boolean;
  error?: string | null;
  report?: VerifyReportDTO | null;
}

/** Poll the narration check until its job finishes; resolves with the report. */
export async function pollVerify(
  videoId: string,
  opts: PollOpts = {}
): Promise<VerifyReportDTO | null> {
  const interval = opts.intervalMs ?? 2500;
  const timeout = opts.timeoutMs ?? 6 * 60 * 1000;
  const deadline = Date.now() + timeout;

  for (;;) {
    const res = await fetch(`/api/videos/${videoId}/verify`, {
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: VerifyResponse = await res.json();

    if (!data.generating) {
      if (data.error) throw new Error(data.error);
      return data.report ?? null;
    }

    if (Date.now() > deadline)
      throw new Error(
        "Narration check is taking unusually long — it may still be running; check back shortly."
      );

    await sleep(interval);
  }
}

/**
 * Poll a character until `predicate` fires or the server records a job error.
 * Used by the portrait studio and consistency-sheet generator.
 */
export async function pollCharacter(
  characterId: string,
  predicate: (c: CharacterDTO) => boolean,
  opts: PollOpts = {}
): Promise<CharacterDTO> {
  const interval = opts.intervalMs ?? 3000;
  const timeout = opts.timeoutMs ?? 8 * 60 * 1000;
  const deadline = Date.now() + timeout;

  for (;;) {
    const res = await fetch(`/api/characters/${characterId}`, {
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: CharacterResponse = await res.json();
    const character = data.character;
    if (!character) throw new Error(data.error ?? "Character not found");

    if (predicate(character)) return character;
    if (character.error) throw new Error(character.error);

    if (Date.now() > deadline)
      throw new Error(
        "Generation is taking unusually long — check the Cast page in a minute; the job may still be running."
      );

    await sleep(interval);
  }
}

/** Poll until the portrait job finishes (handles re-rolls — watch the job flag, not the artifact). */
export function pollPortrait(characterId: string, opts?: PollOpts) {
  return pollCharacter(characterId, (c) => !c.generating.portrait, opts);
}

/** Poll until the consistency-sheet job finishes. */
export function pollPoses(characterId: string, opts?: PollOpts) {
  return pollCharacter(characterId, (c) => !c.generating.poses, opts);
}
