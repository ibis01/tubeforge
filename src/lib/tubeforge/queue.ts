// Durable job queue (Stage 3, T-3.5).
//
// Replaces the fire-and-forget `void fn()` execution model with a DB-backed
// queue: jobs are claimed atomically, retried with exponential backoff,
// cancellable across processes, capped per organization, and re-enqueued
// after a process death when their kind can be rebuilt from DB state.
//
// Why DB-backed instead of Redis/BullMQ (the roadmap's production choice):
// this deployment runs without Redis. The claim primitive is an atomic
// `UPDATE ... WHERE status = 'pending'` which is correct on SQLite AND
// Postgres, so the semantics below are real, not simulated:
//   * durability      — a claimed job's row survives any crash
//   * retries         — attempts + maxAttempts + nextRunAt backoff
//   * cancellation    — cancelRequested is a DB flag every process sees
//   * fairness        — one claim scan ordered by nextRunAt
//   * per-org caps    — heavy ffmpeg kinds capped per organization
//   * restart resume  — boot recovery re-enqueues handler-registered kinds
// The QueueDriver seam (claim/complete/fail) stays one interface wide so a
// BullMQ driver can replace the SQL when infrastructure is provisioned.
//
// S100 / P0.2 — the claim is now a RENEWABLE LEASE with a FENCING TOKEN
// (docs/production-readiness.md, gate P0.2): every claim stamps leaseToken
// (monotonic per job) + leaseExpiresAt; the executing process renews at
// TTL/3; any process may reap expired leases back to pending — bumping the
// token; and EVERY terminal write is conditional on the current token, so a
// worker that lost its lease physically cannot overwrite the newer claimant
// — its results are discarded. Cross-process recovery no longer depends on
// same-host pid checks (those remain only as the boot-recovery shortcut for
// pre-lease legacy rows).

import { rawDatabase, db } from "./tenant-db";
import { withCtx, withCtxNull, type TenantCtx } from "./tenant";
import { errorText } from "@/lib/tubeforge/redact";
import { log } from "./log";
import { JobCancelledError, requestCancel, runWithCancelKey } from "./cancel";
import type { JobKind } from "./jobs";
import type { Prisma } from "@prisma/client";

// ---------------------------------------------------------------------------
// Configuration

/** Tick cadence — how often the claim scan runs. */
export const QUEUE_TICK_MS = 1_000;
/** Claims per tick (bounded so one hot loop can't starve the event loop). */
const CLAIM_BATCH = 4;
/**
 * Max concurrently EXECUTING jobs in this process. ffmpeg stages are also
 * gated per-org (below); this cap protects the process itself.
 */
const MAX_ACTIVE_PER_PROCESS = Number(process.env.TUBEFORGE_MAX_ACTIVE_JOBS ?? 8);
/** Heavy ffmpeg kinds subject to the per-organization cap. S67: whiteboard
 *  joins — chromium + ffmpeg is the same CPU/RAM class (design §3.2). */
const HEAVY_KINDS: readonly JobKind[] = ["render", "short", "convert", "whiteboard"];
/** Per-org concurrent heavy jobs (ffmpeg is CPU/RAM bound). */
const MAX_HEAVY_PER_ORG = Number(process.env.TUBEFORGE_MAX_RENDER_CONCURRENCY ?? 2);
/** Retry backoff: 30s, 60s, 120s … capped at 10 min, +0–2s jitter. */
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 10 * 60_000;
/**
 * Claim attempts allowed before a job sticks as "failed". Note the AI call
 * layer already retries transient 500s internally (budget.ts withRetry ×3) —
 * queue attempts are for whole-job re-runs (e.g. process death mid-stage).
 * script = 1 because runScriptJob carries its own 6-round storm patience;
 * queue-level retries would multiply 2.5h into 7.5h. voiceover / variants /
 * poses = 1 for the same reason — they are multi-call AI stages whose calls
 * already retry internally, and a whole-job re-run re-pays every call.
 */
const MAX_ATTEMPTS_BY_KIND: Partial<Record<JobKind, number>> = {
  script: 1,
  research: 2,
  stock: 2,
  voiceover: 1,
  variants: 1,
  poses: 1,
  // Stage 5 — the director pass and continuity check are single LLM/VLM
  // stages whose calls already retry internally (budget.ts withRetry);
  // a whole-job re-run would re-pay every call.
  director: 1,
  continuity: 1,
};
const DEFAULT_MAX_ATTEMPTS = 2;

