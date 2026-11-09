// schemas.ts — Whiteboard engine data contracts (E1 §3, E2 implementation).
//
// All boundaries validate with zod at runtime (plan §4). TypeScript types are
// derived from the schemas via z.infer — never hand-written beside them.
// SCHEMA_VERSION = 1; migrateProject() is the forward-migration stub.

import { z } from "zod";

export const SCHEMA_VERSION = 1 as const;

export const easingSchema = z.enum(["linear", "easeInOut"]);
export const handStyleSchema = z.enum(["right", "left", "none"]);
export const drawingStyleSchema = z.enum(["ink", "marker"]);
export const aspectSchema = z.enum(["16:9", "9:16", "1:1"]);
export const fpsSchema = z.union([z.literal(24), z.literal(30)]);

export const projectSettingsSchema = z.object({
  width: z.number().int().min(320).max(3840),
  height: z.number().int().min(240).max(3840),
  fps: fpsSchema,
  background: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  drawingStyle: drawingStyleSchema,
  handStyle: handStyleSchema,
});

export const pathSpecSchema = z.object({
  id: z.string().min(1),
  order: z.number().int().min(0),
  durationMs: z.number().int().min(1).max(60_000),
});

export const whiteboardAssetSchema = z.object({
  id: z.string().min(1),
  type: z.literal("svg"),
  name: z.string().min(1),
  category: z.string().min(1),
  tags: z.array(z.string().min(1)),
  paths: z.array(pathSpecSchema),
});

export const placedAssetSchema = z.object({
  assetId: z.string().min(1),
  x: z.number().int().min(-2000).max(4000),
  y: z.number().int().min(-2000).max(4000),
  scale: z.number().min(0.1).max(10),
  layer: z.number().int().min(0).max(20),
});

export const animationEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("draw"),
    assetId: z.string().min(1),
    pathId: z.string().min(1),
    startMs: z.number().int().min(0),
    durationMs: z.number().int().min(1).max(60_000),
    easing: easingSchema.default("easeInOut"),
  }),
  z.object({
    type: z.literal("fade"),
    assetId: z.string().min(1),
    startMs: z.number().int().min(0),
    durationMs: z.number().int().min(1).max(60_000),
  }),
  z.object({
    type: z.literal("move"),
    assetId: z.string().min(1),
    startMs: z.number().int().min(0),
    durationMs: z.number().int().min(1).max(60_000),
    from: z.object({ x: z.number(), y: z.number() }),
    to: z.object({ x: z.number(), y: z.number() }),
  }),
  z.object({
    type: z.literal("color_reveal"),
    assetId: z.string().min(1),
    pathId: z.string().min(1),
    startMs: z.number().int().min(0),
    durationMs: z.number().int().min(1).max(60_000),
    fill: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  }),
]);

export const cameraEventSchema = z.object({
  type: z.enum(["pan", "zoom"]),
  startMs: z.number().int().min(0),
  durationMs: z.number().int().min(1).max(60_000),
  from: z.object({ x: z.number(), y: z.number(), scale: z.number().min(0.1).max(8) }),
  to: z.object({ x: z.number(), y: z.number(), scale: z.number().min(0.1).max(8) }),
  easing: easingSchema.default("easeInOut"),
});

export const whiteboardSceneSchema = z.object({
  id: z.string().min(1),
  order: z.number().int().min(1),
  narration: z.string(),
  startMs: z.number().int().min(0),
  durationMs: z.number().int().min(1).max(300_000),
  assets: z.array(placedAssetSchema).max(40),
  events: z.array(animationEventSchema).max(4000),
  camera: z.array(cameraEventSchema).max(200),
});

