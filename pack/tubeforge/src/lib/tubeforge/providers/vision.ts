// Vision adapter — powers the artwork quality gate (VLM inspection).
// Follows the chat capability's provider; every supported provider can see
// images. If the provider/model can't do vision the call throws, and the
// quality gate catches it and passes the image through (existing behavior).

import { getZAI } from "../ai";
import { getCapability, type CapabilityConfig } from "./settings";
import { providerMeta } from "./registry";
import { joinUrl, providerFetchJson } from "./http";

export interface VisionRequest {
  system: string;
  user: string;
  /** PNG bytes of the image, base64-encoded (no data: prefix). */
  imagePngBase64: string;
}

export async function visionComplete(
  req: VisionRequest,
  overrides?: Partial<CapabilityConfig>
): Promise<string> {
  const config = await getCapability("chat", overrides);

  switch (config.provider) {
    case "openai":
      return openaiVision(req, config);
    case "anthropic":
      return anthropicVision(req, config);
    case "gemini":
      return geminiVision(req, config);
    case "zai":
    default:
      return zaiVision(req, config);
  }
}

// ---------- Z.ai (SDK — unchanged legacy shape) ----------

async function zaiVision(req: VisionRequest, config: CapabilityConfig): Promise<string> {
  const zai = await getZAI();
  const model = config.visionModel?.trim() ?? "";
  // No stored vision model → send none; the gateway injects its default
  // (preserves pre-existing sandbox behavior), hence the cast.
  const completion = await zai.chat.completions.createVision({
    ...(model ? { model } : {}),
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: `${req.system}\n\n${req.user}` },
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${req.imagePngBase64}` },
          },
        ],
      },
    ],
    thinking: { type: "disabled" },
  } as Parameters<typeof zai.chat.completions.createVision>[0]);
  return completion.choices[0]?.message?.content ?? "";
}

// ---------- OpenAI-compatible ----------

async function openaiVision(req: VisionRequest, config: CapabilityConfig): Promise<string> {
  const meta = providerMeta("chat", "openai")!;
  const baseUrl = config.baseUrl?.trim() || meta.defaultBaseUrl;
  const model = config.visionModel?.trim() || config.model?.trim() || "gpt-4o-mini";
  const key = config.apiKey?.trim();
  if (!key) throw new Error("OpenAI-compatible vision needs an API key");

  const data = await providerFetchJson<{ choices?: { message?: { content?: string } }[] }>(
    "OpenAI-compatible",
    joinUrl(baseUrl, "chat/completions"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: req.system },
          {
            role: "user",
            content: [
              { type: "text", text: req.user },
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${req.imagePngBase64}` },
              },
            ],
          },
        ],
      }),
    }
  );
  return data.choices?.[0]?.message?.content ?? "";
}

// ---------- Anthropic ----------

async function anthropicVision(req: VisionRequest, config: CapabilityConfig): Promise<string> {
  const meta = providerMeta("chat", "anthropic")!;
  const baseUrl = config.baseUrl?.trim() || meta.defaultBaseUrl;
  const model = config.visionModel?.trim() || config.model?.trim() || "claude-sonnet-4-5";
  const key = config.apiKey?.trim();
  if (!key) throw new Error("Anthropic vision needs an API key");

  let url = joinUrl(baseUrl, "v1/messages");
  if (/\/v1$/.test(baseUrl.trim().replace(/\/+$/, ""))) {
    url = joinUrl(baseUrl, "messages");
  }

  const data = await providerFetchJson<{ content?: { type: string; text?: string }[] }>(
    "Anthropic",
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        system: req.system,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: req.user },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: req.imagePngBase64,
                },
              },
            ],
          },
        ],
      }),
    }
  );
  return (data.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("")
    .trim();
}

// ---------- Google Gemini ----------

async function geminiVision(req: VisionRequest, config: CapabilityConfig): Promise<string> {
  const meta = providerMeta("chat", "gemini")!;
  const baseUrl = config.baseUrl?.trim() || meta.defaultBaseUrl;
  const model = config.visionModel?.trim() || config.model?.trim() || "gemini-2.5-flash";
  const key = config.apiKey?.trim();
  if (!key) throw new Error("Gemini vision needs an API key");

  const url = joinUrl(baseUrl, `v1beta/models/${encodeURIComponent(model)}:generateContent`);
  const data = await providerFetchJson<{
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  }>("Gemini", url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [
        {
          role: "user",
          parts: [
            { text: req.user },
            { inlineData: { mimeType: "image/png", data: req.imagePngBase64 } },
          ],
        },
      ],
      generationConfig: { responseMimeType: "application/json" },
    }),
  });
  return (data.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("")
    .trim();
}

/** Whether the current chat provider supports vision (all wired ones do). */
export async function visionSupported(): Promise<boolean> {
  const config = await getCapability("chat");
  return ["zai", "openai", "anthropic", "gemini"].includes(config.provider);
}
