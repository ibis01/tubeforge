// P0 — the raster-to-stroke TRACING CORE (the whiteboard-production-system
// audit's P0-1, technique B: "Highest priority for Studio").
//
// One paragraph of design, from the committed plan: normalize (sharp) →
// grayscale + downscale to a fixed working size → adaptive (Otsu) threshold
// to a binary mask → isolated-pixel cleanup → connected-component census →
// Zhang-Suen skeletonization to 1px centerlines → junction-aware centerline
// following into polylines → Douglas-Peucker simplification (with a self-
// crossing guard that re-simplifies instead of emitting geometry the W3
// validator would refuse) → deterministic stroke ordering (reading-order
// bands, long structural strokes before short details) → a sanitized
// single-subpath `<path id d>` fragment that enters the EXISTING upload
// gates. Preview ≡ export is preserved by construction — traced strokes are
// ordinary geometry; frameAt and APPLY_FRAME_FN are untouched.
//
// PURE module law (the audit's words): no fs, no DB, no network. `sharp`
// decodes an IN-MEMORY Buffer only — it is the plan's named preprocessing
// dependency and nothing else crosses the boundary.
//
// Determinism law: fixed working size, fixed threshold rule, stable
// tie-breaking sorts everywhere, fixed decimal precision on emitted
// coordinates. Identical input bytes → byte-identical svgFragment (the
// unit battery pins the double-run equality). The receipt's per-stage `ms`
// numbers are the ONLY intentionally non-deterministic field — the
// determinism pin compares the FRAGMENT, not the receipt.
import sharp from "sharp";
import type { Metadata as SharpMetadata } from "sharp";
import { WB_TRACED_PATH_BUDGET, WB_TRACED_TOTAL_BUDGET } from "./trace-budget";

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** The input-quality classification (the external review's recommendation
 *  A: not every photograph deserves strokes — reject unsuitable images
 *  with a useful explanation instead of generating poor animations). */
export type TraceQualityClass =
  | "icon"
  | "line-art"
  | "diagram"
  | "illustration"
  | "blank"
  | "dense"
  | "noisy"
  | "photo";

/** The classes the upload gate REJECTS (readable errors, the audit §4A). */
export const TRACED_REJECT_CLASSES: readonly TraceQualityClass[] = ["blank", "dense", "noisy", "photo"];

export interface TraceOptions {
  /** Longest working-axis edge (working px). Default 1024. */
  maxWorkingSize?: number;
  /** "otsu" (default) or a fixed 0-255 cutoff (ink = gray < threshold). */
  threshold?: "otsu" | number;
  /** Douglas-Peucker epsilon in working px. Default 1.2. */
  simplifyEpsilon?: number;
  /** Strokes shorter than this (working px of arc length) drop. Default 6. */
  minStrokeLenPx?: number;
  /** Stroke-count ceiling — the longest strokes win. Default 400. */
  maxStrokes?: number;
}

export interface TraceReceipt {
  sourceFormat: "png" | "jpeg";
  sourceBytes: number;
  sourceSize: { w: number; h: number };
  workingSize: { w: number; h: number };
  thresholdMode: "otsu" | "fixed";
  thresholdUsed: number;
  inkRatio: number;
  components: number;
  quality: TraceQualityClass;
  junctions: number;
  skeletonIterations: number;
  strokesRaw: number;
  strokesKept: number;
  droppedShortStrokes: number;
  droppedForCap: number;
  droppedOverBudget: number;
  resimplifiedSelfCross: number;
  commands: number;
  viewBox: { w: number; h: number };
  ms: { decode: number; normalize: number; threshold: number; skeleton: number; trace: number; simplify: number; emit: number };
}

export interface TraceResult {
  /** Sanitized-ready SVG fragment: single-subpath `<path id d>` elements
   *  in draw order — the SAME shape the library assets carry. */
  svgFragment: string;
  viewBox: { w: number; h: number };
  strokes: number;
  commands: number;
  workingSize: { w: number; h: number };
  receipt: TraceReceipt;
}

/** Readable rejection — every failure names what went wrong and what to
 *  do instead (the upload gates' error vocabulary). */
export class TraceError extends Error {}

// ---------------------------------------------------------------------------
// Stage 1 — decode + normalize (sharp)
// ---------------------------------------------------------------------------

