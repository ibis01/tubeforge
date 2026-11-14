// K1 slice 1 — the 2D character-engine substrate: the CharacterRigDoc
// contract (S120 §6). The K1 honesty law applies from this file onward: the
// rig animates REAL decomposed part art (identity-locked portraits
// decomposed by the characters.ts flow), so honest motion is possible — the
// S93 still-portrait breath rig stays for characters that do not opt into a
// rigDoc (additive-parse law: no rigDoc → the S93 path, byte-identical).
//
// Laws: pure module — no fs, no clock, no randomness (S64); every refusal
// names its reason; channels are OFFSETS FROM REST so pose sheets compose
// ("arm raised" is a rotateDeg offset from the rest placement, not a
// re-authored absolute placement); every dimension has a named wall.

export const RIG_DOC_VERSION = 1;

/** The mouth art set — FIVE shapes is the honest beat-sync vocabulary
 *  (S120 §6: "5 shapes is enough for honest narration-sync at explainer
 *  quality"). The measured schedule in rig-frame.ts only ever emits
 *  closed/open from word spans; wide/oh/smile are AUTHORED pose slots
 *  (pose sheets), never invented from text. */
export const MOUTH_SHAPES = ["closed", "open", "wide", "oh", "smile"] as const;
export type MouthShape = (typeof MOUTH_SHAPES)[number];

/** The arm poses the pose-sheet flow targets — the 3-way per side. */
export const ARM_POSES = ["rest", "raise", "point"] as const;
export type ArmPose = (typeof ARM_POSES)[number];

/** Standard slot ids so pose sheets, the mouth schedule and the renderer
 *  agree on the art's part ids (one vocabulary, three consumers). */
export function mouthPartId(shape: MouthShape): string {
  return `mouth-${shape}`;
}

export function armPartId(side: "l" | "r"): string {
  return `arm-${side}`;
}

export function browPartId(side: "l" | "r"): string {
  return `brow-${side}`;
}

/** Parse a mouth slot id back to its shape — null when the id is not a
 *  mouth slot (the renderer's visibility law consumes this). */
export function mouthShapeOfPartId(id: string): MouthShape | null {
  if (!id.startsWith("mouth-")) return null;
  const shape = id.slice("mouth-".length);
  return (MOUTH_SHAPES as readonly string[]).includes(shape) ? (shape as MouthShape) : null;
}

export interface RigPivot {
  x: number;
  y: number;
}

/** A part's rest placement in the character canvas: (x, y) is the part's
 *  ANCHOR position (the art hangs from the anchor), rotateDeg the rest
 *  rotation, scale the rest scale (multiplicative, > 0). */
export interface RigRest {
  x: number;
  y: number;
  rotateDeg?: number;
  scale?: number;
}

/** One layered part of the puppet. svgRef names the asset carrying the
 *  part's art (the characters.ts decomposition flow produces the layers);
 *  z orders the layers (higher draws on top); parent chains parts into a
 *  hierarchy — a child rides its parent's transform, one hop per part,
 *  cycles refused at validation. */
export interface RigPart {
  id: string;
  svgRef: string;
  z: number;
  pivot: RigPivot;
  parent?: string;
  rest: RigRest;
}

/** Per-part channel OFFSETS from rest: rotateDeg/x/y additive, scale a
 *  multiplicative factor (> 0). An absent part (or channel) means "stay at
 *  rest" — a pose only says what it moves. */
export interface RigJoint {
  rotateDeg?: number;
  x?: number;
  y?: number;
  scale?: number;
}

export interface RigPose {
  id: string;
  name: string;
  joints: Record<string, RigJoint>;
}

export interface CharacterRigDoc {
  version: number;
  parts: RigPart[];
  /** Poses may be empty — a rig can exist before its first authored pose;
   *  poseAt then holds REST at every t (the additive baseline). */
  poses: RigPose[];
}

// The named walls (every unbounded dimension has one): a puppet rig is a
// handful of parts and poses; 64 bounds pathological docs cheaply.
export const MAX_RIG_PARTS = 64;
export const MAX_RIG_POSES = 64;

/**
 * validateRigDoc — the ONE law a rig doc must satisfy. Every refusal names
 * its reason (the house law): the editor shows it, the API serializes it,
 * the planner never has to guess. Throws on the first violation.
 */
