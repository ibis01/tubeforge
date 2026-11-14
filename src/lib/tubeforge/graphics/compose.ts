// G1.3 — the graphics composer: static skeleton + ONE applier (S120 §5 /
// Part B). The wb-page.ts seam law applied to the graphics grammar:
//
//   the renderer rasterizes frameAt() through THESE artifacts; the editor
//   plays back frameAt() through THE SAME artifacts. One compose, one
//   applier, two callers — there is no second implementation to drift.
//
// The three artifacts, mirroring whiteboard/wb-page.ts exactly:
//   composeGraphicsScene(scene, doc) → the static HTML/SVG skeleton: the
//     background, one <g id="ge-{id}"> per element in doc order, every
//     piece of per-frame-reactive geometry baked into data-* attributes,
//     static attributes carrying the PLACED state (the poster frame — the
//     applier corrects before any capture).
//   graphicsFramePayload(frame) → the frame truth, serialized for the
//     page (frameAt's GraphicsFrameState, verbatim per element).
//   APPLY_GRAPHICS_FRAME_FN → the ONE applier, a set-only DOM function
//     evaluated by renderer (page.evaluate) and editor (iframe eval)
//     alike. NO CSS animation anywhere — every frame applied by JS
//     (the determinism law, wb-page.ts verbatim).
//
// THE REVEAL CHANNEL — one mechanism per element (the G1.2 contract:
// "wipe/grow/draw expose the reveal-progress channel the composer
// interprets per payload"):
//   bar/barChart → the payload's native mechanism, bar LENGTHS, always
//     baked (progress 1 = full bars; any progress-driving motion —
//     wipe enter, grow exit, emphasis re-trace — modulates them).
//   icon → stroke-dash along the path arc length (svg.ts#pathSegments →
//     totalLength — the S64 geometry, reused, never a second parser),
//     always baked.
//   shape → the FIRST progress-driving motion in slot order (enter →
//     exit → emphasis) picks the mechanism: wipe → a baked clip rect
//     reveals left→right; grow → the shape geometry scales from zero;
//     draw → the outline dashes on (fill appears at progress 1 — the
//     fill-after-outline law). No progress-driving motion → none.
//   text kinds / counter / callout → no mechanism (their legal motion
//     sets drive opacity/offset/scale/count only).
//
// RECORDED v1 DECISIONS (receipts to tune; the names are the contract —
// GRAPHICS_COMPOSE_DEFAULTS is the ONE table):
//   - compose-time defaults: sizePx 48, weight 700, ink #111111, icon
//     strokeWidth 4, shape strokeWidth 4, callout size 28, align center,
//     chart box = ½ surface centered on `at` (types.ts' own comments —
//     the validator clamps, the composer defaults).
//   - bar color is the ink (a per-bar palette is a design-doc slice);
//     bar labels carry the payload unit after the label.
//   - text renders explicit \n lines via tspans; auto-wrap is a design
//     slice, not a drive-by. dominant-baseline centers the block on the
//     anchor; align maps to text-anchor (left→start, center→middle,
//     right→end).
//   - an ABSENT payload composes as an empty element (the validator
//     warned; parse never refuses — the Part F law).
//   - group children nest INSIDE the group's <g> (the group's frame
//     transform/opacity composes with each child's — SVG multiplies
//     subtree opacity for free). Children ride the group's children-array
//     order; an element claimed by two groups lives in the LAST claim
//     (validator dedupes within one group only — recorded semantics).
//   - no camera: graphics is a peer lane; the W5 camera layer stays the
//     whiteboard's. The doc clock IS the timeline.
//   - the applier is IDEMPOTENT BY CONSTRUCTION: every write is an
//     absolute set on a static node — it creates no elements, reads no
//     layout (the W1 getBBox lesson), touches no wall clock, draws no
//     randomness. Full DOM idempotence rides the G1.10 benchmark's
//     frame-hash pin; the unit pins hold the construction laws.
//
// SECURITY (the hostile-icon pin): icon path data is sanitized with
// svg.ts#sanitizeSvg FIRST (payload markup stripped from the d string
// itself), then HTML-attribute-escaped (the hard gate — an escaped value
// cannot break out of its attribute context, ever). Validation counted
// commands on the raw d; the rendered path is the sanitized remainder —
// the budget was an upper bound, sanitize only removes hostile junk.
//
// PURE — no fs, no DOM execution, no clock, no randomness (the S64 law):
// this module builds STRINGS; the DOM owns execution. Leaf-module law:
// imports the grammar (types.ts), the frame truth (frame.ts) and two
// whiteboard siblings (svg) — never the reverse.
import {
  sanitizeSvg,
  pathSegments,
  totalLength,
} from "../whiteboard/svg";
import type { GraphicsDoc, GraphicsElement, GraphicsScene } from "./types";
import type { GraphicsFrameState } from "./frame";

