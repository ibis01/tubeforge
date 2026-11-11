// S90 (ROADMAP #9, S76 §5 P3) — provider selection intelligence.
//
// "Extend the existing registry/provider files, budget.ts and spend.ts —
// do not build another provider framework." This module EXTENDS the
// registry with a scoring layer; it replaces nothing and dispatches
// nothing. The paid-dispatch safety rules (admitDispatch, the $5 stop
// line, SpendPricingUnverifiedError, credit holds) stand unchanged — the
// scorer is ADVISORY: it explains provider choices, it never makes them.
//
// The score is the spec's configurable, production-calibrated weighted
// sum of five factors, each 0..1:
//   • quality        — expected output quality for THIS capability (prior)
//   • reliability    — observed success rate, blended with a neutral prior
//   • cost efficiency— priced from spend.ts where a pricing registry
//                      exists (chat), observed from UsageRecords where it
//                      doesn't; THE LAW: unknown pricing is NEVER free
//   • latency        — observed mean latency blended with a prior
//   • fit            — creative-task fit (identity-locked edits, cloning,
//                      local control) from the registry's own notes
//
// PRIORS ARE STARTING BELIEFS, not measurements: every number below is a
// documented judgment derived from the registry's own provider notes and
// production experience, dominated by the organization's own observed
// data as it accumulates (the Bayesian blend). They are versioned with
// the module and recalibrated by editing this table — the pins keep it
// in lockstep with the registry (every registry provider has a priors
// row, or the sync pin fails).
//
// Pure module: no I/O, no DB, fully pinnable offline. The route gathers
// the observations; this module turns them into an explanation.

import {
  PROVIDERS_BY_CAPABILITY,
  type CapabilityId,
  type ProviderMeta,
} from "./providers/registry";
import { isPaidProvider, modelPriced, priceForModel } from "./spend";

// ---------- the priors table ----------

export interface ProviderPriors {
  /** Expected output quality for this capability (0..1). */
  quality: number;
  /** Expected responsiveness, 1 = fast (0..1). */
  latency: number;
  /** Creative-task fit: the capability-specific extras (0..1). */
  fit: number;
}

/**
 * The neutral reliability starting belief — every provider is assumed
 * competent until the org's own records say otherwise (α = 5 calls of
 * prior weight: ~5 observed calls roughly equal the prior).
 */
export const RELIABILITY_PRIOR = 0.9;
export const PRIOR_WEIGHT_CALLS = 5;

/** Chat priors — derived from the registry notes (see registry.ts) and
 *  production experience with the gateway. */
const CHAT_PRIORS: Record<string, ProviderPriors> = {
  zai: { quality: 0.82, latency: 0.8, fit: 0.85 }, // flash models free; the gateway default
  openai: { quality: 0.9, latency: 0.78, fit: 0.9 },
  anthropic: { quality: 0.92, latency: 0.72, fit: 0.88 },
  gemini: { quality: 0.86, latency: 0.82, fit: 0.82 },
  groq: { quality: 0.74, latency: 0.95, fit: 0.7 }, // "ultra-fast" is the whole point
  deepseek: { quality: 0.82, latency: 0.7, fit: 0.75 },
  mistral: { quality: 0.78, latency: 0.76, fit: 0.72 },
  xai: { quality: 0.84, latency: 0.74, fit: 0.76 },
  openrouter: { quality: 0.84, latency: 0.72, fit: 0.8 }, // aggregator: breadth over consistency
  ollama: { quality: 0.62, latency: 0.35, fit: 0.55 }, // local: free, private, CPU-speed
  lmstudio: { quality: 0.6, latency: 0.35, fit: 0.55 },
};

/** TTS priors — fit is dominated by voice CLONING support. */
const TTS_PRIORS: Record<string, ProviderPriors> = {
  zai: { quality: 0.78, latency: 0.85, fit: 0.8 }, // 7 studio voices, zero setup
  zhipu: { quality: 0.88, latency: 0.75, fit: 0.95 }, // the cloning lane
  selfhost: { quality: 0.7, latency: 0.3, fit: 0.85 }, // free forever, CPU speed, cloning
  openai: { quality: 0.82, latency: 0.85, fit: 0.78 },
  elevenlabs: { quality: 0.95, latency: 0.8, fit: 0.9 },
};