/**
 * S100 / P0.2 — the lease. A claim is a LEASE, not ownership: the executor
 * must renew it (every LEASE_RENEW_MS = TTL/3) or any process may reap the
 * row once the deadline passes, bump the fencing token, and re-run the job.
 * A missed renewal must NOT lose the lease — renewal sits strictly inside
 * the TTL with three chances before expiry at the default cadence.
 */
export const LEASE_TTL_MS = Number(process.env.TUBEFORGE_LEASE_TTL_MS ?? 90_000);
export const LEASE_RENEW_MS = Math.max(5_000, Math.floor(LEASE_TTL_MS / 3));

// ---------------------------------------------------------------------------
// State (globalThis so Next.js HMR reloads keep sharing it)

interface QueuedClosure {
  fn: () => Promise<void>;
  /** Tenant ctx captured at enqueue time — ALS does NOT survive deferred
   *  invocation, so the queue re-enters it explicitly before running fn. */
  ctx: TenantCtx | null;
  registeredAt: number;
}

interface QueueState {
  closures: Map<string, QueuedClosure>; // jobId -> closure (this process only)
  timer: NodeJS.Timeout | null;
  ticking: boolean;
  active: number; // executing in THIS process
  workerId: string; // "<role>:<pid>:<bootTs>"
  role: "web" | "worker";
  /** enqueueOnly mode — web dynamos in a dedicated-worker topology. */
  noClaim: boolean;
  cancelWatchers: Map<string, NodeJS.Timeout>; // jobId -> cancel poll interval
}

const g = globalThis as typeof globalThis & { __tfQueue?: QueueState };
const state: QueueState = (g.__tfQueue ??= {
  closures: new Map(),
  timer: null,
  ticking: false,
  active: 0,
  workerId: "web:0:0",
  role: "web",
  noClaim: process.env.TUBEFORGE_NO_CLAIM === "1",
  cancelWatchers: new Map(),
});

/** Bounded closure registry — stale entries (job finished elsewhere) evict. */
const MAX_CLOSURES = 300;

export function initQueue(role: "web" | "worker" = "web"): void {
  state.role = role;
  state.workerId = `${role}:${process.pid}:${Date.now().toString(36)}`;
  startQueueLoop();
}

/**
 * Pause/resume claiming in THIS process (in-flight jobs still finish).
 * Test harnesses use it to hand the queue over to a spawned worker; a real
 * deployment achieves the same with TUBEFORGE_NO_CLAIM=1 at boot.
 */
export function setClaiming(enabled: boolean): void {
  state.noClaim = !enabled;
}

export function queueWorkerId(): string {
  return state.workerId;
}

// ---------------------------------------------------------------------------
// Lifecycle listeners — jobs.ts subscribes to mirror the in-memory view the
// UI polls (isJobRunning / progress / lastError). Decouples queue execution
// from the registry without an import cycle.

export type JobClaimedListener = (jobId: string, kind: JobKind, entityId: string) => void;
export type JobFinishedListener = (
  jobId: string,
  kind: JobKind,
  entityId: string,
  status: "done" | "cancelled" | "failed" | "interrupted",
  errorMessage: string | null
) => void;

const listeners: { claimed: Set<JobClaimedListener>; finished: Set<JobFinishedListener> } = {
  claimed: new Set(),
  finished: new Set(),
};

export function onJobClaimed(cb: JobClaimedListener): void {
  listeners.claimed.add(cb);
}

export function onJobFinished(cb: JobFinishedListener): void {
  listeners.finished.add(cb);
}

function emitClaimed(jobId: string, kind: JobKind, entityId: string): void {
  for (const cb of listeners.claimed) {
    try { cb(jobId, kind, entityId); } catch (err) { log.error("claimed listener crashed", { err }); }
  }
}

function emitFinished(
  jobId: string,
  kind: JobKind,
  entityId: string,
  status: "done" | "cancelled" | "failed" | "interrupted",
  errorMessage: string | null
): void {
  for (const cb of listeners.finished) {
    try { cb(jobId, kind, entityId, status, errorMessage); } catch (err) { log.error("finished listener crashed", { err }); }
  }
}

