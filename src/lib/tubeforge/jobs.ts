// Persistent background job registry for long-running AI stages.
// Stage POSTs return 202 immediately so preview proxies/gateways never time out
// (long requests were killed with 502 Bad Gateway). Clients poll for completion.
//
// Phase 3: job state is mirrored into the DB `Job` table so it survives server
// restarts. On boot, "running" rows left over from a dead process are marked
// `interrupted` and their owning video/character gets a visible error — users
// see "server restarted mid-stage, run it again" instead of a spinner that
// never resolves.

import { db } from "@/lib/db";

export type JobKind =
  | "voiceover"
  | "thumbnail"
  | "variants"
  | "portrait"
  | "poses"
  | "storyboard"
  | "render"
  | "scene" // single storyboard scene re-roll
  | "verify" // ASR narration check
  | "comments" // engagement kit (pinned comment + replies)
  | "upload"; // YouTube OAuth upload

export type JobStatus = "running" | "done" | "failed" | "interrupted";

interface RunningEntry {
  jobId: string;
  startedAt: number;
}

// Singletons on globalThis so HMR module reloads share the same live state
// with closures still executing from a previous module instance.
interface JobState {
  running: Map<string, RunningEntry>; // key -> active job
  lastErrors: Map<string, string>;
  progress: Map<string, { current: number; total: number; label: string }>;
  bootTs: number; // process boot time — rows older than this are from a dead process
  recoveryPromise: Promise<void> | null;
}

const g = globalThis as typeof globalThis & { __tfJobs?: JobState };
const state: JobState = (g.__tfJobs ??= {
  running: new Map(),
  lastErrors: new Map(),
  progress: new Map(),
  bootTs: Date.now(),
  recoveryPromise: null,
});

const key = (entityId: string, kind: JobKind) => `${entityId}:${kind}`;

/** Base entity id — scene jobs use "<videoId>#scene<N>". */
const baseEntityId = (entityId: string) => entityId.split("#")[0];

const STAGE_LABEL: Record<string, string> = {
  voiceover: "voiceover",
  thumbnail: "thumbnail",
  variants: "A/B thumbnail set",
  portrait: "portrait",
  poses: "consistency sheet",
  storyboard: "storyboard",
  render: "video render",
  scene: "storyboard scene",
  verify: "narration check",
  comments: "engagement kit",
  upload: "YouTube upload",
};

/** Human label for an interrupted stage ("voiceover" -> "Voiceover"). */
const stageLabel = (kind: string) => STAGE_LABEL[kind] ?? kind;

/**
 * One-time boot recovery: any "running" Job row started before this process
 * booted belongs to a dead process — mark it interrupted and surface a
 * readable error on the owning video / character so polling clients stop
 * waiting and the UI explains what happened.
 */
async function runRecovery(): Promise<void> {
  const stale = await db.job.findMany({ where: { status: "running" } });

  for (const row of stale) {
    if (row.startedAt.getTime() >= state.bootTs) continue; // started in this process — alive or HMR orphan

    const message = `Server restarted while this ${stageLabel(row.kind)} was running — run the stage again.`;

    try {
      await db.job.update({
        where: { id: row.id },
        data: { status: "interrupted", error: message, endedAt: new Date() },
      });

      // Surface the interruption where the UI already looks for errors.
      if (["voiceover", "thumbnail", "variants", "storyboard", "render", "scene", "verify", "comments", "upload"].includes(row.kind)) {
        const videoId = baseEntityId(row.entityId);
        const video = await db.video.findUnique({ where: { id: videoId } });
        // Only set the error if the artifact never landed (completed after the row went stale).
        if (video) {
          const artifactLanded =
            (row.kind === "voiceover" && video.hasVoiceover) ||
            (row.kind === "thumbnail" && video.hasThumbnail) ||
            (row.kind === "variants" && video.hasThumbnail) ||
            (row.kind === "storyboard" && video.hasStoryboard) ||
            (row.kind === "scene" && video.hasStoryboard) ||
            (row.kind === "render" && video.hasVideo) ||
            (row.kind === "comments" && Boolean(video.commentsKit)) ||
            (row.kind === "upload" && Boolean(video.youtubeUrl));
          if (!artifactLanded && !video.error)
            await db.video.update({ where: { id: videoId }, data: { error: message } });
        }
      } else if (row.kind === "portrait" || row.kind === "poses") {
        // Characters have no error column — mirror into the in-memory map
        // that serializeCharacter() reads (this process's map is fresh/empty).
        state.lastErrors.set(key(row.entityId, row.kind), message);
      }

      console.warn(`[jobs] recovered stale ${row.kind} job ${row.id} (entity ${row.entityId}) -> interrupted`);
    } catch (err) {
      console.error("[jobs] recovery failed for job", row.id, err);
    }
  }
}

/**
 * Boot recovery: any "running" Job row started before this process booted
 * belongs to a dead process — mark it interrupted and surface a readable
 * error on the owning video / character so polling clients stop waiting and
 * the UI explains what happened.
 *
 * Runs on EVERY startJob/jobHistory call (a cheap indexed scan); concurrent
 * callers share the in-flight promise. Live jobs of this process are safe:
 * they always have startedAt >= bootTs, which the scan ignores.
 */
