// W4 — text becomes drawn text (S120 §3 W4).
//
// SLICE 1 (this commit): the readability law — a PURE check that a text
// element, at its placement scale, through the camera, at the final output
// size, still renders as legible pixels. The storyboard's validation (and
// the W5 camera director's framing policy) consume it; the pin rejects
// scale-0.4 placements that would collapse a label into unreadable specks.
//
// SLICE 2 (next): the glyph-outline mode — one handwriting face converted
// to SVG path outlines (deterministic, the single-face route) emitted as
// draw_path events, with the marker wipe kept as the fallback. The check
// below is mode-independent: outlined glyphs obey the same pixel law.
//
// Pure: no fs, no DOM, no clock. The text's asset-space size comes from
// the scheduler's own registry (timing.ts TEXT_ANCHORS — one source).
import { TEXT_ANCHORS } from "./timing";
import { GLYPH_TABLE } from "./glyphs";

/** The readability wall: a text element whose rendered glyph height is
 *  below this many OUTPUT pixels cannot be read at the final size (12 px
 *  ≈ 0.6% of the 1920-wide stage — the smallest legible label at TV
 *  distance). The W5 camera director reuses it as a framing policy. */
export const WB_TEXT_READABILITY_PX = 12;

export interface TextReadabilityRef {
  assetId: string;
  textId: string;
  /** The placement's scale (the doc's Placement.scale). */
  placementScale: number;
}

export interface TextReadabilityCamera {
  /** The camera's zoom at the text's reveal (1 = the scene plane). */
  zoom: number;
}

export interface TextReadabilityOutput {
  /** The final output width in px (e.g. 1920). */
  width: number;
  /** The scene-plane width the project was authored against. */
  sceneWidth: number;
}

export interface TextReadabilityReport {
  ok: boolean;
  /** Effective rendered glyph height in output pixels. */
  renderedPx: number;
  threshold: number;
  reason?: string;
}

/** checkReadability — effective glyph height =
 *    assetTextSize × placementScale × cameraZoom × (output / scene plane),
 *  compared against the readability wall. A text the registry doesn't
 *  know (an unregistered id) fails CLOSED with a reason — an unreadable
 *  guess must never pass silently. */
export function checkReadability(
  text: TextReadabilityRef,
  camera: TextReadabilityCamera,
  output: TextReadabilityOutput
): TextReadabilityReport {
  const anchor = TEXT_ANCHORS.get(`${text.assetId}::${text.textId}`);
  if (!anchor || !(anchor.size > 0)) {
    return {
      ok: false,
      renderedPx: 0,
      threshold: WB_TEXT_READABILITY_PX,
      reason: `text "${text.assetId}::${text.textId}" is not in the scheduler's text registry — nothing to measure`,
    };
  }
  const zoom = Number.isFinite(camera.zoom) && camera.zoom > 0 ? camera.zoom : 1;
  const plane =
    Number.isFinite(output.sceneWidth) && output.sceneWidth > 0 ? output.sceneWidth : output.width;
  const factor = plane > 0 ? output.width / plane : 1;
  const scale = Number.isFinite(text.placementScale) && text.placementScale > 0 ? text.placementScale : 0;
  const renderedPx = (anchor.size * scale * zoom * factor) || 0;
  const ok = renderedPx >= WB_TEXT_READABILITY_PX;
  return {
    ok,
    renderedPx: Math.round(renderedPx * 100) / 100,
    threshold: WB_TEXT_READABILITY_PX,
    ...(ok
      ? {}
      : {
          reason: `text "${text.assetId}::${text.textId}" renders at ${renderedPx.toFixed(1)}px — below the ${WB_TEXT_READABILITY_PX}px readability wall at this placement/camera/output`,
        }),
  };
}

// ---------------------------------------------------------------------------
// W4 slice 2 — the glyph-outline layout (the single-face route, decision
// §10.3): one committed handwriting face (glyphs.ts — Caveat, OFL, generated
// by scripts/w4-generate-glyphs.py) laid out as positioned SVG path outlines
// the pen can ride. PURE: the table is committed, the math is fixed-precision,
// and the same inputs produce byte-identical paths on every machine.
//
// Policy lives with the caller: this function REPORTS uncovered characters
// (`skipped`) rather than guessing; the scheduler decides marker-wipe
// fallback when coverage is incomplete (the honest-degradation law).

