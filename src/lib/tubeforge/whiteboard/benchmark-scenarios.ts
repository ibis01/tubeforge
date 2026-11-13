// W1 — the perceptual baseline: the FIXED whiteboard benchmark definition.
//
// docs/design/whiteboard-videoscribe-reconciliation.md §9 W1: five fixed
// scene types (title, process diagram, comparison, handwritten key phrase,
// conclusion), the same narration + assets every run, rendered at all
// three house aspects — so every W2+ iteration is measured against the
// same artifacts instead of vibes. PURE module: deterministic layout
// arithmetic, no fs, no clock, no randomness — two builds of the same
// aspect are byte-identical (the unit battery pins it), which is what
// makes the recorded frame hashes comparable across weeks and stages.
//
// The scenes ride the BUILT-IN library only (the S64 benchmark set + the
// S67 concept port): the baseline scores the library that ships today.
// W3's professional asset pack re-runs THIS harness against its own
// additions — the definition stays frozen, the results move.
//
// Layout model. Each scene is authored TWICE, in two fixed design spaces:
//   landscape  1600×900 — used for 16:9 and 1:1
//   portrait   900×1600 — used for 9:16
// A pure fit transform maps design coordinates onto the render canvas
// (fit-scale = min(W/dw, H/dh), centered), and an item's `designScale`
// (display px per asset viewBox px, in design space) rides the same
// fit-scale into the engine's Placement.scale. Assets + narration +
// durations are IDENTICAL across aspects — only the layout adapts, which
// is exactly the per-aspect composition surface the rubric scores.
//
// Audio honesty (the s64 precedent, restated): the baseline runs SILENT —
// explicit durationMs per scene keeps the clock deterministic without a
// TTS dependency, and the rubric's audio dimension is scored "not in this
// lane" rather than faked. Narration text rides the doc for the rubric's
// alignment/comprehension reads.

import type { WhiteboardProject, WhiteboardScene } from "./storyboard";

// ---------------------------------------------------------------------------
// The three house aspects (E10 rendered all three; W1 baselines all three).
// ---------------------------------------------------------------------------

export const W1_ASPECTS = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
} as const;

export type W1AspectId = keyof typeof W1_ASPECTS;

export const W1_ASPECT_IDS: W1AspectId[] = ["16:9", "9:16", "1:1"];

export const W1_FPS = 24;

// ---------------------------------------------------------------------------
// The five fixed scene types — the reconciliation's W1 list, in render
// order. Ids are frozen: the baseline JSON, the rubric scores, and every
// future W-stage diff cite them.
// ---------------------------------------------------------------------------

export const W1_SCENE_IDS = [
  "w1-title",
  "w1-process",
  "w1-comparison",
  "w1-phrase",
  "w1-conclusion",
] as const;

export type W1SceneId = (typeof W1_SCENE_IDS)[number];

/** Scene id → human scene type (the rubric's row labels). */
export const W1_SCENE_KINDS: Record<W1SceneId, string> = {
  "w1-title": "title",
  "w1-process": "process diagram",
  "w1-comparison": "comparison",
  "w1-phrase": "handwritten key phrase",
  "w1-conclusion": "conclusion",
};

// ---------------------------------------------------------------------------
// The rubric dimensions (reconciliation §7 — the plan's perceptual list).
// The rubric doc (docs/audits/w1-blind-rubric.md) is the prose; this is the
// frozen id list the unit battery pins the doc against.
// ---------------------------------------------------------------------------

export const W1_RUBRIC_DIMENSIONS = [
  "stroke-naturalness",
  "semantic-order",
  "narration-alignment",
  "camera-readability",
  "hand-realism",
  "continuity",
  "text-readability",
  "audio",
  "comprehension",
] as const;

export type W1RubricDimension = (typeof W1_RUBRIC_DIMENSIONS)[number];

// ---------------------------------------------------------------------------
// Design-space authoring.
// ---------------------------------------------------------------------------

/** One authored item in design space: `dx/dy` is the asset's top-left in
 *  design px; `designScale` is display px per asset viewBox px (design
 *  space). Rotation and draw order ride through unchanged. */
interface W1DesignItem {
  assetId: string;
  dx: number;
  dy: number;
  designScale: number;
  rotateDeg?: number;
  order?: number;
}

interface W1DesignScene {
  id: W1SceneId;
  narration: string;
  /** EXPLICIT duration — the determinism anchor. No VO dependency: the
   *  clock is the same on every machine, every run (sceneDurationMs
   *  priority: explicit > VO > estimate). */
  durationMs: number;
  landscape: W1DesignItem[];
  portrait: W1DesignItem[];
}

const DESIGN_LANDSCAPE = { w: 1600, h: 900 };
const DESIGN_PORTRAIT = { w: 900, h: 1600 };

