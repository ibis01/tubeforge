// Keynote Slides (render mode "slides") — vertical-native kinetic-typography
// explainers, the "designed slide" format popular on Shorts/Reels.
//
// Instead of AI storyboard art + camera moves, every scene becomes ONE
// designed slide: huge headline typography on a clean studio background,
// accent-colored keywords, badge pills ("TIP"/"NEWS"), data counters
// ("27.4 W"), comparison bars, dark spec cards, numbered step cards, price
// chips and minimal line icons — one idea per beat, timed by the scene's
// narration WAV. The geometry is 9:16 from the start (1080x1920), so nothing
// is ever center-cropped from a landscape master.
//
// Pipeline contract (mirrors music.ts / motion.ts boundaries):
//   1. planSlides()      — one SlideSpec per scene: an LLM designs the deck
//                          from the script; a deterministic heuristic planner
//                          fills in when the LLM is unavailable or malformed.
//                          Specs persist as slides.json next to the scenes so
//                          re-renders never re-bill the deck design.
//   2. slideHtml()       — pure spec → HTML composer (no I/O, unit-tested).
//   3. ensureSlideImages() — Playwright + the bundled Chromium screenshot the
//                          HTML at 2160x3840 (2x supersample, same trick the
//                          Ken Burns graph uses) into slide-NN.png files.
//   4. render.ts         — feeds each PNG through the same zoompan/segment/
//                          transitions/loudnorm pipeline as the other modes.
//
// The visual language is tuned against the reference format: near-white
// radial studio backdrop, near-black ink, one accent per slide, one focal
// element per beat, no clutter. Sound stays in the existing audiomix engine.
//
// Brand kit (per-video): an accent hex recolors EVERY slide's highlight
// system at composer level (CSS custom properties — no deck re-design, no
// re-billing, instant preview of a rebrand), and an uploaded logo gets a
// small corner badge on every slide when enabled. A single slide's design
// can also be re-rolled (fresh LLM take) without touching the rest of the
// deck — see rerollSlideSpec().

import fs from "fs";
import path from "path";
import type { Scene } from "./types";
import { videoDir } from "./ai";
import { aiCall } from "./budget";
import { chatComplete } from "./providers/chat";
import { parseJsonLoose } from "./ai";
import { FOCAL_CENTER, zoompanForShot, OUTPUT_SIZES, type MotionScenePlan, type MotionSettings } from "./motion";

// ---------------------------------------------------------------------------
// Catalogs
// ---------------------------------------------------------------------------

export const SLIDE_LAYOUTS = [
  "statement", // big type only — kicker badge + headline (+ accent/highlight/strike)
  "icon", // headline + minimal line pictogram + small-caps footer
  "photo", // headline + rounded scene-art card (falls back to icon when no art)
  "counter", // huge number + unit + small-caps sub-caption (+ optional bars)
  "bars", // comparison bars + title + source note
  "card", // dark spec card — stacked big/small line pairs
  "steps", // white numbered step card under a small-caps header
  "price", // yellow price chip + footer (+ optional icon)
] as const;

export type SlideLayout = (typeof SLIDE_LAYOUTS)[number];

export const SLIDE_ACCENTS = ["yellow", "green", "red", "blue", "mono"] as const;
export type SlideAccent = (typeof SLIDE_ACCENTS)[number];

// ---------------------------------------------------------------------------
// Brand kit — accent override + corner logo badge (composer-level)
// ---------------------------------------------------------------------------

/** Per-video brand overrides applied when the slide HTML is composed. */
export interface SlideBrand {
  /** #rrggbb — replaces every catalog accent (mono/ink stays ink). */
  accentHex: string | null;
  /** Absolute file:// URL of the uploaded logo — badge shown when set. */
  logoUrl: string | null;
}

/** Normalize a user/LLM color to #rrggbb (3-digit expands); junk → null. */
export function sanitizeBrandAccent(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(v.trim().toLowerCase());
  if (!m) return null;
  const hex = m[1];
  return `#${hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex}`;
}

/** Ink color that stays readable on top of a brand fill (yellow → dark, blue → white). */
export function readableInk(hex: string): string {
  const full = sanitizeBrandAccent(hex);
  if (!full) return "#0D0D0F";
  const h = full.slice(1);
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.55 ? "#0D0D0F" : "#FFFFFF";
}

/** :root custom properties that recolor the accent system (empty → catalog). */
export function brandCssVars(brand: SlideBrand | null): string {
  if (!brand?.accentHex) return "";
  return `:root{--brand:${brand.accentHex};--brand-ink:${readableInk(brand.accentHex)};}`;
}

/** The video's uploaded logo file (any supported ext), null when absent. */
export function brandLogoFile(videoId: string): string | null {
  const dir = videoDir(videoId);
  for (const ext of ["png", "webp", "svg"]) {
    const p = path.join(dir, `brand-logo.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function hasBrandLogo(videoId: string): boolean {
  return brandLogoFile(videoId) !== null;
}

/** Resolve a video row's brand fields into the composer shape (null = catalog). */
export function slideBrandFor(
  videoId: string,
  brandAccent: string | null,
  brandLogoOn: boolean | null
): SlideBrand | null {
  const accentHex = sanitizeBrandAccent(brandAccent);
  const logoFile = brandLogoOn === false ? null : brandLogoFile(videoId);
  if (!accentHex && !logoFile) return null;
  return {
    accentHex,
    logoUrl: logoFile ? `file://${logoFile}` : null,
  };
}

export const SLIDE_ICONS = [
  "laptop", "phone", "chip", "gamepad", "calendar", "battery", "flame",
  "clock", "cart", "cloud", "bolt", "chart", "dollar", "box", "lock", "wifi",
] as const;
export type SlideIcon = (typeof SLIDE_ICONS)[number];

export interface SlideBar {
  label: string; // small-caps row label ("TYPICAL LAPTOP ASLEEP")
  valueText: string; // right-aligned value ("UNDER 2 W")
  weight: number; // 0..1 relative fill
  highlight?: boolean; // the row the slide is about (accent fill)
}

export interface SlideSpec {
  layout: SlideLayout;
  accent: SlideAccent;
  badge: string | null; // pill above the headline ("TIP", "NEWS", "HOT")
  headline: string; // the big text (the visual)
  accentWord: string | null; // a word inside headline to color/highlight
  highlight: boolean; // paint accentWord (or whole headline) with the accent box
  strike: boolean; // red strikethrough — the "correction gag"
  footer: string | null; // small-caps caption under the focal element
  icon: SlideIcon | null; // icon layout pictogram
  number: string | null; // counter big value ("27.4", "29,239,000,000")
  unit: string | null; // counter unit ("W", "%", "×")
  subLabel: string | null; // counter small-caps line under the number
  bars: SlideBar[]; // bars rows (also allowed on "counter")
  cardTitle: string | null; // dark card small-caps header
  cardLines: { big: string; small: string | null }[]; // dark card rows
  steps: { label: string; n: string }[]; // numbered steps
  priceLabel: string | null; // "From"
  priceValue: string | null; // "$2,599"
  source: string | null; // citation line ("Source: Notebookcheck, 2020")
  useImage: boolean; // photo layout: embed the scene's storyboard art
}

// ---------------------------------------------------------------------------
// Sanitizer — every spec that reaches the renderer comes from here
// ---------------------------------------------------------------------------

const clampStr = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  return s.length > 0 ? s.slice(0, max) : null;
};

