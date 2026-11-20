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
  tracedSplitForScene,
  type AssetGeometry,
  type WordAnchors,
} from "./timing";
import { WB_TRACED_FADE_MS } from "./trace-budget";
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
  /** S147 — the rhetorical lens (additive, optional; derived in planBeats).
   *  Absent on old plans; nothing render-path consumes `rhetorical` yet. */
  rhetorical?: RhetoricalPurpose;
  /** What the hand does on screen during this beat. */
  action?: BeatAction;
  /** The emphasis level — high beats may fire their mark. */
  emphasis?: BeatEmphasis;
  /** The fx-* asset that punctuates this beat: compileBeats orders its
   *  items LAST (the mark lands after the claim — the W4 law). Absent ⇒
   *  the compiled events are byte-identical to the pre-S147 order. */
  markAssetId?: string;
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

/** The narration tokenizer — the ANCHOR INDEX SPACE's law: the W4 voice
 *  anchors (voice-anchors.ts) index words in exactly this tokenization, so
 *  the beat windows' per-sentence slices line up with the anchor list.
 *  Exported (not duplicated) — one tokenizer, two consumers. */
export function words(s: string): string[] {
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

// S125 (K1) — exported (was module-private): the rig director consumes the
// SAME classifier for its gesture beats ("reusing beat-plan.ts#classifySentence
// instead of duplicating it, one classifier, two consumers" — roadmap §6).
// The cue rules and the precedence below are UNCHANGED; the whiteboard beat
// plan's own outputs are byte-identical.
export function classifySentence(sentence: string, index: number): BeatPurpose {
  if (EMPHASIS_RE.test(sentence)) return "emphasis";
  if (SETUP_RE.test(sentence)) return "setup";
  if (SUBJECT_RE.test(sentence)) return "subject";
  if (ACTION_RE.test(sentence)) return "action";
  if (index === 0) return "setup";
  return "support";
}

// ---------------------------------------------------------------------------
// S147 — the rhetorical layer (the 2026-11-16 layer-upgrade directive's §2):
// the beat gains its RHETORICAL purpose (what the sentence does in the
// argument), its ACTION (what the hand does on screen), and its EMPHASIS
// level — all ADDITIVE optional fields, derived deterministically, compiled
// into the existing AnimationEvent grammar (no second timeline grammar).
// The STRUCTURAL classifier above is UNTOUCHED — the K1 rig director consumes
// it ("one classifier, two consumers") and its outputs stay byte-identical.
// ---------------------------------------------------------------------------

/** Why the sentence exists in the ARGUMENT — the directive's §2 taxonomy.
 *  A second lens on the same sentence: derived from the same cue family as
 *  the structural purpose plus the comparison/evidence/conclusion cues.
 *  Old plans absent the field (the tolerant-read law); nothing consumes it
 *  for rendering yet — the editor and the LLM planner read it. */
export type RhetoricalPurpose =
  | "setup"
  | "claim"
  | "mechanism"
  | "comparison"
  | "evidence"
  | "conclusion";

const CONCLUSION_RE = /\b(in short|in summary|the takeaway|bottom line|ultimately|the point is|never forget|remember this|the whole point|that's why|that is why|in the end|the key insight|the lesson|remember the)\b/i;
const COMPARISON_RE = /\b(better|worse|faster|slower|cheaper|unlike|compared|whereas|instead|rather than|versus|vs\b\.?|more than|less than|the difference)\b/i;
const EVIDENCE_RE = /\b(percent|study|studies|research|survey|measured|statistics|twice|half|double|triple|times)\b|%|\breported\b/i;

/** The rhetorical classifier — PURE, deterministic, same cue-family laws as
 *  classifySentence (checked in order; the last sentence IS the conclusion
 *  slot — the grammar's close card already owns it). */
export function classifyRhetorical(sentence: string, index: number, total: number): RhetoricalPurpose {
  if (total >= 2 && index === total - 1) return "conclusion";
  if (CONCLUSION_RE.test(sentence)) return "conclusion";
  if (COMPARISON_RE.test(sentence)) return "comparison";
  if (EVIDENCE_RE.test(sentence)) return "evidence";
  // The claim outranks the mechanism — the structural classifier's own
  // precedence (subject before action): "The heart IS a pump" is a claim
  // even though it carries the verb-noun "pump".
  if (SUBJECT_RE.test(sentence)) return "claim";
  if (ACTION_RE.test(sentence)) return "mechanism";
  if (SETUP_RE.test(sentence) || index === 0) return "setup";
  return "claim";
}

/** The hand's emphasis level on this beat (the directive's §2 `emphasis`).
 *  High rides the structural emphasis purpose (the cue family that already
 *  owns exclamation + stakes phrases); low is reserved for the editor. */
export type BeatEmphasis = "low" | "normal" | "high";

export function beatEmphasisOf(purpose: BeatPurpose): BeatEmphasis {
  return purpose === "emphasis" ? "high" : "normal";
}

/** What the hand DOES on screen during this beat (the directive's §2
 *  `action`). Derived, never authored: draw/write/hold from the beat's
 *  contents, the mark verbs (underline/circle/crossout) from a placed
 *  fx-* effect on a HIGH-emphasis beat, reveal for a non-mark effect. */
export type BeatAction =
  | "draw"
  | "write"
  | "underline"
  | "circle"
  | "crossout"
  | "reveal"
  | "hold";

/** The effects pack's frozen id prefix (S142) — the mark-capable assets. */
const FX_PREFIX = "fx-";

function markActionOf(fxAssetId: string): BeatAction | undefined {
  if (fxAssetId === "fx-underline") return "underline";
  if (fxAssetId === "fx-circle-mark") return "circle";
  // fx-crossout does not exist yet — the action stays in the vocabulary for
  // the editor and the future slice; the other effects punctuate (reveal).
  return "reveal";
}

function beatActionOf(
  assetIds: readonly string[],
  geometry: Map<string, AssetGeometry>,
  markAssetId: string | undefined
): BeatAction {
  if (markAssetId) return markActionOf(markAssetId) ?? "reveal";
  let paths = 0;
  let texts = 0;
  for (const id of assetIds) {
    paths += geometry.get(id)?.paths.size ?? 0;
    texts += TEXT_IDS_BY_ASSET.get(id)?.length ?? 0;
  }
  if (paths === 0 && texts === 0) return "hold";
  if (paths === 0 && texts > 0) return "write";
  return "draw";
}

/** The per-asset metadata the matcher scores beyond tags: the S142 effects'
 *  alts (their phrase vocabulary) and the W3 role. Optional — absent meta
 *  degrades the matcher to today's cue+tag scoring byte-for-byte. */
export interface AssetBeatMeta {
  alts?: readonly string[];
  role?: string;
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
  tags: readonly string[] | undefined,
  meta?: AssetBeatMeta
): number {
  let score = 0;
  const cue = ASSET_CUES.get(assetId);
  if (cue && cue.test(sentence)) score += 2;
  const tokens = new Set(sentenceTokens);
  for (const t of tagTokens(tags)) if (tokens.has(t)) score += 1;
  // S147 — the S142 recorded follow-up: score the asset's ALTS (the
  // effects' phrase vocabulary) into the candidate ranking, and give the
  // emphasis role its edge — but ONLY on an emphasis-class sentence, so
  // the marks sprinkle instead of wallpapering every board.
  const lower = sentence.toLowerCase();
  for (const alt of meta?.alts ?? []) {
    if (alt && lower.includes(alt.toLowerCase())) score += 2;
  }
  if (meta?.role === "emphasis" && EMPHASIS_RE.test(sentence)) score += 2;
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

/** R1 — the opening-stroke threshold (ANCHORS world). A board that sits
 *  EMPTY past this many scene-milliseconds reads as dead air AND the QC
 *  frozen-frames lens fails runs of the ~2.3s class on exactly those
 *  stretches (the 265s rich-render receipt: frozen at scene-local 4.7s
 *  and 7.4s where every placement had bound to a later sentence's SPOKEN
 *  window). The first work-carrying beat that would open later than this
 *  pulls its first placement forward to the opening sentence's window.
 *  Chosen UNDER the lens's run class and ABOVE the W2 pins' estimator
 *  openings (the pinned "coin → the money sentence" case opens at
 *  ~2.08s — semantic binding survives). */
export const OPENING_STROKE_MAX_MS = 2200;

/** R1 — the estimator-world twin. The SAME dead-air shape receipts in the
 *  estimator world too (the re-render's 174.4s freeze: an ASR word-count
 *  mismatch on spoken numbers degraded the scene to the estimator, whose
 *  word-proportional windows pushed the first asset ~8.9s deep). The
 *  threshold is deliberately LENIENT: the W2 pins freeze the estimator's
 *  semantic binding ("the coin WAITS for its sentence" at 3.75s), so the
 *  guarantee fires only on waits that are unambiguously dead air. A blind
 *  score can tighten this later — the operator call is recorded in the
 *  R-plan's decision points. */
export const OPENING_STROKE_ESTIMATOR_MAX_MS = 4000;

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
  /** S147 — per-asset alts + role (the matcher's extended vocabulary).
   *  Absent ⇒ byte-identical scoring (tags + cue table only). */
  assetMeta?: ReadonlyMap<string, AssetBeatMeta>;
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
          opts.assetTags?.get(pl.assetId),
          opts.assetMeta?.get(pl.assetId)
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
  let anchored = false;
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
    if (sane) {
      windows = candidate;
      anchored = true;
    }
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
    const purpose = classifySentence(sentences[sentence], sentence);
    // S147 — the additive fields. The mark: the FIRST fx-* asset assigned to
    // a HIGH-emphasis beat (deterministic; a mark on a normal beat draws in
    // order — the sprinkle law). The action rides the mark when one fires.
    const emphasis = beatEmphasisOf(purpose);
    const markAssetId =
      emphasis === "high"
        ? assetIds.find((id) => id.startsWith(FX_PREFIX))
        : undefined;
    beats.push({
      id: `beat-${sentence + 1}`,
      purpose,
      sentence,
      phrase: sentences[sentence],
      assetIds,
      startMs: window.startMs,
      endMs: window.endMs,
      rhetorical: classifyRhetorical(sentences[sentence], sentence, sentences.length),
      action: beatActionOf(assetIds, opts.geometry, markAssetId),
      emphasis,
      markAssetId,
    });
  }
  beats.sort((a, b) => a.sentence - b.sentence);

  // R1 — the opening-stroke guarantee (see the two thresholds): when the
  // earliest asset-carrying beat opens past its world's threshold, its
  // FIRST placement (draw order) pulls forward to sentence 0's window; the
  // rest of its mentions keep their sentence. A closer-card-only scene
  // stays put — pulling a close card to the opening would invert the
  // closer's design. Deterministic.
  const firstBeat = beats[0];
  const closerOnly =
    firstBeat.sentence === sentences.length - 1 &&
    beats.length === 1 &&
    firstBeat.assetIds.every((id) => CARD_LAST.has(id));
  const openingMax = anchored ? OPENING_STROKE_MAX_MS : OPENING_STROKE_ESTIMATOR_MAX_MS;
  if (firstBeat.sentence > 0 && firstBeat.startMs > openingMax && !closerOnly) {
    const moved = firstBeat.assetIds.shift();
    if (firstBeat.assetIds.length === 0) beats.shift();
    if (moved) {
      const purpose = classifySentence(sentences[0], 0);
      const emphasis = beatEmphasisOf(purpose);
      const markAssetId =
        emphasis === "high" && moved.startsWith(FX_PREFIX) ? moved : undefined;
      beats.unshift({
        id: "beat-1",
        purpose,
        sentence: 0,
        phrase: sentences[0],
        assetIds: [moved],
        startMs: windows[0].startMs,
        endMs: windows[0].endMs,
        rhetorical: classifyRhetorical(sentences[0], 0, sentences.length),
        action: beatActionOf([moved], opts.geometry, markAssetId),
        emphasis,
        markAssetId,
      });
    }
  }
  return beats;
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
  geometry: Map<string, AssetGeometry>,
  traced?: { allowed?: ReadonlyMap<string, ReadonlySet<string>>; remainder?: readonly string[] }
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
        // P0 — the traced cap: over-cap paths never enter any beat's fill
        // (they would schedule past the scene clock); they ride the
        // completion-boundary fade below instead.
        const allowedSet = traced?.allowed?.get(assetId);
        for (const [pathId, segs] of geo.paths) {
          if (claimed.has(`${assetId}::${pathId}`)) continue;
          if (allowedSet && !allowedSet.has(pathId)) continue;
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

    // S147 — the emphasis mark fires LAST: the labeled item lands, THEN the
    // mark punctuates it (the W4 law — emphasis fires after the spoken
    // claim). Stable sort: only mark-asset items move; absent markAssetId
    // leaves the order byte-identical to the pre-S147 compile.
    if (beat.markAssetId) {
      items.sort(
        (a, b) =>
          (a.assetId === beat.markAssetId ? 1 : 0) - (b.assetId === beat.markAssetId ? 1 : 0)
      );
    }

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
  // P0 — the completion-boundary fade: the over-cap remainder of traced
  // placements reveals through the EXISTING reveal_color grammar when the
  // last drawn stroke finishes (never outlasting the scene clock). Explicit
  // author events stay senior — an already-claimed remainder path is not
  // faded twice. Absent traced opts → byte-identical compile.
  const fadeKeys = (traced?.remainder ?? []).filter((k) => !claimed.has(k));
  if (fadeKeys.length > 0) {
    let maxEnd = 0;
    for (const e of events) {
      if (e.type === "draw_path" || e.type === "write_text") {
        maxEnd = Math.max(maxEnd, e.startMs + e.durationMs);
      }
    }
    const fadeStart = Math.max(0, Math.min(maxEnd, durationMs - WB_TRACED_FADE_MS));
    for (const key of fadeKeys) {
      const sep = key.indexOf("::");
      events.push({
        type: "reveal_color",
        assetId: key.slice(0, sep),
        pathId: key.slice(sep + 2),
        startMs: Math.round(fadeStart),
        durationMs: WB_TRACED_FADE_MS,
      });
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
  anchors?: WordAnchors,
  assetMeta?: ReadonlyMap<string, AssetBeatMeta>
): AnimationEvent[] {
  // P0 — the traced-placement cap split, computed ONCE here (the same pure
  // derivation the renderer's setup and the editor's setup read for the
  // fade pre-hide — one source, both surfaces).
  const split = tracedSplitForScene(scene, geometry, assetTags, durationMs, anchors);
  const traced = split ? { allowed: split.allowed, remainder: split.remainder } : undefined;
  const fallback = () => scheduleScene(scene, durationMs, geometry, anchors, traced);
  if (!(durationMs > 0)) return fallback();
  const beats = planBeats(scene, { durationMs, geometry, assetTags, anchors, assetMeta });
  if (beats.length === 0) return fallback();
  const events = compileBeats(beats, scene, durationMs, geometry, traced);
  // A usable plan always adds the unclaimed work; an empty list here is
  // the degenerate corner (nothing drawable at all) — the fill law's
  // output would be identical, so either path agrees. Take the fallback
  // for one-source consistency.
  if (events.length === 0) return fallback();
  return events;
}
