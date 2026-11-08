// Provider-agnostic LLM layer — chat + vision.
//
//   provider "zai"    → z-ai-web-dev-sdk (gateway from .z-ai-config) — default,
//                       used for every AI stage when no custom provider is set.
//   provider "openai" → ANY OpenAI-compatible /chat/completions endpoint
//                       (OpenAI, DeepSeek, Groq, Mistral, OpenRouter, Ollama,
//                       LM Studio, vLLM …) configured in Settings → AI Provider.
//
// Settings resolution (cached ~8s per user):
//   1. the MODERN per-capability rows (Settings → AI Providers writes
//      UserSetting "ai.chat" + ProviderCredential("chat", …) via
//      saveCapability) — the source of truth since the capability UI;
//   2. the LEGACY flat rows (aiProvider / aiBaseUrl / aiModel — the pre-
//      capability onboarding) as a fallback for accounts that never touched
//      the capability UI.
// If the custom provider is half-configured the layer fails safe and falls
// back to the Z.ai gateway.
//
// The response shape matches zai.chat.completions.create —
// { choices: [{ message: { content } }] } — so call sites stay untouched.
// Image / TTS / ASR / video stages intentionally stay on the Z.ai SDK: those
// APIs are not standardized across providers.

import ZAI from "z-ai-web-dev-sdk";
import { safeFetch } from "./net-guard";
import { allowPrivateProviderHosts } from "./providers/http";
import { getCapability } from "./providers/settings";
import { currentCtx } from "./tenant";
import { getProviderCredential, getUserSettings } from "./settings";
import { log } from "./log";

// S57/T-57.2 — the module's logger (the old [llm] prefix became a binding).
const llmLog = log.child({ mod: "llm" });
import {
  admitDispatch,
  emitUsage,
  estimateDispatchMicroUsd,
  MAX_OUTPUT_TOKENS,
  usageFromBody,
  type LLMUsage,
} from "./spend";

export type { LLMUsage };

export type LLMProvider = "zai" | "openai";

export interface LLMSettings {
  provider: LLMProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
}

const g = globalThis as typeof globalThis & {
  __tfLLM?: { cache: Map<string, { at: number; cfg: LLMSettings }> };
};
const llmGlobal = (g.__tfLLM ??= { cache: new Map() });

/** Call after saving provider settings so new calls pick them up instantly. */
export function invalidateLLMSettings() {
  llmGlobal.cache.clear();
}

/** Raw saved settings for the ACTING USER (may be an incomplete "openai" config). Cached ~8s. */
async function readLLMSettings(): Promise<LLMSettings> {
  const now = Date.now();
  const ctx = currentCtx();
  if (!ctx) return { provider: "zai", baseUrl: "", apiKey: "", model: "" }; // no acting user (platform path) — Z.ai gateway
  const cached = llmGlobal.cache.get(ctx.userId);
  if (cached && now - cached.at < 8_000) return cached.cfg;

  const cfg: LLMSettings = { provider: "zai", baseUrl: "", apiKey: "", model: "" };
  try {
    const map = await getUserSettings(["ai.chat", "aiProvider", "aiBaseUrl", "aiModel"]);
    // Modern capability row FIRST — the Settings → AI Providers card writes
    // here (saveCapability). Without this, a provider picked in the modern
    // UI never reached the Director: llmChat kept reading the legacy flat
    // rows and silently stayed on the Z.ai gateway.
    const modern = map.get("ai.chat");
    if (modern) {
      try {
        const blob = JSON.parse(modern) as { provider?: string; model?: string };
        if (blob.provider === "openai") {
          // getCapability re-uses the same parser as the settings route and
          // injects the ProviderCredential secret half (baseUrl fallback).
          const cap = await getCapability("chat");
          cfg.provider = "openai";
          cfg.baseUrl = (cap.baseUrl ?? "").trim().replace(/\/+$/, "");
          cfg.model = (blob.model ?? "").trim();
          cfg.apiKey = (cap.apiKey ?? "").trim();
        } else {
          // Z.ai gateway — an explicit chat-model pick rides along to the
          // SDK call (previously the pick only ever reached image/TTS paths).
          cfg.model = typeof blob.model === "string" ? blob.model.trim() : "";
        }
      } catch {
        /* corrupt ai.chat row — fall through to the legacy rows */
      }
    }
    if (!modern) {
      cfg.provider = map.get("aiProvider") === "openai" ? "openai" : "zai";
      cfg.baseUrl = (map.get("aiBaseUrl") ?? "").trim().replace(/\/+$/, "");
      cfg.model = (map.get("aiModel") ?? "").trim();
      if (cfg.provider === "openai") {
        const cred = await getProviderCredential("chat", "openai");
        cfg.apiKey = cred?.apiKey?.trim() ?? "";
      }
    }
  } catch (err) {
    llmLog.warn("settings read failed, defaulting to Z.ai", { err });
  }

  llmGlobal.cache.set(ctx.userId, { at: now, cfg });
  return cfg;
}