const clampNumText = (v: unknown): string | null => {
  const s = clampStr(v, 14);
  return s && /^[-+]?[$€£]?[\d.,]+\s*[%×xX]?$/.test(s) ? s : null;
};

/** Coerce arbitrary LLM/JSON data into a valid SlideSpec (never throws). */
export function sanitizeSlideSpec(raw: unknown): SlideSpec {
  const r = (raw ?? {}) as Record<string, unknown>;
  const layout = (SLIDE_LAYOUTS as readonly string[]).includes(String(r.layout))
    ? (r.layout as SlideLayout)
    : "statement";
  const accent = (SLIDE_ACCENTS as readonly string[]).includes(String(r.accent))
    ? (r.accent as SlideAccent)
    : "yellow";
  const icon = (SLIDE_ICONS as readonly string[]).includes(String(r.icon))
    ? (r.icon as SlideIcon)
    : null;

  let headline = clampStr(r.headline, 120) ?? "Next slide";
  const accentWordRaw = clampStr(r.accentWord, 40);
  // The accent word must actually appear in the headline, else the template
  // can't wrap it — drop it instead of rendering a highlight around nothing.
  const accentWord =
    accentWordRaw && headline.toLowerCase().includes(accentWordRaw.toLowerCase())
      ? accentWordRaw
      : null;

  const bars = Array.isArray(r.bars)
    ? r.bars
        .map((b) => {
          const row = (b ?? {}) as Record<string, unknown>;
          const weight = Number(row.weight);
          return {
            label: clampStr(row.label, 28) ?? "",
            valueText: clampStr(row.valueText, 14) ?? "",
            weight: Number.isFinite(weight) ? Math.min(1, Math.max(0.04, weight)) : 0.5,
            highlight: row.highlight === true,
          };
        })
        .filter((b) => b.label.length > 0)
        .slice(0, 4)
    : [];

  const cardLines = Array.isArray(r.cardLines)
    ? r.cardLines
        .map((l) => {
          const row = (l ?? {}) as Record<string, unknown>;
          return {
            big: clampStr(row.big, 44) ?? "",
            small: clampStr(row.small, 64),
          };
        })
        .filter((l) => l.big.length > 0)
        .slice(0, 6)
    : [];

  const steps = Array.isArray(r.steps)
    ? r.steps
        .map((s, i) => {
          const row = (s ?? {}) as Record<string, unknown>;
          return {
            label: clampStr(row.label, 32) ?? "",
            n: clampStr(row.n, 3) ?? String(i + 1).padStart(2, "0"),
          };
        })
        .filter((s) => s.label.length > 0)
        .slice(0, 5)
    : [];

  return {
    layout,
    accent,
    badge: clampStr(r.badge, 12)?.toUpperCase() ?? null,
    headline,
    accentWord,
    highlight: r.highlight === true,
    strike: r.strike === true,
    footer: clampStr(r.footer, 48),
    icon,
    number: clampNumText(r.number),
    unit: clampStr(r.unit, 8),
    subLabel: clampStr(r.subLabel, 64),
    bars,
    cardTitle: clampStr(r.cardTitle, 48),
    cardLines,
    steps,
    priceLabel: clampStr(r.priceLabel, 24),
    priceValue: clampStr(r.priceValue, 14),
    source: clampStr(r.source, 80),
    useImage: r.useImage === true,
  };
}

// ---------------------------------------------------------------------------
// Deterministic fallback planner — no LLM required
// ---------------------------------------------------------------------------

/** First number (with optional unit) found in free prose, e.g. "27.4 watts". */
const UNIT_WORDS: Record<string, string> = {
  percent: "%", "%": "%", watt: "W", watts: "W", w: "W",
  dollar: "$", dollars: "$", usd: "$", hour: "h", hours: "h", hrs: "h",
  minute: "min", minutes: "min", min: "min", second: "s", seconds: "s",
  day: "d", days: "d", year: "yr", years: "yr", yrs: "yr",
  gb: "GB", gigabyte: "GB", gigabytes: "GB", tb: "TB", mb: "MB",
  kg: "kg", km: "km", miles: "mi", times: "×", x: "×",
};

