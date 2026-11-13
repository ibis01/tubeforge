// Artwork adapter — thumbnails, storyboard scenes, portraits, pose sheets.
//
//   zai          → bundled Z.ai SDK (CogView, data[0].base64, supports identity edits)
//   openai       → POST {baseUrl}/images/generations (DALL·E 3 / gpt-image-1) and
//                  multipart /images/edits for gpt-image-1 / dall-e-2
//   stability    → POST {baseUrl}/v2beta/stable-image/generate/sd3
//   fal          → POST {baseUrl}/fal-ai/flux/dev
//   replicate    → POST {baseUrl}/v1/models/.../predictions
//   ideogram     → POST {baseUrl}/generate
//   recraft      → POST {baseUrl}/images/generations
//   pollinations → Free URL-based generation
//   together     → POST {baseUrl}/images/generations (FLUX.1-schnell-Free — $0, ~10 img/min)
//   cloudflare   → POST {baseUrl}/accounts/{accountId}/ai/run/{model}  (10,000 Neurons/day)
//   huggingface  → POST {baseUrl}/models/{model}  (binary image, ~300 req/hr free)
//   nvidia       → POST {baseUrl}/v1/genai/{model}  (1,000 credits/month free)

import { zaiClientFor } from "../zai-client";
import { redactText } from "../redact";
import { getCapability, type CapabilityConfig } from "./settings";
import { providerMetaRequired } from "./registry";
import { log } from "../log";

const imageLog = log.child({ mod: "image" });
import {
  joinUrl,
  providerFetch,
  providerFetchJson,
  ProviderHttpError,
  withTimeout,
} from "./http";

/** True when an error looks like the SDK's "result.data.map" crash. */
function isMalformedSdkResponse(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /reading 'map'|reading "map"/i.test(err.message);
}

/** Wrap an SDK image call: convert malformed-response TypeErrors into a
 *  retryable, 429-flavored error so budget.ts backs off. Also races the
 *  call against a 150s deadline — the SDK's fetches have no timeout, and
 *  one hung call used to stall a whole storyboard. */
async function callZaiImage<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await withTimeout(150_000, label, fn);
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
  /** Optional generation seed. HONORED by Pollinations (URL `&seed=`),
   *  Together (body `seed`), and NVIDIA (body `seed`); z.ai + the other
   *  OpenAI-compatible APIs have no seed parameter, so the field is silently
   *  ignored there. Callers pin a stable seed per character or per video+scene
   *  to keep a recurring host recognizable across scenes — the closest a
   *  text-to-image-only provider gets to identity locking. */
  seed?: number;
  /** S49 — optional negative prompt (content-policy exclusions). Rides the
   *  providers whose APIs take one (stability, fal, replicate, ideogram,
   *  recraft, together); z.ai / openai / pollinations / cloudflare /
   *  huggingface / nvidia have no such parameter and ignore it — the
   *  SANITIZED POSITIVE prompt carries the policy there
   *  (restricted-subjects.ts appends the hard negative clause to the prompt
   *  itself, so no provider is protected only by this field). */
  negativePrompt?: string;
}

export interface ImageEditRequest extends ImageRequest {
  imagePngBase64: string;
}

const _DALL_E_3_SIZES = ["1024x1024", "1792x1024", "1024x1792"];
const _GPT_IMAGE_SIZES = ["1024x1024", "1536x1024", "1024x1536"];

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
  // All other providers (stability, fal, replicate, ideogram, recraft,
  // pollinations, together, cloudflare, huggingface, nvidia) do not support
  // identity-locked edits in this pipeline yet.
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
    case "together":
      return togetherImage(req, config);
    case "cloudflare":
      return cloudflareImage(req, config);
    case "huggingface":
      return huggingFaceImage(req, config);
    case "nvidia":
      return nvidiaImage(req, config);
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

// ---------- Z.ai (SDK) ----------

