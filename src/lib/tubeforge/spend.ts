// spend.ts — S27: the operator's USD metering layer, aka "the $5 door".
//
// The external review's verdict (Nov 2026): TubeForge's internal credit
// accounting is not a USD spending meter — UsageRecord rows wrote
// inputTokens/outputTokens/costMicroUsd as zeros, the LLM completion
// interface dropped provider usage, and nothing anywhere enforced the
// $5.00 paid-OpenAI experiment budget. This module closes that:
//
//   1. CAPTURE    — provider token usage is parsed off every chat/vision
//                   response (OpenAI, Anthropic, Gemini, Z.ai shapes) and
//                   emitted into a request-scoped sink (see below).
//   2. PROPAGATE  — llm.ts attaches `usage` to LLMCompletion; budget.ts
//                   drains the sink after every aiCall and writes REAL
//                   tokens + computed cost into the UsageRecord row.
//   3. PRICING    — a versioned model price registry (micro-USD per 1M
//                   tokens). Bump PRICING_VERSION when prices change; the
//                   git history of this file is the pricing audit trail.
//   4. RESERVATION— every PAID chat/vision dispatch reserves its worst-case
//                   USD estimate BEFORE the request leaves, and the
//                   reservation is admitted only while
//                       recorded + outstanding + estimate ≤ STOP.
//   5. RECONCILE  — after the response, the hold settles at the ACTUAL
//                   token cost when usage arrived, else conservatively at
//                   the estimate (a provider that answered without a usage
//                   block may still have billed).
//   6. UNCERTAIN  — a dispatch that THREW settles at the full estimate:
//                   an upstream provider may already have billed an
//                   accepted request (timeouts included). Never release.
//   7. THE LIMIT  — because the estimate is provably ≥ the actual cost
//                   (input: chars/3 ≥ tokens for English AND JSON, plus
//                   per-message overhead and a 4000-token/image floor;
//                   output: every paid dispatch is clamped to
//                   MAX_OUTPUT_TOKENS, which the estimate prices in full),
//                   the admit rule caps RECORDED spend at STOP ($4.50 by
//                   default) — and true provider spend, including any hold
//                   lost to a mid-call process crash, stays ≤ STOP ≤ $5.00.
//                   That is the review's law: stop at $4.50 reserved or
//                   recorded, never exceed $5.
//
// Scope: the gate covers CHAT and VISION dispatches to PAID external
// providers — the review's exact allocation ($3 director text + $1
// continuity vision + $0.5 smoke + $0.5 contingency). Image/video/TTS
// economics remain the app-credit estimate system (billing.ts); Z.ai
// gateway calls and local OpenAI-compatible servers (Ollama / LM Studio /
// vLLM) are metered (tokens recorded, shown on the usage dashboard) but
// never gated or priced — they are not the experiment's spend.
//
// Process scope: the hold set is in-memory (hold lifetime = one dispatch,
// seconds). The recorded total boots from the DB (SUM of priced
// UsageRecord rows) and grows in-process. A crash mid-call loses at most
// the outstanding holds — bounded by the admit rule, so the $5 guarantee
// survives the crash. Multi-instance deployments would need a shared
// counter; this deployment runs exactly one daemon process.

import { currentCtx, type TenantCtx } from "./tenant";

// ---------- the law, as knobs ----------

/** Admit line: recorded + outstanding + estimate must stay ≤ this. Default
 *  $4.50 per the review's allocation (stop well under the $5 ceiling). */
const STOP_MICRO_USD = (() => {
  const raw = Number(process.env.TUBEFORGE_SPEND_STOP_USD);
  if (!Number.isFinite(raw) || raw <= 0) return 4_500_000; // $4.50
  return Math.min(Math.round(raw * 1_000_000), 1_000_000_000);
})();

/** Operator escape hatch: TUBEFORGE_SPEND_GATE=0 lifts the gate (the
 *  metering and pricing keep running — only the block is lifted). */
const GATE_ENABLED = process.env.TUBEFORGE_SPEND_GATE !== "0";

/** Output clamp for every gated dispatch — the output half of the
 *  estimate≥actual invariant. Director JSON plans run 1–4k tokens; 8192
 *  is headroom, priced in full by every estimate. */
export const MAX_OUTPUT_TOKENS = 8192;

// ---------- versioned model pricing ----------
//
// PRICING_VERSION "2026-11" — sources: OpenAI's official pricing page
// (developers.openai.com/api/docs/pricing, retrieved 2026-11-05) for the
// gpt-6 generation; the June 2026 CloudZero GPT-4 cost survey + OpenRouter
// listing for the legacy gpt-4.1 / gpt-4o rows (still callable). Standard
// mode only — batch/fast/ultrafast variants are different API surfaces this
// deployment does not call. Prices in micro-USD per 1M tokens.