export function extractNumber(text: string): { number: string; unit: string | null } | null {
  // "$2,599" | "27.4 W" | "8x" | "12 percent" — number, optional symbol, optional unit word
  const m = text.match(
    /[$€£]?\d[\d,]*(?:\.\d+)?(?:\s*(?:%|×|x)\b|\s*(percent|watts?|dollars?|hours?|hrs?|minutes?|mins?|seconds?|days?|years?|yrs?|gigabytes?|gb|tb|mb|kg|km|miles?)\b)?/i
  );
  if (!m) return null;
  const rawNum = m[0].trim();
  let number = rawNum;
  let unit: string | null = null;
  const unitMatch = rawNum.match(/(?:%|×|x)$/i);
  if (unitMatch) {
    unit = unitMatch[0] === "x" || unitMatch[0] === "X" ? "×" : unitMatch[0];
    number = rawNum.slice(0, rawNum.length - unitMatch[0].length).trim();
  } else {
    const word = m[1]?.toLowerCase();
    if (word) {
      unit = UNIT_WORDS[word] ?? null;
      number = rawNum.replace(new RegExp(`\\s*${m[1]}$`, "i"), "").trim();
    }
  }
  if (!/[\d]/.test(number)) return null;
  return { number, unit };
}

const QUESTION_RE = /\?\s*$/;
const SHORT_WORDS = 7;

/**
 * Heuristic deck design when the LLM is unavailable. Reads the scene's own
 * caption/narration: numbers become counters, comparisons become bars,
 * questions and punchy captions become statements, art (when present)
 * becomes a photo card.
 */
export function fallbackSlideForScene(
  scene: Scene,
  opts: { hasImage: boolean; topic?: string | null }
): SlideSpec {
  const text = `${scene.caption} ${scene.narration}`;
  const num = extractNumber(text);
  const caption = scene.caption?.trim() || scene.title?.trim() || "Next slide";

  // Two numbers + a comparative word → comparison bars.
  const comparative = /\b(versus|vs\.?|more than|less than|faster|slower|cheaper|hotter|compared|times)\b/i.test(text);
  if (num && comparative) {
    const n2 = extractNumber(text.replace(num.number, "")) ?? { number: "1", unit: num.unit };
    const a = parseFloat(num.number.replace(/[^0-9.]/g, "")) || 1;
    const b = parseFloat(n2.number.replace(/[^0-9.]/g, "")) || 1;
    const hi = Math.max(a, b);
    return sanitizeSlideSpec({
      layout: "counter",
      accent: "red",
      headline: caption,
      number: num.number,
      unit: num.unit,
      subLabel: scene.title,
      bars: [
        { label: "THIS", valueText: num.number + (num.unit ?? ""), weight: a / hi, highlight: true },
        { label: "TYPICAL", valueText: n2.number + (n2.unit ?? ""), weight: b / hi },
      ],
      footer: null,
    });
  }

  if (num) {
    return sanitizeSlideSpec({
      layout: "counter",
      accent: "blue",
      headline: caption,
      number: num.number,
      unit: num.unit,
      subLabel: scene.title,
      footer: null,
      source: null,
    });
  }

  if (opts.hasImage) {
    return sanitizeSlideSpec({
      layout: "photo",
      accent: scene.rehook ? "red" : "yellow",
      badge: scene.rehook ? "WAIT" : null,
      headline: caption,
      accentWord: null,
      footer: null,
      useImage: true,
    });
  }

  const statement = QUESTION_RE.test(caption) || caption.split(/\s+/).length <= SHORT_WORDS;
  return sanitizeSlideSpec({
    layout: statement ? "statement" : "icon",
    accent: scene.rehook ? "red" : "yellow",
    badge: scene.rehook ? "WAIT" : null,
    headline: caption,
    accentWord: null,
    footer: statement ? null : scene.title,
    icon: statement ? null : "bolt",
  });
}

// ---------------------------------------------------------------------------
// LLM deck planner (with cache + fallback)
// ---------------------------------------------------------------------------

export interface SlidePlanContext {
  topic: string | null;
  niche: string | null;
  tone: string | null;
}

const PLAN_SYSTEM =
  "You are an art director for keynote-style vertical explainer shorts (clean white studio background, huge typography, one idea per slide — the Apple-keynote-meets-Shorts format). You turn a narrated scene script into a slide deck where the TYPE IS THE VISUAL. You always respond with STRICT JSON only — no markdown, no commentary.";

const PLAN_RULES = `LAYOUT CATALOG (pick per scene):
- "statement": pure typography — kicker badge + huge headline. For questions, punchlines, pivots ("How?", "The catch?", "On sale").
- "icon": headline + one minimal line pictogram (icon id) + small-caps footer. For object-level facts ("gaming." + gamepad).
- "photo": headline + the scene's existing art in a rounded card (useImage: true). Only when the scene has rich visual art worth showing.
- "counter": HUGE number + unit + small-caps sub-caption, optional comparison bars. For stats ("0.0 W", "27.4 W", "8×").
- "bars": 2-3 horizontal comparison bars (label, valueText, weight 0..1, highlight on THE row the scene is about) + source note. Only with genuinely comparable numbers.
- "card": dark rounded spec card — cardTitle + 2-5 cardLines each {big, small}. For spec sheets / stacked facts.
- "steps": numbered white card — 2-4 steps {label, n}. For how-to sequences.
- "price": yellow price chip — priceLabel ("From") + priceValue ("$2,599"). For costs.

HARD RULES:
- headline: MAX 6 words, match the scene's narration meaning, sentence case, a period is allowed for punch.
- ONE idea per slide — the slide must make sense while the narration for that scene plays.
- Extract REAL numbers from the narration (never invent). counter.number: digits/commas/decimal only (max 14 chars); unit separate ("W", "%", "GB", "×").
- accent (one per slide): yellow = tips/highlights, green = wins/savings/positive, red = warnings/costs/heat/danger, blue = facts/tech/neutral data, mono = stark statements.
- badge ("TIP","NEWS","HOT","WAIT","NEW") ONLY when the narration is literally a tip/news flash/alert — most slides have no badge.
- accentWord: one word from the headline to color or highlight-box. Use with highlight:true for the yellow-marker look.
- strike:true ONLY for a correction gag (state something, then strike it).
- footer: small-caps label under the visual (max 4 words) — the subject ("WINDOWS LAPTOP") or a context line.
- source: only when the narration cites a study/publication ("Source: Notebookcheck, 2020").
- Vary layouts across the deck — never 5 counters in a row. statement/icon carry the narrative beats; data layouts carry the evidence.

Return a STRICT JSON array with EXACTLY one object per scene, in order, keys:
layout, accent, badge, headline, accentWord, highlight, strike, footer, icon, number, unit, subLabel, bars, cardTitle, cardLines, steps, priceLabel, priceValue, source, useImage
Use null/[]/false for unused keys. No extra keys, no commentary.`;

