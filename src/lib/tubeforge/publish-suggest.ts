// publish-suggest.ts — Stage 6 T-6.5: LLM-driven publish metadata suggestions.
//
// The publish form's title/description/tags are tedious to fill by hand; this
// module asks the LLM to draft them from the video's script + niche + tone.
// The user reviews and edits before clicking Publish — same "AI suggests +
// human approves" doctrine as the Stage 5 AI Director.
//
// The prompt is strict-JSON: one call, three fields. The LLM gets the topic,
// niche, tone, script excerpt (capped to keep the prompt under model context)
// and a list of the scene captions (high-density title-bait material). The
// response is parsed with parseJsonLoose (the same tolerant parser the
// director pass uses) and clamped to YouTube's API limits.

import { aiCall } from "./budget";
import { llmChat } from "./llm";
import { parseJsonLoose } from "./ai";

export type SuggestTone = "clickbait" | "descriptive" | "question" | "curiosity";

export interface PublishSuggestion {
  title: string; // ≤ 100 chars (YouTube limit)
  description: string; // ≤ 4900 chars
  tags: string[]; // ≤ 30 tags, ≤ 80 chars each
}

const TONE_GUIDE: Record<SuggestTone, string> = {
  clickbait:
    "Bold, scroll-stopping, curiosity-gap phrasing. Power words. No clickbait that lies about the content.",
  descriptive:
    "Straightforward, factual, says exactly what the video covers. No hype.",
  question:
    "Frame the title as a question the viewer wants answered.",
  curiosity:
    "Tease the most interesting fact without giving it away. 'Why X does Y' style.",
};

const SYSTEM_PROMPT = `You write YouTube metadata. You are given a video's topic, niche, tone, script excerpt, and per-scene captions. You output STRICT JSON with three fields:

{
  "title": "<=100 chars, no quotes, no emoji, plain text>",
  "description": "<=4900 chars, the first 150 chars become the YouTube search snippet so front-load the hook; include a one-line summary, a 2-3 sentence pitch, and a 'Subscribe for more' line",
  "tags": ["<=30 tags, each <=80 chars, no duplicates, mix broad niche tags and specific topic tags"]
}

Never wrap the JSON in markdown fences. Never add commentary before or after. If the script is short, write a short description — do not pad.`;

function clampTitle(s: string): string {
  return s.replace(/["“”]/g, "'").replace(/\s+/g, " ").trim().slice(0, 100);
}

function clampDescription(s: string): string {
  return s.replace(/\r\n/g, "\n").trim().slice(0, 4900);
}

function clampTags(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of arr) {
    if (typeof tag !== "string") continue;
    const t = tag.trim().slice(0, 80);
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= 30) break;
  }
  return out;
}

/** Suggest publish metadata for a video. The script + scenes are the input;
 *  the LLM's output is clamped to YouTube's limits. Throws a readable error
 *  when the LLM returns junk. */
export async function suggestPublishMeta(opts: {
  topic: string;
  niche: string;
  tone: string;
  script?: string | null;
  sceneCaptions?: string[];
  toneStyle?: SuggestTone;
}): Promise<PublishSuggestion> {
  const toneStyle: SuggestTone = opts.toneStyle ?? "descriptive";
  const scriptExcerpt = (opts.script ?? "").slice(0, 2400);
  const captions = (opts.sceneCaptions ?? []).filter(Boolean).slice(0, 12);
  const userPrompt = [
    `Topic: ${opts.topic}`,
    `Niche: ${opts.niche}`,
    `Tone of the video: ${opts.tone}`,
    `Title style: ${TONE_GUIDE[toneStyle]}`,
    scriptExcerpt ? `Script excerpt:\n${scriptExcerpt}` : "Script excerpt: (unavailable)",
    captions.length ? `Per-scene captions:\n${captions.map((c, i) => `${i + 1}. ${c}`).join("\n")}` : "",
    "Output the STRICT JSON now.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const completion = await aiCall("llm", "publish suggest LLM", () =>
    llmChat({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.7,
    })
  );
  const text = completion.choices?.[0]?.message?.content ?? "";
  const parsed = parseJsonLoose(text);
  const title = clampTitle(typeof parsed.title === "string" ? parsed.title : "");
  const description = clampDescription(typeof parsed.description === "string" ? parsed.description : "");
  const tags = clampTags(parsed.tags);

  if (!title) {
    throw new Error("The model returned no usable title — try again, or write one manually");
  }
  return { title, description, tags };
}