export interface GrayscaleImage {
  gray: Uint8Array;
  w: number;
  h: number;
  sourceW: number;
  sourceH: number;
  format: "png" | "jpeg";
}

/** Decode PNG/JPEG bytes → single-channel grayscale working image, longest
 *  edge capped at maxWorkingSize (aspect preserved). sharp owns the codec
 *  reality; everything downstream is pure arithmetic on the buffer. */
export async function grayscaleResize(bytes: Buffer, maxWorkingSize: number): Promise<GrayscaleImage> {
  let meta: SharpMetadata;
  try {
    meta = await sharp(bytes).metadata();
  } catch {
    throw new TraceError("the image could not be decoded — the file may be truncated or corrupt");
  }
  const format = meta.format;
  if (format !== "png" && format !== "jpeg") {
    throw new TraceError(`only PNG and JPEG raster images are supported (got ${format ?? "unknown"})`);
  }
  if (!meta.width || !meta.height || meta.width < 2 || meta.height < 2) {
    throw new TraceError(`the image is ${meta.width ?? 0}×${meta.height ?? 0}px — at least 2×2 is required to trace`);
  }
  const scale = Math.min(1, maxWorkingSize / Math.max(meta.width, meta.height));
  const w = Math.max(2, Math.round(meta.width * scale));
  const h = Math.max(2, Math.round(meta.height * scale));
  const { data, info } = await sharp(bytes)
    .grayscale()
    .resize(w, h, { fit: "fill", kernel: "lanczos3" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  // Defensive channel fold: grayscale raw normally lands 1 channel; a
  // palette oddity could surface 3/4 — average them (deterministic).
  const ch = info.channels;
  const gray = new Uint8Array(w * h);
  if (ch === 1) {
    gray.set(data.subarray(0, w * h));
  } else {
    for (let i = 0; i < w * h; i++) {
      let sum = 0;
      for (let c = 0; c < ch; c++) sum += data[i * ch + c];
      gray[i] = Math.round(sum / ch);
    }
  }
  return { gray, w, h, sourceW: meta.width, sourceH: meta.height, format };
}

// ---------------------------------------------------------------------------
// Stage 2 — threshold + mask + cleanup + census
// ---------------------------------------------------------------------------

/** Otsu's between-class variance maximum over the 256-bin histogram —
 *  deterministic, no randomness. A degenerate (single-bin) histogram
 *  falls back to the bin below the value so blank images yield ~0 ink. */
export function otsuThreshold(gray: Uint8Array): number {
  const hist = new Float64Array(256);
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
  const total = gray.length;
  let nonEmpty = 0;
  let lastBin = 0;
  for (let b = 0; b < 256; b++) {
    if (hist[b] > 0) {
      nonEmpty++;
      lastBin = b;
    }
  }
  if (nonEmpty <= 1) return Math.max(0, lastBin - 1);
  let sumAll = 0;
  for (let b = 0; b < 256; b++) sumAll += b * hist[b];
  let sumB = 0;
  let wB = 0;
  let best = -1;
  let bestT = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      bestT = t;
    }
  }
  return bestT;
}

export interface BinaryMask {
  mask: Uint8Array;
  inkRatio: number;
  thresholdUsed: number;
}

/** Ink = gray strictly below the threshold (dark ink on white paper). */
export function binaryMask(gray: Uint8Array, w: number, h: number, threshold: "otsu" | number): BinaryMask {
  const t = threshold === "otsu" ? otsuThreshold(gray) : Math.max(0, Math.min(255, Math.round(threshold)));
  const mask = new Uint8Array(w * h);
  let ink = 0;
  for (let i = 0; i < gray.length; i++) {
    if (gray[i] < t) {
      mask[i] = 1;
      ink++;
    }
  }
  return { mask, inkRatio: ink / (w * h), thresholdUsed: t };
}

/** Remove isolated ink pixels (no ink neighbor in the 8-neighborhood) —
 *  salt-noise the skeletonizer would turn into 1px dots. One deterministic
 *  pass into a fresh array (no in-place order dependence). */
export function removeIsolatedPixels(mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (mask[ny * w + nx]) n++;
        }
      }
      if (n > 0) out[i] = 1;
    }
  }
  return out;
}

/** 4-connected component census (iterative stack flood fill — no
 *  recursion, deterministic row-major seeding). */
