// Global AI rate budget (Phase 3 — robustness).
//
// All upstream AI calls (GLM chat, TTS, CogView / image-edit, CogVideoX i2v)
// flow through aiCall(), which coordinates:
//   * pacing  — minimum spacing between call STARTS per service (per-minute
//               budget from Settings, cached 25s)
//   * concurrency caps per service (e.g. one image call at a time)
//   * 429 penalties — when upstream rate-limits a service, every caller of
//               that service backs off for a shared cool-down window instead
//               of each job retrying into the same wall
// The budget never deadlocks: waiters proceed after a hard 10-minute cap.

import { db } from "@/lib/db";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type AiService = "llm" | "tts" | "image" | "video";

/** Concurrency caps per service (small upstream limits — be a polite client). */
const MAX_CONCURRENT: Record<AiService, number> = {
  llm: 3,
  tts: 2,
  image: 1,
  video: 1,
};

/** Shared cool-down when a service reports a 429. */
const RATE_LIMIT_PENALTY_MS = 45_000;

/** Hard cap on budget waiting — after this, run anyway (fail-open). */
const MAX_WAIT_MS = 10 * 60_000;

interface ServiceState {
  active: number; // calls currently in flight
  lastStart: number; // ms timestamp of the last call start
  penaltyUntil: number; // ms timestamp — no starts before this on a 429
  queue: Promise<void>; // FIFO chain — serializes the pacing gates
}

interface BudgetState {
  services: Record<AiService, ServiceState>;
  cfgCache: { at: number; enabled: boolean; perMin: Record<AiService, number> } | null;
}

const g = globalThis as typeof globalThis & { __tfBudget?: BudgetState };
const budget: BudgetState = (g.__tfBudget ??= {
  services: {
    llm: { active: 0, lastStart: 0, penaltyUntil: 0, queue: Promise.resolve() },
    tts: { active: 0, lastStart: 0, penaltyUntil: 0, queue: Promise.resolve() },
    image: { active: 0, lastStart: 0, penaltyUntil: 0, queue: Promise.resolve() },
    video: { active: 0, lastStart: 0, penaltyUntil: 0, queue: Promise.resolve() },
  },
  cfgCache: null,
});

// ---------- settings (cached) ----------

const DEFAULT_PER_MIN: Record<AiService, number> = {
  llm: 30,
  tts: 12,
  image: 8,
  video: 4,
};

/** Read budget settings with a 25s cache so hot paths never hit the DB. */
async function getBudgetConfig() {
  const now = Date.now();
  if (budget.cfgCache && now - budget.cfgCache.at < 25_000) return budget.cfgCache;

  let enabled = true;
  const perMin = { ...DEFAULT_PER_MIN };
  try {
    const rows = await db.setting.findMany({
      where: { key: { in: ["aiBudgetEnabled", "aiLlmPerMin", "aiTtsPerMin", "aiImagePerMin", "aiVideoPerMin"] } },
    });
    const map = new Map(rows.map((r) => [r.key, r.value]));
    enabled = (map.get("aiBudgetEnabled") ?? "true") !== "false";
    for (const [key, svc] of [
      ["aiLlmPerMin", "llm"],
      ["aiTtsPerMin", "tts"],
      ["aiImagePerMin", "image"],
      ["aiVideoPerMin", "video"],
    ] as const) {
      const raw = Number(map.get(key));
      if (Number.isFinite(raw) && raw >= 1) perMin[svc] = Math.min(raw, 600);
    }
  } catch (err) {
    console.warn("[budget] settings read failed, using defaults:", err);
  }

  budget.cfgCache = { at: now, enabled, perMin };
  return budget.cfgCache;
}

// ---------- slot acquisition ----------

/**
 * Wait for a service slot: pacing since the last start, a free concurrency
 * slot, and any active 429 penalty window. FIFO via the per-service chain so
 * jobs are served in arrival order (no starvation).
 */
function acquire(service: AiService): Promise<() => void> {
  const s = budget.services[service];

  const ticket = s.queue.then(async () => {
    const enteredAt = Date.now();
    for (;;) {
      const cfg = await getBudgetConfig();
      if (!cfg.enabled) break;

      const minInterval = Math.max(0, 60_000 / cfg.perMin[service]);
      const now = Date.now();
      const earliest = Math.max(s.lastStart + minInterval, s.penaltyUntil);
      const free = s.active < MAX_CONCURRENT[service];

      if (now >= earliest && free) break;
      if (now - enteredAt > MAX_WAIT_MS) {
        console.warn(`[budget] ${service} waiter exceeded ${MAX_WAIT_MS / 60000}min — proceeding (fail-open)`);
        break;
      }
      await sleep(Math.min(200, Math.max(50, earliest - now)));
    }

    s.active += 1;
    s.lastStart = Date.now();
  });

  // Keep the chain alive regardless of gate failures.
  s.queue = ticket.then(
    () => {},
    () => {}
  );

  return ticket.then(() => () => {
    s.active = Math.max(0, s.active - 1);
  });
}

/** Record an upstream 429 — every caller of this service cools down together. */
function noteRateLimit(service: AiService, ms = RATE_LIMIT_PENALTY_MS) {
  budget.services[service].penaltyUntil = Math.max(
    budget.services[service].penaltyUntil,
    Date.now() + ms
  );
  console.warn(`[budget] 429 on ${service} — shared cool-down until +${Math.round(ms / 1000)}s`);
}

// ---------- retry core ----------

export interface RetryOpts {
  /** Called with the failure message before each retry attempt. */
  onRetry?: (message: string) => void;
}

/**
 * Retry an async AI call with exponential backoff.
 * The upstream GLM/TTS/CogView services occasionally return transient 500s
 * ("network error, please try again later") — one blip should never fail a stage.
 */
export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 3,
  baseDelayMs = 2000,
  opts: RetryOpts = {}
): Promise<T> {
  let lastError: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      opts.onRetry?.(msg);
      if (i < attempts) {
        // Rate limits (429) need much longer cool-downs than transient 500s.
        const rateLimited = /429|too many requests/i.test(msg);
        const delay = baseDelayMs * Math.pow(2, i - 1) * (rateLimited ? 4 : 1);
        console.warn(
          `[ai-retry] ${label} failed (attempt ${i}/${attempts}), retrying in ${delay}ms:`,
          msg
        );
        await sleep(delay);
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`${label} failed after ${attempts} attempts`);
}

/**
 * Budget-aware AI call: acquire a service slot (pacing + concurrency + shared
 * 429 penalties), run `fn` with retries, always release the slot.
 * Every AI call site in the pipeline goes through here.
 */
export async function aiCall<T>(
  service: AiService,
  label: string,
  fn: () => Promise<T>,
  retryOpts: { attempts?: number; baseDelayMs?: number } = {}
): Promise<T> {
  const release = await acquire(service);
  try {
    return await withRetry(label, fn, retryOpts.attempts ?? 3, retryOpts.baseDelayMs ?? 2000, {
      onRetry: (msg) => {
        if (/429|too many requests/i.test(msg)) noteRateLimit(service);
      },
    });
  } finally {
    release();
  }
}