async function zaiImage(req: ImageRequest): Promise<Buffer> {
  const zai = await zaiClientFor("image");
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
  const zai = await zaiClientFor("image");
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
  const meta = providerMetaRequired("image", "openai");
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
  const meta = providerMetaRequired("image", "openai");
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
  if (req.negativePrompt) form.append("negative_prompt", req.negativePrompt);

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
        ...(req.negativePrompt ? { negative_prompt: req.negativePrompt } : {}),
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
  const body: {
    input: {
      prompt: string;
      aspect_ratio: string;
      output_format: string;
      negative_prompt?: string;
    };
    version?: string;
  } = {
    input: {
      prompt: req.prompt,
      aspect_ratio: aspectRatio,
      output_format: "png",
      ...(req.negativePrompt ? { negative_prompt: req.negativePrompt } : {}),
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
        ...(req.negativePrompt ? { negative_prompt: req.negativePrompt } : {}),
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
        ...(req.negativePrompt ? { negative_prompt: req.negativePrompt } : {}),
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
  const meta = providerMetaRequired("image", "pollinations");
  const baseUrl = config.baseUrl?.trim() || meta.defaultBaseUrl;
  const model = config.model?.trim() || "flux";
  const { width, height } = pollinationsSize(req.size);

  const seed =
    typeof req.seed === "number" && Number.isFinite(req.seed)
      ? Math.max(0, Math.min(2_147_483_647, Math.floor(req.seed)))
      : Math.floor(Math.random() * 1_000_000);
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
        redactText(
          `429 too many requests — Pollinations rate-limited (HTTP ${err.status}); retry in ~20s. ${err.message.slice(0, 200)}`,
        ),
      );
    }
    throw err;
  }
  const bytes = Buffer.from(new Uint8Array(await response.arrayBuffer()));
  if (bytes.length < 1000) {
    throw new Error(`Pollinations returned ${bytes.length} bytes — too small`);
  }

  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    try {
      const sharp = (await import("sharp")).default;
      const png = await sharp(bytes).png().toBuffer();
      if (png.length > 1000) return png;
    } catch (err) {
      imageLog.warn("JPEG to PNG conversion failed, serving JPEG as-is", {
        err,
      });
    }
  }
  return bytes;
}

// ---------- Together AI (FLUX.1-schnell; -Free is the $0 lane) ----------

