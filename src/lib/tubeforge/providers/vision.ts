// Vision adapter — powers the artwork quality gate (VLM inspection).
// Follows the chat capability's provider; every supported provider can see
// images. If the provider/model can't do vision the call throws, and the
// quality gate catches it and passes the image through (existing behavior).

import { zaiClientFor } from "../zai-client";
import { getCapability, type CapabilityConfig } from "./settings";
import { providerMeta, providerMetaRequired } from "./registry";
import { joinUrl, providerFetchJson, withTimeout } from "./http";
import {
  admitDispatch,
  emitUsage,
  estimateDispatchMicroUsd,
  MAX_OUTPUT_TOKENS,
  usageFromBody,
} from "../spend";

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

  // S27 — the $5 door on the vision line ($1 of the experiment budget):
  // same reserve-before/settle-after law as chat. The image counts as an
  // explicit 4000-token floor in the estimate (its base64 never rides in
  // the texts).
  const model = visionModelFor(config);
  const hold = await admitDispatch({
    provider: config.provider,
    model,
    estimatedMicro: estimateDispatchMicroUsd(
      model,
      [req.system, req.user],
      1
    ),
  });
  try {
    let content: string;
    switch (config.provider) {
      case "openai":
        content = await openaiVision(req, config);
        break;
      case "anthropic":
        content = await anthropicVision(req, config);
        break;
      case "gemini":
        content = await geminiVision(req, config);
        break;
      case "zai":
      default:
        content = await zaiVision(req, config);
    }
    if (hold) await hold.settleFromSink();
    return content;
  } catch (err) {
    if (hold) await hold.settleUncertain();
    throw err;
  }
}

/** The model id a vision dispatch will actually use — mirrors the
 *  per-provider fns' own resolution. */
function visionModelFor(config: CapabilityConfig): string {
  if (config.provider === "zai") return config.visionModel?.trim() ?? "";
  const meta = providerMeta("chat", config.provider);
  return (
    config.visionModel?.trim() ||
    config.model?.trim() ||
    meta?.models[0]?.id ||
    "gpt-4o-mini"
  );
}

// ---------- Z.ai (SDK — unchanged legacy shape) ----------

async function zaiVision(req: VisionRequest, config: CapabilityConfig): Promise<string> {
  const zai = await zaiClientFor("chat");
  const model = config.visionModel?.trim() ?? "";
  // No stored vision model → send none; the gateway injects its default
  // (preserves pre-existing sandbox behavior), hence the cast.
  // 120s deadline: a hung vision call must never stall the quality gate
  // (or the storyboard loop that awaits it) — the gate fails open on error.
  const completion = await withTimeout(120_000, "Z.ai vision", () =>
    zai.chat.completions.createVision({
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
    } as Parameters<typeof zai.chat.completions.createVision>[0])
  );
  // S27 — ungated (platform gateway), but reported tokens reach the meter.
  const usage = usageFromBody(completion);
  if (usage) emitUsage(usage);
  return completion.choices[0]?.message?.content ?? "";
}

// ---------- OpenAI-compatible ----------

async function openaiVision(req: VisionRequest, config: CapabilityConfig): Promise<string> {
  const meta = providerMetaRequired("chat", "openai");
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
        // S27 — output clamp (same law as chat).
        max_tokens: MAX_OUTPUT_TOKENS,
      }),
    }
  );
  // S27 — reported usage (openai wire shape) into the metering sink.
  const usage = usageFromBody(data);
  if (usage) emitUsage(usage);
  return data.choices?.[0]?.message?.content ?? "";
}

// ---------- Anthropic ----------

async function anthropicVision(req: VisionRequest, config: CapabilityConfig): Promise<string> {
  const meta = providerMetaRequired("chat", "anthropic");
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

async function geminiVision(req: VisionRequest, config: CapabilityConfig): Promise<string> {
  const meta = providerMetaRequired("chat", "gemini");
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
  // S27 — gemini wire shape: usageMetadata { promptTokenCount, candidatesTokenCount }.
  const usage = usageFromBody(data);
  if (usage) emitUsage(usage);
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
