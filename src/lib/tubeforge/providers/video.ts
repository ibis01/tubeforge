// Video adapter — image-to-video generation.
//   zai         → Z.ai SDK (CogVideoX i2v — zai-video-core.ts)
//   fal         → POST {baseUrl}/fal-ai/...
//   replicate   → POST {baseUrl}/models/{model}/predictions
//   huggingface → POST {baseUrl}/models/{model}
//   runway      → POST {baseUrl}/image_to_video
//   luma        → POST {baseUrl}/generations
//   magichour   → POST {baseUrl}/image-to-video (two-step: upload → generate)
//   agnes       → POST {baseUrl}/videos (async polling via /agnesapi)
//   nvidia      → POST {baseUrl}/v1/videos/generations
//   kling       → POST {baseUrl}/image-to-video (async polling)
//   hailuo      → POST {baseUrl}/v1/video_generation (async polling)
//   ltxstudio   → POST {baseUrl}/v2/image-to-video (async polling)

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
    case "agnes":
      return agnesVideo(req, config);
    case "nvidia":
      return nvidiaVideo(req, config);
    case "kling":
      return klingVideo(req, config);
    case "hailuo":
      return hailuoVideo(req, config);
    case "ltxstudio":
      return ltxStudioVideo(req, config);
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
        duration: req.duration || 5,
        ratio: "1280:720",
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
  }
  throw new Error(
    `Magic Hour timed out after ${Math.round((maxPolls * pollMs) / 1000)}s`,
  );
}

// ---------- Agnes AI (Free Tier) ----------

async function agnesVideo(
  req: ImageToVideoRequest,
  config: CapabilityConfig,
): Promise<Buffer> {
  let baseUrl = config.baseUrl?.trim() || "https://apihub.agnes-ai.com/v1";
  if (!baseUrl.endsWith("/v1")) {
    baseUrl = baseUrl.replace(/\/$/, "") + "/v1";
  }
  const model = config.model?.trim() || "agnes-video-2.5-flash";
  const key = config.apiKey?.trim();
  if (!key) throw new Error("Agnes AI needs an API key");

  const submit = () =>
    providerFetch("Agnes Video", joinUrl(baseUrl, "videos"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        prompt: req.prompt,
        seconds: String(req.duration || 5),
        mode: "keyframe",
        size: "720P",
        aspect_ratio: "16:9",
        first_frame: `data:image/png;base64,${req.imagePngBase64}`,
      }),
    });

  // 503 "video_queue_full" is a transient overload — retry up to 3 times
  // with a 15s gap before surfacing the error. Total wait ≈ 45s.
  let response: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await submit();
      break;
    } catch (err) {
      const isQueueFull =
        err instanceof Error &&
        (err.message.includes("503") || err.message.includes("queue_full"));
      if (isQueueFull && attempt < 2) {
        await new Promise((r) => setTimeout(r, 15_000));
        continue;
      }
      throw err;
    }
  }
  if (!response) throw new Error("Agnes queue remained full after 3 attempts");

  const data = await response.json();
  if (!data.video_id) {
    throw new Error(
      `Agnes AI failed to start generation: ${JSON.stringify(data).slice(0, 300)}`,
    );
  }

  const pollBase = baseUrl.replace(/\/v1$/, "");
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const poll = await providerFetch(
      "Agnes Poll",
      `${pollBase}/agnesapi?video_id=${data.video_id}&model_name=${encodeURIComponent(model)}`,
      { headers: { Authorization: `Bearer ${key}` } },
    );
    const task = await poll.json();

    if (task.status === "completed") {
      const url = task.url;
      if (!url) throw new Error("Agnes returned no video URL");
      const vidRes = await providerFetch("Agnes Download", url, {});
      return Buffer.from(new Uint8Array(await vidRes.arrayBuffer()));
    }
    if (task.status === "failed") {
      throw new Error(`Agnes failed: ${task.error || "unknown error"}`);
    }
  }
  throw new Error("Agnes timed out");
}

// ---------- NVIDIA NIM (Wan2.2-Animate) ----------

async function nvidiaVideo(
  req: ImageToVideoRequest,
  config: CapabilityConfig,
): Promise<Buffer> {
  const meta = providerMetaRequired("video", "nvidia");
  const baseUrl = config.baseUrl?.trim() || meta.defaultBaseUrl;
  const model = config.model?.trim() || "wan-ai/wan2.2-animate-2-14b";
  const key = config.apiKey?.trim();
  if (!key) throw new Error("NVIDIA NIM needs an API key (nvapi-…)");

  const response = await providerFetch(
    "NVIDIA Video",
    joinUrl(baseUrl, "v1/videos/generations"),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        prompt: req.prompt,
        image: `data:image/png;base64,${req.imagePngBase64}`,
      }),
    },
  );

  const data = await response.json();
  if (data.data && data.data[0]?.url) {
    const vidRes = await providerFetch("NVIDIA Download", data.data[0].url, {});
    return Buffer.from(new Uint8Array(await vidRes.arrayBuffer()));
  }
  if (data.id) {
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const poll = await providerFetch(
        "NVIDIA Poll",
        joinUrl(baseUrl, `v1/videos/generations/${data.id}`),
        { headers: { Authorization: `Bearer ${key}` } },
      );
      const task = await poll.json();
      if (task.status === "succeeded" || task.status === "completed") {
        const url = task.data?.[0]?.url || task.url;
        if (!url) throw new Error("NVIDIA returned no video URL");
        const vidRes = await providerFetch("NVIDIA Download", url, {});
        return Buffer.from(new Uint8Array(await vidRes.arrayBuffer()));
      }
      if (task.status === "failed") throw new Error("NVIDIA generation failed");
    }
  }
  throw new Error("NVIDIA returned an unexpected response format");
}