// ---------------------------------------------------------------------------
// Handler registry — kinds whose work can be rebuilt from DB state. These
// survive process death: boot recovery re-enqueues them and the standalone
// worker (scripts/worker.mts) can execute them without the original closure.

export type JobHandler = (
  entityId: string,
  /** Parsed Job.payload — the enqueue-time request options (null when the
   *  enqueuing route had nothing request-scoped to preserve). */
  payload: unknown
) => Promise<void>;

const handlers = new Map<JobKind, JobHandler>();

export function registerJobHandler(kind: JobKind, handler: JobHandler): void {
  handlers.set(kind, handler);
}

export function handlerKinds(): JobKind[] {
  return [...handlers.keys()];
}

// ---------------------------------------------------------------------------
// Enqueue

export interface EnqueueResult {
  jobId: string;
}

/**
 * Create a pending Job row. The caller registers the closure right after
 * (registerClosure) and triggers a tick so latency stays ~0 in-process.
 */
export async function createPendingJob(input: {
  organizationId: string;
  userId: string | null;
  kind: JobKind;
  entityId: string;
  /** Request-scoped options for the crash-recovery handler (JSON-encoded). */
  payload?: unknown;
}): Promise<EnqueueResult> {
  const maxAttempts = MAX_ATTEMPTS_BY_KIND[input.kind] ?? DEFAULT_MAX_ATTEMPTS;
  const row = await db.job.create({
    data: {
      organizationId: input.organizationId,
      userId: input.userId,
      kind: input.kind,
      entityId: input.entityId,
      status: "pending",
      maxAttempts,
      nextRunAt: new Date(),
      startedAt: new Date(),
      ...(input.payload === undefined || input.payload === null
        ? {}
        : { payload: JSON.stringify(input.payload) }),
    },
  });
  return { jobId: row.id };
}

/** Register the in-process closure for a job this process created. */
export function registerClosure(jobId: string, fn: () => Promise<void>, ctx: TenantCtx | null): void {
  if (state.closures.size >= MAX_CLOSURES) {
    // Evict the oldest entry — its job either finished or belongs to a dead
    // request; the handler registry is the durable path either way.
    const oldest = state.closures.keys().next().value;
    if (oldest) state.closures.delete(oldest);
  }
  state.closures.set(jobId, { fn, ctx, registeredAt: Date.now() });
}

// ---------------------------------------------------------------------------
// Claim + execute

function backoffMs(attempts: number): number {
  const exp = BACKOFF_BASE_MS * Math.pow(2, Math.max(0, attempts - 1));
  return Math.min(exp, BACKOFF_CAP_MS) + Math.floor(Math.random() * 2_000);
}

// ---------------------------------------------------------------------------
// Claim + lease (S100 / P0.2)

export interface ClaimResult {
  claimed: boolean;
  /** The fencing token stamped by THIS claim (0 when not claimed). */
  leaseToken: number;
}

/**
 * The atomic claim primitive: flips a pending row to running and stamps a
 * fresh MONOTONIC fencing token + lease deadline. Exported for the lease
 * battery (test-queue phase C) — tickQueue is the only in-app caller.
 * Returns claimed=false when another worker holds the row (live lease).
 */
export async function claimJob(jobId: string, workerId: string): Promise<ClaimResult> {
  const claimed = await withCtxNull(() =>
    rawDatabase.job.updateMany({
      where: { id: jobId, status: "pending" },
      data: {
        status: "running",
        claimedBy: workerId,
        claimedAt: new Date(),
        startedAt: new Date(),
        attempts: { increment: 1 },
        leaseToken: { increment: 1 },
        leaseExpiresAt: new Date(Date.now() + LEASE_TTL_MS),
      },
    })
  );
  if (claimed.count !== 1) return { claimed: false, leaseToken: 0 };
  // Read back the token THIS claim stamped (updateMany doesn't return the
  // row). If another claimant snuck in between the two statements — only
  // possible after our lease was reaped — claimedBy won't be ours.
  const row = await withCtxNull(() =>
    rawDatabase.job.findUnique({ where: { id: jobId }, select: { leaseToken: true, claimedBy: true } })
  );
  if (!row || row.claimedBy !== workerId) return { claimed: false, leaseToken: 0 };
  return { claimed: true, leaseToken: row.leaseToken };
}