function scenesBrief(scenes: Scene[]): string {
  return scenes
    .map(
      (s) =>
        `Scene ${s.index} — title: "${s.title}" | caption: "${s.caption}" | narration: "${s.narration}"${
          s.rehook ? " [REHOOK — pattern-interrupt beat]" : ""
        }`
    )
    .join("\n");
}

/** slides.json — the persisted deck (re-renders reuse it verbatim). */
export function slidesJsonPath(videoId: string): string {
  return path.join(videoDir(videoId), "slides.json");
}

export function loadSlideDeck(videoId: string): SlideSpec[] | null {
  try {
    const raw = JSON.parse(fs.readFileSync(slidesJsonPath(videoId), "utf8")) as unknown;
    if (!Array.isArray(raw) || raw.length === 0) return null;
    return raw.map(sanitizeSlideSpec);
  } catch {
    return null;
  }
}

/**
 * Design (or load the cached) slide deck for a video. Never throws — any
 * LLM failure falls back to the deterministic planner per scene, so a
 * missing/misconfigured chat provider degrades instead of blocking renders.
 */
export async function planSlides(
  videoId: string,
  scenes: Scene[],
  ctx: SlidePlanContext,
  opts: { force?: boolean } = {}
): Promise<{ specs: SlideSpec[]; source: "cache" | "llm" | "fallback" }> {
  if (!opts.force) {
    const cached = loadSlideDeck(videoId);
    // Previews render the FIRST N scenes — a longer cached deck slices fine.
    if (cached && cached.length >= scenes.length)
      return { specs: cached.slice(0, scenes.length), source: "cache" };
  }

  const imageByIndex = new Set(
    scenes.filter((s) => fs.existsSync(path.join(videoDir(videoId), `scene-${String(s.index).padStart(2, "0")}.png`))).map((s) => s.index)
  );

  try {
    const raw = await aiCall("llm", "slide deck design", () =>
      chatComplete({
        system: PLAN_SYSTEM,
        user: `Topic: "${ctx.topic ?? ""}"
Niche: ${ctx.niche ?? "general"}
Tone: ${ctx.tone ?? "informative"}

${PLAN_RULES}

SCENES:
${scenesBrief(scenes)}`,
      })
    );
    const parsed = parseJsonLoose(raw);
    const arr = Array.isArray(parsed) ? parsed : (Array.isArray((parsed as { slides?: unknown[] })?.slides) ? (parsed as { slides: unknown[] }).slides : null);
    if (arr && arr.length === scenes.length) {
      const specs = arr.map((s, i) => {
        const spec = sanitizeSlideSpec(s);
        // The LLM cannot know which scenes have art on disk — reconcile.
        if (spec.layout === "photo") spec.useImage = imageByIndex.has(scenes[i].index);
        return spec;
      });
      fs.mkdirSync(videoDir(videoId), { recursive: true });
      fs.writeFileSync(slidesJsonPath(videoId), JSON.stringify(specs, null, 2));
      return { specs, source: "llm" };
    }
  } catch {
    // fall through to the deterministic planner
  }

  const specs = scenes.map((s) =>
    fallbackSlideForScene(s, { hasImage: imageByIndex.has(s.index), topic: ctx.topic })
  );
  fs.mkdirSync(videoDir(videoId), { recursive: true });
  fs.writeFileSync(slidesJsonPath(videoId), JSON.stringify(specs, null, 2));
  return { specs, source: "fallback" };
}

// ---------------------------------------------------------------------------
// Per-slide re-roll — fresh design for ONE scene (Scene Studio)
// ---------------------------------------------------------------------------

export interface SlideRerollResult {
  spec: SlideSpec;
  source: "llm" | "fallback";
}

const sceneImageName = (index: number) =>
  `scene-${String(index).padStart(2, "0")}.png`;

/**
 * Design ONE slide fresh, without touching the rest of the deck. The LLM gets
 * the scene brief plus the previous design (explicitly told to differ), so a
 * re-roll is a genuinely new take — not the same spec re-served. Falls back
 * to the deterministic planner with a rotated accent when the LLM is
 * unavailable, so the button always yields a visible change. Never throws.
 */
export async function rerollSlideSpec(
  scene: Scene,
  ctx: SlidePlanContext,
  previous: SlideSpec | null,
  opts: { hasImage: boolean } = { hasImage: false }
): Promise<SlideRerollResult> {
  const previousBrief = previous
    ? `PREVIOUS DESIGN for this scene (you are replacing it — give a FRESH take: a different layout or different accent/highlight treatment, still true to the narration): layout=${previous.layout}, accent=${previous.accent}, badge=${previous.badge ?? "none"}, headline="${previous.headline}"\n`
    : "";
  try {
    const raw = await aiCall("llm", "single slide redesign", () =>
      chatComplete({
        system: PLAN_SYSTEM,
        user: `Topic: "${ctx.topic ?? ""}"
Niche: ${ctx.niche ?? "general"}
Tone: ${ctx.tone ?? "informative"}

${PLAN_RULES}
${previousBrief}
Design EXACTLY ONE slide for the scene below. Return a STRICT JSON object (NOT an array) with exactly these keys:
layout, accent, badge, headline, accentWord, highlight, strike, footer, icon, number, unit, subLabel, bars, cardTitle, cardLines, steps, priceLabel, priceValue, source, useImage
Use null/[]/false for unused keys. No extra keys, no commentary.

SCENE:
${scenesBrief([scene])}`,
      })
    );
    const parsed = parseJsonLoose(raw);
    const obj = Array.isArray(parsed) ? parsed[0] : parsed;
    if (obj && typeof obj === "object") {
      const spec = sanitizeSlideSpec(obj);
      // The LLM cannot see the disk — reconcile photo art availability.
      if (spec.layout === "photo") spec.useImage = opts.hasImage;
      return { spec, source: "llm" };
    }
  } catch {
    // fall through to the deterministic planner
  }

  const spec = fallbackSlideForScene(scene, { hasImage: opts.hasImage, topic: ctx.topic });
  // Rotate the accent off the previous one so even the no-LLM path differs.
  const rotate: SlideAccent[] = ["yellow", "blue", "green", "red", "mono"];
  const prevIdx = previous ? rotate.indexOf(previous.accent) : -1;
  spec.accent = rotate[(prevIdx + 1 + rotate.length) % rotate.length];
  return { spec, source: "fallback" };
}