export function ensureRecovered(): Promise<void> {
  if (!state.recoveryPromise) {
    state.recoveryPromise = runRecovery()
      .catch((err) => console.error("[jobs] recovery crashed:", err))
      .finally(() => {
        state.recoveryPromise = null;
      });
  }
  return state.recoveryPromise;
}

export function isJobRunning(entityId: string, kind: JobKind): boolean {
  return state.running.has(key(entityId, kind));
}

export function jobStartedAt(entityId: string, kind: JobKind): number | null {
  return state.running.get(key(entityId, kind))?.startedAt ?? null;
}

export function lastJobError(entityId: string, kind: JobKind): string | null {
  return state.lastErrors.get(key(entityId, kind)) ?? null;
}

/** Report human-readable progress for a running job (render: scene 3 of 6). */
export function setJobProgress(
  entityId: string,
  kind: JobKind,
  current: number,
  total: number,
  label: string
): void {
  const k = key(entityId, kind);
  if (!state.running.has(k)) return;
  state.progress.set(k, { current, total, label });

  // Persist for the job-history panel (cheap: render calls this a handful of times).
  const entry = state.running.get(k);
  if (entry) {
    const ratio = total > 0 ? Math.min(1, current / total) : null;
    void db.job
      .update({ where: { id: entry.jobId }, data: { progress: ratio, label } })
      .catch(() => {});
  }
}

export function jobProgress(
  entityId: string,
  kind: JobKind
): { current: number; total: number; label: string } | null {
  return state.progress.get(key(entityId, kind)) ?? null;
}

/**
 * Launch a fire-and-forget background job. Returns false if an identical job
 * is already in flight (dedupes double-clicks and concurrent stages).
 * The promise keeps running inside the Node process regardless of whether the
 * HTTP client (or proxy) disconnects; the DB row records the outcome so a
 * server crash can be detected after restart.
 */
export async function startJob(
  entityId: string,
  kind: JobKind,
  fn: () => Promise<void>
): Promise<boolean> {
  await ensureRecovered();

  const k = key(entityId, kind);
  if (state.running.has(k)) return false;

  state.lastErrors.delete(k);
  state.progress.delete(k);

  let jobId: string | null = null;
  try {
    const row = await db.job.create({
      data: { kind, entityId, status: "running", startedAt: new Date() },
    });
    jobId = row.id;
  } catch (err) {
    // DB hiccup must not block the stage itself — run untracked.
    console.error("[jobs] failed to persist job row:", err);
  }

  state.running.set(k, { jobId: jobId ?? "", startedAt: Date.now() });

  void fn()
    .then(async () => {
      if (jobId)
        await db.job
          .update({ where: { id: jobId }, data: { status: "done", endedAt: new Date(), progress: 1 } })
          .catch(() => {});
    })
    .catch(async (err) => {
      const message = err instanceof Error ? err.message : `${kind} job failed`;
      state.lastErrors.set(k, message);
      console.error(`[job:${k}] failed:`, message);
      if (jobId)
        await db.job
          .update({ where: { id: jobId }, data: { status: "failed", error: message, endedAt: new Date() } })
          .catch(() => {});
    })
    .finally(() => {
      state.running.delete(k);
      state.progress.delete(k);
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
  verify: boolean;
  comments: boolean;
  upload: boolean;
} {
  return {
    voiceover: isJobRunning(videoId, "voiceover"),
    thumbnail: isJobRunning(videoId, "thumbnail"),
    variants: isJobRunning(videoId, "variants"),
    storyboard: isJobRunning(videoId, "storyboard"),
    render: isJobRunning(videoId, "render"),
    verify: isJobRunning(videoId, "verify"),
    comments: isJobRunning(videoId, "comments"),
    upload: isJobRunning(videoId, "upload"),
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

/** Recent jobs for the history panel, with entity titles resolved. */
export async function jobHistory(limit = 20) {
  await ensureRecovered();
  const rows = await db.job.findMany({ orderBy: { startedAt: "desc" }, take: limit });

  const videoIds = [
    ...new Set(rows.map((r) => (["portrait", "poses"].includes(r.kind) ? null : baseEntityId(r.entityId))).filter((v): v is string => Boolean(v))),
  ];
  const characterIds = [
    ...new Set(rows.filter((r) => r.kind === "portrait" || r.kind === "poses").map((r) => r.entityId)),
  ];

  const [videos, characters] = await Promise.all([
    videoIds.length
      ? db.video.findMany({ where: { id: { in: videoIds } }, select: { id: true, title: true, topic: true } })
      : Promise.resolve([]),
    characterIds.length
      ? db.character.findMany({ where: { id: { in: characterIds } }, select: { id: true, name: true } })
      : Promise.resolve([]),
  ]);

  const titleById = new Map<string, string>();
  for (const v of videos) titleById.set(v.id, v.title || v.topic || "Untitled video");
  for (const c of characters) titleById.set(c.id, c.name);

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    entityId: r.entityId,
    status: r.status as JobStatus,
    progress: r.progress,
    label: r.label,
    error: r.error,
    startedAt: r.startedAt.toISOString(),
    endedAt: r.endedAt ? r.endedAt.toISOString() : null,
    durationMs: r.endedAt ? r.endedAt.getTime() - r.startedAt.getTime() : null,
    entityTitle: titleById.get(baseEntityId(r.entityId)) ?? null,
  }));
}
