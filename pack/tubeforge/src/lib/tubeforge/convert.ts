// Classic → Scene conversion ("Make it a video").
//
// A narration-script video (format "script") has a finished script and a
// finished voiceover but NO scenes — so it can never be rendered to an MP4.
// This module upgrades it to a scene-based story video WITHOUT throwing away
// anything the user already generated:
//
//   1. GLM splits the existing script into N consecutive scenes, copying the
//      narration VERBATIM (a mechanical sentence-splitter is the fallback).
//   2. The existing voiceover.wav is cut into per-scene WAVs with ffmpeg —
//      speech runs are detected via silencedetect and scene boundaries snap
//      to the nearest silence gap at each scene's cumulative word fraction.
//      Zero TTS calls: the voice audio the user already approved is kept.
//
// After conversion the normal story pipeline takes over: storyboard →
// (voiceover already done) → render Ken Burns or full AI animation.

import fs from "fs";
import path from "path";
import { db } from "@/lib/db";
import { parseJsonLoose, videoDir } from "./ai";
import { aiCall } from "./budget";
import { chatComplete } from "./providers/chat";
import { sceneWavFile, normalizeScene, applyRetentionRules, isRehookPosition } from "./story";
import { SCENE_COUNTS, type Scene } from "./types";

const UPLOAD_ROOT = path.join(process.cwd(), "uploads");

// ---------- 1) Script splitting ----------