export async function togetherImage(
  req: ImageRequest,
  config: CapabilityConfig,
): Promise<Buffer> {
  const meta = providerMetaRequired("image", "together");
  const baseUrl = config.baseUrl?.trim() || meta.defaultBaseUrl;
  const model =
    config.model?.trim() ||
    meta.models[0]?.id ||
    "black-forest-labs/FLUX.1-schnell-Free";
  const key = config.apiKey?.trim();
  if (!key) throw new Error("Together AI needs an API key");

  const m = req.size.match(/^(\d+)x(\d+)$/);
  const width = m ? Number(m[1]) : 1344;
  const height = m ? Number(m[2]) : 768;

  const body: Record<string, unknown> = {
    model,
    prompt: req.prompt,
    width,
    height,
    n: 1,
    response_format: "base64",
    output_format: "png",
  };
  if (/schnell/i.test(model)) body.steps = 4;
  if (typeof req.seed === "number" && Number.isFinite(req.seed)) {
    body.seed = Math.max(0, Math.min(2_147_483_647, Math.floor(req.seed)));
  }
  if (req.negativePrompt) body.negative_prompt = req.negativePrompt;

  let data: { data?: { b64_json?: string; url?: string }[] };
  try {
    data = await providerFetchJson<{
      data?: { b64_json?: string; url?: string }[];
    }>("Together AI", joinUrl(baseUrl, "images/generations"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (
      err instanceof ProviderHttpError &&
      (err.status === 429 || err.status === 402)
    ) {
      throw new Error(
        redactText(
          `429 too many requests — Together AI rate-limited (HTTP ${err.status}); the FLUX.1-schnell-Free tier allows ~10 images/min. ${err.message.slice(0, 200)}`,
        ),
      );
    }
    throw err;
  }

  const first = data.data?.[0];
  if (first?.b64_json) return decodeB64("Together AI", first.b64_json, "image");
  if (first?.url) {
    const response = await providerFetch("Together AI download", first.url, {});
    return Buffer.from(new Uint8Array(await response.arrayBuffer()));
  }
  throw new Error("Together AI returned no image data");
}

// ---------- Cloudflare Workers AI ----------
//
// Endpoint:  POST {baseUrl}/accounts/{accountId}/ai/run/{model}
//            where baseUrl = https://api.cloudflare.com/client/v4
//                  accountId is parsed from the user's saved base URL
//                  model = e.g. "@cf/black-forest-labs/flux-1-schnell"
// Auth:      Authorization: Bearer {API_TOKEN}
// Response:  binary PNG (newer deployments) OR JSON { result: { image: "base64…" } }
//
// The user MUST include their account ID in the base URL — there's no way to
// derive it from the API token alone. The registry's defaultBaseUrl shows the
// placeholder YOUR_ACCOUNT_ID so the Settings UI hints at what to swap.
//
// Free tier: 10,000 Neurons/day ≈ 500 FLUX.1-schnell images/day at 1024×1024.
//
// NSFW false-positive retry: Cloudflare's FLUX NSFW filter is overaggressive
// (GitHub issues open since Oct 2024) — even prompts like "a solid teal
// circle" get flagged with error code 8007 ("Input prompt contains NSFW
// content"). The community reports that the SAME prompt usually succeeds on
// a second attempt seconds later, so this adapter retries once on that exact
// error signature before giving up.

async function cloudflareImage(
  req: ImageRequest,
  config: CapabilityConfig,
): Promise<Buffer> {
  const meta = providerMetaRequired("image", "cloudflare");
  const baseUrl = config.baseUrl?.trim() || meta.defaultBaseUrl;
  const model = config.model?.trim() || "@cf/black-forest-labs/flux-1-schnell";
  const key = config.apiKey?.trim();
  if (!key) throw new Error("Cloudflare Workers AI needs an API token");

  // Parse the account ID out of the base URL.
  // Accepted: https://api.cloudflare.com/client/v4/accounts/{accountId}
  const accountId = baseUrl.match(/accounts\/([^/]+)/)?.[1];
  if (!accountId) {
    throw new Error(
      "Cloudflare Workers AI needs your Account ID in the base URL — use https://api.cloudflare.com/client/v4/accounts/YOUR_ACCOUNT_ID",
    );
  }
  // Strip the /accounts/{id} suffix so joinUrl() doesn't double it.
  const rootUrl = baseUrl.replace(/\/accounts\/[^/]+.*$/, "");

  // FLUX.1-schnell accepts `steps` (integer, 1-8); 4 is the documented sweet
  // spot for the distilled model. (The SDXL model on Cloudflare uses
  // `num_steps` instead — that's why the two are easy to confuse. FLUX
  // rejects `num_steps` with "Additional or unevaluated properties not
  // allowed".)
  const callOnce = () =>
    providerFetch(
      "Cloudflare Workers AI",
      joinUrl(rootUrl, `accounts/${accountId}/ai/run/${model}`),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          prompt: req.prompt,
          steps: 4,
        }),
      },
    );

  let response: Response;
  try {
    response = await callOnce();
  } catch (err) {
    // Cloudflare's FLUX NSFW filter has known false positives on benign
    // prompts — error code 8007 / "Input prompt contains NSFW content".
    // Retry once after a short delay; the same prompt often succeeds on
    // the second attempt (see cloudflare/workerd issues #2900, #3306).
    const isNsfwFalsePositive =
      err instanceof ProviderHttpError && /nsfw/i.test(err.message);
    if (isNsfwFalsePositive) {
      await new Promise((r) => setTimeout(r, 3000));
      response = await callOnce();
    } else {
      throw err;
    }
  }

  const contentType = response.headers.get("content-type") ?? "";

  // Newer Cloudflare deployments return raw image bytes for image models.
  if (contentType.startsWith("image/")) {
    const buffer = Buffer.from(new Uint8Array(await response.arrayBuffer()));
    if (buffer.length < 1000) {
      throw new Error("Cloudflare Workers AI returned an empty image");
    }
    return buffer;
  }

  // Older / JSON envelope: { result: { image: "<base64 or data: URI>" }, success }
  const data = (await response.json()) as {
    result?: { image?: string };
    success?: boolean;
    errors?: { message?: string }[];
  };
  const image = data.result?.image;
  if (!image) {
    const detail =
      data.errors
        ?.map((e) => e.message)
        .filter(Boolean)
        .join(" · ") || "no result.image field";
    throw new Error(`Cloudflare Workers AI returned no image — ${detail}`);
  }
  const b64 = image.replace(/^data:image\/[a-z]+;base64,/, "");
  return decodeB64("Cloudflare Workers AI", b64, "image");
}

