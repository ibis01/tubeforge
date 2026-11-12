// Video adapter — image-to-video generation.
//   zai         → Z.ai SDK (CogVideoX i2v — zai-video-core.ts)
//   fal         → POST {baseUrl}/fal-ai/...
//   replicate   → POST {baseUrl}/models/{model}/predictions
//   huggingface → POST {baseUrl}/models/{model}
//   runway      → POST {baseUrl}/image_to_video
//   luma        → POST {baseUrl}/generations
//   magichour   → POST {baseUrl}/image-to-video (two-step: upload → generate),
//                 poll GET {baseUrl}/video-projects/{id}

import { zaiClientFor } from "../zai-client";
import { getCapability, type CapabilityConfig } from "./settings";
import { providerMetaRequired } from "./registry";
import { joinUrl, providerFetch, providerFetchJson } from "./http";
import { zaiVideoViaClient } from "./zai-video-core";

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
    case "magichour":
      return magicHourVideo(req, config);
    case "zai":
    default:
      return zaiVideo(req, config);
  }
}

// ---------- Z.ai (SDK) ----------

async function zaiVideo(
  req: ImageToVideoRequest,
  config: CapabilityConfig,
): Promise<Buffer> {
  const zai = await zaiClientFor("video");
  const model = config.model?.trim() || "cogvideox-3";
  return zaiVideoViaClient(zai, req, {
    model,
    ...(req.duration !== undefined ? { duration: req.duration } : {}),
  });
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

async function replicateVideo(
  req: ImageToVideoRequest,
  config: CapabilityConfig,
): Promise<Buffer> {
  const baseUrl = config.baseUrl?.trim() || "https://api.replicate.com/v1";
  const model = config.model?.trim() || "minimax/video-01";
  const key = config.apiKey?.trim();
  if (!key) throw new Error("Replicate needs an API key");

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
      { headers: { Authorization: `Bearer ${key}` } },
    );
    const task = await poll.json();

    if (task.status === "succeeded") {
      const outputUrl = Array.isArray(task.output)
        ? task.output[0]
        : task.output;
      if (!outputUrl) throw new Error("Replicate returned no output");
      const vidRes = await providerFetch("Replicate Download", outputUrl, {});
      return Buffer.from(new Uint8Array(await vidRes.arrayBuffer()));
    }
    if (task.status === "failed")
      throw new Error(`Replicate failed: ${task.error}`);
  }
  throw new Error("Replicate timed out");
}

// ---------- Hugging Face ----------