/**
 * Persist one re-designed slide back into slides.json (array is aligned with
 * the video's scene order, mirroring planSlides/render.ts). Returns the full
 * updated deck, or null when no deck exists yet (call planSlides first).
 */
export function saveSlideSpecAt(
  videoId: string,
  deckPosition: number,
  spec: SlideSpec
): SlideSpec[] | null {
  const deck = loadSlideDeck(videoId);
  if (!deck || deckPosition < 0 || deckPosition >= deck.length) return null;
  deck[deckPosition] = spec;
  fs.mkdirSync(videoDir(videoId), { recursive: true });
  fs.writeFileSync(slidesJsonPath(videoId), JSON.stringify(deck, null, 2));
  return deck;
}

// ---------------------------------------------------------------------------
// HTML composer (pure — unit-tested)
// ---------------------------------------------------------------------------

const ACCENT_HEX: Record<SlideAccent, string> = {
  yellow: "#FFC918",
  green: "#00A64F",
  red: "#FF3B30",
  blue: "#0A7CFF",
  mono: "#0D0D0F",
};

/** Headline size by text length — huge type is the whole point of the format. */
export function headlineFontPx(len: number): number {
  if (len <= 10) return 176;
  if (len <= 20) return 148;
  if (len <= 36) return 118;
  if (len <= 60) return 96;
  return 80;
}

const FONT_STACK =
  "'Carlito','Liberation Sans','Noto Sans SC',sans-serif";

const BASE_CSS = `
* { margin:0; padding:0; box-sizing:border-box; }
html,body { width:1080px; height:1920px; overflow:hidden; }
body {
  font-family:${FONT_STACK};
  color:#0D0D0F;
  background:
    radial-gradient(120% 90% at 50% 42%, #ffffff 0%, #f7f7f8 55%, #e9e9ec 100%);
  display:flex; flex-direction:column; align-items:center; justify-content:center;
  position:relative;
}
.stage { width:100%; height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center; padding:0 90px; position:relative; }
.badge {
  display:inline-block; background:var(--brand, ${ACCENT_HEX.yellow}); color:var(--brand-ink, #0D0D0F);
  font-weight:700; font-size:34px; letter-spacing:0.12em;
  padding:14px 40px; border-radius:999px; margin-bottom:56px;
}
.headline {
  font-weight:700; letter-spacing:-0.025em; line-height:1.04;
  text-align:center; text-wrap:balance;
}
.headline .accent { padding:2px 22px; border-radius:14px; }
.hl-yellow .accent, .hl .accent { background:var(--brand, ${ACCENT_HEX.yellow}); color:var(--brand-ink, #0D0D0F); }
.strike { text-decoration:line-through; text-decoration-color:${ACCENT_HEX.red}; text-decoration-thickness:14px; }
.brand-badge {
  position:absolute; top:54px; right:64px; height:76px; max-width:300px;
  object-fit:contain; object-position:right center;
}
.footer {
  font-size:30px; font-weight:600; letter-spacing:0.22em; text-transform:uppercase;
  color:#8B8B92; text-align:center; margin-top:48px;
}
.source {
  position:absolute; bottom:110px; left:0; right:0; text-align:center;
  font-size:26px; color:#A0A0A6; letter-spacing:0.02em;
}
.icon-wrap { margin-top:64px; }
.icon-wrap svg { width:440px; height:440px; display:block; margin:0 auto; }
.photo-card {
  margin-top:64px; width:880px; border-radius:48px; overflow:hidden;
  box-shadow:0 40px 90px rgba(13,13,15,0.14);
}
.photo-card img { width:100%; height:660px; object-fit:cover; display:block; }
.num { font-size:300px; font-weight:700; letter-spacing:-0.04em; line-height:0.95; text-align:center; font-variant-numeric:tabular-nums; }
.num .unit { font-size:96px; font-weight:600; color:#8B8B92; letter-spacing:0; margin-left:18px; }
.sub { font-size:34px; font-weight:600; letter-spacing:0.2em; text-transform:uppercase; color:#8B8B92; margin-top:56px; text-align:center; }
.bars { width:100%; max-width:860px; margin-top:88px; display:flex; flex-direction:column; gap:44px; }
.bar-row .bar-head { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:16px; }
.bar-row .bar-label { font-size:28px; font-weight:600; letter-spacing:0.16em; text-transform:uppercase; color:#8B8B92; }
.bar-row .bar-value { font-size:38px; font-weight:700; letter-spacing:0.02em; }
.bar-track { height:30px; border-radius:999px; background:#E6E6EA; overflow:hidden; }
.bar-fill { height:100%; border-radius:999px; background:#0D0D0F; }
.bar-fill.hot { background:var(--brand, ${ACCENT_HEX.red}); }
.spec-card {
  background:#101014; color:#fff; border-radius:56px; padding:88px 80px;
  width:100%; max-width:900px; display:flex; flex-direction:column; gap:56px; margin-top:72px;
}
.spec-card .card-title { font-size:30px; font-weight:600; letter-spacing:0.2em; text-transform:uppercase; color:#8E8E96; text-align:center; margin-bottom:8px; }
.spec-line .big { font-size:50px; font-weight:700; text-align:center; letter-spacing:-0.01em; }
.spec-line .small { font-size:32px; color:#9A9AA2; text-align:center; margin-top:10px; font-weight:400; }
.steps-card {
  background:#fff; border-radius:56px; padding:24px 64px; width:100%; max-width:900px;
  box-shadow:0 30px 80px rgba(13,13,15,0.10); margin-top:72px;
}
.step-row { display:flex; justify-content:space-between; align-items:center; padding:44px 8px; border-bottom:2px solid #EEEEF1; }
.step-row:last-child { border-bottom:none; }
.step-row .label { font-size:42px; font-weight:700; letter-spacing:-0.01em; }
.step-row .n { font-size:32px; color:#B4B4BA; font-weight:600; font-variant-numeric:tabular-nums; }
.price-chip {
  background:var(--brand, ${ACCENT_HEX.yellow}); border-radius:48px; padding:48px 88px;
  display:flex; flex-direction:column; align-items:center; margin-top:56px;
  box-shadow:0 30px 80px color-mix(in srgb, var(--brand, ${ACCENT_HEX.yellow}) 35%, transparent);
}
.price-chip .from { font-size:36px; font-weight:600; color:var(--brand-ink, #0D0D0F); opacity:0.75; }
.price-chip .value { font-size:104px; font-weight:700; letter-spacing:-0.02em; color:var(--brand-ink, #0D0D0F); line-height:1.05; }
`;