/**
 * Extend the lease for the CURRENT token. False = lost: another claimant or
 * reap holds a newer token and this worker must stop writing. Throws on
 * transient DB errors — a failed renewal must not be confused with a lost
 * lease (the caller retries next interval; the lease still stands).
 */
export async function renewLease(jobId: string, leaseToken: number): Promise<boolean> {
  const renewed = await withCtxNull(() =>
    rawDatabase.job.updateMany({
      where: { id: jobId, leaseToken, status: "running" },
      data: { leaseExpiresAt: new Date(Date.now() + LEASE_TTL_MS) },
    })
  );
  return renewed.count === 1;
}

/**
 * Expired-lease recovery (S100 / P0.2) — the cross-process story the old
 * module header documented as its known limitation: any "running" row whose
 * lease expired AND whose kind this process can re-execute (a registered
 * handler — the durable resume path) is flipped back to pending and its
 * fencing token BUMPED, which instantly blinds the previous claimant's
 * writes. NULL-lease legacy rows never match (SQL NULL is not lt now) —
 * they keep the boot-recovery contract. Safe to run from every process;
 * scoped to handler kinds so non-resumable rows keep their honest
 * "interrupted" degradation instead of becoming unrunnable pending rows.
 */
export async function reapExpiredLeases(): Promise<number> {
  const kinds = handlerKinds();
  if (!kinds.length) return 0;
  const reaped = await withCtxNull(() =>
    rawDatabase.job.updateMany({
      where: {
        status: "running",
        leaseExpiresAt: { lt: new Date() },
        kind: { in: kinds },
      },
      data: {
        status: "pending",
        claimedBy: null,
        claimedAt: null,
        leaseExpiresAt: null,
        leaseToken: { increment: 1 },
        nextRunAt: new Date(),
        error: "Lease expired — reclaimed for another attempt.",
      },
    })
  );
  if (reaped.count > 0) log.warn("reaped expired job leases", { count: reaped.count });
  return reaped.count;
}

/**
 * The fencing write (S100 / P0.2): terminal job state lands ONLY when the
 * caller still holds the CURRENT lease token. Returns false when fenced —
 * a stale worker must treat its results as discarded and surface nothing
 * (the newer claimant owns the row and will report its own outcome).
 */
export async function writeOutcomeIfLeased(
  jobId: string,
  leaseToken: number,
  data: Prisma.JobUpdateManyMutationInput
): Promise<boolean> {
  const written = await withCtxNull(() =>
    rawDatabase.job.updateMany({ where: { id: jobId, leaseToken }, data })
  );
  return written.count === 1;
}

/** S101 — tick counter gating the lazy expired-storage-hold sweep (~1/min). */
let storageSweepTick = 0;

/**
 * One claim pass. Claimable set depends on role:
 *   web    — jobs this process created (closure present) + handler kinds
 *   worker — handler kinds only (it cannot run foreign closures)
 */
