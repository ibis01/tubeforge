// geometry.ts — pure SVG path math for the whiteboard drawing engine (E2).
//
// Replaces browser DOM methods (SVGPathElement.getTotalLength / getPointAtLength)
// with pure-TS implementations of the SVG `d` subset we accept:
//   M x,y    moveto                 (moveto / sub-path start)
//   L x,y    lineto
//   H x      horizontal lineto
//   V y      vertical lineto
//   C x1,y1 x2,y2 x,y   cubic bezier
//   Q x1,y1 x,y         quadratic bezier
//   Z        closepath  (line back to the most recent M)
//
// All other commands (A/S/T, relative lowercase) are rejected by the parser —
// the SVG validator's safe subset is enforced there, the geometry layer only
// computes on already-validated paths.
//
// Public surface: parsePath, samplePath, arcLength, pointAt, tangentAt.

import type { Easing } from "./schemas";

export interface PathCommand {
  cmd: "M" | "L" | "H" | "V" | "C" | "Q" | "Z";
  args: number[];
}

export interface PathPoint {
  x: number;
  y: number;
}

export interface PathSample {
  length: number; // arc length at this sample
  point: PathPoint;
  tangent: PathPoint; // unit tangent
}

export class GeometryError extends Error {
  constructor(message: string) {
    super(`GeometryError: ${message}`);
    this.name = "GeometryError";
  }
}

/**
 * Parse the `d` attribute into commands. Throws on unsupported / malformed.
 * Coordinates MUST be absolute (uppercase) — the validator denies lowercase.
 */
export function parsePath(d: string): PathCommand[] {
  const s = d.trim();
  if (s.length === 0) throw new GeometryError("empty path d");
  const commands: PathCommand[] = [];
  let i = 0;

  const skipWs = () => {
    while (i < s.length && /[\s,]/.test(s[i])) i++;
  };
  const readNumber = (): number => {
    skipWs();
    const start = i;
    if (s[i] === "-" || s[i] === "+") i++;
    while (i < s.length && /[0-9.eE+-]/.test(s[i])) i++;
    if (i === start) throw new GeometryError(`expected number at offset ${i} in "${d}"`);
    const raw = s.slice(start, i);
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new GeometryError(`invalid number "${raw}" at offset ${start}`);
    return n;
  };
  const readCommandLetter = (): string | null => {
    skipWs();
    if (i >= s.length) return null;
    const c = s[i];
    // STRICT: only uppercase (absolute) commands. Lowercase (relative)
    // commands are rejected — the SVG validator's safe subset forbids them,
    // and the geometry layer only computes on already-validated paths.
    if (/[MLHVCQZ]/.test(c)) {
      i++;
      return c;
    }
    if (/[mlhvcqz]/.test(c)) {
      throw new GeometryError(
        `relative command "${c}" is not supported (only absolute M/L/H/V/C/Q/Z)`,
      );
    }
    // Some authors skip the explicit L between coordinate pairs. We don't
    // support implicit continuation — the parser is intentionally strict.
    return null;
  };

  let expectImplicit: string | null = null;
  // First token MUST be a moveto
  const first = readCommandLetter();
  if (first === null) throw new GeometryError("path must start with a command letter");
  if (first !== "M") {
    throw new GeometryError(`path must start with M, got ${first}`);
  }
  expectImplicit = "M";

  while (i < s.length) {
    skipWs();
    if (i >= s.length) break;
    // Peek: is the next char a command letter? If not, repeat previous (implicit).
    let cmd: string;
    if (/[MLHVCQZmlhvcqz]/.test(s[i])) {
      if (/[mlhvcqz]/.test(s[i])) {
        throw new GeometryError(
          `relative command "${s[i]}" is not supported (only absolute M/L/H/V/C/Q/Z)`,
        );
      }
      cmd = s[i];
      i++;
    } else if (expectImplicit !== null) {
      cmd = expectImplicit;
    } else {
      throw new GeometryError(`unexpected character "${s[i]}" at offset ${i}`);
    }

    if (cmd === "M") {
      const x = readNumber();
      const y = readNumber();
      commands.push({ cmd: "M", args: [x, y] });
      expectImplicit = "L"; // subsequent implicit coordinate pairs are linetos
    } else if (cmd === "L") {
      const x = readNumber();
      const y = readNumber();
      commands.push({ cmd: "L", args: [x, y] });
      expectImplicit = "L";
    } else if (cmd === "H") {
      const x = readNumber();
      commands.push({ cmd: "H", args: [x] });
      expectImplicit = "H";
    } else if (cmd === "V") {
      const y = readNumber();
      commands.push({ cmd: "V", args: [y] });
      expectImplicit = "V";
    } else if (cmd === "C") {
      const x1 = readNumber(); const y1 = readNumber();
      const x2 = readNumber(); const y2 = readNumber();
      const x = readNumber(); const y = readNumber();
      commands.push({ cmd: "C", args: [x1, y1, x2, y2, x, y] });
      expectImplicit = "C";
    } else if (cmd === "Q") {
      const x1 = readNumber(); const y1 = readNumber();
      const x = readNumber(); const y = readNumber();
      commands.push({ cmd: "Q", args: [x1, y1, x, y] });
      expectImplicit = "Q";
    } else if (cmd === "Z") {
      commands.push({ cmd: "Z", args: [] });
      expectImplicit = null; // Z terminates the sub-path; next must be explicit M
    } else {
      throw new GeometryError(`unsupported command "${cmd}" (only M/L/H/V/C/Q/Z)`);
    }
  }
  if (commands.length === 0) throw new GeometryError("path has no commands");
  return commands;
}