/** Minimal inline stroke pictograms (no assets, scale-free, print-crisp). */
const ICON_PATHS: Record<SlideIcon, string> = {
  laptop: `<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M2 19h20"/>`,
  phone: `<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>`,
  chip: `<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>`,
  gamepad: `<path d="M6 9h4M8 7v4"/><circle cx="16.5" cy="8.5" r="0.8"/><circle cx="18.5" cy="11" r="0.8"/><path d="M17.5 5h-11a4.5 4.5 0 0 0-4.4 5.4l.9 4.5A3 3 0 0 0 8 16l1.5-2h5L16 16a3 3 0 0 0 5-1.1l.9-4.5A4.5 4.5 0 0 0 17.5 5Z" transform="translate(0 3)"/>`,
  calendar: `<rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 10h18M8 2.5V6M16 2.5V6"/><rect x="7" y="13.5" width="4" height="4" rx="1" fill="currentColor" stroke="none"/>`,
  battery: `<rect x="2.5" y="8" width="17" height="9" rx="2.5"/><path d="M22 11v3"/><rect x="5" y="10.5" width="8" height="4" rx="1" fill="currentColor" stroke="none"/>`,
  flame: `<path d="M12 3s5.5 4.2 5.5 9a5.5 5.5 0 0 1-11 0c0-2 1-3.8 2-5 0 1.5.7 2.5 1.8 2.8C10 8 10.5 5 12 3Z"/>`,
  clock: `<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>`,
  cart: `<path d="M3 4h2.5l2.2 11.5a2 2 0 0 0 2 1.5h7.8a2 2 0 0 0 2-1.6L21 8H6"/><circle cx="10" cy="20" r="1.4"/><circle cx="17" cy="20" r="1.4"/>`,
  cloud: `<path d="M7 18a4.5 4.5 0 0 1-.4-9A6 6 0 0 1 18.3 10 3.8 3.8 0 0 1 17.5 18Z"/>`,
  bolt: `<path d="M13 2 4.5 13.5H11L9.5 22 19 10h-6.5Z"/>`,
  chart: `<path d="M4 20V4"/><path d="M4 20h16"/><rect x="7.5" y="12" width="3.5" height="5" rx="1" fill="currentColor" stroke="none"/><rect x="13" y="8" width="3.5" height="9" rx="1" fill="currentColor" stroke="none"/>`,
  dollar: `<circle cx="12" cy="12" r="9"/><path d="M12 7v10M15 8.8c-.6-1-1.7-1.4-3-1.4-1.6 0-2.8.8-2.8 2.1 0 2.9 5.8 1.5 5.8 4.4 0 1.3-1.2 2.1-3 2.1-1.4 0-2.6-.5-3.2-1.5"/>`,
  box: `<path d="m12 2.5 8.5 4.6v9.8L12 21.5l-8.5-4.6V7.1Z"/><path d="M3.5 7.1 12 11.7l8.5-4.6M12 11.7v9.8"/>`,
  lock: `<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3M12 14.5v2.5"/>`,
  wifi: `<path d="M2.5 9.5a14 14 0 0 1 19 0M6 13a9 9 0 0 1 12 0M9.5 16.4a4.3 4.3 0 0 1 5 0"/><circle cx="12" cy="19.3" r="1.2" fill="currentColor" stroke="none"/>`,
};

