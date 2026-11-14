// anim/camera — the camera-keys model: validated moves, eased sampling,
// pinhole projection.
//
// Provenance: these are algorithms worth having from the "Stickman Video
// Director" project (MIT-licensed source, audited 2026-11-14),
// REIMPLEMENTED independently in TypeScript (no code copied). This is
// S121 P2 of the unified integration roadmap — the shared Stage-X motion
// primitives the graphics/character lanes build on.
//
// Laws. S64 purity: every function is PURE — no fs, no clock, no
// randomness, no globals; same inputs → same outputs, always (the same
// quantized t is byte-identical across calls). Hold semantics: a sample
// time outside the key span CLAMPS to the boundary keys — a move holds
// its first pose before the span and its last pose after it. The
// null-at-plane law: the projection returns null for a point at or
// behind the camera plane — a non-positive depth is a null result, never
// a division that poisons the output with NaN. Interpolation rides the
// shared easing substrate (evalEase, "ease-in-out" — the ONE motion
// feel); no second cubic is hand-rolled here.
import { evalEase } from "./easing";

/** One key of a camera move: the camera's world pose at time `t`
 *  (seconds). x/y/z are world units, fov is degrees (20–100); yaw/pitch
 *  are optional degrees (absent = 0 — the camera faces its default axis). */
export interface CameraKey {
  t: number;
  x: number;
  y: number;
  z: number;
  fov: number;
  yaw?: number;
  pitch?: number;
}

/** A named camera move: free-text intent ("establish", "follow", ...) and
 *  the keys that shape it. The FIRST key must anchor at t=0 and the keys
 *  must strictly ascend — validateCameraMove enforces both. */
export interface CameraMove {
  intent: string;
  keys: CameraKey[];
}

const FOV_MIN = 20;
const FOV_MAX = 100;

/** Validate once, refuse loudly: every failure names its reason (the bad
 *  key, the bad field, the bad value — never a bare "invalid"). A move
 *  that passes here is guaranteed finite, anchored at t=0, and strictly
 *  ascending. This is the SEAM's contract: cameraAt/projectPoint trust a
 *  validated move (their documented precondition) and do not re-validate. */
export function validateCameraMove(move: CameraMove): void {
  if (!move.keys || move.keys.length === 0) {
    throw new Error("camera move refused: the key list is empty — a move needs at least one key");
  }
  if (move.keys[0].t !== 0) {
    throw new Error(
      `camera move refused: keys must anchor at t=0 (the first key sits at t=${String(move.keys[0].t)})`,
    );
  }
  let prevT = -Infinity;
  for (let i = 0; i < move.keys.length; i++) {
    const k = move.keys[i];
    for (const field of ["t", "x", "y", "z", "fov"] as const) {
      if (!Number.isFinite(k[field])) {
        throw new Error(
          `camera move refused: key ${i} carries a non-finite ${field} (${String(k[field])})`,
        );
      }
    }
    if (k.yaw !== undefined && !Number.isFinite(k.yaw)) {
      throw new Error(`camera move refused: key ${i} carries a non-finite yaw (${String(k.yaw)})`);
    }
    if (k.pitch !== undefined && !Number.isFinite(k.pitch)) {
      throw new Error(`camera move refused: key ${i} carries a non-finite pitch (${String(k.pitch)})`);
    }
    if (k.fov < FOV_MIN || k.fov > FOV_MAX) {
      throw new Error(
        `camera move refused: key ${i} fov ${String(k.fov)} is outside ${FOV_MIN}..${FOV_MAX} degrees`,
      );
    }
    if (k.t <= prevT) {
      throw new Error(
        `camera move refused: keys must strictly ascend — key ${i} (t=${String(k.t)}) does not follow key ${i - 1} (t=${String(prevT)})`,
      );
    }
    prevT = k.t;
  }
}

/** The boundary-key copy: a held pose carries the key's own values with
 *  the optional yaw/pitch defaulted to 0 (their documented default). */
function heldKey(k: CameraKey): CameraKey {
  return { t: k.t, x: k.x, y: k.y, z: k.z, fov: k.fov, yaw: k.yaw ?? 0, pitch: k.pitch ?? 0 };
}