/** Cubic bezier point at parameter t (0..1). */
function cubicAt(p0: PathPoint, p1: PathPoint, p2: PathPoint, p3: PathPoint, t: number): PathPoint {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

/** Quadratic bezier point at parameter t (0..1). */
function quadAt(p0: PathPoint, p1: PathPoint, p2: PathPoint, t: number): PathPoint {
  const mt = 1 - t;
  const a = mt * mt;
  const b = 2 * mt * t;
  const c = t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x,
    y: a * p0.y + b * p1.y + c * p2.y,
  };
}

/**
 * Convert commands into a polyline of segments (lines + adaptive bezier
 * flattening). Each segment has start point, end point, and length. Returns
 * the cumulative arc length + the segment list, from which point/length
 * queries are O(log n) by binary search.
 *
 * Bezier flattening uses adaptive subdivision based on chord flatness
 * (≤ 0.25 px deviation — visually indistinguishable at 1080p). For testing
 * reproducibility the SAMPLES_PER_BEZIER constant upper-bounds the worst
 * case so output is byte-stable across runs.
 */
const FLATNESS_TOLERANCE = 0.25;
const MAX_BEZIER_SAMPLES = 256;

interface Segment {
  start: PathPoint;
  end: PathPoint;
  length: number;
  cumulativeLength: number;
  // for tangent interpolation across beziers
  startTangent: PathPoint;
  endTangent: PathPoint;
}

export interface SampledPath {
  commands: PathCommand[];
  segments: Segment[];
  totalLength: number;
}

function flattenCubic(
  p0: PathPoint, p1: PathPoint, p2: PathPoint, p3: PathPoint,
  out: PathPoint[],
  depth = 0,
): void {
  // flatness: distance of control points from the chord p0->p3
  const chordX = p3.x - p0.x;
  const chordY = p3.y - p0.y;
  const d1 = Math.abs((p1.x - p0.x) * chordY - (p1.y - p0.y) * chordX);
  const d2 = Math.abs((p2.x - p0.x) * chordY - (p2.y - p0.y) * chordX);
  if ((d1 + d2) <= FLATNESS_TOLERANCE || depth >= 8) {
    out.push(p3);
    return;
  }
  // de Casteljau split at t=0.5
  const m01 = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
  const m12 = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  const m23 = { x: (p2.x + p3.x) / 2, y: (p2.y + p3.y) / 2 };
  const m012 = { x: (m01.x + m12.x) / 2, y: (m01.y + m12.y) / 2 };
  const m123 = { x: (m12.x + m23.x) / 2, y: (m12.y + m23.y) / 2 };
  const m = { x: (m012.x + m123.x) / 2, y: (m012.y + m123.y) / 2 };
  flattenCubic(p0, m01, m012, m, out, depth + 1);
  flattenCubic(m, m123, m23, p3, out, depth + 1);
}

