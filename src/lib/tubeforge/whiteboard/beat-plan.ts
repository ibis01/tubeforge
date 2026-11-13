// W2 — the Whiteboard semantic beat compiler (the reconciliation §9 W2).
//
// The fill law (timing.ts scheduleScene) schedules every drawable in
// PLACEMENT order across the narration window — nothing knows WHAT the
// narrator is saying while a stroke lands. This module is the semantic
// layer the reconciliation ordered: the narration is split into sentences,
// each sentence is classified (setup / subject / action / support /
// emphasis) from cue rules, the scene's placements are matched to the
// sentence that introduces them, and the match compiles into plain
// `AnimationEvent[]` — the doc's existing rows, ZERO grammar growth.
//
// Laws this module keeps:
//   - COMPILE-ONLY (decision §10.1): beats are a planning artifact. They
//     never ride the doc, never reach the validator, never grow the S87
//     grammar — they exist long enough to become events and die.
//   - THE PRECEDENCE LAW (timing.ts:57-58): explicit events are SENIOR.
//     Compiled work only fills what the author's events have not claimed,
//     with the exact claimed-key grammar the fill law uses.
//   - ORDER IS SENIOR TO MATCHING: a placement is never scheduled before
//     an earlier-ordered placement. The author's/planner's `order` field
//     is semantic intent; the beat layer aligns TIMING to the narration
//     within that constraint (monotonic assignment), it does not overrule.
//   - EVERY BEAT HAS AN ACTION: a placement joins a beat only when it
//     carries unclaimed drawable work; a beat with no work never exists.
//   - THE FILL LAW IS THE FALLBACK: no usable beat plan → the caller gets
//     scheduleScene's output byte-for-byte. A beat plan that degenerates
//     (no matches, no drawables, no sentences) never renders differently
//     from today.
//   - PURE AND DETERMINISTIC: same scene + duration + tags + geometry →
//     the same events, byte-for-byte (the S64 law extends here). No clock,
//     no randomness, no fs.
//
// The timing envelope reuses the house constants (LEAD_IN_MS, HOLD_END_MS,
// PATH_GAP_MS, the stroke clamps, the text char model) — ONE scheduler's
// arithmetic, two entry shapes (design §1's law: never a second
// implementation of the schedule math).
import {
  HOLD_END_MS,
  LEAD_IN_MS,
  MAX_PATH_MS,
  MIN_PATH_MS,
  MS_PER_CHAR,
  PATH_GAP_MS,
  TEXT_CHARS_BY_ID,
  TEXT_IDS_BY_ASSET,
  anchorEnvelope,
  scheduleScene,
  type AssetGeometry,
  type WordAnchors,
} from "./timing";
import { totalLength } from "./svg";
import type { AnimationEvent, WhiteboardScene } from "./storyboard";

// ---------------------------------------------------------------------------
// The beat — the planning artifact (never persisted; compiles to events)
// ---------------------------------------------------------------------------

/** Why a beat exists in the narration. The reconciliation's W2 taxonomy:
 *  sentence type + keywords + punctuation → purpose. */
export type BeatPurpose = "setup" | "subject" | "action" | "support" | "emphasis";

/** One semantic beat: a narration sentence, the window it owns inside the
 *  scene's clock, and the placements the narrator introduces during it.
 *  `assetIds` are in placement order (the order-monotonic law). */
export interface WhiteboardBeat {
  /** Stable id: `beat-<sentence index + 1>` — cited by the pins. */
  id: string;
  purpose: BeatPurpose;
  /** 0-based index of the beat's sentence in splitSentences(narration). */
  sentence: number;
  /** The sentence itself (trimmed). */
  phrase: string;
  /** Placements assigned to this beat, in placement order. */
  assetIds: string[];
  /** The beat's window inside the scene clock (ms). Windows are
   *  word-proportional slices of the draw span; for any clock the
   *  estimator can produce (≥ 4 s) the last window ends at
   *  durationMs − HOLD_END_MS exactly like the fill law's draw budget. */
  startMs: number;
  endMs: number;
}

// ---------------------------------------------------------------------------
// Sentence segmentation — the one split the LLM beat normalization shares
// (llm-planner.ts imports this — one source).
// ---------------------------------------------------------------------------

/** Split narration into sentences: terminate on . ! ? (keeping the
 *  punctuation — and any trailing quotes/brackets — attached), collapse
 *  whitespace, drop empties. Text without terminal punctuation is ONE
 *  sentence. Deterministic. */
