// AI pipeline services for TubeForge — LLM script generation, TTS voiceover, thumbnail art.
// z-ai-web-dev-sdk is used server-side only.

import fs from "fs";
import path from "path";
import ZAI from "z-ai-web-dev-sdk";
import { mergeWavs } from "./wav";
import { aiCall } from "./budget";
import { LENGTHS, THUMB_STYLES, type ResearchIdea } from "./types";
import { syncZaiConfigFile } from "./zai-config";
import { chatComplete } from "./providers/chat";
import { ttsSynthesize } from "./providers/tts";
import { imageEdit, imageGenerate, imageEditSupported } from "./providers/image";

const UPLOAD_ROOT = path.join(process.cwd(), "uploads");

export function videoDir(videoId: string) {
  const dir = path.join(UPLOAD_ROOT, videoId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

let zaiInstance: Awaited<ReturnType<typeof ZAI.create>> | null = null;
export async function getZAI() {
  if (!zaiInstance) {
    // Settings stored in the UI (API key / base URL) win over any existing
    // config file — materialize them before the SDK reads the file.
    await syncZaiConfigFile();
    zaiInstance = await ZAI.create();
  }
  return zaiInstance;
}

/** Drop the cached SDK client so the next getZAI() picks up fresh settings. */
export function resetZAIClient() {
  zaiInstance = null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Extract JSON from an LLM response that may contain markdown fences or prose. */
export function parseJsonLoose(raw: string): Record<string, unknown> {
  const cleaned = raw
    .replace(/```json/gi, "```")
    .replace(/```/g, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error("Model did not return valid JSON");
  }
}

export interface ScriptPackage {
  title: string;
  script: string;
  description: string;
  tags: string[];
}

/** Research intelligence attached to a greenlit idea (Phase 4 pipeline). */
export interface ResearchBrief {
  angle: string;
  keywords: string[];
  why: string;
}

/** Prompt block that steers GLM with Topic Radar findings. */
export function researchBriefBlock(brief: ResearchBrief | null | undefined): string {
  if (!brief) return "";
  const lines = [
    brief.angle ? `CONTENT ANGLE (research-approved): ${brief.angle}` : "",
    brief.why ? `WHY VIEWERS CLICK: ${brief.why}` : "",
    brief.keywords.length
      ? `SEO KEYWORDS to weave naturally into the title, description and tags where they fit: ${brief.keywords.join(", ")}`
      : "",
  ].filter(Boolean);
  return lines.length ? `\n${lines.join("\n")}\n` : "";
}

/** Stage 1 — GLM writes the full video package (title, script, description, tags). */
export async function generateScriptPackage(opts: {
  topic: string;
  niche: string;
  tone: string;
  length: string;
  brief?: ResearchBrief | null;
}): Promise<ScriptPackage> {
  const words = LENGTHS.find((l) => l.id === opts.length)?.words ?? 450;
  const toneMap: Record<string, string> = {
    informative: "clear, authoritative, fact-packed",
    dramatic: "intense, suspenseful, cinematic",
    humorous: "witty, playful, light-hearted",
    mysterious: "eerie, curiosity-driven, enigmatic",
    inspirational: "uplifting, emotional, motivational",
  };
  const toneDesc = toneMap[opts.tone] ?? "clear and engaging";

  const raw = await aiCall("llm", "script LLM", () =>
    chatComplete({
      system:
        "You are an elite faceless-YouTube scriptwriter with 10M+ views per video. You write narration-first scripts optimized for retention (strong hook in the first 2 sentences, open loops, pattern interrupts, and a payoff). You always respond with STRICT JSON only — no markdown, no commentary.",
      user: `Create a complete YouTube video package for a faceless channel.
Niche: ${opts.niche}
Tone: ${toneDesc}
Topic: "${opts.topic}"
Target script length: about ${words} words.
${researchBriefBlock(opts.brief)}
Return JSON with exactly these keys:
{
  "title": "click-worthy title under 70 characters, no clickbait lies",
  "script": "the full narration script. Start with a gripping hook, then the body in flowing spoken paragraphs separated by blank lines, end with a call-to-action asking viewers to subscribe. Pure narration text only — no scene directions, no camera notes, no speaker labels.",
  "description": "engaging YouTube description (2-3 sentences) followed by a line of relevant hashtags",
  "tags": ["array of 10 SEO tags relevant to the topic"]
}`,
    })
  );
  const parsed = parseJsonLoose(raw);

  const title = String(parsed.title ?? "").trim();
  const script = String(parsed.script ?? "").trim();
  const description = String(parsed.description ?? "").trim();
  const tags = Array.isArray(parsed.tags)
    ? parsed.tags.map(String).slice(0, 12)
    : [];

  if (!title || !script) throw new Error("Incomplete script package from model");
  return { title, script, description, tags };
}

/** Clean a script for speech: strip markers, markdown and emoji noise. */
function scriptToSpeech(script: string): string {
  return script
    .replace(/\[[^\]]*\]/g, " ") // [HOOK] style markers
    .replace(/\*\*|__|~~|`/g, " ") // markdown decorations
    .replace(
      /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}]/gu,
      " "
    ) // emoji & arrows
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*\n\s*/g, ". ") // paragraph breaks become sentence gaps
    .replace(/\s*\n\s*/g, " ")
    .replace(/\.{2,}/g, ".")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim();
}

/** Split text into <=maxLen chunks at sentence boundaries (TTS limit: 1024 chars). */
export function splitForTts(text: string, maxLen = 950): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+["')\]]*\s*/g) ?? [text];
  const chunks: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    // Handle pathological single sentences longer than maxLen
    let s = sentence;
    while (s.length > maxLen) {
      const cutAt = s.lastIndexOf(",", maxLen) > maxLen * 0.5
        ? s.lastIndexOf(",", maxLen)
        : Math.floor(maxLen * 0.9);
      chunks.push(s.slice(0, cutAt + 1).trim());
      s = s.slice(cutAt + 1);
    }
    if ((current + s).length <= maxLen) {
      current += s;
    } else {
      if (current.trim()) chunks.push(current.trim());
      current = s;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(Boolean);
}

/** Stage 2 — TTS the script in chunks, merge into one WAV. Returns duration. */
export async function generateVoiceover(opts: {
  script: string;
  voice: string;
  speed: number;
  videoId: string;
}): Promise<{ durationSec: number; fileBytes: number }> {
  const speech = scriptToSpeech(opts.script);
  if (!speech) throw new Error("Script has no speakable content");

  const chunks = splitForTts(speech);
  if (chunks.length === 0) throw new Error("Nothing to speak");

  const buffers: Buffer[] = [];

  for (const [i, chunk] of chunks.entries()) {
    // Pace chunk requests — rapid back-to-back TTS calls trip upstream burst limits.
    if (i > 0) await sleep(2000);
    const buffer = await aiCall(
      "tts",
      `tts chunk (${chunk.length} chars)`,
      () => ttsSynthesize({ input: chunk, voice: opts.voice, speed: opts.speed }),
      { attempts: 6, baseDelayMs: 8000 } // background job — outlast long rate-limit storms (≈16 min of patience)
    );
    if (buffer.length < 44) throw new Error("TTS returned empty audio");
    buffers.push(buffer);
  }

  const { buffer: merged, durationSec } = mergeWavs(buffers);
  const outPath = path.join(videoDir(opts.videoId), "voiceover.wav");
  fs.writeFileSync(outPath, merged);

  return { durationSec, fileBytes: merged.length };
}

/** Stage 3 — CogView generates the 16:9 thumbnail.
 * `variant` targets an A/B variant file (variant-<style>.png) instead of the primary.
 * `character` stamps the recurring host's identity onto the artwork — via visual
 * reference editing when a portrait exists, otherwise via the text identity anchor. */
export async function generateThumbnail(opts: {
  title: string;
  topic: string;
  style: string;
  videoId: string;
  variant?: boolean;
  character?: {
    id?: string;
    name: string;
    identityAnchor: string | null;
    appearance: string | null;
  } | null;
}): Promise<{ fileBytes: number; fileName: string }> {
  const stylePrompt =
    THUMB_STYLES.find((s) => s.id === opts.style)?.prompt ??
    THUMB_STYLES[0].prompt;

  const scenePrompt = `YouTube video thumbnail about "${opts.topic}". ${stylePrompt}. Wide 16:9 cinematic frame, extremely detailed, eye-catching composition built for high click-through rate, professional color grading. The host character is the single focal point. Absolutely no text, no letters, no words, no watermarks.`;

  // Preferred path — visually seed the generation with the character's portrait
  // so the host keeps their real likeness inside the scene.
  const { readPortrait, characterSceneFragment } = await import("./characters");
  const portrait =
    opts.character?.id ? readPortrait(opts.character.id) : null;

  let buffer: Buffer | null = null;
  if (opts.character && portrait && (await imageEditSupported())) {
    // Identity-locked edit seeded with the cast portrait. Real failures
    // (rate limits, server errors) fall through to the prompt-seeded path.
    buffer = await aiCall(
      "image",
      "thumbnail edit (cast likeness)",
      () =>
        imageEdit({
          prompt: `Place this exact person into a new scene — keep their face, hairstyle, glasses, facial hair and signature outfit perfectly recognizable. ${scenePrompt}`,
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
    const castFragment = opts.character
      ? characterSceneFragment(opts.character)
      : "";
    buffer = await aiCall(
      "image",
      "thumbnail image",
      () =>
        imageGenerate({
          prompt: `${scenePrompt}${castFragment ? ` ${castFragment}` : ""}`,
          size: "1344x768",
        }),
      { attempts: 4, baseDelayMs: 5000 } // background job — room for rate-limit windows
    );
  }

  if (buffer.length < 1000) throw new Error("Generated image is empty");

  const fileName = opts.variant
    ? `variant-${opts.style}.png`
    : "thumbnail.png";
  fs.writeFileSync(path.join(videoDir(opts.videoId), fileName), buffer);

  return { fileBytes: buffer.length, fileName };
}

/** Pick A/B variant styles: the video's chosen style plus up to `count-1` others. */
export function pickVariantStyles(primaryStyle: string, count = 3): string[] {
  const ids = THUMB_STYLES.map((s) => s.id);
  const styles = [ids.includes(primaryStyle) ? primaryStyle : ids[0]];
  for (const id of ids) {
    if (styles.length >= count) break;
    if (!styles.includes(id)) styles.push(id);
  }
  return styles;
}

export function readMedia(
  videoId: string,
  kind: "voiceover.wav" | "thumbnail.png" | `variant-${string}.png`
) {
  const filePath = path.join(UPLOAD_ROOT, videoId, kind);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath);
}

/** List existing A/B thumbnail variants for a video. */
export function listVariants(videoId: string): { style: string; fileName: string }[] {
  const dir = path.join(UPLOAD_ROOT, videoId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^variant-[\w-]+\.png$/.test(f))
    .map((f) => ({ style: f.replace("variant-", "").replace(".png", ""), fileName: f }))
    .sort((a, b) => a.style.localeCompare(b.style));
}

/** Promote a variant file to be the primary thumbnail.png. */
export function promoteVariant(videoId: string, style: string) {
  const variantPath = path.join(UPLOAD_ROOT, videoId, `variant-${style}.png`);
  if (!fs.existsSync(variantPath)) throw new Error(`No variant for style "${style}"`);
  fs.copyFileSync(variantPath, path.join(UPLOAD_ROOT, videoId, "thumbnail.png"));
}

export interface ResearchResult {
  ideas: ResearchIdea[];
  nicheSummary: string;
}

/** Topic Radar — GLM mines a niche for high-potential video topics with SEO metrics.
 * Phase 5: the prompt carries a PERFORMANCE INTELLIGENCE brief built from real
 * synced YouTube stats, so the strategist steers toward the channel's winners. */
export async function generateTopicResearch(opts: {
  niche: string;
  query: string;
}): Promise<ResearchResult> {
  const { performanceBriefBlock } = await import("./analytics");
  const performanceBrief = await performanceBriefBlock();

  const raw = await aiCall("llm", "research LLM", () =>
    chatComplete({
      system:
        "You are a senior YouTube growth strategist who has scaled multiple faceless channels past 1M subscribers. You deeply understand search demand, CTR psychology, watch-time retention, and how faceless niches grow. You always respond with STRICT JSON only — no markdown, no commentary.",
      user: `Research the "${opts.niche}" niche on YouTube${opts.query ? ` with a focus on "${opts.query}"` : ""}.
${performanceBrief}
Find 8 concrete, specific faceless-video topic ideas that are most likely to perform well right now. Favor evergreen topics with proven search demand and strong curiosity gaps that work without a host on camera.

Return JSON with exactly these keys:
{
  "nicheSummary": "2-3 sentence analysis of this niche's current momentum and what kind of topics win in it",
  "ideas": [
    {
      "title": "a ready-to-use YouTube video title under 70 characters",
      "angle": "one sentence describing the exact content angle and structure",
      "keywords": ["4-6 short SEO keywords or phrases people would search"],
      "searchVolume": "one of: Very High, High, Medium, Low",
      "competition": "one of: Low, Medium, High",
      "viralScore": 0-100 integer estimating click + share potential,
      "suggestedLength": "one of: short, medium, long",
      "why": "one punchy sentence on why viewers will click and stay"
    }
  ]
}`,
    })
  );
  const parsed = parseJsonLoose(raw);

  const ideas = Array.isArray(parsed.ideas)
    ? (parsed.ideas as Record<string, unknown>[]).map((idea, i) => ({
        id: `idea-${i + 1}`,
        title: String(idea.title ?? "").trim(),
        angle: String(idea.angle ?? "").trim(),
        keywords: Array.isArray(idea.keywords)
          ? idea.keywords.map(String).slice(0, 8)
          : [],
        searchVolume: String(idea.searchVolume ?? "Medium").trim(),
        competition: String(idea.competition ?? "Medium").trim(),
        viralScore: Math.max(
          1,
          Math.min(100, Math.round(Number(idea.viralScore ?? 70) || 70))
        ),
        suggestedLength: String(idea.suggestedLength ?? "medium").trim(),
        why: String(idea.why ?? "").trim(),
      }))
    : [];

  const valid = ideas.filter((i: ResearchIdea) => i.title && i.angle);
  if (valid.length === 0)
    throw new Error("Research returned no usable ideas — try a different query");

  return {
    ideas: valid.slice(0, 8),
    nicheSummary: String(parsed.nicheSummary ?? "").trim(),
  };
}