function iconSvg(icon: SlideIcon, accent: SlideAccent, brand: SlideBrand | null = null): string {
  // Brand kit: every accent-colored pictogram follows the brand accent; the
  // mono/ink default stays ink. Red keeps the flame's heat semantics ONLY
  // when no brand is set.
  const semantic = icon === "flame" ? ACCENT_HEX.red : icon === "bolt" ? ACCENT_HEX.yellow : "#0D0D0F";
  const stroke = brand?.accentHex && accent !== "mono" ? brand.accentHex : semantic;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[icon]}</svg>`;
}

/** Escape text for HTML interpolation (headlines are user/LLM text). */
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Wrap the accent word in its span (or highlight the whole headline). */
export function renderHeadline(spec: SlideSpec, brand: SlideBrand | null = null): string {
  const h = esc(spec.headline);
  const cls = spec.highlight ? "hl" : "";
  // Brand kit: the accent color collapses to the brand hex (mono stays ink).
  const accentHex =
    brand?.accentHex && spec.accent !== "mono" ? brand.accentHex : ACCENT_HEX[spec.accent];
  if (spec.accentWord) {
    const target = spec.accentWord.toLowerCase();
    // Find the word in the ALREADY-ESCAPED headline (escapes never create or
    // destroy the plain words, so a case-insensitive indexOf is safe here).
    const idx = h.toLowerCase().indexOf(esc(spec.accentWord).toLowerCase());
    if (idx >= 0) {
      const wordEsc = h.slice(idx, idx + spec.accentWord.length);
      const color = spec.highlight ? "" : `color:${accentHex};`;
      return h.replace(
        wordEsc,
        `<span class="accent ${cls}" style="${color}">${wordEsc}</span>`
      );
    }
  }
  if (spec.highlight) {
    const ink = brand?.accentHex ? readableInk(brand.accentHex) : spec.accent === "yellow" || spec.accent === "mono" ? "#0D0D0F" : "#fff";
    return `<span class="accent" style="background:${accentHex};color:${ink}">${h}</span>`;
  }
  return h;
}

function barsHtml(spec: SlideSpec): string {
  if (!spec.bars.length) return "";
  return `<div class="bars">${spec.bars
    .map(
      (b) => `<div class="bar-row">
        <div class="bar-head"><span class="bar-label">${esc(b.label)}</span><span class="bar-value">${esc(b.valueText)}</span></div>
        <div class="bar-track"><div class="bar-fill${b.highlight ? " hot" : ""}" style="width:${Math.round(b.weight * 100)}%"></div></div>
      </div>`
    )
    .join("")}</div>`;
}

/** spec → complete standalone HTML document at 1080x1920. */
export function slideHtml(
  spec: SlideSpec,
  imageUrl: string | null = null,
  brand: SlideBrand | null = null
): string {
  const badge = spec.badge ? `<div class="badge">${esc(spec.badge)}</div>` : "";
  const footer = spec.footer ? `<div class="footer">${esc(spec.footer)}</div>` : "";
  const source = spec.source ? `<div class="source">${esc(spec.source)}</div>` : "";
  const logo = brand?.logoUrl ? `<img class="brand-badge" src="${esc(brand.logoUrl)}" alt=""/>` : "";
  const headlineStyle = `font-size:${headlineFontPx(spec.headline.length)}px;`;
  const headline = `<div class="headline${spec.strike ? " strike" : ""}" style="${headlineStyle}">${renderHeadline(spec, brand)}</div>`;

  let focal = "";
  if (spec.layout === "icon" && spec.icon) {
    focal = `<div class="icon-wrap">${iconSvg(spec.icon, spec.accent, brand)}</div>`;
  } else if (spec.layout === "photo" && imageUrl) {
    focal = `<div class="photo-card"><img src="${esc(imageUrl)}"/></div>`;
  } else if ((spec.layout === "counter" || spec.layout === "bars") && spec.number) {
    const num = esc(spec.number);
    focal = `<div class="num">${num}${spec.unit ? `<span class="unit">${esc(spec.unit)}</span>` : ""}</div>
      ${spec.subLabel ? `<div class="sub">${esc(spec.subLabel)}</div>` : ""}
      ${barsHtml(spec)}`;
  } else if (spec.layout === "card" && spec.cardLines.length) {
    focal = `<div class="spec-card">
      ${spec.cardTitle ? `<div class="card-title">${esc(spec.cardTitle)}</div>` : ""}
      ${spec.cardLines.map((l) => `<div class="spec-line"><div class="big">${esc(l.big)}</div>${l.small ? `<div class="small">${esc(l.small)}</div>` : ""}</div>`).join("")}
    </div>`;
  } else if (spec.layout === "steps" && spec.steps.length) {
    focal = `<div class="steps-card">${spec.steps
      .map((s) => `<div class="step-row"><span class="label">${esc(s.label)}</span><span class="n">${esc(s.n)}</span></div>`)
      .join("")}</div>`;
  } else if (spec.layout === "price" && spec.priceValue) {
    focal = `<div class="price-chip">
      ${spec.priceLabel ? `<div class="from">${esc(spec.priceLabel)}</div>` : ""}
      <div class="value">${esc(spec.priceValue)}</div>
    </div>
    ${spec.icon ? `<div class="icon-wrap" style="margin-top:72px">${iconSvg(spec.icon, spec.accent, brand)}</div>` : ""}`;
  }

  // Layouts whose focal element is missing degrade to a statement slide —
  // a beat must never render as just a floating label.
  const effective = focal ? spec.layout : "statement";

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>${brandCssVars(brand)}${BASE_CSS}</style></head>
<body data-layout="${effective}">
${logo}
<div class="stage">
  ${badge}
  ${headline}
  ${focal}
  ${footer}
</div>
${source}
</body></html>`;
}

// ---------------------------------------------------------------------------
// PNG renderer (Playwright + bundled Chromium)
// ---------------------------------------------------------------------------

const SLIDE_VIEWPORT = { width: 1080, height: 1920 };
const SLIDE_SCALE = 2; // 2160x3840 — matches the Ken Burns supersample canvas

export function slidePngPath(videoId: string, sceneIndex: number): string {
  return path.join(videoDir(videoId), `slide-${String(sceneIndex).padStart(2, "0")}.png`);
}

/** The rendered slide PNG (what viewers actually see), null before a render. */
export function readSlideImage(videoId: string, sceneIndex: number): Buffer | null {
  try {
    return fs.readFileSync(slidePngPath(videoId, sceneIndex));
  } catch {
    return null;
  }
}

/** Delete every cached slide PNG — brand/art changes re-screenshot at render. */
export function invalidateSlidePngs(videoId: string): void {
  const dir = videoDir(videoId);
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    if (/^slide-\d{2}\.png$/.test(f)) fs.rmSync(path.join(dir, f), { force: true });
  }
}

/**
 * Screenshot the deck. One browser for the whole batch (launch is ~300 ms);
 * each slide is an isolated page so a broken spec can't poison the rest.
 * Items pair each spec with its scene (PNG cache key = scene index, matching
 * the scene-NN.png art naming). Returns the list of written PNG paths.
 * `brand` recolors accents + stamps the logo badge into every composed HTML.
 *
 * The HTML is written to a temp file next to the art and OPENED via file://
 * (page.goto) instead of setContent: Chromium blocks file:// subresources on
 * about:blank pages, which silently blanked the brand logo AND the photo-
 * layout scene art. file → file image loads are allowed.
 */
