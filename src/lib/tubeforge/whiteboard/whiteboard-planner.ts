// S67 — the Whiteboard native scaffold planner (E9 Phase A / E5 phase 1).
//
// The ZERO-AI starter: builds a valid WhiteboardProject from the video's
// story scenes — narration copied per scene, asset picks from a deterministic
// keyword→library-tag rule table, placements from a per-scene-kind grid, and
// EMPTY animation arrays (timing.ts's scheduleScene fills the draw schedule
// at render/playback with the length-weighted fill law — the schedule is an
// ENGINE contract, never a planner's second implementation).
//
// The whiteboard module stays a leaf: this planner imports shared whiteboard
// modules + the story Scene type only — never Director, never generation
// APIs (the design §1 laws 1 and 5: native scaffold is $0 work).
import type { WhiteboardAsset } from "./assets";
import { applyWhiteboardProfile } from "./profiles";
import type { WhiteboardAssetPlacement, WhiteboardProject, WhiteboardScene } from "./storyboard";
import { WB_BUDGETS } from "./storyboard";
import type { Placement } from "./svg";
import { measureGlyphWidth, wrapGlyphLines } from "./text-draw";

/** The minimal story-scene shape the planner consumes (parseScenes' Scene). */
export interface ScaffoldSceneInput {
  index: number;
  title: string;
  narration: string;
}

// ---------------------------------------------------------------------------
// S137 — the generated per-video cards (title + close) and the rich scaffold.
//
// The built-in structural cards carry BENCHMARK text ("How Your Heart
// Works", "60-100 beats every minute") — scaffolding any other topic wrote
// another video's words onto the board (the rendered receipt that caught
// it: a habits video whose opener read "How You…"). The fix: the scaffold
// synthesizes the two cards from THIS video's topic and stores them as
// per-video upload assets (the S69 store — manifest + object, one merge at
// load). The card ids embed the video id, so the loader's per-asset text
// registries (`${assetId}::${textId}` keys) can never collide across
// videos, and the LLM planner's reserved-id law recognizes the prefix.
//
// The rich layout rides the same switch: boards get the topic title card,
// a large primary concept AND a supporting asset per scene (the one-tiny-
// icon board the first receipt rendered is what "sparse" means in
// practice), with the paper tone alternating per scene. Without generated
// assets the planner is BYTE-IDENTICAL to its previous output — the
// additive law, pinned by the existing S67 suite and the new guard.
// ---------------------------------------------------------------------------

/** The synthesized title card's asset-id prefix (per-video ids follow). */
export const WB_GENERATED_TITLE_PREFIX = "wb-title-";
/** The synthesized close card's asset-id prefix. */
export const WB_GENERATED_CLOSE_PREFIX = "wb-close-";

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

/** Escape a topic-derived string for safe embedding in the card's SVG
 *  markup (the topic is untrusted input like any other). */
function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => XML_ESCAPES[c] ?? c);
}

/** Wrap a topic into 1–3 balanced card lines (≤ 15 / 19 / 24 chars per
 *  line by tier, word-boundary splits, ellipsis on the hard tail).
 *  Deterministic and pure. */
export function wrapTitleLines(topic: string): string[] {
  const t = topic.trim().replace(/\s+/g, " ");
  if (!t) return [];
  if (t.length <= 15) return [t];
  const words = t.split(" ");
  let best: [string, string] | null = null;
  let bestMax = Number.POSITIVE_INFINITY;
  for (let i = 1; i < words.length; i++) {
    const l = words.slice(0, i).join(" ");
    const r = words.slice(i).join(" ");
    if (l.length > 19 || r.length > 19) continue;
    const m = Math.max(l.length, r.length);
    if (m < bestMax) {
      bestMax = m;
      best = [l, r];
    }
  }
  if (best) return best;
  // Greedy fill to at most 3 lines of ≤ 24; leftover words ride the third
  // line as a trimmed ellipsis tail (never a mid-word slice).
  const lines: string[] = [];
  let cur = "";
  let leftoverFrom = -1; // index of the first unconsumed word (-1 = none)
  for (let wi = 0; wi < words.length; wi++) {
    const next = cur ? `${cur} ${words[wi]}` : words[wi];
    if (cur && next.length > 24) {
      lines.push(cur);
      cur = words[wi];
      if (lines.length === 3) {
        leftoverFrom = wi;
        break;
      }
    } else {
      cur = next;
      if (cur.length >= 24) {
        lines.push(cur);
        cur = "";
        if (lines.length === 3) {
          leftoverFrom = wi + 1;
          break;
        }
      }
    }
  }
  if (leftoverFrom >= 0) {
    return [lines[0], lines[1], trimEllipsis(words.slice(leftoverFrom).join(" "), 22)];
  }
  if (cur) lines.push(cur);
  if (lines.length > 0 && lines.length <= 3) {
    const lastIdx = lines.length - 1;
    if (lines[lastIdx].length > 22) lines[lastIdx] = trimEllipsis(lines[lastIdx], 22);
    return lines;
  }
  // Degenerate topic (one giant word): hard two-line trim with an ellipsis.
  return [t.slice(0, 19), trimEllipsis(t.slice(19), 19)];
}

