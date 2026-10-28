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
//
// z.ai occasionally returns HTTP 200 with a body that has no `data` field
// (capacity / soft-rate-limit envelopes). The z-ai-web-dev-sdk then crashes
// with "Cannot read properties of undefined (reading 'map')" because it does
// `result.data.map(...)` unguarded. We catch that TypeError here and rethrow
// as a 429-flavored message so the budget.ts retry layer treats it as a
// rate-limit storm and backs off (instead of failing the storyboard).

import { getZAI } from "../ai";
import { redactText } from "../redact";
import { getCapability, type CapabilityConfig } from "./settings";
import { providerMeta } from "./registry";
import { joinUrl, providerFetch, providerFetchJson, ProviderHttpError } from "./http";

/** True when an error looks like the SDK's "result.data.map" crash. */
function isMalformedSdkResponse(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /reading 'map'|reading "map"/i.test(err.message);
}

/** Wrap an SDK image call: convert malformed-response TypeErrors into a
 *  retryable, 429-flavored error so budget.ts backs off. */
async function callZaiImage<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isMalformedSdkResponse(err)) {
      // Upstream sent 200 but the body was missing `data` — almost always a
      // capacity / soft-rate-limit envelope. Make the retry layer see "429".
      throw new Error(
        `429 too many requests — ${label} returned a malformed response (no data field), treating as rate limit`
      );
    }
    throw err;
  }
}

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
  if (config.provider === "pollinations") return false; // URL-only API, no edits
  const model = config.model?.trim() || "dall-e-3";
  return model !== "dall-e-3"; // DALL·E 3 has no edits endpoint
}

/** Fresh generation; always returns PNG bytes. */
export async function imageGenerate(
  req: ImageRequest,
  overrides?: Partial<CapabilityConfig>
): Promise<Buffer> {
  const config = await getCapability("image", overrides);
  if (config.provider === "pollinations") {
    return pollinationsImage(req, config);
  }
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
  if (config.provider === "pollinations") {
    return null; // URL-only API — caller falls back to prompt-seeded generation
  }
  if (config.provider === "openai") {
    return openaiImageEdit(req, config);
  }
  return zaiImageEdit(req);
}

// ---------- Z.ai (SDK — unchanged legacy shape) ----------

async function zaiImage(req: ImageRequest): Promise<Buffer> {
  const zai = await getZAI();
  const response = await callZaiImage("Z.ai image", () =>
    zai.images.generations.create({
      prompt: req.prompt,
      // App only ever passes "1344x768" (wide) or "1024x1024" (square).
      size: req.size as "1344x768" | "1024x1024",
    })
  );
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
  const response = await callZaiImage("Z.ai image edit", () =>
    zai.images.generations.edit({
      prompt: req.prompt,
      images: [{ url: `data:image/png;base64,${req.imagePngBase64}` }],
      size: req.size as "1344x768" | "1024x1024",
    } as Parameters<typeof zai.images.generations.edit>[0])
  );
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

// ---------- Pollinations.ai (free, URL-based, no API key) ----------
//
// URL shape:  https://image.pollinations.ai/prompt/{url-encoded-prompt}?width=W&height=H&model=flux&nologo=true&seed=N
// Returns the image bytes directly. Pollinations:
//   * currently returns JPEG bytes regardless of the URL path (we convert to PNG below);
//   * caps the resolution on the free tier (1024x576 requests come back as 1015x580);
//   * occasionally returns 503 SERVICE_UNAVAILABLE during heavy load — the body says
//     "Retry after 10s", so we rethrow with a "429" token so budget.ts triggers the
//     shared cool-down and the storyboard loop waits it out instead of failing.
//
// Identity-locked edits are not supported — imageEdit() returns null above, and
// the caller's existing fallback adds the cast appearance fragment to the prompt
// and re-enters imageGenerate(), which lands back here.

/** Map an app size (e.g. "1344x768") onto the closest Pollinations-friendly pair.
 *  Free-tier Pollinations silently downscales larger requests, so we cap the
 *  width at 1024 to avoid wasting bandwidth on a response that gets shrunk anyway. */
function pollinationsSize(size: string): { width: number; height: number } {
  const m = size.match(/^(\d+)x(\d+)$/);
  const w = m ? Number(m[1]) : 1344;
  const h = m ? Number(m[2]) : 768;
  // Free-tier downscale cap — request at most 1024 on the long edge.
  if (w <= 1024 && h <= 1024) return { width: w, height: h };
  if (w >= h) {
    const scale = 1024 / w;
    return { width: 1024, height: Math.max(576, Math.round(h * scale)) };
  }
  const scale = 1024 / h;
  return { width: Math.max(576, Math.round(w * scale)), height: 1024 };
}

async function pollinationsImage(
  req: ImageRequest,
  config: CapabilityConfig
): Promise<Buffer> {
  const meta = providerMeta("image", "pollinations")!;
  const baseUrl = config.baseUrl?.trim() || meta.defaultBaseUrl;
  const model = config.model?.trim() || "flux";
  const { width, height } = pollinationsSize(req.size);

  // Stable seed across calls — Pollinations honors `seed` for reproducibility,
  // and a per-request random seed makes the storyboard varied without burning
  // the user's quota on duplicates.
  const seed = Math.floor(Math.random() * 1_000_000);
  const promptUrl = `${baseUrl}/prompt/${encodeURIComponent(req.prompt)}`;
  const url = `${promptUrl}?width=${width}&height=${height}&model=${encodeURIComponent(
    model
  )}&nologo=true&seed=${seed}`;

  // Pollinations returns 503 with a JSON body when at capacity. providerFetch
  // throws ProviderHttpError on non-2xx; we catch 503 and rethrow with a "429"
  // token so budget.ts treats it as a rate-limit storm.
  let response: Response;
  try {
    response = await providerFetch("Pollinations", url, {});
  } catch (err) {
    if (
      err instanceof ProviderHttpError &&
      (err.status === 503 || err.status === 429 || err.status === 402)
    ) {
      // 503 = capacity; 402 = free-tier rate limit (1 image / 45s / IP);
      // both should trigger the shared cool-down so the storyboard waits
      // instead of failing.
      throw new Error(
        redactText(
          `429 too many requests — Pollinations rate-limited (HTTP ${err.status}); retry in ~20s. ${err.message.slice(0, 200)}`
        )
      );
    }
    throw err;
  }
  const bytes = Buffer.from(new Uint8Array(await response.arrayBuffer()));
  if (bytes.length < 1000) {
    throw new Error(`Pollinations returned ${bytes.length} bytes — too small`);
  }

  // Pollinations returns JPEG bytes. The rest of the pipeline assumes PNG
  // (file extension .png, Content-Type: image/png, base64 image/png mime in
  // the VLM gate). Convert via sharp so downstream consumers stay consistent.
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    // JPEG magic bytes — re-encode to PNG.
    try {
      const sharp = (await import("sharp")).default;
      const png = await sharp(bytes).png().toBuffer();
      if (png.length > 1000) return png;
    } catch (err) {
      console.warn("[pollinations] JPEG→PNG conversion failed, serving JPEG as-is:", err);
    }
  }
  return bytes;
}