// The five scenes, hand-authored on the library's own benchmark topic
// ("How Your Heart Works" — the S64 set), one per scene TYPE. Layouts fit
// both design spaces with margins; the unit battery pins the mapped rects
// inside every canvas.
const DESIGN_SCENES: W1DesignScene[] = [
  {
    id: "w1-title",
    narration:
      "Your heart beats about one hundred thousand times every single day. Today, we draw how it keeps you alive.",
    durationMs: 7500,
    landscape: [
      { assetId: "title-hero", dx: 360, dy: 200, designScale: 1.1 },
      { assetId: "heart-main", dx: 1050, dy: 460, designScale: 1.5, order: 2 },
    ],
    portrait: [
      { assetId: "title-hero", dx: 50, dy: 520, designScale: 1.0 },
      { assetId: "heart-main", dx: 340, dy: 820, designScale: 1.3, order: 2 },
    ],
  },
  {
    id: "w1-process",
    narration:
      "Here is the loop. The right side pumps blood to the lungs to pick up oxygen. The left side then fires it out to the whole body.",
    durationMs: 8500,
    landscape: [
      { assetId: "heart-main", dx: 180, dy: 320, designScale: 1.4 },
      { assetId: "lungs", dx: 1140, dy: 320, designScale: 1.4, order: 2 },
      { assetId: "arrow-curve", dx: 640, dy: 260, designScale: 1.1, rotateDeg: -15, order: 3 },
      { assetId: "arrow-return", dx: 640, dy: 500, designScale: 1.1, rotateDeg: 168, order: 4 },
    ],
    portrait: [
      { assetId: "heart-main", dx: 70, dy: 700, designScale: 1.2 },
      { assetId: "lungs", dx: 590, dy: 700, designScale: 1.2, order: 2 },
      { assetId: "arrow-curve", dx: 370, dy: 610, designScale: 0.9, rotateDeg: -18, order: 3 },
      { assetId: "arrow-return", dx: 370, dy: 840, designScale: 0.9, rotateDeg: 168, order: 4 },
    ],
  },
  {
    id: "w1-comparison",
    narration:
      "An athlete's resting heart beats about forty times a minute. The average heart sits near seventy. Training makes every beat count.",
    durationMs: 8000,
    landscape: [
      { assetId: "bar-chart", dx: 420, dy: 280, designScale: 1.5 },
      { assetId: "heart-main", dx: 980, dy: 300, designScale: 1.3, order: 2 },
    ],
    portrait: [
      { assetId: "bar-chart", dx: 80, dy: 760, designScale: 1.25 },
      { assetId: "heart-main", dx: 570, dy: 780, designScale: 1.1, order: 2 },
    ],
  },
  {
    id: "w1-phrase",
    narration:
      "If you remember one number, make it this one: sixty to one hundred beats every minute.",
    durationMs: 7000,
    landscape: [{ assetId: "close-card", dx: 400, dy: 340, designScale: 1.2 }],
    portrait: [{ assetId: "close-card", dx: 50, dy: 720, designScale: 1.0 }],
  },
  {
    id: "w1-conclusion",
    narration:
      "Now you can draw the heart yourself. Sketch it, label it, and share the story.",
    durationMs: 7000,
    landscape: [
      { assetId: "check-badge", dx: 480, dy: 320, designScale: 1.4 },
      { assetId: "rocket", dx: 920, dy: 320, designScale: 1.4, order: 2 },
    ],
    portrait: [
      { assetId: "check-badge", dx: 130, dy: 800, designScale: 1.25 },
      { assetId: "rocket", dx: 520, dy: 800, designScale: 1.25, order: 2 },
    ],
  },
];

// ---------------------------------------------------------------------------
// Pure layout arithmetic.
// ---------------------------------------------------------------------------

const round1 = (n: number): number => Math.round(n * 10) / 10;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

interface W1Fit {
  scale: number;
  ox: number;
  oy: number;
}

function fitFor(aspect: W1AspectId): W1Fit {
  const { width, height } = W1_ASPECTS[aspect];
  const design = aspect === "9:16" ? DESIGN_PORTRAIT : DESIGN_LANDSCAPE;
  const scale = Math.min(width / design.w, height / design.h);
  return {
    scale,
    ox: (width - design.w * scale) / 2,
    oy: (height - design.h * scale) / 2,
  };
}

// The layout math needs asset display sizes — mirrored from assets.ts
// (200×200 concept set; the two text cards differ). The unit battery
// cross-checks this table against the loaded library.
export const W1_ASSET_VIEWBOX: Record<string, { w: number; h: number }> = {
  "heart-main": { w: 200, h: 200 },
  "title-hero": { w: 800, h: 200 },
  "close-card": { w: 800, h: 220 },
  "bar-chart": { w: 200, h: 200 },
  "check-badge": { w: 200, h: 200 },
  "rocket": { w: 200, h: 200 },
  "lungs": { w: 200, h: 200 },
  "arrow-curve": { w: 200, h: 200 },
  "arrow-return": { w: 200, h: 200 },
};

/** The mapped, canvas-space placements for one scene on one aspect (the
 *  same numbers buildBenchmarkProject bakes into the project). */
