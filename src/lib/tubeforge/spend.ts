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
//                   (input: script-aware floors — ASCII chars/3 for English
//                   AND JSON, CJK/complex scripts at 1.5 tokens/char, other
//                   non-ASCII at 1, astral at 2 (S34; the old chars/3 broke
//                   the law for non-Latin text, under-reserving a CJK pass
//                   ~4.5x), plus per-message overhead and a 4000-token/image
//                   floor; output: every paid dispatch is clamped to
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
// Process scope: S32 made the hold set DURABLE in the SpendReservation
// table (admit writes a pending row; settle marks it settled; connection
// tests outside aiCall persist too). S47 closes the one gap the S32
// comment still had to disclaim — "multi-instance deployments would still
// need a shared counter". Every paid admit now runs READ-check-RESERVE
// inside ONE serializable transaction against SpendReservation, so
// concurrent instances serialize on the same rows: no instance can admit
// against a stale snapshot of another instance's settlements or holds.
// Holds are UUID-keyed (no cross-instance id collisions). A failed
// admission read stays fail-CLOSED and is re-tried on the next admit,
// matching the SpendBootFailedError contract. Crash semantics are
// unchanged: a pending row left behind by a mid-call crash counts against
// the stop line on every future admit (conservative).

import { randomUUID } from "node:crypto";

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

/** External-audit response — the two operator escape hatches, made
 *  observable. Both are documented, deliberate tools (probes; a
 *  pre-activation sanity check), but an override that leaves no trace is
 *  the dangerous kind: TUBEFORGE_SPEND_GATE=0 lifts the $5 stop line and
 *  TUBEFORGE_PRICING_VERIFIED=1 admits dispatches on provisional prices.
 *  spendOverrides() reports which are active in this process, and
 *  admitDispatch announces them ONCE per process on stderr — a degraded
 *  protection state can never again be silent. */
export function spendOverrides(): {
  gateLifted: boolean;
  pricingForcedVerified: boolean;
} {
  return {
    gateLifted: process.env.TUBEFORGE_SPEND_GATE === "0",
    pricingForcedVerified: process.env.TUBEFORGE_PRICING_VERIFIED === "1",
  };
}

let overridesAnnounced = false;
function announceOverridesOnce(): void {
  if (overridesAnnounced) return;
  overridesAnnounced = true;
  const o = spendOverrides();
  if (!o.gateLifted && !o.pricingForcedVerified) return;
  const parts: string[] = [];
  if (o.gateLifted)
    parts.push(
      "TUBEFORGE_SPEND_GATE=0 — the $5.00 stop line is LIFTED in this process"
    );
  if (o.pricingForcedVerified)
    parts.push(
      "TUBEFORGE_PRICING_VERIFIED=1 — provisional pricing is being treated as verified"
    );
  console.warn(
    `[spend] OVERRIDE ACTIVE: ${parts.join("; ")}. ` +
      "Paid-dispatch protections are degraded by environment, not by source."
  );
}

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
//
// Provenance-stamp convention (external-audit response, 2026-11-05 UTC):
// bare LOCAL calendar dates keep reading as future-dated to a reviewer in
// an earlier timezone. The S27 stamp above was the first hit (an audit run
// 2026-11-04 saw "2026-11-05"); the S34 stamps were flagged again by the
// 2026-11-05 UTC audit because "2026-11-06" was the Asia/Shanghai calendar
// date of a fetch that landed 2026-11-05 UTC. Every stamp in this file is
// now a UTC date or an ISO instant, anchored where possible to the git
// commit whose author timestamp independently bounds it.

export const PRICING_VERSION = "2026-11";

/** The verification state of the pricing registry. "provisional" blocks
 *  paid dispatches; "verified" admits them. Flip to "verified" only after
 *  reconciling every MODEL_PRICES row against its cited source URL AND
 *  proving the ledger against the first real invoices (the audit's P2-1
 *  condition — source pages are necessary, invoices are ground truth). */
export const PRICING_STATUS: "provisional" | "verified" = "provisional";