/** Effective settings — an "openai" choice only applies when fully configured. */
async function effectiveSettings(): Promise<LLMSettings> {
  const s = await readLLMSettings();
  if (s.provider === "openai" && s.baseUrl && s.apiKey) return s;
  if (s.provider === "openai")
    llmLog.warn("custom LLM selected but baseUrl/apiKey incomplete — using Z.ai gateway");
  // The half-configured provider's model name must NOT ride to the gateway —
  // it names a model the gateway may not serve.
  return { ...s, provider: "zai", model: "" };
}

// ---------- Z.ai gateway client (own instance — no import cycle with ai.ts) ----------

let zaiClient: Awaited<ReturnType<typeof ZAI.create>> | null = null;
async function getZai() {
  zaiClient ??= await ZAI.create();
  return zaiClient;
}

/** Whether the Z.ai gateway (from .z-ai-config) is usable — shown in Settings. */
export async function zaiConfigured(): Promise<boolean> {
  try {
    await getZai();
    return true;
  } catch {
    return false;
  }
}

// ---------- OpenAI-compatible transport ----------

export interface LLMMessage {
  role: string;
  content: unknown;
}

export interface LLMChatBody {
  messages: LLMMessage[];
  thinking?: { type?: string };
  temperature?: number;
}

export interface LLMCompletion {
  choices: { message: { content?: string; reasoning_content?: string } }[];
  /** S27 — the provider's reported token usage, normalized off the wire
   *  (openai/anthropic/gemini/zai shapes) when the provider sent one.
   *  budget.ts records it into UsageRecord and prices it. */
  usage?: LLMUsage;
}

async function openaiFetch(
  s: LLMSettings,
  path: string,
  payload: Record<string, unknown>,
  timeoutMs: number
): Promise<LLMCompletion> {
  // safeFetch: destination validated (public hosts unless
  // TUBEFORGE_ALLOW_PRIVATE_HOSTS=1 for self-hosted servers), redirects
  // re-validated, 256 MB response cap, AbortSignal timeout kept.
  const res = await safeFetch(`${s.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${s.apiKey}`,
    },
    body: JSON.stringify(payload),
    timeoutMs,
    maxBytes: 256 * 1024 * 1024,
    allowPrivateHosts: allowPrivateProviderHosts(),
  });
  if (!res.ok)
    throw new Error(
      `API request failed with status ${res.status}: ${(await res.text()).slice(0, 300)}`
    );
  const completion = (await res.json()) as LLMCompletion;

  // S27 — capture the provider's reported token usage (openai shape; the
  // normalizer also accepts anthropic/gemini keys for compatibility) and
  // emit it into the request-scoped sink for the metering layer.
  const usage = usageFromBody(completion);
  if (usage) {
    completion.usage = usage;
    emitUsage(usage);
  }

  // Reasoner-style models (e.g. deepseek-reasoner) answer in reasoning_content.
  const msg = completion?.choices?.[0]?.message as
    | { content?: string; reasoning_content?: string }
    | undefined;
  if (msg && !msg.content && msg.reasoning_content) msg.content = msg.reasoning_content;
  return completion;
}