export function splitSentences(narration: string): string[] {
  const text = narration.replace(/\s+/g, " ").trim();
  if (!text) return [];
  const parts = text.split(/(?<=[.!?]["')\]]*)\s+/);
  const out = parts.map((s) => s.trim()).filter(Boolean);
  return out.length > 0 ? out : [text];
}

function words(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9']+/).filter(Boolean);
}

// ---------------------------------------------------------------------------
// The cue rules — sentence classification + asset mention matching
// ---------------------------------------------------------------------------

/** Sentence-purpose cues, checked in order (emphasis wins over everything:
 *  an exclamation or a stakes phrase owns its sentence). Index 0 defaults
 *  to setup when nothing stronger fires — the opener IS the setup. */
const EMPHASIS_RE = /[!]|\b(key|crucial|critical|most important|remember|the trick|the whole point|never forget)\b/i;
const SETUP_RE = /\b(imagine|picture|let's|lets|consider|suppose|first(ly)?|to start|to begin|welcome|what (if|is|are|do|does|did)|how (do|does|did)|why (do|does|did))\b/i;
const SUBJECT_RE = /\b(is|are|means|refers?|called|known as|defined as|represents|stands for)\b/i;
const ACTION_RE = /\b(then|next|after|now|push(es|ed)?|flows?|moves?|sends?|draws?|writes?|adds?|takes?|turns?|becomes?|starts?|begins?|runs?|grows?|rises?|falls?|beats?|pumps?|launch(es|ed)?)\b/i;

function classifySentence(sentence: string, index: number): BeatPurpose {
  if (EMPHASIS_RE.test(sentence)) return "emphasis";
  if (SETUP_RE.test(sentence)) return "setup";
  if (SUBJECT_RE.test(sentence)) return "subject";
  if (ACTION_RE.test(sentence)) return "action";
  if (index === 0) return "setup";
  return "support";
}

/** Concept cue table — WHAT the narrator is mentioning, keyed by the
 *  built-in concept ids. Mirrors the scaffold planner's KEYWORD_PICKS
 *  (whiteboard-planner.ts) semantics: the planner picks the asset FROM the
 *  narration, the beat layer places it AT the narration. */
const ASSET_CUES: ReadonlyMap<string, RegExp> = new Map([
  ["coin", /\b(money|dollar|cost|price|revenue|budget|profit|paid|expensive|cheap|cash|pay)\b/i],
  ["arrow-growth", /\b(grow|growth|increase|rise|trend|boost|scale|higher|compound)\b/i],
  ["bar-chart", /\b(data|chart|stat|percent|metric|measure|number|graph)\b/i],
  ["lightbulb", /\b(idea|innovate|innovation|invent|insight|think|creative)\b/i],
  ["globe", /\b(world|global|internet|country|countries|international|online)\b/i],
  ["clock", /\b(time|deadline|schedule|minute|hour|fast|slow|wait)\b/i],
  ["rocket", /\b(launch|start|begin|first|pilot|ship|release)\b/i],
  ["check-badge", /\b(check|verify|correct|right|proven|safe|quality|benefit|advantage)\b/i],
]);

/** The scaffold-grammar cards: the title owns the opening sentence, the
 *  close card owns the last one — the same grammar the native planner
 *  places them with (first/last placement). */
const CARD_FIRST = new Set(["title-hero"]);
const CARD_LAST = new Set(["close-card"]);

/** Tag-token stopwords: palette noise that would match every sentence. */
const TAG_STOPWORDS = new Set([
  "and", "the", "for", "with", "this", "that", "from", "into",
  "upload", "svg", "icon", "symbol", "concept", "drawing", "illustration",
  "white", "black", "simple", "flat", "line", "art", "outline", "style",
]);

function tagTokens(tags: readonly string[] | undefined): string[] {
  if (!tags) return [];
  const out: string[] = [];
  for (const t of tags) {
    for (const w of t.toLowerCase().split(/[^a-z0-9]+/)) {
      if (w.length >= 3 && !TAG_STOPWORDS.has(w)) out.push(w);
    }
  }
  return out;
}

/** Score how strongly a sentence introduces an asset: a cue-table hit is
 *  the strongest signal (the planner's own vocabulary), tag overlap is the
 *  generic signal (uploads, the benchmark library), silence scores 0. */
function mentionScore(
  sentenceTokens: string[],
  sentence: string,
  assetId: string,
  tags: readonly string[] | undefined
): number {
  let score = 0;
  const cue = ASSET_CUES.get(assetId);
  if (cue && cue.test(sentence)) score += 2;
  const tokens = new Set(sentenceTokens);
  for (const t of tagTokens(tags)) if (tokens.has(t)) score += 1;
  return score;
}

// ---------------------------------------------------------------------------
// planBeats — narration → beats (windows + assignments)
// ---------------------------------------------------------------------------

/** Floor per-sentence weight: a three-word beat still gets a readable
 *  slice of the draw span (4 words ≈ 1.5 s of narration at the house
 *  2.6-wps pace). */
const MIN_BEAT_WORDS = 4;

/** The draw span's floor — the same envelope the fill law applies
 *  (timing.ts:102: `Math.max(1200, …)`), so a beat plan and the fill law
 *  agree on where drawing can live inside ANY scene clock. */
const MIN_DRAW_SPAN_MS = 1200;

export interface PlanBeatsOptions {
  durationMs: number;
  /** The scene's geometry — which placements still carry unclaimed
   *  drawable work (a fully-claimed placement never joins a beat: the
   *  precedence law decides, not the matcher). */
  geometry: Map<string, AssetGeometry>;
  /** Per-asset library tags (id → tags). Optional: absent tags degrade the
   *  matcher to the cue table + the cards + deterministic grouping — the
   *  plan still compiles, just with less vocabulary. */
  assetTags?: ReadonlyMap<string, readonly string[]>;
  /** W4: the captions lane's per-word spoken spans — an INPUT, never a
   *  doc field. When the anchor count matches the narration's word
   *  tokenization, each sentence's window IS its words' spoken span (the
   *  strokes land on the clock the VO actually spoke); a mismatch
   *  degrades to the word-proportional estimator byte-for-byte. */
  anchors?: WordAnchors;
}

/** The exact claimed-key grammar the fill law uses (timing.ts:66-70). */
function claimedKeys(scene: WhiteboardScene): Set<string> {
  const claimed = new Set<string>();
  for (const e of scene.animations) {
    if (e.type === "draw_path") claimed.add(`${e.assetId}::${e.pathId}`);
    else if (e.type === "write_text") claimed.add(`${e.assetId}::text:${e.textId}`);
  }
  return claimed;
}

/** Whether a placement still carries drawable work the beat layer may
 *  schedule (unclaimed paths or texts). */
function hasUnclaimedWork(
  assetId: string,
  scene: WhiteboardScene,
  geometry: Map<string, AssetGeometry>,
  claimed: Set<string>
): boolean {
  const geo = geometry.get(assetId);
  if (geo) {
    for (const pathId of geo.paths.keys()) {
      if (!claimed.has(`${assetId}::${pathId}`)) return true;
    }
  }
  const texts = TEXT_IDS_BY_ASSET.get(assetId) ?? [];
  for (const textId of texts) {
    if (!claimed.has(`${assetId}::text:${textId}`)) return true;
  }
  return false;
}

/**
 * Plan the scene's beats. PURE. Returns [] when the plan degenerates —
 * no sentences, no unclaimed drawables, a clock too short to beat — and
 * the caller falls back to the fill law (the fallback-renders law).
 *
 * Assignment: placements are visited in ORDER (the fill law's own sort:
 * the `order` field, ties by array position — stable, deterministic).
 * Each placement joins the best-scoring sentence at or AFTER the previous
 * placement's sentence (the order-monotonic law): title text draws with
 * the opening sentence, the coin draws when the narrator says "money",
 * labels ride the sentence that names them — but never ahead of an
 * earlier-ordered placement. Unmatched placements stay grouped at the
 * cursor.
 */
export function planBeats(
  scene: WhiteboardScene,
  opts: PlanBeatsOptions
): WhiteboardBeat[] {
  const sentences = splitSentences(scene.narration);
  if (sentences.length === 0) return [];
  if (!(opts.durationMs > 0)) return [];

  const claimed = claimedKeys(scene);
  const placements = [...scene.placements]
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .filter((pl) => hasUnclaimedWork(pl.assetId, scene, opts.geometry, claimed));
  if (placements.length === 0) return [];

  const sentenceTokens = sentences.map((s) => words(s));

  // Assign every work-carrying placement to a sentence (order-monotonic,
  // best mention wins; ties → the earliest sentence).
  const bySentence = new Map<number, string[]>();
  let cursor = 0;
  for (const pl of placements) {
    let target: number;
    if (CARD_FIRST.has(pl.assetId)) {
      target = 0;
    } else if (CARD_LAST.has(pl.assetId)) {
      target = sentences.length - 1;
    } else {
      target = cursor;
      let best = 0;
      for (let i = cursor; i < sentences.length; i++) {
        const score = mentionScore(
          sentenceTokens[i],
          sentences[i],
          pl.assetId,
          opts.assetTags?.get(pl.assetId)
        );
        if (score > best) {
          best = score;
          target = i;
        }
      }
    }
    target = Math.min(Math.max(target, cursor), sentences.length - 1);
    const bucket = bySentence.get(target) ?? [];
    bucket.push(pl.assetId);
    bySentence.set(target, bucket);
    cursor = Math.max(cursor, target);
  }
  if (bySentence.size === 0) return [];

  // W4 — the windows. Two sources, one law:
  //   aligned anchors → each sentence's window is its words' spoken span
  //   (the clock the VO actually spoke; the hold extends to the scene
  //   clock's edge);
  //   absent / mismatched / degenerate → the word-proportional estimator
  //   across the fill law's envelope ([LEAD_IN, duration − HOLD]),
  //   byte-for-byte the W2 behavior. Anchors are advisory inputs — a
  //   misheard ASR pass degrades, it never corrupts the choreography.
  const narrationWords = sentences.map((s) => words(s));
  const flatWordCount = narrationWords.reduce((a, w) => a + w.length, 0);
  const env = anchorEnvelope(opts.anchors, opts.durationMs);
  const sortedWords =
    opts.anchors && env ? [...opts.anchors.byWord].sort((a, b) => a.index - b.index) : null;
  let windows: { startMs: number; endMs: number }[] | null = null;
  if (sortedWords && sortedWords.length === flatWordCount) {
    const candidate: { startMs: number; endMs: number }[] = [];
    let off = 0;
    let sane = true;
    for (const toks of narrationWords) {
      const first = sortedWords[off];
      const last = sortedWords[off + toks.length - 1];
      off += toks.length;
      if (!first || !last || last.endMs <= first.startMs) {
        sane = false;
        break;
      }
      candidate.push({ startMs: Math.round(first.startMs), endMs: Math.round(last.endMs) });
    }
    // Windows must march forward (weird ASR spans never reorder the beats).
    for (let i = 1; sane && i < candidate.length; i++) {
      if (candidate[i].startMs < candidate[i - 1].endMs) sane = false;
    }
    if (sane) windows = candidate;
  }
  if (!windows) {
    // Word-proportional windows across the draw span (the fill law's
    // envelope: [LEAD_IN, duration − HOLD], floored — timing.ts:102).
    const weights = sentences.map((s) => Math.max(words(s).length, MIN_BEAT_WORDS));
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const drawSpan = Math.max(MIN_DRAW_SPAN_MS, opts.durationMs - LEAD_IN_MS - HOLD_END_MS);
    let t = LEAD_IN_MS;
    windows = weights.map((w) => {
      const start = t;
      t += (w / totalWeight) * drawSpan;
      return { startMs: Math.round(start), endMs: Math.round(t) };
    });
  }

  const beats: WhiteboardBeat[] = [];
  for (const [sentence, assetIds] of bySentence) {
    const window = windows[sentence];
    beats.push({
      id: `beat-${sentence + 1}`,
      purpose: classifySentence(sentences[sentence], sentence),
      sentence,
      phrase: sentences[sentence],
      assetIds,
      startMs: window.startMs,
      endMs: window.endMs,
    });
  }
  return beats.sort((a, b) => a.sentence - b.sentence);
}

// ---------------------------------------------------------------------------
// compileBeats — beats → AnimationEvent[] (the doc's existing grammar)
// ---------------------------------------------------------------------------

/**
 * Compile a beat plan into the scene's event list: the author's explicit
 * events pass through untouched (senior — the precedence law), every beat
 * fills its window with the unclaimed drawables of its placements, using
 * the fill law's own arithmetic (weight = scaled stroke length / text
 * char count; per-item clamps; the stroke gap; a uniform fit factor).
 * An item never outlasts the scene clock. PURE.
 */
export function compileBeats(
  beats: WhiteboardBeat[],
  scene: WhiteboardScene,
  durationMs: number,
  geometry: Map<string, AssetGeometry>
): AnimationEvent[] {
  const events: AnimationEvent[] = [...scene.animations];
  const claimed = claimedKeys(scene);

  for (const beat of beats) {
    interface Item {
      kind: "path" | "text";
      assetId: string;
      id: string;
      weight: number;
    }
    const items: Item[] = [];
    for (const assetId of beat.assetIds) {
      const geo = geometry.get(assetId);
      if (geo) {
        const scale = scene.placements.find((pl) => pl.assetId === assetId)?.placement.scale ?? 1;
        for (const [pathId, segs] of geo.paths) {
          if (claimed.has(`${assetId}::${pathId}`)) continue;
          items.push({ kind: "path", assetId, id: pathId, weight: Math.max(120, totalLength(segs) * scale) });
        }
      }
      const texts = TEXT_IDS_BY_ASSET.get(assetId) ?? [];
      for (const textId of texts) {
        if (claimed.has(`${assetId}::text:${textId}`)) continue;
        const chars = TEXT_CHARS_BY_ID.get(`${assetId}::${textId}`) ?? 12;
        items.push({ kind: "text", assetId, id: textId, weight: 40 * chars });
      }
    }
    if (items.length === 0) continue; // the every-beat-has-an-action law

    // The fill law's arithmetic, scoped to the beat window.
    const gaps = PATH_GAP_MS * (items.length - 1);
    const avail = Math.max(120, beat.endMs - beat.startMs - gaps);
    const totalWeight = items.reduce((a, w) => a + w.weight, 0);
    let rawSum = 0;
    const raw = items.map((w) => {
      const ideal = (w.weight / totalWeight) * avail;
      const d =
        w.kind === "path"
          ? Math.max(MIN_PATH_MS, Math.min(MAX_PATH_MS, ideal))
          : Math.max(500, (TEXT_CHARS_BY_ID.get(`${w.assetId}::${w.id}`) ?? 12) * MS_PER_CHAR);
      rawSum += d;
      return d;
    });
    const f = rawSum > 0 ? Math.min(2.8, Math.max(0.5, avail / rawSum)) : 1;
    let t = beat.startMs;
    for (let i = 0; i < items.length; i++) {
      const w = items[i];
      // Never outlast the scene clock (the hold is the window's own edge).
      const dur = Math.max(120, Math.min(Math.round(raw[i] * f), Math.max(120, durationMs - t)));
      if (w.kind === "path") {
        events.push({ type: "draw_path", assetId: w.assetId, pathId: w.id, startMs: Math.round(t), durationMs: dur });
        claimed.add(`${w.assetId}::${w.id}`);
      } else {
        events.push({ type: "write_text", assetId: w.assetId, textId: w.id, startMs: Math.round(t), durationMs: dur });
        claimed.add(`${w.assetId}::text:${w.id}`);
      }
      t += dur + PATH_GAP_MS;
    }
  }
  return events.sort((a, b) => a.startMs - b.startMs);
}

// ---------------------------------------------------------------------------
// beatSceneEvents — the seam the render and the editor preview share
// ---------------------------------------------------------------------------

/**
 * The W2 scheduling entry point, consumed by BOTH the renderer
 * (render.ts) and the editor preview (wb-canvas.tsx) — the one-source
 * law: same inputs, same beats, same frames on both surfaces.
 *
 * Plan → compile; a degenerate plan (no beats, no compiled work beyond
 * the author's events) falls back to `scheduleScene` BYTE-FOR-BYTE — the
 * fallback-renders law. When the plan is usable, explicit events stay
 * senior inside compileBeats and the compiled fills ride the narration's
 * windows.
 */
export function beatSceneEvents(
  scene: WhiteboardScene,
  durationMs: number,
  geometry: Map<string, AssetGeometry>,
  assetTags?: ReadonlyMap<string, readonly string[]>,
  anchors?: WordAnchors
): AnimationEvent[] {
  const fallback = () => scheduleScene(scene, durationMs, geometry, anchors);
  if (!(durationMs > 0)) return fallback();
  const beats = planBeats(scene, { durationMs, geometry, assetTags, anchors });
  if (beats.length === 0) return fallback();
  const events = compileBeats(beats, scene, durationMs, geometry);
  // A usable plan always adds the unclaimed work; an empty list here is
  // the degenerate corner (nothing drawable at all) — the fill law's
  // output would be identical, so either path agrees. Take the fallback
  // for one-source consistency.
  if (events.length === 0) return fallback();
  return events;
}