/** Provenance for the registry — one entry per cited source. The audit's
 *  rule: every model and price has valid source provenance. An operator
 *  flips PRICING_STATUS to "verified" only after confirming each source
 *  still lists the price recorded here.
 *
 *  S34 reconciliation (2026-11-05 UTC — the Asia/Shanghai session recorded
 *  it as 2026-11-06 local; bounded above by commit 1e24911, authored
 *  2026-11-05T19:20:00Z): the OpenAI pricing page was re-fetched
 *  and EVERY current-generation row below matched exactly. The legacy
 *  gpt-4.1/gpt-4o rows' cited source (CloudZero survey) is now a 404 and
 *  OpenAI's live page no longer lists those models — unverifiable-cheap is
 *  the dangerous direction, so the rows were REMOVED; a configured legacy
 *  id now prices at FALLBACK_PRICE (over-reserve only, never under). */
export const PRICING_SOURCES = [
  {
    url: "https://developers.openai.com/api/docs/pricing",
    retrievedAt: "2026-11-05", // UTC day; 2026-11-06 Asia/Shanghai local — stamp convention above
    covers: ["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-cyber", "gpt-6-rosalind", "gpt-rosalind-research", "gpt-rosalind-discovery", "gpt-6-astra-law"],
    note: "gpt-6 generation standard-mode pricing — S34 re-fetch 2026-11-05 UTC (2026-11-06 Asia/Shanghai local): every row reconciled exactly against the live page",
  },
  {
    url: "https://www.cloudzero.com/blog/gpt-4-cost",
    retrievedAt: "2026-06-15",
    covers: [],
    note: "TOMBSTONE — 404 as of the S34 re-check (2026-11-05 UTC / 2026-11-06 Asia/Shanghai local). The legacy gpt-4.1/gpt-4o rows it sourced are gone from MODEL_PRICES (unverifiable-cheap under-prices the gate); legacy ids price at FALLBACK_PRICE until a live source exists",
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
  // Current flagship generation — every row RECONCILED against the live
  // OpenAI pricing page on 2026-11-05 UTC (S34; 2026-11-06 Asia/Shanghai
  // local): all ten matched exactly.
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
  // Legacy generation (gpt-4.1 / gpt-4.1-mini / gpt-4.1-nano / gpt-4o / the
  // gpt-4o-mini default): REMOVED in S34 — their only cited source is a 404
  // and OpenAI's live page no longer lists them, so their prices cannot be
  // verified, and unverifiable-cheap is the dangerous direction (an under-
  // priced row under-reserves the $5 gate). A configured legacy id resolves
  // to FALLBACK_PRICE below, which can only OVER-reserve. Re-add a row only
  // with a live, citable source.
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

// S34 — script-aware input floors. chars/3 is a provable ceiling ONLY for
// ASCII text (English prose ~4 ch/tok, JSON/code ~3-3.5). Non-Latin scripts
// tokenize at roughly ONE-AND-A-HALF tokens PER CHAR — a 6000-char CJK
// director pass is ~9000 real tokens, which chars/3 priced at 2000: a 4.5x
// under-reserve that broke the $5 law on exactly the non-English content a
// multi-language narration pipeline produces. The floors (each ≥ every
// tokenizer average we could find, with margin — over-reserving only blocks
// earlier, never late):
//   ASCII            → ceil(chars/3)   the S27 English+JSON law, unchanged
//   CJK/complex      → 1.5 tokens/char Han, kana, Hangul, Thai, Lao, Khmer,
//                                       Myanmar, CJK punctuation/fullwidth
//   other non-ASCII  → 1 token/char    Cyrillic, Greek, Arabic, Hebrew,
//                                       Devanagari, Latin accents (real
//                                       ratio 2-4 ch/tok — 1/char is ≥)
//   astral plane     → 2 tokens/char   emoji + rare scripts (each is a
//                                       surrogate pair; 1-3 tokens each)
const ASCII_RE = /[\x00-\x7F]/g;
const CJK_RE =
  /[\u0E00-\u0E7F\u0E80-\u0EFF\u1000-\u109F\u1100-\u11FF\u1780-\u17FF\u3000-\u303F\u3040-\u30FF\u3130-\u318F\u3400-\u4DBF\u4E00-\u9FFF\uA960-\uA97F\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]/g;
const HIGH_SURROGATE_RE = /[\uD800-\uDBFF]/g;

/** Worst-case input-token count for one text — the input half of the
 *  estimate≥actual invariant, safe for every script mix. Base64/data-URI
 *  runs must be stripped first (stripHeavy). */
export function estimateInputTokens(text: string): number {
  const ascii = text.match(ASCII_RE)?.length ?? 0;
  const cjk = text.match(CJK_RE)?.length ?? 0;
  const astral = text.match(HIGH_SURROGATE_RE)?.length ?? 0; // 1 per astral char
  // Remaining UTF-16 units are other-BMP chars (1 unit = 1 char each).
  const other = Math.max(0, text.length - ascii - cjk - 2 * astral);
  return Math.ceil(ascii / 3) + Math.ceil(cjk * 1.5) + other + astral * 2;
}

function countImages(text: string): number {
  return (text.match(DATA_URI_RE)?.length ?? 0) + (text.match(BASE64_RUN_RE)?.length ?? 0);
}

function stripHeavy(text: string): string {
  return text.replace(DATA_URI_RE, " ").replace(BASE64_RUN_RE, " ");
}

/** Worst-case USD estimate for one dispatch. Input: the script-aware floors
 *  (ASCII chars/3 for English ~4 ch/tok AND JSON ~3-3.5 ch/tok; CJK at
 *  1.5 tokens/char; astral at 2) + per-message overhead + a fixed floor per
 *  image (explicit counts for vision-style dispatches whose image bytes never
 *  ride inside the texts); output: MAX_OUTPUT_TOKENS priced in full. */
export function estimateDispatchMicroUsd(
  model: string,
  texts: string[],
  images = 0
): number {
  let inputTokens = 0;
  let messageImages = 0;
  let messages = 0;
  for (const t of texts) {
    messages += 1;
    messageImages += countImages(t);
    inputTokens += estimateInputTokens(stripHeavy(t));
  }
  inputTokens +=
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

/** Drain every reported usage in this request (sum across retry attempts —
 *  each attempt that got a billed response DID cost tokens). budget.ts
 *  consumes this for the UsageRecord row AFTER the aiCall resolves. */
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

// S34 — per-hold usage slices. The S27/S32 settle path read peekLastUsage():
// the LAST entry in the REQUEST-scoped sink. Two defects: a dispatch whose
// provider answered without a usage block settled at a STALE usage some
// earlier dispatch in the same request had emitted (under- or over-count,
// depending on the models involved), and a transport that emitted twice (an
// internally retried fetch where both attempts got billed responses) settled
// at only the second. The fix: admitDispatch snapshots the sink size at admit
// time, and the hold settles on exactly the entries emitted since — its own
// attempts, nobody else's. peekLastUsage() was removed with the fix (it had
// no callers outside the settle path).

/** Snapshot of the request sink's size — the hold's baseline. */
export function sinkBaseline(): number {
  const ctx = currentCtx();
  if (!ctx) return 0;
  return sinks.get(ctx)?.length ?? 0;
}

/** Sum of the usage entries emitted since `baseline` (this hold's own
 *  attempts). Undefined when nothing was emitted — the caller settles at
 *  the reserved estimate (a provider that answered without a usage block
 *  may still have billed). */
export function usageSinceBaseline(baseline: number): LLMUsage | undefined {
  const ctx = currentCtx();
  if (!ctx) return undefined;
  const sink = sinks.get(ctx);
  if (!sink || sink.length <= baseline) return undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  for (let i = baseline; i < sink.length; i++) {
    inputTokens += sink[i].inputTokens;
    outputTokens += sink[i].outputTokens;
  }
  return { inputTokens, outputTokens };
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
        "src/lib/tubeforge/spend.ts before authorizing paid dispatches. " +
        "(The TUBEFORGE_PRICING_VERIFIED=1 environment override exists for " +
        "probes and pre-activation checks only; it is announced on stderr " +
        "when active.)"
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
  /** S32/S47 — fail-closed: a failed shared-admission read sets this, and
   *  admitDispatch throws SpendBootFailedError for PAID providers. Unlike
   *  the S32 boot latch there is NO permanent flag: the next admit re-tries
   *  the read, so the gate self-heals once the DB recovers. Ungated
   *  providers (zai/local) are unaffected. */
  bootFailed: boolean;
  /** Mirror of SUM(settled.actualCostMicroUsd) — re-derived from the DB on
   *  every paid admit (S47), grown by every local settle in between. */
  recordedMicro: number;
  /** Mirror of every instance's pending reservation rows (re-derived on
   *  every paid admit) plus this process's own in-flight holds. */
  holds: Map<string, number>; // holdId → reserved estimate
  /** S47 — holds minted WITHOUT a request ctx (probes/tests) never persist
   *  to SpendReservation; tracked here so the per-admit DB re-sync cannot
   *  wipe them. Production dispatches always run under a tenant ctx and are
   *  fully DB-backed. */
  localOnly: Set<string>;
}

const g = globalThis as typeof globalThis & { __tfSpend?: SpendState };
const spend: SpendState = (g.__tfSpend ??= {
  bootFailed: false,
  recordedMicro: 0,
  holds: new Map(),
  localOnly: new Set(),
});

function outstandingMicro(): number {
  let sum = 0;
  for (const v of spend.holds.values()) sum += v;
  return sum;
}

/** S47 — one retry on a Prisma serialization conflict (P2034): the loser
 *  of a concurrent-admission race re-runs the transaction against the
 *  winner's committed rows. Any other error propagates (fail-closed). */
async function admitWithConflictRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if ((err as { code?: string })?.code !== "P2034") throw err;
    return await fn();
  }
}

export interface SpendHold {
  /** Success path: settle at the cost of THIS hold's reported usage (the
   *  sink entries emitted since admit — S34 per-hold slice), or — when the
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
  announceOverridesOnce();
  if (!GATE_ENABLED || !isPaidProvider(opts.provider)) return null;
  // S32 — unverified pricing blocks paid dispatches (belt-and-suspenders on
  // top of the existing "no paid API keys" posture). The operator flips
  // PRICING_STATUS to "verified" after reconciling the registry.
  if (!pricingVerified()) throw new SpendPricingUnverifiedError();
  // S47 — fail-closed on the LAST failed read: this dispatch is refused
  // without touching the DB. The flag clears HERE so the NEXT admit re-tries
  // the shared read (self-healing; a still-broken DB re-sets the flag from
  // the transaction failure below).
  if (spend.bootFailed) {
    spend.bootFailed = false;
    throw new SpendBootFailedError("shared admission unavailable (last read failed)");
  }

  const ctx = currentCtx();
  const est = Math.max(0, Math.round(opts.estimatedMicro));
  // S47 — UUID-keyed holds: two instances minting holds at the same moment
  // can never collide on the SpendReservation primary key.
  const holdId = `spend-${randomUUID()}`;

  // S47 — context-free holds (probes/tests) live only in this process's
  // mirror; the shared DB read cannot see them, so the in-transaction
  // check adds them explicitly. Production dispatches always run under a
  // tenant ctx — their holds are DB rows every instance sees.
  let localOutstanding = 0;
  for (const id of spend.localOnly) {
    const v = spend.holds.get(id);
    if (v !== undefined) localOutstanding += v;
  }

  // S47 — shared admission. READ (settled total + every instance's pending
  // reservations), CHECK the stop line, and INSERT our reservation inside
  // ONE transaction — Serializable on Postgres, so the DB itself serializes
  // concurrent admissions (two instances racing on the same snapshot cannot
  // both commit; the loser retries against the winner's committed rows).
  // SQLite is single-writer, so its default transaction is already
  // serialized. Any read/write failure is fail-CLOSED (SpendBootFailedError)
  // with no permanent latch — the next admit re-tries.
  const { rawDatabase } = await import("./tenant-db");
  const serializable = !`${process.env.DATABASE_URL ?? ""}`.startsWith("file:");
  let fresh: { recorded: number; pendingRows: { id: string; estimatedMicroUsd: number }[] };
  try {
    fresh = await admitWithConflictRetry(() =>
      rawDatabase.$transaction(
        async (tx) => {
          const [settledAgg, pendingRows] = await Promise.all([
            tx.spendReservation.aggregate({
              _sum: { actualCostMicroUsd: true },
              where: { status: "settled", provider: { in: [...PAID_PROVIDERS] } },
            }),
            tx.spendReservation.findMany({
              where: { status: "pending", provider: { in: [...PAID_PROVIDERS] } },
              select: { id: true, estimatedMicroUsd: true },
            }),
          ]);
          const recorded = settledAgg._sum.actualCostMicroUsd ?? 0;
          const outstanding = pendingRows.reduce((s, r) => s + r.estimatedMicroUsd, 0);
          if (recorded + outstanding + localOutstanding + est > STOP_MICRO_USD) {
            throw new SpendBlockedError(
              recorded,
              outstanding + localOutstanding,
              est,
              STOP_MICRO_USD
            );
          }
          // Request-scoped dispatches persist (production always runs under
          // a tenant ctx — job bodies inherit the launching request's ALS).
          // Context-free dispatches (probes/tests) stay process-local, as in
          // S32 — they are not part of the deployed spend surface.
          if (ctx) {
            await tx.spendReservation.create({
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
          }
          return { recorded, pendingRows };
        },
        serializable ? { isolationLevel: "Serializable" } : undefined
      )
    );
  } catch (err) {
    if (err instanceof SpendBlockedError) throw err; // a real gate refusal, not an outage
    spend.bootFailed = true;
    console.error(
      "[spend] shared admission failed — PAID dispatches blocked (fail-closed):",
      err instanceof Error ? err.message : err
    );
    throw new SpendBootFailedError(
      `shared admission failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Re-sync the local mirrors from what the transaction actually saw (every
  // instance's pending rows + the fresh settled total), then add THIS hold.
  // ctx-null (process-local) holds never exist as DB rows — carry them over
  // so the re-sync cannot erase spend the gate has already counted.
  spend.bootFailed = false;
  spend.recordedMicro = fresh.recorded;
  const localOnlyPrev = new Map<string, number>();
  for (const id of spend.localOnly) {
    const v = spend.holds.get(id);
    if (v !== undefined) localOnlyPrev.set(id, v);
  }
  spend.holds.clear();
  for (const row of fresh.pendingRows) spend.holds.set(row.id, row.estimatedMicroUsd);
  for (const [id, v] of localOnlyPrev) spend.holds.set(id, v);
  spend.holds.set(holdId, est);
  if (!ctx) spend.localOnly.add(holdId);

  // S34 — the hold's usage slice starts HERE: everything the request sink
  // already holds belongs to earlier dispatches (already settled off their
  // own slices). settleFromSink reads exactly the entries emitted after
  // this line — this hold's attempts, nobody else's.
  const baseline = sinkBaseline();

  const settle = async (micro: number) => {
    // The hold comes off at the estimate; the recorded total takes the
    // settlement. est ≥ actual is the invariant, so recorded never jumps.
    if (!spend.holds.delete(holdId)) return; // already settled (idempotent)
    spend.localOnly.delete(holdId);
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
      // S34 — the hold's OWN slice, not the request's last entry: a dispatch
      // whose provider answered without a usage block settles at the estimate
      // (never at a stale usage an earlier dispatch emitted), and a transport
      // that emitted twice (both attempts billed) settles at the sum.
      const usage = usageSinceBaseline(baseline);
      await settle(usage ? computeCostMicroUsd(opts.model, usage) : est);
    },
    async settleUncertain() {
      await settle(est);
    },
  };
}
