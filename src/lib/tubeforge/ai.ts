// AI pipeline services for TubeForge — LLM script generation, TTS voiceover, thumbnail art.
// z-ai-web-dev-sdk is used server-side only.

import fs from "fs";
import path from "path";
import ZAI from "z-ai-web-dev-sdk";
import { mergeWavs } from "./wav";
import { LENGTHS, THUMB_STYLES, type ResearchIdea } from "./types";

const UPLOAD_ROOT = path.join(process.cwd(), "uploads");

export function videoDir(videoId: string) {
  const dir = path.join(UPLOAD_ROOT, videoId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

let zaiInstance: Awaited<ReturnType<typeof ZAI.create>> | null = null;
async function getZAI() {
  if (!zaiInstance) zaiInstance = await ZAI.create();
  return zaiInstance;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry an async AI call with exponential backoff.
 * The upstream GLM/TTS/CogView services occasionally return transient 500s
 * ("network error, please try again later") — one blip should never fail a stage.
 */
async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 3,
  baseDelayMs = 2000
): Promise<T> {
  let lastError: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (i < attempts) {
        const msg = err instanceof Error ? err.message : String(err);
        // Rate limits (429) need much longer cool-downs than transient 500s.
        const rateLimited = /429|too many requests/i.test(msg);
        const delay = baseDelayMs * Math.pow(2, i - 1) * (rateLimited ? 4 : 1);
        console.warn(
          `[ai-retry] ${label} failed (attempt ${i}/${attempts}), retrying in ${delay}ms:`,
          msg
        );
        await sleep(delay);
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`${label} failed after ${attempts} attempts`);
}

/** Extract JSON from an LLM response that may contain markdown fences or prose. */
function parseJsonLoose(raw: string): Record<string, unknown> {
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

/** Stage 1 — GLM writes the full video package (title, script, description, tags). */
export async function generateScriptPackage(opts: {
  topic: string;
  niche: string;
  tone: string;
  length: string;
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

  const zai = await getZAI();
  const completion = await withRetry("script LLM", () =>
    zai.chat.completions.create({
    messages: [
      {
        role: "assistant",
        content:
          "You are an elite faceless-YouTube scriptwriter with 10M+ views per video. You write narration-first scripts optimized for retention (strong hook in the first 2 sentences, open loops, pattern interrupts, and a payoff). You always respond with STRICT JSON only — no markdown, no commentary.",
      },
      {
        role: "user",
        content: `Create a complete YouTube video package for a faceless channel.
Niche: ${opts.niche}
Tone: ${toneDesc}
Topic: "${opts.topic}"
Target script length: about ${words} words.

Return JSON with exactly these keys:
{
  "title": "click-worthy title under 70 characters, no clickbait lies",
  "script": "the full narration script. Start with a gripping hook, then the body in flowing spoken paragraphs separated by blank lines, end with a call-to-action asking viewers to subscribe. Pure narration text only — no scene directions, no camera notes, no speaker labels.",
  "description": "engaging YouTube description (2-3 sentences) followed by a line of relevant hashtags",
  "tags": ["array of 10 SEO tags relevant to the topic"]
}`,
      },
    ],
    thinking: { type: "disabled" },
  }));

  const raw = completion.choices[0]?.message?.content ?? "";
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

  const zai = await getZAI();
  const buffers: Buffer[] = [];

  for (const chunk of chunks) {
    const response = await withRetry(
      `tts chunk (${chunk.length} chars)`,
      () =>
        zai.audio.tts.create({
          input: chunk,
          voice: opts.voice,
          speed: opts.speed,
          response_format: "wav",
          stream: false,
        }),
      5, // 5 attempts — rate-limit windows need patience
      6000 // 6s base → 6/12/24/48s backoff (x4 for 429s)
    );
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(new Uint8Array(arrayBuffer));
    if (buffer.length < 44) throw new Error("TTS returned empty audio");
    buffers.push(buffer);
  }

  const { buffer: merged, durationSec } = mergeWavs(buffers);
  const outPath = path.join(videoDir(opts.videoId), "voiceover.wav");
  fs.writeFileSync(outPath, merged);

  return { durationSec, fileBytes: merged.length };
}

/** Stage 3 — CogView generates the 16:9 thumbnail.
 * `variant` targets an A/B variant file (variant-<style>.png) instead of the primary. */
export async function generateThumbnail(opts: {
  title: string;
  topic: string;
  style: string;
  videoId: string;
  variant?: boolean;
}): Promise<{ fileBytes: number; fileName: string }> {
  const stylePrompt =
    THUMB_STYLES.find((s) => s.id === opts.style)?.prompt ??
    THUMB_STYLES[0].prompt;

  const zai = await getZAI();
  const response = await withRetry(
    "thumbnail image",
    () =>
      zai.images.generations.create({
        prompt: `YouTube video thumbnail about "${opts.topic}". ${stylePrompt}. Wide 16:9 cinematic frame, extremely detailed, eye-catching composition built for high click-through rate, professional color grading. Absolutely no text, no letters, no words, no watermarks.`,
        size: "1344x768",
      }),
    4, // background job — room for rate-limit windows
    5000 // 5/10/20s backoff (x4 for 429s)
  );

  const base64 = response.data[0]?.base64;
  if (!base64) throw new Error("Image generation returned no data");

  const buffer = Buffer.from(base64, "base64");
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

/** Topic Radar — GLM mines a niche for high-potential video topics with SEO metrics. */
export async function generateTopicResearch(opts: {
  niche: string;
  query: string;
}): Promise<ResearchResult> {
  const zai = await getZAI();
  const completion = await withRetry("research LLM", () =>
    zai.chat.completions.create({
    messages: [
      {
        role: "assistant",
        content:
          "You are a senior YouTube growth strategist who has scaled multiple faceless channels past 1M subscribers. You deeply understand search demand, CTR psychology, watch-time retention, and how faceless niches grow. You always respond with STRICT JSON only — no markdown, no commentary.",
      },
      {
        role: "user",
        content: `Research the "${opts.niche}" niche on YouTube${opts.query ? ` with a focus on "${opts.query}"` : ""}.

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
      },
    ],
    thinking: { type: "disabled" },
  }));

  const raw = completion.choices[0]?.message?.content ?? "";
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
