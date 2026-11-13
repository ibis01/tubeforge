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
import { validateAsset } from "./asset-validate";

/** W3 (reconciliation §5.3): the role an asset plays in the stroke
 *  grammar — advisory metadata the validator (and later the W4/W5/W7
 *  schedulers) read when present. Optional + tolerant-read: parsers and
 *  docs written before W3 ignore these fields entirely. */
export type AssetRole = "outline" | "fill" | "label" | "arrow" | "emphasis";

export interface WhiteboardAsset {
  id: string;
  /** Sanitized SVG markup (a fragment usable inside a <g>). */
  svg: string;
  viewBox: { w: number; h: number };
  tags: string[];
  /** W3 additive metadata — all optional, ignored by old parsers. */
  role?: AssetRole;
  /** Pen groups: groupId → member path ids. One group, one pen —
   *  the validator pins stroke-width/linecap consistency inside. */
  penGroups?: Record<string, string[]>;
  /** Explicit path draw order (default: document order). */
  drawOrder?: string[];
  /** Per-asset duration weight for the fill law's W4 successor. */
  durWeight?: number;
  /** Placement framing hint for the W5 camera director. */
  framing?: { pad?: number };
  /** Alternative match names the W2 mention matcher may consult. */
  alts?: string[];
  /** Accessibility description (screen readers, alt text). */
  a11y?: string;
}