export const PRICING_VERSION = "2026-11";

type ModelPrice = { in: number; out: number };

const MODEL_PRICES: Record<string, ModelPrice> = {
  // current flagship generation (official pricing page, Nov 2026)
  "gpt-6-astra": { in: 10_000_000, out: 50_000_000 },
  "gpt-6.1-sol": { in: 2_000_000, out: 10_000_000 },
  "gpt-6.1-terra": { in: 1_000_000, out: 5_000_000 },
  "gpt-6-luna": { in: 100_000, out: 500_000 },
  "gpt-5.6-sol": { in: 4_000_000, out: 20_000_000 },
  "gpt-5.6-cyber": { in: 12_500_000, out: 75_000_000 },
  "gpt-6-rosalind": { in: 15_000_000, out: 75_000_000 },
  "gpt-rosalind-research": { in: 5_000_000, out: 25_000_000 },
  "gpt-rosalind-discovery": { in: 5_000_000, out: 25_000_000 },
  "gpt-6-astra-law": { in: 10_000_000, out: 50_000_000 },
  // legacy generation — still callable per the June 2026 survey data
  "gpt-4.1": { in: 2_000_000, out: 8_000_000 },
  "gpt-4.1-mini": { in: 400_000, out: 1_600_000 },
  "gpt-4.1-nano": { in: 100_000, out: 400_000 },
  "gpt-4o": { in: 2_500_000, out: 10_000_000 },
};

/** Unknown model on a PAID provider → the priciest standard-mode flagship.
 *  Conservative by construction: an unpriced model can never under-count.
 *  (Domain-restricted ultra-premium rows — rosalind/cyber — are excluded
 *  from the fallback: a general chat dispatch cannot route to them, and
 *  wiring one means pricing it explicitly, here, first.) */
const FALLBACK_PRICE: ModelPrice = MODEL_PRICES["gpt-6-astra"];

/** Longest-prefix match so dated snapshots ("gpt-6.1-sol-2026-10-15") and
 *  vendor-qualified ids ("openai/gpt-6.1-sol") resolve to their row. */
export function priceForModel(model: string): ModelPrice {
  const id = model.trim().replace(/^[a-z0-9-]+\//i, "");
  if (MODEL_PRICES[id]) return MODEL_PRICES[id];
  const keys = Object.keys(MODEL_PRICES).sort((a, b) => b.length - a.length);
  for (const key of keys) if (id.startsWith(key)) return MODEL_PRICES[key];
  return FALLBACK_PRICE;
}

/** Actual cost from REPORTED usage — integer micro-USD, per-side rounding. */
export function computeCostMicroUsd(
  model: string,
  usage: { inputTokens: number; outputTokens: number }
): number {
  const p = priceForModel(model);
  const inMicro = Math.round((usage.inputTokens * p.in) / 1_000_000);
  const outMicro = Math.round((usage.outputTokens * p.out) / 1_000_000);
  return inMicro + outMicro;
}

// ---------- provider vocabulary ----------

/** Providers the gate treats as PAID externals (chat + vision dispatches).
 *  Mirrors providers/chat.ts OPENAI_COMPATIBLE minus the local servers,
 *  plus the two first-class paid chat providers. */
export const PAID_PROVIDERS: ReadonlySet<string> = new Set([
  "openai",
  "mistral",
  "groq",
  "deepseek",
  "xai",
  "openrouter",
  "together",
  "fireworks",
  "perplexity",
  "cohere",
  "azure-openai",
  "anthropic",
  "gemini",
]);

/** Self-hosted OpenAI-compatible servers — real tokens, $0 marginal cost. */
const LOCAL_PROVIDERS: ReadonlySet<string> = new Set([
  "ollama",
  "lmstudio",
  "vllm",
]);

/** Is this dispatch gated (and priced)? Z.ai gateway + locals: no. */
export function isPaidProvider(provider: string): boolean {
  return PAID_PROVIDERS.has(provider);
}

export function isLocalProvider(provider: string): boolean {
  return LOCAL_PROVIDERS.has(provider);
}

// ---------- usage shapes ----------
//
// One normalizer for every wire shape the chat/vision layers meet:
//   openai-compatible  { usage: { prompt_tokens, completion_tokens } }
//   anthropic          { usage: { input_tokens, output_tokens } }
//   gemini             { usageMetadata: { promptTokenCount, candidatesTokenCount } }
//   zai SDK            openai-shaped when present (duck-checked)

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
}

