// AI pipeline services for TubeForge — LLM script generation, TTS voiceover, thumbnail art.
// z-ai-web-dev-sdk is used server-side only.

import fs from "fs";
import path from "path";
import { mergeWavs } from "./wav";
import { aiCall } from "./budget";
import { LENGTHS, THUMB_STYLES, type ResearchIdea } from "./types";
import { zaiClientFor, invalidateZaiClients } from "./zai-client";
import { chatComplete } from "./providers/chat";
import { ttsSynthesize } from "./providers/tts";
import {
  imageEdit,
  imageGenerate,
  imageEditSupported,
} from "./providers/image";

import { isVercelRuntime, scratchDir, storageDriverKind } from "./storage";
import * as storage from "./storage";

export function videoDir(videoId: string) {
  // S150 — ONE root again: storage.ts's UPLOAD_ROOT now lands on /tmp on
  // Vercel, so scratchDir() and every put()/get() share the same writable
  // tree — the scene WAVs written here, the merged voiceover.wav published
  // through storage.put, and the renderer's ffmpeg inputs all resolve to
  // /tmp/tubeforge-uploads/<videoId>/. This restores the one-seam design the
  // interim hard-coded /tmp path forked around.
  // The explicit mkdir keeps the failure loud (scratchDir swallows
  // read-only-FS errors by design — module-evaluation callers rely on that).
  const dir = scratchDir(videoId);
  if (isVercelRuntime()) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * The Settings-aware Z.ai client (T-3.10 law). The acting user's key saved
 * in Settings → AI Providers takes priority; the platform .z-ai-config file
 * (and the /etc fallback) is only the fallback. getZAI() historically ran
 * ONE platform singleton for every caller — a stored provider key was
 * silently ignored on this path. zaiClientFor resolves the per-user
 * credential (cached per user+key-hash) and throws an honest error when no
 * provider is configured at all; it owns the VERCEL HOME=/tmp fix too.
 */
export async function getZAI() {
  return zaiClientFor("chat");
}

/** Drop the cached SDK clients so the next getZAI() picks up fresh settings. */
export function resetZAIClient() {
  invalidateZaiClients();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Parse without throwing — undefined when the text is not valid JSON. */
function tryJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function repairCommonJson(text: string): string {
  return (
    text
      .replace(/,\s*([\]}])/g, "$1")
      .replace(/[\u201C\u201D]/g, '"')
  );
}

function largestBalancedJson(text: string): string | null {
  let best: string | null = null;
  for (const [open, close] of [
    ["{", "}"],
    ["[", "]"],
  ] as const) {
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== open) continue;
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let j = i; j < text.length; j++) {
        const ch = text[j];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          if (inString) escaped = true;
          continue;
        }
        if (ch === '"') {
          inString = !inString;
          continue;
        }
        if (inString) continue;
        if (ch === open) depth++;
        else if (ch === close) {
          depth--;
          if (depth === 0) {
            const candidate = text.slice(i, j + 1);
            if (best === null || candidate.length > best.length) best = candidate;
            break;
          }
        }
      }
    }
  }
  return best;
}

function isJsonScalarToken(token: string): boolean {
  return (
    token === "true" ||
    token === "false" ||
    token === "null" ||
    /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(token)
  );
}

