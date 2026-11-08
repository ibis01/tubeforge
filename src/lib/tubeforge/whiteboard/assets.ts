// S64 — the Whiteboard Engine: the starter vector asset library.
//
// Hand-authored SVG, each drawable element carrying a stable id. Drawing
// order = document order (the scheduler's default). All assets run through
// sanitizeSvg on load — trusted or not, the gate applies (the security
// law is a property of the PIPELINE, not of the caller's mood).
//
// The library is intentionally small in P0 (the benchmark set + generics);
// the categorized education/science/business/history library is the
// dedicated asset phase (plan §C / Phase 2). Coordinates are asset-space
// (see each viewBox); the scene places them via Placement.
import { countPathCommands, sanitizeSvg } from "./svg";
import { TEXT_CHARS_BY_ID, TEXT_IDS_BY_ASSET, TEXT_ANCHORS } from "./timing";
import { validWhiteboardId } from "./storyboard";

export interface WhiteboardAsset {
  id: string;
  /** Sanitized SVG markup (a fragment usable inside a <g>). */
  svg: string;
  viewBox: { w: number; h: number };
  tags: string[];
}

const A = (
  id: string,
  viewBox: { w: number; h: number },
  tags: string[],
  svg: string
): WhiteboardAsset => ({ id, viewBox, tags, svg: sanitizeSvg(svg) });

// ---------------------------------------------------------------------------
// The benchmark set — "How Your Heart Works"
// ---------------------------------------------------------------------------

const HEART_OUTLINE =
  "M 100 62 C 74 26, 24 44, 24 94 C 24 136, 62 162, 100 184 C 138 162, 176 136, 176 94 C 176 44, 126 26, 100 62 Z";

