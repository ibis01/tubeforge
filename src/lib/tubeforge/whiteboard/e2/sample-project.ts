// sample-project.ts — minimal valid project for the E2 prototype + tests.
//
// This is NOT a substitute for the E5 storyboard planner (which will use an
// LLM with a deterministic fallback, mirroring slides.ts planSlides). It
// exists so the E2 acceptance gate ("render a 60s 1080p MP4") can run end-to-
// end without depending on E5, and so the test suite has a stable fixture.
//
// The project: "Three Pillars of Productivity" — 5 scenes, 12s each = 60s,
// one or two assets per scene, deterministic draw + camera events.

import type {
  AnimationEvent,
  CameraEvent,
  PlacedAsset,
  WhiteboardProject,
  WhiteboardScene,
} from "./schemas";

const CANVAS_W = 1920;
const CANVAS_H = 1080;

function placement(
  assetId: string,
  x: number,
  y: number,
  scale: number,
  layer = 0,
): PlacedAsset {
  return { assetId, x, y, scale, layer };
}

/** Draw all paths of an asset sequentially inside the scene's local timeline. */
function drawAllPaths(
  assetId: string,
  pathIds: string[],
  startMs: number,
  perPathMs: number,
): AnimationEvent[] {
  const events: AnimationEvent[] = [];
  let t = startMs;
  for (const pid of pathIds) {
    events.push({
      type: "draw",
      assetId,
      pathId: pid,
      startMs: t,
      durationMs: perPathMs,
      easing: "easeInOut",
    });
    t += perPathMs;
  }
  return events;
}

function cameraZoomIn(startMs: number, durationMs: number, toScale = 1.2): CameraEvent {
  return {
    type: "zoom",
    startMs,
    durationMs,
    from: { x: CANVAS_W / 2, y: CANVAS_H / 2, scale: 1 },
    to: { x: CANVAS_W / 2, y: CANVAS_H / 2, scale: toScale },
    easing: "easeInOut",
  };
}

function cameraPan(
  startMs: number,
  durationMs: number,
  from: { x: number; y: number },
  to: { x: number; y: number },
): CameraEvent {
  return {
    type: "pan",
    startMs,
    durationMs,
    from: { x: from.x, y: from.y, scale: 1 },
    to: { x: to.x, y: to.y, scale: 1 },
    easing: "easeInOut",
  };
}

// Asset path IDs (must match the in-repo library files)
const LIGHTBULB_PATHS = ["bulb-glass", "bulb-filament", "bulb-screw"];
const ROCKET_PATHS = ["rocket-body", "rocket-window", "rocket-fin", "rocket-fin2", "rocket-flame"];
const CHART_PATHS = ["chart-axis", "chart-bar1", "chart-bar2", "chart-bar3", "chart-arrow"];
const CLOCK_PATHS = ["clock-outer", "clock-tick12", "clock-tick3", "clock-tick6", "clock-tick9", "clock-hour", "clock-minute"];
const GROWTH_PATHS = ["growth-axis", "growth-line", "growth-arrow"];

const SCENE_MS = 12_000; // 12s per scene × 5 scenes = 60s

export function buildSampleProject(): WhiteboardProject {
  const now = "2026-11-09T00:00:00.000Z";
  const scenes: WhiteboardScene[] = [];

  // Scene 1: Lightbulb (centered, slightly left) — "It starts with an idea"
  {
    const assetId = "lightbulb";
    const placed = placement(assetId, 760, 380, 2.4); // ~480px tall at 2.4x
    const events = drawAllPaths(assetId, LIGHTBULB_PATHS, 500, 1800);
    events.push({
      type: "color_reveal",
      assetId,
      pathId: "bulb-glass",
      startMs: 500 + LIGHTBULB_PATHS.length * 1800,
      durationMs: 1000,
      fill: "#FBBF24",
    });
    scenes.push({
      id: "scene-1-idea",
      order: 1,
      narration: "Every great video starts with an idea — a single spark worth pursuing.",
      startMs: 0,
      durationMs: SCENE_MS,
      assets: [placed],
      events,
      camera: [cameraZoomIn(0, SCENE_MS, 1.15)],
    });
  }

  // Scene 2: Rocket (right side) — "Then you launch"
  {
    const assetId = "rocket";
    const placed = placement(assetId, 1280, 280, 2.4);
    const events = drawAllPaths(assetId, ROCKET_PATHS, 500, 1400);
    scenes.push({
      id: "scene-2-launch",
      order: 2,
      narration: "You launch. The first cut, the first voice-over, the first frame.",
      startMs: SCENE_MS,
      durationMs: SCENE_MS,
      assets: [placed],
      events,
      camera: [cameraPan(0, SCENE_MS, { x: CANVAS_W / 2, y: CANVAS_H / 2 }, { x: 1400, y: CANVAS_H / 2 })],
    });
  }

  // Scene 3: Bar chart (left) — "Measure what matters"
  {
    const assetId = "bar-chart";
    const placed = placement(assetId, 560, 360, 2.6);
    const events = drawAllPaths(assetId, CHART_PATHS, 500, 1500);
    scenes.push({
      id: "scene-3-measure",
      order: 3,
      narration: "You measure. Watch time, retention, the slope of the curve.",
      startMs: SCENE_MS * 2,
      durationMs: SCENE_MS,
      assets: [placed],
      events,
      camera: [cameraZoomIn(0, SCENE_MS, 1.2)],
    });
  }

  // Scene 4: Clock (center) — "Time is the only non-renewable"
  {
    const assetId = "clock";
    const placed = placement(assetId, 760, 320, 2.6);
    const events = drawAllPaths(assetId, CLOCK_PATHS, 500, 1200);
    scenes.push({
      id: "scene-4-time",
      order: 4,
      narration: "And time — the only thing you cannot make more of — keeps moving.",
      startMs: SCENE_MS * 3,
      durationMs: SCENE_MS,
      assets: [placed],
      events,
      camera: [cameraZoomIn(0, SCENE_MS, 1.25)],
    });
  }

  // Scene 5: Arrow growth (center) — "Compound it"
  {
    const assetId = "arrow-growth";
    const placed = placement(assetId, 760, 360, 2.6);
    const events = drawAllPaths(assetId, GROWTH_PATHS, 500, 1800);
    scenes.push({
      id: "scene-5-compound",
      order: 5,
      narration: "Then you compound it. Video on video, frame on frame, until it's unmistakable.",
      startMs: SCENE_MS * 4,
      durationMs: SCENE_MS,
      assets: [placed],
      events,
      camera: [cameraZoomIn(0, SCENE_MS, 1.3)],
    });
  }

  return {
    id: "sample-whiteboard-project",
    schemaVersion: 1,
    title: "Three Pillars of Productivity",
    script: "Every great video starts with an idea — a single spark worth pursuing. You launch. You measure. Time is the only non-renewable. Then you compound it.",
    settings: {
      width: 1920,
      height: 1080,
      fps: 30,
      background: "#FFFFFF",
      drawingStyle: "ink",
      handStyle: "right",
    },
    scenes,
    audio: {},
    status: "ready",
    createdAt: now,
    updatedAt: now,
  };
}