function structuralRepairJson(text: string): string | null {
  type Edit = { kind: "quote"; start: number; end: number } | { kind: "delete"; at: number };
  const edits: Edit[] = [];
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let valueStart = -1;

  const endValue = (end: number) => {
    if (valueStart < 0) return;
    const token = text.slice(valueStart, end);
    const trimmed = token.trim();
    if (
      trimmed.length > 0 &&
      !trimmed.startsWith('"') &&
      !trimmed.startsWith("{") &&
      !trimmed.startsWith("[") &&
      !trimmed.includes('"') &&
      !isJsonScalarToken(trimmed)
    ) {
      const lead = token.length - token.trimStart().length;
      edits.push({ kind: "quote", start: valueStart + lead, end: valueStart + lead + trimmed.length });
    }
    valueStart = -1;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === ":") {
      valueStart = i + 1;
      continue;
    }
    if (ch === ",") {
      endValue(i);
      continue;
    }
    if (ch === "}" || ch === "]") {
      endValue(i);
      if (stack.length === 0) {
        edits.push({ kind: "delete", at: i });
        continue;
      }
      const open = stack[stack.length - 1] ?? "";
      if ((open === "{" && ch === "}") || (open === "[" && ch === "]")) stack.pop();
      else return null;
      continue;
    }
    if (ch === "{") {
      stack.push("{");
      valueStart = -1;
      continue;
    }
    if (ch === "[") {
      stack.push("[");
      valueStart = -1;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      endValue(i);
      continue;
    }
  }
  if (inString) return null;
  endValue(text.length);

  let out = text;
  for (let e = edits.length - 1; e >= 0; e--) {
    const edit = edits[e];
    if (edit.kind === "delete") {
      out = out.slice(0, edit.at) + out.slice(edit.at + 1);
    } else {
      const token = out.slice(edit.start, edit.end).replace(/\\/g, "\\\\");
      out = out.slice(0, edit.start) + `"${token}"` + out.slice(edit.end);
    }
  }
  const missingClosers = stack
    .slice()
    .reverse()
    .map((open) => (open === "{" ? "}" : "]"))
    .join("");
  return out + missingClosers;
}

