// Story engine — scene-based scripts via GLM, identity-locked storyboards via
// CogView (+ image editing when a cast portrait exists), per-scene TTS so the
// final video timeline maps 1:1 to scenes, and SRT caption building.
// The `render.ts` compositor consumes these artifacts to assemble the MP4.

import fs from "fs";
import path from "path";
import { getZAI, parseJsonLoose, videoDir, splitForTts, researchBriefBlock, type ResearchBrief } from "./ai";
import { aiCall } from "./budget";
import { runQualityGate } from "./quality";
import { mergeWavs } from "./wav";
import { CAMERAS, SCENE_COUNTS, type Scene } from "./types";
import { characterSceneFragment, readPortrait } from "./characters";
import { isJobRunning } from "./jobs";

const UPLOAD_ROOT = path.join(process.cwd(), "uploads");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- Scene storage ----------

export function sceneImageFile(index: number): string {
  return `scene-${String(index).padStart(2, "0")}.png`;
}

export function sceneWavFile(index: number): string {
  return `scene-${String(index).padStart(2, "0")}.wav`;
}

export function parseScenes(json: string | null | undefined): Scene[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((s: Record<string, unknown>, i: number) => ({
        index: Number(s.index ?? i + 1),
        title: String(s.title ?? `Scene ${i + 1}`),
        narration: String(s.narration ?? "").trim(),
        visual: String(s.visual ?? "").trim(),
        camera: CAMERAS.some((c) => c.id === s.camera) ? String(s.camera) : "zoom-in",
        mood: String(s.mood ?? "").trim(),
        caption: String(s.caption ?? "").trim().slice(0, 60),
        hostInScene: Boolean(s.hostInScene),
      }))
      .filter((s: Scene) => s.narration && s.visual);
  } catch {
    return [];
  }
}

export function serializeScenes(
  videoId: string,
  scenes: Scene[]
): import("./types").SceneDTO[] {
  return scenes.map((s) => {
    const hasImage = fs.existsSync(
      path.join(UPLOAD_ROOT, videoId, sceneImageFile(s.index))
    );
    return {
      index: s.index,
      title: s.title,
      narration: s.narration,
      visual: s.visual,
      camera: s.camera,
      cameraLabel: CAMERAS.find((c) => c.id === s.camera)?.label ?? s.camera,
      mood: s.mood,
      caption: s.caption,
      hostInScene: s.hostInScene,
      hasImage,
      imageUrl: hasImage ? `/api/videos/${videoId}/storyboard/${s.index}` : null,
      generating: isJobRunning(`${videoId}#scene${s.index}`, "scene"),
    };
  });
}

/** True when every scene has its storyboard image on disk. */
export function storyboardComplete(videoId: string, scenes: Scene[]): boolean {
  return (
    scenes.length > 0 &&
    scenes.every((s) =>
      fs.existsSync(path.join(UPLOAD_ROOT, videoId, sceneImageFile(s.index)))
    )
  );
}

export function readSceneImage(videoId: string, index: number): Buffer | null {
  if (!Number.isInteger(index) || index < 1 || index > 99) return null;
  const p = path.join(UPLOAD_ROOT, videoId, sceneImageFile(index));
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p);
}

// ---------- Stage 1 — scene script ----------

export interface SceneScriptPackage {
  title: string;
  description: string;
  tags: string[];
  scenes: Scene[];
  script: string; // narration joined by blank lines (compat + word count)
}