const wordsOf = (text: string): string[] =>
  text.toLowerCase().match(/[a-z0-9']+/g) ?? [];

/** Word-level coverage: how much of the script's vocabulary the scenes reuse. */
function coverage(scriptWords: string[], sceneWords: string[]): number {
  if (scriptWords.length === 0) return 1;
  const scriptBag = new Map<string, number>();
  for (const w of scriptWords) scriptBag.set(w, (scriptBag.get(w) ?? 0) + 1);
  let hit = 0;
  for (const w of sceneWords) {
    const left = scriptBag.get(w) ?? 0;
    if (left > 0) {
      hit++;
      scriptBag.set(w, left - 1);
    }
  }
  return hit / scriptWords.length;
}

/** Mechanical fallback: split sentences into N groups balanced by word count. */
function mechanicalSplit(script: string, n: number): Scene[] {
  // Same decimal guard as captions/TTS — never split "$6.5" across groups.
  const DOT = "\u0001";
  const guarded = script.replace(/(\d)\.(\d)/g, "$1" + DOT + "$2");
  const sentences =
    guarded.match(/[^.!?]+[.!?]+["')\]]*\s*/g) ?? [guarded];
  const restore = (s: string) => s.replace(new RegExp(DOT, "g"), ".");
  const totalWords = wordsOf(script).length || 1;
  const target = totalWords / n;

  const groups: string[][] = [];
  let current: string[] = [];
  let currentWords = 0;
  for (const s of sentences) {
    current.push(s);
    currentWords += wordsOf(s).length;
    if (currentWords >= target && groups.length < n - 1) {
      groups.push(current);
      current = [];
      currentWords = 0;
    }
  }
  if (current.length) groups.push(current);

  return applyRetentionRules(
    groups.map((g, i) => ({
      index: i + 1,
      title: `Scene ${i + 1}`,
      narration: restore(g.join(" ")).trim(),
      visual: "",
      camera: "zoom-in",
      mood: "",
      caption: "",
      hostInScene: false,
      rehook: isRehookPosition(i),
      sfx: i === 0 ? "boom" : isRehookPosition(i) ? "sting" : "none",
    }))
  );
}

/**
 * GLM splits the script into N scenes. Narration must be copied verbatim and
 * cover the whole script in order — visual/camera/mood/caption are new
 * creative metadata that drive the storyboard + render.
 */
export async function splitScriptIntoScenes(opts: {
  script: string;
  sceneCount: number;
  niche: string;
  tone: string;
  topic: string;
}): Promise<Scene[]> {
  const raw = await aiCall("llm", "scene split LLM", () =>
    chatComplete({
      system:
        "You are a precise video editor who splits finished narration scripts into visual scenes. You NEVER rewrite or paraphrase narration — you only partition it and add art direction. You always respond with STRICT JSON only — no markdown, no commentary.",
      user: `Split the narration script below into exactly ${opts.sceneCount} consecutive scenes for the video "${opts.topic}" (${opts.niche} niche, ${opts.tone} tone).

STRICT RULES for "narration":
- Copy the script text VERBATIM — word for word, in order. No rewriting, no summarizing, no skipping.
- Together your scenes must cover the ENTIRE script from first sentence to last.
- Break at natural story beats; keep scenes roughly balanced in length.
- Scene 1 is always "rehook": true (it opens the video). Later rehook scenes are every 3rd scene — flag "rehook": true ONLY on those, and give each of them a matching "sfx" cue.

For each scene also write art direction:
- "title": short scene label (2-4 words)
- "visual": detailed image prompt (main subject, setting, action, composition, time of day — NO camera or lighting words). NEVER ask for charts, graphs, formulas, floating numbers, letters, documents or UI screens — image models render those as garbled gibberish; express the idea with physical objects and people. NEVER describe transformations ("aging", "dissolving") — paint one frozen moment.
- "camera": one of: zoom-in, zoom-out, pan-left, pan-right, push-in
- "mood": color palette + lighting keywords, e.g. "teal shadows, cold moonlight, volumetric haze"
- "caption": punchy on-screen subtitle under 45 characters
- "hostInScene": false
- "sfx": one of "boom" (reveals/impacts), "sting" (dramatic hits), "riser" (tension), "whoosh" (transitions) — RESERVED for rehook scenes; "none" on every other scene

Return JSON: { "scenes": [ { "title", "narration", "visual", "camera", "mood", "caption", "hostInScene", "rehook", "sfx" } ] }

SCRIPT:
${opts.script}`,
    })
  );
  const parsed = parseJsonLoose(raw);
  const rawScenes = Array.isArray(parsed.scenes) ? parsed.scenes : [];

  // Same deterministic retention map as fresh story scripts: rehooks on
  // scene 1 + every 3rd, SFX reserved for those beats, notation spoken,
  // visuals hardened against image-model gibberish.
  return applyRetentionRules(
    rawScenes
      .map((s: Record<string, unknown>, i: number) => normalizeScene(s, i))
      .filter((s: Scene) => s.narration)
  );
}

// ---------- 2) Voiceover cutting ----------

interface SilenceSpan {
  start: number;
  end: number;
}

/** Speech runs (complement of silences) across the full voiceover. */
function speechRuns(
  duration: number,
  silences: SilenceSpan[]
): { start: number; end: number }[] {
  const runs: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const s of silences) {
    if (s.start > cursor) runs.push({ start: cursor, end: Math.min(s.start, duration) });
    cursor = Math.max(cursor, s.end);
  }
  if (cursor < duration) runs.push({ start: cursor, end: duration });
  return runs.filter((r) => r.end - r.start > 0.05);
}

/** Map a position inside total speech time to absolute wav time. */
function speechTimeToAbsolute(
  speechSec: number,
  runs: { start: number; end: number }[]
): number {
  let remaining = speechSec;
  for (const r of runs) {
    const len = r.end - r.start;
    if (remaining <= len) return r.start + remaining;
    remaining -= len;
  }
  return runs.length ? runs[runs.length - 1].end : speechSec;
}

/**
 * Cut voiceover.wav into per-scene WAVs. Boundaries land at the cumulative
 * word fraction of the narration, mapped onto detected speech, then snapped
 * to the nearest silence gap (±2.5s) so cuts never clip a word.
 */
export async function cutVoiceoverIntoScenes(opts: {
  videoId: string;
  scenes: Scene[];
  onProgress?: (done: number, total: number) => void;
}): Promise<{ cut: number; fallbackEven: boolean }> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);

  const dir = videoDir(opts.videoId);
  const wavPath = path.join(UPLOAD_ROOT, opts.videoId, "voiceover.wav");
  if (!fs.existsSync(wavPath)) throw new Error("voiceover.wav not found");

  const run = async (args: string[], timeoutMs = 120_000) => {
    try {
      return (await execFileAsync("ffmpeg", args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 })).stderr.toString();
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      throw new Error(`ffmpeg failed: ${(e.stderr ?? e.message ?? "").split("\n").slice(-4).join("\n").slice(0, 400)}`);
    }
  };

  // Probe duration + detect silences (speech runs) in one pass.
  const probe = JSON.parse(
    (
      await execFileAsync("ffprobe", [
        "-v", "error", "-show_entries", "format=duration", "-of", "json", wavPath,
      ])
    ).stdout.toString()
  ) as { format?: { duration?: string } };
  const duration = Number(probe.format?.duration ?? 0);
  if (!Number.isFinite(duration) || duration <= 0)
    throw new Error("Could not probe voiceover duration");

  const detect = await run([
    "-i", wavPath,
    "-af", "silencedetect=noise=-35dB:d=0.30",
    "-f", "null", "-",
  ]);
  const silences: SilenceSpan[] = [];
  let pendingStart: number | null = null;
  for (const line of detect.split("\n")) {
    const startMatch = line.match(/silence_start:\s*([-\d.]+)/);
    const endMatch = line.match(/silence_end:\s*([-\d.]+)/);
    if (startMatch) pendingStart = Math.max(0, parseFloat(startMatch[1]));
    if (endMatch && pendingStart !== null) {
      silences.push({ start: pendingStart, end: Math.min(duration, parseFloat(endMatch[1])) });
      pendingStart = null;
    }
  }
  if (pendingStart !== null) silences.push({ start: pendingStart, end: duration });

  const runs = speechRuns(duration, silences);
  const totalSpeech = runs.reduce((a, r) => a + (r.end - r.start), 0) || duration;

  // Cumulative word fractions → target cut times.
  const counts = opts.scenes.map((s) => Math.max(wordsOf(s.narration).length, 1));
  const totalWords = counts.reduce((a, b) => a + b, 0);

  const cuts: number[] = [0];
  let accWords = 0;
  for (let i = 0; i < opts.scenes.length - 1; i++) {
    accWords += counts[i];
    const target = speechTimeToAbsolute((accWords / totalWords) * totalSpeech, runs);
    // Snap to the nearest silence gap midpoint within ±2.5s.
    let best = target;
    let bestDist = 2.5;
    for (const s of silences) {
      const mid = (s.start + s.end) / 2;
      const dist = Math.abs(mid - target);
      if (dist < bestDist) {
        best = mid;
        bestDist = dist;
      }
    }
    cuts.push(best);
  }
  cuts.push(duration);

  // Enforce monotonic + minimum 2s per scene.
  for (let i = 1; i < cuts.length - 1; i++) {
    if (cuts[i] - cuts[i - 1] < 2) cuts[i] = cuts[i - 1] + 2;
    if (cuts[i] > duration - 2 * (cuts.length - 1 - i)) cuts[i] = duration - 2 * (cuts.length - 1 - i);
  }

  let cut = 0;
  for (const [i, scene] of opts.scenes.entries()) {
    const start = cuts[i];
    const end = cuts[i + 1];
    if (end - start < 0.5) continue; // degenerate — leave even-split fallback? keep file absent
    await run([
      "-ss", start.toFixed(3),
      "-to", end.toFixed(3),
      "-i", wavPath,
      "-c:a", "pcm_s16le",
      "-y", path.join(dir, sceneWavFile(scene.index)),
    ]);
    cut++;
    opts.onProgress?.(cut, opts.scenes.length);
  }

  if (cut < opts.scenes.length)
    throw new Error(`Only ${cut}/${opts.scenes.length} scene audio cuts succeeded`);
  return { cut, fallbackEven: false };
}

