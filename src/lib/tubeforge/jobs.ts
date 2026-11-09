// Persistent background job registry + durable queue integration (Stage 3).
//
// Stage 1/2 model: startJob ran the closure fire-and-forget inside the web
// process; DB rows were a visibility mirror; a crash meant "interrupted, run
// again" for every in-flight stage.
//
// Stage 3 (T-3.5) model: startJob ENQUEUES. The row starts "pending"; the
// queue (queue.ts) claims it atomically, runs it under the captured tenant
// ctx, retries with backoff, and persists cancellation across processes.
// Kinds with registered handlers (queue-handlers.ts) survive a full process
// crash: boot recovery flips their stale rows back to "pending".
//
// This module keeps the Stage-1/2 public surface EXACTLY: isJobRunning,
// requestJobCancel, isJobCancelled, jobStartedAt, lastJobError,
// setJobProgress, jobProgress, jobSnapshot, characterJobSnapshot,
// jobHistory, ensureRecovered, startJob — 22 route call sites unchanged.

import { db, rawDatabase } from "./tenant-db";
import { currentCtx, withCtxNull, type TenantCtx } from "./tenant";
import { errorText } from "@/lib/tubeforge/redact";
import { JobCancelledError } from "./cancel";
import { log } from "./log";
import {
  createPendingJob,
  registerClosure,
  kickQueue,
  reenqueueIfHandlerKind,
  onJobClaimed,
  onJobFinished,
  claimIsStale,
} from "./queue";

// S57/T-57.2 — the module's logger (the old [jobs]/[job:k] string prefixes
// became bindings; the lines are now structured JSON).
const jobsLog = log.child({ mod: "jobs" });

export type JobKind =
  | "voiceover"
  | "thumbnail"
  | "variants"
  | "portrait"
  | "poses"
  | "storyboard"
  | "render"
  | "scene" // single storyboard scene re-roll
  | "slide" // single keynote slide design re-roll (Scene Studio)
  | "verify" // ASR narration check
  | "comments" // engagement kit (pinned comment + replies)
  | "upload" // YouTube OAuth upload
  | "short" // 9:16 vertical cut (Phase 5)
  | "convert" // classic narration script -> scene-based story
  | "stock" // stock b-roll fetch (Pexels/Pixabay)
  | "research" // Topic Radar scan (Stage 1, T-1.10 — jobbed off the request path)
  | "script" // (re)generate the script package — retry after a failed create, or re-roll
  | "director" // Stage 5 — LLM shot-list pass (AI suggests, human approves)
  | "continuity" // Stage 5 — VLM per-scene character-continuity check
  | "qc" // Stage 6 — re-run the QC battery against the existing final.mp4
  | "whiteboard"; // S67 — Whiteboard Engine full render / scene preview (E9 Phase A)

export type JobStatus = "pending" | "running" | "done" | "failed" | "interrupted" | "cancelled";

/**
 * Thrown by cancellable loops when a user requested cancellation.
 * Re-exported from cancel.ts — Stage 3 unified the TWO same-named classes
 * (jobs.ts + cancel.ts) that previously made instanceof checks miss, so a
 * cancelled script job was recorded "failed" instead of "cancelled".
 */
export { JobCancelledError };

interface RunningEntry {
  jobId: string;
  startedAt: number;
}

// Singletons on globalThis so HMR module reloads share the same live state
// with closures still executing from a previous module instance.
interface JobState {
  running: Map<string, RunningEntry>; // key -> active job
  queued: Set<string>; // key -> enqueued, not yet claimed (Stage 3)
  lastErrors: Map<string, string>;
  progress: Map<string, { current: number; total: number; label: string }>;
  cancelled: Set<string>; // keys with a pending cancel request (in-process fast path)
  bootTs: number; // process boot time — rows older than this are from a dead process
  recoveryPromise: Promise<void> | null;
}