/** GLM writes the video as N scenes with narration + visual + camera + mood per scene. */
export async function generateSceneScriptPackage(opts: {
  topic: string;
  niche: string;
  tone: string;
  length: string;
  brief?: ResearchBrief | null;
  character?: {
    name: string;
    personality: string | null;
    identityAnchor: string | null;
  } | null;
}): Promise<SceneScriptPackage> {
  const sceneCount = SCENE_COUNTS[opts.length] ?? 6;
  const words = { short: 250, medium: 450, long: 700 }[opts.length] ?? 450;
  const wordsPerScene = Math.round(words / sceneCount);
  const toneMap: Record<string, string> = {
    informative: "clear, authoritative, fact-packed",
    dramatic: "intense, suspenseful, cinematic",
    humorous: "witty, playful, light-hearted",
    mysterious: "eerie, curiosity-driven, enigmatic",
    inspirational: "uplifting, emotional, motivational",
  };
  const toneDesc = toneMap[opts.tone] ?? "clear and engaging";

  const castBlock = opts.character
    ? `RECURRING HOST: "${opts.character.name}" appears in most (not all) scenes.
${opts.character.personality ? `Personality: ${opts.character.personality}` : ""}
Write the narration in their voice. Mark scenes where they appear with "hostInScene": true. In those scenes' visual prompts, describe WHERE and HOW the host appears so the art stays consistent.`
    : "";

  const zai = await getZAI();
  const completion = await aiCall("llm", "scene script LLM", () =>
    zai.chat.completions.create({
      messages: [
        {
          role: "assistant",
          content:
            "You are an elite faceless-YouTube storyteller and storyboard director. You structure videos as a sequence of visual scenes, each with tight narration and a concrete image prompt that an AI artist could paint. You always respond with STRICT JSON only — no markdown, no commentary.",
        },
        {
          role: "user",
          content: `Create a scene-based YouTube video package.
Niche: ${opts.niche}
Tone: ${toneDesc}
Topic: "${opts.topic}"
Structure: exactly ${sceneCount} scenes, about ${wordsPerScene} words of narration per scene (total ≈ ${words} words).
${researchBriefBlock(opts.brief)}${castBlock}

Return JSON with exactly these keys:
{
  "title": "click-worthy title under 70 characters",
  "description": "engaging YouTube description (2-3 sentences) followed by a line of hashtags",
  "tags": ["10 SEO tags"],
  "scenes": [
    {
      "title": "short scene label (2-4 words)",
      "narration": "the spoken narration for this scene (${wordsPerScene} words, gripping and rhythmic; scene 1 opens with a hook, the last scene closes with a call-to-action)",
      "visual": "detailed image prompt for the scene art: main subject, setting, action, composition, time of day. NO camera or lighting words here",
      "camera": "one of: zoom-in, zoom-out, pan-left, pan-right, push-in",
      "mood": "color palette + lighting mood keywords, e.g. 'teal shadows, cold moonlight, volumetric haze'",
      "caption": "punchy on-screen subtitle under 45 characters (no quotes, no emojis)",
      "hostInScene": ${opts.character ? "true/false — does the host appear in this scene?" : "false"}
    }
  ]
}`,
        },
      ],
      thinking: { type: "disabled" },
    })
  );

  const raw = completion.choices[0]?.message?.content ?? "";
  const parsed = parseJsonLoose(raw);

  const title = String(parsed.title ?? "").trim();
  const description = String(parsed.description ?? "").trim();
  const tags = Array.isArray(parsed.tags) ? parsed.tags.map(String).slice(0, 12) : [];

  const rawScenes = Array.isArray(parsed.scenes) ? parsed.scenes : [];
  const scenes: Scene[] = rawScenes
    .map((s: Record<string, unknown>, i: number) => ({
      index: i + 1,
      title: String(s.title ?? `Scene ${i + 1}`).trim().slice(0, 60),
      narration: String(s.narration ?? "").trim(),
      visual: String(s.visual ?? "").trim(),
      camera: CAMERAS.some((c) => c.id === s.camera) ? String(s.camera) : "zoom-in",
      mood: String(s.mood ?? "").trim().slice(0, 200),
      caption: String(s.caption ?? "").trim().slice(0, 60),
      hostInScene: Boolean(s.hostInScene),
    }))
    .filter((s: Scene) => s.narration && s.visual);

  if (!title || scenes.length < 2)
    throw new Error("Incomplete scene package from model");

  // Narration joined = the classic script field (drives word count + fallback TTS)
  const script = scenes.map((s) => s.narration).join("\n\n");

  return { title, description, tags, scenes, script };
}

// ---------- Stage 2 — storyboard ----------

/**
 * Render one scene's storyboard image.
 * Host scenes + cast portrait → identity-locked image EDIT (keeps the face).
 * Everything else → fresh CogView generation from the visual prompt.
 */