export async function tickQueue(): Promise<void> {
  if (state.ticking || state.noClaim) return;
  state.ticking = true;
  try {
    // S100 — expired-lease recovery first: stale running rows return to
    // pending so the claim scan below can hand them to a live process.
    await reapExpiredLeases().catch(() => {});

    // S101 — expired storage holds release quota lazily: an indexed scan
    // that is a no-op the overwhelming majority of ticks. One minute per
    // process keeps the amortized cost at zero; the dynamic import avoids
    // a load-time cycle (storage.ts sits below the queue in the graph).
    if (++storageSweepTick % 60 === 0) {
      void import("./storage")
        .then((m) => m.sweepExpiredStorageReservations())
        .catch(() => {});
    }

    const now = new Date();
    const closureIds = [...state.closures.keys()];
    const kinds = handlerKinds();

    // Build the claimable filter. A web process with no closures and no
    // registered handlers has nothing to claim.
    const claimable: { id?: { in: string[] }; kind?: { in: string[] } }[] = [];
    if (closureIds.length) claimable.push({ id: { in: closureIds } });
    if (kinds.length) claimable.push({ kind: { in: kinds } });
    if (!claimable.length) return;

    const candidates = await withCtxNull(() =>
      rawDatabase.job.findMany({
        where: {
          status: "pending",
          nextRunAt: { lte: now },
          OR: claimable,
        },
        orderBy: { nextRunAt: "asc" },
        take: CLAIM_BATCH * 3, // over-fetch: some fail caps/cancel checks
      })
    );

    for (const candidate of candidates) {
      if (state.active >= MAX_ACTIVE_PER_PROCESS) break;

      const kind = candidate.kind as JobKind;
      const hasClosure = state.closures.has(candidate.id);
      const hasHandler = handlers.has(kind);
      if (!hasClosure && !hasHandler) continue; // another process's closure job

      // Cancelled while queued — never start it. Status-guarded (no lease
      // exists on a pending row).
      if (candidate.cancelRequested) {
        await withCtxNull(() =>
          rawDatabase.job.updateMany({
            where: { id: candidate.id, status: "pending" },
            data: { status: "cancelled", endedAt: new Date(), error: "Cancelled before starting" },
          })
        ).catch(() => {});
        continue;
      }

      // Per-org heavy cap — count RUNNING heavy rows for this org.
      if ((HEAVY_KINDS as readonly string[]).includes(kind)) {
        const running = await withCtxNull(() =>
          rawDatabase.job.count({
            where: { organizationId: candidate.organizationId, status: "running", kind: { in: [...HEAVY_KINDS] } },
          })
        );
        if (running >= MAX_HEAVY_PER_ORG) continue; // stays pending — retried next tick
      }

      // Atomic claim (S100: a lease, not ownership) — the claim primitive
      // only hits when STILL pending and stamps a fresh monotonic fencing
      // token + lease deadline.
      const claim = await claimJob(candidate.id, state.workerId).catch(() => ({ claimed: false, leaseToken: 0 }));
      if (!claim.claimed) continue;

      // Detached execution — the tick keeps claiming; jobs run concurrently
      // (bounded by MAX_ACTIVE_PER_PROCESS, incremented below before detach
      // so the loop can't oversubscribe in the await window).
      state.active += 1;
      void executeClaimed(candidate.id, kind, candidate.entityId, candidate.organizationId, candidate.userId, candidate.payload ?? null, claim.leaseToken)
        .finally(() => {
          state.active -= 1;
        });
    }
  } catch (err) {
    log.error("queue tick failed", { err });
  } finally {
    state.ticking = false;
  }
}

/**
 * Execute one claimed job row: closure (if this process has it) or handler,
 * under the captured/restored tenant ctx and cancel key. Sets final status
 * with retry backoff on failure.
 */
