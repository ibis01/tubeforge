// Cooperative job cancellation (Phase 6 — user-facing Stop).
//
// Long AI stages (especially the script job riding out multi-hour quota
// storms) run in the background. Users need a Stop button that takes effect
// in seconds, not after the current 20-minute cool-down finishes.
//
// Design: a global set of cancelled job keys + an AsyncLocalStorage slot
// that carries the active job's key DOWN the call stack (through aiCall →
// withRetry → budget gates) with zero signature changes. Every sleep in the
// AI retry machinery becomes cancellable: it ticks in short slices and
// throws JobCancelledError the moment the user stops the job.

import { AsyncLocalStorage } from "node:async_hooks";

/** Thrown inside a job body after the user stops it — caught by the registry. */
export class JobCancelledError extends Error {
  constructor() {
    super("Cancelled by user");
    this.name = "JobCancelledError";
  }
}

interface CancelState {
  /** keys of jobs the user asked to stop */
  cancelled: Set<string>;
  /** ALS slot carrying the active job's key through the async call stack */
  storage: AsyncLocalStorage<{ key: string }>;
}

const g = globalThis as typeof globalThis & { __tfCancel?: CancelState };
const state: CancelState = (g.__tfCancel ??= {
  cancelled: new Set<string>(),
  storage: new AsyncLocalStorage<{ key: string }>(),
});

/** The job key this async context belongs to (null outside any job). */
export function currentJobKey(): string | null {
  return state.storage.getStore()?.key ?? null;
}

/** Ask a running job to stop at its next cancellation checkpoint. */
export function requestCancel(key: string): void {
  state.cancelled.add(key);
}

/** Remove the cancel flag (called when the job actually finishes). */
export function clearCancel(key: string): void {
  state.cancelled.delete(key);
}

/** Has this job been cancelled? */
export function isCancelled(key: string | null): boolean {
  return key !== null && state.cancelled.has(key);
}

/**
 * Throw JobCancelledError when the current async context's job was stopped.
 * Called at checkpoints inside the AI retry machinery; the error propagates
 * up to the job body's catch, which resets entity state, then to the
 * registry, which marks the job row "cancelled".
 */
export function throwIfCancelled(): void {
  if (isCancelled(currentJobKey())) throw new JobCancelledError();
}

/**
 * Sleep that wakes EARLY (in ≤500ms) when the current job is cancelled —
 * outside a job context it behaves like a plain sleep. Used by the budget
 * gates and retry backoffs so a Stop press lands within half a second.
 */
export function cancellableSleep(ms: number): Promise<void> {
  const key = currentJobKey();
  if (!key) return new Promise((r) => setTimeout(r, ms));

  return new Promise((resolve, reject) => {
    const slice = 500;
    let waited = 0;
    const tick = () => {
      if (isCancelled(key)) return reject(new JobCancelledError());
      if (waited >= ms) return resolve();
      const step = Math.min(slice, ms - waited);
      waited += step;
      setTimeout(tick, step);
    };
    tick();
  });
}

/** Run `fn` with `key` as the cancellation context (jobs.ts wraps every job body). */
export function runWithCancelKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return state.storage.run({ key }, fn);
}
