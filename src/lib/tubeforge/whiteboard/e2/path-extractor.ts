// path-extractor.ts — turns a validated SVG tree into ordered drawable paths.
//
// Pipeline: validated SVG element tree (from svg-validator) → list of paths
// with assigned order + computed arc length + deterministic draw duration.
// The registry consumes this to build WhiteboardAsset records.
//
// Duration assignment is deterministic: durationMs = clamp(L * MS_PER_PX, 120, 2400)
// where L is the path's arc length on the asset's local (viewBox) coordinate
// system. This makes the drawing speed feel consistent across assets.

import { LIMITS, type PathSpec, type WhiteboardAsset } from "./schemas";
import { arcLength, parsePath, samplePath, type SampledPath, type PathCommand } from "./geometry";
import { type SvgElement, validatedRoot, validateSvg } from "./svg-validator";

const MS_PER_PX = 4; // ~250 px/s draw speed → 1s for a 250px path
const MIN_DURATION_MS = 120;
const MAX_DURATION_MS = 2400;

export interface ExtractedPath extends PathSpec {
  /** Raw SVG `d` attribute — the composer needs it to draw the stroke. */
  d: string;
  /** Parsed commands (debugging + tests). */
  commands: PathCommand[];
  /** Flattened + arc-length-aware sampled path (geometry cache). */
  sampled: SampledPath;
  /** Default stroke color picked up from the path element or its nearest ancestor <g>. */
  stroke: string;
  strokeWidth: number;
  /** Default fill (none unless explicitly set). */
  fill: string | null;
  /** Stroke linecap (default round). */
  strokeLinecap: "butt" | "round" | "square";
  strokeLinejoin: "miter" | "round" | "bevel";
}

export class PathExtractionError extends Error {
  constructor(message: string) {
    super(`PathExtractionError: ${message}`);
    this.name = "PathExtractionError";
  }
}

interface InheritedStyle {
  stroke: string;
  strokeWidth: number;
  fill: string | null;
  strokeLinecap: "butt" | "round" | "square";
  strokeLinejoin: "miter" | "round" | "bevel";
}

const DEFAULT_STYLE: InheritedStyle = {
  stroke: "#111827",
  strokeWidth: 6,
  fill: null,
  strokeLinecap: "round",
  strokeLinejoin: "round",
};

function parseStrokeWidth(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const s = raw.trim().replace(/px$/, "");
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

function applyElementStyle(el: SvgElement, inherited: InheritedStyle): InheritedStyle {
  return {
    stroke: el.attrs.stroke || inherited.stroke,
    strokeWidth: parseStrokeWidth(el.attrs["stroke-width"], inherited.strokeWidth),
    fill: el.attrs.fill === undefined ? inherited.fill : (el.attrs.fill === "none" ? null : el.attrs.fill),
    strokeLinecap: (el.attrs["stroke-linecap"] as InheritedStyle["strokeLinecap"]) || inherited.strokeLinecap,
    strokeLinejoin: (el.attrs["stroke-linejoin"] as InheritedStyle["strokeLinejoin"]) || inherited.strokeLinejoin,
  };
}

function viewBox(el: SvgElement): { x: number; y: number; w: number; h: number } | null {
  const v = el.attrs.viewBox;
  if (!v) return null;
  const parts = v.trim().split(/\s+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new PathExtractionError(`invalid viewBox "${v}"`);
  }
  return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
}

/** Recursive walk; pushes path elements in document order. */
function collectPaths(
  el: SvgElement,
  inherited: InheritedStyle,
  out: ExtractedPath[],
  counter: { n: number },
): void {
  const style = applyElementStyle(el, inherited);
  if (el.name === "path") {
    const d = el.attrs.d;
    if (!d) throw new PathExtractionError("<path> has no `d` attribute");
    let commands: PathCommand[];
    try {
      commands = parsePath(d);
    } catch (e) {
      throw new PathExtractionError(`failed to parse path d="${d.slice(0, 40)}…": ${(e as Error).message}`);
    }
    const sampled = samplePath(commands);
    const L = arcLength(sampled);
    const durationMs = Math.min(
      MAX_DURATION_MS,
      Math.max(MIN_DURATION_MS, Math.round(L * MS_PER_PX)),
    );
    const id = el.attrs.id || `p${counter.n}`;
    counter.n += 1;
    out.push({
      id,
      order: out.length,
      durationMs,
      d,
      commands,
      sampled,
      stroke: style.stroke,
      strokeWidth: style.strokeWidth,
      fill: style.fill,
      strokeLinecap: style.strokeLinecap,
      strokeLinejoin: style.strokeLinejoin,
    });
    return;
  }
  for (const c of el.children) {
    collectPaths(c, style, out, counter);
  }
}

export interface ExtractedAsset {
  /** Asset record (without the path geometry — registry attaches that). */
  asset: Omit<WhiteboardAsset, "paths"> & { paths: PathSpec[] };
  /** Full path geometry (for the renderer + tests). */
  paths: ExtractedPath[];
  /** The viewBox the asset was authored in. */
  viewBox: { x: number; y: number; w: number; h: number } | null;
  /** Size on disk in bytes (the original source). */
  sizeBytes: number;
}

export function extractAsset(source: string, meta: {
  id: string;
  name: string;
  category: string;
  tags: string[];
}): ExtractedAsset {
  if (source.length > LIMITS.MAX_ASSET_BYTES) {
    throw new PathExtractionError(
      `asset source is ${source.length} bytes, exceeds MAX_ASSET_BYTES (${LIMITS.MAX_ASSET_BYTES})`,
    );
  }
  const validated = validateSvg(source);
  const root = validated.root;
  const vb = viewBox(root);
  const paths: ExtractedPath[] = [];
  collectPaths(root, DEFAULT_STYLE, paths, { n: 0 });
  if (paths.length === 0) {
    throw new PathExtractionError("asset has no drawable <path> elements");
  }
  if (paths.length > LIMITS.MAX_PATHS_PER_ASSET) {
    throw new PathExtractionError(
      `asset has ${paths.length} paths, exceeds MAX_PATHS_PER_ASSET (${LIMITS.MAX_PATHS_PER_ASSET})`,
    );
  }
  const pathSpecs: PathSpec[] = paths.map((p) => ({
    id: p.id,
    order: p.order,
    durationMs: p.durationMs,
  }));
  return {
    asset: {
      id: meta.id,
      type: "svg",
      name: meta.name,
      category: meta.category,
      tags: meta.tags,
      paths: pathSpecs,
    },
    paths,
    viewBox: vb,
    sizeBytes: validated.sizeBytes,
  };
}

/**
 * Convenience for the registry + tests: validate, extract, attach geometry.
 * The returned map is keyed by path id for O(1) animator lookups.
 */
export function extractPathMap(source: string): Map<string, ExtractedPath> {
  // re-validate to get the tree without constructing a full asset record
  validatedRoot(source); // throws if unsafe — defense in depth
  const paths: ExtractedPath[] = [];
  collectPaths(validateSvg(source).root, DEFAULT_STYLE, paths, { n: 0 });
  return new Map(paths.map((p) => [p.id, p]));
}
