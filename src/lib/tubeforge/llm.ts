// Provider-agnostic LLM layer — chat + vision.
//
//   provider "zai"    → z-ai-web-dev-sdk (gateway from .z-ai-config) — default,
//                       used for every AI stage when no custom provider is set.
//   provider "openai" → ANY OpenAI-compatible /chat/completions endpoint
//                       (OpenAI, DeepSeek, Groq, Mistral, OpenRouter, Ollama,
//                       LM Studio, vLLM …) configured in Settings → AI Provider.
//
// Config lives in the Setting table (aiProvider / aiBaseUrl / aiApiKey / aiModel),
// cached briefly like the rate budget. If the custom provider is half-configured
// the layer fails safe and falls back to the Z.ai gateway.
//
// The response shape matches zai.chat.completions.create —
// { choices: [{ message: { content } }] } — so call sites stay untouched.
// Image / TTS / ASR / video stages intentionally stay on the Z.ai SDK: those
// APIs are not standardized across providers.

import ZAI from "z-ai-web-dev-sdk";
import { db } from "@/lib/db";
import { safeFetch } from "./net-guard";
import { allowPrivateProviderHosts } from "./providers/http";

export type LLMProvider = "zai" | "openai";

export interface LLMSettings {
  provider: LLMProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
}

const SETTING_KEYS = ["aiProvider", "aiBaseUrl", "aiApiKey", "aiModel"];

const g = globalThis as typeof globalThis & {
  __tfLLM?: { cache: { at: number; cfg: LLMSettings } | null };
};
const llmGlobal = (g.__tfLLM ??= { cache: null });

/** Call after saving provider settings so new calls pick them up instantly. */
export function invalidateLLMSettings() {
  llmGlobal.cache = null;
}

/** Raw saved settings (may be an incomplete "openai" config). Cached ~8s. */
async function readLLMSettings(): Promise<LLMSettings> {
  const now = Date.now();
  if (llmGlobal.cache && now - llmGlobal.cache.at < 8_000) return llmGlobal.cache.cfg;

  const cfg: LLMSettings = { provider: "zai", baseUrl: "", apiKey: "", model: "" };
  try {
    const rows = await db.setting.findMany({ where: { key: { in: SETTING_KEYS } } });
    const map = new Map(rows.map((r) => [r.key, r.value]));
    cfg.provider = map.get("aiProvider") === "openai" ? "openai" : "zai";
    cfg.baseUrl = (map.get("aiBaseUrl") ?? "").trim().replace(/\/+$/, "");
    cfg.apiKey = (map.get("aiApiKey") ?? "").trim();
    cfg.model = (map.get("aiModel") ?? "").trim();
  } catch (err) {
    console.warn("[llm] settings read failed, defaulting to Z.ai:", err);
  }

  llmGlobal.cache = { at: now, cfg };
  return cfg;
}

/** Effective settings — an "openai" choice only applies when fully configured. */
async function effectiveSettings(): Promise<LLMSettings> {
  const s = await readLLMSettings();
  if (s.provider === "openai" && s.baseUrl && s.apiKey) return s;
  if (s.provider === "openai")
    console.warn("[llm] custom LLM selected but baseUrl/apiKey incomplete — using Z.ai gateway");
  return { ...s, provider: "zai" };
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

  // Reasoner-style models (e.g. deepseek-reasoner) answer in reasoning_content.
  const msg = completion?.choices?.[0]?.message as
    | { content?: string; reasoning_content?: string }
    | undefined;
  if (msg && !msg.content && msg.reasoning_content) msg.content = msg.reasoning_content;
  return completion;
}

/** Chat against explicit settings. `thinking` is dropped for OpenAI-compatible providers. */
async function chatWith(s: LLMSettings, body: LLMChatBody, timeoutMs = 300_000): Promise<LLMCompletion> {
  if (s.provider === "openai") {
    const payload: Record<string, unknown> = { messages: body.messages };
    if (s.model) payload.model = s.model;
    if (typeof body.temperature === "number") payload.temperature = body.temperature;
    return openaiFetch(s, "/chat/completions", payload, timeoutMs);
  }
  const zai = await getZai();
  return zai.chat.completions.create(body as never) as Promise<LLMCompletion>;
}

/** Vision against explicit settings (OpenAI-style multimodal content parts). */
async function visionWith(s: LLMSettings, body: LLMChatBody, timeoutMs = 300_000): Promise<LLMCompletion> {
  if (s.provider === "openai") {
    const payload: Record<string, unknown> = { messages: body.messages };
    if (s.model) payload.model = s.model;
    return openaiFetch(s, "/chat/completions", payload, timeoutMs);
  }
  const zai = await getZai();
  return zai.chat.completions.createVision(body as never) as Promise<LLMCompletion>;
}

// ---------- public API used by the pipeline ----------

/** Provider-agnostic chat completion. Drop-in for zai.chat.completions.create. */
export async function llmChat(body: LLMChatBody): Promise<LLMCompletion> {
  return chatWith(await effectiveSettings(), body);
}

/** Provider-agnostic vision completion. Drop-in for zai.chat.completions.createVision. */
export async function llmVision(body: LLMChatBody): Promise<LLMCompletion> {
  return visionWith(await effectiveSettings(), body);
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