export async function renderSlidePngs(
  videoId: string,
  items: { scene: Scene; spec: SlideSpec }[],
  opts: {
    force?: boolean;
    brand?: SlideBrand | null;
    onProgress?: (done: number, total: number, label: string) => void;
  } = {}
): Promise<string[]> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const written: string[] = [];
  const tmpHtml = path.join(videoDir(videoId), `slide-tmp-${Date.now()}.html`);
  try {
    const context = await browser.newContext({
      viewport: SLIDE_VIEWPORT,
      deviceScaleFactor: SLIDE_SCALE,
    });
    for (const [i, { scene, spec }] of items.entries()) {
      opts.onProgress?.(i, items.length, `Designing slide ${i + 1} of ${items.length}`);
      const outPath = slidePngPath(videoId, scene.index);
      // Cache: slide-NN.png is keyed by scene index — reuse unless forced.
      if (!opts.force && fs.existsSync(outPath) && fs.statSync(outPath).size > 10_000) {
        written.push(outPath);
        continue;
      }
      const imageUrl = spec.useImage
        ? `file://${path.join(videoDir(videoId), `scene-${String(scene.index).padStart(2, "0")}.png`)}`
        : null;
      fs.mkdirSync(videoDir(videoId), { recursive: true });
      fs.writeFileSync(tmpHtml, slideHtml(spec, imageUrl, opts.brand ?? null));
      const page = await context.newPage();
      await page.goto(`file://${tmpHtml}`, { waitUntil: "load" });
      await page.waitForTimeout(30); // font shaping settle
      await page.screenshot({ path: outPath, clip: { x: 0, y: 0, width: 1080, height: 1920 } });
      await page.close();
      written.push(outPath);
    }
  } finally {
    fs.rmSync(tmpHtml, { force: true });
    await browser.close();
  }
  return written;
}

// ---------------------------------------------------------------------------
// Slide motion — gentle push-ins, rehooks get the punch
// ---------------------------------------------------------------------------

/**
 * Camera plan for one slide: a slow center push (the format's signature
 * breathing motion). Rehook beats open with a punch; the user's intensity
 * is halved — slides already carry visual energy through their cuts.
 * Zoom-only: pans have zero travel room at z=1 on a full-bleed slide.
 */
export function slideMotionPlan(scene: Scene, settings: MotionSettings): MotionScenePlan {
  const off = settings.mode === "off";
  const amp = Math.max(0.02, (settings.intensity / 100) * 0.5);
  if (off) {
    return { sceneType: "standard", move: "Static hold", shots: [{ kind: "hold", zStart: 1, zEnd: 1, focal: FOCAL_CENTER, travel: 0, sec: 99 }], staticImage: true };
  }
  if (scene.rehook) {
    return { sceneType: "standard", move: "Punch-in", shots: [{ kind: "punch", zStart: 1, zEnd: 1 + amp * 1.4, focal: FOCAL_CENTER, travel: 0, sec: 99 }], staticImage: false };
  }
  const zoomOut = scene.index % 3 === 0; // every third beat breathes the other way
  return {
    sceneType: "standard",
    move: zoomOut ? "Slow pull-back" : "Gentle push",
    shots: [{ kind: zoomOut ? "zoom-out" : "zoom-in", zStart: zoomOut ? 1 + amp : 1, zEnd: zoomOut ? 1 : 1 + amp, focal: FOCAL_CENTER, travel: 0, sec: 99 }],
    staticImage: false,
  };
}

// ---------------------------------------------------------------------------
// Segment filter graph (single-frame input)
// ---------------------------------------------------------------------------

/**
 * Visual filter graph for one slide segment. The PNG enters ONCE (no
 * `-loop 1`): each shot branch takes the still and lets zoompan `d` emit
 * exactly its share of frames. This is the canonical stills-zoompan shape —
 * it also sidesteps a teardown deadlock this ffmpeg build hits when the
 * 2160x3840 PNG is decoded through the looped-image demuxer. The shot math
 * (zoom easing, focal anchoring, punch attack) is motion.ts's own builder.
 */
export function slideSegmentGraph(opts: {
  dur: number;
  plan: MotionScenePlan;
  settings: MotionSettings;
  fps: number;
}): string {
  const out = OUTPUT_SIZES["9:16"].out;
  // 1.5x supersample (not the Ken Burns 2x): slides only push <= 7% zoom on
  // vector-crisp PNGs — 1620x2880 keeps text clean while zoompan (which is
  // single-threaded and cost-dominated by input area) runs ~2x faster.
  const work: [number, number] = [1620, 2880];
  const { plan, settings } = opts;
  const [W, H] = work;
  const [ow, oh] = out;
  const fps = opts.fps;
  const totalFrames = Math.max(Math.round(opts.dur * fps), 2);
  const shotCount = Math.max(1, plan.shots.length);

  // Split the frame budget across shots (slides normally ship exactly one).
  const per = Math.max(Math.floor(totalFrames / shotCount), 2);
  const frames = Array.from({ length: shotCount }, (_, i) =>
    i === shotCount - 1 ? Math.max(totalFrames - per * (shotCount - 1), 2) : per
  );

  const cover = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1`;
  if (shotCount === 1) {
    const zp = zoompanForShot(plan.shots[0], frames[0], opts.settings, work, out, fps, frames[0]);
    return `[0:v]${cover},${zp},format=yuv420p[v]`;
  }

  const parts: string[] = [`[0:v]${cover},split=${shotCount}${plan.shots.map((_, i) => `[s${i}]`).join("")}`];
  plan.shots.forEach((shot, i) => {
    const zp = zoompanForShot(shot, frames[i], opts.settings, work, out, fps, frames[i]);
    parts.push(`[s${i}]${zp},format=yuv420p[v${i}]`);
  });
  parts.push(`${plan.shots.map((_, i) => `[v${i}]`).join("")}concat=n=${shotCount}:v=1:a=0[v]`);
  return parts.join(";");
}