export const ASSETS: WhiteboardAsset[] = [
  A("heart-main", { w: 200, h: 200 }, ["science", "heart", "benchmark"], `
    <path id="hm-outline" d="${HEART_OUTLINE}" fill="#e63946" fill-opacity="0" stroke="#1d3557" stroke-width="5" stroke-linecap="round"/>
    <path id="hm-aorta" d="M 96 44 C 92 22, 112 8, 130 16 C 148 24, 150 46, 136 56" fill="none" stroke="#1d3557" stroke-width="4.5" stroke-linecap="round"/>
    <path id="hm-pulmonary" d="M 116 42 C 124 24, 146 18, 158 30" fill="none" stroke="#457b9d" stroke-width="4.5" stroke-linecap="round"/>
    <path id="hm-septum" d="M 100 62 C 96 100, 96 140, 100 184" fill="none" stroke="#1d3557" stroke-width="4" stroke-linecap="round"/>
    <path id="hm-chamber-r" d="M 34 96 C 56 88, 80 90, 96 100" fill="none" stroke="#457b9d" stroke-width="3.5" stroke-linecap="round"/>
    <path id="hm-chamber-l" d="M 104 100 C 122 90, 146 88, 166 96" fill="none" stroke="#e63946" stroke-width="3.5" stroke-linecap="round"/>
  `),
  A("heart-labels", { w: 200, h: 200 }, ["science", "heart", "labels"], `
    <text id="hl-ra" x="34" y="120" font-family="DejaVu Sans, sans-serif" font-size="22" fill="#457b9d" font-weight="bold">RA</text>
    <text id="hl-rv" x="40" y="164" font-family="DejaVu Sans, sans-serif" font-size="22" fill="#457b9d" font-weight="bold">RV</text>
    <text id="hl-la" x="150" y="120" font-family="DejaVu Sans, sans-serif" font-size="22" fill="#e63946" font-weight="bold">LA</text>
    <text id="hl-lv" x="144" y="164" font-family="DejaVu Sans, sans-serif" font-size="22" fill="#e63946" font-weight="bold">LV</text>
    <text id="hl-septum" x="88" y="52" font-family="DejaVu Sans, sans-serif" font-size="15" fill="#1d3557">septum</text>
  `),
  A("lungs", { w: 200, h: 200 }, ["science", "lungs"], `
    <path id="lg-trachea" d="M 100 12 L 100 48" fill="none" stroke="#1d3557" stroke-width="5" stroke-linecap="round"/>
    <path id="lg-left" d="M 100 48 C 74 52, 52 74, 44 110 C 38 146, 52 174, 76 170 C 96 166, 100 140, 100 108 Z" fill="#a8dadc" fill-opacity="0" stroke="#457b9d" stroke-width="4.5" stroke-linecap="round"/>
    <path id="lg-right" d="M 100 48 C 126 52, 148 74, 156 110 C 162 146, 148 174, 124 170 C 104 166, 100 140, 100 108 Z" fill="#a8dadc" fill-opacity="0" stroke="#457b9d" stroke-width="4.5" stroke-linecap="round"/>
  `),
  A("ecg-pulse", { w: 400, h: 120 }, ["science", "ecg", "pulse"], `
    <path id="ecg-line" d="M 8 70 L 90 70 L 106 42 L 124 98 L 142 24 L 160 112 L 178 70 L 392 70" fill="none" stroke="#e63946" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>
  `),
  A("spark", { w: 120, h: 120 }, ["science", "spark", "energy"], `
    <path id="sp-1" d="M 60 14 L 60 42" fill="none" stroke="#e9c46a" stroke-width="5" stroke-linecap="round"/>
    <path id="sp-2" d="M 26 28 L 42 48" fill="none" stroke="#e9c46a" stroke-width="5" stroke-linecap="round"/>
    <path id="sp-3" d="M 94 28 L 78 48" fill="none" stroke="#e9c46a" stroke-width="5" stroke-linecap="round"/>
    <path id="sp-4" d="M 18 62 L 44 62" fill="none" stroke="#e9c46a" stroke-width="5" stroke-linecap="round"/>
    <path id="sp-5" d="M 102 62 L 76 62" fill="none" stroke="#e9c46a" stroke-width="5" stroke-linecap="round"/>
    <path id="sp-core" d="M 53 62 A 7 7 0 1 0 67 62 A 7 7 0 1 0 53 62 Z" fill="none" stroke="#e9c46a" stroke-width="5" stroke-linecap="round"/>
  `),
  A("arrow-curve", { w: 200, h: 200 }, ["generic", "arrow", "flow"], `
    <path id="ac-stem" d="M 30 170 C 40 100, 90 60, 160 44" fill="none" stroke="#1d3557" stroke-width="5" stroke-linecap="round"/>
    <path id="ac-head" d="M 138 28 L 164 43 L 148 68" fill="none" stroke="#1d3557" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
  `),
  A("arrow-return", { w: 200, h: 200 }, ["generic", "arrow", "flow", "return"], `
    <path id="ar-stem" d="M 30 170 C 40 100, 90 60, 160 44" fill="none" stroke="#457b9d" stroke-width="5" stroke-linecap="round"/>
    <path id="ar-head" d="M 138 28 L 164 43 L 148 68" fill="none" stroke="#457b9d" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
  `),
  A("title-hero", { w: 800, h: 200 }, ["generic", "title"], `
    <text id="th-line1" x="60" y="92" font-family="DejaVu Sans, sans-serif" font-size="76" fill="#1d3557" font-weight="bold">How Your Heart</text>
    <text id="th-line2" x="60" y="176" font-family="DejaVu Sans, sans-serif" font-size="76" fill="#1d3557" font-weight="bold">Works</text>
    <path id="th-underline" d="M 60 190 C 200 178, 420 198, 560 186" fill="none" stroke="#e63946" stroke-width="6" stroke-linecap="round"/>
  `),
  A("close-card", { w: 800, h: 220 }, ["generic", "close", "stat"], `
    <text id="cc-big" x="60" y="110" font-family="DejaVu Sans, sans-serif" font-size="84" fill="#1d3557" font-weight="bold">60-100</text>
    <text id="cc-small" x="60" y="164" font-family="DejaVu Sans, sans-serif" font-size="40" fill="#457b9d">beats every minute</text>
    <path id="cc-box" d="M 48 34 L 48 190 L 640 190 L 640 34 Z" fill="none" stroke="#e63946" stroke-width="5" stroke-linecap="round"/>
  `),
  // The drawing hand: a marker held in a stylized hand. The marker tip is
  // the asset's anchor: (70, 150). The renderer translates the hand so the
  // TIP lands on the path point (asset inner translate −tip) and applies a
  // gentle fixed tilt + wobble — the hand FOLLOWS the true path point at
  // every frame (the plan's hard requirement); the tilt is aesthetic only.
  A("hand-marker", { w: 140, h: 170 }, ["hand", "marker"], `
    <path id="hd-nib" d="M 70 150 L 60 126 L 80 126 Z" fill="#1d3557" stroke="none"/>
    <path id="hd-body" d="M 60 126 L 80 126 L 82 66 L 58 66 Z" fill="#e63946" stroke="#1d3557" stroke-width="3"/>
    <path id="hd-band" d="M 58 66 L 82 66 L 84 50 L 56 50 Z" fill="#1d3557" stroke="none"/>
    <path id="hd-cap" d="M 56 50 L 84 50 L 84 38 L 56 38 Z" fill="#457b9d" stroke="#1d3557" stroke-width="3"/>
    <path id="hd-fingers" d="M 82 118 C 108 110, 118 82, 108 56 C 102 40, 88 34, 78 38 L 80 52 C 94 52, 100 66, 98 82 C 96 98, 90 106, 82 104 Z" fill="#f1faee" stroke="#1d3557" stroke-width="3.5"/>
    <path id="hd-thumb" d="M 60 106 C 46 102, 38 88, 46 78 C 51 71, 60 72, 64 78" fill="none" stroke="#1d3557" stroke-width="3.5" stroke-linecap="round"/>
    <path id="hd-palm" d="M 84 52 C 96 54, 102 62, 100 72" fill="none" stroke="#1d3557" stroke-width="3" stroke-linecap="round"/>
  `),
];

/** The marker tip anchor of the drawing-hand asset (asset-space). */
export const HAND_TIP = { x: 70, y: 150 } as const;