// ---------------------------------------------------------------------------
// The compose-time defaults — ONE table, cited by the skeleton and the pins
// ---------------------------------------------------------------------------

export const GRAPHICS_COMPOSE_DEFAULTS = {
  /** Text font size when the payload omits sizePx (types.ts comment). */
  sizePx: 48,
  /** Text weight when the payload omits weight (types.ts comment). */
  weight: 700,
  /** The default ink — text fill, bar fill, icon stroke, shape stroke. */
  ink: "#111111",
  /** Icon stroke width when the payload omits it. */
  iconStrokeWidth: 4,
  /** Shape stroke width when the payload omits it. */
  shapeStrokeWidth: 4,
  /** Callout bubble text size (callouts are annotations, not headlines). */
  calloutSizePx: 28,
  /** Chart box = this fraction of the surface, centered on `at`. */
  chartBoxFraction: 0.5,
  /** Bar label font size. */
  barLabelSizePx: 20,
  /** Gap between the chart baseline and its labels. */
  barLabelGapPx: 24,
  /** Bar thickness as a fraction of its slot. */
  barSlotFill: 0.6,
  /** Text line height multiplier. */
  textLineHeight: 1.25,
  /** Shape defaults when the payload omits the dimension. */
  shapeW: 240,
  shapeH: 240,
  shapeR: 120,
  lineW: 320,
  /** Callout bubble padding / minimum width / char-width estimate. */
  bubblePadPx: 16,
  bubbleMinW: 140,
  bubbleCharW: 0.6,
  bubbleLineHeight: 1.3,
  /** Callout tail dot radius. */
  tailDotR: 4,
} as const;

// ---------------------------------------------------------------------------
// Escaping + formatting (module-private, pure)
// ---------------------------------------------------------------------------

/** HTML-escape for text content AND attribute values — the hard gate that
 *  keeps author strings (payload text, icon path data) inside their
 *  context. Applied AFTER sanitizeSvg on icon paths (sanitize first —
 *  strips the payload markup; escape second — nothing breaks out). */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Deterministic number → attribute string (6 decimals, no -0, no
 *  exponent noise). The applier recomputes FROM these baked values, so
 *  what the skeleton says is what the frame math uses. */
function fmt(n: number): string {
  return String(Math.round(n * 1e6) / 1e6);
}

/** The counter's rendered string — exported so the pins and any future
 *  surface share ONE formatter. decimals defaults to 0, unit rides after. */
export function formatCounter(value: number, decimals?: number, unit?: string): string {
  return value.toFixed(decimals ?? 0) + (unit ?? "");
}

// ---------------------------------------------------------------------------
// The reveal mechanism — ONE per element (module-private)
// ---------------------------------------------------------------------------

type RevealMechanism = "bar" | "dash" | "grow" | "wipe";

const SHAPE_PROGRESS_MECHANISM: Partial<Record<string, "wipe" | "grow" | "dash">> = {
  wipe: "wipe",
  grow: "grow",
  draw: "dash",
};

/** Shapes pick the mechanism from the FIRST progress-driving motion in
 *  slot order (enter → exit → emphasis); bars/icons carry their native
 *  mechanism always; everything else none. */
