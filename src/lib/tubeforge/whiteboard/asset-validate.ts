// W3 — the stroke-authored asset validator.
//
// The single-subpath / no-teleport law is today CONVENTION-ONLY: the S67
// receipt (docs/audits/s67-…record.md) records that the prototype library
// had to be hand-split because a mid-path M teleports the drawing hand —
// but nothing GATES that law. A multi-subpath path (or a self-crossing
// stroke, a zero-winding closed shape, a fill drawn before its outline)
// renders broken ink with no check firing. This module turns the
// conventions into checks (S120 §3 W3): pure functions over the asset's
// extracted geometry, each returning `{ok, reason, pathId?}`, aggregated
// by `validateAsset` into one report.
//
// The three-tier deployment (the risk register's over-rejection answer):
//   built-ins  — loadLibrary throws (a built-in failing its own validator
//                is a programming error, never a data condition);
//   uploads    — validateUploadedSvg rejects with the readable reasons;
//   library    — loadLibrary warn-and-EXCLUDES failing uploads (the row
//                stays, the asset stops validating) without mutating any
//                doc — the doc law is untouched by construction (this
//                module never sees a project document).
//
// Determinism law: same asset in → same report out, byte-identical (the
// suite pins the double-run equality). No fs, no clock, no randomness.
import { flattenPath, parsePathData, type PathSegment, type Point } from "./svg";
import { extractAsset, type ExtractedAsset, type WhiteboardAsset } from "./assets";

/** The readable-ink wall: a stroke wider than this cannot ride the hand
 *  aesthetic (the library's pens are 3–7 units). Generous, not tasteful —
 *  the check exists to catch stroke-width="0" / negative / missing, with
 *  the ceiling as a sane backstop. */
export const WB_STROKE_WIDTH_MAX = 64;

/** The linecap vocabulary SVG itself allows (anything else is a typo the
 *  browser would silently ignore — a pen that draws butt when the artist
 *  asked for round). */
export const WB_STROKE_CAPS = ["butt", "round", "square"] as const;

/** Geometric epsilon (asset units). Cross products below this are
 *  collinear; a REAL crossing in a ≥16-unit viewBox produces cross
 *  products many orders of magnitude above it. */
const EPS = 1e-6;

export type AssetCheckId =
  | "teleport"
  | "self-intersection"
  | "caps"
  | "closed-direction"
  | "fill-after-outline"
  | "orientation";

export interface AssetFinding {
  check: AssetCheckId;
  ok: boolean;
  reason?: string;
  pathId?: string;
}

export interface AssetValidationReport {
  assetId: string;
  /** True when no check rejected. */
  ok: boolean;
  /** ONLY the failing findings — a passing asset carries no prose. */
  findings: AssetFinding[];
}

const okFinding = (check: AssetCheckId, pathId?: string): AssetFinding => ({ check, ok: true, pathId });
const failFinding = (check: AssetCheckId, reason: string, pathId?: string): AssetFinding => ({
  check,
  ok: false,
  reason,
  pathId,
});

/** The pen attributes extractAsset lifts off each path tag (additive W3
 *  enrichment — consumers that only read {id, d} are untouched). */
export type PenPath = ExtractedAsset["paths"][number];

// ---------------------------------------------------------------------------
// Geometry helpers (pure, local — svg.ts owns the path grammar, this module
// owns only the *judgment* over the flattened polylines)
// ---------------------------------------------------------------------------

