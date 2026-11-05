// Z.ai i2v core — the submit → poll → download logic behind the SDK shell.
//
// LIVE-CALIBRATED against the real gateway (probe, 2026-11-05 UTC): a 256x144
// steelblue frame through cogvideox-3 (quality "speed", 5s, 1080p) came back
// SUCCESS in ~2.8 min with video_result[0].url → a 4.9 MB h264 1920x1080
// 5.1s clip. The response shape this core parses is exactly what the live
// task returned: { id, task_status: "PROCESSING" | "SUCCESS" | "FAIL",
// video_result?: [{ url }] }.
//
// Deliberately SDK-free: the client is a minimal STRUCTURAL shape satisfied
// by the real Z.ai client, so the unit suite drives every path (SUCCESS /
// FAIL / no-id / no-url / timeout / empty download) with a fake — the same
// "pure cores behind thin shells" pattern the render-QC lenses use.
//
// Callers:
//   providers/video.ts  → zaiVideo (the settings Test button + any
//                         imageToVideo caller with provider "zai")
//   render.ts           → ensureSceneClip (the per-scene i2v channel; keeps
//                         its own clip cache + aiCall retry around this core)

/** The slice of the Z.ai client the core needs (structural — the real
 *  client satisfies this without importing the SDK here). */
export interface ZaiVideoClientShape {
  video: {
    generations: {
      create: (body: Record<string, unknown>) => Promise<{ id?: string | null }>;
    };
  };
  async: {
    result: {
      query: (taskId: string) => Promise<ZaiVideoAsyncResult>;
    };
  };
}

/** The live result shape (probe + SDK d.ts): task_status drives the loop,
 *  the video URL may arrive under several keys depending on model/version —
 *  video_result[0].url is the canonical one, the rest are fallbacks. */
export interface ZaiVideoAsyncResult {
  task_status?: string | null;
  video_result?: Array<{ url?: string }> | null;
  video_url?: string | null;
  url?: string | null;
  video?: string | null;
}

export interface ZaiVideoCoreRequest {
  prompt: string;
  imagePngBase64: string;
}

export interface ZaiVideoCoreOpts {
  /** Capability model id (default cogvideox-3 at the call sites). */
  model: string;
  duration?: number; // default 5
  fps?: number; // default 30
  size?: string; // default "1920x1080"
  quality?: "speed" | "quality"; // default "speed"
  withAudio?: boolean; // default false
  /** Poll cadence / budget. Defaults: 5s × 60 = 5 min (the render pipeline
   *  passes 10s × 60 = 10 min to match its historical window). */
  pollMs?: number;
  maxPolls?: number;
  /** Injectable downloader — production uses global fetch. */
  fetchFn?: (url: string) => Promise<Response>;
}

/** A downloaded clip below this is an empty/truncated file, not a video. */
export const ZAI_VIDEO_MIN_BYTES = 10_000;

export async function zaiVideoViaClient(
  zai: ZaiVideoClientShape,
  req: ZaiVideoCoreRequest,
  opts: ZaiVideoCoreOpts,
): Promise<Buffer> {
  const pollMs = opts.pollMs ?? 5_000;
  const maxPolls = opts.maxPolls ?? 60;
  const doFetch = opts.fetchFn ?? fetch;

  const submit = await zai.video.generations.create({
    model: opts.model,
    prompt: req.prompt,
    image_url: `data:image/png;base64,${req.imagePngBase64}`,
    quality: opts.quality ?? "speed",
    with_audio: opts.withAudio ?? false,
    duration: opts.duration ?? 5,
    fps: opts.fps ?? 30,
    size: opts.size ?? "1920x1080",
  });
  if (!submit?.id)
    throw new Error("Z.ai video: the provider returned no task id");

  for (let i = 0; i < maxPolls; i++) {
    await new Promise((r) => setTimeout(r, pollMs));
    const res = await zai.async.result.query(submit.id);
    const status = res?.task_status;
    const url =
      res?.video_result?.[0]?.url ??
      res?.video_url ??
      res?.url ??
      res?.video ??
      null;
    if (status === "SUCCESS") {
      if (!url)
        throw new Error(
          "Z.ai video: task succeeded but returned no video URL"
        );
      const response = await doFetch(url);
      const buf = Buffer.from(new Uint8Array(await response.arrayBuffer()));
      if (buf.length < ZAI_VIDEO_MIN_BYTES)
        throw new Error("Z.ai video: downloaded clip is empty or truncated");
      return buf;
    }
    if (status === "FAIL")
      throw new Error("Z.ai video: the generation task failed");
  }
  throw new Error("Z.ai video: generation timed out");
}