/** Image priors — fit is dominated by identity-locked EDIT support. */
const IMAGE_PRIORS: Record<string, ProviderPriors> = {
  zai: { quality: 0.82, latency: 0.7, fit: 0.9 }, // CogView identity-locked edits
  pollinations: { quality: 0.68, latency: 0.25, fit: 0.55 }, // free, 1 img/45s, no edits
  openai: { quality: 0.88, latency: 0.78, fit: 0.88 }, // gpt-image-1 edits
  stability: { quality: 0.8, latency: 0.74, fit: 0.7 },
  fal: { quality: 0.88, latency: 0.8, fit: 0.72 },
  replicate: { quality: 0.86, latency: 0.72, fit: 0.72 },
};

/** Video priors. */
const VIDEO_PRIORS: Record<string, ProviderPriors> = {
  zai: { quality: 0.78, latency: 0.65, fit: 0.85 }, // CogVideoX; Ken Burns needs no AI
  fal: { quality: 0.84, latency: 0.78, fit: 0.8 },
  replicate: { quality: 0.82, latency: 0.7, fit: 0.78 },
  runway: { quality: 0.9, latency: 0.74, fit: 0.82 },
  luma: { quality: 0.86, latency: 0.72, fit: 0.8 },
};

const PRIORS_BY_CAPABILITY: Record<CapabilityId, Record<string, ProviderPriors>> = {
  chat: CHAT_PRIORS,
  tts: TTS_PRIORS,
  image: IMAGE_PRIORS,
  video: VIDEO_PRIORS,
};

/** The conservative stand-in when a registry provider lacks a priors row
 *  (the sync pin should make this unreachable — defense in depth). */
const MISSING_PRIORS: ProviderPriors = { quality: 0.5, latency: 0.5, fit: 0.5 };

export function priorsFor(capability: CapabilityId, providerId: string): ProviderPriors {
  return PRIORS_BY_CAPABILITY[capability][providerId] ?? MISSING_PRIORS;
}

/** Every registry provider has a priors row — the registry-sync law. */
export function priorsComplete(): boolean {
  for (const [cap, providers] of Object.entries(PROVIDERS_BY_CAPABILITY)) {
    for (const p of providers) {
      if (!PRIORS_BY_CAPABILITY[cap as CapabilityId][p.id]) return false;
    }
  }
  return true;
}

// ---------- the weights (configurable, production-calibrated defaults) ----------

export interface ScoreWeights {
  quality: number;
  reliability: number;
  cost: number;
  latency: number;
  fit: number;
}

/** The production-calibrated defaults (sum 100): quality leads, the org's
 *  own reliability record is close behind, cost matters but does not
 *  dominate, latency is a tiebreaker, fit carries the capability-specific
 *  extras. A user who cares more about cost can say so — see
 *  parseScoreWeights + the ai.scoreWeights setting. */
export const DEFAULT_WEIGHTS: ScoreWeights = {
  quality: 30,
  reliability: 25,
  cost: 20,
  latency: 10,
  fit: 15,
};

const WEIGHT_KEYS: (keyof ScoreWeights)[] = ["quality", "reliability", "cost", "latency", "fit"];

/**
 * Tolerant parse of a stored weights override: numbers are clamped to
 * 0..100; junk, missing keys, or an all-zero table falls back to the
 * defaults (a configuration mistake must never zero out the comparison).
 */
export function parseScoreWeights(raw: unknown): ScoreWeights {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_WEIGHTS };
  const r = raw as Record<string, unknown>;
  const out: ScoreWeights = { ...DEFAULT_WEIGHTS };
  let any = false;
  for (const k of WEIGHT_KEYS) {
    const v = Number(r[k]);
    if (Number.isFinite(v) && v >= 0) {
      out[k] = Math.min(v, 100);
      any = true;
    }
  }
  const total = WEIGHT_KEYS.reduce((s, k) => s + out[k], 0);
  if (!any || total === 0) return { ...DEFAULT_WEIGHTS };
  return out;
}

// ---------- the cost factor (THE UNKNOWN-PRICING LAW lives here) ----------