const A = (
  id: string,
  viewBox: { w: number; h: number },
  tags: string[],
  svg: string,
  meta: Partial<Pick<WhiteboardAsset, "role" | "penGroups" | "drawOrder" | "durWeight" | "framing" | "alts" | "a11y">> = {}
): WhiteboardAsset => ({ id, viewBox, tags, svg: sanitizeSvg(svg), ...meta });

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
  `, { role: "arrow" }),
  A("arrow-return", { w: 200, h: 200 }, ["generic", "arrow", "flow", "return"], `
    <path id="ar-stem" d="M 30 170 C 40 100, 90 60, 160 44" fill="none" stroke="#457b9d" stroke-width="5" stroke-linecap="round"/>
    <path id="ar-head" d="M 138 28 L 164 43 L 148 68" fill="none" stroke="#457b9d" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
  `, { role: "arrow" }),
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
  // ---------------------------------------------------------------------------
  // S67 — the E2 reconciliation port: eight concept assets from the archived
  // prototype library (contrib/whiteboard-e2, shapes preserved). Two honest
  // adaptations, both recorded in docs/audits/s67-…record.md:
  //   1. Ink recolored to the house palette (#1d3557, accents #e63946 /
  //      #457b9d / #e9c46a) so the library sits beside the benchmark set —
  //      the prototype's near-black #111827 read as a different pen.
  //   2. Every path is a SINGLE subpath: the prototype packed multi-M paths
  //      (growth-axis, chart-axis, coin-dollar, bulb-screw), but the S64
  //      dash-reveal + hand-follow geometry is benchmark-proven on
  //      single-subpath paths only (a mid-path M teleports the hand). The
  //      split is semantic, not cosmetic — each subpath becomes its own
  //      drawable the scheduler times separately.
  // ---------------------------------------------------------------------------
  A("arrow-growth", { w: 200, h: 200 }, ["business", "growth", "trend", "up", "arrow"], `
    <path id="ag-axis-y" d="M 30 170 L 30 40" fill="none" stroke="#1d3557" stroke-width="6" stroke-linecap="round"/>
    <path id="ag-axis-x" d="M 30 170 L 170 170" fill="none" stroke="#1d3557" stroke-width="6" stroke-linecap="round"/>
    <path id="ag-line" d="M 40 150 L 70 120 L 100 130 L 140 70" fill="none" stroke="#1d3557" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
    <path id="ag-head" d="M 130 60 L 150 60 L 150 80" fill="none" stroke="#e63946" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
  `, { role: "arrow" }),
  A("bar-chart", { w: 200, h: 200 }, ["business", "data", "chart", "stat", "graph"], `
    <path id="bc-axis-y" d="M 30 170 L 30 30" fill="none" stroke="#1d3557" stroke-width="6" stroke-linecap="round"/>
    <path id="bc-axis-x" d="M 30 170 L 180 170" fill="none" stroke="#1d3557" stroke-width="6" stroke-linecap="round"/>
    <path id="bc-bar1" d="M 50 130 L 80 130 L 80 170 L 50 170 Z" fill="none" stroke="#1d3557" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
    <path id="bc-bar2" d="M 90 110 L 120 110 L 120 170 L 90 170 Z" fill="none" stroke="#1d3557" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
    <path id="bc-bar3" d="M 130 70 L 160 70 L 160 170 L 130 170 Z" fill="none" stroke="#1d3557" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
    <path id="bc-trend" d="M 60 100 L 90 80 L 130 50" fill="none" stroke="#e63946" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
  `),
  A("check-badge", { w: 200, h: 200 }, ["business", "check", "done", "quality", "verified"], `
    <path id="cb-outer" d="M 100 25 L 115 35 L 130 30 L 138 45 L 155 50 L 152 67 L 165 80 L 155 93 L 162 110 L 145 117 L 145 135 L 128 135 L 120 150 L 105 142 L 90 152 L 82 137 L 65 137 L 65 120 L 48 113 L 55 97 L 45 82 L 60 70 L 55 53 L 72 48 L 78 33 L 95 38 Z" fill="none" stroke="#1d3557" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
    <path id="cb-check" d="M 75 95 L 95 115 L 130 75" fill="none" stroke="#e63946" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
  `),
  A("clock", { w: 200, h: 200 }, ["time", "clock", "deadline", "schedule"], `
    <path id="cl-outer" d="M 100 30 C 60 30 30 60 30 100 C 30 140 60 170 100 170 C 140 170 170 140 170 100 C 170 60 140 30 100 30 Z" fill="none" stroke="#1d3557" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
    <path id="cl-tick12" d="M 100 40 L 100 55" fill="none" stroke="#1d3557" stroke-width="6" stroke-linecap="round"/>
    <path id="cl-tick3" d="M 160 100 L 145 100" fill="none" stroke="#1d3557" stroke-width="6" stroke-linecap="round"/>
    <path id="cl-tick6" d="M 100 160 L 100 145" fill="none" stroke="#1d3557" stroke-width="6" stroke-linecap="round"/>
    <path id="cl-tick9" d="M 40 100 L 55 100" fill="none" stroke="#1d3557" stroke-width="6" stroke-linecap="round"/>
    <path id="cl-hour" d="M 100 100 L 100 70" fill="none" stroke="#457b9d" stroke-width="6" stroke-linecap="round"/>
    <path id="cl-minute" d="M 100 100 L 130 100" fill="none" stroke="#e63946" stroke-width="6" stroke-linecap="round"/>
  `),
  A("coin", { w: 200, h: 200 }, ["money", "coin", "cost", "price", "revenue"], `
    <path id="cn-outer" d="M 100 30 C 60 30 30 60 30 100 C 30 140 60 170 100 170 C 140 170 170 140 170 100 C 170 60 140 30 100 30 Z" fill="none" stroke="#1d3557" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
    <path id="cn-inner" d="M 100 50 C 70 50 50 70 50 100 C 50 130 70 150 100 150 C 130 150 150 130 150 100 C 150 70 130 50 100 50 Z" fill="none" stroke="#1d3557" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
    <path id="cn-dollar-stem" d="M 100 70 L 100 130" fill="none" stroke="#e9c46a" stroke-width="6" stroke-linecap="round"/>
    <path id="cn-dollar-s" d="M 85 85 C 85 75 95 70 100 75 C 105 70 115 75 115 85 C 115 95 105 95 100 100 C 95 105 85 105 85 115 C 85 125 95 130 100 125 C 105 130 115 125 115 115" fill="none" stroke="#e9c46a" stroke-width="6" stroke-linecap="round"/>
  `),
  A("globe", { w: 200, h: 200 }, ["world", "global", "internet", "international"], `
    <path id="gl-outer" d="M 100 30 C 60 30 30 60 30 100 C 30 140 60 170 100 170 C 140 170 170 140 170 100 C 170 60 140 30 100 30 Z" fill="none" stroke="#1d3557" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
    <path id="gl-equator" d="M 30 100 L 170 100" fill="none" stroke="#1d3557" stroke-width="6" stroke-linecap="round"/>
    <path id="gl-meridian" d="M 100 30 L 100 170" fill="none" stroke="#1d3557" stroke-width="6" stroke-linecap="round"/>
    <path id="gl-arc-west" d="M 60 50 C 80 80 80 120 60 150" fill="none" stroke="#457b9d" stroke-width="6" stroke-linecap="round"/>
    <path id="gl-arc-east" d="M 140 50 C 120 80 120 120 140 150" fill="none" stroke="#457b9d" stroke-width="6" stroke-linecap="round"/>
  `),
  A("lightbulb", { w: 200, h: 200 }, ["idea", "innovation", "insight", "think"], `
    <path id="lb-glass" d="M 100 30 C 60 30 40 70 60 110 C 70 125 70 140 70 150 L 130 150 C 130 140 130 125 140 110 C 160 70 140 30 100 30 Z" fill="none" stroke="#1d3557" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
    <path id="lb-filament" d="M 80 90 C 80 70 90 60 100 70 C 110 60 120 70 120 90" fill="none" stroke="#e9c46a" stroke-width="6" stroke-linecap="round"/>
    <path id="lb-screw-1" d="M 75 160 L 125 160" fill="none" stroke="#1d3557" stroke-width="6" stroke-linecap="round"/>
    <path id="lb-screw-2" d="M 78 170 L 122 170" fill="none" stroke="#1d3557" stroke-width="6" stroke-linecap="round"/>
    <path id="lb-screw-3" d="M 82 180 L 118 180" fill="none" stroke="#1d3557" stroke-width="6" stroke-linecap="round"/>
  `),
  A("rocket", { w: 200, h: 200 }, ["launch", "startup", "speed", "rocket", "growth"], `
    <path id="rk-body" d="M 100 30 C 120 50 130 90 130 130 L 70 130 C 70 90 80 50 100 30 Z" fill="none" stroke="#1d3557" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
    <path id="rk-window" d="M 100 70 C 95 70 90 75 90 80 C 90 85 95 90 100 90 C 105 90 110 85 110 80 C 110 75 105 70 100 70 Z" fill="none" stroke="#457b9d" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
    <path id="rk-fin-l" d="M 70 110 L 50 150 L 70 150 Z" fill="none" stroke="#1d3557" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
    <path id="rk-fin-r" d="M 130 110 L 150 150 L 130 150 Z" fill="none" stroke="#1d3557" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
    <path id="rk-flame" d="M 85 140 C 90 160 95 175 100 175 C 105 175 110 160 115 140" fill="none" stroke="#e63946" stroke-width="6" stroke-linecap="round"/>
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

  // ---------------------------------------------------------------------------
  // W3 — the extended starter pack: education / business / science /
  // process. Every path is ONE subpath (the teleport law), every closed
  // shape winds, every arrow's head sits on its stem's tip — the validator
  // (asset-validate.ts) gates all of it, and the suite pins every built-in
  // through validateAsset.
  // ---------------------------------------------------------------------------
  A("graduation-cap", { w: 200, h: 200 }, ["education", "school", "learn", "graduate", "study"], `
    <path id="gc-board" d="M 100 60 L 180 95 L 100 130 L 20 95 Z" fill="none" stroke="#1d3557" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
    <path id="gc-band" d="M 70 126 C 74 144, 126 144, 130 126" fill="none" stroke="#457b9d" stroke-width="5.5" stroke-linecap="round"/>
    <path id="gc-tassel" d="M 180 95 C 184 115, 176 132, 180 152" fill="none" stroke="#e63946" stroke-width="5" stroke-linecap="round"/>
  `),
  A("open-book", { w: 200, h: 200 }, ["education", "book", "read", "learn", "story"], `
    <path id="ob-spine" d="M 100 70 L 100 150" fill="none" stroke="#1d3557" stroke-width="6" stroke-linecap="round"/>
    <path id="ob-page-l" d="M 100 70 C 70 58, 40 58, 24 66 L 24 146 C 40 138, 70 138, 100 150" fill="none" stroke="#1d3557" stroke-width="5.5" stroke-linecap="round"/>
    <path id="ob-page-r" d="M 100 70 C 130 58, 160 58, 176 66 L 176 146 C 160 138, 130 138, 100 150" fill="none" stroke="#457b9d" stroke-width="5.5" stroke-linecap="round"/>
  `),
  A("target", { w: 200, h: 200 }, ["business", "goal", "target", "aim", "focus"], `
    <path id="tg-outer" d="M 30 100 A 70 70 0 1 0 170 100 A 70 70 0 1 0 30 100 Z" fill="none" stroke="#1d3557" stroke-width="6" stroke-linecap="round"/>
    <path id="tg-mid" d="M 55 100 A 45 45 0 1 0 145 100 A 45 45 0 1 0 55 100 Z" fill="none" stroke="#457b9d" stroke-width="5.5" stroke-linecap="round"/>
    <path id="tg-inner" d="M 80 100 A 20 20 0 1 0 120 100 A 20 20 0 1 0 80 100 Z" fill="none" stroke="#e63946" stroke-width="5" stroke-linecap="round"/>
  `),
  A("pie-chart", { w: 200, h: 200 }, ["business", "data", "chart", "share", "percent", "pie"], `
    <path id="pc-circle" d="M 30 100 A 70 70 0 1 0 170 100 A 70 70 0 1 0 30 100 Z" fill="none" stroke="#1d3557" stroke-width="6" stroke-linecap="round"/>
    <path id="pc-slice" d="M 100 100 L 100 30 A 70 70 0 0 1 160.6 65 Z" fill="none" stroke="#e63946" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/>
  `),
  A("flask", { w: 200, h: 200 }, ["science", "lab", "experiment", "chemistry", "test"], `
    <path id="fl-body" d="M 85 30 L 85 70 L 45 150 C 40 162, 48 170, 60 170 L 140 170 C 152 170, 160 162, 155 150 L 115 70 L 115 30" fill="none" stroke="#1d3557" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
    <path id="fl-rim" d="M 73 30 L 127 30" fill="none" stroke="#1d3557" stroke-width="6" stroke-linecap="round"/>
    <path id="fl-liquid" d="M 60 122 C 80 130, 120 130, 140 122" fill="none" stroke="#457b9d" stroke-width="5" stroke-linecap="round"/>
  `),
  A("atom", { w: 200, h: 200 }, ["science", "atom", "physics", "energy", "nucleus"], `
    <path id="at-nucleus" d="M 88 100 A 12 12 0 1 0 112 100 A 12 12 0 1 0 88 100 Z" fill="none" stroke="#e63946" stroke-width="5" stroke-linecap="round"/>
    <path id="at-orbit-h" d="M 20 100 A 80 32 0 1 0 180 100 A 80 32 0 1 0 20 100 Z" fill="none" stroke="#1d3557" stroke-width="5" stroke-linecap="round"/>
    <path id="at-orbit-v" d="M 100 20 A 32 80 0 1 0 100 180 A 32 80 0 1 0 100 20 Z" fill="none" stroke="#457b9d" stroke-width="5" stroke-linecap="round"/>
  `),
  A("gear", { w: 200, h: 200 }, ["process", "machine", "gear", "system", "work", "engine"], `
    <path id="gr-outer" d="M 40 100 A 60 60 0 1 0 160 100 A 60 60 0 1 0 40 100 Z" fill="none" stroke="#1d3557" stroke-width="6" stroke-linecap="round"/>
    <path id="gr-hub" d="M 80 100 A 20 20 0 1 0 120 100 A 20 20 0 1 0 80 100 Z" fill="none" stroke="#457b9d" stroke-width="6" stroke-linecap="round"/>
    <path id="gr-t1" d="M 160 100 L 175 100" fill="none" stroke="#1d3557" stroke-width="6" stroke-linecap="round"/>
    <path id="gr-t2" d="M 142.4 57.6 L 153 47" fill="none" stroke="#1d3557" stroke-width="6" stroke-linecap="round"/>
    <path id="gr-t3" d="M 100 40 L 100 25" fill="none" stroke="#1d3557" stroke-width="6" stroke-linecap="round"/>
    <path id="gr-t4" d="M 57.6 57.6 L 47 47" fill="none" stroke="#1d3557" stroke-width="6" stroke-linecap="round"/>
    <path id="gr-t5" d="M 40 100 L 25 100" fill="none" stroke="#1d3557" stroke-width="6" stroke-linecap="round"/>
    <path id="gr-t6" d="M 57.6 142.4 L 47 153" fill="none" stroke="#1d3557" stroke-width="6" stroke-linecap="round"/>
    <path id="gr-t7" d="M 100 160 L 100 175" fill="none" stroke="#1d3557" stroke-width="6" stroke-linecap="round"/>
    <path id="gr-t8" d="M 142.4 142.4 L 153 153" fill="none" stroke="#1d3557" stroke-width="6" stroke-linecap="round"/>
  `, {
    // One gear, one pen: the whole asset shares a single declared pen group
    // (the validator's group-consistency check has a passing home).
    penGroups: { "pen-gear": ["gr-outer", "gr-hub", "gr-t1", "gr-t2", "gr-t3", "gr-t4", "gr-t5", "gr-t6", "gr-t7", "gr-t8"] },
  }),
  A("flow-steps", { w: 200, h: 200 }, ["process", "flow", "steps", "sequence", "workflow"], `
    <path id="fs-box1" d="M 20 40 L 80 40 L 80 80 L 20 80 Z" fill="none" stroke="#1d3557" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
    <path id="fs-box2" d="M 120 40 L 180 40 L 180 80 L 120 80 Z" fill="none" stroke="#1d3557" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
    <path id="fs-box3" d="M 70 120 L 130 120 L 130 160 L 70 160 Z" fill="none" stroke="#1d3557" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
    <path id="fs-arrow1" d="M 85 60 L 112 60" fill="none" stroke="#e63946" stroke-width="5" stroke-linecap="round"/>
    <path id="fs-head1" d="M 104 52 L 114 60 L 104 68" fill="none" stroke="#e63946" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
    <path id="fs-arrow2" d="M 150 85 L 118 112" fill="none" stroke="#e63946" stroke-width="5" stroke-linecap="round"/>
    <path id="fs-head2" d="M 124 104 L 113 116 L 127 121" fill="none" stroke="#e63946" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
  `),
];