async function executeClaimed(
  jobId: string,
  kind: JobKind,
  entityId: string,
  organizationId: string,
  userId: string | null,
  payloadRaw: string | null,
  /** The fencing token stamped by the claim that started this run (S100). */
  leaseToken: number
): Promise<void> {
  emitClaimed(jobId, kind, entityId);

  const closure = state.closures.get(jobId) ?? null;
  const handler = handlers.get(kind) ?? null;
  if (!closure && !handler) {
    // Claimed but unrunnable (closure evaporated, no handler) — interrupt
    // honestly instead of leaving a forever-running row. FENCED write
    // (S100): only if this run still holds the current lease token.
    const fenced = await withCtxNull(() =>
      rawDatabase.job.updateMany({
        where: { id: jobId, leaseToken },
        data: {
          status: "interrupted",
          endedAt: new Date(),
          error: "Server restarted while this job was queued — run the stage again.",
        },
      })
    ).catch(() => ({ count: 0 }));
    if (fenced.count !== 1) {
      log.warn("stale executor fenced — interrupted outcome discarded", { jobId, kind, leaseToken });
      return;
    }
    emitFinished(jobId, kind, entityId, "interrupted", "Server restarted while this job was queued — run the stage again.");
    return;
  }

  const jobKey = `${entityId}:${kind}`;

  // Cross-process cancellation: poll the row's cancelRequested and mirror it
  // into the in-memory cancel set, where cancellableSleep/throwIfCancelled
  // already look. Also cleared on finish.
  const watcher = setInterval(() => {
    void withCtxNull(() => rawDatabase.job.findUnique({ where: { id: jobId }, select: { cancelRequested: true } }))
      .then((row) => {
        if (row?.cancelRequested) requestCancel(jobKey);
      })
      .catch(() => {});
  }, 2_000);
  state.cancelWatchers.set(jobId, watcher);

  // S100 — the lease renewer, every LEASE_RENEW_MS (TTL/3). A FAILED
  // renewal is authoritative (count 0 after a successful query): someone
  // else owns the row now — cancel the body at its next cancel point and
  // let the fenced terminal write discard this run. A THROWN (transient
  // DB) error keeps the lease — the next interval retries; a single missed
  // renew must not lose the lease (three chances before expiry).
  const renewer = setInterval(() => {
    void renewLease(jobId, leaseToken)
      .then((alive) => {
        if (!alive) {
          log.warn("job lease lost — a newer claimant owns this row; discarding results", {
            jobId,
            kind,
            leaseToken,
          });
          requestCancel(jobKey);
        }
      })
      .catch(() => {});
  }, LEASE_RENEW_MS);

  let outcome: "done" | "cancelled" | "retry" | "failed" = "done";
  let errorMessage: string | null = null;

  try {
    if (closure) {
      // Re-enter the enqueue-time tenant ctx — the deferred call would
      // otherwise run outside any scope (ALS follows the CALLER's context).
      const body = () => runWithCancelKey(jobKey, closure.fn);
      if (closure.ctx) await withCtx(closure.ctx, body);
      else await withCtxNull(body);
    } else if (handler) {
      const ctx = await ctxFromRow(organizationId, userId);
      if (!ctx) throw new Error("Job row has no user to run as — cannot restore tenant context");
      // Parse the durable payload ONCE here — handlers receive plain data and
      // stay free of storage/serialization concerns. A corrupt payload (hand-
      // edited row, older writer) degrades to null instead of killing the job.
      let payload: unknown = null;
      if (payloadRaw) {
        try {
          payload = JSON.parse(payloadRaw);
        } catch {
          log.warn("job payload failed to parse — running with defaults", { jobId, kind });
        }
      }
      await withCtx(ctx, () => runWithCancelKey(jobKey, () => handler(entityId, payload)));
    }
  } catch (err) {
    if (err instanceof JobCancelledError) {
      outcome = "cancelled";
      errorMessage = errorText(err, "Cancelled by the user");
    } else {
      errorMessage = errorText(err, `${kind} job failed`);
      outcome = "failed";
    }
  } finally {
    clearInterval(watcher);
    clearInterval(renewer);
    state.cancelWatchers.delete(jobId);
  }

  // Read attempts BEFORE deciding retries (claim already incremented).
  const row = await withCtxNull(() => rawDatabase.job.findUnique({ where: { id: jobId }, select: { attempts: true, maxAttempts: true } })).catch(() => null);
  const attempts = row?.attempts ?? 1;
  const maxAttempts = row?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (outcome === "failed" && attempts < maxAttempts) outcome = "retry";

  // The closure survives a RETRY so the creating process re-runs it with the
  // original request-scoped data; terminal outcomes release it.
  if (outcome !== "retry") state.closures.delete(jobId);

  const now = new Date();
  try {
    // S100 — the FENCED terminal write: the outcome lands ONLY if this run
    // still holds the current lease token. A stale worker (lease reaped or
    // re-claimed mid-run) affects ZERO rows — its results are discarded
    // and nothing is emitted, because the newer claimant owns the row and
    // will report its own outcome.
    const fenced = await writeOutcomeIfLeased(
      jobId,
      leaseToken,
      outcome === "done"
        ? { status: "done", endedAt: now, progress: 1, error: null }
        : outcome === "cancelled"
          ? { status: "cancelled", endedAt: now, error: errorMessage }
          : outcome === "retry"
            ? { status: "pending", endedAt: null, claimedBy: null, claimedAt: null, leaseExpiresAt: null, nextRunAt: new Date(Date.now() + backoffMs(attempts)), error: errorMessage }
            : { status: "failed", endedAt: now, error: errorMessage },
    );
    if (!fenced) {
      log.warn("stale executor fenced — outcome discarded", { jobId, kind, leaseToken, outcome });
      return;
    }
  } catch (err) {
    log.error("queue failed to persist job outcome", { jobId, kind, err });
  }

  if (outcome === "retry") {
    log.warn("job failed — requeued with backoff", { jobId, kind, entityId, attempts, nextInMs: backoffMs(attempts), error: errorMessage });
  } else {
    if (outcome === "failed") {
      log.error("job failed permanently", { jobId, kind, entityId, attempts, error: errorMessage });
    }
    emitFinished(
      jobId,
      kind,
      entityId,
      outcome === "done" ? "done" : outcome,
      errorMessage
    );
  }
}