export function countComponents(mask: Uint8Array, w: number, h: number): number {
  const seen = new Uint8Array(mask.length);
  const stack: number[] = [];
  let count = 0;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    count++;
    stack.push(start);
    seen[start] = 1;
    while (stack.length > 0) {
      const i = stack.pop() as number;
      const x = i % w;
      const y = (i - x) / w;
      if (x > 0 && mask[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1); }
      if (x < w - 1 && mask[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1); }
      if (y > 0 && mask[i - w] && !seen[i - w]) { seen[i - w] = 1; stack.push(i - w); }
      if (y < h - 1 && mask[i + w] && !seen[i + w]) { seen[i + w] = 1; stack.push(i + w); }
    }
  }
  return count;
}

// The quality-class thresholds (exported for the battery's pins; the
// classification is deliberately CONSERVATIVE at the rejecting end —
// over-rejection costs real uploads, under-rejection costs one bad trace).
export const TRACE_QUALITY_THRESHOLDS = {
  /** ink pixels / total below this = essentially blank. */
  blankInkRatio: 0.002,
  /** ink coverage above this = solid areas / a photograph's tones. */
  denseInkRatio: 0.62,
  /** more components than this = photo noise, not deliberate linework. */
  noisyComponents: 5000,
  /** speckle noise: a big majority of TINY components (≤4px) is photo
   *  grain, not linework — catches mid-density noise the raw count
   *  misses (a 900-speck photograph has hundreds of components, each
   *  a dot). */
  noisyTinyFrac: 0.75,
  noisyMinComponents: 300,
  /** the combined photo shape: heavy coverage AND fragmented ink. */
  photoInkRatio: 0.28,
  photoComponents: 2500,
  /** few components + thin coverage = an icon. */
  iconComponents: 40,
  iconInkRatio: 0.06,
} as const;

export function classifyQuality(inkRatio: number, components: number, tinyFrac = 0): TraceQualityClass {
  const T = TRACE_QUALITY_THRESHOLDS;
  if (inkRatio < T.blankInkRatio) return "blank";
  if (inkRatio > T.denseInkRatio) return "dense";
  if (components > T.noisyComponents) return "noisy";
  if (components > T.noisyMinComponents && tinyFrac > T.noisyTinyFrac) return "noisy";
  if (inkRatio > T.photoInkRatio && components > T.photoComponents) return "photo";
  if (components <= T.iconComponents && inkRatio < T.iconInkRatio) return "icon";
  if (components <= 300) return "line-art";
  return "illustration";
}

/** 4-connected component census with the size statistics the quality
 *  classifier reads: count, the fraction of tiny (≤4px) components
 *  (photo grain), and the largest component's size. Iterative stack
 *  flood fill — no recursion, deterministic row-major seeding. */
export function componentStats(
  mask: Uint8Array,
  w: number,
  h: number
): { count: number; tinyFrac: number; largest: number } {
  const seen = new Uint8Array(mask.length);
  const stack: number[] = [];
  let count = 0;
  let tiny = 0;
  let largest = 0;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    count++;
    let size = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length > 0) {
      const i = stack.pop() as number;
      size++;
      const x = i % w;
      const y = (i - x) / w;
      if (x > 0 && mask[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1); }
      if (x < w - 1 && mask[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1); }
      if (y > 0 && mask[i - w] && !seen[i - w]) { seen[i - w] = 1; stack.push(i - w); }
      if (y < h - 1 && mask[i + w] && !seen[i + w]) { seen[i + w] = 1; stack.push(i + w); }
    }
    if (size <= 4) tiny++;
    if (size > largest) largest = size;
  }
  return { count, tinyFrac: count > 0 ? tiny / count : 0, largest };
}

/** The STRUCTURAL verdict (post-trace): noise's skeleton merges hundreds
 *  of unrelated specks into a couple of scribbles — strokes ≪ components.
 *  Real linework traces to at least one stroke per deliberate component
 *  (and usually many more: junctions split, hatches multiply). The ratio
 *  law catches mid-density grain the pre-trace census cannot see. */
export function classifyStructure(strokes: number, components: number): "noisy" | null {
  if (components > 60 && strokes / Math.max(1, components) < 0.08) return "noisy";
  return null;
}

// ---------------------------------------------------------------------------
// Stage 3 — Zhang-Suen skeletonization
// ---------------------------------------------------------------------------