/** A nominal chat call's token shape — a typical script/plan dispatch,
 *  NOT the gate's conservative full-output estimate (that invariant is
 *  spend.ts's to keep; this is the advisory layer's typical-case view). */
export const NOMINAL_CHAT_INPUT_TOKENS = 3_000;
export const NOMINAL_CHAT_OUTPUT_TOKENS = 1_500;

/** Nominal per-call cost for a PRICED (chat) model, micro-USD. */
export function nominalChatCostMicroUsd(model: string): number {
  const p = priceForModel(model);
  return Math.round(
    (NOMINAL_CHAT_INPUT_TOKENS * p.in + NOMINAL_CHAT_OUTPUT_TOKENS * p.out) / 1_000_000
  );
}

/** The cost-efficiency curve: $0 → 1.0, ~$0.025/call → 0.5, ~$0.105 (the
 *  fallback price at nominal shape) → ~0.19, $1+ → near 0. Hyperbolic —
 *  smooth, monotone, and it never rewards an unknown price. */
export function costEfficiencyFromMicroUsd(microUsd: number): number {
  if (microUsd <= 0) return 1;
  return 1 / (1 + microUsd / 25_000);
}

/** What the cost factor is built from — surfaced with every score. */
export type CostBasis = "priced" | "observed" | "free" | "unknown";

/** The cautious factor for an unpriced paid provider: below the middle,
 *  with the reason attached. NEVER 1.0 — that would treat unknown as free. */
export const UNKNOWN_COST_FACTOR = 0.4;

// ---------- the observed-stat blending ----------

export interface ProviderObservation {
  calls: number;
  okCount: number;
  meanLatencyMs: number | null;
  meanCostMicroUsd: number | null;
}

/** Bayesian reliability: (ok + α·prior) / (calls + α). */
export function reliabilityBlend(obs: ProviderObservation | undefined): number {
  if (!obs || obs.calls <= 0) return RELIABILITY_PRIOR;
  return (obs.okCount + PRIOR_WEIGHT_CALLS * RELIABILITY_PRIOR) / (obs.calls + PRIOR_WEIGHT_CALLS);
}

/** Observed mean latency → factor (2s → 1.0, 30s → 0.0), blended with the
 *  prior the same Bayesian way. */
export function latencyBlend(
  obs: ProviderObservation | undefined,
  priorLatency: number
): number {
  const observedFactor = (ms: number) => Math.max(0, Math.min(1, 1 - (ms - 2_000) / 28_000));
  if (!obs || obs.calls <= 0 || obs.meanLatencyMs == null) return priorLatency;
  return (
    (obs.calls * observedFactor(obs.meanLatencyMs) + PRIOR_WEIGHT_CALLS * priorLatency) /
    (obs.calls + PRIOR_WEIGHT_CALLS)
  );
}

// ---------- the score ----------

export interface ScoredProvider {
  provider: string;
  label: string;
  /** True when the user's capability config points here (or the config
   *  shares the provider's credentials). */
  configured: boolean;
  /** 0..100 */
  score: number;
  factors: {
    quality: number;
    reliability: number;
    cost: number;
    latency: number;
    fit: number;
  };
  costBasis: CostBasis;
  /** Nominal per-call estimate (chat: priced; others: observed mean or null). */
  estimatedCostMicroUsd: number | null;
  evidence: {
    calls: number;
    okRate: number | null;
    meanLatencyMs: number | null;
  };
  reasons: string[];
}

export interface ScoreContext {
  /** The user's configured model per provider id (only configured ones). */
  models: Record<string, string>;
  /** The org's observed stats per provider id. */
  observations: Record<string, ProviderObservation>;
  weights: ScoreWeights;
}

/**
 * Non-chat capabilities have no per-model pricing registry, so "free" must
 * be established by DESIGN, not assumed: the bundled Z.ai gateway, your
 * own machine (selfhost), and every documented no-key provider. Anything
 * else that takes a key is paid-facing → unknown until observed.
 */
const FREE_BY_DESIGN = new Set(["zai", "selfhost"]);

function nonChatFreeByDesign(meta: ProviderMeta): boolean {
  return meta.requiresKey === false || FREE_BY_DESIGN.has(meta.id);
}

