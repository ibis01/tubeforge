// Story engine — scene-based scripts via GLM, identity-locked storyboards via
// CogView (+ image editing when a cast portrait exists), per-scene TTS so the
// final video timeline maps 1:1 to scenes, and SRT caption building.
// The `render.ts` compositor consumes these artifacts to assemble the MP4.

import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { parseJsonLoose, videoDir, splitForTts, researchBriefBlock, type ResearchBrief } from "./ai";
import { aiCall } from "./budget";
import { runQualityGate } from "./quality";
import { mergeWavs } from "./wav";
import { CAMERAS, SCENE_COUNTS, SFX_KINDS, sanitizeSceneStyle, sceneStylePrompt, type Scene, type StockRef } from "./types";
import { normalizeFocalToken } from "./motion";
import { characterSceneFragment, readPortrait } from "./characters";
import { isJobRunning } from "./jobs";
import { chatComplete } from "./providers/chat";
import { ttsSynthesize } from "./providers/tts";
import { imageEdit, imageGenerate, imageEditSupported } from "./providers/image";

const execFileAsync = promisify(execFile);

const UPLOAD_ROOT = path.join(process.cwd(), "uploads");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- Scene storage ----------

export function sceneImageFile(index: number): string {
  return `scene-${String(index).padStart(2, "0")}.png`;
}

export function sceneWavFile(index: number): string {
  return `scene-${String(index).padStart(2, "0")}.wav`;
}

/** Validate a persisted StockRef (legacy/unknown shapes are dropped). */
function parseStockRef(raw: unknown): StockRef | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const s = raw as Record<string, unknown>;
  if (
    (s.source !== "pexels" && s.source !== "pixabay") ||
    typeof s.file !== "string" ||
    !/^stock-\d{2}\.mp4$/.test(s.file)
  )
    return undefined;
  return {
    source: s.source,
    file: s.file,
    query: String(s.query ?? ""),
    credit: String(s.credit ?? ""),
    pageUrl: String(s.pageUrl ?? ""),
    durationSec: Number(s.durationSec ?? 0),
  };
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
        rehook: s.rehook != null ? Boolean(s.rehook) : i === 0, // legacy rows: scene 1 is the hook
        sfx: (SFX_KINDS as readonly string[]).includes(String(s.sfx ?? ""))
          ? String(s.sfx)
          : s.rehook && s.sfx == null
            ? "sting" // legacy rehook rows still get their attention reset
            : "none",
        focal: normalizeFocalToken(s.focal as string | null | undefined) ?? undefined,
        stock: parseStockRef(s.stock),
        style: s.style != null ? sanitizeSceneStyle(s.style) : undefined,
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
      rehook: s.rehook,
      sfx: s.sfx,
      focal: normalizeFocalToken(s.focal) ?? "center",
      style: sanitizeSceneStyle(s.style),
      hasImage,
      imageUrl: hasImage ? `/api/videos/${videoId}/storyboard/${s.index}` : null,
      generating: isJobRunning(`${videoId}#scene${s.index}`, "scene"),
      hasStock: Boolean(s.stock),
      stockUrl: s.stock ? `/api/videos/${videoId}/stock/${s.index}` : null,
      stockSource: s.stock?.source ?? null,
      stockQuery: s.stock?.query ?? null,
      stockCredit: s.stock?.credit ?? null,
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

// ---------- Scene normalization ----------

/** Coerce one raw LLM scene object into a valid Scene (shared by all writers). */
export function normalizeScene(s: Record<string, unknown>, i: number): Scene {
  const sfx = String(s.sfx ?? "none").trim().toLowerCase();
  return {
    index: i + 1,
    title: String(s.title ?? `Scene ${i + 1}`).trim().slice(0, 60),
    narration: String(s.narration ?? "").trim(),
    visual: String(s.visual ?? "").trim(),
    camera: CAMERAS.some((c) => c.id === s.camera) ? String(s.camera) : "zoom-in",
    mood: String(s.mood ?? "").trim().slice(0, 200),
    caption: String(s.caption ?? "").trim().slice(0, 60),
    hostInScene: Boolean(s.hostInScene),
    rehook: Boolean(s.rehook),
    sfx: (SFX_KINDS as readonly string[]).includes(sfx) ? sfx : "none",
    focal: normalizeFocalToken(s.focal as string | null | undefined) ?? undefined,
  };
}

// ---------- Stage 1 — scene script ----------

