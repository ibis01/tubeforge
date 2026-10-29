// Video adapter — image-to-video generation.
//   fal         → POST {baseUrl}/fal-ai/...
//   replicate   → POST {baseUrl}/predictions
//   huggingface → POST {baseUrl}/models/{model}
//   runway      → POST {baseUrl}/image_to_video
//   luma        → POST {baseUrl}/generations

import { getZAI } from "../ai";
import { getCapability, type CapabilityConfig } from "./settings";
import { providerMeta } from "./registry";
import { joinUrl, providerFetch, providerFetchJson } from "./http";

export interface ImageToVideoRequest {
  imagePngBase64: string;
  prompt: string;
  duration?: number;
}

export async function imageToVideo(
  req: ImageToVideoRequest,
  overrides?: Partial<CapabilityConfig>,
): Promise<Buffer> {
  const config = await getCapability("video", overrides);

  switch (config.provider) {
    case "fal":
      return falVideo(req, config);
    case "replicate":
      return replicateVideo(req, config);
    case "huggingface":
      return huggingFaceVideo(req, config);
    case "runway":
      return runwayVideo(req, config);
    case "luma":
      return lumaVideo(req, config);
    case "zai":
    default:
      return zaiVideo(req, config);
  }
}

// ---------- Z.ai (SDK — unchanged legacy shape) ----------

async function zaiVideo(
  req: ImageToVideoRequest,
  config: CapabilityConfig,
): Promise<Buffer> {
  const zai = await getZAI();
  const model = config.model?.trim() || "cogvideox-3";

  // Note: Z.ai SDK method for video may vary. Using a placeholder here.
  // If it doesn't work, ensure the correct method is called.
  throw new Error(
    "Z.ai video generation is currently handled in the pipeline, not here. Please select fal.ai, Replicate, or Ken Burns for testing.",
  );
}

// ---------- fal.ai ----------