export function validateRigDoc(doc: CharacterRigDoc): void {
  if (!doc || typeof doc !== "object") {
    throw new Error("the rig doc must be an object");
  }
  if (doc.version !== RIG_DOC_VERSION) {
    throw new Error(`the rig doc version must be ${RIG_DOC_VERSION}, got ${String(doc.version)}`);
  }
  if (!Array.isArray(doc.parts) || doc.parts.length === 0) {
    throw new Error("the rig needs at least one part");
  }
  if (doc.parts.length > MAX_RIG_PARTS) {
    throw new Error(`the rig carries ${doc.parts.length} parts — the wall is ${MAX_RIG_PARTS} (a puppet is a handful)`);
  }
  const ids = new Set<string>();
  for (const part of doc.parts) {
    if (!part || typeof part !== "object") {
      throw new Error("every rig part must be an object");
    }
    if (typeof part.id !== "string" || part.id.trim() === "") {
      throw new Error("every rig part needs a non-empty id");
    }
    if (ids.has(part.id)) {
      throw new Error(`part id "${part.id}" is used twice — part ids are the rig's primary keys`);
    }
    ids.add(part.id);
    if (typeof part.svgRef !== "string" || part.svgRef.trim() === "") {
      throw new Error(`part "${part.id}" needs an svgRef — the asset that carries its art`);
    }
    if (!Number.isFinite(part.z)) {
      throw new Error(`part "${part.id}" needs a finite z (layer order)`);
    }
    if (
      !part.pivot ||
      !Number.isFinite(part.pivot.x) ||
      !Number.isFinite(part.pivot.y)
    ) {
      throw new Error(`part "${part.id}" needs a finite pivot {x, y}`);
    }
    if (!part.rest || !Number.isFinite(part.rest.x) || !Number.isFinite(part.rest.y)) {
      throw new Error(`part "${part.id}" needs a finite rest {x, y}`);
    }
    if (part.rest.rotateDeg !== undefined && !Number.isFinite(part.rest.rotateDeg)) {
      throw new Error(`part "${part.id}" carries a non-finite rest.rotateDeg`);
    }
    if (part.rest.scale !== undefined) {
      if (!Number.isFinite(part.rest.scale) || part.rest.scale <= 0) {
        throw new Error(`part "${part.id}" needs a rest.scale > 0 (got ${String(part.rest.scale)})`);
      }
    }
  }
  // Referential integrity: a parent must exist, never be self, never loop.
  for (const part of doc.parts) {
    if (part.parent === undefined) continue;
    if (part.parent === part.id) {
      throw new Error(`part "${part.id}" cannot be its own parent`);
    }
    if (!ids.has(part.parent)) {
      throw new Error(`part "${part.id}" names parent "${part.parent}" which is not in the rig`);
    }
  }
  for (const part of doc.parts) {
    const seen = new Set<string>([part.id]);
    let cur = part.parent;
    while (cur !== undefined) {
      if (seen.has(cur)) {
        throw new Error(`the rig's parent chain loops at "${cur}" (walking up from "${part.id}")`);
      }
      seen.add(cur);
      cur = doc.parts.find((p) => p.id === cur)?.parent;
    }
  }
  // Poses: ids unique, joints reference real parts, channels finite.
  if (!Array.isArray(doc.poses)) {
    throw new Error("the rig doc's poses must be an array (empty is allowed)");
  }
  if (doc.poses.length > MAX_RIG_POSES) {
    throw new Error(`the rig carries ${doc.poses.length} poses — the wall is ${MAX_RIG_POSES}`);
  }
  const poseIds = new Set<string>();
  for (const pose of doc.poses) {
    if (!pose || typeof pose !== "object") {
      throw new Error("every rig pose must be an object");
    }
    if (typeof pose.id !== "string" || pose.id.trim() === "") {
      throw new Error("every rig pose needs a non-empty id");
    }
    if (poseIds.has(pose.id)) {
      throw new Error(`pose id "${pose.id}" is used twice`);
    }
    poseIds.add(pose.id);
    if (typeof pose.name !== "string" || pose.name.trim() === "") {
      throw new Error(`pose "${pose.id}" needs a non-empty display name`);
    }
    if (!pose.joints || typeof pose.joints !== "object") {
      throw new Error(`pose "${pose.id}" needs a joints record (empty is allowed)`);
    }
    for (const [partId, joint] of Object.entries(pose.joints)) {
      if (!ids.has(partId)) {
        throw new Error(`pose "${pose.id}" moves unknown part "${partId}" — joints reference rig parts by id`);
      }
      if (!joint || typeof joint !== "object") {
        throw new Error(`pose "${pose.id}" part "${partId}": the joint must be an object`);
      }
      for (const [channel, value] of Object.entries(joint)) {
        if (value === undefined) continue;
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw new Error(`pose "${pose.id}" part "${partId}" channel "${channel}" must be a finite number`);
        }
        if (channel === "scale" && value <= 0) {
          throw new Error(`pose "${pose.id}" part "${partId}" scale must be > 0 (got ${String(value)})`);
        }
      }
    }
  }
}