/** Sample the move at time `t`. PRECONDITION: `move` has already passed
 *  validateCameraMove — this function does NOT re-validate the move (the
 *  planner validates once; sampling stays hot). It does refuse a
 *  non-finite `t` (never launder NaN into a pose).
 *
 *  Hold semantics: t before the first key's t → the first key's pose; t
 *  after the last key's t → the last key's pose. Between two neighboring
 *  keys a→b the progress p = evalEase("ease-in-out", (t - ta) / (tb - ta))
 *  eases EVERY numeric field: x, y, z, fov — and yaw/pitch when BOTH keys
 *  define them (when either key omits them, the field defaults to 0 per
 *  the CameraKey contract). Spans are left-closed, so an exact interior
 *  key time evaluates to that key's own pose (p = 0 on the span it
 *  starts). The returned key's `t` is the query clamped into the key
 *  span; every value is plain arithmetic — deterministic, byte-identical
 *  for the same inputs (S64). */
export function cameraAt(move: CameraMove, t: number): CameraKey {
  if (!Number.isFinite(t)) {
    throw new Error(`camera move refused: the sample time t must be finite, got ${String(t)}`);
  }
  const keys = move.keys;
  const first = keys[0];
  const last = keys[keys.length - 1];
  if (t <= first.t) return heldKey(first);
  if (t >= last.t) return heldKey(last);
  // The span [a, b] with a.t <= t (left-closed, right-open).
  let i = 0;
  while (i + 2 < keys.length && keys[i + 1].t <= t) i++;
  const a = keys[i];
  const b = keys[i + 1];
  const p = evalEase("ease-in-out", (t - a.t) / (b.t - a.t));
  const yaw = a.yaw !== undefined && b.yaw !== undefined ? a.yaw + (b.yaw - a.yaw) * p : 0;
  const pitch = a.pitch !== undefined && b.pitch !== undefined ? a.pitch + (b.pitch - a.pitch) * p : 0;
  return {
    t,
    x: a.x + (b.x - a.x) * p,
    y: a.y + (b.y - a.y) * p,
    z: a.z + (b.z - a.z) * p,
    fov: a.fov + (b.fov - a.fov) * p,
    yaw,
    pitch,
  };
}

/** Pinhole projection of a world point at camera time `t`.
 *  PRECONDITION: `move` already validated (cameraAt trusts it); `point`
 *  must be finite (refused otherwise — garbage is never laundered).
 *
 *  The math (simple, documented, deterministic): take cam = cameraAt(move,
 *  t); translate the point into camera-local coordinates (point − cam);
 *  then rotate the WORLD into camera space — the billboard inverse of the
 *  camera's own orientation, applied as inverse yaw (around Y) first,
 *  then inverse pitch (around X). The camera looks down −z in camera
 *  space, so the point's depth along the forward axis is d = −(camera z).
 *  d <= 0 → the point sits at or behind the camera plane → null (the
 *  null-at-plane law: no division by a non-positive depth). Else
 *  scale = fov / d and the screen position is (camera x, y) · scale.
 *  fov acts as the focal scale in these units — relative sizes and
 *  screen positions are what consumers need, not physical millimeters. */
export function projectPoint(
  move: CameraMove,
  t: number,
  point: { x: number; y: number; z: number },
): { x: number; y: number; scale: number } | null {
  for (const field of ["x", "y", "z"] as const) {
    if (!Number.isFinite(point[field])) {
      throw new Error(
        `camera move refused: the projected point's ${field} is not finite (${String(point[field])})`,
      );
    }
  }
  const cam = cameraAt(move, t);
  const vx = point.x - cam.x;
  const vy = point.y - cam.y;
  const vz = point.z - cam.z;
  // Inverse yaw (degrees → radians): the world turns back around Y.
  // R_y(-ψ): x' = cosψ·x − sinψ·z, z' = sinψ·x + cosψ·z.
  const yawRad = ((cam.yaw ?? 0) * Math.PI) / 180;
  const cy = Math.cos(yawRad);
  const sy = Math.sin(yawRad);
  const x1 = cy * vx - sy * vz;
  const y1 = vy;
  const z1 = sy * vx + cy * vz;
  // Inverse pitch: the world turns back around X.
  // R_x(-θ): y' = cosθ·y + sinθ·z, z' = −sinθ·y + cosθ·z.
  const pitchRad = ((cam.pitch ?? 0) * Math.PI) / 180;
  const cp = Math.cos(pitchRad);
  const sp = Math.sin(pitchRad);
  const x2 = x1;
  const y2 = cp * y1 + sp * z1;
  const z2 = -sp * y1 + cp * z1;
  const depth = -z2; // the camera looks down −z: depth is the distance ahead
  if (depth <= 0) return null;
  const scale = cam.fov / depth;
  return { x: x2 * scale, y: y2 * scale, scale };
}