/** Restore a TenantCtx from a Job row (membership lookup gives the role). */
async function ctxFromRow(organizationId: string, userId: string | null): Promise<TenantCtx | null> {
  if (!userId) return null;
  const membership = await withCtxNull(() =>
    rawDatabase.membership.findFirst({ where: { userId, organizationId } })
  );
  if (!membership) return null;
  return { userId, organizationId, role: membership.role };
}

// ---------------------------------------------------------------------------
// Loop

export function startQueueLoop(): void {
  if (state.timer) return;
  state.timer = setInterval(() => {
    void tickQueue();
  }, QUEUE_TICK_MS);
  // Never hold the event loop open just for the queue (worker calls explicitly).
  state.timer.unref?.();
}

/** Enqueue + immediate tick — keeps request→execution latency near zero. */
export function kickQueue(): void {
  void tickQueue();
}

// ---------------------------------------------------------------------------
// Boot recovery integration

/**
 * A stale "running" row (from a dead process) becomes claimable again when
 * its kind has a handler — the durable resume path. Kinds without handlers
 * keep the interrupted + user-visible-error behavior.
 */
export async function reenqueueIfHandlerKind(jobId: string, kind: string): Promise<boolean> {
  if (!handlers.has(kind as JobKind)) return false;
  const updated = await withCtxNull(() =>
    rawDatabase.job.updateMany({
      where: { id: jobId, status: "running" },
      data: {
        status: "pending",
        claimedBy: null,
        claimedAt: null,
        leaseExpiresAt: null,
        leaseToken: { increment: 1 }, // S100 — blind the dead claimant's writes
        nextRunAt: new Date(),
      },
    })
  ).catch(() => ({ count: 0 }));
  return updated.count === 1;
}

/** Queue diagnostics for GET /api/status. */
export function queueStats() {
  return {
    workerId: state.workerId,
    role: state.role,
    active: state.active,
    closures: state.closures.size,
    handlerKinds: handlerKinds(),
    noClaim: state.noClaim,
    caps: { perProcess: MAX_ACTIVE_PER_PROCESS, heavyPerOrg: MAX_HEAVY_PER_ORG },
    lease: { ttlMs: LEASE_TTL_MS, renewMs: LEASE_RENEW_MS }, // S100
  };
}

// ---------------------------------------------------------------------------
// Cross-process claim liveness
//
// claimedBy encodes "<role>:<pid>:<bootTs>". On a single host (the supported
// topology: one app process + optional worker, docker-compose shares the pid
// namespace only with --pid=host — separate containers do NOT share) a dead
// claimer's pid answers ESRCH. Multi-host HA needs the BullMQ driver —
// documented limitation, see the module header.

/** True when this row was claimed by THIS process. */
export function isOwnClaim(claimedBy: string | null): boolean {
  return claimedBy === state.workerId;
}

/**
 * True when the claimer's process is provably dead on this host. Unknown /
 * foreign-host claimers read as ALIVE (fail-safe: never kill a live job).
 * Same-host pid reuse can mask a dead claimer — accepted, rare, and the row
 * is still recovered on the next process boot.
 */
export function claimerPidIsDead(claimedBy: string | null): boolean {
  if (!claimedBy) return false;
  const parts = claimedBy.split(":");
  const pid = Number(parts[1]);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false; // alive (or a reused pid)
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/**
 * The full staleness predicate for boot recovery: may this process treat a
 * "running" row as abandoned? Called AFTER the startedAt < bootTs pre-check.
 *
 *   null claimedBy                      -> stale (Stage 1/2 legacy row — a
 *                                          Stage-3 claim always stamps it)
 *   my own workerId                     -> live (I am executing it)
 *   my role + my pid + earlier bootTs   -> stale (previous incarnation of
 *                                          THIS process reused the pid)
 *   anything else                       -> stale only when the pid is dead
 * Fail-safe by construction: an unknown/live claimer is never interrupted.
 */
export function claimIsStale(claimedBy: string | null): boolean {
  if (!claimedBy) return true;
  if (claimedBy === state.workerId) return false;
  const [role, pidStr, bootStr] = claimedBy.split(":");
  const myBoot = state.workerId.split(":")[2];
  if (role === state.role && Number(pidStr) === process.pid && bootStr !== myBoot) {
    return true; // previous incarnation of this very process
  }
  return claimerPidIsDead(claimedBy);
}