/** Flatten one message's content for the spend estimator — multimodal
 *  parts JSON-stringify so the estimator's data-URI/base64 rules see them. */
function contentText(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content ?? "");
}

/** S27 — the $5 door on the legacy layer: a paid dispatch reserves its
 *  worst-case USD estimate BEFORE the request leaves and settles after —
 *  at the reported usage when one arrived, else conservatively at the
 *  estimate; a thrown dispatch settles uncertain (the provider may have
 *  billed an accepted request). Zai/local dispatches are ungated (null
 *  hold) but still emit usage for the metering row. */
async function gated<T>(
  s: LLMSettings,
  texts: string[],
  dispatch: () => Promise<T>
): Promise<T> {
  const hold = await admitDispatch({
    provider: s.provider,
    model: s.model,
    estimatedMicro: estimateDispatchMicroUsd(s.model || "gpt-4o", texts),
  });
  try {
    const result = await dispatch();
    if (hold) await hold.settleFromSink();
    return result;
  } catch (err) {
    if (hold) await hold.settleUncertain();
    throw err;
  }
}

/** Chat against explicit settings. `thinking` is dropped for OpenAI-compatible providers.
 * S48 — `modelHint` (e.g. the Director's "glm-4.6") applies ONLY when the
 * operator has not pinned an explicit chat model: the operator's Settings
 * pick always wins, the hint just upgrades the platform gateway default
 * for work that has proven to need a director-grade model. */
async function chatWith(s: LLMSettings, body: LLMChatBody, timeoutMs = 300_000, modelHint?: string): Promise<LLMCompletion> {
  const model = resolveChatModel(s.model, modelHint);
  if (s.provider === "openai") {
    // MAX_OUTPUT_TOKENS clamps the output half of the cost bound — the
    // estimate prices all 8192, so reported usage can never exceed it.
    const payload: Record<string, unknown> = {
      messages: body.messages,
      max_tokens: MAX_OUTPUT_TOKENS,
    };
    if (model) payload.model = model;
    if (typeof body.temperature === "number") payload.temperature = body.temperature;
    return gated(s, body.messages.map((m) => contentText(m.content)), () =>
      openaiFetch(s, "/chat/completions", payload, timeoutMs)
    );
  }
  const zai = await getZai();
  // An explicit chat-model pick (Settings → AI Providers) rides to the
  // gateway; absent = the gateway's own default, exactly as before.
  const completion = (await zai.chat.completions.create(
    (model ? { ...body, model } : body) as never
  )) as LLMCompletion;
  // Ungated (platform gateway) — but the tokens still reach the meter.
  const usage = usageFromBody(completion);
  if (usage) {
    completion.usage = usage;
    emitUsage(usage);
  }
  return completion;
}

/** S48 — the model-resolution precedence, extracted PURE so the unit suite
 * can pin it: operator pick (Settings) > caller hint > gateway default.
 * The S47 director benchmark measured the platform default (glm-4.5-flash)
 * failing the narrative re-run 3/3 — callers with director-grade needs pass
 * a hint instead of silently riding the weakest default. */
export function resolveChatModel(
  settingsModel: string | null | undefined,
  modelHint?: string
): string {
  const pinned = (settingsModel ?? "").trim();
  if (pinned) return pinned;
  return (modelHint ?? "").trim();
}