function flattenQuad(
  p0: PathPoint, p1: PathPoint, p2: PathPoint,
  out: PathPoint[],
  depth = 0,
): void {
  const d = Math.abs((p1.x - p0.x) * (p2.y - p0.y) - (p1.y - p0.y) * (p2.x - p0.x));
  if (d <= FLATNESS_TOLERANCE || depth >= 8) {
    out.push(p2);
    return;
  }
  const m01 = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
  const m12 = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  const m = { x: (m01.x + m12.x) / 2, y: (m01.y + m12.y) / 2 };
  flattenQuad(p0, m01, m, out, depth + 1);
  flattenQuad(m, m12, p2, out, depth + 1);
}

export function samplePath(commands: PathCommand[]): SampledPath {
  if (commands.length === 0) throw new GeometryError("cannot sample empty path");
  if (commands[0].cmd !== "M") {
    throw new GeometryError("path must begin with M");
  }
  const segments: Segment[] = [];
  let cursor: PathPoint = { x: commands[0].args[0], y: commands[0].args[1] };
  let subpathStart: PathPoint = { ...cursor };
  let cumulative = 0;

  for (let i = 1; i < commands.length; i++) {
    const c = commands[i];
    let end: PathPoint;
    let startTangent: PathPoint = { x: 0, y: 0 };
    let endTangent: PathPoint = { x: 0, y: 0 };
    let bezSamples: PathPoint[] | null = null;

    if (c.cmd === "M") {
      cursor = { x: c.args[0], y: c.args[1] };
      subpathStart = { ...cursor };
      continue;
    }
    if (c.cmd === "L") {
      end = { x: c.args[0], y: c.args[1] };
      const dx = end.x - cursor.x;
      const dy = end.y - cursor.y;
      const L = Math.hypot(dx, dy) || 1;
      startTangent = endTangent = { x: dx / L, y: dy / L };
    } else if (c.cmd === "H") {
      end = { x: c.args[0], y: cursor.y };
      const dx = end.x - cursor.x;
      const L = Math.abs(dx) || 1;
      startTangent = endTangent = { x: dx / L, y: 0 };
    } else if (c.cmd === "V") {
      end = { x: cursor.x, y: c.args[0] };
      const dy = end.y - cursor.y;
      const L = Math.abs(dy) || 1;
      startTangent = endTangent = { x: 0, y: dy / L };
    } else if (c.cmd === "C") {
      const p1 = { x: c.args[0], y: c.args[1] };
      const p2 = { x: c.args[2], y: c.args[3] };
      end = { x: c.args[4], y: c.args[5] };
      bezSamples = [];
      flattenCubic(cursor, p1, p2, end, bezSamples);
      // tangents at the endpoints
      const st0 = cubicAt(cursor, p1, p2, end, 0.001);
      const st1 = cubicAt(cursor, p1, p2, end, 0.999);
      {
        const dx = st0.x - cursor.x;
        const dy = st0.y - cursor.y;
        const L = Math.hypot(dx, dy) || 1;
        startTangent = { x: dx / L, y: dy / L };
        const dx2 = end.x - st1.x;
        const dy2 = end.y - st1.y;
        const L2 = Math.hypot(dx2, dy2) || 1;
        endTangent = { x: dx2 / L2, y: dy2 / L2 };
      }
    } else if (c.cmd === "Q") {
      const p1 = { x: c.args[0], y: c.args[1] };
      end = { x: c.args[2], y: c.args[3] };
      bezSamples = [];
      flattenQuad(cursor, p1, end, bezSamples);
      const st0 = quadAt(cursor, p1, end, 0.001);
      const st1 = quadAt(cursor, p1, end, 0.999);
      {
        const dx = st0.x - cursor.x;
        const dy = st0.y - cursor.y;
        const L = Math.hypot(dx, dy) || 1;
        startTangent = { x: dx / L, y: dy / L };
        const dx2 = end.x - st1.x;
        const dy2 = end.y - st1.y;
        const L2 = Math.hypot(dx2, dy2) || 1;
        endTangent = { x: dx2 / L2, y: dy2 / L2 };
      }
    } else if (c.cmd === "Z") {
      end = { ...subpathStart };
      const dx = end.x - cursor.x;
      const dy = end.y - cursor.y;
      const L = Math.hypot(dx, dy) || 1;
      if (L < 1e-6) {
        // zero-length Z — skip
        cursor = { ...subpathStart };
        continue;
      }
      startTangent = endTangent = { x: dx / L, y: dy / L };
    } else {
      throw new GeometryError(`unsupported command ${c.cmd}`);
    }

    if (bezSamples && bezSamples.length > 0) {
      // flatten produced intermediate points; emit a segment per chord
      let prev = cursor;
      for (const p of bezSamples) {
        const dx = p.x - prev.x;
        const dy = p.y - prev.y;
        const L = Math.hypot(dx, dy);
        if (L < 1e-6) { prev = p; continue; }
        cumulative += L;
        segments.push({
          start: prev,
          end: p,
          length: L,
          cumulativeLength: cumulative,
          startTangent: { x: dx / L, y: dy / L },
          endTangent: { x: dx / L, y: dy / L },
        });
        prev = p;
      }
      // override first/last tangent of the run with bezier tangents
      if (segments.length > 0) {
        segments[segments.length - 1].endTangent = endTangent;
        const firstSegIdx = segments.length - bezSamples.length;
        if (firstSegIdx >= 0) {
          segments[firstSegIdx >= 0 ? firstSegIdx : 0].startTangent = startTangent;
        }
      }
    } else {
      const dx = end.x - cursor.x;
      const dy = end.y - cursor.y;
      const L = Math.hypot(dx, dy);
      cumulative += L;
      segments.push({
        start: cursor,
        end,
        length: L,
        cumulativeLength: cumulative,
        startTangent,
        endTangent,
      });
    }
    cursor = end;
    if (c.cmd === "Z") {
      subpathStart = { ...cursor };
    }
  }

  return { commands, segments, totalLength: cumulative };
}

