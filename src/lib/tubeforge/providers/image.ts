// Artwork adapter — thumbnails, storyboard scenes, portraits, pose sheets.
//  /home/ibismuh/tubeforge/src/lib/tubeforge/providers/image.ts
//   zai        → bundled Z.ai SDK (CogView, data[0].base64, supports identity edits)
//   openai     → POST {baseUrl}/images/generations (DALL·E 3 / gpt-image-1) and
//                multipart /images/edits for gpt-image-1 / dall-e-2
//   stability  → POST {baseUrl}/v2beta/stable-image/generate/sd3
//   fal        → POST {baseUrl}/fal-ai/flux/dev
//   replicate  → POST {baseUrl}/v1/models/.../predictions
//   ideogram   → POST {baseUrl}/generate
//   recraft    → POST {baseUrl}/images/generations
//   pollinations → Free URL-based generation
//
// imageEdit() returns null when the provider/model can't edit images —
// callers fall back to a prompt-seeded fresh generation (cast fragment), the
// same path used when no reference portrait exists.

import { getZAI } from "../ai";
import { getCapability, type CapabilityConfig } from "./settings";
import { providerMeta } from "./registry";
import {
  joinUrl,
  providerFetch,
  providerFetchJson,
  ProviderHttpError,
} from "./http";

/** True when an error looks like the SDK's "result.data.map" crash. */
function isMalformedSdkResponse(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /reading 'map'|reading "map"/i.test(err.message);
}

async function callZaiImage<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isMalformedSdkResponse(err)) {
      throw new Error(
        `429 too many requests — ${label} returned a malformed response (no data field), treating as rate limit`,
      );
    }
    throw err;
  }
}

export interface ImageRequest {
  prompt: string;
  size: string;
}

export interface ImageEditRequest extends ImageRequest {
  imagePngBase64: string;
}

const DALL_E_3_SIZES = ["1024x1024", "1792x1024", "1024x1792"];
const GPT_IMAGE_SIZES = ["1024x1024", "1536x1024", "1024x1536"];

export function mapImageSize(model: string, size: string): string {
  if (model.startsWith("gpt-image")) {
    if (size === "1024x1024") return "1024x1024";
    if (size === "1024x1792") return "1024x1536";
    return "1536x1024";
  }
  if (model === "dall-e-2") return "1024x1024";
  if (size === "1024x1024") return "1024x1024";
  if (size === "1024x1792") return "1024x1792";
  return "1792x1024";
}

export async function imageEditSupported(
  overrides?: Partial<CapabilityConfig>,
): Promise<boolean> {
  const config = await getCapability("image", overrides);
  if (config.provider === "zai") return true;
  if (config.provider === "openai") {
    const model = config.model?.trim() || "dall-e-3";
    return model !== "dall-e-3";
  }
  // All other providers (stability, fal, replicate, ideogram, recraft, pollinations)
  // do not support identity-locked edits in this pipeline yet.
  return false;
}

export async function imageGenerate(
  req: ImageRequest,
  overrides?: Partial<CapabilityConfig>,
): Promise<Buffer> {
  const config = await getCapability("image", overrides);

  switch (config.provider) {
    case "pollinations":
      return pollinationsImage(req, config);
    case "openai":
      return openaiImage(req, config);
    case "stability":
      return stabilityImage(req, config);
    case "fal":
      return falImage(req, config);
    case "replicate":
      return replicateImage(req, config);
    case "ideogram":
      return ideogramImage(req, config);
    case "recraft":
      return recraftImage(req, config);
    case "zai":
    default:
      return zaiImage(req);
  }
}

export async function imageEdit(
  req: ImageEditRequest,
  overrides?: Partial<CapabilityConfig>,
): Promise<Buffer | null> {
  const config = await getCapability("image", overrides);

  if (config.provider === "zai") return zaiImageEdit(req);
  if (config.provider === "openai") return openaiImageEdit(req, config);

  return null; // Caller falls back to prompt-seeded generation
}

// ---------- Z.ai (SDK — unchanged legacy shape) ----------

async function zaiImage(req: ImageRequest): Promise<Buffer> {
  const zai = await getZAI();
  const response = await callZaiImage("Z.ai image", () =>
    zai.images.generations.create({
      prompt: req.prompt,
      size: req.size as "1344x768" | "1024x1024",
    }),
  );
  const base64 = response.data[0]?.base64;
  if (!base64) throw new Error("Image generation returned no data");
  const buffer = Buffer.from(base64, "base64");
  if (buffer.length < 1000) throw new Error("Generated image is empty");
  return buffer;
}