export interface SceneScriptPackage {
  title: string;
  description: string;
  tags: string[];
  scenes: Scene[];
  script: string; // narration joined by blank lines (compat + word count)
}

/**
 * Convert leftover math notation into speakable words. The script prompt bans
 * formulas, but this backstop keeps TTS from ever reading "^" or "×" aloud
 * (glm-flash models still slip the odd formula past the prompt).
 */
export function narrationToSpeech(text: string): string {
  return text
    .replace(/(\d)\s*%/g, "$1 percent")
    .replace(/\s*\^\s*/g, " to the power of ")
    .replace(/\s*×\s*/g, " times ")
    .replace(/\s*÷\s*/g, " divided by ")
    .replace(/\s*=\s*/g, " equals ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Backstop for visual prompts that slipped chart/text/UI requests past the
 * script prompt — AI image models render those as garbled nonsense
 * ("Σ=d=V0" galaxies, fake bar charts), so they get a hard corrective clause.
 */
const UNPAINTABLE_RE =
  /\b(chart|graph|diagram|formula|equation|numbers?|letters?|text|document|contract|spreadsheet|interface|screen)\b/i;

export function paintableVisual(visual: string): string {
  if (!UNPAINTABLE_RE.test(visual)) return visual;
  const fix =
    "Paint this as a physical, text-free moment: real objects and people only — no charts, no writing, no numbers, no screens with readable content anywhere in frame.";
  return `${visual.replace(/[.\s]+$/, "")}. ${fix}`;
}

/**
 * Deterministic attention map — rehooks land on scene 1, then every 3rd
 * scene (1, 4, 7, …). The model cannot be trusted to pace these itself
 * (it flagged half the scenes as rehooks when left to choose).
 */
export function isRehookPosition(sceneIndex0: number): boolean {
  return sceneIndex0 % 3 === 0;
}

/**
 * Shared post-processor: enforces the rehook map, keeps SFX reserved for
 * rehook beats only (a synth cue on every scene boundary reads as cheap),
 * speaks math notation, and hardens visual prompts. Mutates + returns scenes.
 */
export function applyRetentionRules(scenes: Scene[]): Scene[] {
  return scenes.map((s, i) => {
    const scene = { ...s };
    scene.rehook = isRehookPosition(i);
    scene.sfx = scene.rehook ? (i === 0 ? "boom" : scene.sfx === "none" ? "sting" : scene.sfx) : "none";
    scene.narration = narrationToSpeech(scene.narration);
    scene.visual = paintableVisual(scene.visual);
    return scene;
  });
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

  const rehookList = Array.from({ length: sceneCount }, (_, i) => i + 1)
    .filter((_, i) => isRehookPosition(i))
    .join(", ");

  const castBlock = opts.character
    ? `RECURRING HOST: "${opts.character.name}" appears in most (not all) scenes.
${opts.character.personality ? `Personality: ${opts.character.personality}` : ""}
Write the narration in their voice. Mark scenes where they appear with "hostInScene": true. In those scenes' visual prompts, describe WHERE and HOW the host appears so the art stays consistent.`
    : "";

  const raw = await aiCall("llm", "scene script LLM", () =>
    chatComplete({
      system:
        "You are an elite faceless-YouTube storyteller and storyboard director whose videos hold 70%+ retention. You structure videos as a sequence of visual scenes, each with tight narration and a concrete image prompt that an AI artist could paint. You write with surgical concreteness: real names, numbers with units, specific places, sensory verbs. BANNED everywhere in the video: generic openers ('Since the dawn of time', 'Throughout history', 'In a world where', 'Have you ever wondered', 'X was one of the most Y in history'), tired clichés ('the eighth wonder of the world', 'Einstein said...', 'skip the daily latte', 'the best time to plant a tree was', 'the power of X is real', 'whether you\'re a X or a Y'), apocryphal or unverifiable quotes attributed to famous people, filler words, vague superlatives without specifics, corporate hedging, math formulas or equations written as notation (speak them in words instead). You always respond with STRICT JSON only — no markdown, no commentary.",
      user: `Create a scene-based YouTube video package.
Niche: ${opts.niche}
Tone: ${toneDesc}
Topic: "${opts.topic}"
Structure: exactly ${sceneCount} scenes, about ${wordsPerScene} words of narration per scene (total ≈ ${words} words).
${researchBriefBlock(opts.brief)}${castBlock}

NARRATION RULES (spoken aloud by a text-to-speech voice):
- Narration is SPOKEN language. Never write formulas, equations or notation — say them in words ("ten percent a year", not "10% APR"; "your money doubles roughly every seven years", not "(1+R)^T").
- Numbers are allowed and encouraged ($10,000, 30 years) — just never inside a formula.
- NEVER quote a famous person unless the quote is verifiable and short; apocryphal quotes ("Einstein called it the eighth wonder") are banned.
- Use a specific real detail (a name, a place, a date, a dollar figure) in at least half the scenes.

VISUAL RULES (each scene art is painted by an AI image model):
- Describe ONE frozen paintable moment: concrete subject doing something, in a specific place, at a specific time of day.
- NEVER ask for charts, graphs, formulas, floating numbers, letters, documents, contracts, UI screens or anything that contains writing — image models render those as garbled gibberish. Express the idea with physical objects and people instead (rising stacks of coins instead of a growth chart).
- NEVER describe a transformation or morph ("aging from young to old", "dissolving into numbers") — pick the single most striking end-state and paint that.

RETENTION RULES:
- Scene 1 is the HOOK: open in mid-action, with a shocking number, or by dropping the viewer into the single most dramatic moment. Name something concrete in the first 5 words. The hook must create an open loop the video only closes at the end. NEVER open with background or context.
- Scenes ${rehookList} are REHOOK beats: they open with a pattern interrupt — a reversal ('But then...'), a direct question, a counter-intuitive claim, or a shocking stat — and are flagged "rehook": true. No other scene is a rehook.
- Every scene ends on a sentence that pulls the viewer forward (cliffhanger, question, promise) except the final CTA scene.
- "sfx": sound cues are RESERVED for the rehook scenes — set a fitting cue ("boom", "sting", "riser" or "whoosh") on those and "none" on every other scene.

Return JSON with exactly these keys:
{
  "title": "click-worthy title under 70 characters",
  "description": "engaging YouTube description (2-3 sentences) followed by a line of hashtags",
  "tags": ["10 SEO tags"],
  "scenes": [
    {
      "title": "short scene label (2-4 words)",
      "narration": "the spoken narration for this scene (${wordsPerScene} words, gripping and rhythmic; scene 1 opens with the hook, the last scene closes with a call-to-action)",
      "visual": "detailed image prompt for the scene art: main subject, setting, action, composition, time of day. NO camera or lighting words here",
      "camera": "one of: zoom-in, zoom-out, pan-left, pan-right, push-in",
      "mood": "color palette + lighting mood keywords, e.g. 'teal shadows, cold moonlight, volumetric haze'",
      "caption": "punchy on-screen subtitle under 45 characters (no quotes, no emojis)",
      "focal": "where the viewer's eye must stay while the camera moves — the subject, face or key object in the frame. One of: center, left, right, upper, lower, upper-left, upper-right, lower-left, lower-right",
      "hostInScene": ${opts.character ? "true/false — does the host appear in this scene?" : "false"},
      "rehook": true/false,
      "sfx": "whoosh|boom|riser|sting|pop|none"
    }
  ]
}`,
    })
  );
  const parsed = parseJsonLoose(raw);

  const title = String(parsed.title ?? "").trim();
  const description = String(parsed.description ?? "").trim();
  const tags = Array.isArray(parsed.tags) ? parsed.tags.map(String).slice(0, 12) : [];

  const rawScenes = Array.isArray(parsed.scenes) ? parsed.scenes : [];
  const scenes: Scene[] = rawScenes
    .map((s: Record<string, unknown>, i: number) => normalizeScene(s, i))
    .filter((s: Scene) => s.narration && s.visual);

  if (!title || scenes.length < 2)
    throw new Error("Incomplete scene package from model");

  // Deterministic retention map — the model's own rehook/sfx choices are
  // overridden (it over-flags both), narration math is spoken, visuals are
  // hardened against image-model gibberish.
  const finalScenes = applyRetentionRules(scenes);

  // Narration joined = the classic script field (drives word count + fallback TTS)
  const script = finalScenes.map((s) => s.narration).join("\n\n");

  return { title, description, tags, scenes: finalScenes, script };
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
  const { scene } = opts;
  // ONE dominant subject, painted literally: multi-subject prompts scatter
  // the composition and the model fills the frame with unrelated clutter.
  // The no-text clause stays (numbers/charts come out as gibberish glyphs).
  // A per-scene art style (Scene Studio) is woven in right after the subject
  // so the taste override steers the whole render, not just the edges.
  const styleClause = sceneStylePrompt(scene.style);
  const artPrompt = `${scene.visual}.${styleClause ? ` ${styleClause}.` : ""} ${scene.mood}. Wide 16:9 cinematic frame, ONE dominant subject filling the frame, highly detailed, professional color grading, storytelling composition. Absolutely no text, no letters, no numbers, no charts, no graphs, no readable writing, no watermarks — any information in the scene must be shown as physical objects, never as writing.`;

  const portrait =
    scene.hostInScene && opts.character?.id
      ? readPortrait(opts.character.id)
      : null;

  const imagePath = path.join(videoDir(opts.videoId), sceneImageFile(scene.index));
  const canEdit = await imageEditSupported();

  const produce = async () => {
    let buffer: Buffer | null = null;
    if (opts.character && portrait && canEdit) {
      // Identity-locked: seed the edit with the cast portrait so the host keeps
      // their exact likeness inside this scene. Real failures fall through to
      // the prompt-seeded generation below.
      buffer = await aiCall(
        "image",
        `scene ${scene.index} edit (host likeness)`,
        () =>
          imageEdit({
            prompt: `Place this exact person into the described scene, keeping their face, hairstyle, glasses, facial hair and signature outfit perfectly recognizable. Scene: ${artPrompt}`,
            imagePngBase64: portrait.toString("base64"),
            size: "1344x768",
          }).then((b) => {
            if (!b) throw new Error("Image edit returned no data");
            return b;
          }),
        { attempts: 4, baseDelayMs: 5000 }
      ).catch(() => null);
    }

    if (!buffer) {
      const castFragment = scene.hostInScene
        ? characterSceneFragment(opts.character ?? { name: "", identityAnchor: null, appearance: null })
        : "";
      buffer = await aiCall(
        "image",
        `scene ${scene.index} image`,
        () =>
          imageGenerate({
            prompt: castFragment ? `${artPrompt} ${castFragment}` : artPrompt,
            size: "1344x768",
          }),
        { attempts: 4, baseDelayMs: 5000 }
      );
    }

    if (buffer.length < 1000) throw new Error(`Scene ${scene.index} image is empty`);
    fs.writeFileSync(imagePath, buffer);
  };

  // Phase 3: VLM quality gate — when enabled (qualityGate = "all") every
  // scene image is inspected against ITS scene: subject/story match first,
  // artifact detection second; below-threshold images get one re-roll.
  await runQualityGate({
    kind: "scene",
    videoId: opts.videoId,
    imagePath,
    context: `storyboard scene ${scene.index} "${scene.title}" of a story video — this exact image must depict the scene's moment: ${scene.visual} (mood: ${scene.mood}; narration at this moment: "${scene.narration.slice(0, 140)}")`,
    generate: produce,
  });

  return { fileBytes: fs.existsSync(imagePath) ? fs.statSync(imagePath).size : 0 };
}

// ---------- Scene Studio — per-scene image editing ----------

/**
 * AI-edit the CURRENT scene image with a free-form instruction ("make it
 * night", "remove the crowd", "warmer light"). Keeps the composition the
 * user already chose — this is the taste knob between a full re-roll and
 * settling for what the model painted. Requires an edit-capable image
 * provider (CogView / gpt-image-1); throws an actionable error otherwise.
 */
export async function editSceneImage(opts: {
  videoId: string;
  scene: Scene;
  instruction: string;
}): Promise<{ fileBytes: number }> {
  const { scene } = opts;
  const instruction = opts.instruction.trim();
  if (instruction.length < 3)
    throw new Error("Describe the change you want (at least 3 characters)");
  if (instruction.length > 500)
    throw new Error("Instruction too long — keep it under 500 characters");

  const imagePath = path.join(videoDir(opts.videoId), sceneImageFile(scene.index));
  if (!fs.existsSync(imagePath))
    throw new Error(`Scene ${scene.index} has no image yet — generate the storyboard first`);

  if (!(await imageEditSupported()))
    throw new Error(
      "Your image provider can't edit existing images — use Regenerate with an updated prompt instead"
    );

  const current = fs.readFileSync(imagePath);
  const buffer = await aiCall(
    "image",
    `scene ${scene.index} edit (instruction)`,
    () =>
      imageEdit({
        // Keep the edit surgical: preserve the composition/subject, apply the
        // requested change, and keep the no-text hygiene clause so edits don't
        // smuggle garbled lettering into previously clean frames.
        prompt: `Edit this image: ${instruction}. Keep the overall composition, subject and framing unchanged unless the instruction asks otherwise. Photorealistic continuity with the original. Absolutely no text, no letters, no numbers, no watermarks.`,
        imagePngBase64: current.toString("base64"),
        size: "1344x768",
      }).then((b) => {
        if (!b) throw new Error("Image edit returned no data");
        return b;
      }),
    { attempts: 3, baseDelayMs: 5000 }
  );

  if (buffer.length < 1000) throw new Error(`Edited image for scene ${scene.index} is empty`);
  fs.writeFileSync(imagePath, buffer);
  return { fileBytes: buffer.length };
}

const MAX_SCENE_UPLOAD_BYTES = 15 * 1024 * 1024;

/** Magic-byte sniffing — extensions lie, file signatures don't. */
function sniffImageFormat(buf: Buffer): "png" | "jpeg" | "webp" | null {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
    return "png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (
    buf.length > 12 &&
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "webp";
  return null;
}

/**
 * Replace a scene's image with a user-supplied file (Scene Studio upload).
 * The bytes are cover-cropped to the pipeline's 1344x768 canvas with ffmpeg
 * so Smart Motion, the renderer and the Shorts cutter can treat it exactly
 * like a generated frame. Returns the written file's size.
 */
export async function replaceSceneImage(
  videoId: string,
  index: number,
  upload: Buffer
): Promise<number> {
  if (!Number.isInteger(index) || index < 1 || index > 99)
    throw new Error("Invalid scene number");
  if (upload.length < 1000) throw new Error("That file is too small to be a real image");
  if (upload.length > MAX_SCENE_UPLOAD_BYTES)
    throw new Error(`Image exceeds the ${MAX_SCENE_UPLOAD_BYTES / 1024 / 1024} MB limit`);
  if (!sniffImageFormat(upload))
    throw new Error("Unsupported image — upload a PNG, JPEG or WebP file");

  const dir = videoDir(videoId);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `upload-tmp-${Date.now()}`);
  const outPath = path.join(dir, sceneImageFile(index));
  fs.writeFileSync(tmp, upload);

  try {
    // Cover-crop: scale up to fill 1344x768, center-crop the overflow, lock
    // the sample aspect — identical geometry to generated scene art.
    await execFileAsync(
      "ffmpeg",
      [
        "-y", "-i", tmp,
        "-vf", "scale=1344:768:force_original_aspect_ratio=increase,crop=1344:768,setsar=1",
        "-frames:v", "1",
        outPath,
      ],
      { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }
    );
  } finally {
    fs.rmSync(tmp, { force: true });
  }

  const bytes = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
  if (bytes < 1000) throw new Error("Could not process that image — the file may be corrupt");
  return bytes;
}

/** Full storyboard — every scene image, paced to respect upstream burst limits.
 *  Resumable: scenes whose image already exists on disk are skipped, so a 429
 *  mid-way through a 16-scene run only re-paints the scenes that didn't finish.
 */
export async function generateStoryboard(opts: {
  videoId: string;
  scenes: Scene[];
  character?: {
    id: string;
    name: string;
    identityAnchor: string | null;
    appearance: string | null;
  } | null;
  /** Throw inside the loop when the user cancelled the job (jobs.ts). */
  shouldCancel?: () => boolean;
  /** Progress hook per finished scene (i is 0-based). */
  onSceneDone?: (i: number, total: number) => void;
  /** When true, regenerate every scene even if its image already exists. Default false. */
  force?: boolean;
}): Promise<{ generated: number }> {
  let generated = 0;
  for (const [i, scene] of opts.scenes.entries()) {
    if (opts.shouldCancel?.())
      throw new Error("__CANCELLED__"); // route translates into JobCancelledError

    // Resume support: a scene whose image is already on disk is treated as done.
    // The per-scene re-roll endpoint can still force a single scene to repaint.
    if (!opts.force) {
      const existing = path.join(videoDir(opts.videoId), sceneImageFile(scene.index));
      if (fs.existsSync(existing) && fs.statSync(existing).size >= 1000) {
        opts.onSceneDone?.(i, opts.scenes.length);
        if (i < opts.scenes.length - 1) await sleep(2000);
        continue;
      }
    }

    await generateSceneImage({ ...opts, scene });
    generated++;
    opts.onSceneDone?.(i, opts.scenes.length);
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
      const buffer = await aiCall(
        "tts",
        `scene ${scene.index} tts (${chunk.length} chars)`,
        () => ttsSynthesize({ input: chunk, voice: opts.voice, speed: opts.speed }),
        { attempts: 6, baseDelayMs: 8000 } // outlast rate-limit storms (≈16 min of patience)
      );
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