// ---------- Orchestrator ----------

export interface ConvertResult {
  sceneCount: number;
  audioCut: boolean;
  method: "llm" | "mechanical";
}

export async function convertClassicToScenes(opts: {
  videoId: string;
  onProgress?: (label: string) => void;
}): Promise<ConvertResult> {
  const video = await db.video.findUnique({ where: { id: opts.videoId } });
  if (!video) throw new Error("Video not found");
  if (video.format === "story")
    throw new Error("Video is already scene-based");
  if (!video.script || video.script.trim().length < 80)
    throw new Error("Generate the script first — there is nothing to split into scenes");

  const sceneCount = SCENE_COUNTS[video.length] ?? 6;
  const dir = videoDir(opts.videoId);

  // 1) Split the script (GLM, mechanical fallback).
  opts.onProgress?.("Splitting the script into scenes");
  let method: "llm" | "mechanical" = "llm";
  let scenes: Scene[] = [];
  try {
    scenes = await splitScriptIntoScenes({
      script: video.script,
      sceneCount,
      niche: video.niche,
      tone: video.tone,
      topic: video.topic,
    });
    const cov = coverage(wordsOf(video.script), wordsOf(scenes.map((s) => s.narration).join(" ")));
    if (scenes.length < 2 || cov < 0.6) throw new Error(`weak split (coverage ${(cov * 100).toFixed(0)}%)`);
  } catch (err) {
    console.warn("[convert] LLM split unusable, falling back to mechanical split:", err);
    scenes = mechanicalSplit(video.script, sceneCount);
    method = "mechanical";
  }

  // 2) Cut the existing voiceover into scene WAVs (skips when none exists —
  //    the user can then run the normal story voiceover stage).
  let audioCut = false;
  const hasVoice = fs.existsSync(path.join(UPLOAD_ROOT, opts.videoId, "voiceover.wav"));
  if (hasVoice) {
    opts.onProgress?.(`Cutting narration audio into ${scenes.length} scenes`);
    await cutVoiceoverIntoScenes({ videoId: opts.videoId, scenes });
    audioCut = true;
  }

  // 3) Clear stale render artifacts (a previous story lifecycle could linger).
  for (const f of ["final.mp4", "preview.mp4", "subtitles.srt", "short.mp4", "short-thumb.png"]) {
    fs.rmSync(path.join(dir, f), { force: true });
  }

  // 4) Flip the video to story format. Storyboard + video flags reset; the
  //    voiceover stays (per-scene WAVs + merged file all exist).
  await db.video.update({
    where: { id: opts.videoId },
    data: {
      format: "story",
      scenes: JSON.stringify(scenes),
      hasStoryboard: false,
      hasVideo: false,
      hasVoiceover: hasVoice,
      hasShort: false,
      videoDuration: null,
      shortDuration: null,
      shortScene: null,
      error: null,
    },
  });

  await db.activity.create({
    data: {
      videoId: opts.videoId,
      stage: "convert",
      message: `Upgraded to scene video — ${scenes.length} scenes (${method === "llm" ? "AI" : "auto"} split)${audioCut ? ", existing voiceover preserved" : ""}. Paint the storyboard, then render.`,
    },
  });

  return { sceneCount: scenes.length, audioCut, method };
}