// ---------- Kling AI ----------

async function klingVideo(
  req: ImageToVideoRequest,
  config: CapabilityConfig,
): Promise<Buffer> {
  const meta = providerMetaRequired("video", "kling");
  const baseUrl = config.baseUrl?.trim() || meta.defaultBaseUrl;
  const model = config.model?.trim() || "kling-v1";
  const key = config.apiKey?.trim();
  if (!key) throw new Error("Kling AI needs an API key");

  const response = await providerFetch(
    "Kling Video",
    joinUrl(baseUrl, "image-to-video"),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        prompt: req.prompt,
        image: `data:image/png;base64,${req.imagePngBase64}`,
        duration: req.duration || 5,
      }),
    },
  );

  const data = await response.json();
  if (!data.task_id) throw new Error("Kling failed to start generation");

  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const poll = await providerFetch(
      "Kling Poll",
      joinUrl(baseUrl, `tasks/${data.task_id}`),
      { headers: { Authorization: `Bearer ${key}` } },
    );
    const task = await poll.json();
    if (task.task_status === "succeed") {
      const url = task.task_result?.videos?.[0]?.url;
      if (!url) throw new Error("Kling returned no video URL");
      const vidRes = await providerFetch("Kling Download", url, {});
      return Buffer.from(new Uint8Array(await vidRes.arrayBuffer()));
    }
    if (task.task_status === "failed")
      throw new Error("Kling generation failed");
  }
  throw new Error("Kling timed out");
}

// ---------- Hailuo AI (MiniMax) ----------

async function hailuoVideo(
  req: ImageToVideoRequest,
  config: CapabilityConfig,
): Promise<Buffer> {
  const meta = providerMetaRequired("video", "hailuo");
  const baseUrl = config.baseUrl?.trim() || meta.defaultBaseUrl;
  const model = config.model?.trim() || "MiniMax-Hailuo-02";
  const key = config.apiKey?.trim();
  if (!key) throw new Error("Hailuo AI needs an API key");

  const response = await providerFetch(
    "Hailuo Video",
    joinUrl(baseUrl, "v1/video_generation"),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        prompt: req.prompt,
        first_frame_image: `data:image/png;base64,${req.imagePngBase64}`,
        duration: req.duration || 6,
        resolution: "1080P",
      }),
    },
  );

  const data = await response.json();
  if (!data.task_id) throw new Error("Hailuo failed to start generation");

  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const poll = await providerFetch(
      "Hailuo Poll",
      joinUrl(baseUrl, `v1/video_generation/${data.task_id}`),
      { headers: { Authorization: `Bearer ${key}` } },
    );
    const task = await poll.json();
    if (task.status === "Success") {
      const url = task.file_id
        ? joinUrl(baseUrl, `v1/files/${task.file_id}`)
        : task.video_url;
      if (!url) throw new Error("Hailuo returned no video URL");
      const vidRes = await providerFetch("Hailuo Download", url, {});
      return Buffer.from(new Uint8Array(await vidRes.arrayBuffer()));
    }
    if (task.status === "Fail") throw new Error("Hailuo generation failed");
  }
  throw new Error("Hailuo timed out");
}

// ---------- LTX Studio ----------

async function ltxStudioVideo(
  req: ImageToVideoRequest,
  config: CapabilityConfig,
): Promise<Buffer> {
  const meta = providerMetaRequired("video", "ltxstudio");
  const baseUrl = config.baseUrl?.trim() || meta.defaultBaseUrl;
  const model = config.model?.trim() || "ltx-2-5-pro";
  const key = config.apiKey?.trim();
  if (!key) throw new Error("LTX Studio needs an API key");

  const response = await providerFetch(
    "LTX Video",
    joinUrl(baseUrl, "v2/image-to-video"),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        image_uri: `data:image/png;base64,${req.imagePngBase64}`,
        prompt: req.prompt,
        model,
        duration: req.duration || 8,
        resolution: "1920x1080",
      }),
    },
  );

  const data = await response.json();
  if (!data.id) throw new Error("LTX Studio failed to start generation");

  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const poll = await providerFetch(
      "LTX Poll",
      joinUrl(baseUrl, `v2/image-to-video/${data.id}`),
      { headers: { Authorization: `Bearer ${key}` } },
    );
    const task = await poll.json();
    if (task.status === "completed") {
      const url = task.result?.video_url;
      if (!url) throw new Error("LTX returned no video URL");
      const vidRes = await providerFetch("LTX Download", url, {});
      return Buffer.from(new Uint8Array(await vidRes.arrayBuffer()));
    }
    if (task.status === "failed")
      throw new Error(`LTX failed: ${task.error || "unknown"}`);
  }
  throw new Error("LTX timed out");
}