/** Vision against explicit settings (OpenAI-style multimodal content parts). */
async function visionWith(s: LLMSettings, body: LLMChatBody, timeoutMs = 300_000): Promise<LLMCompletion> {
  if (s.provider === "openai") {
    const payload: Record<string, unknown> = {
      messages: body.messages,
      max_tokens: MAX_OUTPUT_TOKENS,
    };
    if (s.model) payload.model = s.model;
    return gated(s, body.messages.map((m) => contentText(m.content)), () =>
      openaiFetch(s, "/chat/completions", payload, timeoutMs)
    );
  }
  const zai = await getZai();
  const completion = (await zai.chat.completions.createVision(body as never)) as LLMCompletion;
  const usage = usageFromBody(completion);
  if (usage) {
    completion.usage = usage;
    emitUsage(usage);
  }
  return completion;
}

// ---------- public API used by the pipeline ----------

/** Provider-agnostic chat completion. Drop-in for zai.chat.completions.create.
 * S48: the optional model hint upgrades the gateway default (see
 * resolveChatModel) for director-grade callers — never overrides the
 * operator's Settings pick. */
export async function llmChat(
  body: LLMChatBody,
  opts?: { modelHint?: string }
): Promise<LLMCompletion> {
  return chatWith(await effectiveSettings(), body, 300_000, opts?.modelHint);
}

/** Provider-agnostic vision completion. Drop-in for zai.chat.completions.createVision. */
export async function llmVision(body: LLMChatBody): Promise<LLMCompletion> {
  return visionWith(await effectiveSettings(), body);
}

export interface WebSearchResult {
  url: string;
  name: string;
  snippet: string;
  host: string;
}

/**
 * Real web search via the Z.ai gateway's web_search function (Stage 5,
 * module A — research grounding). Z.ai-SDK-only by design, like vision:
 * there is no cross-provider standard for search. Returns [] on ANY failure
 * (no key, gateway down, empty result) — callers treat sources as optional
 * enrichment, never a dependency: a scan without sources is still a scan.
 */
export async function llmWebSearch(query: string, num = 10): Promise<WebSearchResult[]> {
  if (!query.trim()) return [];
  try {
    const zai = await getZai();
    const results = (await zai.functions.invoke("web_search", {
      query: query.trim().slice(0, 400),
      num: Math.min(Math.max(num, 1), 20),
    })) as { url?: string; name?: string; snippet?: string; host_name?: string }[];
    return (Array.isArray(results) ? results : [])
      .filter((r) => typeof r?.url === "string" && /^https?:\/\//.test(r.url))
      .slice(0, 20)
      .map((r) => ({
        url: String(r.url).slice(0, 300),
        name: String(r.name ?? "").slice(0, 160),
        snippet: String(r.snippet ?? "").slice(0, 300),
        host: String(r.host_name ?? "").slice(0, 100),
      }));
  } catch {
    return []; // fail-open — see the doc comment
  }
}

/**
 * One tiny round-trip used by the Settings → "Test connection" button.
 * `override` merges over saved settings so a key can be tested before saving.
 */
export async function testLLM(
  override?: Partial<LLMSettings>
): Promise<{ settings: LLMSettings; reply: string }> {
  const saved = await readLLMSettings();
  const s: LLMSettings = {
    provider: override?.provider ?? saved.provider,
    baseUrl: (override?.baseUrl ?? saved.baseUrl).trim().replace(/\/+$/, ""),
    apiKey: (override?.apiKey ?? saved.apiKey).trim(),
    model: (override?.model ?? saved.model).trim(),
  };

  if (s.provider === "openai" && (!s.baseUrl || !s.apiKey))
    throw new Error("Custom LLM selected but base URL / API key is missing");
  if (s.provider === "zai" && !(await zaiConfigured()))
    throw new Error("Z.ai gateway not configured — create .z-ai-config (see LOCAL-SETUP.md §4)");

  const completion = await chatWith(
    s,
    { messages: [{ role: "user", content: "Reply with the single word: pong" }] },
    25_000
  );
  return { settings: s, reply: (completion.choices[0]?.message?.content ?? "").trim().slice(0, 80) };
}