/** Zhang-Suen thinning to 1px centerlines. 8-neighborhood in the P2..P9
 *  order (N, NE, E, SE, S, SW, W, NW); two deleting sub-iterations per
 *  pass; stops when a full pass deletes nothing (or the 64-pass guard
 *  fires — a guard that never trips on real linework). Endpoints survive
 *  by construction (the 2 ≤ B ≤ 6 condition), so strokes stay connected. */
export function skeletonize(mask: Uint8Array, w: number, h: number): { skel: Uint8Array; iterations: number } {
  // The P2..P9 ring, row-major-relative: up, up-right, right, down-right,
  // down, down-left, left, up-left.
  const ZS = [
    [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1],
  ] as const;
  let cur = Uint8Array.from(mask);
  let nxt = new Uint8Array(cur.length);
  let iterations = 0;
  for (let pass = 0; pass < 64; pass++) {
    let deleted = 0;
    for (let step = 0; step < 2; step++) {
      nxt.set(cur);
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          if (!cur[i]) continue;
          const seq = [
            cur[i + ZS[0][1] * w + ZS[0][0]],
            cur[i + ZS[1][1] * w + ZS[1][0]],
            cur[i + ZS[2][1] * w + ZS[2][0]],
            cur[i + ZS[3][1] * w + ZS[3][0]],
            cur[i + ZS[4][1] * w + ZS[4][0]],
            cur[i + ZS[5][1] * w + ZS[5][0]],
            cur[i + ZS[6][1] * w + ZS[6][0]],
            cur[i + ZS[7][1] * w + ZS[7][0]],
          ];
          let b = 0;
          let a = 0;
          for (let k = 0; k < 8; k++) {
            b += seq[k];
            if (seq[k] === 0 && seq[(k + 1) % 8] === 1) a++;
          }
          if (b < 2 || b > 6 || a !== 1) continue;
          const p2 = seq[0];
          const p4 = seq[2];
          const p6 = seq[4];
          const p8 = seq[6];
          if (step === 0) {
            if (p2 * p4 * p6 !== 0 || p8 * p2 * p4 !== 0) continue;
          } else {
            if (p2 * p4 * p8 !== 0 || p2 * p6 * p8 !== 0) continue;
          }
          nxt[i] = 0;
          deleted++;
        }
      }
      const swap = cur;
      cur = nxt;
      nxt = swap;
      if (deleted === 0) break;
    }
    iterations = pass + 1;
    if (deleted === 0) break;
  }
  return { skel: cur, iterations };
}

// ---------------------------------------------------------------------------
// Stage 4 — junction-aware centerline following
// ---------------------------------------------------------------------------

export interface TracedStroke {
  /** Working-px points, in pen order. */
  points: { x: number; y: number }[];
}

export interface CenterlineResult {
  strokes: TracedStroke[];
  junctions: number;
}

const NEI8 = [
  [-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1],
] as const;

/** Follow the skeleton into polylines. The law from the plan: strokes end
 *  where the pen would lift — a junction pixel (≥3 skeleton neighbors) is
 *  NEVER crossed twice; a walk steps onto one only to END there, and the
 *  junction pixel stays available for the other arms' walks (shared
 *  endpoint). Endpoint-first, then leftover loops, both row-major
 *  deterministic. Each traced polyline is a simple path in the skeleton
 *  graph — it cannot revisit a pixel, so raw strokes cannot properly
 *  cross themselves. */
export function followCenterlines(skel: Uint8Array, w: number, h: number): CenterlineResult {
  const deg = new Uint8Array(skel.length);
  let junctions = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!skel[i]) continue;
      let d = 0;
      for (const [dx, dy] of NEI8) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        if (skel[ny * w + nx]) d++;
      }
      deg[i] = d;
      if (d >= 3) junctions++;
    }
  }
  const visited = new Uint8Array(skel.length);
  const strokes: TracedStroke[] = [];
  const walk = (sx: number, sy: number): TracedStroke => {
    const pts: { x: number; y: number }[] = [{ x: sx, y: sy }];
    visited[sy * w + sx] = 1;
    let cx = sx;
    let cy = sy;
    for (;;) {
      let pickSimple: { x: number; y: number; deg: number } | null = null;
      let pickAny: { x: number; y: number; deg: number } | null = null;
      for (const [dx, dy] of NEI8) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const ni = ny * w + nx;
        if (!skel[ni] || visited[ni]) continue;
        const c = { x: nx, y: ny, deg: deg[ni] };
        if (!pickAny) pickAny = c;
        if (c.deg <= 2 && !pickSimple) pickSimple = c;
      }
      if (!pickAny) break;
      const next = pickSimple ?? pickAny;
      pts.push({ x: next.x, y: next.y });
      if (next.deg >= 3) break; // end AT the junction — the pen lifts
      visited[next.y * w + next.x] = 1;
      cx = next.x;
      cy = next.y;
    }
    return { points: pts };
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (skel[i] && deg[i] === 1 && !visited[i]) strokes.push(walk(x, y));
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (skel[i] && !visited[i] && deg[i] >= 2) {
        const s = walk(x, y);
        if (s.points.length >= 2) strokes.push(s);
      }
    }
  }
  return { strokes, junctions };
}

