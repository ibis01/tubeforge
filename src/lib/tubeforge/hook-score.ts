// S70 — Creator Intelligence CI-1: Hook & Script Intelligence.
//
// From the decision record (docs/audits/creator-intelligence-record.md §3):
// generate N candidate openers, panel-score them (deterministic properties
// — specificity, tension, promise — plus an LLM judge with strict-JSON
// output), mark retention beats on the chosen script, and verify the
// opening delivers the title's promise. The rehook map stays the
// structural spine (story.ts's isRehookPosition) — CI-1 marks beats, it
// never rewrites pacing.
//
// The adopted honesty doctrine (the record's "best idea in the repo"):
// EVERY score this module emits carries `heuristic: true` — a heuristic,
// never a predictor. Missing data is asked for, never invented.
//
// Layering: the deterministic half is PURE (unit-pinned); the LLM half
// rides the llm.ts seam through budget.ts's single choke point
// (aiCall) — provider-independent, budget-capped, and it FAILS READABLE
// (the panel endpoint degrades to score-only, never to invented numbers).
import { aiCall } from "./budget";
import { llmChat } from "./llm";
import { parseJsonLoose } from "./ai";
import { isRehookPosition } from "./story";

// ---------------------------------------------------------------------------
// The deterministic scorer — specificity / tension / promise (0-100 each)
// ---------------------------------------------------------------------------

export interface HookHeuristicScore {
  /** 0-100 — concrete nouns, numbers, named specifics. */
  specificity: number;
  /** 0-100 — stakes, negation, contrarian angles. */
  tension: number;
  /** 0-100 — a payoff the viewer can expect ("how", "why", "you"). */
  promise: number;
  /** 0-100 weighted blend (50/30/20). */
  total: number;
  /** The signals that fired, in plain words (the evidence, not a vibe). */
  notes: string[];
  /** The doctrine: a heuristic, never a predictor. */
  heuristic: true;
}

/** Vague words dilute specificity; tension words raise stakes. Both lists
 *  are deliberately short — precision beats coverage on a heuristic. */