function revealMechanism(el: GraphicsElement): RevealMechanism | null {
  if (el.kind === "bar" || el.kind === "barChart") return "bar";
  if (el.kind === "icon") return "dash";
  if (el.kind === "shape") {
    for (const m of [el.enter, el.exit, el.emphasis]) {
      if (m === undefined) continue;
      const mech = SHAPE_PROGRESS_MECHANISM[m.kind];
      if (mech !== undefined) return mech;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Element renderers (module-private, pure) — each returns the INNER content
// of the element's <g>; the wrapper carries the frame-driven transform +
// opacity (poster = the placed state).
// ---------------------------------------------------------------------------

interface TextOpts {
  lines: string[];
  sizePx: number;
  weight: number;
  color: string;
  align: "left" | "center" | "right";
  extraAttrs?: string;
  /** Pre-formatted single-line content (the counter's poster value). */
  content?: string;
}

/** The shared text block: tspans per line, block centered on the anchor
 *  (dominant-baseline middle), align → text-anchor. */
function textBlock(o: TextOpts): string {
  const anchor = o.align === "left" ? "start" : o.align === "right" ? "end" : "middle";
  const lh = o.sizePx * GRAPHICS_COMPOSE_DEFAULTS.textLineHeight;
  const n = o.lines.length;
  const tspans = o.content !== undefined && n === 1
    ? esc(o.content)
    : o.lines
        .map((line, i) => `<tspan x="0" y="${fmt((i - (n - 1) / 2) * lh)}">${esc(line)}</tspan>`)
        .join("");
  return (
    `<text text-anchor="${anchor}" dominant-baseline="middle"` +
    ` font-size="${fmt(o.sizePx)}" font-weight="${o.weight}" fill="${o.color}"` +
    ` xml:space="preserve"${o.extraAttrs ?? ""}>${tspans}</text>`
  );
}

function textInner(el: GraphicsElement): string {
  const p = el.text;
  if (p === undefined) return ""; // absent payload → empty element (validator warned)
  return textBlock({
    lines: p.text.split("\n"),
    sizePx: p.sizePx ?? GRAPHICS_COMPOSE_DEFAULTS.sizePx,
    weight: p.weight ?? GRAPHICS_COMPOSE_DEFAULTS.weight,
    color: p.color ?? GRAPHICS_COMPOSE_DEFAULTS.ink,
    align: p.align ?? "center",
  });
}

function counterInner(el: GraphicsElement): string {
  const p = el.counter;
  if (p === undefined) return "";
  const d = p.decimals ?? 0;
  return textBlock({
    lines: [""],
    sizePx: GRAPHICS_COMPOSE_DEFAULTS.sizePx,
    weight: GRAPHICS_COMPOSE_DEFAULTS.weight,
    color: GRAPHICS_COMPOSE_DEFAULTS.ink,
    align: "center",
    extraAttrs: ` data-counter="1" data-decimals="${d}" data-unit="${esc(p.unit ?? "")}"`,
    content: formatCounter(p.to, p.decimals, p.unit), // poster = the final value
  });
}

function barInner(el: GraphicsElement, doc: GraphicsDoc): string {
  const p = el.bar;
  if (p === undefined) return "";
  const D = GRAPHICS_COMPOSE_DEFAULTS;
  const boxW = doc.width * D.chartBoxFraction;
  const boxH = doc.height * D.chartBoxFraction;
  const left = el.at.x - boxW / 2;
  const top = el.at.y - boxH / 2;
  // scaleMax: the payload ceiling, else the data max (all-zero data → 1,
  // so zero-length bars stay honest instead of dividing by zero).
  const dataMax = Math.max(...p.data.map((r) => r.value), 0);
  const scaleMax = p.max !== undefined && p.max > 0 ? p.max : dataMax > 0 ? dataMax : 1;
  const ink = GRAPHICS_COMPOSE_DEFAULTS.ink;
  const n = p.data.length;
  const parts: string[] = [];
  if (p.horizontal === true) {
    const slotH = boxH / n;
    const barH = slotH * D.barSlotFill;
    for (let i = 0; i < n; i++) {
      const row = p.data[i];
      if (row === undefined) continue;
      const len = (row.value / scaleMax) * boxW;
      const cy = top + i * slotH + slotH / 2;
      parts.push(
        `<rect x="${fmt(left)}" y="${fmt(cy - barH / 2)}" width="${fmt(len)}" height="${fmt(barH)}"` +
          ` fill="${ink}" data-len="${fmt(len)}" data-axis="h"/>`,
      );
      parts.push(
        `<text x="${fmt(left - 12)}" y="${fmt(cy)}" text-anchor="end" dominant-baseline="middle"` +
          ` font-size="${D.barLabelSizePx}" fill="${ink}" xml:space="preserve">${esc(row.label + (p.unit ? " " + p.unit : ""))}</text>`,
      );
    }
  } else {
    const slotW = boxW / n;
    const barW = slotW * D.barSlotFill;
    const baseline = top + boxH;
    for (let i = 0; i < n; i++) {
      const row = p.data[i];
      if (row === undefined) continue;
      const len = (row.value / scaleMax) * boxH;
      const x = left + i * slotW + (slotW - barW) / 2;
      parts.push(
        `<rect x="${fmt(x)}" y="${fmt(baseline - len)}" width="${fmt(barW)}" height="${fmt(len)}"` +
          ` fill="${ink}" data-len="${fmt(len)}" data-axis="v" data-base="${fmt(baseline)}"/>`,
      );
      parts.push(
        `<text x="${fmt(left + i * slotW + slotW / 2)}" y="${fmt(baseline + D.barLabelGapPx)}"` +
          ` text-anchor="middle" font-size="${D.barLabelSizePx}" fill="${ink}" xml:space="preserve">` +
          `${esc(row.label + (p.unit ? " " + p.unit : ""))}</text>`,
      );
    }
  }
  return parts.join("\n");
}

function iconInner(el: GraphicsElement): string {
  const p = el.icon;
  if (p === undefined) return "";
  const color = p.color ?? GRAPHICS_COMPOSE_DEFAULTS.ink;
  const sw = p.strokeWidth ?? GRAPHICS_COMPOSE_DEFAULTS.iconStrokeWidth;
  // sanitize FIRST (svg.ts strips payload markup from the d string), then
  // escape (nothing breaks the attribute context). The data-len rides the
  // SANITIZED path — what renders is what measures.
  return p.paths
    .map((d) => {
      const clean = sanitizeSvg(d);
      const len = totalLength(pathSegments(clean));
      return (
        `<path d="${esc(clean)}" fill="none" stroke="${color}" stroke-width="${fmt(sw)}"` +
        ` stroke-linecap="round" stroke-linejoin="round"` +
        ` stroke-dasharray="${fmt(len)}" data-len="${fmt(len)}"/>`
      );
    })
    .join("\n");
}

function calloutInner(el: GraphicsElement): string {
  const p = el.callout;
  if (p === undefined) return "";
  const D = GRAPHICS_COMPOSE_DEFAULTS;
  const sizePx = D.calloutSizePx;
  const ink = D.ink;
  const lines = p.text.split("\n");
  const maxChars = Math.max(...lines.map((l) => l.length), 1);
  const w = Math.max(maxChars * sizePx * D.bubbleCharW + D.bubblePadPx * 2, D.bubbleMinW);
  const h = lines.length * sizePx * D.bubbleLineHeight + D.bubblePadPx * 2;
  const parts: string[] = [];
  if (p.pointsAt !== undefined) {
    // Tail from the bubble's bottom edge to the target — LOCAL coords (the
    // group carries `at`; exact when rotate 0 / scale 1, the authored case).
    const dx = p.pointsAt.x - el.at.x;
    const dy = p.pointsAt.y - el.at.y;
    parts.push(`<line x1="0" y1="${fmt(h / 2)}" x2="${fmt(dx)}" y2="${fmt(dy)}" stroke="${ink}" stroke-width="2"/>`);
    parts.push(`<circle cx="${fmt(dx)}" cy="${fmt(dy)}" r="${D.tailDotR}" fill="${ink}"/>`);
  }
  parts.push(
    `<rect x="${fmt(-w / 2)}" y="${fmt(-h / 2)}" width="${fmt(w)}" height="${fmt(h)}" rx="12"` +
      ` fill="#ffffff" stroke="${ink}" stroke-width="2"/>`,
  );
  parts.push(
    textBlock({
      lines,
      sizePx,
      weight: D.weight,
      color: ink,
      align: "center",
    }),
  );
  return parts.join("\n");
}

function shapeInner(el: GraphicsElement): string {
  const p = el.shape;
  if (p === undefined) return "";
  const D = GRAPHICS_COMPOSE_DEFAULTS;
  const stroke = p.stroke ?? D.ink;
  const fill = p.fill ?? "none";
  const sw = p.strokeWidth ?? D.shapeStrokeWidth;
  const mech = revealMechanism(el);
  const base = ` stroke="${stroke}" stroke-width="${fmt(sw)}" data-shape="${p.kind}"`;
  let attrs = "";
  if (mech === "dash") {
    attrs += ` data-fill="1"`; // fill-after-outline: the applier flips it at progress 1
  }
  if (mech === "grow") {
    attrs += ` data-grow="1"`; // the applier recomputes the geometry from the baked dims
  }
  // Full dims ALWAYS baked (data-w/h/r) — the grow branch recomputes from
  // them; the poster attributes carry the placed geometry.
  switch (p.kind) {
    case "rect": {
      const w = p.w ?? D.shapeW;
      const h = p.h ?? D.shapeH;
      attrs += ` data-w="${fmt(w)}" data-h="${fmt(h)}"`;
      if (mech === "dash") {
        const len = 2 * (w + h);
        attrs += ` stroke-dasharray="${fmt(len)}" data-len="${fmt(len)}"`;
      }
      if (mech === "wipe") {
        attrs += ` clip-path="url(#ge-${el.id}--wipe)"`;
      }
      return `<rect x="${fmt(-w / 2)}" y="${fmt(-h / 2)}" width="${fmt(w)}" height="${fmt(h)}"` +
        ` fill="${fill}"${base}${attrs}/>`;
    }
    case "line": {
      const w = p.w ?? D.lineW;
      const h = p.h ?? 0;
      attrs += ` data-w="${fmt(w)}" data-h="${fmt(h)}"`;
      if (mech === "dash") {
        const len = Math.hypot(w, h);
        attrs += ` stroke-dasharray="${fmt(len)}" data-len="${fmt(len)}"`;
      }
      return `<line x1="${fmt(-w / 2)}" y1="${fmt(-h / 2)}" x2="${fmt(w / 2)}" y2="${fmt(h / 2)}"` +
        ` fill="none"${base}${attrs}/>`;
    }
    case "circle": {
      const r = p.r ?? D.shapeR;
      attrs += ` data-r="${fmt(r)}"`;
      if (mech === "dash") {
        const len = 2 * Math.PI * r;
        attrs += ` stroke-dasharray="${fmt(len)}" data-len="${fmt(len)}"`;
      }
      if (mech === "wipe") {
        attrs += ` clip-path="url(#ge-${el.id}--wipe)"`;
      }
      return `<circle cx="0" cy="0" r="${fmt(r)}" fill="${fill}"${base}${attrs}/>`;
    }
  }
}

/** The wipe mechanism's clip — baked INSIDE the group so the applier's
 *  :scope query finds it and the element's user space owns the coords. */
function wipeClip(el: GraphicsElement): string {
  const p = el.shape;
  if (p === undefined) return "";
  const D = GRAPHICS_COMPOSE_DEFAULTS;
  let x: number;
  let y: number;
  let w: number;
  let h: number;
  switch (p.kind) {
    case "rect": {
      w = p.w ?? D.shapeW;
      h = p.h ?? D.shapeH;
      x = -w / 2;
      y = -h / 2;
      break;
    }
    case "line": {
      w = p.w ?? D.lineW;
      h = (p.h ?? 0) + (p.strokeWidth ?? D.shapeStrokeWidth) + 8;
      x = -w / 2;
      y = -h / 2;
      break;
    }
    case "circle": {
      const r = p.r ?? D.shapeR;
      x = -r;
      y = -r;
      w = 2 * r;
      h = 2 * r;
      break;
    }
  }
  return (
    `<clipPath id="ge-${el.id}--wipe"><rect x="${fmt(x)}" y="${fmt(y)}"` +
    ` width="${fmt(w)}" height="${fmt(h)}" data-w="${fmt(w)}"/></clipPath>`
  );
}

function elementInner(el: GraphicsElement, doc: GraphicsDoc): string {
  switch (el.kind) {
    case "headline":
    case "subhead":
    case "bullet":
      return textInner(el);
    case "counter":
      return counterInner(el);
    case "bar":
    case "barChart":
      return barInner(el, doc);
    case "icon":
      return iconInner(el);
    case "callout":
      return calloutInner(el);
    case "shape":
      return shapeInner(el);
    case "group":
      return ""; // unreachable — elementNode short-circuits groups; children ride the assembly pass
  }
}

/** The element wrapper: the frame engine (applier) owns transform +
 *  opacity; the poster carries the placed state. Groups receive their
 *  children's nodes as the body (the assembly pass below builds them). */
function elementNode(el: GraphicsElement, doc: GraphicsDoc, childrenBody = ""): string {
  const transform =
    `translate(${fmt(el.at.x)} ${fmt(el.at.y)}) rotate(${fmt(el.at.rotateDeg)}) scale(${fmt(el.at.scale)})`;
  const opacity = fmt(el.opacity ?? 1);
  const clip = el.kind === "shape" && revealMechanism(el) === "wipe" ? wipeClip(el) : "";
  const inner = el.kind === "group" ? childrenBody : elementInner(el, doc);
  const body = clip !== "" ? `${clip}\n${inner}` : inner;
  return `<g id="ge-${el.id}" transform="${transform}" opacity="${opacity}">${body}</g>`;
}

// ---------------------------------------------------------------------------
// The skeleton
// ---------------------------------------------------------------------------

export interface ComposedGraphicsScene {
  html: string;
}

/** The static skeleton for one scene — the poster frame. PURE: same
 *  (scene, doc) → byte-identical html (pinned). The renderer feeds it to
 *  page.setContent; the editor to an iframe srcdoc — one compose, two
 *  callers (the wb-page.ts seam law). */
export function composeGraphicsScene(scene: GraphicsScene, doc: GraphicsDoc): ComposedGraphicsScene {
  // Group nesting — children ride the group's children-array order inside
  // the group's <g>; an element claimed by two groups lives in the LAST
  // claim (recorded v1 semantics).
  const claims = new Map<string, string>();
  for (const el of scene.elements) {
    if (el.kind === "group" && el.group !== undefined) {
      for (const child of el.group.children) claims.set(child, el.id);
    }
  }
  const emitted = new Set<string>();
  const parts: string[] = [];
  for (const el of scene.elements) {
    if (el.kind === "group") {
      const inner = (el.group?.children ?? [])
        .map((cid) => scene.elements.find((c) => c.id === cid))
        .filter((c): c is GraphicsElement => c !== undefined && !emitted.has(c.id));
      for (const c of inner) emitted.add(c.id);
      const body = inner.map((c) => elementNode(c, doc)).join("\n");
      parts.push(elementNode(el, doc, body));
      continue;
    }
    if (claims.has(el.id) || emitted.has(el.id)) continue; // lives inside its group
    parts.push(elementNode(el, doc));
  }
  const html =
    `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:${scene.background};overflow:hidden}
svg{display:block}
text{font-family:Arial,Helvetica,sans-serif}
</style></head><body>
<svg id="board" width="${doc.width}" height="${doc.height}" viewBox="0 0 ${doc.width} ${doc.height}" xmlns="http://www.w3.org/2000/svg">
<rect x="0" y="0" width="${doc.width}" height="${doc.height}" fill="${scene.background}"/>
${parts.join("\n")}
</svg></body></html>`;
  return { html };
}

// ---------------------------------------------------------------------------
// The payload + the ONE applier
// ---------------------------------------------------------------------------

/** The frame truth serialized for the page — frameAt's state, verbatim,
 *  in doc order. Key order stable; byte-identical for equal frames. */
export function graphicsFramePayload(frame: GraphicsFrameState): string {
  return JSON.stringify({
    sceneId: frame.sceneId,
    sceneTMs: frame.sceneTMs,
    elements: frame.elements.map((e) => ({
      id: e.id,
      opacity: e.opacity,
      x: e.x,
      y: e.y,
      scale: e.scale,
      rotateDeg: e.rotateDeg,
      progress: e.progress,
      ...(e.counterValue !== undefined ? { counterValue: e.counterValue } : {}),
    })),
  });
}

/** The ONE applier — shared by the renderer (page.evaluate) and the editor
 *  (iframe eval). IDEMPOTENT BY CONSTRUCTION: every write is an absolute
 *  set on a static skeleton node (apply twice ≡ once); it creates no
 *  elements, reads no layout, touches no wall clock, draws no randomness.
 *  Mechanism queries are :scope-scoped to the element's OWN content so a
 *  group's pass never overwrites a child's reveal state. */
export const APPLY_GRAPHICS_FRAME_FN = `(payloadJson) => {
  const p = JSON.parse(payloadJson);
  for (const el of p.elements) {
    const g = document.getElementById("ge-" + el.id);
    if (!g) continue;
    g.setAttribute("transform", "translate(" + el.x + " " + el.y + ") rotate(" + el.rotateDeg + ") scale(" + el.scale + ")");
    g.setAttribute("opacity", String(el.opacity));
    const prog = el.progress;
    // Bars — the data reveal: each bar's length rides the progress channel.
    for (const rect of g.querySelectorAll(":scope > rect[data-len][data-axis]")) {
      const len = Number(rect.dataset.len) * prog;
      if (rect.dataset.axis === "v") {
        rect.setAttribute("height", String(len));
        rect.setAttribute("y", String(Number(rect.dataset.base) - len));
      } else {
        rect.setAttribute("width", String(len));
      }
    }
    // Counter — the tweened value, formatted by the baked decimals/unit.
    const counter = g.querySelector(":scope > text[data-counter]");
    if (counter && el.counterValue !== undefined) {
      counter.textContent = Number(el.counterValue).toFixed(Number(counter.dataset.decimals || "0")) + (counter.dataset.unit || "");
    }
    // Stroke draw — icons and drawn shapes reveal along their arc length
    // (data-len without data-axis: bars carry the axis, draw does not).
    for (const s of g.querySelectorAll(":scope > [data-len]:not([data-axis])")) {
      const L = Number(s.dataset.len);
      s.setAttribute("stroke-dashoffset", String(L * (1 - prog)));
    }
    // Shape geometry grow + the fill-after-outline flip.
    const shape = g.querySelector(":scope > [data-shape]");
    if (shape) {
      if (shape.hasAttribute("data-grow")) {
        const k = prog;
        const kind = shape.getAttribute("data-shape");
        if (kind === "rect") {
          const w = Number(shape.dataset.w) * k;
          const h = Number(shape.dataset.h) * k;
          shape.setAttribute("width", String(w));
          shape.setAttribute("height", String(h));
          shape.setAttribute("x", String(-w / 2));
          shape.setAttribute("y", String(-h / 2));
        } else if (kind === "circle") {
          shape.setAttribute("r", String(Number(shape.dataset.r) * k));
        } else {
          const w = Number(shape.dataset.w) * k;
          const h = Number(shape.dataset.h) * k;
          shape.setAttribute("x1", String(-w / 2));
          shape.setAttribute("y1", String(-h / 2));
          shape.setAttribute("x2", String(w / 2));
          shape.setAttribute("y2", String(h / 2));
        }
      }
      if (shape.hasAttribute("data-fill")) {
        shape.setAttribute("fill-opacity", prog >= 1 ? "1" : "0");
      }
    }
    // Wipe — the baked clip rect's width rides progress.
    const clipRect = g.querySelector(":scope > clipPath rect[data-w]");
    if (clipRect) clipRect.setAttribute("width", String(Number(clipRect.dataset.w) * prog));
  }
  return true;
}`;