export function parseJsonLoose(raw: string): Record<string, unknown> {
  const cleaned = raw
    .replace(/```json/gi, "```")
    .replace(/```/g, "")
    .replace(/\uFEFF/g, "")
    .replace(/[\u200B-\u200D\u2060]/g, "")
    .trim();
  const strategies: unknown[] = [
    tryJsonParse(cleaned),
    tryJsonParse(repairCommonJson(cleaned)),
  ];
  const structural = structuralRepairJson(cleaned);
  if (structural !== null) {
    strategies.push(tryJsonParse(structural));
    strategies.push(tryJsonParse(repairCommonJson(structural)));
  }
  const balanced = largestBalancedJson(cleaned);
  if (balanced !== null) {
    strategies.push(tryJsonParse(balanced));
    strategies.push(tryJsonParse(repairCommonJson(balanced)));
  }
  for (const parsed of strategies) {
    if (parsed !== undefined) return parsed as Record<string, unknown>;
  }
  throw new Error("Model did not return valid JSON");
}

export async function aiCallJson<T = Record<string, unknown>>(
  service: Parameters<typeof aiCall>[0],
  label: string,
  ask: () => Promise<string>,
  opts: {
    validate?: (parsed: Record<string, unknown>) => T;
    retry?: { attempts?: number; baseDelayMs?: number };
    call?: <U>(
      service: Parameters<typeof aiCall>[0],
      label: string,
      fn: () => Promise<U>,
      retryOpts?: { attempts?: number; baseDelayMs?: number }
    ) => Promise<U>;
  } = {}
): Promise<T> {
  const run = opts.call ?? aiCall;
  return run(
    service,
    label,
    async () => {
      const parsed = parseJsonLoose(await ask());
      return opts.validate ? opts.validate(parsed) : (parsed as T);
    },
    opts.retry ?? {}
  );
}

export interface ScriptPackage {
  title: string;
  script: string;
  description: string;
  tags: string[];
}

export interface ResearchBrief {
  angle: string;
  keywords: string[];
  why: string;
  sources?: { url: string; name: string; host: string }[];
}

export function researchBriefBlock(
  brief: ResearchBrief | null | undefined,
): string {
  if (!brief) return "";
  const lines = [
    brief.angle ? `CONTENT ANGLE (research-approved): ${brief.angle}` : "",
    brief.why ? `WHY VIEWERS CLICK: ${brief.why}` : "",
    brief.keywords.length
      ? `SEO KEYWORDS to weave naturally into the title, description and tags where they fit: ${brief.keywords.join(", ")}`
      : "",
    brief.sources?.length
      ? `REFERENCE SOURCES (real web pages found for this topic — ground every factual claim in them; never say URLs aloud, never fabricate statistics beyond what they state):\n${brief.sources
          .slice(0, 6)
          .map((s) => `- ${s.name} (${s.host}) — ${s.url}`)
          .join("\n")}`
      : "",
  ].filter(Boolean);
  return lines.length ? `\n${lines.join("\n")}\n` : "";
}

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

  const pkg = await aiCallJson<ScriptPackage>("llm", "script LLM",
    () =>
      chatComplete({
        system:
          "You are an elite faceless-YouTube scriptwriter with 10M+ views per video and 70%+ average retention. You write narration-first scripts with surgical concreteness: real names, numbers with units, specific places, sensory verbs. BANNED everywhere: generic openers ('Since the dawn of time', 'Throughout history', 'In a world where', 'Have you ever wondered', 'X was one of the most Y in history'), tired clichés ('the eighth wonder of the world', 'Einstein said...', 'skip the daily latte', 'the best time to plant a tree was', 'the power of X is real', 'whether you're a X or a Y'), apocryphal or unverifiable quotes attributed to famous people, filler words, vague superlatives without specifics, corporate hedging, math formulas or equations written as notation (speak them in words instead). You always respond with STRICT JSON only — no markdown, no commentary.",
        user: `Create a complete YouTube video package for a faceless channel.
Niche: ${opts.niche}
Tone: ${toneDesc}
Topic: "${opts.topic}"
Target script length: about ${words} words.
${researchBriefBlock(opts.brief)}
RETENTION RULES:
- The FIRST sentence is the hook: open in mid-action, drop a shocking number, or start at the most dramatic moment. Name something concrete within the first 5 words. NEVER open with background, context or a dictionary-style definition. The hook must open a loop the script only closes near the end.
- Insert a pattern interrupt every ~75 words: a reversal ('But then...'), a direct question, or a counter-intuitive fact.
- The script is SPOKEN aloud: write numbers and formulas in words ("ten percent a year", never "(1+R)^T"; "20 percent", never "20%"). No markdown, no stage directions.
- Every paragraph ends on a line that pulls the viewer forward. The final paragraph is the call-to-action.
- LENGTH IS A CONTRACT: the script must be at least ${Math.round(words * 0.55)} words (the target is about ${words}). A thin script is a failed response, not a valid one.

Return JSON with exactly these keys:
{
  "title": "click-worthy title under 70 characters, no clickbait lies",
  "script": "the full narration script. Start with the gripping hook, then the body in flowing spoken paragraphs separated by blank lines, end with a call-to-action asking viewers to subscribe. Pure narration text only — no scene directions, no camera notes, no speaker labels.",
  "description": "engaging YouTube description (2-3 sentences) followed by a line of relevant hashtags",
  "tags": ["array of 10 SEO tags relevant to the topic"]
}`,
      }),
    {
      validate: (parsed) => {
        const title = String(parsed.title ?? "").trim();
        const script = String(parsed.script ?? "").trim();
        const description = String(parsed.description ?? "").trim();
        const tags = Array.isArray(parsed.tags)
          ? parsed.tags.map(String).slice(0, 12)
          : [];
        if (!title || !script)
          throw new Error("Incomplete script package from model");
        // S155 — the classic length contract (the S151 story floor's
        // sibling): the picker promises about N words, and a lazy model used
        // to ship a thin script silently. Below the floor = a failed
        // generation — aiCall's retry loop re-asks with the same length
        // instruction instead of recording a script half the promised size.
        const wordCount = script.split(/\s+/).filter(Boolean).length;
        const minWords = Math.round(words * 0.55);
        if (wordCount < minWords)
          throw new Error(
            `Script came back short: ${wordCount} words for a ${opts.length} video that promises about ${words} — retrying`
          );
        return { title, script, description, tags };
      },
    }
  );
  return pkg;
}

function scriptToSpeech(script: string): string {
  return script
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\*\*|__|~~|`/g, " ")
    .replace(
      /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2190}-\u{21FF}]/gu,
      " ",
    )
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*\n\s*/g, ". ")
    .replace(/\s*\n\s*/g, " ")
    .replace(/\.{2,}/g, ".")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim();
}