export interface GlyphLayoutOptions {
  /** Baseline-left origin of the run, in asset-space coordinates. */
  x: number;
  y: number;
  /** The em size in asset-space units (font-size semantics). */
  size: number;
  /** Extra space between glyphs, in asset-space units (default 0). */
  letterSpacing?: number;
}

export interface GlyphLayout {
  fontId: string;
  upem: number;
  size: number;
  /** Total advance width of the laid-out run (unknown chars contribute 0). */
  width: number;
  /** One positioned outline path per drawn glyph (space emits nothing). */
  paths: { char: string; d: string }[];
  /** Characters absent from the committed table — the caller's fallback signal. */
  skipped: string[];
}

/** Fixed-precision number formatting for path data (2dp, trimmed) — the same
 *  discipline the generator used on the table, so re-transforms stay stable. */
function fmt2(v: number): string {
  if (!Number.isFinite(v)) return "0";
  let s = v.toFixed(2);
  if (s === "-0.00") s = "0.00";
  s = s.replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
}

/** Transform one committed glyph outline (font units, y-up) into asset-space
 *  (y-down) at the pen position: x' = x0 + gx·s, y' = y0 − gy·s. Absolute
 *  M/L/Q/C/Z commands only — exactly what SVGPathPen emits upstream. */
function transformOutline(d: string, x0: number, y0: number, s: number): string {
  let out = "";
  let i = 0;
  const n = d.length;
  while (i < n) {
    const c = d[i];
    if (c >= "A" && c <= "Z") {
      out += c;
      i += 1;
      continue;
    }
    // consume the numbers of the current command
    let j = i;
    const nums: number[] = [];
    while (j < n && !(d[j] >= "A" && d[j] <= "Z")) {
      while (j < n && (d[j] === " " || d[j] === ",")) j += 1;
      let k = j;
      while (k < n && !/[A-Z, ]/.test(d[k])) k += 1;
      const tok = d.slice(j, k);
      if (tok) nums.push(parseFloat(tok));
      j = k;
    }
    // pairs: M/L take 1 pair, Q 2, C 3; y flips, x translates
    const pairs: [number, number][] = [];
    for (let p = 0; p + 1 < nums.length; p += 2) pairs.push([nums[p], nums[p + 1]]);
    for (const [gx, gy] of pairs) {
      out += `${fmt2(x0 + gx * s)} ${fmt2(y0 - gy * s)} `;
    }
    if (out.endsWith(" ")) out = out.slice(0, -1);
    i = j;
  }
  return out;
}

/** textToGlyphPaths — lay out one line of text as glyph-outline paths.
 *  Deterministic: fixed 2dp output, no clock, no randomness; the same call
 *  twice is byte-identical. Unknown characters are REPORTED in `skipped`
 *  and contribute zero width — the caller owns the marker-wipe fallback. */
export function textToGlyphPaths(text: string, opts: GlyphLayoutOptions): GlyphLayout {
  const size = Number.isFinite(opts.size) && opts.size > 0 ? opts.size : 0;
  const x0 = Number.isFinite(opts.x) ? opts.x : 0;
  const y0 = Number.isFinite(opts.y) ? opts.y : 0;
  const ls = Number.isFinite(opts.letterSpacing ?? 0) ? (opts.letterSpacing ?? 0) : 0;
  const s = size / GLYPH_TABLE.upem;
  const paths: { char: string; d: string }[] = [];
  const skipped: string[] = [];
  let pen = x0;
  for (const ch of text) {
    const row = GLYPH_TABLE.glyphs.get(ch);
    if (!row) {
      skipped.push(ch);
      continue;
    }
    if (row.d) {
      paths.push({ char: ch, d: transformOutline(row.d, pen, y0, s) });
    }
    pen += row.advance * s + ls;
  }
  // width = the last pen position minus ls (no trailing spacing) — but if
  // every char was skipped, the run is empty and the width is 0.
  const width = paths.length > 0 || skipped.length < text.length ? pen - x0 - ls : 0;
  return {
    fontId: GLYPH_TABLE.fontId,
    upem: GLYPH_TABLE.upem,
    size,
    width: Math.round(width * 100) / 100,
    paths,
    skipped,
  };
}