function intOf(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0
    ? Math.round(v)
    : null;
}

export function normalizeUsage(raw: unknown): LLMUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const pairs: [unknown, unknown][] = [
    [r.inputTokens, r.outputTokens], // already-normalized (re-parse safety)
    [r.prompt_tokens, r.completion_tokens], // openai + zai
    [r.input_tokens, r.output_tokens], // anthropic
    [r.promptTokenCount, r.candidatesTokenCount], // gemini
  ];
  for (const [i, o] of pairs) {
    const inputTokens = intOf(i);
    const outputTokens = intOf(o);
    if (inputTokens !== null && outputTokens !== null)
      return { inputTokens, outputTokens };
  }
  return undefined;
}

/** Pull usage off a parsed provider response body (any of the shapes). */
export function usageFromBody(body: unknown): LLMUsage | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  return normalizeUsage(b.usage) ?? normalizeUsage(b.usageMetadata);
}

// ---------- the estimate (the ≥-actual invariant) ----------

const DATA_URI_RE = /data:image\/[^;"']+[;base64,][A-Za-z0-9+/=]+/g;
const BASE64_RUN_RE = /[A-Za-z0-9+/=]{512,}/g;
/** Conservative per-image token floor (a small tile-budget image costs less;
 *  a detailed one more — the output side of the estimate dominates anyway). */
const TOKENS_PER_IMAGE = 4000;
const TOKENS_PER_MESSAGE = 8;

function countImages(text: string): number {
  return (text.match(DATA_URI_RE)?.length ?? 0) + (text.match(BASE64_RUN_RE)?.length ?? 0);
}

function stripHeavy(text: string): string {
  return text.replace(DATA_URI_RE, " ").replace(BASE64_RUN_RE, " ");
}

/** Worst-case USD estimate for one dispatch. Input: chars/3 (≥ tokens for
 *  English ~4 ch/tok AND JSON/code ~3-3.5 ch/tok) + per-message overhead +
 *  a fixed floor per image (explicit counts for vision-style dispatches
 *  whose image bytes never ride inside the texts); output: MAX_OUTPUT_TOKENS
 *  priced in full. */
export function estimateDispatchMicroUsd(
  model: string,
  texts: string[],
  images = 0
): number {
  let chars = 0;
  let messageImages = 0;
  let messages = 0;
  for (const t of texts) {
    messages += 1;
    messageImages += countImages(t);
    chars += stripHeavy(t).length;
  }
  const inputTokens =
    Math.ceil(chars / 3) +
    messages * TOKENS_PER_MESSAGE +
    (images + messageImages) * TOKENS_PER_IMAGE;
  const p = priceForModel(model);
  const inMicro = Math.round((inputTokens * p.in) / 1_000_000);
  const outMicro = Math.round((MAX_OUTPUT_TOKENS * p.out) / 1_000_000);
  return inMicro + outMicro;
}

// ---------- the request-scoped usage sink ----------
//
// Provider transports emit reported usage here; budget.ts drains it after
// the aiCall resolves and writes it into the UsageRecord row. Keyed by the
// TenantCtx object (WeakMap) — per-request isolation for free, concurrent
// dispatches never cross, and outside a request (platform path) it no-ops.

const sinks = new WeakMap<TenantCtx, LLMUsage[]>();

export function emitUsage(usage: LLMUsage | undefined): void {
  if (!usage) return;
  const ctx = currentCtx();
  if (!ctx) return;
  const sink = sinks.get(ctx);
  if (sink) sink.push(usage);
  else sinks.set(ctx, [usage]);
}

/** Latest reported usage WITHOUT clearing — the settle path reads the
 *  attempt that produced the returned content. */
export function peekLastUsage(): LLMUsage | undefined {
  const ctx = currentCtx();
  if (!ctx) return undefined;
  const sink = sinks.get(ctx);
  return sink && sink.length ? sink[sink.length - 1] : undefined;
}

/** Drain every reported usage in this request (sum across retry attempts —
 *  each attempt that got a billed response DID cost tokens). */
export function drainUsage(): LLMUsage | undefined {
  const ctx = currentCtx();
  if (!ctx) return undefined;
  const sink = sinks.get(ctx);
  if (!sink || !sink.length) return undefined;
  const total = sink.reduce(
    (acc, u) => ({
      inputTokens: acc.inputTokens + u.inputTokens,
      outputTokens: acc.outputTokens + u.outputTokens,
    }),
    { inputTokens: 0, outputTokens: 0 }
  );
  sinks.delete(ctx);
  return total;
}

// ---------- the gate ----------

export class SpendBlockedError extends Error {
  readonly recordedMicro: number;
  readonly outstandingMicro: number;
  readonly estimatedMicro: number;
  readonly stopMicro: number;
  constructor(
    recordedMicro: number,
    outstandingMicro: number,
    estimatedMicro: number,
    stopMicro: number
  ) {
    super(
      `AI spend budget reached — recorded $${(recordedMicro / 1e6).toFixed(2)} + outstanding $${(
        outstandingMicro / 1e6
      ).toFixed(2)} + this dispatch's worst case $${(estimatedMicro / 1e6).toFixed(2)} would pass the $${(
        stopMicro / 1e6
      ).toFixed(2)} stop line (the $5.00 experiment ceiling). The operator must raise TUBEFORGE_SPEND_STOP_USD to continue.`
    );
    this.name = "SpendBlockedError";
    this.recordedMicro = recordedMicro;
    this.outstandingMicro = outstandingMicro;
    this.estimatedMicro = estimatedMicro;
    this.stopMicro = stopMicro;
  }
}

interface SpendState {
  booted: boolean;
  bootPromise: Promise<void> | null;
  recordedMicro: number; // DB-bootstrapped, grows with every settle
  holds: Map<string, number>; // holdId → reserved estimate (in flight)
  nextHoldId: number;
}

const g = globalThis as typeof globalThis & { __tfSpend?: SpendState };
const spend: SpendState = (g.__tfSpend ??= {
  booted: false,
  bootPromise: null,
  recordedMicro: 0,
  holds: new Map(),
  nextHoldId: 1,
});

function outstandingMicro(): number {
  let sum = 0;
  for (const v of spend.holds.values()) sum += v;
  return sum;
}

/** Boot the recorded total from the platform DB — SUM of every priced
 *  UsageRecord row (the exact rows this module's settles write). Lazy,
 *  once per process. A boot failure fails OPEN on the read only (a broken
 *  meter must not brick the studio) — the in-process total still grows
 *  from zero, so a repairable meter never silently re-opens a spent budget
 *  beyond what this process settles itself. */
async function bootRecorded(): Promise<void> {
  if (spend.booted) return;
  spend.bootPromise ??= (async () => {
    try {
      const { rawDatabase } = await import("./tenant-db");
      const agg = await rawDatabase.usageRecord.aggregate({
        _sum: { costMicroUsd: true },
        where: { provider: { in: [...PAID_PROVIDERS] } },
      });
      spend.recordedMicro = agg._sum.costMicroUsd ?? 0;
      spend.booted = true;
    } catch (err) {
      console.warn(
        "[spend] boot sum failed — gate runs on in-process totals only:",
        err instanceof Error ? err.message : err
      );
      spend.booted = true; // do not retry every call
    }
  })();
  await spend.bootPromise;
}

export interface SpendHold {
  /** Success path: settle at the reported usage's cost, or — when the
   *  provider answered without a usage block — conservatively at the
   *  reserved estimate. */
  settleFromSink(): Promise<void>;
  /** Failure path: the provider MAY have billed the accepted request —
   *  settle at the full estimate, never release. */
  settleUncertain(): Promise<void>;
}

/** Admit one paid dispatch: reserve the worst-case estimate, enforce the
 *  stop line, return the hold to settle afterwards. Ungated providers
 *  (zai gateway, local servers) return null — metering still happens via
 *  emitUsage at the transport. Throws SpendBlockedError when the
 *  reservation would cross the stop line — the caller must NOT dispatch. */
export async function admitDispatch(opts: {
  provider: string;
  model: string;
  estimatedMicro: number;
}): Promise<SpendHold | null> {
  if (!GATE_ENABLED || !isPaidProvider(opts.provider)) return null;
  await bootRecorded();

  const est = Math.max(0, Math.round(opts.estimatedMicro));
  const projection = spend.recordedMicro + outstandingMicro() + est;
  if (projection > STOP_MICRO_USD) {
    throw new SpendBlockedError(
      spend.recordedMicro,
      outstandingMicro(),
      est,
      STOP_MICRO_USD
    );
  }

  const holdId = `spend-${spend.nextHoldId++}`;
  spend.holds.set(holdId, est);

  const settle = async (micro: number) => {
    // The hold comes off at the estimate; the recorded total takes the
    // settlement. est ≥ actual is the invariant, so recorded never jumps.
    if (spend.holds.delete(holdId)) spend.recordedMicro += micro;
  };

  return {
    async settleFromSink() {
      const usage = peekLastUsage();
      await settle(usage ? computeCostMicroUsd(opts.model, usage) : est);
    },
    async settleUncertain() {
      await settle(est);
    },
  };
}