function trimEllipsis(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return `${sp > 0 ? cut.slice(0, sp) : cut}…`;
}

const KEY_PHRASE_STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "for", "and", "or", "but", "your", "you", "why",
  "how", "what", "when", "where", "who", "is", "are", "was", "were", "be", "been",
  "in", "on", "with", "that", "this", "it", "its", "by", "from", "at", "as", "into",
]);

/** The close card's big line: the topic's first ≤ 3 significant words
 *  (stopwords stripped, first letter capitalized, ≤ 18 chars). */
export function keyPhrase(topic: string): string {
  const words = topic.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  const significant = words.filter(
    (w) => !KEY_PHRASE_STOPWORDS.has(w.toLowerCase().replace(/[^a-z0-9']/g, ""))
  );
  const pick = (significant.length >= 2 ? significant : words).slice(0, 3).join(" ");
  const phrase = pick.length > 18 ? trimEllipsis(pick, 18) : pick;
  return phrase ? phrase.charAt(0).toUpperCase() + phrase.slice(1) : "";
}

/** The close card's small line: the story's final sentence (the promise),
 *  trimmed to 34 chars at a word boundary; a neutral fallback otherwise. */
export function closeNoteLine(lastNarration: string): string {
  const sentence =
    lastNarration
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .pop() ?? "";
  const clean = sentence.replace(/[.!?]+$/, "").trim();
  if (!clean) return "the one thing to remember";
  if (clean.length <= 34) return clean;
  return trimEllipsis(clean, 34);
}

/** Build the per-video generated cards. EMPTY when the topic is blank (the
 *  scaffold then falls back to the built-in cards — a graceful degrade, not
 *  a broken board). PURE: same inputs → byte-identical SVG strings. */
export function buildGeneratedCards(input: {
  videoId: string;
  topic: string;
  lastNarration?: string;
}): WhiteboardAsset[] {
  const topic = (input.topic ?? "").trim();
  if (!topic) return [];
  const cards: WhiteboardAsset[] = [];

  const title = buildTitleCard(input.videoId, topic);
  if (title) cards.push(title);
  const close = buildCloseCard(input.videoId, topic, input.lastNarration ?? "");
  if (close) cards.push(close);
  return cards;
}

function buildTitleCard(videoId: string, topic: string): WhiteboardAsset | null {
  // S139 — the card law: text WRAPS ON MEASURED Caveat advances (the glyph
  // table is the one metric), the size walks down until the whole topic
  // fits three lines, and the card opts into glyph mode so the pen DRAWS
  // every letterform. Uncovered characters or an unmeasurable topic fall
  // back to the S137 naive wrap + marker wipe (the honest-degrade law).
  const BOX_W = 760; // the 840-wide card minus its 40-unit margins
  const sizes = [84, 72, 64, 56, 50];
  for (const font of sizes) {
    const wrap = wrapGlyphLines(topic, BOX_W, font);
    if (!wrap.covered || wrap.lines.length === 0 || wrap.lines.length > 3) continue;
    if (wrap.lines.some((l) => !Number.isFinite(measureGlyphWidth(l, font)))) continue;
    const ys = wrap.lines.length === 1 ? [150] : wrap.lines.length === 2 ? [122, 216] : [96, 176, 256];
    const texts = wrap.lines
      .map(
        (line, i) =>
          `<text id="tb-line${i + 1}" x="40" y="${ys[i]}" font-size="${font}" fill="#1d3557" font-weight="bold">${escapeXml(line)}</text>`
      )
      .join("");
    const lastW = measureGlyphWidth(wrap.lines[wrap.lines.length - 1], font);
    const w = Math.round(Number.isFinite(lastW) ? lastW : 0);
    const uy = ys[ys.length - 1] + 24;
    const underline =
      wrap.lines.length < 3 && w > 40
        ? `<path id="tb-underline" d="M 40 ${uy} C ${40 + Math.round(w * 0.3)} ${uy - 8}, ${40 + Math.round(w * 0.7)} ${uy + 8}, ${40 + Math.min(760, w)} ${uy - 4}" fill="none" stroke="#e63946" stroke-width="6" stroke-linecap="round"/>`
        : "";
    return {
      id: `${WB_GENERATED_TITLE_PREFIX}${videoId}`,
      viewBox: { w: 840, h: 300 },
      tags: ["generic", "title"],
      svg: texts + underline,
      textMode: "glyph",
    };
  }
  // The measured route failed (uncovered chars, or nothing fits 3 lines) —
  // the S137 fallback stays byte-for-byte (naive wrap + marker wipe).
  const lines = wrapTitleLines(topic);
  if (lines.length === 0) return null;
  const font = lines.length === 1 ? 84 : lines.length === 2 ? 64 : 50;
  const ys = lines.length === 1 ? [150] : lines.length === 2 ? [122, 216] : [96, 176, 256];
  const texts = lines
    .map(
      (line, i) =>
        `<text id="tb-line${i + 1}" x="40" y="${ys[i]}" font-family="DejaVu Sans, sans-serif" font-size="${font}" fill="#1d3557" font-weight="bold">${escapeXml(line)}</text>`
    )
    .join("");
  const lastLen = lines[lines.length - 1].length;
  const w = Math.round(lastLen * font * 0.62);
  const uy = ys[ys.length - 1] + 24;
  const underline =
    lines.length < 3 && w > 40
      ? `<path id="tb-underline" d="M 40 ${uy} C ${40 + Math.round(w * 0.3)} ${uy - 8}, ${40 + Math.round(w * 0.7)} ${uy + 8}, ${40 + Math.min(720, w)} ${uy - 4}" fill="none" stroke="#e63946" stroke-width="6" stroke-linecap="round"/>`
      : "";
  return {
    id: `${WB_GENERATED_TITLE_PREFIX}${videoId}`,
    viewBox: { w: 840, h: 300 },
    tags: ["generic", "title"],
    svg: texts + underline,
  };
}

function buildCloseCard(videoId: string, topic: string, lastNarration: string): WhiteboardAsset | null {
  const big = keyPhrase(topic);
  if (!big) return null;
  const small = closeNoteLine(lastNarration);
  const bigFont = big.length <= 12 ? 88 : 68;
  const smallFont = small.length <= 26 ? 36 : 30;
  // S139 — glyph mode when the committed table covers BOTH strings and
  // they measure inside the box (the honest fallback keeps the wipe).
  const bigFits = Number.isFinite(measureGlyphWidth(big, bigFont)) && (measureGlyphWidth(big, bigFont) ?? 0) < 700;
  const smallFits = Number.isFinite(measureGlyphWidth(small, smallFont)) && (measureGlyphWidth(small, smallFont) ?? 0) < 700;
  const glyphMode = bigFits && smallFits;
  return {
    id: `${WB_GENERATED_CLOSE_PREFIX}${videoId}`,
    viewBox: { w: 840, h: 260 },
    tags: ["generic", "close"],
    ...(glyphMode ? { textMode: "glyph" as const } : {}),
    svg:
      `<path id="cl-box" d="M 28 28 L 28 216 L 740 216 L 740 28 Z" fill="none" stroke="#e63946" stroke-width="5" stroke-linecap="round"/>` +
      `<text id="cl-big" x="52" y="116" font-size="${bigFont}" fill="#1d3557" font-weight="bold">${escapeXml(big)}</text>` +
      `<text id="cl-small" x="52" y="182" font-size="${smallFont}" fill="#457b9d">${escapeXml(small)}</text>`,
  };
}

// ---------------------------------------------------------------------------
// The rule table — deterministic keyword → library-tag matching (E5 phase 1).
// Ordered: first hit wins. Tags mirror assets.ts; the fallback cycle rotates
// through the concept set so a scene with no cue still gets a varied board.
// ---------------------------------------------------------------------------

const KEYWORD_PICKS: { re: RegExp; assetId: string }[] = [
  { re: /\b(money|dollar|cost|price|revenue|budget|profit|paid|expensive|cheap)\b/i, assetId: "coin" },
  { re: /\b(grow|growth|increase|rise|trend|boost|scale|higher)\b/i, assetId: "arrow-growth" },
  { re: /\b(data|chart|stat|percent|metric|measure|number|graph)\b/i, assetId: "bar-chart" },
  { re: /\b(idea|innovate|innovation|invent|insight|think|creative)\b/i, assetId: "lightbulb" },
  { re: /\b(world|global|internet|country|countries|international|online)\b/i, assetId: "globe" },
  { re: /\b(time|deadline|schedule|minute|hour|fast|slow|wait)\b/i, assetId: "clock" },
  { re: /\b(launch|start|begin|first|pilot|ship|release)\b/i, assetId: "rocket" },
  { re: /\b(check|verify|correct|right|proven|safe|quality|benefit|advantage)\b/i, assetId: "check-badge" },
];

/** The no-cue fallback cycle (deterministic by scene position). */
const FALLBACK_CYCLE = ["lightbulb", "bar-chart", "rocket", "globe", "clock", "coin", "check-badge", "arrow-growth"] as const;

// S137 — the rich layout's scene-space slots (1920×1080 reference; remapped
// by remapPlacement like every other constant). The primary concept reads
// LARGE (the one-tiny-icon board was the sparse receipt); the supporting
// asset alternates sides by scene parity so consecutive boards don't look
// stamped from one die.
const GEN_TITLE_PLACEMENT: Placement = { x: 430, y: 96, scale: 1.3, rotateDeg: 0 };
const GEN_CLOSE_PLACEMENT: Placement = { x: 430, y: 100, scale: 1.3, rotateDeg: 0 };
const RICH_OPENER_PRIMARY: Placement = { x: 560, y: 500, scale: 2.0, rotateDeg: 0 };
const RICH_OPENER_SUPPORT: Placement = { x: 1240, y: 560, scale: 1.5, rotateDeg: 0 };
const RICH_PRIMARY: Placement = { x: 660, y: 400, scale: 2.4, rotateDeg: 0 };
const RICH_SUPPORT_LEFT: Placement = { x: 260, y: 560, scale: 1.6, rotateDeg: 0 };
const RICH_SUPPORT_RIGHT: Placement = { x: 1280, y: 560, scale: 1.6, rotateDeg: 0 };
const RICH_CLOSER_PRIMARY: Placement = { x: 560, y: 540, scale: 1.9, rotateDeg: 0 };

/** The concept library grid: a 320px board sits left-of-center; the
 *  title/close cards span the top when their scene kind calls for them.
 *  S68: the constants are 16:9 scene-space and are PROPORTIONALLY remapped
 *  to the project's real dimensions (9:16 / 1:1 scaffolds place sensibly —
 *  the 16:9 numbers stay the exact defaults). */
const CONCEPT_PLACEMENT: Placement = { x: 800, y: 420, scale: 1.6, rotateDeg: 0 };
const TITLE_PLACEMENT: Placement = { x: 460, y: 120, scale: 1.25, rotateDeg: 0 };
const CLOSE_PLACEMENT: Placement = { x: 460, y: 380, scale: 1.25, rotateDeg: 0 };
/** A second concept under the close card (the last scene still teaches). */
const CLOSE_CONCEPT_PLACEMENT: Placement = { x: 820, y: 560, scale: 1.4, rotateDeg: 0 };

/** Remap a 16:9 scene-space placement onto (width × height). Positions
 *  scale by axis; the scale factor keeps the 1920-wide reference size for
 *  16:9 and shrinks/grows with board width for other aspects (assets must
 *  stay on a 1080-tall board: their pixel size follows the WIDTH ratio so a
 *  9:16 board at 1080 wide draws the same asset size it would at 1080 wide
 *  in 16:9 — vertical space is what changes, not ink size). */
function remapPlacement(pl: Placement, width: number, height: number): Placement {
  const fx = width / 1920;
  const fy = height / 1080;
  return { x: Math.round(pl.x * fx), y: Math.round(pl.y * fy), scale: pl.scale * fx, rotateDeg: pl.rotateDeg };
}

function pickForScene(narration: string, position: number, exclude?: ReadonlySet<string>): string {
  for (const { re, assetId } of KEYWORD_PICKS) {
    if (re.test(narration) && !exclude?.has(assetId)) return assetId;
  }
  for (let k = 0; k < FALLBACK_CYCLE.length; k++) {
    const cand = FALLBACK_CYCLE[(position + k) % FALLBACK_CYCLE.length];
    if (!exclude?.has(cand)) return cand;
  }
  return FALLBACK_CYCLE[position % FALLBACK_CYCLE.length];
}

/** The supporting pick: the NEXT distinct rule-table hit on the narration
 *  (a scene that talks about money AND growth gets the coin AND the growth
 *  arrow), else the fallback cycle at an offset from the primary so no-cue
 *  scenes still pair two different concepts. Deterministic. */
function supportForScene(narration: string, position: number, exclude: ReadonlySet<string>): string {
  for (const { re, assetId } of KEYWORD_PICKS) {
    if (re.test(narration) && !exclude.has(assetId)) return assetId;
  }
  for (let k = 0; k < FALLBACK_CYCLE.length; k++) {
    const cand = FALLBACK_CYCLE[(position + 3 + k) % FALLBACK_CYCLE.length];
    if (!exclude.has(cand)) return cand;
  }
  return FALLBACK_CYCLE[(position + 3) % FALLBACK_CYCLE.length];
}

/**
 * Build the starter project. PURE and DETERMINISTIC: same scenes → the same
 * project JSON byte-for-byte (the determinism law extends to the planner).
 * The caller has already enforced the scene-count wall (≤
 * WB_BUDGETS.scenesPerProject) — this function refuses beyond it rather
 * than silently truncating (a silent truncation would read as success).
 *
 * S68 — `width`/`height`/`fps` are OPTIONAL and default to the house
 * 1920×1080@24 (existing callers unchanged); placements remap
 * proportionally and the default camera key centers on the real board.
 */
export function scaffoldWhiteboardProject(input: {
  scenes: ScaffoldSceneInput[];
  topic: string;
  width?: number;
  height?: number;
  fps?: number;
  /** S137 — the per-video generated cards (buildGeneratedCards' output).
   *  Absent/empty = the LEGACY path, byte-identical to the previous
   *  planner (built-in cards, one concept per scene, white paper). The
   *  scaffold route always passes the synthesized cards when a topic
   *  exists — the rich path is the product default, the legacy path is
   *  the pinned fallback. */
  generatedAssets?: WhiteboardAsset[];
  /** P5 — the production profile: the recipe bakes onto the scaffolded
   *  project (hand, sfx, papers, board defaults). Absent = the classic
   *  house shape, byte-identical to the pre-P5 scaffold (the fallback
   *  law). Unknown ids apply nothing (the applier reports it). */
  profileId?: string;
}): WhiteboardProject {
  if (input.scenes.length === 0) {
    throw new Error("whiteboard scaffold needs at least one story scene");
  }
  if (input.scenes.length > WB_BUDGETS.scenesPerProject) {
    throw new Error(
      `whiteboard scaffold: ${input.scenes.length} scenes exceeds the ${WB_BUDGETS.scenesPerProject}-scene project budget — trim the story first`
    );
  }

  // Same clamp grammar as the validator (the one gate every doc passes):
  // out-of-band numbers fall back to the house defaults rather than
  // producing a project the validator would bend behind the planner's back.
  const width =
    typeof input.width === "number" && input.width >= 320 && input.width <= 3840
      ? Math.round(input.width)
      : 1920;
  const height =
    typeof input.height === "number" && input.height >= 320 && input.height <= 3840
      ? Math.round(input.height)
      : 1080;
  const fps =
    typeof input.fps === "number" && input.fps >= 12 && input.fps <= 60
      ? Math.round(input.fps)
      : 24;
  const remap = (pl: Placement) => remapPlacement(pl, width, height);

  // S137 — resolve the generated cards (rich path) vs the built-ins (legacy).
  const genTitleId =
    (input.generatedAssets ?? []).find((a) => a.id.startsWith(WB_GENERATED_TITLE_PREFIX))?.id ?? null;
  const genCloseId =
    (input.generatedAssets ?? []).find((a) => a.id.startsWith(WB_GENERATED_CLOSE_PREFIX))?.id ?? null;
  // The anti-repeat carry: the previous scene's primary pick (rich path).
  let prevPrimary = "";

  const scenes: WhiteboardScene[] = input.scenes.map((s, i) => {
    const isFirst = i === 0;
    const isLast = i === input.scenes.length - 1 && input.scenes.length > 1;
    const placements: WhiteboardAssetPlacement[] = [];

    if (genTitleId !== null) {
      // ---- S137 rich path: the topic's own cards, a LARGE primary and a
      // supporting concept per scene, alternating paper tones. The
      // anti-repeat exclusion keeps the previous scene's primary off this
      // board (the bar-chart×3/rocket×3 repetition the receipt caught).
      const primary = pickForScene(`${s.title} ${s.narration}`, i, prevPrimary ? new Set([prevPrimary]) : undefined);
      const support = supportForScene(`${s.title} ${s.narration}`, i, new Set([primary, prevPrimary]));
      prevPrimary = primary;
      if (isFirst) {
        placements.push({ assetId: genTitleId, placement: remap(GEN_TITLE_PLACEMENT), order: 0 });
        placements.push({ assetId: primary, placement: remap(RICH_OPENER_PRIMARY), order: 1 });
        placements.push({ assetId: support, placement: remap(RICH_OPENER_SUPPORT), order: 2 });
      } else if (isLast && genCloseId) {
        placements.push({ assetId: genCloseId, placement: remap(GEN_CLOSE_PLACEMENT), order: 0 });
        placements.push({ assetId: primary, placement: remap(RICH_CLOSER_PRIMARY), order: 1 });
        placements.push({ assetId: support, placement: remap(RICH_OPENER_SUPPORT), order: 2 });
      } else {
        placements.push({ assetId: primary, placement: remap(RICH_PRIMARY), order: 0 });
        placements.push({
          assetId: support,
          placement: remap(i % 2 === 1 ? RICH_SUPPORT_LEFT : RICH_SUPPORT_RIGHT),
          order: 1,
        });
      }
      return {
        id: `scene-${s.index}`,
        narration: s.narration,
        background: i % 2 === 1 ? "#f8f5ee" : "#ffffff",
        placements,
        animations: [], // scheduleScene's fill law owns the draw schedule
        camera: [{ cx: width / 2, cy: height / 2, scale: 1, startMs: 0, durationMs: 0 }],
      };
    }

    if (isFirst) {
      // The opener: the hero title card up top, the lead concept below.
      placements.push({ assetId: "title-hero", placement: remap(TITLE_PLACEMENT), order: 0 });
      placements.push({
        assetId: pickForScene(`${s.title} ${s.narration}`, i),
        placement: remap(CONCEPT_PLACEMENT),
        order: 1,
      });
    } else if (isLast) {
      placements.push({ assetId: "close-card", placement: remap(CLOSE_PLACEMENT), order: 0 });
      placements.push({
        assetId: pickForScene(`${s.title} ${s.narration}`, i),
        placement: remap(CLOSE_CONCEPT_PLACEMENT),
        order: 1,
      });
    } else {
      placements.push({
        assetId: pickForScene(`${s.title} ${s.narration}`, i),
        placement: remap(CONCEPT_PLACEMENT),
        order: 0,
      });
    }

    return {
      id: `scene-${s.index}`,
      narration: s.narration,
      background: "#ffffff",
      placements,
      animations: [], // scheduleScene's fill law owns the draw schedule
      camera: [{ cx: width / 2, cy: height / 2, scale: 1, startMs: 0, durationMs: 0 }],
    };
  });

  return applyWhiteboardProfile(
    {
      title: input.topic ? `Whiteboard — ${input.topic}`.slice(0, 120) : "Whiteboard",
      width,
      height,
      fps,
      hand: { style: "marker", scale: 1 },
      scenes,
    },
    input.profileId ?? null
  ).project;
}

// ---------------------------------------------------------------------------
// The doc revision stamp — the advisory concurrency token (design §2.1).
// Stored INSIDE the doc (a `rev` key beside the project), bumped on every
// accepted PUT; a save whose rev mismatches the stored one gets a 409 with
// the server's current doc. LWW remains the final law; rev is UX.
// ---------------------------------------------------------------------------

export interface WhiteboardDoc {
  rev: number;
  project: WhiteboardProject;
}

/** Read the doc column (tolerant parse discipline: null on invalid — never
 *  throw on untrusted JSON; the house law for every doc column). */
export function parseWhiteboardDoc(raw: string | null | undefined): WhiteboardDoc | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const rec = parsed as Record<string, unknown>;
  const rev = rec.rev;
  if (typeof rev !== "number" || !Number.isInteger(rev) || rev < 1) return null;
  // A doc without a project body is corrupt (a truncated write), not an
  // empty one — null reads as "no project", which is the honest state.
  if (typeof rec.project !== "object" || rec.project === null) return null;
  return { rev, project: rec.project as WhiteboardProject };
}

/** Serialize doc + rev for storage (stable key order the house writes). */
export function serializeWhiteboardDoc(doc: WhiteboardDoc): string {
  return JSON.stringify({ rev: doc.rev, project: doc.project });
}