async function falVideo(
  req: ImageToVideoRequest,
  config: CapabilityConfig,
): Promise<Buffer> {
  const baseUrl = config.baseUrl?.trim() || "https://fal.run";
  const model = config.model?.trim() || "fal-ai/fast-svd";
  const key = config.apiKey?.trim();
  if (!key) throw new Error("fal.ai needs an API key");

  const data = await providerFetchJson<{ video: { url: string } }>(
    "fal.ai Video",
    joinUrl(baseUrl, model),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Key ${key}`,
      },
      body: JSON.stringify({
        prompt: req.prompt,
        image_url: `data:image/png;base64,${req.imagePngBase64}`,
      }),
    },
  );

  if (!data.video?.url) throw new Error("fal.ai returned no video");
  const response = await providerFetch("fal.ai download", data.video.url, {});
  return Buffer.from(new Uint8Array(await response.arrayBuffer()));
}

// ---------- Replicate ----------

async function replicateVideo(req: ImageToVideoRequest, config: CapabilityConfig): Promise<Buffer> {
  const baseUrl = config.baseUrl?.trim() || "https://api.replicate.com/v1";
  const model = config.model?.trim() || "minimax/video-01";
  const key = config.apiKey?.trim();
  if (!key) throw new Error("Replicate needs an API key");

  // Use the model-scoped endpoint — no version hash needed.
  // https://api.replicate.com/v1/models/{owner}/{name}/predictions
  const response = await providerFetch(
    "Replicate Video",
    joinUrl(baseUrl, `models/${model}/predictions`),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        Prefer: "wait",
      },
      body: JSON.stringify({
        input: {
          prompt: req.prompt,
          first_frame_image: `data:image/png;base64,${req.imagePngBase64}`,
        },
      }),
    },
  );

  const data = await response.json();
  if (!data.id) throw new Error("Replicate failed to start generation");

  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const poll = await providerFetch(
      "Replicate Poll",
      joinUrl(baseUrl, `predictions/${data.id}`),
      {
        headers: { Authorization: `Bearer ${key}` },
      },
    );
    const task = await poll.json();

    if (task.status === "succeeded") {
      const outputUrl = Array.isArray(task.output) ? task.output[0] : task.output;
      if (!outputUrl) throw new Error("Replicate returned no output");
      const vidRes = await providerFetch("Replicate Download", outputUrl, {});
      return Buffer.from(new Uint8Array(await vidRes.arrayBuffer()));
    }
    if (task.status === "failed") throw new Error(`Replicate failed: ${task.error}`);
  }
  throw new Error("Replicate timed out");
}
// ---------- Hugging Face (Free Tier) ----------

async function huggingFaceVideo(
  req: ImageToVideoRequest,
  config: CapabilityConfig,
): Promise<Buffer> {
  const meta = providerMeta("video", "huggingface")!;
  const baseUrl = config.baseUrl?.trim() || meta.defaultBaseUrl;
  const model =
    config.model?.trim() || "stabilityai/stable-video-diffusion-img2vid-xt";
  const key = config.apiKey?.trim();

  if (!key)
    throw new Error(
      "Hugging Face needs an API token (Settings → AI Providers)",
    );

  const url = `${baseUrl}/models/${model}`;

  const imageBuffer = Buffer.from(req.imagePngBase64, "base64");
  const form = new FormData();
  form.append(
    "image",
    new Blob([new Uint8Array(imageBuffer)], { type: "image/png" }),
    "input.png",
  );

  const response = await providerFetch("Hugging Face Video", url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
    },
    body: form,
  });

  const bytes = Buffer.from(new Uint8Array(await response.arrayBuffer()));
  if (bytes.length < 1000)
    throw new Error("Hugging Face returned an empty or invalid video file");
  return bytes;
}

// ---------- Runway ----------

async function runwayVideo(
  req: ImageToVideoRequest,
  config: CapabilityConfig,
): Promise<Buffer> {
  const meta = providerMeta("video", "runway")!;
  const baseUrl = config.baseUrl?.trim() || meta.defaultBaseUrl;
  const model = config.model?.trim() || "gen4_turbo";
  const key = config.apiKey?.trim();

  if (!key) throw new Error("Runway needs an API key");

  const response = await providerFetch(
    "Runway Video",
    joinUrl(baseUrl, "image_to_video"),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Runway-Version": "2024-11-06",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        promptImage: `data:image/png;base64,${req.imagePngBase64}`,
        promptText: req.prompt,
        duration: 5,
        ratio: "1280:768",
      }),
    },
  );

  const data = await response.json();
  if (!data.id) throw new Error("Runway failed to start generation");

  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const poll = await providerFetch(
      "Runway Poll",
      joinUrl(baseUrl, `tasks/${data.id}`),
      {
        headers: { Authorization: `Bearer ${key}` },
      },
    );
    const task = await poll.json();

    if (task.status === "SUCCEEDED") {
      if (!task.output || !task.output[0])
        throw new Error("Runway returned no output");
      const vidRes = await providerFetch("Runway Download", task.output[0], {});
      return Buffer.from(new Uint8Array(await vidRes.arrayBuffer()));
    }
    if (task.status === "FAILED")
      throw new Error(`Runway failed: ${task.failure}`);
  }
  throw new Error("Runway timed out");
}

// ---------- Luma ----------

async function lumaVideo(
  req: ImageToVideoRequest,
  config: CapabilityConfig,
): Promise<Buffer> {
  const meta = providerMeta("video", "luma")!;
  const baseUrl = config.baseUrl?.trim() || meta.defaultBaseUrl;
  const model = config.model?.trim() || "ray-2";
  const key = config.apiKey?.trim();

  if (!key) throw new Error("Luma needs an API key");

  const response = await providerFetch(
    "Luma Video",
    joinUrl(baseUrl, "generations"),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        prompt: { text: req.prompt },
        keyframes: {
          frame0: {
            type: "image",
            url: `data:image/png;base64,${req.imagePngBase64}`,
          },
        },
      }),
    },
  );

  const data = await response.json();
  if (!data.id) throw new Error("Luma failed to start generation");

  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const poll = await providerFetch(
      "Luma Poll",
      joinUrl(baseUrl, `generations/${data.id}`),
      {
        headers: { Authorization: `Bearer ${key}` },
      },
    );
    const task = await poll.json();

    if (task.state === "completed") {
      if (!task.assets || !task.assets.video)
        throw new Error("Luma returned no video");
      const vidRes = await providerFetch(
        "Luma Download",
        task.assets.video,
        {},
      );
      return Buffer.from(new Uint8Array(await vidRes.arrayBuffer()));
    }
    if (task.state === "failed")
      throw new Error(`Luma failed: ${task.failure_reason}`);
  }
  throw new Error("Luma timed out");
}
