// In-process background job registry for long-running AI stages.
// Stage POSTs return 202 immediately so preview proxies/gateways never time out
// (long requests were killed with 502 Bad Gateway). Clients poll for completion.

export type JobKind =
  | "voiceover"
  | "thumbnail"
  | "variants"
  | "portrait"
  | "poses"
  | "storyboard"
  | "render"
  | "scene"; // single storyboard scene re-roll

const running = new Map<string, number>(); // key -> startedAt (ms)
const lastErrors = new Map<string, string>(); // key -> last failure message
const progress = new Map<string, { current: number; total: number; label: string }>();

const key = (entityId: string, kind: JobKind) => `${entityId}:${kind}`;

export function isJobRunning(entityId: string, kind: JobKind): boolean {
  return running.has(key(entityId, kind));
}

export function jobStartedAt(entityId: string, kind: JobKind): number | null {
  return running.get(key(entityId, kind)) ?? null;
}

export function lastJobError(entityId: string, kind: JobKind): string | null {
  return lastErrors.get(key(entityId, kind)) ?? null;
}

/** Report human-readable progress for a running job (render: scene 3 of 6). */
export function setJobProgress(
  entityId: string,
  kind: JobKind,
  current: number,
  total: number,
  label: string
): void {
  if (!running.has(key(entityId, kind))) return;
  progress.set(key(entityId, kind), { current, total, label });
}

export function jobProgress(
  entityId: string,
  kind: JobKind
): { current: number; total: number; label: string } | null {
  return progress.get(key(entityId, kind)) ?? null;
}

/**
 * Launch a fire-and-forget background job. Returns false if an identical job
 * is already in flight (dedupes double-clicks and concurrent stages).
 * The promise keeps running inside the Node process regardless of whether the
 * HTTP client (or proxy) disconnects.
 */
export function startJob(
  entityId: string,
  kind: JobKind,
  fn: () => Promise<void>
): boolean {
  const k = key(entityId, kind);
  if (running.has(k)) return false;

  lastErrors.delete(k);
  progress.delete(k);
  running.set(k, Date.now());

  void fn()
    .catch((err) => {
      const message = err instanceof Error ? err.message : `${kind} job failed`;
      lastErrors.set(k, message);
      console.error(`[job:${k}] failed:`, message);
    })
    .finally(() => {
      running.delete(k);
      progress.delete(k);
    });

  return true;
}

/** Snapshot of all running jobs for a video — merged into GET video responses. */
export function jobSnapshot(videoId: string): {
  voiceover: boolean;
  thumbnail: boolean;
  variants: boolean;
  storyboard: boolean;
  render: boolean;
} {
  return {
    voiceover: isJobRunning(videoId, "voiceover"),
    thumbnail: isJobRunning(videoId, "thumbnail"),
    variants: isJobRunning(videoId, "variants"),
    storyboard: isJobRunning(videoId, "storyboard"),
    render: isJobRunning(videoId, "render"),
  };
}

/** Snapshot of the image jobs for a character — merged into GET character responses. */
export function characterJobSnapshot(characterId: string): {
  portrait: boolean;
  poses: boolean;
} {
  return {
    portrait: isJobRunning(characterId, "portrait"),
    poses: isJobRunning(characterId, "poses"),
  };
}