// ---------------------------------------------------------------------------
// W4 slice 2 step 2 — the per-asset glyph-mode transform (the consumer seam).
//
// An asset that opts in (metadata `textMode: "glyph"`) has its <text>
// elements REPLACED by committed-outline <path> elements at registration —
// one path per glyph, deterministic ids "${textId}-g${i}-${contour}" — so EVERYTHING
// downstream rides unchanged: buildGeometry sees ordinary paths,
// scheduleScene emits draw_path rows (the pen lane), wb-page namespaces and
// animates them through the existing draw law, and the W5 camera frames
// their bboxes like any other stroke. The marker wipe stays the fallback at
// TWO levels: per-text (uncovered chars, degenerate geometry, or a
// non-paint fill — a stroke the dash law cannot animate would render an
// invisible draw) and per-asset (no `textMode` metadata → the transform is
// never applied — the byte-identity law for every existing asset).

export interface GlyphModeResult {
  /** The transformed SVG fragment (text elements swapped for glyph paths). */
  svg: string;
  /** Anchors of the REPLACED texts — the caller keeps registering them so
   *  checkReadability and the W5 framing policy still see glyph text. */
  replacedAnchors: { id: string; x: number; y: number; size: number }[];
}

/** A paint the dash law can animate: the glyph outline draws as the pen
 *  trace in the letter's own ink, and the fill renders through the engine's
 *  uniform fill law. "none" (or a missing fill) cannot show a draw — the
 *  honest fallback is the marker wipe, not an invisible stroke. */
function isPaint(fill: string | undefined): fill is string {
  return fill !== undefined && fill !== "none" && fill.trim() !== "";
}

export function applyGlyphTextMode(svg: string): GlyphModeResult {
  const replacedAnchors: GlyphModeResult["replacedAnchors"] = [];
  const out = svg.replace(/<text\b([^>]*)>([^<]*)<\/text>/g, (full, attrs: string, contentRaw: string) => {
    const content = contentRaw.trim();
    const id = /\sid="([^"]+)"/.exec(attrs)?.[1];
    const x = Number(/\sx="([-\d.]+)"/.exec(attrs)?.[1] ?? NaN);
    const y = Number(/\sy="([-\d.]+)"/.exec(attrs)?.[1] ?? NaN);
    const size = Number(/\sfont-size="([-\d.]+)"/.exec(attrs)?.[1] ?? NaN);
    const fillRaw = /\sfill="([^"]*)"/.exec(attrs)?.[1];
    const anchor = /\stext-anchor="([^"]*)"/.exec(attrs)?.[1] ?? "start";
    if (!id || !content || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(size) || size <= 0) return full;
    if (!isPaint(fillRaw)) return full; // no ink to trace → marker wipe keeps the look
    // first pass at the origin measures the run (for non-start anchors)
    const probe = textToGlyphPaths(content, { x: 0, y, size });
    if (probe.skipped.length > 0 || probe.paths.length === 0) return full; // honest per-text fallback
    let ox = x;
    if (anchor === "middle") ox = x - probe.width / 2;
    else if (anchor === "end") ox = x - probe.width;
    const layout = textToGlyphPaths(content, { x: ox, y, size });
    if (layout.skipped.length > 0 || layout.paths.length === 0) return full;
    // The pen width: a thin marker proportional to the em (deterministic,
    // clamped to sane pixels) — thick enough that the dash-offset draw is
    // visible, thin enough not to fatten the outline.
    const sw = Math.max(2, Math.round((size / 16) * 100) / 100);
    // The S67 seam law: one path, ONE subpath — but filled faces contour
    // letters in parts (the i's dot, the d's stem + bowl). Split every
    // glyph's outline into its own pen-ridable path; the hand walks them
    // in order exactly like a multi-stroke letter.
    const glyphPaths = layout.paths
      .flatMap((p, i) =>
        (p.d.match(/M[^M]+/g) ?? []).map(
          (contour, ci) =>
            `<path id="${id}-g${i}-${ci}" d="${contour.trim()}" fill="${fillRaw}" stroke="${fillRaw}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`
        )
      )
      .join("");
    replacedAnchors.push({ id, x, y, size });
    return glyphPaths;
  });
  return { svg: out, replacedAnchors };
}
