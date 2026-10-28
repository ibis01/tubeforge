// Client-side polling for async AI stage jobs.
// Stage POSTs return 202 + start a server-side background job; the client
// polls the video record until the artifact exists or an error is recorded.

import type { VideoDTO, CharacterDTO, VerifyReportDTO, CommentsKitDTO } from "./types";

export interface GeneratingFlags {
  voiceover: boolean;
  thumbnail: boolean;
  variants: boolean;
  storyboard: boolean;
  render: boolean;
  verify: boolean;
  comments: boolean;
  upload: boolean;
  short: boolean;
  convert: boolean;
  script: boolean;
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

// ---------- Stock b-roll ----------

export interface StockStatus {
  generating: boolean;
  progress: { current: number; total: number; label: string } | null;
  matched: number;
  total: number;
  error: string | null;
}

/** Poll the stock-fetch job until it stops generating (or records an error). */
export async function pollStock(
  videoId: string,
  onTick?: (status: StockStatus) => void,
  opts: PollOpts = {}
): Promise<StockStatus> {
  const interval = opts.intervalMs ?? 3000;
  const timeout = opts.timeoutMs ?? 12 * 60 * 1000; // ~1.2s per scene + search time
  const deadline = Date.now() + timeout;

  for (;;) {
    const res = await fetch(`/api/videos/${videoId}/stock`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: StockStatus = await res.json();
    onTick?.(data);

    if (!data.generating) {
      if (data.error) throw new Error(data.error);
      return data;
    }

    if (Date.now() > deadline)
      throw new Error(
        "Stock matching is taking unusually long — it may still be running in the background; check back in a few minutes."
      );

    await sleep(interval);
  }
}

/** Poll until the YouTube upload lands (youtubeUrl set) or records an error. */
export function pollUpload(videoId: string, opts?: PollOpts) {
  return pollVideo(
    videoId,
    (v) => Boolean(v.youtubeUrl),
    (v) => Boolean(v.error) && !v.youtubeUrl,
    { ...opts, timeoutMs: opts?.timeoutMs ?? 20 * 60 * 1000 }
  );
}

/** Poll until the vertical Short lands (hasShort set) or records an error. */
export function pollShort(videoId: string, opts?: PollOpts) {
  return pollVideo(
    videoId,
    (v) => v.hasShort,
    (v) => Boolean(v.error) && !v.hasShort,
    { ...opts, timeoutMs: opts?.timeoutMs ?? 10 * 60 * 1000 }
  );
}

/** Poll until the classic→scene conversion flips the format to "story". */
export function pollConvert(videoId: string, opts?: PollOpts) {
  return pollVideo(
    videoId,
    (v) => v.format === "story",
    (v) => Boolean(v.error) && v.format !== "story",
    { ...opts, timeoutMs: opts?.timeoutMs ?? 6 * 60 * 1000 }
  );
}

/**
 * Poll until the script (re)generation job finishes. Watches the job flag
 * (not the artifact) so it works for BOTH first-time generation (retry after
 * a failed create) and re-rolls of an existing script.
 */
export async function pollScript(
  videoId: string,
  opts: PollOpts = {}
): Promise<VideoDTO> {
  const interval = opts.intervalMs ?? 2500;
  const timeout = opts.timeoutMs ?? 10 * 60 * 1000;
  const deadline = Date.now() + timeout;

  for (;;) {
    const data = await fetchVideo(videoId);
    if (!data.video) throw new Error(data.error ?? "Video not found");

    if (!data.generating?.script) {
      if (data.video.error) throw new Error(data.video.error);
      return data.video;
    }

    if (Date.now() > deadline)
      throw new Error(
        "Script generation is taking unusually long — it may still be running; check back shortly."
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

interface CommentsResponse {
  generating?: boolean;
  error?: string | null;
  kit?: CommentsKitDTO | null;
}

/** Poll the engagement-kit job until it finishes; resolves with the kit. */
export async function pollComments(
  videoId: string,
  opts: PollOpts = {}
): Promise<CommentsKitDTO | null> {
  const interval = opts.intervalMs ?? 2500;
  const timeout = opts.timeoutMs ?? 4 * 60 * 1000;
  const deadline = Date.now() + timeout;

  for (;;) {
    const res = await fetch(`/api/videos/${videoId}/comments`, {
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data: CommentsResponse = await res.json();

    if (!data.generating) {
      if (data.error) throw new Error(data.error);
      return data.kit ?? null;
    }

    if (Date.now() > deadline)
      throw new Error(
        "Engagement kit is taking unusually long — it may still be running; check back shortly."
      );

    await sleep(interval);
  }
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