/** The marker tip anchor of the drawing-hand asset (asset-space). */
export const HAND_TIP = { x: 70, y: 150 } as const;

// ---------------------------------------------------------------------------
// Extraction + registration
// ---------------------------------------------------------------------------

export interface ExtractedAsset {
  asset: WhiteboardAsset;
  /** Drawable path elements: id + raw path data (document order = draw
   *  order). W3: the pen attributes ride along (stroke / stroke-width /
   *  linecap / fill) — the validator's caps + fill law read them; old
   *  consumers reading {id, d} are untouched (additive, tolerant). */
  paths: { id: string; d: string; stroke?: string; strokeWidth?: number; linecap?: string; fill?: string }[];
  /** Text elements: id + visible content + anchor. */
  texts: { id: string; content: string; x: number; y: number; size: number }[];
  /** S65 (E1): elements excluded from the drawable index, with the budget
   *  law each one broke — surfaced for diagnostics instead of silently
   *  shrinking the drawable set (the E11 upload path rejects outright).
   *  W3: `detail` carries the exact numbers behind the reason. */
  rejected: { kind: "path" | "text"; id: string; reason: "id-charset" | "path-commands"; detail?: string }[];
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
      rejected.push({ kind: "path", id, reason: "id-charset", detail: `id "${id}" carries characters outside the namespace law` });
      continue;
    }
    const commands = countPathCommands(d);
    if (commands > WB_PATH_COMMAND_BUDGET) {
      rejected.push({ kind: "path", id, reason: "path-commands", detail: `${commands} expanded commands > ${WB_PATH_COMMAND_BUDGET} budget` });
      continue;
    }
    const strokeRaw = /\sstroke="([^"]*)"/.exec(tag)?.[1];
    const swRaw = /\sstroke-width="([-\d.]+)"/.exec(tag)?.[1];
    const capRaw = /\sstroke-linecap="([^"]*)"/.exec(tag)?.[1];
    const fillRaw = /\sfill="([^"]*)"/.exec(tag)?.[1];
    paths.push({
      id,
      d,
      ...(strokeRaw !== undefined ? { stroke: strokeRaw } : {}),
      ...(swRaw !== undefined ? { strokeWidth: Number(swRaw) } : {}),
      ...(capRaw !== undefined ? { linecap: capRaw } : {}),
      ...(fillRaw !== undefined ? { fill: fillRaw } : {}),
    });
  }
  for (const m of asset.svg.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)) {
    const attrs = m[1];
    const content = m[2].trim();
    const id = /\sid="([^"]+)"/.exec(attrs)?.[1];
    if (!id || !content) continue;
    if (!validWhiteboardId(id)) {
      rejected.push({ kind: "text", id, reason: "id-charset", detail: `id "${id}" carries characters outside the namespace law` });
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
 *  and feed the pure scheduler's text registries.
 *
 *  S69 (E9 Phase C / E11 §7 gate 7): `uploaded` merges per-video uploaded
 *  assets AFTER the built-ins — the SAME registration path (sanitize on
 *  load, extraction, the scheduler's text registries), so a placement or
 *  event addressing an upload validates and renders through the exact code
 *  the built-ins ride. Id collisions (an upload vs a built-in, or two
 *  uploads) throw — the /asset route prevents them at write time, so a
 *  collision at load is data corruption and says so. */
export function loadLibrary(uploaded: WhiteboardAsset[] = []): {
  assets: Map<string, WhiteboardAsset>;
  extracted: Map<string, ExtractedAsset>;
  libraryIndex: {
    assetIds: Set<string>;
    pathIdsByAsset: Map<string, Set<string>>;
    textIdsByAsset: Map<string, Set<string>>;
  };
  /** W3: uploads the stroke-authored validator EXCLUDED (warn-and-
   *  exclude — the manifest row stays, the asset never registers, and no
   *  document is mutated; this module never sees one). Built-ins never
   *  land here: a built-in failing its own validator throws, because
   *  that is a programming error, not a data condition. */
  warnings: { assetId: string; reasons: string[] }[];
} {
  const assets = new Map<string, WhiteboardAsset>();
  const extracted = new Map<string, ExtractedAsset>();
  const pathIdsByAsset = new Map<string, Set<string>>();
  const textIdsByAsset = new Map<string, Set<string>>();
  const warnings: { assetId: string; reasons: string[] }[] = [];
  const register = (a: WhiteboardAsset, origin: string): void => {
    if (assets.has(a.id)) throw new Error(`duplicate whiteboard asset id: ${a.id} (${origin})`);
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
  };
  // W3: every built-in rides its own validator — a failure is a bug in
  // the library itself and says so loudly (the suite pins all-pass).
  for (const a of ASSETS) {
    const report = validateAsset(a);
    if (!report.ok) {
      throw new Error(
        `built-in whiteboard asset "${a.id}" failed the W3 validator: ${report.findings.map((f) => f.reason).join(" · ")}`
      );
    }
    register(a, "built-in library");
  }
  for (const u of uploaded) {
    // The load-time sanitize law applies to uploads too — trusted-or-not,
    // the gate is a property of the pipeline (they were sanitized at upload
    // as well; this is defense in depth, not a second vocabulary).
    const sanitized: WhiteboardAsset = { ...u, svg: sanitizeSvg(u.svg) };
    // W3 — warn-and-exclude (the risk register's over-rejection answer):
    // an upload the validator refuses never reaches the drawable index;
    // the caller learns why through `warnings` and decides (the studio
    // surfaces, the renderer just renders what validated).
    const report = validateAsset(sanitized);
    if (!report.ok) {
      warnings.push({ assetId: u.id, reasons: report.findings.map((f) => f.reason ?? "invalid geometry") });
      continue;
    }
    register(sanitized, "upload manifest");
  }
  return {
    assets,
    extracted,
    libraryIndex: { assetIds: new Set(assets.keys()), pathIdsByAsset, textIdsByAsset },
    warnings,
  };
}