function costFactor(
  capability: CapabilityId,
  meta: ProviderMeta,
  model: string,
  obs: ProviderObservation | undefined
): { factor: number; basis: CostBasis; micro: number | null; reason: string } {
  if (capability === "chat") {
    if (!isPaidProvider(meta.id)) {
      return { factor: 1, basis: "free", micro: 0, reason: "no per-token billing (gateway/local)" };
    }
    const id = model || meta.models[0]?.id || "";
    const micro = nominalChatCostMicroUsd(id);
    const known = modelPriced(id);
    return {
      factor: costEfficiencyFromMicroUsd(micro),
      basis: "priced",
      micro,
      reason: known
        ? `$${(micro / 1_000_000).toFixed(4)}/call nominal (priced registry)`
        : `unknown model — priced at the conservative fallback ($${(micro / 1_000_000).toFixed(4)}/call nominal), NEVER free`,
    };
  }
  // Non-chat capabilities: observed spend is the truth when it exists;
  // free-by-design is free; a keyed external without observations is
  // UNKNOWN — cautious, never free.
  if (nonChatFreeByDesign(meta)) {
    return { factor: 1, basis: "free", micro: 0, reason: "no per-call billing (gateway/local/free tier)" };
  }
  if (obs && obs.calls > 0 && obs.meanCostMicroUsd != null) {
    return {
      factor: costEfficiencyFromMicroUsd(obs.meanCostMicroUsd),
      basis: "observed",
      micro: obs.meanCostMicroUsd,
      reason: `$${(obs.meanCostMicroUsd / 1_000_000).toFixed(4)}/call observed over ${obs.calls} calls`,
    };
  }
  return {
    factor: UNKNOWN_COST_FACTOR,
    basis: "unknown",
    micro: null,
    reason: "no pricing registry for this capability and no observed spend — cost unknown, never assumed free",
  };
}

/**
 * Score every registry provider for one capability. Deterministic:
 * score desc, then provider id asc.
 */
export function scoreProviders(
  capability: CapabilityId,
  ctx: ScoreContext
): ScoredProvider[] {
  const out: ScoredProvider[] = [];
  for (const meta of PROVIDERS_BY_CAPABILITY[capability]) {
    const priors = priorsFor(capability, meta.id);
    const model = ctx.models[meta.id] ?? "";
    const obs = ctx.observations[meta.id];
    const configured = ctx.models[meta.id] != null;

    const reliability = reliabilityBlend(obs);
    const latency = latencyBlend(obs, priors.latency);
    const cost = costFactor(capability, meta, model, obs);

    const w = ctx.weights;
    const totalWeight = WEIGHT_KEYS.reduce((s, k) => s + w[k], 0);
    const score =
      totalWeight === 0
        ? 0
        : Math.round(
            (100 *
              (w.quality * priors.quality +
                w.reliability * reliability +
                w.cost * cost.factor +
                w.latency * latency +
                w.fit * priors.fit)) /
              totalWeight
          );

    const reasons: string[] = [cost.reason];
    if (obs && obs.calls > 0) {
      reasons.push(
        `${obs.calls} calls · ${Math.round((obs.okCount / obs.calls) * 100)}% ok${
          obs.meanLatencyMs != null ? ` · ${(obs.meanLatencyMs / 1000).toFixed(1)}s avg` : ""
        }`
      );
    } else {
      reasons.push("no observed calls yet — priors only");
    }
    if (priors === MISSING_PRIORS) reasons.push("no priors row (registry sync drift)");

    out.push({
      provider: meta.id,
      label: meta.label,
      configured,
      score,
      factors: {
        quality: priors.quality,
        reliability,
        cost: cost.factor,
        latency,
        fit: priors.fit,
      },
      costBasis: cost.basis,
      estimatedCostMicroUsd: cost.micro,
      evidence: {
        calls: obs?.calls ?? 0,
        okRate: obs && obs.calls > 0 ? obs.okCount / obs.calls : null,
        meanLatencyMs: obs?.meanLatencyMs ?? null,
      },
      reasons,
    });
  }
  out.sort((a, b) => b.score - a.score || a.provider.localeCompare(b.provider));
  return out;
}
