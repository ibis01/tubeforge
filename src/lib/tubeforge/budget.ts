// Global AI rate budget (Phase 3 — robustness).
//
// All upstream AI calls (GLM chat, TTS, CogView / image-edit, CogVideoX i2v)
// flow through aiCall(), which coordinates:
//   * pacing  — minimum spacing between call STARTS per service (per-minute
//               budget from the ACTING USER's settings, cached 25s per user)
//   * concurrency caps per service (e.g. one image call at a time)
//   * 429 penalties — when upstream rate-limits a service, every caller of
//               that service backs off for a shared cool-down window instead
//               of each job retrying into the same wall
// The budget never deadlocks: waiters proceed after a hard 10-minute cap.
//
// Stage 2 note: the per-minute limits are per user; the pacing/concurrency
// queues themselves stay shared platform-wide (a conservative posture that
// protects upstream) — per-user queues arrive with Redis in Stage 3.

import { currentCtx } from "./tenant";
import { getUserSettings } from "./settings";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type AiService = "llm" | "tts" | "image" | "video" | "search";

/** Concurrency caps per service (small upstream limits — be a polite client). */
const MAX_CONCURRENT: Record<AiService, number> = {
  llm: 3,
  tts: 2,
  image: 1,
  video: 1,
  search: 2,
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
  cfgCache: Map<string, { at: number; enabled: boolean; perMin: Record<AiService, number> }>;
}

const g = globalThis as typeof globalThis & { __tfBudget?: BudgetState };
const budget: BudgetState = (g.__tfBudget ??= {
  services: {
    llm: { active: 0, lastStart: 0, penaltyUntil: 0, queue: Promise.resolve() },
    tts: { active: 0, lastStart: 0, penaltyUntil: 0, queue: Promise.resolve() },
    image: { active: 0, lastStart: 0, penaltyUntil: 0, queue: Promise.resolve() },
    video: { active: 0, lastStart: 0, penaltyUntil: 0, queue: Promise.resolve() },
    search: { active: 0, lastStart: 0, penaltyUntil: 0, queue: Promise.resolve() },
  },
  cfgCache: new Map(),
});

// ---------- settings (cached) ----------

const DEFAULT_PER_MIN: Record<AiService, number> = {
  llm: 30,
  tts: 12,
  image: 8,
  video: 4,
  search: 10,
};

/** Read the ACTING USER's budget settings with a 25s cache so hot paths never hit the DB. */
async function getBudgetConfig() {
  const now = Date.now();
  const ctx = currentCtx();
  if (!ctx) return { enabled: true, perMin: { ...DEFAULT_PER_MIN } }; // platform path — defaults
  const cached = budget.cfgCache.get(ctx.userId);
  if (cached && now - cached.at < 25_000) return cached;

  let enabled = true;
  const perMin = { ...DEFAULT_PER_MIN };
  try {
    const map = await getUserSettings([
      "aiBudgetEnabled",
      "aiLlmPerMin",
      "aiTtsPerMin",
      "aiImagePerMin",
      "aiVideoPerMin",
    ]);
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

  budget.cfgCache.set(ctx.userId, { at: now, enabled, perMin });
  return { at: now, enabled, perMin };
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
 *
 * Stage 3 (T-3.8): every call is also metered — one UsageRecord row per
 * aiCall (attempts collapsed into one row: ok=false means the whole retry
 * chain failed). Recording is fire-and-forget and NEVER breaks the call.
 */
export async function aiCall<T>(
  service: AiService,
  label: string,
  fn: () => Promise<T>,
  retryOpts: { attempts?: number; baseDelayMs?: number } = {}
): Promise<T> {
  const release = await acquire(service);
  const startedAt = Date.now();
  try {
    const result = await withRetry(label, fn, retryOpts.attempts ?? 3, retryOpts.baseDelayMs ?? 2000, {
      onRetry: (msg) => {
        if (/429|too many requests/i.test(msg)) noteRateLimit(service);
      },
    });
    void recordAiUsage(service, label, Date.now() - startedAt, true, retryOpts.attempts ?? 3);
    return result;
  } catch (err) {
    void recordAiUsage(service, label, Date.now() - startedAt, false, retryOpts.attempts ?? 3);
    throw err;
  } finally {
    release();
  }
}

// ---------- usage metering (T-3.8) ----------

/** service → provider-capability id (UsageRecord.capability vocabulary) */
const CAPABILITY_OF: Record<AiService, "chat" | "tts" | "image" | "video"> = {
  llm: "chat",
  tts: "tts",
  image: "image",
  video: "video",
  // Stage 5 (module A): the web_search function rides the Z.ai gateway under
  // the chat capability's provider config — it is the same credential.
  search: "chat",
};

/**
 * Persist one UsageRecord for the acting user. Fire-and-forget: metering
 * problems must never surface inside a creative pipeline. Resolves the
 * provider/model from the user's capability settings (cached read) so the
 * row can answer "what did this user spend on, where".
 */
async function recordAiUsage(
  service: AiService,
  label: string,
  latencyMs: number,
  ok: boolean,
  attempts: number
): Promise<void> {
  const ctx = currentCtx();
  if (!ctx) return; // platform path (boot recovery) — no user to attribute
  try {
    const [{ rawDatabase }, settingsMod] = await Promise.all([
      import("./tenant-db"),
      import("./providers/settings"),
    ]);
    const capability = CAPABILITY_OF[service];
    let provider = "zai";
    let model: string | null = null;
    try {
      const cfg = await settingsMod.getCapability(capability);
      provider = cfg.provider;
      model = cfg.model || null;
    } catch {
      /* defaults are fine — the row still counts the call */
    }
    await rawDatabase.usageRecord.create({
      data: {
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        capability,
        provider,
        model,
        latencyMs: Math.min(latencyMs, 2 ** 31 - 1),
        ok,
        // Cost arrives with provider-level token reporting (Stage 3 part 2);
        // the call-count + latency baseline is what billing pivots on today.
        inputTokens: 0,
        outputTokens: 0,
        costMicroUsd: 0,
      },
    });
    if (!ok) {
      console.warn(`[usage] ${service} call failed after ${attempts} attempt(s): ${label.slice(0, 80)}`);
    }
  } catch (err) {
    // Never let metering break the pipeline.
    console.warn("[usage] record failed (non-fatal):", err instanceof Error ? err.message : err);
  }
}
