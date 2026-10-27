// Text-generation adapter — one call site, four providers.
//
//   zai       → the bundled Z.ai SDK (shared singleton, global credentials)
//   openai    → POST {baseUrl}/chat/completions   (OpenAI, OpenRouter, Groq,
//               DeepSeek, Ollama, LM Studio — anything OpenAI-shaped)
//   anthropic → POST {baseUrl}/v1/messages
//   gemini    → POST {baseUrl}/v1beta/models/{model}:generateContent
//
// All call sites pass a clean { system, user } pair; each provider maps it to
// its own wire format. Z.ai keeps the exact legacy request shape (leading
// assistant message + thinking disabled) so behavior is unchanged.

import { getZAI } from "../ai";
import { DEFAULT_CHAT_MODEL } from "../types";
import { getCapability, type CapabilityConfig } from "./settings";
import { providerMeta } from "./registry";
import { joinUrl, providerFetchJson } from "./http";

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

export async function chatComplete(
  req: ChatRequest,
  overrides?: Partial<CapabilityConfig>
): Promise<string> {
  const config = await getCapability("chat", overrides);

  switch (config.provider) {
    case "openai":
      return openaiChat(req, config);
    case "anthropic":
      return anthropicChat(req, config);
    case "gemini":
      return geminiChat(req, config);
    case "zai":
    default:
      return zaiChat(req, config);
  }
}

// ---------- Z.ai (SDK — unchanged legacy shape) ----------

async function zaiChat(req: ChatRequest, config: CapabilityConfig): Promise<string> {
  const zai = await getZAI();
  const model = config.model?.trim() || DEFAULT_CHAT_MODEL;
  const completion = await zai.chat.completions.create({
    model,
    messages: [
      { role: "assistant", content: req.system },
      { role: "user", content: req.user },
    ],
    // GLM-4.7 / GLM-5.3 models FORCE thinking — sending "disabled" there
    // errors with code 1210. Everything else accepts the fast direct mode.
    thinking: /^glm-(4\.7|5\.3)/.test(model)
      ? { type: "enabled" }
      : { type: "disabled" },
  });
  return completion.choices[0]?.message?.content ?? "";
}

// ---------- OpenAI-compatible ----------

async function openaiChat(req: ChatRequest, config: CapabilityConfig): Promise<string> {
  const meta = providerMeta("chat", "openai")!;
  const baseUrl = config.baseUrl?.trim() || meta.defaultBaseUrl;
  const model = config.model?.trim() || "gpt-4o-mini";
  const key = config.apiKey?.trim();
  if (!key) throw new Error("OpenAI-compatible chat needs an API key (Settings → AI Providers)");

  const data = await providerFetchJson<OpenAiChatResponse>("OpenAI-compatible", joinUrl(baseUrl, "chat/completions"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      // NOTE: no `thinking` field — that is Z.ai-specific and strict OpenAI
      // servers reject unknown parameters with a 400.
    }),
  });
  return data.choices?.[0]?.message?.content ?? "";
}

// ---------- Anthropic ----------

async function anthropicChat(req: ChatRequest, config: CapabilityConfig): Promise<string> {
  const meta = providerMeta("chat", "anthropic")!;
  const baseUrl = config.baseUrl?.trim() || meta.defaultBaseUrl;
  const model = config.model?.trim() || "claude-sonnet-4-5";
  const key = config.apiKey?.trim();
  if (!key) throw new Error("Anthropic needs an API key (Settings → AI Providers)");

  let url = joinUrl(baseUrl, "v1/messages");
  if (/\/v1$/.test(baseUrl.trim().replace(/\/+$/, ""))) {
    url = joinUrl(baseUrl, "messages"); // user already included /v1
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
      max_tokens: 8192, // required by Anthropic — roomy enough for full scripts
      system: req.system,
      messages: [{ role: "user", content: req.user }],
    }),
  });
  return (data.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("")
    .trim();
}

// ---------- Google Gemini ----------

async function geminiChat(req: ChatRequest, config: CapabilityConfig): Promise<string> {
  const meta = providerMeta("chat", "gemini")!;
  const baseUrl = config.baseUrl?.trim() || meta.defaultBaseUrl;
  const model = config.model?.trim() || "gemini-2.5-flash";
  const key = config.apiKey?.trim();
  if (!key) throw new Error("Gemini needs an API key (Settings → AI Providers)");

  const url = joinUrl(baseUrl, `v1beta/models/${encodeURIComponent(model)}:generateContent`);

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
        responseMimeType: "application/json", // every TubeForge prompt wants JSON
      },
    }),
  });
  return (data.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("")
    .trim();
}