const g = globalThis as typeof globalThis & { __tfJobs?: JobState };
const state: JobState = (g.__tfJobs ??= {
  running: new Map(),
  queued: new Set(),
  lastErrors: new Map(),
  progress: new Map(),
  cancelled: new Set(),
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
  slide: "slide design",
  verify: "narration check",
  comments: "engagement kit",
  upload: "YouTube upload",
  short: "vertical short",
  convert: "scene conversion",
  stock: "stock b-roll",
  research: "Topic Radar scan",
  script: "script",
  director: "director pass", // Stage 5 — was missing from this map until the
  continuity: "continuity check", // S33 contract-drift fix caught the family
  qc: "quality check",
  whiteboard: "whiteboard render", // S67
};

/** Human label for an interrupted stage ("voiceover" -> "Voiceover"). */
const stageLabel = (kind: string) => STAGE_LABEL[kind] ?? kind;

// ---------------------------------------------------------------------------
// Queue lifecycle bridge — the queue owns execution; this module owns the
// in-memory view the UI polls (isJobRunning / progress / lastError).

onJobClaimed((jobId, kind, entityId) => {
  const k = key(entityId, kind);
  state.queued.delete(k);
  state.lastErrors.delete(k);
  state.progress.delete(k);
  state.cancelled.delete(k);
  state.running.set(k, { jobId, startedAt: Date.now() });
});

onJobFinished((jobId, kind, entityId, status, errorMessage) => {
  const k = key(entityId, kind);
  state.running.delete(k);
  state.queued.delete(k);
  state.progress.delete(k);
  state.cancelled.delete(k);
  if ((status === "failed" || status === "cancelled" || status === "interrupted") && errorMessage) {
    state.lastErrors.set(k, errorMessage);
  }
});

// ---------------------------------------------------------------------------
// Boot recovery

/**
 * One-time boot recovery: any "running" Job row started before this process
 * booted belongs to a dead process. Kinds with a registered handler are
 * flipped back to "pending" (the queue resumes them automatically); the rest
 * are marked "interrupted" and their owning video/character gets a visible
 * error so polling clients stop waiting and the UI explains what happened.
 */
async function runRecovery(): Promise<void> {
  // Boot recovery must see EVERY organization's stale rows — never the
  // per-request scope (it can be triggered from inside a scoped request).
  return withCtxNull(async () => {
    const rawDb = rawDatabase;
    const stale = await rawDb.job.findMany({ where: { status: "running" } });

    for (const row of stale) {
      if (row.startedAt.getTime() >= state.bootTs) continue; // started in this process — alive or HMR orphan

      // Stage 3 multi-process guard: a running row claimed by a LIVE process
      // (standalone worker, second web dyno) is NOT stale just because it
      // started before this process booted. Only unclaimed rows, previous
      // incarnations of this process, or provably dead claimers are recovered.
      if (!claimIsStale(row.claimedBy)) continue;

      // Durable resume: handler kinds go back to the queue instead of dying.
      // S67 — the whiteboard FULL render's idempotence wall first: a render
      // whose final.mp4 already landed (crash between the last assembly and
      // the row update) must be marked done, not re-enqueued — re-rendering
      // an 18-minute chromium job to no effect is exactly the waste the
      // budget laws exist to prevent. Scene previews (composite
      // <videoId>#wb<sceneId> entityIds) re-render cheaply at 720p and ride
      // the normal resume; only the full-render rows (plain videoId) gate.
      if (row.kind === "whiteboard" && row.entityId === baseEntityId(row.entityId)) {
        const wbVideo = await rawDb.video.findUnique({ where: { id: row.entityId } });
        if (wbVideo && wbVideo.hasVideo && wbVideo.renderMode === "whiteboard") {
          await rawDb.job.update({
            where: { id: row.id },
            data: { status: "done", endedAt: new Date() },
          });
          jobsLog.warn("recovered stale whiteboard job — artifact already landed, marked done", {
            kind: row.kind,
            jobId: row.id,
            entityId: row.entityId,
          });
          continue;
        }
      }
      const resumed = await reenqueueIfHandlerKind(row.id, row.kind).catch(() => false);
      if (resumed) {
        jobsLog.warn("recovered stale job — re-enqueued", { kind: row.kind, jobId: row.id, entityId: row.entityId });
        continue;
      }

      const message = `Server restarted while this ${stageLabel(row.kind)} was running — run the stage again.`;

      try {
        await rawDb.job.update({
          where: { id: row.id },
          data: { status: "interrupted", error: message, endedAt: new Date() },
        });

        // Surface the interruption where the UI already looks for errors.
        // (director/continuity joined in the S33 drift fix: their outputs are
        // advisory reports, so there is no artifactLanded case — an
        // interrupted pass simply tells the user to re-run. Unreachable today
        // while every kind is handler-registered; this is the defense for the
        // day one isn't.)
        if (["voiceover", "thumbnail", "variants", "storyboard", "render", "scene", "slide", "verify", "comments", "upload", "short", "convert", "script", "stock", "qc", "director", "continuity", "whiteboard"].includes(row.kind)) {
          const videoId = baseEntityId(row.entityId);
          const video = await rawDb.video.findUnique({ where: { id: videoId } });
          // Only set the error if the artifact never landed (completed after the row went stale).
          if (video) {
            const artifactLanded =
              (row.kind === "voiceover" && video.hasVoiceover) ||
              (row.kind === "thumbnail" && video.hasThumbnail) ||
              (row.kind === "variants" && video.hasThumbnail) ||
              (row.kind === "storyboard" && video.hasStoryboard) ||
              (row.kind === "scene" && video.hasStoryboard) ||
              (row.kind === "slide" && video.hasVideo) ||
              (row.kind === "render" && video.hasVideo) ||
              (row.kind === "comments" && Boolean(video.commentsKit)) ||
              (row.kind === "upload" && Boolean(video.youtubeUrl)) ||
              (row.kind === "short" && video.hasShort) ||
              (row.kind === "convert" && video.format === "story") ||
              (row.kind === "script" && Boolean(video.script)) ||
              (row.kind === "stock" && Boolean(video.scenes && video.scenes.includes('"stock"'))) ||
              (row.kind === "qc" && Boolean(video.qcReport)) ||
              (row.kind === "whiteboard" && video.hasVideo);
            if (!artifactLanded && !video.error)
              await rawDb.video.update({ where: { id: videoId }, data: { error: message } });
          }
        } else if (row.kind === "portrait" || row.kind === "poses") {
          // Characters have no error column — mirror into the in-memory map
          // that serializeCharacter() reads (this process's map is fresh/empty).
          state.lastErrors.set(key(row.entityId, row.kind as JobKind), message);
        }

        jobsLog.warn("recovered stale job — interrupted", { kind: row.kind, jobId: row.id, entityId: row.entityId });
      } catch (err) {
        jobsLog.error("recovery failed for job", { jobId: row.id, err });
      }
    }
  });
}

/**
 * Boot recovery: any "running" Job row started before this process booted
 * belongs to a dead process — resume it (handler kinds) or mark it
 * interrupted with a readable error.
 *
 * Runs on EVERY startJob/jobHistory call (a cheap indexed scan); concurrent
 * callers share the in-flight promise. Live jobs of this process are safe:
 * they always have startedAt >= bootTs, which the scan ignores.
 */
export function ensureRecovered(): Promise<void> {
  if (!state.recoveryPromise) {
    state.recoveryPromise = runRecovery()
      .catch((err) => jobsLog.error("recovery crashed", { err }))
      .finally(() => {
        state.recoveryPromise = null;
      });
  }
  return state.recoveryPromise;
}

// ---------------------------------------------------------------------------
// In-memory job view (UI contract)

export function isJobRunning(entityId: string, kind: JobKind): boolean {
  return state.running.has(key(entityId, kind)) || state.queued.has(key(entityId, kind));
}

/**
 * Request cancellation of one running job (all running jobs when kind
 * omitted). Stage 3: the request ALSO lands in the Job row
 * (cancelRequested) so it is visible to the executing process even when
 * that is a different one (standalone worker), and pending jobs that were
 * cancelled before starting never run.
 */
export function requestJobCancel(entityId: string, kind?: JobKind): JobKind[] {
  const cancelled: JobKind[] = [];
  const prefix = `${entityId}:`;
  for (const k of state.running.keys()) {
    if (!k.startsWith(prefix)) continue;
    if (kind && k !== key(entityId, kind)) continue;
    state.cancelled.add(k);
    cancelled.push(k.slice(prefix.length) as JobKind);
  }
  for (const k of state.queued.keys()) {
    if (!k.startsWith(prefix)) continue;
    if (kind && k !== key(entityId, kind)) continue;
    state.cancelled.add(k);
    if (!cancelled.includes(k.slice(prefix.length) as JobKind)) {
      cancelled.push(k.slice(prefix.length) as JobKind);
    }
  }

  // Persist cross-process. Fire-and-forget: the in-memory flag above already
  // covers the local case; the row covers the worker + not-yet-claimed cases.
  void withCtxNull(() =>
    rawDatabase.job.updateMany({
      where: {
        entityId,
        ...(kind ? { kind } : {}),
        status: { in: ["pending", "running"] },
      },
      data: { cancelRequested: true },
    })
  ).catch(() => {});

  return cancelled;
}

/** True when a cancel request is pending for this job (checked by long loops). */
export function isJobCancelled(entityId: string, kind: JobKind): boolean {
  return state.cancelled.has(key(entityId, kind));
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

// ---------------------------------------------------------------------------
// startJob — enqueue

/**
 * Enqueue a background job. Returns false if an identical job is already
 * in flight or queued (dedupes double-clicks and concurrent stages).
 *
 * The work runs when the queue claims the row (typically within one tick —
 * ~1s worst case, near-zero when the process is idle). The closure captures
 * the REQUEST's tenant context at enqueue time; the queue re-enters it for
 * execution, so tenant scoping survives the deferred call.
 *
 * opts.payload — the request-scoped options (render mode, scene instruction,
 * voiceover source pointer, …), JSON-encoded into the Job row. After a
 * process crash the kind's registered handler re-runs the job from DB state
 * + this payload, so the caller's choices survive the restart instead of
 * degrading to factory defaults. Keep it small and plain-JSON.
 *
 * Fallback: if the Job row cannot be created (DB hiccup) or there is no
 * tenant context to attribute it to, the closure runs untracked in-process
 * exactly like Stage 1 — a durability downgrade, never a functional one.
 */
export async function startJob(
  entityId: string,
  kind: JobKind,
  fn: () => Promise<void>,
  opts: { payload?: unknown } = {}
): Promise<boolean> {
  await ensureRecovered();

  const k = key(entityId, kind);
  if (state.running.has(k) || state.queued.has(k)) return false;

  // Cross-process dedupe: a pending OR running row from ANOTHER process
  // (the worker) must block a duplicate enqueue — the in-memory check above
  // only sees this process's jobs. Phase 0 audit R-01: checking only
  // "pending" left a window where a re-click during a worker-executed job
  // could enqueue a second billable job for the same logical work. A stale
  // running row left by a dead process is re-pended by boot recovery /
  // claim liveness, so the block is bounded — and failing closed is the
  // safe direction.
  const alreadyQueued = await db.job
    .findFirst({
      where: { entityId, kind, status: { in: ["pending", "running"] } },
      select: { id: true },
    })
    .catch(() => null);
  if (alreadyQueued) return false;

  state.lastErrors.delete(k);
  state.progress.delete(k);
  state.cancelled.delete(k);

  const jobCtx: TenantCtx | null = currentCtx();
  let jobId: string | null = null;
  if (jobCtx) {
    try {
      jobId = (
        await createPendingJob({
          organizationId: jobCtx.organizationId,
          userId: jobCtx.userId,
          kind,
          entityId,
          payload: opts.payload,
        })
      ).jobId;
    } catch (err) {
      // DB hiccup — run untracked (Stage-1 behavior) rather than block the stage.
      jobsLog.error("failed to persist job row — running untracked", { err });
    }
  } else {
    jobsLog.warn("job started outside a tenant context — running untracked");
  }

  if (!jobId) {
    // Untracked fallback: fire-and-forget, in-memory state only.
    state.running.set(k, { jobId: "", startedAt: Date.now() });
    void (async () => {
      try {
        await fn();
      } catch (err) {
        const cancelled = err instanceof JobCancelledError;
        const message = errorText(err, `${kind} job failed`);
        state.lastErrors.set(k, message);
        if (!cancelled) jobsLog.error("job failed", { key: k, err: message });
      } finally {
        state.running.delete(k);
        state.progress.delete(k);
        state.cancelled.delete(k);
      }
    })();
    return true;
  }

  registerClosure(jobId, fn, jobCtx);
  state.queued.add(k);
  kickQueue(); // claim immediately when a slot is free

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
  short: boolean;
  convert: boolean;
  script: boolean;
  stock: boolean;
  qc: boolean;
  whiteboard: boolean;
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
    short: isJobRunning(videoId, "short"),
    convert: isJobRunning(videoId, "convert"),
    script: isJobRunning(videoId, "script"),
    stock: isJobRunning(videoId, "stock"),
    qc: isJobRunning(videoId, "qc"),
    whiteboard: isJobRunning(videoId, "whiteboard"),
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