// ---------------------------------------------------------------------------
// Stage 5 — simplification (Douglas-Peucker) + the self-crossing guard
// ---------------------------------------------------------------------------

const pointSegDist = (p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
};

/** Douglas-Peucker, stack-based (no recursion depth limits). Endpoints
 *  always survive — the connectivity law the junction splitting paid for. */
export function simplifyPolyline(points: { x: number; y: number }[], epsilon: number): { x: number; y: number }[] {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [lo, hi] = stack.pop() as [number, number];
    if (hi - lo < 2) continue;
    let maxD = -1;
    let maxI = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = pointSegDist(points[i], points[lo], points[hi]);
      if (d > maxD) {
        maxD = d;
        maxI = i;
      }
    }
    if (maxD > epsilon && maxI > 0) {
      keep[maxI] = 1;
      stack.push([lo, maxI], [maxI, hi]);
    }
  }
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number =>
  (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/** PROPER interior crossing of two segments (endpoint touches explicitly
 *  excluded — the same judgment asset-validate.ts applies; collinear
 *  overlap is invisible ink, not a crossing). Scaled epsilon so tiny
 *  working-px segments stay honest. */
function segsProperCross(p1: { x: number; y: number }, p2: { x: number; y: number }, p3: { x: number; y: number }, p4: { x: number; y: number }): boolean {
  const l1 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const l2 = Math.hypot(p4.x - p3.x, p4.y - p3.y);
  const eps = 1e-9 * Math.max(1e-12, l1 * l2);
  const d1 = cross(p3, p4, p1);
  const d2 = cross(p3, p4, p2);
  const d3 = cross(p1, p2, p3);
  const d4 = cross(p1, p2, p4);
  return (
    ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) &&
    ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps))
  );
}

/** First proper self-crossing of one polyline (non-adjacent segment
 *  pairs; index order deterministic). Raw skeleton paths cannot self-
 *  cross (simple paths in the graph) — this guards the SIMPLIFICATION,
 *  whose chords can cut across a near-passing tail (narrow loops like a
 *  handwritten "e"). */