async function huggingFaceVideo(
  req: ImageToVideoRequest,
  config: CapabilityConfig,
): Promise<Buffer> {
  const meta = providerMetaRequired("video", "huggingface");
  const baseUrl = config.baseUrl?.trim() || meta.defaultBaseUrl;
  const model =
    config.model?.trim() || "stabilityai/stable-video-diffusion-img2vid-xt";
  const key = config.apiKey?.trim();

  if (!key) throw new Error("Hugging Face needs an API token");

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
    headers: { Authorization: `Bearer ${key}` },
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
  const meta = providerMetaRequired("video", "runway");
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
      { headers: { Authorization: `Bearer ${key}` } },
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
  const meta = providerMetaRequired("video", "luma");
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
      { headers: { Authorization: `Bearer ${key}` } },
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

// ---------- Magic Hour (free tier) ----------
//
// Three-step flow:
//  1. POST /v1/files/upload-urls     → { items: [{ upload_url, file_path }] }
//  2. PUT  {upload_url}              → upload the PNG bytes
//  3. POST /v1/image-to-video        → { id, credits_charged }
//  4. GET  /v1/video-projects/{id}   → poll until status is complete/error
//
// The status endpoint is /video-projects/{id}, NOT /image-to-video/{id}.
// That path mismatch was the "HTTP 404" the settings test was hitting.

/** Exported for the S95 pin suite (the S37 zaiVideoViaClient seam).
 *  opts.pollMs / opts.maxPolls exist so the pins can script the whole
 *  4-step flow in milliseconds; production defaults keep 5s x 60 = the
 *  5-minute poll budget the status endpoint's latency justifies. */
export async function magicHourVideo(
  req: ImageToVideoRequest,
  config: CapabilityConfig,
  opts: { pollMs?: number; maxPolls?: number } = {},
): Promise<Buffer> {
  const pollMs = opts.pollMs ?? 5000;
  const maxPolls = opts.maxPolls ?? 60;
  const baseUrl = config.baseUrl?.trim() || "https://api.magichour.ai/v1";
  const key = config.apiKey?.trim();
  if (!key) throw new Error("Magic Hour needs an API key");

  const model = config.model?.trim() || "wan-2.2";
  const endSeconds = req.duration ?? 5;

  // Step 1 — request an upload URL for a PNG image.
  const uploadReq = await providerFetchJson<{
    items: { upload_url: string; file_path: string }[];
  }>("Magic Hour upload request", joinUrl(baseUrl, "files/upload-urls"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      items: [{ type: "image", extension: "png" }],
    }),
  });

  const uploadItem = uploadReq.items?.[0];
  if (!uploadItem?.upload_url || !uploadItem?.file_path) {
    throw new Error(
      `Magic Hour upload-urls response missing upload_url/file_path: ${JSON.stringify(uploadReq).slice(0, 300)}`,
    );
  }

  // Step 2 — PUT the raw image bytes to the presigned URL.
  // S95 hardening: this rode RAW fetch — no AbortSignal, so a hung upload
  // stalled the whole video job past every other timeout in the pipeline.
  // providerFetch gives it the download-capability deadline (10 min) and
  // the redacted error surface every other provider step already had.
  const imageBuffer = Buffer.from(req.imagePngBase64, "base64");
  await providerFetch(
    "Magic Hour image upload",
    uploadItem.upload_url,
    {
      method: "PUT",
      body: new Uint8Array(imageBuffer),
      headers: { "Content-Type": "image/png" },
    },
    { capability: "download" },
  );

  // Step 3 — submit the image-to-video job with the uploaded file_path.
  const submitRes = await providerFetch(
    "Magic Hour Video",
    joinUrl(baseUrl, "image-to-video"),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        name: "TubeForge scene",
        end_seconds: endSeconds,
        model,
        resolution: "480p",
        style: { prompt: req.prompt },
        assets: { image_file_path: uploadItem.file_path },
      }),
    },
  );

  const submitted = (await submitRes.json()) as {
    id?: string;
    status?: string;
    error?: { message?: string };
  };
  if (!submitted.id) {
    throw new Error(
      `Magic Hour failed to start generation: ${JSON.stringify(submitted).slice(0, 300)}`,
    );
  }

  // Step 4 — poll the video-project status endpoint (NOT /image-to-video/{id}).
  for (let i = 0; i < maxPolls; i++) {
    await new Promise((r) => setTimeout(r, pollMs));
    const pollRes = await providerFetch(
      "Magic Hour Poll",
      joinUrl(baseUrl, `video-projects/${submitted.id}`),
      { headers: { Authorization: `Bearer ${key}` } },
    );
    const task = (await pollRes.json()) as {
      status?: string;
      downloads?: { url?: string }[];
      error?: { message?: string };
    };

    if (task.status === "complete") {
      const url = task.downloads?.[0]?.url;
      if (!url) throw new Error("Magic Hour returned no download URL");
      const vidRes = await providerFetch("Magic Hour Download", url, {});
      return Buffer.from(new Uint8Array(await vidRes.arrayBuffer()));
    }
    if (
      task.status === "error" ||
      task.status === "failed" ||
      task.status === "canceled"
    ) {
      throw new Error(
        `Magic Hour failed: ${task.error?.message ?? task.status}`,
      );
    }
    // queued / rendering → keep polling
  }
  throw new Error(
    `Magic Hour timed out after ${Math.round((maxPolls * pollMs) / 1000)}s`
  );
}