async function zaiImageEdit(req: ImageEditRequest): Promise<Buffer> {
  const zai = await getZAI();
  const response = await callZaiImage("Z.ai image edit", () =>
    zai.images.generations.edit({
      prompt: req.prompt,
      images: [{ url: `data:image/png;base64,${req.imagePngBase64}` }],
      size: req.size as "1344x768" | "1024x1024",
    } as Parameters<typeof zai.images.generations.edit>[0]),
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
  if (buffer.length < 1000)
    throw new Error(`${provider} ${what} image is empty`);
  return buffer;
}

async function openaiImage(
  req: ImageRequest,
  config: CapabilityConfig,
): Promise<Buffer> {
  const meta = providerMeta("image", "openai")!;
  const baseUrl = config.baseUrl?.trim() || meta.defaultBaseUrl;
  const model = config.model?.trim() || "dall-e-3";
  const key = config.apiKey?.trim();
  if (!key) throw new Error("OpenAI-compatible images need an API key");

  const isGptImage = model.startsWith("gpt-image");
  const body: Record<string, unknown> = {
    model,
    prompt: req.prompt,
    size: mapImageSize(model, req.size),
  };
  if (!isGptImage) body.response_format = "b64_json";

  const data = await providerFetchJson<{
    data?: { b64_json?: string; url?: string }[];
  }>("OpenAI-compatible images", joinUrl(baseUrl, "images/generations"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });
  const first = data.data?.[0];
  if (first?.b64_json)
    return decodeB64("OpenAI-compatible", first.b64_json, "image");
  if (first?.url) {
    const response = await providerFetch(
      "OpenAI-compatible images",
      first.url,
      {},
    );
    return Buffer.from(new Uint8Array(await response.arrayBuffer()));
  }
  throw new Error("Image generation returned no data");
}

async function openaiImageEdit(
  req: ImageEditRequest,
  config: CapabilityConfig,
): Promise<Buffer | null> {
  const meta = providerMeta("image", "openai")!;
  const baseUrl = config.baseUrl?.trim() || meta.defaultBaseUrl;
  const model = config.model?.trim() || "dall-e-3";
  const key = config.apiKey?.trim();
  if (!key) throw new Error("OpenAI-compatible images need an API key");

  if (model === "dall-e-3") return null;

  const form = new FormData();
  form.append(
    "image",
    new Blob([new Uint8Array(Buffer.from(req.imagePngBase64, "base64"))], {
      type: "image/png",
    }),
    "reference.png",
  );
  form.append("model", model);
  form.append("prompt", req.prompt);
  form.append("size", mapImageSize(model, req.size));
  if (!model.startsWith("gpt-image"))
    form.append("response_format", "b64_json");

  const data = await providerFetchJson<{ data?: { b64_json?: string }[] }>(
    "OpenAI-compatible image edit",
    joinUrl(baseUrl, "images/edits"),
    { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form },
  );
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) return null;
  return decodeB64("OpenAI-compatible", b64, "image edit");
}

// ---------- Stability AI ----------

async function stabilityImage(
  req: ImageRequest,
  config: CapabilityConfig,
): Promise<Buffer> {
  const baseUrl = config.baseUrl?.trim() || "https://api.stability.ai";
  const model = config.model?.trim() || "sd3.5-large";
  const key = config.apiKey?.trim();
  if (!key) throw new Error("Stability AI needs an API key");

  const aspectRatio =
    req.size === "1344x768"
      ? "16:9"
      : req.size === "1024x1792"
        ? "9:16"
        : "1:1";

  const form = new FormData();
  form.append("prompt", req.prompt);
  form.append("output_format", "png");
  form.append("aspect_ratio", aspectRatio);

  const endpoint = model.includes("sdxl") ? "core" : "sd3";
  const response = await providerFetch(
    "Stability AI",
    joinUrl(baseUrl, `v2beta/stable-image/generate/${endpoint}`),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "image/*",
      },
      body: form,
    },
  );
  return Buffer.from(new Uint8Array(await response.arrayBuffer()));
}

// ---------- fal.ai ----------

