import { zaiClientFor } from "../zai-client";
import { DEFAULT_CHAT_MODEL } from "../types";
import { getCapability, type CapabilityConfig } from "./settings";
import { providerMeta } from "./registry";
import { joinUrl, providerFetchJson } from "./http";
import {
  admitDispatch,
  emitUsage,
  estimateDispatchMicroUsd,
  MAX_OUTPUT_TOKENS,
  usageFromBody,
} from "../spend";

export interface ChatRequest {
  system: string;
  user: string;
}

interface OpenAiChatResponse {
  choices?: { message?: { content?: string } }[];
}

interface AnthropicResponse {
  content?: { type: string; text?: string }[];
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
}

// Providers that speak OpenAI's wire format — one handler covers all of them.
const OPENAI_COMPATIBLE = new Set([
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
  "ollama",
  "lmstudio",
  "vllm",
]);

export async function chatComplete(
  req: ChatRequest,
  overrides?: Partial<CapabilityConfig>,
): Promise<string> {
  const config = await getCapability("chat", overrides);
  const provider = config.provider;

  // S27 — the $5 door: paid dispatches reserve their worst-case estimate
  // BEFORE the request leaves and settle after (actual usage when the
  // provider reported one, else the estimate; a thrown dispatch settles
  // uncertain). Zai gateway + local servers are ungated (null hold) but
  // still emit usage at the transport for the metering row.
  const model = modelFor(provider, config);
  const hold = await admitDispatch({
    provider,
    model,
    estimatedMicro: estimateDispatchMicroUsd(model, [req.system, req.user]),
  });
  try {
    let content: string;
    if (OPENAI_COMPATIBLE.has(provider)) content = await openaiChat(req, config);
    else
      switch (provider) {
        case "anthropic":
          content = await anthropicChat(req, config);
          break;
        case "gemini":
          content = await geminiChat(req, config);
          break;
        case "zai":
        default:
          content = await zaiChat(req, config);
      }
    if (hold) await hold.settleFromSink();
    return content;
  } catch (err) {
    if (hold) await hold.settleUncertain();
    throw err;
  }
}

/** The model id a dispatch will actually use — mirrors each per-provider
 *  fn's own resolution (the gate prices THIS id). */
function modelFor(provider: string, config: CapabilityConfig): string {
  if (OPENAI_COMPATIBLE.has(provider)) {
    const meta = providerMeta("chat", provider);
    return config.model?.trim() || meta?.models[0]?.id || "gpt-4o-mini";
  }
  switch (provider) {
    case "anthropic":
      return config.model?.trim() || "claude-sonnet-4-5";
    case "gemini":
      return config.model?.trim() || "gemini-2.5-flash";
    default:
      return config.model?.trim() || DEFAULT_CHAT_MODEL;
  }
}

// ---------- Z.ai (SDK — legacy shape, model-aware thinking) ----------

async function zaiChat(
  req: ChatRequest,
  config: CapabilityConfig,
): Promise<string> {
  const zai = await zaiClientFor("chat");
  const model = config.model?.trim() || DEFAULT_CHAT_MODEL;
  const completion = await zai.chat.completions.create({
    model,
    messages: [
      { role: "assistant", content: req.system },
      { role: "user", content: req.user },
    ],
    thinking: /^glm-(4\.7|5\.3)/.test(model)
      ? { type: "enabled" }
      : { type: "disabled" },
  });
  // S27 — ungated (platform gateway), but reported tokens reach the meter.
  const usage = usageFromBody(completion);
  if (usage) emitUsage(usage);
  return completion.choices[0]?.message?.content ?? "";
}

// ---------- OpenAI-compatible (covers ~14 providers) ----------

async function openaiChat(
  req: ChatRequest,
  config: CapabilityConfig,
): Promise<string> {
  const meta = providerMeta("chat", config.provider);
  const baseUrl =
    config.baseUrl?.trim() ||
    meta?.defaultBaseUrl ||
    "https://api.openai.com/v1";
  const model = config.model?.trim() || meta?.models[0]?.id || "gpt-4o-mini";
  const key = config.apiKey?.trim();

  // FIXED: This now works because meta has requiresKey in the new registry.ts
  const requiresKey = meta?.requiresKey !== false;

  // Local servers (Ollama / LM Studio / vLLM) don't need a key — skip the check.
  if (!key && requiresKey) {
    const who = meta?.label ?? config.provider;
    throw new Error(`${who} needs an API key (Settings → AI Providers)`);
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  // Only attach auth when we actually have a key — some local servers
  // reject an empty `Authorization:` header outright.
  if (key) headers.Authorization = `Bearer ${key}`;

  const data = await providerFetchJson<OpenAiChatResponse>(
    meta?.label ?? "OpenAI-compatible",
    joinUrl(baseUrl, "chat/completions"),
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
        // S27 — the output clamp: the spend estimate prices MAX_OUTPUT_TOKENS
        // in full, so the response can never blow past the reserved cost.
        max_tokens: MAX_OUTPUT_TOKENS,
      }),
    },
  );
  // S27 — reported usage (openai wire shape) into the metering sink.
  const usage = usageFromBody(data);
  if (usage) emitUsage(usage);
  return data.choices?.[0]?.message?.content ?? "";
}

// ---------- Anthropic ----------

async function anthropicChat(
  req: ChatRequest,
  config: CapabilityConfig,
): Promise<string> {
  const meta = providerMeta("chat", "anthropic")!;
  const baseUrl = config.baseUrl?.trim() || meta.defaultBaseUrl;
  const model = config.model?.trim() || "claude-sonnet-4-5";
  const key = config.apiKey?.trim();
  if (!key)
    throw new Error("Anthropic needs an API key (Settings → AI Providers)");

  let url = joinUrl(baseUrl, "v1/messages");
  if (/\/v1$/.test(baseUrl.trim().replace(/\/+$/, ""))) {
    url = joinUrl(baseUrl, "messages");
  }

  const data = await providerFetchJson<AnthropicResponse>("Anthropic", url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      system: req.system,
      messages: [{ role: "user", content: req.user }],
    }),
  });
  // S27 — anthropic wire shape: usage { input_tokens, output_tokens }.
  const usage = usageFromBody(data);
  if (usage) emitUsage(usage);
  return (data.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("")
    .trim();
}

// ---------- Google Gemini ----------

async function geminiChat(
  req: ChatRequest,
  config: CapabilityConfig,
): Promise<string> {
  const meta = providerMeta("chat", "gemini")!;
  const baseUrl = config.baseUrl?.trim() || meta.defaultBaseUrl;
  const model = config.model?.trim() || "gemini-2.5-flash";
  const key = config.apiKey?.trim();
  if (!key)
    throw new Error("Gemini needs an API key (Settings → AI Providers)");

  const url = joinUrl(
    baseUrl,
    `v1beta/models/${encodeURIComponent(model)}:generateContent`,
  );

  const data = await providerFetchJson<GeminiResponse>("Gemini", url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": key,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: "user", parts: [{ text: req.user }] }],
      generationConfig: {
        maxOutputTokens: 8192,
        responseMimeType: "application/json",
      },
    }),
  });
  // S27 — gemini wire shape: usageMetadata { promptTokenCount, candidatesTokenCount }.
  const usage = usageFromBody(data);
  if (usage) emitUsage(usage);
  return (data.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("")
    .trim();
}