export function w1MappedPlacements(
  sceneId: W1SceneId,
  aspect: W1AspectId
): { assetId: string; x: number; y: number; w: number; h: number; order?: number }[] {
  const scene = DESIGN_SCENES.find((s) => s.id === sceneId);
  if (!scene) throw new Error(`unknown W1 scene: ${sceneId}`);
  const items = aspect === "9:16" ? scene.portrait : scene.landscape;
  const fit = fitFor(aspect);
  return items.map((it) => {
    const vb = W1_ASSET_VIEWBOX[it.assetId];
    if (!vb) throw new Error(`W1 scene ${sceneId} references unmapped asset ${it.assetId}`);
    return {
      assetId: it.assetId,
      x: round1(fit.ox + it.dx * fit.scale),
      y: round1(fit.oy + it.dy * fit.scale),
      w: round1(vb.w * it.designScale * fit.scale),
      h: round1(vb.h * it.designScale * fit.scale),
      order: it.order,
    };
  });
}

/** Build the benchmark project for one aspect — PURE, deterministic.
 *  Two calls return deep-equal projects (the unit battery pins it). */
export function buildBenchmarkProject(aspect: W1AspectId): WhiteboardProject {
  const { width, height } = W1_ASPECTS[aspect];
  const fit = fitFor(aspect);
  const scenes: WhiteboardScene[] = DESIGN_SCENES.map((s) => {
    const items = aspect === "9:16" ? s.portrait : s.landscape;
    const placements = items.map((it) => {
      const vb = W1_ASSET_VIEWBOX[it.assetId];
      if (!vb) throw new Error(`W1 scene ${s.id} references unmapped asset ${it.assetId}`);
      return {
        assetId: it.assetId,
        placement: {
          x: round1(fit.ox + it.dx * fit.scale),
          y: round1(fit.oy + it.dy * fit.scale),
          scale: round3(it.designScale * fit.scale),
          rotateDeg: it.rotateDeg ?? 0,
        },
        ...(it.order !== undefined ? { order: it.order } : {}),
      };
    });
    return {
      id: s.id,
      narration: s.narration,
      durationMs: s.durationMs,
      background: "#ffffff" as const,
      placements,
      animations: [],
      camera: [],
    };
  });
  return {
    title: "W1 whiteboard perceptual baseline — five fixed scene types",
    width,
    height,
    fps: W1_FPS,
    hand: { style: "marker", scale: 1 },
    scenes,
  };
}

// ---------------------------------------------------------------------------
// The clock — explicit durations, cumulative spans, sample + seam times.
// Aspect-independent (durations are frozen), so timestamps are comparable
// across aspects and runs.
// ---------------------------------------------------------------------------

export interface W1Span {
  id: W1SceneId;
  kind: string;
  startMs: number;
  durationMs: number;
  endMs: number;
}

export function w1SceneSpans(): W1Span[] {
  let t = 0;
  return DESIGN_SCENES.map((s) => {
    const startMs = t;
    t += s.durationMs;
    return { id: s.id, kind: W1_SCENE_KINDS[s.id], startMs, durationMs: s.durationMs, endMs: t };
  });
}

/** Total benchmark duration (ms) — one number the receipts cite. */
export function w1TotalDurationMs(): number {
  const spans = w1SceneSpans();
  return spans[spans.length - 1].endMs;
}

export interface W1Sample {
  id: W1SceneId;
  kind: string;
  /** Sample point inside the final concat'd mp4 (seconds) — 60% into the
   *  scene's span: mid-ink for every scene type, never the blank lead-in. */
  tSec: number;
}

export function w1SamplePlan(): W1Sample[] {
  return w1SceneSpans().map((s) => ({
    id: s.id,
    kind: s.kind,
    tSec: Math.round((s.startMs + s.durationMs * 0.6)) / 1000,
  }));
}

export interface W1Seam {
  between: [W1SceneId, W1SceneId];
  /** The outgoing scene's LAST frame (seconds) — 1.5 frames before the
   *  cut, because ffmpeg input seek lands on the first frame with
   *  PTS ≥ t: at endMs − 1 frame it rounds UP onto the incoming scene's
   *  frame 0 (verified against the concat'd PTS table). */
  lastTSec: number;
  /** The incoming scene's FIRST frame (seconds) — PTS == the cut, which
   *  the concat'd timeline places exactly on the boundary. */
  firstTSec: number;
}

export function w1SeamPlan(): W1Seam[] {
  const spans = w1SceneSpans();
  const frameMs = 1000 / W1_FPS;
  const seams: W1Seam[] = [];
  for (let i = 0; i < spans.length - 1; i++) {
    seams.push({
      between: [spans[i].id, spans[i + 1].id],
      lastTSec: Math.round(spans[i].endMs - 1.5 * frameMs) / 1000,
      firstTSec: spans[i].endMs / 1000,
    });
  }
  return seams;
}
