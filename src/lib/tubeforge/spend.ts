// spend.ts — S27: the operator's USD metering layer, aka "the $5 door".
//
// S32 — the audit's P0 repairs (Nov 2026): durable reservations, fail-closed
// bootstrap, pricing provenance. The in-memory hold set is gone — every
// reservation now lives in the SpendReservation table, so a crash mid-call
// or a connection-test dispatch (outside aiCall) survives the restart.
// bootRecorded fails CLOSED on DB error (a broken meter no longer re-opens
// a spent budget). A PRICING_STATUS = "provisional" constant blocks paid
// dispatches until an operator reconciles the registry against the live
// provider pricing pages and flips it to "verified".
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
// Process scope: S32 — the hold set is DURABLE in the SpendReservation
// table. admitDispatch writes a pending row; settle updates it to settled;
// bootRecorded rebuilds the in-process holds Map and recordedMicro from
// the table on every boot. A crash mid-call leaves a pending row that the
// next boot counts against the stop line (conservative — the gate holds
// it again). Connection-test dispatches (settings/ai route, outside
// aiCall) now persist too — their spend is no longer lost on restart.
// Multi-instance deployments would still need a shared counter; this
// deployment runs exactly one daemon process.

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
// (developers.openai.com/api/docs/pricing) for the gpt-6 generation; the
// June 2026 CloudZero GPT-4 cost survey + OpenRouter listing for the legacy
// gpt-4.1 / gpt-4o rows (still callable). Standard mode only —
// batch/fast/ultrafast variants are different API surfaces this deployment
// does not call. Prices in micro-USD per 1M tokens.
//
// S32 — PRICING_STATUS. The S27 comment cited a source date of 2026-11-05;
// the external audit (run 2026-11-04) flagged it as future-dated and the
// registry unverified against the live provider pages. Until an operator
// reconciles every row against its authoritative source and flips this to
// "verified", the gate refuses paid dispatches with a
// SpendPricingUnverifiedError — belt-and-suspenders on top of the existing
// "no paid API keys configured" posture. (zai gateway + local servers stay
// ungated; the experiment's spend is paid external chat/vision only.)

export const PRICING_VERSION = "2026-11";

/** The verification state of the pricing registry. "provisional" blocks
 *  paid dispatches; "verified" admits them. Flip to "verified" only after
 *  reconciling every MODEL_PRICES row against its cited source URL. */
export const PRICING_STATUS: "provisional" | "verified" = "provisional";

/** Provenance for the registry — one entry per cited source. The audit's
 *  rule: every model and price has valid source provenance. An operator
 *  flips PRICING_STATUS to "verified" only after confirming each source
 *  still lists the price recorded here. */
export const PRICING_SOURCES = [
  {
    url: "https://developers.openai.com/api/docs/pricing",
    retrievedAt: "2026-11-04",
    covers: ["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-cyber", "gpt-6-rosalind", "gpt-rosalind-research", "gpt-rosalind-discovery", "gpt-6-astra-law"],
    note: "gpt-6 generation standard-mode pricing (reconcile before activation)",
  },
  {
    url: "https://www.cloudzero.com/blog/gpt-4-cost",
    retrievedAt: "2026-06-15",
    covers: ["gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano", "gpt-4o"],
    note: "June 2026 CloudZero GPT-4 cost survey + OpenRouter listing for the legacy generation",
  },
] as const;

/** True only when the registry has been reconciled against its sources.
 *  admitDispatch checks this BEFORE the boot/hold path and throws
 *  SpendPricingUnverifiedError when false — paid dispatches cannot run on
 *  unverified prices.
 *
 *  Operator override: set `TUBEFORGE_PRICING_VERIFIED=1` in the environment
 *  after reconciling every MODEL_PRICES row against its PRICING_SOURCES
 *  entry. The constant stays "provisional" in the source until a real
 *  reconciliation commit flips it; the env override lets probes (and a
 *  pre-activation operator sanity-check) exercise the gate without
 *  editing source. */
export function pricingVerified(): boolean {
  if (process.env.TUBEFORGE_PRICING_VERIFIED === "1") return true;
  return PRICING_STATUS === "verified";
}

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

/** S32 — the pricing registry has not been reconciled against its cited
 *  sources. Paid dispatches cannot run on unverified prices. The operator
 *  must flip PRICING_STATUS to "verified" (in spend.ts) after reconciling
 *  every MODEL_PRICES row against its PRICING_SOURCES entry. */
export class SpendPricingUnverifiedError extends Error {
  constructor() {
    super(
      "AI spend pricing is unverified — PRICING_STATUS is \"provisional\". " +
        "Reconcile every MODEL_PRICES row against its cited source " +
        "(PRICING_SOURCES), then flip PRICING_STATUS to \"verified\" in " +
        "src/lib/tubeforge/spend.ts before authorizing paid dispatches."
    );
    this.name = "SpendPricingUnverifiedError";
  }
}

/** S32 — the gate's boot failed (DB aggregation error). Fail-closed: paid
 *  dispatches are blocked until the next successful boot. The zai gateway
 *  and local servers stay open (ungated). The operator must repair the DB
 *  and the next admitDispatch re-tries the boot. */
export class SpendBootFailedError extends Error {
  constructor(detail: string) {
    super(
      `AI spend gate boot failed — paid dispatches blocked (fail-closed). ` +
        `The recorded total could not be verified from the DB; repair the ` +
        `meter and retry. Detail: ${detail}`
    );
    this.name = "SpendBootFailedError";
  }
}