// ---------------------------------------------------------------------------
// Extraction + registration
// ---------------------------------------------------------------------------

export interface ExtractedAsset {
  asset: WhiteboardAsset;
  /** Drawable path elements: id + raw path data (document order = draw order). */
  paths: { id: string; d: string }[];
  /** Text elements: id + visible content + anchor. */
  texts: { id: string; content: string; x: number; y: number; size: number }[];
  /** S65 (E1): elements excluded from the drawable index, with the budget
   *  law each one broke — surfaced for diagnostics instead of silently
   *  shrinking the drawable set (the E11 upload path rejects outright). */
  rejected: { kind: "path" | "text"; id: string; reason: "id-charset" | "path-commands" }[];
}

/** S65 (E1): per-path command budget, counted as EXPANDED commands through
 *  the real grammar (svg.ts countPathCommands — implicit repeats count),
 *  so a polyline of 10,000 implicit points counts as 10,000 — the
 *  flattening cost the timing engine and the rasterizer would both pay
 *  per frame. */
export const WB_PATH_COMMAND_BUDGET = 512;

/** Extract drawable elements from an asset's markup (trusted, well-formed
 *  library markup — regex extraction; the sanitizer already ran on load).
 *  S65: the id-charset law and the per-path command budget apply HERE —
 *  an element that breaks either never reaches the drawable index, so no
 *  project event can address it and the renderer's namespace seam
 *  (`${assetId}--${pathId}` DOM ids, `assetId::pathId` frame-plan keys)
 *  can never be fed a corrupting id. */
export function extractAsset(asset: WhiteboardAsset): ExtractedAsset {
  const paths: { id: string; d: string }[] = [];
  const texts: ExtractedAsset["texts"] = [];
  const rejected: ExtractedAsset["rejected"] = [];
  const pathRe = /<path\b[^>]*>/g;
  for (const m of asset.svg.matchAll(pathRe)) {
    const tag = m[0];
    // Attribute-anchored regexes (\s prefix): a bare /d="…"/ would match
    // the tail of id="…" and extract the id as path data.
    const id = /\sid="([^"]+)"/.exec(tag)?.[1];
    const d = /\sd="([^"]+)"/.exec(tag)?.[1];
    if (!id || !d) continue;
    if (!validWhiteboardId(id)) {
      rejected.push({ kind: "path", id, reason: "id-charset" });
      continue;
    }
    if (countPathCommands(d) > WB_PATH_COMMAND_BUDGET) {
      rejected.push({ kind: "path", id, reason: "path-commands" });
      continue;
    }
    paths.push({ id, d });
  }
  for (const m of asset.svg.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)) {
    const attrs = m[1];
    const content = m[2].trim();
    const id = /\sid="([^"]+)"/.exec(attrs)?.[1];
    if (!id || !content) continue;
    if (!validWhiteboardId(id)) {
      rejected.push({ kind: "text", id, reason: "id-charset" });
      continue;
    }
    texts.push({
      id,
      content,
      x: Number(/\sx="([-\d.]+)"/.exec(attrs)?.[1] ?? 0),
      y: Number(/\sy="([-\d.]+)"/.exec(attrs)?.[1] ?? 0),
      size: Number(/\sfont-size="([-\d.]+)"/.exec(attrs)?.[1] ?? 32),
    });
  }
  return { asset, paths, texts, rejected };
}

/** Load + register the library: sanitize (already at construction), extract,
 *  and feed the pure scheduler's text registries. */
export function loadLibrary(): {
  assets: Map<string, WhiteboardAsset>;
  extracted: Map<string, ExtractedAsset>;
  libraryIndex: {
    assetIds: Set<string>;
    pathIdsByAsset: Map<string, Set<string>>;
    textIdsByAsset: Map<string, Set<string>>;
  };
} {
  const assets = new Map<string, WhiteboardAsset>();
  const extracted = new Map<string, ExtractedAsset>();
  const pathIdsByAsset = new Map<string, Set<string>>();
  const textIdsByAsset = new Map<string, Set<string>>();
  for (const a of ASSETS) {
    if (assets.has(a.id)) throw new Error(`duplicate whiteboard asset id: ${a.id}`);
    const ex = extractAsset(a);
    assets.set(a.id, a);
    extracted.set(a.id, ex);
    pathIdsByAsset.set(a.id, new Set(ex.paths.map((p) => p.id)));
    textIdsByAsset.set(a.id, new Set(ex.texts.map((t) => t.id)));
    // Register the pure scheduler's text metadata.
    TEXT_IDS_BY_ASSET.set(a.id, ex.texts.map((t) => t.id));
    for (const t of ex.texts) {
      TEXT_CHARS_BY_ID.set(`${a.id}::${t.id}`, t.content.length);
      TEXT_ANCHORS.set(`${a.id}::${t.id}`, { x: t.x, y: t.y, size: t.size });
    }
  }
  return {
    assets,
    extracted,
    libraryIndex: { assetIds: new Set(assets.keys()), pathIdsByAsset, textIdsByAsset },
  };
}