export const whiteboardProjectSchema = z.object({
  id: z.string().min(1),
  schemaVersion: z.literal(SCHEMA_VERSION),
  title: z.string().min(1).max(200),
  script: z.string().max(20_000),
  settings: projectSettingsSchema,
  scenes: z.array(whiteboardSceneSchema).min(1).max(60),
  audio: z
    .object({
      narrationAssetId: z.string().optional(),
      musicAssetId: z.string().optional(),
    })
    .default({}),
  status: z.enum([
    "draft",
    "planning",
    "ready",
    "rendering",
    "completed",
    "failed",
  ]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

// Derived types — the canonical TypeScript surface; consumers use these.
export type Easing = z.infer<typeof easingSchema>;
export type HandStyle = z.infer<typeof handStyleSchema>;
export type DrawingStyle = z.infer<typeof drawingStyleSchema>;
export type ProjectSettings = z.infer<typeof projectSettingsSchema>;
export type PathSpec = z.infer<typeof pathSpecSchema>;
export type WhiteboardAsset = z.infer<typeof whiteboardAssetSchema>;
export type PlacedAsset = z.infer<typeof placedAssetSchema>;
export type AnimationEvent = z.infer<typeof animationEventSchema>;
export type CameraEvent = z.infer<typeof cameraEventSchema>;
export type WhiteboardScene = z.infer<typeof whiteboardSceneSchema>;
export type WhiteboardProject = z.infer<typeof whiteboardProjectSchema>;

// Hard limits (plan §4): enforced at validation boundaries in addition to zod.
export const LIMITS = {
  MAX_ASSET_BYTES: 512 * 1024,
  MAX_PATHS_PER_ASSET: 600,
  MAX_PROJECT_BYTES: 8 * 1024 * 1024,
} as const;

/**
 * Forward-migration stub. v1 is the first version, so this is a passthrough.
 * Future versions branch on `parsed.schemaVersion` and upgrade in place.
 */
export function migrateProject(parsed: unknown): WhiteboardProject {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("migrateProject: input is not an object");
  }
  const obj = parsed as { schemaVersion?: number };
  if (obj.schemaVersion === undefined) {
    throw new Error("migrateProject: missing schemaVersion");
  }
  if (obj.schemaVersion === SCHEMA_VERSION) {
    return whiteboardProjectSchema.parse(parsed);
  }
  if (obj.schemaVersion > SCHEMA_VERSION) {
    throw new Error(
      `migrateProject: project schemaVersion ${obj.schemaVersion} is newer than supported ${SCHEMA_VERSION}`,
    );
  }
  // (Future) v0 → v1 upgrade goes here. None exists yet.
  throw new Error(
    `migrateProject: no migration path from schemaVersion ${obj.schemaVersion} to ${SCHEMA_VERSION}`,
  );
}

/**
 * Referential integrity check (plan §4). Called after parse, before render.
 * Throws a typed error listing every dangling reference it finds.
 */
export class ReferentialIntegrityError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Referential integrity errors:\n  - ${issues.join("\n  - ")}`);
    this.name = "ReferentialIntegrityError";
    this.issues = issues;
  }
}

export function validateReferences(
  project: WhiteboardProject,
  registry: { has(id: string): boolean; asset(id: string): WhiteboardAsset | undefined },
): void {
  const issues: string[] = [];
  for (const scene of project.scenes) {
    for (const placed of scene.assets) {
      if (!registry.has(placed.assetId)) {
        issues.push(`scene ${scene.id}: placed asset "${placed.assetId}" is not in the registry`);
        continue;
      }
      const asset = registry.asset(placed.assetId);
      if (!asset) continue;
      const validPathIds = new Set(asset.paths.map((p) => p.id));
      for (const ev of scene.events) {
        if (ev.assetId !== placed.assetId) {
          issues.push(
            `scene ${scene.id}: event of type "${ev.type}" references asset "${ev.assetId}" not placed in this scene`,
          );
        }
        if (ev.type === "draw" || ev.type === "color_reveal") {
          if (!validPathIds.has(ev.pathId)) {
            issues.push(
              `scene ${scene.id}: ${ev.type} event references path "${ev.pathId}" not present on asset "${ev.assetId}"`,
            );
          }
        }
      }
    }
    if (scene.startMs < 0) {
      issues.push(`scene ${scene.id}: startMs ${scene.startMs} is negative`);
    }
  }
  for (let i = 1; i < project.scenes.length; i++) {
    const prev = project.scenes[i - 1];
    const cur = project.scenes[i];
    if (cur.startMs !== prev.startMs + prev.durationMs) {
      issues.push(
        `scene ${cur.id}: startMs ${cur.startMs} is not contiguous with previous scene end ${prev.startMs + prev.durationMs}`,
      );
    }
  }
  if (issues.length > 0) {
    throw new ReferentialIntegrityError(issues);
  }
}

/**
 * Canonical serializer (design §3). Stable object-key ordering via a sorted
 * replacer so persisted projects hash deterministically regardless of the
 * insertion order in which they were built.
 */
export function canonicalSerialize(project: WhiteboardProject): string {
  const seen = new WeakSet();
  const replacer = (_key: string, value: unknown): unknown => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (seen.has(value)) return undefined; // cycle guard
      seen.add(value);
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value as Record<string, unknown>).sort()) {
        sorted[k] = (value as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return value;
  };
  return JSON.stringify(project, replacer);
}