const VAGUE_WORDS = new Set([
  "things", "stuff", "ways", "tips", "hacks", "secrets", "amazing", "incredible",
  "awesome", "ultimate", "best", "top", "simple", "easy", "powerful", "crazy",
]);
const TENSION_WORDS = new Set([
  "never", "nobody", "stop", "wrong", "mistake", "avoid", "before", "fails",
  "why", "hidden", "truth", "actually", "but", "until", "nobody",
]);
const PROMISE_MARKERS = /\b(how|why|what|learn|understand|fix|build|master|explain)\b/i;
const SECOND_PERSON = /\b(you|your|you're|youre)\b/i;

function wordList(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\s']/g, " ").split(/\s+/).filter(Boolean);
}

/** The pure hook scorer — the panel's deterministic anchor. */
export function scoreHookHeuristic(hook: string): HookHeuristicScore {
  const notes: string[] = [];
  const words = wordList(hook);

  // Specificity: digits, multi-digit numbers, capitalized mid-sentence
  // tokens (proper nouns), and a LACK of vague filler.
  const digits = (hook.match(/\d/g) ?? []).length;
  const properNouns = (hook.match(/\b[A-Z][a-z]{2,}/g) ?? []).filter(
    (w, i) => i > 0 || !/^[A-Z][a-z]+$/.test(w) // ignore a leading sentence-case word
  ).length;
  const vague = words.filter((w) => VAGUE_WORDS.has(w)).length;
  let specificity = 20 + Math.min(40, digits * 8) + Math.min(30, properNouns * 15) - vague * 15;
  if (digits > 0) notes.push("carries a number (specific)");
  if (properNouns > 0) notes.push("names a specific thing");
  if (vague > 0) notes.push(`${vague} vague filler word${vague === 1 ? "" : "s"} (things/ways/secrets-class)`);

  // Tension: stakes + negation + contrarian angles.
  const tense = words.filter((w) => TENSION_WORDS.has(w)).length;
  const question = hook.trim().endsWith("?") ? 1 : 0;
  let tension = 15 + Math.min(70, tense * 22) + question * 12;
  if (tense > 0) notes.push("stakes/negation language present");
  if (question) notes.push("opens a question the viewer wants closed");

  // Promise: a payoff marker + second person + length discipline (a hook
  // that rambles past ~90 chars stops being a hook).
  let promise = 10;
  if (PROMISE_MARKERS.test(hook)) {
    promise += 40;
    notes.push("promises an explanation or a skill");
  }
  if (SECOND_PERSON.test(hook)) {
    promise += 25;
    notes.push("addresses the viewer directly");
  }
  const len = hook.trim().length;
  if (len >= 25 && len <= 90) {
    promise += 25;
  } else if (len > 90) {
    promise -= 15;
    notes.push("runs long — the first clause should carry the hook");
  } else {
    promise -= 10;
    notes.push("very short — no room for a promise");
  }

  // Clarity penalties: ALL-CAPS runs and stacked punctuation read as
  // shouting, not tension.
  const capsRuns = (hook.match(/\b[A-Z]{4,}\b/g) ?? []).length;
  const bangs = (hook.match(/!/g) ?? []).length;
  if (capsRuns > 0) {
    specificity -= capsRuns * 10;
    notes.push("ALL-CAPS run (shouting reads as noise)");
  }
  if (bangs > 1) {
    tension -= (bangs - 1) * 10;
    notes.push("stacked exclamation marks");
  }
  // An empty hook is not a hook.
  if (words.length < 2) {
    notes.push("too few words to score");
    return { specificity: 0, tension: 0, promise: 0, total: 0, notes, heuristic: true };
  }

  specificity = Math.max(0, Math.min(100, Math.round(specificity)));
  tension = Math.max(0, Math.min(100, Math.round(tension)));
  promise = Math.max(0, Math.min(100, Math.round(promise)));
  const total = Math.round(specificity * 0.5 + tension * 0.3 + promise * 0.2);
  if (notes.length === 0) notes.push("no strong signal either way — a middling hook");
  return { specificity, tension, promise, total, notes, heuristic: true };
}

// ---------------------------------------------------------------------------
// The panel — LLM generation + judge, deterministically anchored
// ---------------------------------------------------------------------------

export interface HookCandidate {
  text: string;
  /** The formula family the candidate uses (the taxonomy's name for it). */
  formula: string;
  score: HookHeuristicScore;
  /** 0-100 from the LLM judge, when the judge ran. */
  judgeScore?: number;
  judgeVerdict?: string;
  /** The panel's blended rank (0.6 deterministic + 0.4 judge). */
  panelScore: number;
}

export interface HookPanel {
  candidates: HookCandidate[];
  /** The panel's pick — a PROPOSAL. Applying it is the user's click. */
  winner: HookCandidate | null;
  /** True when the LLM judge contributed (false = deterministic only). */
  judged: boolean;
  heuristic: true;
}

const GENERATE_PROMPT = `You write YouTube hook lines (the opening sentence of a video). You are given a video's topic, niche, tone, and script excerpt. Generate CANDIDATE HOOKS from DIFFERENT formula families — e.g. Question Hook, Bold Claim, Contrarian Take, Number/List Promise, Story Cold-Open, Curiosity Gap, Warning/Stakes, Direct Address, Myth-Bust, Before/After. Output STRICT JSON:

{
  "hooks": [
    { "formula": "<family name>", "text": "<=90 chars, one sentence, no quotes, no emoji>" }
  ]
}

Rules: 5 distinct families, no two candidates from the same family. Never wrap in markdown fences. Never add commentary.`;

const JUDGE_PROMPT = `You are a strict YouTube hook judge. For each candidate hook, given the video's topic, score it 0-100 for how well it would stop a scroll AND honestly represent the content (a lie scores 0), and write a one-line verdict. Output STRICT JSON:

{
  "scores": [
    { "text": "<the hook verbatim>", "score": <0-100>, "verdict": "<=120 chars" }
  ]
}

Never wrap in markdown fences. Never add commentary.`;

function clampHookText(s: string): string {
  return s.replace(/["“”]/g, "'").replace(/\s+/g, " ").trim().slice(0, 120);
}

/** Generate + panel-score N candidate openers. The deterministic score
 *  anchors every candidate; the LLM judge adds its read when the gateway
 *  cooperates (judged: false = deterministic-only, honestly labeled). */
export async function generateHookPanel(opts: {
  topic: string;
  niche: string;
  tone: string;
  scriptExcerpt?: string;
  candidates?: number;
}): Promise<HookPanel> {
  const want = Math.max(2, Math.min(8, opts.candidates ?? 5));
  const userPrompt = [
    `Topic: ${opts.topic}`,
    `Niche: ${opts.niche}`,
    `Tone: ${opts.tone}`,
    opts.scriptExcerpt ? `Script excerpt:\n${opts.scriptExcerpt.slice(0, 1600)}` : "Script excerpt: (unavailable — work from the topic)",
    `Generate ${want} candidate hooks.`,
    "Output the STRICT JSON now.",
  ].join("\n\n");

  const completion = await aiCall("llm", "hook panel generation", () =>
    llmChat({
      messages: [
        { role: "system", content: GENERATE_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.8,
    })
  );
  const text = completion.choices?.[0]?.message?.content ?? "";
  const parsed = parseJsonLoose(text);
  const rawHooks = Array.isArray(parsed.hooks) ? parsed.hooks : [];
  const seen = new Set<string>();
  const candidates: HookCandidate[] = [];
  for (const h of rawHooks) {
    const t = clampHookText(String((h as Record<string, unknown>)?.text ?? ""));
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    candidates.push({
      text: t,
      formula: String((h as Record<string, unknown>)?.formula ?? "hook").slice(0, 40),
      score: scoreHookHeuristic(t),
      panelScore: 0,
    });
    if (candidates.length >= want) break;
  }
  if (candidates.length === 0)
    throw new Error("The model returned no usable hook candidates — try again");

  // The judge — optional by design: a gateway hiccup degrades the panel to
  // deterministic-only instead of failing the whole request.
  let judged = false;
  try {
    const judgeCompletion = await aiCall("llm", "hook panel judge", () =>
      llmChat({
        messages: [
          { role: "system", content: JUDGE_PROMPT },
          {
            role: "user",
            content: `Topic: ${opts.topic}\n\nCandidates:\n${candidates
              .map((c, i) => `${i + 1}. ${c.text}`)
              .join("\n")}\n\nOutput the STRICT JSON now.`,
          },
        ],
        temperature: 0.2,
      })
    );
    const jText = judgeCompletion.choices?.[0]?.message?.content ?? "";
    const jParsed = parseJsonLoose(jText);
    const scores = Array.isArray(jParsed.scores) ? jParsed.scores : [];
    for (const s of scores) {
      const row = s as Record<string, unknown>;
      const t = clampHookText(String(row?.text ?? ""));
      const match = candidates.find((c) => c.text.toLowerCase() === t.toLowerCase());
      const sc = Number(row?.score);
      if (match && Number.isFinite(sc) && sc >= 0 && sc <= 100) {
        match.judgeScore = Math.round(sc);
        match.judgeVerdict = String(row?.verdict ?? "").slice(0, 140);
        judged = true;
      }
    }
  } catch {
    /* judge unavailable — the panel stays deterministic-only */
  }

  for (const c of candidates) {
    c.panelScore = Math.round(
      c.score.total * 0.6 + (c.judgeScore ?? c.score.total) * 0.4
    );
  }
  candidates.sort((a, b) => b.panelScore - a.panelScore);
  return { candidates, winner: candidates[0] ?? null, judged, heuristic: true };
}

// ---------------------------------------------------------------------------
// Retention beats + the title-promise check (both deterministic)
// ---------------------------------------------------------------------------

export interface RetentionBeat {
  /** Scene index (0-based) or word offset — where the beat lands. */
  at: number;
  kind: "hook" | "rehook";
  label: string;
}

/** Mark the retention beats on a script: scene 1 is the hook, then every
 *  3rd scene rehooks — the story engine's own spine (isRehookPosition),
 *  cited, not re-invented. For classic (non-scene) scripts the beats map
 *  onto paragraphs at the same 1-4-7 cadence. */
export function markRetentionBeats(sceneCount: number): RetentionBeat[] {
  const beats: RetentionBeat[] = [];
  for (let i = 0; i < sceneCount; i++) {
    if (i === 0) beats.push({ at: i, kind: "hook", label: "scene 1 — the hook (front-load the payoff promise)" });
    else if (isRehookPosition(i)) beats.push({ at: i, kind: "rehook", label: `scene ${i + 1} — rehook (re-earn the attention every ~3 scenes)` });
  }
  return beats;
}

export interface TitlePromiseCheck {
  delivers: boolean;
  /** Title terms the opening never mentions (the promise gap). */
  missing: string[];
  heuristic: true;
}

const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "your", "you",
  "how", "why", "what", "this", "that", "with", "is", "are", "it", "at", "be",
]);

/** Verify the opening delivers the title's promise: every meaningful title
 *  term should appear in (or be answered by) the opening lines. A missing
 *  concrete term is a promise the video opens on but does not name. */
export function verifyTitlePromise(title: string, opening: string): TitlePromiseCheck {
  const titleTerms = wordList(title).filter((w) => w.length > 3 && !STOPWORDS.has(w));
  const openingLower = opening.toLowerCase();
  const missing = titleTerms.filter((w) => !openingLower.includes(w));
  return {
    delivers: missing.length === 0,
    missing,
    heuristic: true,
  };
}