// ---------- Hugging Face Inference API ----------
//
// Endpoint:  POST {baseUrl}/models/{model}
//            where baseUrl = https://api-inference.huggingface.co
//                  model   = e.g. "black-forest-labs/FLUX.1-dev"
// Auth:      Authorization: Bearer {HF_TOKEN}
// Body:      { inputs: "<prompt>" }
// Response:  binary image bytes on success, JSON { error: "…" } on failure
//
// Free tier: ~300 requests/hour. Model cold-start returns 503 for 30-90s;
// we surface that as a "429 too many requests" so budget.ts triggers the
// shared cool-down and retries instead of failing the storyboard.

async function huggingFaceImage(
  req: ImageRequest,
  config: CapabilityConfig,
): Promise<Buffer> {
  const meta = providerMetaRequired("image", "huggingface");
  const baseUrl = config.baseUrl?.trim() || meta.defaultBaseUrl;
  const model = config.model?.trim() || "black-forest-labs/FLUX.1-dev";
  const key = config.apiKey?.trim();
  if (!key) throw new Error("Hugging Face needs an API token");

  let response: Response;
  try {
    response = await providerFetch(
      "Hugging Face image",
      joinUrl(baseUrl, `models/${model}`),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({ inputs: req.prompt }),
      },
    );
  } catch (err) {
    if (err instanceof ProviderHttpError && err.status === 503) {
      throw new Error(
        redactText(
          `429 too many requests — Hugging Face model is cold-starting (HTTP 503); retry in ~30s.`,
        ),
      );
    }
    throw err;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) {
    const text = await response.text().catch(() => "");
    if (/loading|queue/i.test(text)) {
      throw new Error(
        redactText(
          `429 too many requests — Hugging Face model is still loading; retry in ~30s. ${text.slice(0, 200)}`,
        ),
      );
    }
    throw new Error(
      `Hugging Face returned a non-image response (${contentType || "no content-type"}): ${text.slice(0, 200)}`,
    );
  }

  const buffer = Buffer.from(new Uint8Array(await response.arrayBuffer()));
  if (buffer.length < 1000) {
    throw new Error("Hugging Face returned an empty image");
  }
  return buffer;
}

// ---------- NVIDIA NIM ----------
//
// Endpoint:  POST {baseUrl}/v1/genai/{model}
//            where baseUrl = https://ai.api.nvidia.com
//                  model   = e.g. "black-forest-labs/flux.1-dev"
// Auth:      Authorization: Bearer {nvapi-…}
// Body:      { prompt, mode: "base", cfg_scale, width, height, seed, steps }
// Response:  { image: "base64" } OR { artifacts: [{ base64: "…" }] }
//
// Free tier: 1,000 requests/month, no credit card required.

async function nvidiaImage(
  req: ImageRequest,
  config: CapabilityConfig,
): Promise<Buffer> {
  const meta = providerMetaRequired("image", "nvidia");
  const baseUrl = config.baseUrl?.trim() || meta.defaultBaseUrl;
  const model = config.model?.trim() || "black-forest-labs/flux.1-dev";
  const key = config.apiKey?.trim();
  if (!key) throw new Error("NVIDIA NIM needs an API key (nvapi-…)");

  const width = req.size === "1024x1792" ? 1024 : 1344;
  const height =
    req.size === "1024x1792" ? 1792 : req.size === "1024x1024" ? 1024 : 768;

  const response = await providerFetch(
    "NVIDIA NIM",
    joinUrl(baseUrl, `v1/genai/${model}`),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        prompt: req.prompt,
        mode: "base",
        cfg_scale: 7,
        width,
        height,
        seed:
          typeof req.seed === "number" && Number.isFinite(req.seed)
            ? Math.max(0, Math.min(2_147_483_647, Math.floor(req.seed)))
            : 0,
        steps: 30,
      }),
    },
  );

  const data = (await response.json()) as {
    image?: string;
    artifacts?: { base64?: string }[];
  };
  const b64 = data.image ?? data.artifacts?.[0]?.base64;
  if (!b64) throw new Error("NVIDIA NIM returned no image");
  const cleaned = b64.replace(/^data:image\/[a-z]+;base64,/, "");
  return decodeB64("NVIDIA NIM", cleaned, "image");
}