async function falImage(
  req: ImageRequest,
  config: CapabilityConfig,
): Promise<Buffer> {
  const baseUrl = config.baseUrl?.trim() || "https://fal.run";
  const model = config.model?.trim() || "fal-ai/flux/dev";
  const key = config.apiKey?.trim();
  if (!key) throw new Error("fal.ai needs an API key");

  const sizeMap: Record<string, string> = {
    "1344x768": "landscape_16_9",
    "1024x1792": "portrait_16_9",
    "1024x1024": "square_hd",
  };

  const data = await providerFetchJson<{ images: { url: string }[] }>(
    "fal.ai",
    joinUrl(baseUrl, model),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Key ${key}`,
      },
      body: JSON.stringify({
        prompt: req.prompt,
        image_size: sizeMap[req.size] || "landscape_16_9",
        num_images: 1,
      }),
    },
  );

  const url = data.images?.[0]?.url;
  if (!url) throw new Error("fal.ai returned no image");
  const response = await providerFetch("fal.ai download", url, {});
  return Buffer.from(new Uint8Array(await response.arrayBuffer()));
}

// ---------- Replicate ----------

async function replicateImage(
  req: ImageRequest,
  config: CapabilityConfig,
): Promise<Buffer> {
  const baseUrl = config.baseUrl?.trim() || "https://api.replicate.com/v1";
  const model = config.model?.trim() || "black-forest-labs/flux-1.1-pro";
  const key = config.apiKey?.trim();
  if (!key) throw new Error("Replicate needs an API key");

  const aspectRatio =
    req.size === "1344x768"
      ? "16:9"
      : req.size === "1024x1792"
        ? "9:16"
        : "1:1";

  let url = joinUrl(baseUrl, `models/${model}/predictions`);
  const body: any = {
    input: {
      prompt: req.prompt,
      aspect_ratio: aspectRatio,
      output_format: "png",
    },
  };

  if (model.includes(":")) {
    url = joinUrl(baseUrl, "predictions");
    const [_, version] = model.split(":");
    body.version = version;
  }

  const data = await providerFetchJson<{ output: string | string[] }>(
    "Replicate",
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        Prefer: "wait",
      },
      body: JSON.stringify(body),
    },
  );

  const output = Array.isArray(data.output) ? data.output[0] : data.output;
  if (!output) throw new Error("Replicate returned no image");
  const response = await providerFetch("Replicate download", output, {});
  return Buffer.from(new Uint8Array(await response.arrayBuffer()));
}

// ---------- Ideogram ----------

async function ideogramImage(
  req: ImageRequest,
  config: CapabilityConfig,
): Promise<Buffer> {
  const baseUrl = config.baseUrl?.trim() || "https://api.ideogram.ai";
  const key = config.apiKey?.trim();
  if (!key) throw new Error("Ideogram needs an API key");

  const aspectRatio =
    req.size === "1344x768"
      ? "16x9"
      : req.size === "1024x1792"
        ? "9x16"
        : "1x1";

  const data = await providerFetchJson<{ data: { url: string }[] }>(
    "Ideogram",
    joinUrl(baseUrl, "generate"),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Api-Key": key,
      },
      body: JSON.stringify({
        prompt: req.prompt,
        aspect_ratio: aspectRatio,
      }),
    },
  );

  const url = data.data?.[0]?.url;
  if (!url) throw new Error("Ideogram returned no image");
  const response = await providerFetch("Ideogram download", url, {});
  return Buffer.from(new Uint8Array(await response.arrayBuffer()));
}

// ---------- Recraft ----------

async function recraftImage(
  req: ImageRequest,
  config: CapabilityConfig,
): Promise<Buffer> {
  const baseUrl =
    config.baseUrl?.trim() || "https://external.api.recraft.ai/v1";
  const model = config.model?.trim() || "recraftv3";
  const key = config.apiKey?.trim();
  if (!key) throw new Error("Recraft needs an API key");

  const size =
    req.size === "1344x768"
      ? "1820x1024"
      : req.size === "1024x1792"
        ? "1024x1820"
        : "1024x1024";

  const data = await providerFetchJson<{ data: { url: string }[] }>(
    "Recraft",
    joinUrl(baseUrl, "images/generations"),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        prompt: req.prompt,
        size,
        style: "realistic_image",
        model,
      }),
    },
  );

  const url = data.data?.[0]?.url;
  if (!url) throw new Error("Recraft returned no image");
  const response = await providerFetch("Recraft download", url, {});
  return Buffer.from(new Uint8Array(await response.arrayBuffer()));
}

// ---------- Pollinations.ai (free, URL-based, no API key) ----------

function pollinationsSize(size: string): { width: number; height: number } {
  const m = size.match(/^(\d+)x(\d+)$/);
  const w = m ? Number(m[1]) : 1344;
  const h = m ? Number(m[2]) : 768;
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
  config: CapabilityConfig,
): Promise<Buffer> {
  const meta = providerMeta("image", "pollinations")!;
  const baseUrl =
    config.baseUrl?.trim() ||
    meta?.defaultBaseUrl ||
    "https://image.pollinations.ai";
  const model = config.model?.trim() || "flux";
  const { width, height } = pollinationsSize(req.size);

  const seed = Math.floor(Math.random() * 1_000_000);
  const promptUrl = `${baseUrl}/prompt/${encodeURIComponent(req.prompt)}`;
  const url = `${promptUrl}?width=${width}&height=${height}&model=${encodeURIComponent(
    model,
  )}&nologo=true&seed=${seed}`;

  let response: Response;
  try {
    response = await providerFetch("Pollinations", url, {});
  } catch (err) {
    if (
      err instanceof ProviderHttpError &&
      (err.status === 503 || err.status === 429 || err.status === 402)
    ) {
      throw new Error(
        `429 too many requests — Pollinations rate-limited (HTTP ${err.status}); retry in ~20s.`,
      );
    }
    throw err;
  }
  const bytes = Buffer.from(new Uint8Array(await response.arrayBuffer()));
  if (bytes.length < 1000) {
    throw new Error(`Pollinations returned ${bytes.length} bytes — too small`);
  }

  // Pollinations returns JPEG bytes. Convert to PNG.
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    try {
      const sharp = (await import("sharp")).default;
      const png = await sharp(bytes).png().toBuffer();
      if (png.length > 1000) return png;
    } catch (err) {
      console.warn(
        "[pollinations] JPEG→PNG conversion failed, serving JPEG as-is:",
        err,
      );
    }
  }
  return bytes;
}