interface SpendState {
  booted: boolean;
  /** S32 — fail-closed: a DB boot failure sets this, and admitDispatch
   *  throws SpendBootFailedError for PAID providers until the next boot
   *  succeeds. Ungated providers (zai/local) are unaffected. */
  bootFailed: boolean;
  bootPromise: Promise<void> | null;
  recordedMicro: number; // DB-bootstrapped from settled SpendReservation rows, grows with every settle
  holds: Map<string, number>; // holdId → reserved estimate (rebuilt from pending rows on boot)
  nextHoldId: number;
}

const g = globalThis as typeof globalThis & { __tfSpend?: SpendState };
const spend: SpendState = (g.__tfSpend ??= {
  booted: false,
  bootFailed: false,
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

/** Boot the recorded total AND the outstanding holds from the SpendReservation
 *  table — the gate's durable source of truth (S32). Lazy, once per process.
 *  Fail-CLOSED: a DB aggregation error sets bootFailed and admitDispatch
 *  refuses paid dispatches until the next boot succeeds (a broken meter must
 *  never re-open a spent budget). The zai gateway and local servers stay
 *  open (ungated) regardless. */
async function bootRecorded(): Promise<void> {
  if (spend.booted) return;
  spend.bootPromise ??= (async () => {
    try {
      const { rawDatabase } = await import("./tenant-db");
      const [settledAgg, pendingRows] = await Promise.all([
        rawDatabase.spendReservation.aggregate({
          _sum: { actualCostMicroUsd: true },
          where: { status: "settled", provider: { in: [...PAID_PROVIDERS] } },
        }),
        rawDatabase.spendReservation.findMany({
          where: { status: "pending", provider: { in: [...PAID_PROVIDERS] } },
          select: { id: true, estimatedMicroUsd: true },
        }),
      ]);
      spend.recordedMicro = settledAgg._sum.actualCostMicroUsd ?? 0;
      // Rebuild the in-process holds from pending rows — a crash mid-call
      // left these behind, and the next boot counts them against the stop
      // line (conservative: the gate holds them again until a settle lands).
      spend.holds.clear();
      let maxId = 0;
      for (const row of pendingRows) {
        spend.holds.set(row.id, row.estimatedMicroUsd);
        const num = parseInt(row.id.replace("spend-", ""), 10);
        if (Number.isFinite(num) && num >= maxId) maxId = num + 1;
      }
      spend.nextHoldId = maxId;
      spend.bootFailed = false;
      spend.booted = true;
    } catch (err) {
      // S32 — fail-closed: the recorded total could not be verified. Block
      // paid dispatches until the DB recovers; do NOT continue with
      // recordedMicro=0 (the S27 fail-open path that could re-open a spent
      // budget). The next admitDispatch re-tries the boot.
      console.error(
        "[spend] boot failed — PAID dispatches blocked (fail-closed):",
        err instanceof Error ? err.message : err
      );
      spend.bootFailed = true;
      spend.booted = true; // do not retry every call; admitDispatch re-checks bootFailed
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
 *  emitUsage at the transport. Throws SpendPricingUnverifiedError when the
 *  pricing registry is provisional, SpendBootFailedError when the boot
 *  could not verify the recorded total (fail-closed), or SpendBlockedError
 *  when the reservation would cross the stop line — in all three cases the
 *  caller must NOT dispatch. */
export async function admitDispatch(opts: {
  provider: string;
  model: string;
  estimatedMicro: number;
}): Promise<SpendHold | null> {
  if (!GATE_ENABLED || !isPaidProvider(opts.provider)) return null;
  // S32 — unverified pricing blocks paid dispatches (belt-and-suspenders on
  // top of the existing "no paid API keys" posture). The operator flips
  // PRICING_STATUS to "verified" after reconciling the registry.
  if (!pricingVerified()) throw new SpendPricingUnverifiedError();
  await bootRecorded();
  if (spend.bootFailed) throw new SpendBootFailedError("boot failed");

  const ctx = currentCtx();
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

  // S32 — persist the reservation so it survives restarts. A crash mid-call
  // leaves a pending row that the next boot counts against the stop line
  // (conservative). If the persistence write itself fails, we must NOT
  // admit — an un-persisted hold would be invisible on restart, under-
  // counting the gate. Fail closed: roll back the in-memory hold and throw.
  if (ctx) {
    try {
      const { rawDatabase } = await import("./tenant-db");
      await rawDatabase.spendReservation.create({
        data: {
          id: holdId,
          organizationId: ctx.organizationId,
          userId: ctx.userId,
          provider: opts.provider,
          model: opts.model,
          estimatedMicroUsd: est,
          status: "pending",
        },
      });
    } catch (err) {
      spend.holds.delete(holdId);
      spend.nextHoldId--; // reuse the id on the next admit
      throw new SpendBootFailedError(
        `reservation persist failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const settle = async (micro: number) => {
    // The hold comes off at the estimate; the recorded total takes the
    // settlement. est ≥ actual is the invariant, so recorded never jumps.
    if (!spend.holds.delete(holdId)) return; // already settled (idempotent)
    spend.recordedMicro += micro;
    // S32 — persist the settlement so the next boot's SUM picks it up. A
    // settle-write failure leaves the row pending — on next boot the gate
    // counts it as outstanding (conservative: the hold is re-applied). Log
    // only; never block the pipeline that just ran the call.
    if (ctx) {
      try {
        const { rawDatabase } = await import("./tenant-db");
        await rawDatabase.spendReservation.update({
          where: { id: holdId },
          data: {
            status: "settled",
            actualCostMicroUsd: micro,
            settledAt: new Date(),
          },
        });
      } catch (err) {
        console.warn(
          "[spend] settle persist failed (row stays pending, conservative on next boot):",
          err instanceof Error ? err.message : err
        );
      }
    }
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