export function splitForTts(text: string, maxLen = 950): string[] {
  const DOT = "\u0001";
  const guarded = text.replace(/(\d)\.(\d)/g, "$1" + DOT + "$2");
  const restore = (s: string) => s.replace(new RegExp(DOT, "g"), ".");
  const sentences = guarded.match(/[^.!?]+[.!?]+["')\]]*\s*/g) ?? [guarded];
  const chunks: string[] = [];
  let current = "";

  for (const rawSentence of sentences) {
    let s = restore(rawSentence);
    while (s.length > maxLen) {
      const cutAt =
        s.lastIndexOf(",", maxLen) > maxLen * 0.5
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
    if (i > 0) await sleep(2000);
    const buffer = await aiCall(
      "tts",
      `tts chunk (${chunk.length} chars)`,
      () =>
        ttsSynthesize({ input: chunk, voice: opts.voice, speed: opts.speed }),
      { attempts: 6, baseDelayMs: 8000 },
    );
    if (buffer.length < 44) throw new Error("TTS returned empty audio");
    buffers.push(buffer);
  }

  const { buffer: merged, durationSec } = mergeWavs(buffers);
  
  // Storage seam (T-3.7): write via the driver so the artifact lands in
  // object storage (s3) and the org quota counter ticks on both drivers.
  await storage.put(`${opts.videoId}/voiceover.wav`, merged);

  return { durationSec, fileBytes: merged.length };
}

export async function deriveThumbnailConcept(opts: {
  topic: string;
  script: string | null;
}): Promise<string> {
  const fallback = (opts.script ?? "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?]) /)
    .slice(0, 2)
    .join(" ")
    .slice(0, 300)
    .trim();

  if (!opts.script || opts.script.trim().length < 80)
    return fallback || opts.topic;
  const script = opts.script;

  try {
    const raw = await aiCall("llm", "thumbnail concept LLM", () =>
      chatComplete({
        system:
          "You are an art director who designs YouTube thumbnails. You answer with the visual concept ONLY — one vivid sentence, no preamble, no quotes.",
        user: `Read this narration script and describe the SINGLE most striking, click-worthy visual moment it contains — the image a viewer must see to want the story. Concrete subject + action + setting + mood. Under 40 words. One clear focal subject with strong emotion and contrast. NEVER describe charts, graphs, text, numbers or interfaces — image models render those as garbled gibberish; pick a physical human moment instead.

Topic: "${opts.topic}"

SCRIPT:
${script.slice(0, 4000)}`,
      }),
    );
    const concept = raw.replace(/^["'\s]+|["'\s]+$/g, "").trim();
    return concept.length > 10 ? concept.slice(0, 400) : fallback || opts.topic;
  } catch {
    return fallback || opts.topic;
  }
}

export async function generateThumbnail(opts: {
  title: string;
  topic: string;
  style: string;
  videoId: string;
  variant?: boolean;
  concept?: string | null;
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

  const concept = (opts.concept ?? "").trim();
  const scenePrompt = concept
    ? `YouTube video thumbnail depicting this exact moment from the video's story: ${concept}. (Video title: "${opts.title}"). ${stylePrompt}. Wide 16:9 cinematic frame, extremely detailed, ONE dominant focal subject filling the frame with strong emotion or tension, high contrast between subject and background, eye-catching composition built for high click-through rate, professional color grading, storytelling composition that teases the story's central conflict. Absolutely no text, no letters, no numbers, no charts, no graphs, no readable writing, no watermarks.`
    : `YouTube video thumbnail about "${opts.topic}". ${stylePrompt}. Wide 16:9 cinematic frame, extremely detailed, ONE dominant focal subject filling the frame with strong emotion or tension, high contrast between subject and background, eye-catching composition built for high click-through rate, professional color grading. The host character is the single focal point. Absolutely no text, no letters, no numbers, no charts, no graphs, no readable writing, no watermarks.`;

  const { readPortrait, characterSceneFragment } = await import("./characters");
  const portrait = opts.character?.id ? await readPortrait(opts.character.id) : null;

  let buffer: Buffer | null = null;
  if (opts.character && portrait && (await imageEditSupported())) {
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
      { attempts: 4, baseDelayMs: 5000 },
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
      { attempts: 4, baseDelayMs: 5000 },
    );
  }

  if (buffer.length < 1000) throw new Error("Generated image is empty");

  const fileName = opts.variant ? `variant-${opts.style}.png` : "thumbnail.png";
  await storage.put(`${opts.videoId}/${fileName}`, buffer);

  return { fileBytes: buffer.length, fileName };
}

export function pickVariantStyles(primaryStyle: string, count = 3): string[] {
  const ids: string[] = THUMB_STYLES.map((s) => s.id);
  const styles: string[] = [ids.includes(primaryStyle) ? primaryStyle : ids[0]];
  for (const id of ids) {
    if (styles.length >= count) break;
    if (!styles.includes(id)) styles.push(id);
  }
  return styles;
}

export async function readMedia(
  videoId: string,
  kind: "voiceover.wav" | "thumbnail.png" | `variant-${string}.png`,
) {
  const s = await storage.stat(`${videoId}/${kind}`);
  if (!s) return null;
  return storage.get(`${videoId}/${kind}`);
}

export async function listVariants(
  videoId: string,
): Promise<{ style: string; fileName: string }[]> {
  if (storageDriverKind() === "local") {
    const dir = path.join(scratchDir(videoId));
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => /^variant-[\w-]+\.png$/.test(f))
      .map((f) => ({
        style: f.replace("variant-", "").replace(".png", ""),
        fileName: f,
      }))
      .sort((a, b) => a.style.localeCompare(b.style));
  }
  const out: { style: string; fileName: string }[] = [];
  for (const style of VARIANT_PROBE_STYLES) {
    if (await storage.exists(`${videoId}/variant-${style}.png`)) {
      out.push({ style, fileName: `variant-${style}.png` });
    }
  }
  return out.sort((a, b) => a.style.localeCompare(b.style));
}

const VARIANT_PROBE_STYLES = [
  "cinematic",
  "bold",
  "minimal",
  "retro",
  "playful",
  "documentary",
];

export async function promoteVariant(videoId: string, style: string) {
  const key = `${videoId}/variant-${style}.png`;
  if (!(await storage.exists(key)))
    throw new Error(`No variant for style "${style}"`);
  const buf = await storage.get(key);
  await storage.put(`${videoId}/thumbnail.png`, buf);
}

export interface ResearchResult {
  ideas: ResearchIdea[];
  nicheSummary: string;
}

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
      "viralScore": 0-100 integer estimating click + share potential",
      "suggestedLength": "one of: short, medium, long",
      "why": "one punchy sentence on why viewers will click and stay"
    }
  ]
}`,
    }),
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
          Math.min(100, Math.round(Number(idea.viralScore ?? 70) || 70)),
        ),
        suggestedLength: String(idea.suggestedLength ?? "medium").trim(),
        why: String(idea.why ?? "").trim(),
      }))
    : [];

  const valid = ideas.filter((i: ResearchIdea) => i.title && i.angle);
  if (valid.length === 0)
    throw new Error(
      "Research returned no usable ideas — try a different query",
    );

  return {
    ideas: valid.slice(0, 8),
    nicheSummary: String(parsed.nicheSummary ?? "").trim(),
  };
}