export async function generateSceneImage(opts: {
  videoId: string;
  scene: Scene;
  character?: {
    id: string;
    name: string;
    identityAnchor: string | null;
    appearance: string | null;
  } | null;
}): Promise<{ fileBytes: number }> {
  const zai = await getZAI();
  const { scene } = opts;
  const artPrompt = `${scene.visual}. ${scene.mood}. Wide 16:9 cinematic frame, highly detailed, professional color grading, storytelling composition. Absolutely no text, no letters, no watermarks.`;

  const portrait =
    scene.hostInScene && opts.character?.id
      ? readPortrait(opts.character.id)
      : null;

  const imagePath = path.join(videoDir(opts.videoId), sceneImageFile(scene.index));

  const produce = async () => {
    let response;
    if (opts.character && portrait) {
      // Identity-locked: seed the edit with the cast portrait so the host keeps
      // their exact likeness inside this scene.
      response = await aiCall(
        "image",
        `scene ${scene.index} edit (host likeness)`,
        () =>
          zai.images.generations.edit({
            prompt: `Place this exact person into the described scene, keeping their face, hairstyle, glasses, facial hair and signature outfit perfectly recognizable. Scene: ${artPrompt}`,
            images: [{ url: `data:image/png;base64,${portrait.toString("base64")}` }],
            size: "1344x768",
          }),
        { attempts: 4, baseDelayMs: 5000 }
      );
    } else {
      const castFragment = scene.hostInScene
        ? characterSceneFragment(opts.character ?? { name: "", identityAnchor: null, appearance: null })
        : "";
      response = await aiCall(
        "image",
        `scene ${scene.index} image`,
        () =>
          zai.images.generations.create({
            prompt: castFragment ? `${artPrompt} ${castFragment}` : artPrompt,
            size: "1344x768",
          }),
        { attempts: 4, baseDelayMs: 5000 }
      );
    }

    const base64 = response.data[0]?.base64;
    if (!base64) throw new Error(`Scene ${scene.index} returned no image data`);
    const buffer = Buffer.from(base64, "base64");
    if (buffer.length < 1000) throw new Error(`Scene ${scene.index} image is empty`);

    fs.writeFileSync(imagePath, buffer);
  };

  // Phase 3: VLM quality gate (re-rolls badly deformed scene art once when
  // qualityGate = "all"; disabled by default to keep storyboards fast).
  await runQualityGate({
    kind: "scene",
    videoId: opts.videoId,
    imagePath,
    context: `storyboard scene ${scene.index} "${scene.title}" — should depict: ${scene.visual}`,
    generate: produce,
  });

  return { fileBytes: fs.existsSync(imagePath) ? fs.statSync(imagePath).size : 0 };
}

/** Full storyboard — every scene image, paced to respect upstream burst limits. */
export async function generateStoryboard(opts: {
  videoId: string;
  scenes: Scene[];
  character?: {
    id: string;
    name: string;
    identityAnchor: string | null;
    appearance: string | null;
  } | null;
}): Promise<{ generated: number }> {
  let generated = 0;
  for (const [i, scene] of opts.scenes.entries()) {
    await generateSceneImage({ ...opts, scene });
    generated++;
    if (i < opts.scenes.length - 1) await sleep(2000);
  }
  return { generated };
}

// ---------- Stage 3 — per-scene voiceover ----------

/**
 * TTS each scene into its own WAV (scene-XX.wav) so the video timeline maps
 * 1:1 to scenes, and merge everything into voiceover.wav for compatibility.
 */
export async function generateSceneVoiceovers(opts: {
  videoId: string;
  scenes: Scene[];
  voice: string;
  speed: number;
}): Promise<{ durationSec: number; sceneDurations: number[] }> {
  const zai = await getZAI();
  const dir = videoDir(opts.videoId);
  const allBuffers: Buffer[] = [];
  const sceneDurations: number[] = [];

  for (const [i, scene] of opts.scenes.entries()) {
    if (i > 0) await sleep(2000); // pace TTS across scenes

    // Narration is short, but split anyway for safety on long scenes.
    const chunks = splitForTts(scene.narration);
    if (chunks.length === 0) throw new Error(`Scene ${scene.index} has nothing to speak`);

    const buffers: Buffer[] = [];
    for (const [j, chunk] of chunks.entries()) {
      if (j > 0) await sleep(2000); // pace chunks within a scene too
      const response = await aiCall(
        "tts",
        `scene ${scene.index} tts (${chunk.length} chars)`,
        () =>
          zai.audio.tts.create({
            input: chunk,
            voice: opts.voice,
            speed: opts.speed,
            response_format: "wav",
            stream: false,
          }),
        { attempts: 6, baseDelayMs: 8000 } // outlast rate-limit storms (≈16 min of patience)
      );
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(new Uint8Array(arrayBuffer));
      if (buffer.length < 44) throw new Error(`Scene ${scene.index} TTS returned empty audio`);
      buffers.push(buffer);
    }

    const merged = mergeWavs(buffers);
    fs.writeFileSync(path.join(dir, sceneWavFile(scene.index)), merged.buffer);
    allBuffers.push(merged.buffer);
    sceneDurations.push(merged.durationSec);
  }

  const full = mergeWavs(allBuffers);
  fs.writeFileSync(path.join(dir, "voiceover.wav"), full.buffer);

  return { durationSec: full.durationSec, sceneDurations };
}

// ---------- Captions ----------

function srtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const milli = ms % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(milli, 3)}`;
}

/** SRT built from explicit per-scene [start, duration] pairs (used by the compositor). */
export function buildSrtFromSegments(
  scenes: Scene[],
  segments: { start: number; duration: number }[]
): string {
  const parts: string[] = [];
  scenes.forEach((scene, i) => {
    const seg = segments[i];
    if (!seg) return;
    const caption = scene.caption || scene.title;
    parts.push(
      `${i + 1}\n${srtTime(seg.start)} --> ${srtTime(seg.start + seg.duration)}\n${caption}\n`
    );
  });
  return parts.join("\n");
}