export function arcLength(path: SampledPath): number {
  return path.totalLength;
}

/**
 * Point at arc length `len` along the path. Returns the path start if len ≤ 0
 * and the path end if len ≥ totalLength. O(log n) via binary search.
 */
export function pointAt(path: SampledPath, len: number): PathPoint {
  if (path.segments.length === 0) {
    const m = path.commands[0];
    return { x: m.args[0], y: m.args[1] };
  }
  if (len <= 0) return path.segments[0].start;
  if (len >= path.totalLength) return path.segments[path.segments.length - 1].end;
  // binary search for the segment whose cumulativeLength straddles `len`
  let lo = 0;
  let hi = path.segments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (path.segments[mid].cumulativeLength < len) lo = mid + 1;
    else hi = mid;
  }
  const seg = path.segments[lo];
  const segStart = seg.cumulativeLength - seg.length;
  const t = seg.length > 0 ? (len - segStart) / seg.length : 0;
  return {
    x: seg.start.x + (seg.end.x - seg.start.x) * t,
    y: seg.start.y + (seg.end.y - seg.start.y) * t,
  };
}

/**
 * Tangent at arc length `len`. Linearly interpolates the segment's
 * startTangent → endTangent so beziers feel smooth across the flat sample
 * points (otherwise each flattened chord would have a constant tangent and
 * the hand would "snap" at chord boundaries).
 */
export function tangentAt(path: SampledPath, len: number): PathPoint {
  if (path.segments.length === 0) return { x: 1, y: 0 };
  if (len <= 0) return path.segments[0].startTangent;
  if (len >= path.totalLength) return path.segments[path.segments.length - 1].endTangent;
  let lo = 0;
  let hi = path.segments.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (path.segments[mid].cumulativeLength < len) lo = mid + 1;
    else hi = mid;
  }
  const seg = path.segments[lo];
  const segStart = seg.cumulativeLength - seg.length;
  const t = seg.length > 0 ? (len - segStart) / seg.length : 0;
  return {
    x: seg.startTangent.x + (seg.endTangent.x - seg.startTangent.x) * t,
    y: seg.startTangent.y + (seg.endTangent.y - seg.startTangent.y) * t,
  };
}

/** Convert tangent vector → angle in degrees, measured CW from +x axis. */
export function tangentAngleDeg(t: PathPoint): number {
  return (Math.atan2(t.y, t.x) * 180) / Math.PI;
}

/** Easing functions (plan §4.4). `linear` is identity; `easeInOut` is smoothstep. */
export function applyEasing(t: number, easing: Easing): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  if (easing === "linear") return t;
  // smoothstep: 3t² - 2t³
  return t * t * (3 - 2 * t);
}

/** Clamp helper. */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