const cross = (o: Point, a: Point, b: Point): number =>
  (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/** PROPER interior crossing of two segments — endpoint touches are
 *  explicitly NOT crossings: every closed shape legitimately closes by
 *  touching its own start, strokes legitimately END on earlier strokes
 *  (a T), and curve samples meet their neighbors at shared vertices. A
 *  real crossing flips the sign of all four cross products with margin
 *  (eps scales with the segments' lengths — coordinate magnitude is
 *  viewBox-dependent). Collinear overlaps are invisible ink (the pen
 *  retracing its own line) and are not the check's business. */
function segsProperCross(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
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

interface FlatSub {
  points: Point[];
  closed: boolean;
}

function flattenSubpaths(d: string): FlatSub[] {
  return flattenPath(parsePathData(d)).map((s: PathSegment) => ({ points: s.points, closed: s.closed }));
}

/** Signed area (shoelace) of a closed subpath — the winding's unit of
 *  account. Zero net area = the shape retraces itself (a figure-8 or an
 *  out-and-back line): drawable ink, but a fill with no inside. */
function signedArea(points: Point[]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

function pointInPolygon(q: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i];
    const pj = poly[j];
    if (
      (pi.y > q.y) !== (pj.y > q.y) &&
      q.x < ((pj.x - pi.x) * (q.y - pi.y)) / (pj.y - pi.y) + pi.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function polylineLength(points: Point[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return len;
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

/** checkTeleport — the S67 law, gated at last: a path is ONE continuous
 *  stroke. A second M mid-path (relative m included — the flattener
 *  normalizes both) lifts the pen and teleports the hand; fewer than two
 *  drawable points means there is no stroke to ride at all. */
export function checkTeleport(path: { id: string; d: string }): AssetFinding {
  const subs = flattenSubpaths(path.d);
  const drawable = subs.filter((s) => s.points.length >= 2);
  if (subs.length > 1) {
    return failFinding(
      "teleport",
      `path "${path.id}" draws ${subs.length} separate strokes (a mid-path M/m teleports the hand) — split it into one path per stroke`,
      path.id
    );
  }
  if (drawable.length === 0) {
    return failFinding("teleport", `path "${path.id}" has fewer than two drawable points — nothing for the pen to trace`, path.id);
  }
  return okFinding("teleport", path.id);
}

/** checkSelfIntersection — segment-pair intersection on the flattened
 *  polylines (O(n·m) under the 512-command wall, with a uniform-grid cull
 *  so legal dense paths stay cheap). Segments that legitimately share an
 *  endpoint (adjacent in the polyline, plus the closing wrap on a closed
 *  subpath) are excluded; degenerate zero-length segments are skipped. */
export function checkSelfIntersection(path: { id: string; d: string }): AssetFinding {
  const subs = flattenSubpaths(path.d);
  for (const sub of subs) {
    const pts = sub.points;
    if (pts.length < 2) continue;
    // Segment list; a closed subpath adds the wrap segment last→first.
    const segs: { a: Point; b: Point }[] = [];
    for (let i = 1; i < pts.length; i++) segs.push({ a: pts[i - 1], b: pts[i] });
    if (sub.closed) segs.push({ a: pts[pts.length - 1], b: pts[0] });
    const n = segs.length;
    // Uniform-grid cull: bucket segments by AABB, test only co-cell pairs.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of segs) {
      minX = Math.min(minX, s.a.x, s.b.x); minY = Math.min(minY, s.a.y, s.b.y);
      maxX = Math.max(maxX, s.a.x, s.b.x); maxY = Math.max(maxY, s.a.y, s.b.y);
    }
    const span = Math.max(maxX - minX, maxY - minY, 1);
    const cell = span / 32;
    const buckets = new Map<string, number[]>();
    const key = (cx: number, cy: number): string => `${cx},${cy}`;
    for (const [i, s] of segs.entries()) {
      if (Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y) <= EPS) continue; // degenerate
      const x0 = Math.floor((Math.min(s.a.x, s.b.x) - minX) / cell);
      const x1 = Math.floor((Math.max(s.a.x, s.b.x) - minX) / cell);
      const y0 = Math.floor((Math.min(s.a.y, s.b.y) - minY) / cell);
      const y1 = Math.floor((Math.max(s.a.y, s.b.y) - minY) / cell);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cy = y0; cy <= y1; cy++) {
          const k = key(cx, cy);
          const list = buckets.get(k);
          if (list) list.push(i);
          else buckets.set(k, [i]);
        }
      }
    }
    const tested = new Set<string>();
    for (const list of buckets.values()) {
      for (let x = 0; x < list.length; x++) {
        for (let y = x + 1; y < list.length; y++) {
          const i = list[x];
          const j = list[y];
          let lo = i;
          let hi = j;
          if (lo > hi) [lo, hi] = [hi, lo];
          if (lo === hi) continue;
          const adjacent = hi - lo === 1 || (lo === 0 && hi === n - 1);
          if (adjacent) continue;
          const pairKey = `${lo}:${hi}`;
          if (tested.has(pairKey)) continue;
          tested.add(pairKey);
          if (segsProperCross(segs[lo].a, segs[lo].b, segs[hi].a, segs[hi].b)) {
            return failFinding(
              "self-intersection",
              `path "${path.id}" crosses itself (segments ${i} and ${j}) — the hand would redraw over wet ink`,
              path.id
            );
          }
        }
      }
    }
  }
  return okFinding("self-intersection", path.id);
}

/** checkCaps — pen sanity for one path, plus (when the asset declares
 *  penGroups) consistency inside the pen group: every path of a group
 *  must carry the SAME stroke-width and linecap as the group's reference
 *  (the first declared pen in document order) — one group, one pen. */
export function checkCaps(
  path: PenPath,
  groupRef?: { strokeWidth?: number; linecap?: string }
): AssetFinding {
  const stroke = path.stroke;
  if (stroke === undefined || stroke === "none") return okFinding("caps", path.id);
  const sw = path.strokeWidth;
  if (sw === undefined || !Number.isFinite(sw) || sw <= 0) {
    return failFinding("caps", `path "${path.id}" declares a stroke but no usable stroke-width`, path.id);
  }
  if (sw > WB_STROKE_WIDTH_MAX) {
    return failFinding("caps", `path "${path.id}" stroke-width ${sw} exceeds the ${WB_STROKE_WIDTH_MAX} wall`, path.id);
  }
  const cap = path.linecap;
  if (cap !== undefined && !(WB_STROKE_CAPS as readonly string[]).includes(cap)) {
    return failFinding(
      "caps",
      `path "${path.id}" linecap "${cap}" is not one of ${WB_STROKE_CAPS.join("|")}`,
      path.id
    );
  }
  if (groupRef && groupRef.strokeWidth !== undefined && groupRef.strokeWidth !== sw) {
    return failFinding(
      "caps",
      `path "${path.id}" stroke-width ${sw} breaks its pen group's ${groupRef.strokeWidth}`,
      path.id
    );
  }
  if (groupRef && groupRef.linecap !== undefined && groupRef.linecap !== cap) {
    return failFinding(
      "caps",
      `path "${path.id}" linecap "${cap ?? "none"}" breaks its pen group's "${groupRef.linecap}"`,
      path.id
    );
  }
  return okFinding("caps", path.id);
}

/** checkClosedDirection — a closed shape must wind: net signed area ≈ 0
 *  means the outline doubles back on itself (a fill would have no
 *  inside to order). Open subpaths are not the check's business. */
export function checkClosedDirection(path: { id: string; d: string }): AssetFinding {
  const subs = flattenSubpaths(path.d);
  for (const sub of subs) {
    if (!sub.closed || sub.points.length < 3) continue;
    const area = Math.abs(signedArea(sub.points));
    if (area < 1e-3) {
      return failFinding(
        "closed-direction",
        `path "${path.id}" closes with degenerate winding (net area ≈ ${area.toExponential(1)}) — the outline retraces itself`,
        path.id
      );
    }
  }
  return okFinding("closed-direction", path.id);
}

const isPenPath = (p: PenPath): boolean => p.stroke !== undefined && p.stroke !== "none";
const isPureFill = (p: PenPath): boolean =>
  !isPenPath(p) && p.fill !== undefined && p.fill !== "none";

/** checkFillAfterOutline — the draw-order law for solid fills: a pure
 *  fill (no stroke) must appear AFTER a stroke path whose outline
 *  contains it, or the fill shows before its boundary exists. The hand
 *  asset is exempt (tags "hand"): it is the drawing agent, never
 *  scheduled, and its fills (nib, band) lead the document by design. */
export function checkFillAfterOutline(asset: WhiteboardAsset, ex: ExtractedAsset): AssetFinding[] {
  const findings: AssetFinding[] = [];
  if (asset.tags.includes("hand")) return findings;
  const penIds: string[] = [];
  const outlines = new Map<string, Point[]>();
  for (const p of ex.paths) {
    if (isPenPath(p) && !outlines.has(p.id)) {
      const subs = flattenSubpaths(p.d);
      if (subs.length > 0) outlines.set(p.id, subs[0].points);
      penIds.push(p.id);
    }
  }
  for (const p of ex.paths) {
    if (!isPureFill(p)) continue;
    const subs = flattenSubpaths(p.d);
    const probe = subs[0]?.points[0];
    if (!probe) continue; // teleport flags the empty geometry
    const myIndex = ex.paths.findIndex((x) => x.id === p.id);
    const before = ex.paths.slice(0, myIndex).filter(isPenPath);
    const container = before.find((s) => {
      const poly = outlines.get(s.id);
      return poly ? pointInPolygon(probe, poly) : false;
    });
    if (!container) {
      findings.push(
        failFinding(
          "fill-after-outline",
          `fill path "${p.id}" appears before any stroke outline that contains it — the fill would show before its boundary is drawn`,
          p.id
        )
      );
    }
  }
  return findings;
}

/** checkOrientation — up-vector sanity for the roles that have one:
 *  arrows must point where their stem ends (the head sits at the TIP,
 *  not the tail), and label anchors must land inside the asset's own
 *  viewBox (a label outside its box is upside-down thinking). */
export function checkOrientation(asset: WhiteboardAsset, ex: ExtractedAsset): AssetFinding[] {
  const findings: AssetFinding[] = [];
  const isArrow = asset.role === "arrow" || asset.tags.includes("arrow");
  const isLabel = asset.role === "label" || asset.tags.includes("labels");
  if (isArrow) {
    const pens = ex.paths.filter(isPenPath);
    if (pens.length >= 2) {
      let stem = pens[0];
      let stemLen = -1;
      const lens = new Map<string, { len: number; tip: Point }>();
      for (const p of pens) {
        const subs = flattenSubpaths(p.d);
        let len = 0;
        let tip: Point | null = null;
        for (const s of subs) {
          len += polylineLength(s.points);
          tip = s.points[s.points.length - 1] ?? tip;
        }
        if (tip) lens.set(p.id, { len, tip });
        if (len > stemLen) {
          stemLen = len;
          stem = p;
        }
      }
      const head = pens[pens.length - 1];
      const headSubs = flattenSubpaths(head.d);
      const headPts = headSubs[0]?.points ?? [];
      const stemTip = lens.get(stem.id)?.tip;
      if (headPts.length > 0 && stemTip) {
        const cx = headPts.reduce((s, q) => s + q.x, 0) / headPts.length;
        const cy = headPts.reduce((s, q) => s + q.y, 0) / headPts.length;
        const dist = Math.hypot(cx - stemTip.x, cy - stemTip.y);
        const diag = Math.hypot(asset.viewBox.w, asset.viewBox.h);
        if (dist > 0.35 * diag) {
          findings.push(
            failFinding(
              "orientation",
              `arrow "${asset.id}": the head sits ${Math.round(dist)} units from the stem's tip (limit ${Math.round(0.35 * diag)}) — flipped or detached`,
              head.id
            )
          );
        }
      }
    }
  }
  if (isLabel) {
    for (const t of ex.texts) {
      if (t.x < 0 || t.y < 0 || t.x > asset.viewBox.w || t.y > asset.viewBox.h) {
        findings.push(
          failFinding(
            "orientation",
            `label "${t.id}" anchor (${t.x}, ${t.y}) lands outside the ${asset.viewBox.w}×${asset.viewBox.h} viewBox`,
            t.id
          )
        );
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// The aggregate
// ---------------------------------------------------------------------------

/** validateAsset — all six checks over the asset's extracted geometry.
 *  Pure, deterministic (the suite pins the double-run byte-equality). */
export function validateAsset(asset: WhiteboardAsset): AssetValidationReport {
  const ex = extractAsset(asset);
  const failures: AssetFinding[] = [];
  // Pen-group references: the first declared pen of each group (document
  // order) is the reference every other member must match.
  const groupRefByPath = new Map<string, { strokeWidth?: number; linecap?: string }>();
  if (asset.penGroups) {
    for (const members of Object.values(asset.penGroups)) {
      const ref = ex.paths.find((p) => members.includes(p.id) && isPenPath(p));
      if (!ref) continue;
      for (const id of members) {
        if (id !== ref.id) groupRefByPath.set(id, { strokeWidth: ref.strokeWidth, linecap: ref.linecap });
      }
    }
  }
  for (const p of ex.paths) {
    for (const f of [
      checkTeleport(p),
      checkSelfIntersection(p),
      checkCaps(p, groupRefByPath.get(p.id)),
      checkClosedDirection(p),
    ]) {
      if (!f.ok) failures.push(f);
    }
  }
  failures.push(...checkFillAfterOutline(asset, ex).filter((f) => !f.ok));
  failures.push(...checkOrientation(asset, ex).filter((f) => !f.ok));
  return { assetId: asset.id, ok: failures.length === 0, findings: failures };
}