function firstSelfCross(pts: { x: number; y: number }[]): boolean {
  for (let i = 0; i < pts.length - 1; i++) {
    for (let j = i + 2; j < pts.length - 1; j++) {
      if (i === 0 && j === pts.length - 2) continue; // wrap-adjacent on an implicit loop
      if (segsProperCross(pts[i], pts[i + 1], pts[j], pts[j + 1])) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Stage 6 — ordering, budget enforcement, emission
// ---------------------------------------------------------------------------

export function polylineLength(points: { x: number; y: number }[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return len;
}

/** Deterministic reading-order law (the plan's): row bands top→bottom,
 *  long structural strokes before short details inside a band, ties broken
 *  by x then y. Bands are h/8 (min 24px) so large compositions still read
 *  top-down while local details keep their discovery order. */
export function orderStrokes(strokes: TracedStroke[], viewBoxH: number): TracedStroke[] {
  const bandH = Math.max(24, Math.floor(viewBoxH / 8));
  const decorated = strokes.map((s) => {
    let minY = Infinity;
    let minX = Infinity;
    for (const p of s.points) {
      if (p.y < minY) minY = p.y;
      if (p.x < minX) minX = p.x;
    }
    return { s, band: Math.floor(minY / bandH), len: polylineLength(s.points), minX, minY };
  });
  decorated.sort((a, b) => a.band - b.band || b.len - a.len || a.minX - b.minX || a.minY - b.minY);
  return decorated.map((d) => d.s);
}

/** Fixed 1-decimal coordinate formatting (deterministic; toString trims
 *  trailing zeros — stable for identical inputs). */
const fmt = (v: number): string => String(Math.round(v * 10) / 10);

const TRACED_INK = "#1d3557";
const TRACED_STROKE_WIDTH = 3.5;

/** Emit the library-shaped fragment: one single-subpath `<path id d>` per
 *  stroke, draw order = document order, house ink, rounded caps. The ids
 *  (`tr-1` …) satisfy the WB_ID_RE namespace law (no `--`/`::`), so the
 *  renderer's `${assetId}--${pathId}` seam stays unambiguous. */
export function emitStrokeSvg(strokes: TracedStroke[]): { svgFragment: string; commands: number } {
  const parts: string[] = [];
  let commands = 0;
  let n = 0;
  for (const s of strokes) {
    if (s.points.length < 2) continue;
    n++;
    const seg = [`M ${fmt(s.points[0].x)} ${fmt(s.points[0].y)}`];
    for (let i = 1; i < s.points.length; i++) seg.push(`L ${fmt(s.points[i].x)} ${fmt(s.points[i].y)}`);
    commands += s.points.length - 1;
    parts.push(
      `<path id="tr-${n}" d="${seg.join(" ")}" fill="none" stroke="${TRACED_INK}" stroke-width="${TRACED_STROKE_WIDTH}" stroke-linecap="round" stroke-linejoin="round"/>`
    );
  }
  return { svgFragment: parts.join("\n"), commands };
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

/** The working-px → viewBox scale: traced assets behave like library
 *  assets (200-unit viewBoxes) in placement, framing and camera — the
 *  palette places them with the same designScale numbers. */
export const TRACE_VIEWBOX_MAX = 200;

const PER_PATH_RESIMPLIFY_STEPS = 6;

export async function traceRasterToStrokes(bytes: Buffer, opts: TraceOptions = {}): Promise<TraceResult> {
  const maxWorkingSize = opts.maxWorkingSize ?? 1024;
  const thresholdOpt = opts.threshold ?? "otsu";
  const epsilon = opts.simplifyEpsilon ?? 1.2;
  const minStrokeLenPx = opts.minStrokeLenPx ?? 6;
  const maxStrokes = opts.maxStrokes ?? 400;

  const ms = { decode: 0, normalize: 0, threshold: 0, skeleton: 0, trace: 0, simplify: 0, emit: 0 };
  let t0 = Date.now();
  const img = await grayscaleResize(bytes, maxWorkingSize);
  ms.decode = Date.now() - t0;

  t0 = Date.now();
  const { mask: rawMask, inkRatio, thresholdUsed } = binaryMask(img.gray, img.w, img.h, thresholdOpt);
  const mask = removeIsolatedPixels(rawMask, img.w, img.h);
  const stats = componentStats(mask, img.w, img.h);
  const components = stats.count;
  // The census class (pre-trace) — the structural verdict below may override.
  const preQuality = classifyQuality(inkRatio, components, stats.tinyFrac);
  ms.threshold = Date.now() - t0;

  t0 = Date.now();
  const { skel, iterations } = skeletonize(mask, img.w, img.h);
  ms.skeleton = Date.now() - t0;

  t0 = Date.now();
  const { strokes: rawStrokes, junctions } = followCenterlines(skel, img.w, img.h);
  ms.trace = Date.now() - t0;

  t0 = Date.now();
  // Simplify, then GUARD: an over-crossing stroke re-simplifies with a
  // halved epsilon (endpoints pinned) before it is allowed to fall back to
  // the raw polyline — the W3 self-intersection law must never see traced
  // geometry it would refuse.
  let resimplifiedSelfCross = 0;
  const simplified = rawStrokes.map((st) => {
    let eps = epsilon;
    let pts = simplifyPolyline(st.points, eps);
    if (firstSelfCross(pts)) {
      resimplifiedSelfCross++;
      for (let k = 0; k < PER_PATH_RESIMPLIFY_STEPS; k++) {
        eps = eps / 2;
        pts = simplifyPolyline(st.points, eps);
        if (!firstSelfCross(pts)) return pts;
      }
      return st.points; // raw centerline — a simple graph path, crossing-free
    }
    return pts;
  });

  // Length floor + cap: the shortest detail specks drop first (recorded).
  const withLen = simplified
    .map((pts) => ({ pts, len: polylineLength(pts) }))
    .filter((s) => s.len >= minStrokeLenPx && s.pts.length >= 2);
  const droppedShortStrokes = simplified.length - withLen.length;
  // The structural verdict (post-trace, post-length-floor): a mask of
  // hundreds of specks whose skeletons merge into a couple of scribbles is
  // photo grain, not linework — strokes ≪ components after the honest
  // length floor. The structural class overrides the census class.
  const quality = classifyStructure(withLen.length, components) ?? preQuality;
  let droppedForCap = 0;
  const capped = [...withLen].sort((a, b) => a.len - b.len).slice(Math.max(0, withLen.length - maxStrokes));
  droppedForCap = withLen.length - capped.length;
  ms.simplify = Date.now() - t0;

  t0 = Date.now();
  // The viewBox scale (library-parity geometry) applied BEFORE ordering and
  // emission so every downstream number (bands, lengths) is viewBox-space.
  const s = Math.min(1, TRACE_VIEWBOX_MAX / Math.max(img.w, img.h));
  const viewBox = { w: Math.max(16, Math.round(img.w * s)), h: Math.max(16, Math.round(img.h * s)) };
  const scaled: TracedStroke[] = capped.map((st) => ({ points: st.pts.map((p) => ({ x: p.x * s, y: p.y * s })) }));

  // Per-path budget: re-simplify with a growing epsilon until the expanded
  // command count fits (endpoints survive DP, so connectivity holds).
  const perPath = scaled.map((st) => {
    let pts = st.points;
    // The path budget is in EXPANDED commands = points − 1 for an open
    // polyline; DP re-simplification with a growing epsilon enforces it
    // (endpoints survive, so connectivity holds even in the worst case).
    let eps = Math.max(epsilon * s, 0.5);
    let guard = 0;
    while (pts.length - 1 > WB_TRACED_PATH_BUDGET && guard < PER_PATH_RESIMPLIFY_STEPS) {
      eps = eps * 1.6;
      pts = simplifyPolyline(pts, eps);
      guard++;
    }
    return { points: pts, len: polylineLength(pts) };
  });

  // Total budget: drop the shortest strokes first, recorded (never silent).
  const totalCommands = () => perPath.reduce((a, st) => a + Math.max(1, st.points.length - 1), 0);
  let droppedOverBudget = 0;
  const byLen = [...perPath].sort((a, b) => a.len - b.len);
  let over = totalCommands();
  const keptSet = new Set(perPath);
  while (over > WB_TRACED_TOTAL_BUDGET && keptSet.size > 1) {
    const shortest = byLen.find((st) => keptSet.has(st));
    if (!shortest) break;
    keptSet.delete(shortest);
    droppedOverBudget++;
    over = totalCommands();
  }
  const kept = [...keptSet];

  // The reading-order law, THEN emission (document order = draw order).
  const ordered = orderStrokes(kept.map((st) => ({ points: st.points })), viewBox.h);
  const { svgFragment, commands } = emitStrokeSvg(ordered);
  ms.emit = Date.now() - t0;

  const receipt: TraceReceipt = {
    sourceFormat: img.format,
    sourceBytes: bytes.length,
    sourceSize: { w: img.sourceW, h: img.sourceH },
    workingSize: { w: img.w, h: img.h },
    thresholdMode: thresholdOpt === "otsu" ? "otsu" : "fixed",
    thresholdUsed,
    inkRatio,
    components,
    quality,
    junctions,
    skeletonIterations: iterations,
    strokesRaw: rawStrokes.length,
    strokesKept: ordered.length,
    droppedShortStrokes,
    droppedForCap,
    droppedOverBudget,
    resimplifiedSelfCross,
    commands,
    viewBox,
    ms,
  };
  if (ordered.length === 0) {
    throw new TraceError(
      `the trace produced 0 strokes (ink ${Math.round(inkRatio * 10000) / 100}%, ${components} components, classified "${quality}") — the image may be a solid photo or a blank canvas without line art; try a higher-contrast line-art source`
    );
  }
  return { svgFragment, viewBox, strokes: ordered.length, commands, workingSize: { w: img.w, h: img.h }, receipt };
}
