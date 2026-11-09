// index.ts — Whiteboard engine public surface (E2).
//
// The ONLY import path outside the engine. Re-exports the strict contracts
// (plan §6) and the implementation modules. Internal modules import each
// other relatively; consumers (the API routes, the queue handlers, tests,
// the prototype script) only touch this file.
//
// Boundary rule (enforced by review): no module inside whiteboard/ imports
// from ../render.ts, ../director.ts, ../director-plan.ts or any route.

// Schemas + helpers (explicit — `export *` is flaky under tsx ESM)
export {
  SCHEMA_VERSION,
  LIMITS,
  easingSchema,
  handStyleSchema,
  drawingStyleSchema,
  aspectSchema,
  fpsSchema,
  projectSettingsSchema,
  pathSpecSchema,
  whiteboardAssetSchema,
  placedAssetSchema,
  animationEventSchema,
  cameraEventSchema,
  whiteboardSceneSchema,
  whiteboardProjectSchema,
  migrateProject,
  validateReferences,
  ReferentialIntegrityError,
  canonicalSerialize,
} from "./schemas";
export type {
  Easing,
  HandStyle,
  DrawingStyle,
  ProjectSettings,
  PathSpec,
  WhiteboardAsset,
  PlacedAsset,
  AnimationEvent,
  CameraEvent,
  WhiteboardScene,
  WhiteboardProject,
} from "./schemas";
export { evaluateFrame, projectDurationMs } from "./animator";
export type {
  FrameState,
  FrameLayer,
  FramePath,
  FrameHand,
  FrameCamera,
} from "./animator";
export { composeFrameSvg } from "./composer";
export { rasterizeSvg } from "./rasterizer";
export { encodeFramesToMp4, encodeFrameStreamToMp4 } from "./encoder";
export type { EncodeOptions, EncodeResult } from "./encoder";
export { renderProject, renderProjectToBuffer } from "./rendering/renderer";
export type { RenderOptions, RenderResult } from "./rendering/renderer";

export { validateSvg, isSafeSvg, assertSvgRejected } from "./svg-validator";
export type { ValidatedSvg } from "./svg-validator";

export { parsePath, samplePath, arcLength, pointAt, tangentAt, tangentAngleDeg, applyEasing, clamp } from "./geometry";
export type { PathCommand, PathPoint, PathSample, SampledPath } from "./geometry";

export { extractAsset, extractPathMap } from "./path-extractor";
export type { ExtractedPath, ExtractedAsset } from "./path-extractor";

export { assetRegistry } from "./asset-registry";

// Convenience for the prototype script + tests: build a minimal valid
// project from a few arguments, so callers don't have to construct every
// field by hand. (Production API routes construct projects from user input
// via the schemas' zod parse, not from this helper.)
export { buildSampleProject } from "./sample-project";
