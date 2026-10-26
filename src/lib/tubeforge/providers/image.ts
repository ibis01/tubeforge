// Artwork adapter — thumbnails, storyboard scenes, portraits, pose sheets.
//
//   zai    → bundled Z.ai SDK (CogView, data[0].base64, supports identity
//            edits seeded from a reference portrait)
//   openai → POST {baseUrl}/images/generations (DALL·E 3 / gpt-image-1) and
//            multipart /images/edits for gpt-image-1 / dall-e-2
//
// imageEdit() returns null when the provider/model can't edit images —
// callers fall back to a prompt-seeded fresh generation (cast fragment), the
// same path used when no reference portrait exists.

import { getZAI } from "../ai";
import { getCapability, type CapabilityConfig } from "./settings";
import { providerMeta } from "./registry";
import { joinUrl, providerFetch, providerFetchJson } from "./http";

export interface ImageRequest {
  prompt: string;
  /** App-internal size, e.g. "1344x768" (wide) or "1024x1024" (square). */
  size: string;
}

export interface ImageEditRequest extends ImageRequest {
  /** Reference PNG, base64 (no data: prefix). */
  imagePngBase64: string;
}

const DALL_E_3_SIZES = ["1024x1024", "1792x1024", "1024x1792"];
const GPT_IMAGE_SIZES = ["1024x1024", "1536x1024", "1024x1536"];

/** Map an app size onto the model's supported sizes. */
export function mapImageSize(model: string, size: string): string {
  if (model.startsWith("gpt-image")) {
    if (size === "1024x1024") return "1024x1024";
    if (size === "1024x1792") return "1024x1536";
    return "1536x1024"; // wide / anything else → landscape
  }
  if (model === "dall-e-2") return "1024x1024"; // square only
  // dall-e-3 default
  if (size === "1024x1024") return "1024x1024";
  if (size === "1024x1792") return "1024x1792";
  return "1792x1024"; // wide / anything else → landscape
}

/** Whether the current image provider can do identity-locked edits at all. */
export async function imageEditSupported(
  overrides?: Partial<CapabilityConfig>
): Promise<boolean> {
  const config = await getCapability("image", overrides);
  if (config.provider === "zai") return true;
  const model = config.model?.trim() || "dall-e-3";
  return model !== "dall-e-3"; // DALL·E 3 has no edits endpoint
}

/** Fresh generation; always returns PNG bytes. */
export async function imageGenerate(
  req: ImageRequest,
  overrides?: Partial<CapabilityConfig>
): Promise<Buffer> {
  const config = await getCapability("image", overrides);
  if (config.provider === "openai") {
    return openaiImage(req, config);
  }
  return zaiImage(req);
}

/** Identity-locked edit seeded from a reference image. null = unsupported. */
export async function imageEdit(
  req: ImageEditRequest,
  overrides?: Partial<CapabilityConfig>
): Promise<Buffer | null> {
  const config = await getCapability("image", overrides);
  if (config.provider === "openai") {
    return openaiImageEdit(req, config);
  }
  return zaiImageEdit(req);
}

// ---------- Z.ai (SDK — unchanged legacy shape) ----------

async function zaiImage(req: ImageRequest): Promise<Buffer> {
  const zai = await getZAI();
  const response = await zai.images.generations.create({
    prompt: req.prompt,
    // App only ever passes "1344x768" (wide) or "1024x1024" (square).
    size: req.size as "1344x768" | "1024x1024",
  });
  const base64 = response.data[0]?.base64;
  if (!base64) throw new Error("Image generation returned no data");
  const buffer = Buffer.from(base64, "base64");
  if (buffer.length < 1000) throw new Error("Generated image is empty");
  return buffer;
}

async function zaiImageEdit(req: ImageEditRequest): Promise<Buffer> {
  const zai = await getZAI();
  // NOTE: the SDK's .d.ts wrongly declares `image`, but the live Z.ai edit
  // endpoint takes `images: [{url}]` (proven by working pose generation) —
  // the SDK posts the body verbatim, hence the cast.
  const response = await zai.images.generations.edit({
    prompt: req.prompt,
    images: [{ url: `data:image/png;base64,${req.imagePngBase64}` }],
    size: req.size as "1344x768" | "1024x1024",
  } as Parameters<typeof zai.images.generations.edit>[0]);
  const base64 = response.data[0]?.base64;
  if (!base64) throw new Error("Image edit returned no data");
  const buffer = Buffer.from(base64, "base64");
  if (buffer.length < 1000) throw new Error("Edited image is empty");
  return buffer;
}

// ---------- OpenAI-compatible ----------

function decodeB64(provider: string, b64: unknown, what: string): Buffer {
  if (typeof b64 !== "string" || !b64) {
    throw new Error(`${provider} ${what} returned no image data`);
  }
  const buffer = Buffer.from(b64, "base64");
  if (buffer.length < 1000) throw new Error(`${provider} ${what} image is empty`);
  return buffer;
}

async function openaiImage(req: ImageRequest, config: CapabilityConfig): Promise<Buffer> {
  const meta = providerMeta("image", "openai")!;
  const baseUrl = config.baseUrl?.trim() || meta.defaultBaseUrl;
  const model = config.model?.trim() || "dall-e-3";
  const key = config.apiKey?.trim();
  if (!key) throw new Error("OpenAI-compatible images need an API key (Settings → AI Providers)");

  const isGptImage = model.startsWith("gpt-image");
  const body: Record<string, unknown> = {
    model,
    prompt: req.prompt,
    size: mapImageSize(model, req.size),
  };
  // gpt-image-1 always returns b64_json and rejects response_format.
  if (!isGptImage) body.response_format = "b64_json";

  const data = await providerFetchJson<{ data?: { b64_json?: string; url?: string }[] }>(
    "OpenAI-compatible images",
    joinUrl(baseUrl, "images/generations"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    }
  );
  const first = data.data?.[0];
  if (first?.b64_json) return decodeB64("OpenAI-compatible", first.b64_json, "image");
  if (first?.url) {
    // Some mirrors return a URL — pull the bytes.
    const response = await providerFetch("OpenAI-compatible images", first.url, {});
    return Buffer.from(new Uint8Array(await response.arrayBuffer()));
  }
  throw new Error("Image generation returned no data");
}

async function openaiImageEdit(
  req: ImageEditRequest,
  config: CapabilityConfig
): Promise<Buffer | null> {
  const meta = providerMeta("image", "openai")!;
  const baseUrl = config.baseUrl?.trim() || meta.defaultBaseUrl;
  const model = config.model?.trim() || "dall-e-3";
  const key = config.apiKey?.trim();
  if (!key) throw new Error("OpenAI-compatible images need an API key (Settings → AI Providers)");

  // DALL·E 3 has no edits endpoint — fall back to prompt-seeded generation.
  if (model === "dall-e-3") return null;

  const form = new FormData();
  form.append(
    "image",
    new Blob([new Uint8Array(Buffer.from(req.imagePngBase64, "base64"))], {
      type: "image/png",
    }),
    "reference.png"
  );
  form.append("model", model);
  form.append("prompt", req.prompt);
  form.append("size", mapImageSize(model, req.size));
  if (!model.startsWith("gpt-image")) form.append("response_format", "b64_json");

  const data = await providerFetchJson<{ data?: { b64_json?: string }[] }>(
    "OpenAI-compatible image edit",
    joinUrl(baseUrl, "images/edits"),
    { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form }
  );
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) return null; // provider ignored the edit — let the caller fall back
  return decodeB64("OpenAI-compatible", b64, "image edit");
}
