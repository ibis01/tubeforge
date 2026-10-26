import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { db } from "@/lib/db";
import { generateVoiceover, readMedia } from "@/lib/tubeforge/ai";
import { generateSceneVoiceovers, parseScenes } from "@/lib/tubeforge/story";
import { ingestCustomAudio, MAX_AUDIO_BYTES, isValidAudioUrl } from "@/lib/tubeforge/voice";
import { deriveStatus } from "@/lib/tubeforge/status";
import { startJob, setJobProgress } from "@/lib/tubeforge/jobs";
import { serializeVideo } from "@/lib/tubeforge/serialize";

type Ctx = { params: Promise<{ id: string }> };

const UPLOAD_ROOT = path.join(process.cwd(), "uploads");

/** POST — (re)generate the voiceover as a background job (returns 202 immediately).
 * Long synchronous requests were killed by the gateway with 502; the job runs
 * in-process and the client polls GET /api/videos/[id] for completion.
 *
 * Three modes:
 *   default / JSON {mode:"tts"}            → built-in TTS voices (scene videos get per-scene TTS)
 *   multipart/form-data (field "file")     → bring-your-own-voice: use an uploaded audio file
 *   JSON {mode:"url", url}                 → bring-your-own-voice: download audio from an internet link
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });

  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });

  // ----- Parse the request into a voiceover mode -----
  const contentType = req.headers.get("content-type") ?? "";

  type Mode =
    | { kind: "tts" }
    | { kind: "upload"; buffer: Buffer; filename: string }
    | { kind: "url"; url: string; label?: string };

  let mode: Mode = { kind: "tts" };

  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File) || file.size === 0)
      return NextResponse.json(
        { error: "Attach an audio file in the 'file' field" },
        { status: 400 }
      );
    if (file.size > MAX_AUDIO_BYTES)
      return NextResponse.json(
        { error: `Audio exceeds the ${MAX_AUDIO_BYTES / 1024 / 1024} MB limit` },
        { status: 413 }
      );
    const label = (form.get("label") as string | null)?.trim() || file.name || "uploaded audio";
    mode = {
      kind: "upload",
      buffer: Buffer.from(await file.arrayBuffer()),
      filename: label,
    };
  } else if (contentType.includes("application/json")) {
    const body = (await req.json().catch(() => ({}))) as {
      mode?: string;
      url?: string;
      label?: string;
    };
    if (body.mode === "url") {
      const url = (body.url ?? "").trim();
      if (!url)
        return NextResponse.json({ error: "Provide an audio URL" }, { status: 400 });
      if (!isValidAudioUrl(url))
        return NextResponse.json(
          { error: "That is not a valid http(s) audio link" },
          { status: 400 }
        );
      mode = { kind: "url", url, label: body.label?.trim() };
    }
    // body.mode "tts" or absent → TTS path below
  }

  const custom = mode.kind !== "tts";
  const scenes = video.format === "story" ? parseScenes(video.scenes) : [];
  if (!custom && video.format === "story" && scenes.length === 0)
    return NextResponse.json(
      { error: "Scene video has no scenes — regenerate the scene script" },
      { status: 400 }
    );
  if (!custom && !video.script)
    return NextResponse.json(
      { error: "Video has no script yet — generate the script first" },
      { status: 400 }
    );

  // Clear any stale error from a previous failed attempt before polling starts.
  await db.video.update({ where: { id }, data: { error: null } });

  const accepted = await startJob(id, "voiceover", async () => {
    try {
      let durationSec: number;
      let voiceSource = "tts";
      let voiceLabel: string | null = null;
      let activityMsg: string;

      if (custom) {
        // ----- Bring-your-own-voice: normalize + (scene videos) cut -----
        const result = await ingestCustomAudio({
          videoId: id,
          source:
            mode.kind === "upload"
              ? { kind: "upload", buffer: mode.buffer, filename: mode.filename }
              : { kind: "url", url: mode.url },
          onProgress: (label) => setJobProgress(id, "voiceover", 1, 2, label),
        });
        durationSec = result.durationSec;
        voiceSource = "custom";
        voiceLabel = mode.kind === "upload" ? mode.filename : (mode.label ?? result.sourceLabel);
        activityMsg = `Custom voice attached from ${mode.kind === "upload" ? "upload" : "web link"} — “${voiceLabel}”, ${Math.round(durationSec)}s${
          result.scenesCut !== null ? `, cut across ${result.scenesCut} scenes` : ""
        }`;
      } else if (video.format === "story" && scenes.length > 0) {
        // Per-scene narration → scene-XX.wav + merged voiceover.wav
        const result = await generateSceneVoiceovers({
          videoId: id,
          scenes,
          voice: video.voice,
          speed: video.ttsSpeed,
        });
        durationSec = result.durationSec;
        activityMsg = `Scene-by-scene voiceover rendered (${video.voice}, ${video.ttsSpeed}x) — ${Math.round(durationSec)}s across ${scenes.length} scenes`;
      } else {
        const result = await generateVoiceover({
          script: video.script ?? "",
          voice: video.voice,
          speed: video.ttsSpeed,
          videoId: id,
        });
        durationSec = result.durationSec;
        activityMsg = `Voiceover rendered (${video.voice}, ${video.ttsSpeed}x) — ${Math.round(durationSec)}s of audio`;
      }

      if (video.format === "story") {
        // Old renders no longer match the new narration timing.
        for (const f of [
          "final.mp4",
          "preview.mp4",
          "subtitles.srt",
          "short.mp4",
          "short-thumb.png",
        ]) {
          fs.rmSync(path.join(UPLOAD_ROOT, id, f), { force: true });
        }
      }

      const fresh = await db.video.findUnique({ where: { id } });
      const nextStatus = deriveStatus(video, {
        hasVoiceover: true,
        hasThumbnail: fresh?.hasThumbnail ?? video.hasThumbnail,
      });

      await db.video.update({
        where: { id },
        data: {
          hasVoiceover: true,
          audioDuration: Math.round(durationSec * 10) / 10,
          voiceSource,
          voiceLabel,
          hasVideo: video.format === "story" ? false : video.hasVideo,
          hasShort: video.format === "story" ? false : video.hasShort,
          shortDuration: video.format === "story" ? null : video.shortDuration,
          shortScene: video.format === "story" ? null : video.shortScene,
          status: nextStatus,
          error: null,
        },
      });

      await db.activity.create({
        data: { videoId: id, stage: "voiceover", message: activityMsg },
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Voiceover failed";
      await db.video.update({
        where: { id },
        data: { status: "failed", error: message },
      });
      await db.activity.create({
        data: {
          videoId: id,
          stage: "voiceover",
          level: "error",
          message: `Voiceover failed: ${message}`,
        },
      });
      // Re-thrown so startJob records the failure for GET polling + history.
      throw err;
    }
  });

  // 202 Accepted — job already running (dedupe) or just started.
  return NextResponse.json(
    {
      video: serializeVideo(video, null, { includeScenes: true }),
      accepted: true,
      generating: true,
    },
    { status: 202 }
  );
}

/** GET — stream the voiceover WAV file. */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const media = readMedia(id, "voiceover.wav");
  if (!media)
    return NextResponse.json({ error: "No voiceover yet" }, { status: 404 });

  return new NextResponse(new Uint8Array(media), {
    status: 200,
    headers: {
      "Content-Type": "audio/wav",
      "Content-Length": String(media.length),
      "Cache-Control": "private, max-age=3600",
    },
  });
}
