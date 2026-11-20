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
  // The five-subject fill (the benchmark stage) — every new asset the
  // subject sets reference, mirrored from assets.ts. The unit battery
  // cross-checks the whole table against the loaded library.
  "gear": { w: 200, h: 200 },
  "flow-steps": { w: 200, h: 200 },
  "open-book": { w: 200, h: 200 },
  "globe": { w: 200, h: 200 },
  "coin": { w: 200, h: 200 },
  "clock": { w: 200, h: 200 },
  "pie-chart": { w: 200, h: 200 },
  "lightbulb": { w: 200, h: 200 },
  "target": { w: 200, h: 200 },
  "graduation-cap": { w: 200, h: 200 },
  "arrow-growth": { w: 200, h: 200 },
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
// P0 — the traced-image benchmark seed (the plan's P0-8) + the five-subject
// slots. The W1 five-scene set above stays FROZEN (the reconciliation's
// law); the traced seed rides BESIDE it as its own scene id + a pure
// builder, so buildBenchmarkProject remains byte-identical (the
// no-regression pin) while the harness gains a raster lane.
// ---------------------------------------------------------------------------

export const W1_TRACED_SCENE_ID = "w1-traced";

/** The committed line-art fixture the benchmark script, the unit battery
 *  and the e2e golden path all trace (scripts/fixtures/whiteboard-trace-
 *  fixture.png). This module stays PURE: the bytes are a PARAMETER — the
 *  script reads the file and traces it through traceRasterToStrokes; here
 *  only the RESULT is placed. */
export const W1_TRACED_FIXTURE = "scripts/fixtures/whiteboard-trace-fixture.png";

export interface W1TracedAssetInput {
  assetId: string;
  /** The traced fragment (extractAsset-shaped, single-subpath paths). */
  svg: string;
  viewBox: { w: number; h: number };
  strokes: number;
}

export const W1_TRACED_NARRATION =
  "This diagram was not drawn by hand. A picture went in, and the pen drew every line of it — the same strokes, the same engine.";

/** Build the traced benchmark project for one aspect — PURE, deterministic
 *  (the traced asset is an INPUT, not a file read; two calls with the same
 *  input return deep-equal projects). One process-diagram scene: the
 *  traced illustration draws progressively under the fill law, the arrow
 *  punctuates it, and the traced strokes ride the SAME scheduleScene /
 *  frameAt machinery every built-in rides. */
export function buildTracedBenchmarkProject(aspect: W1AspectId, traced: W1TracedAssetInput): WhiteboardProject {
  const { width, height } = W1_ASPECTS[aspect];
  const fit = fitFor(aspect);
  // Display target ~480 design px wide (portrait: ~380) — the traced asset
  // scales like a library asset despite its own viewBox size.
  const designScale = Math.round(((aspect === "9:16" ? 380 : 480) / traced.viewBox.w) * 1000) / 1000;
  const items: W1DesignItem[] = [
    { assetId: traced.assetId, dx: aspect === "9:16" ? 90 : 320, dy: aspect === "9:16" ? 620 : 220, designScale },
    { assetId: "arrow-curve", dx: aspect === "9:16" ? 380 : 880, dy: aspect === "9:16" ? 560 : 500, designScale: 0.9, rotateDeg: -15, order: 2 },
  ];
  const placements = items.map((it) => {
    const vb = it.assetId === traced.assetId ? traced.viewBox : W1_ASSET_VIEWBOX[it.assetId];
    if (!vb) throw new Error(`w1-traced references unmapped asset ${it.assetId}`);
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
    title: "W1 traced-image seed — the raster-to-stroke lane",
    width,
    height,
    fps: W1_FPS,
    hand: { style: "marker", scale: 1 },
    scenes: [
      {
        id: W1_TRACED_SCENE_ID,
        narration: W1_TRACED_NARRATION,
        durationMs: 8500,
        background: "#ffffff" as const,
        placements,
        animations: [],
        camera: [],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// The benchmark stage — the five-subject suite FILL. The frozen W1 set
// above IS the science slot (its topic rides the built-in benchmark set);
// each other subject authors the SAME five scene types (title / process
// diagram / comparison / handwritten key phrase / conclusion) on its own
// topic, in the same two design spaces, with the SAME per-kind durations
// (comparability across subjects is the harness's whole point). PURE and
// deterministic: two builds of the same subject+aspect are deep-equal.
// ---------------------------------------------------------------------------

/** One subject-authored scene. `kind` is one of the five frozen W1 scene
 *  TYPES (the rubric's rows); `id` is the subject-scoped scene id. */
export interface SubjectDesignScene {
  id: string;
  kind: W1SceneId;
  narration: string;
  durationMs: number;
  landscape: W1DesignItem[];
  portrait: W1DesignItem[];
}

/** Per-kind durations — mirrored from the frozen W1 scenes (title 7.5s,
 *  process 8.5s, comparison 8s, phrase 7s, conclusion 7s) so every
 *  subject spans the same clock and receipts are comparable. */
export const SUBJECT_KIND_DURATION_MS: Record<W1SceneId, number> = {
  "w1-title": 7500,
  "w1-process": 8500,
  "w1-comparison": 8000,
  "w1-phrase": 7000,
  "w1-conclusion": 7000,
};

/** The subject-scoped scene ids, in the frozen type order. */
export const SUBJECT_SCENE_KIND_IDS: Record<W1SceneId, string> = {
  "w1-title": "title",
  "w1-process": "process",
  "w1-comparison": "comparison",
  "w1-phrase": "phrase",
  "w1-conclusion": "conclusion",
};

/** The four newly authored subjects (science = the frozen W1 set). The
 *  islamic-history set is authored on OBJECTS ONLY — no figures, no
 *  faces, no depictions of people (the I.8 constraint as an authoring
 *  law; the unit battery pins the asset allowlist + the narration scan). */
export const SUBJECT_DESIGN_SCENES: Record<string, SubjectDesignScene[]> = {
  engineering: [
    {
      id: "eng-title",
      kind: "w1-title",
      narration:
        "A suspension bridge carries thousands of cars every day. Today we draw the secret of how all that weight finds its way to the ground.",
      durationMs: 7500,
      landscape: [
        { assetId: "title-hero", dx: 360, dy: 200, designScale: 1.1 },
        { assetId: "gear", dx: 1050, dy: 460, designScale: 1.5, order: 2 },
      ],
      portrait: [
        { assetId: "title-hero", dx: 50, dy: 520, designScale: 1.0 },
        { assetId: "gear", dx: 340, dy: 820, designScale: 1.3, order: 2 },
      ],
    },
    {
      id: "eng-process",
      kind: "w1-process",
      narration:
        "Follow the load. The deck pushes into the cables, the cables lean on the towers, and the towers hand everything down into the bedrock.",
      durationMs: 8500,
      landscape: [
        { assetId: "flow-steps", dx: 180, dy: 300, designScale: 1.5 },
        { assetId: "gear", dx: 1140, dy: 300, designScale: 1.3, order: 2 },
        { assetId: "arrow-curve", dx: 640, dy: 250, designScale: 1.0, rotateDeg: -15, order: 3 },
        { assetId: "arrow-return", dx: 640, dy: 520, designScale: 1.0, rotateDeg: 168, order: 4 },
      ],
      portrait: [
        { assetId: "flow-steps", dx: 70, dy: 660, designScale: 1.25 },
        { assetId: "gear", dx: 590, dy: 660, designScale: 1.15, order: 2 },
        { assetId: "arrow-curve", dx: 370, dy: 570, designScale: 0.9, rotateDeg: -18, order: 3 },
        { assetId: "arrow-return", dx: 370, dy: 800, designScale: 0.9, rotateDeg: 168, order: 4 },
      ],
    },
    {
      id: "eng-comparison",
      kind: "w1-comparison",
      narration:
        "Two bridges, two spans. A plain beam bridge sags past thirty meters. Hang the deck from cables, and the same river crossing clears two kilometers.",
      durationMs: 8000,
      landscape: [
        { assetId: "bar-chart", dx: 420, dy: 280, designScale: 1.5 },
        { assetId: "arrow-growth", dx: 980, dy: 300, designScale: 1.3, order: 2 },
      ],
      portrait: [
        { assetId: "bar-chart", dx: 80, dy: 760, designScale: 1.25 },
        { assetId: "arrow-growth", dx: 570, dy: 780, designScale: 1.1, order: 2 },
      ],
    },
    {
      id: "eng-phrase",
      kind: "w1-phrase",
      narration:
        "If you remember one shape, make it this one: the cable's curve is what carries the load.",
      durationMs: 7000,
      landscape: [{ assetId: "close-card", dx: 400, dy: 340, designScale: 1.2 }],
      portrait: [{ assetId: "close-card", dx: 50, dy: 720, designScale: 1.0 }],
    },
    {
      id: "eng-conclusion",
      kind: "w1-conclusion",
      narration:
        "Now you can sketch the bridge yourself: deck, cables, towers — and the ground that quietly takes the weight.",
      durationMs: 7000,
      landscape: [
        { assetId: "check-badge", dx: 480, dy: 320, designScale: 1.4 },
        { assetId: "gear", dx: 920, dy: 320, designScale: 1.4, order: 2 },
      ],
      portrait: [
        { assetId: "check-badge", dx: 130, dy: 800, designScale: 1.25 },
        { assetId: "gear", dx: 520, dy: 800, designScale: 1.25, order: 2 },
      ],
    },
  ],
  "islamic-history": [
    {
      id: "isl-title",
      kind: "w1-title",
      narration:
        "In ninth-century Baghdad stood a library known as the House of Wisdom, where books, maps and instruments turned translation into an engine of science.",
      durationMs: 7500,
      landscape: [
        { assetId: "title-hero", dx: 360, dy: 200, designScale: 1.1 },
        { assetId: "open-book", dx: 1050, dy: 460, designScale: 1.5, order: 2 },
      ],
      portrait: [
        { assetId: "title-hero", dx: 50, dy: 520, designScale: 1.0 },
        { assetId: "open-book", dx: 340, dy: 820, designScale: 1.3, order: 2 },
      ],
    },
    {
      id: "isl-process",
      kind: "w1-process",
      narration:
        "Here is the movement. Texts arrived in Greek, Persian and Sanskrit. Teams rendered them into Arabic, checked every table, and passed the corrected pages onward.",
      durationMs: 8500,
      landscape: [
        { assetId: "flow-steps", dx: 180, dy: 300, designScale: 1.5 },
        { assetId: "open-book", dx: 1140, dy: 300, designScale: 1.3, order: 2 },
        { assetId: "arrow-curve", dx: 640, dy: 250, designScale: 1.0, rotateDeg: -15, order: 3 },
        { assetId: "arrow-return", dx: 640, dy: 520, designScale: 1.0, rotateDeg: 168, order: 4 },
      ],
      portrait: [
        { assetId: "flow-steps", dx: 70, dy: 660, designScale: 1.25 },
        { assetId: "open-book", dx: 590, dy: 660, designScale: 1.15, order: 2 },
        { assetId: "arrow-curve", dx: 370, dy: 570, designScale: 0.9, rotateDeg: -18, order: 3 },
        { assetId: "arrow-return", dx: 370, dy: 800, designScale: 0.9, rotateDeg: 168, order: 4 },
      ],
    },
    {
      id: "isl-comparison",
      kind: "w1-comparison",
      narration:
        "The maps changed too. Older charts copied inherited guesses. Baghdad's astronomers measured a degree of latitude on open ground and redrew the world to match.",
      durationMs: 8000,
      landscape: [
        { assetId: "bar-chart", dx: 420, dy: 280, designScale: 1.5 },
        { assetId: "globe", dx: 980, dy: 300, designScale: 1.3, order: 2 },
      ],
      portrait: [
        { assetId: "bar-chart", dx: 80, dy: 760, designScale: 1.25 },
        { assetId: "globe", dx: 570, dy: 780, designScale: 1.1, order: 2 },
      ],
    },
    {
      id: "isl-phrase",
      kind: "w1-phrase",
      narration:
        "If you remember one idea, make it this one: translation there was not copying — it was invention.",
      durationMs: 7000,
      landscape: [{ assetId: "close-card", dx: 400, dy: 340, designScale: 1.2 }],
      portrait: [{ assetId: "close-card", dx: 50, dy: 720, designScale: 1.0 }],
    },
    {
      id: "isl-conclusion",
      kind: "w1-conclusion",
      narration:
        "The shelves are gone; the ideas stayed. The science we inherit still carries the marks of that room of books.",
      durationMs: 7000,
      landscape: [
        { assetId: "check-badge", dx: 480, dy: 320, designScale: 1.4 },
        { assetId: "lightbulb", dx: 920, dy: 320, designScale: 1.4, order: 2 },
      ],
      portrait: [
        { assetId: "check-badge", dx: 130, dy: 800, designScale: 1.25 },
        { assetId: "lightbulb", dx: 520, dy: 800, designScale: 1.25, order: 2 },
      ],
    },
  ],
  business: [
    {
      id: "biz-title",
      kind: "w1-title",
      narration:
        "Most startups do not die because the product fails. They die because the money runs out first. Today we draw why.",
      durationMs: 7500,
      landscape: [
        { assetId: "title-hero", dx: 360, dy: 200, designScale: 1.1 },
        { assetId: "coin", dx: 1050, dy: 460, designScale: 1.5, order: 2 },
      ],
      portrait: [
        { assetId: "title-hero", dx: 50, dy: 520, designScale: 1.0 },
        { assetId: "coin", dx: 340, dy: 820, designScale: 1.3, order: 2 },
      ],
    },
    {
      id: "biz-process",
      kind: "w1-process",
      narration:
        "Watch the loop. Cash buys the build, the build finds customers, customers bring cash back. Spend faster than the loop returns, and the runway clock wins.",
      durationMs: 8500,
      landscape: [
        { assetId: "flow-steps", dx: 180, dy: 300, designScale: 1.4 },
        { assetId: "coin", dx: 1140, dy: 300, designScale: 1.3, order: 2 },
        { assetId: "clock", dx: 180, dy: 560, designScale: 1.0, order: 3 },
        { assetId: "arrow-curve", dx: 640, dy: 250, designScale: 1.0, rotateDeg: -15, order: 4 },
      ],
      portrait: [
        { assetId: "flow-steps", dx: 70, dy: 660, designScale: 1.2 },
        { assetId: "coin", dx: 590, dy: 660, designScale: 1.15, order: 2 },
        { assetId: "clock", dx: 70, dy: 900, designScale: 0.9, order: 3 },
        { assetId: "arrow-curve", dx: 370, dy: 570, designScale: 0.9, rotateDeg: -18, order: 4 },
      ],
    },
    {
      id: "biz-comparison",
      kind: "w1-comparison",
      narration:
        "Two companies, same revenue. One spends forty percent of it on growth, the other eighty. Only one of them survives a bad quarter.",
      durationMs: 8000,
      landscape: [
        { assetId: "bar-chart", dx: 420, dy: 280, designScale: 1.5 },
        { assetId: "pie-chart", dx: 980, dy: 300, designScale: 1.3, order: 2 },
      ],
      portrait: [
        { assetId: "bar-chart", dx: 80, dy: 760, designScale: 1.25 },
        { assetId: "pie-chart", dx: 570, dy: 780, designScale: 1.1, order: 2 },
      ],
    },
    {
      id: "biz-phrase",
      kind: "w1-phrase",
      narration:
        "If you remember one number, make it this one: eighteen months of runway, minimum.",
      durationMs: 7000,
      landscape: [{ assetId: "close-card", dx: 400, dy: 340, designScale: 1.2 }],
      portrait: [{ assetId: "close-card", dx: 50, dy: 720, designScale: 1.0 }],
    },
    {
      id: "biz-conclusion",
      kind: "w1-conclusion",
      narration:
        "Now you can read your own burn: cash in, cash out, every month — and the gap between them that decides everything.",
      durationMs: 7000,
      landscape: [
        { assetId: "check-badge", dx: 480, dy: 320, designScale: 1.4 },
        { assetId: "target", dx: 920, dy: 320, designScale: 1.4, order: 2 },
      ],
      portrait: [
        { assetId: "check-badge", dx: 130, dy: 800, designScale: 1.25 },
        { assetId: "target", dx: 520, dy: 800, designScale: 1.25, order: 2 },
      ],
    },
  ],
  "general-education": [
    {
      id: "edu-title",
      kind: "w1-title",
      narration:
        "Every river is a sculptor working slowly. Today we draw how moving water rewrites the land it touches.",
      durationMs: 7500,
      landscape: [
        { assetId: "title-hero", dx: 360, dy: 200, designScale: 1.1 },
        { assetId: "globe", dx: 1050, dy: 460, designScale: 1.5, order: 2 },
      ],
      portrait: [
        { assetId: "title-hero", dx: 50, dy: 520, designScale: 1.0 },
        { assetId: "globe", dx: 340, dy: 820, designScale: 1.3, order: 2 },
      ],
    },
    {
      id: "edu-process",
      kind: "w1-process",
      narration:
        "Follow one drop. Rain falls, runoff gathers, the channel cuts downward, and the sediment it carried settles wide at the delta.",
      durationMs: 8500,
      landscape: [
        { assetId: "flow-steps", dx: 180, dy: 300, designScale: 1.5 },
        { assetId: "globe", dx: 1140, dy: 300, designScale: 1.3, order: 2 },
        { assetId: "arrow-curve", dx: 640, dy: 250, designScale: 1.0, rotateDeg: -15, order: 3 },
        { assetId: "arrow-return", dx: 640, dy: 520, designScale: 1.0, rotateDeg: 168, order: 4 },
      ],
      portrait: [
        { assetId: "flow-steps", dx: 70, dy: 660, designScale: 1.25 },
        { assetId: "globe", dx: 590, dy: 660, designScale: 1.15, order: 2 },
        { assetId: "arrow-curve", dx: 370, dy: 570, designScale: 0.9, rotateDeg: -18, order: 3 },
        { assetId: "arrow-return", dx: 370, dy: 800, designScale: 0.9, rotateDeg: 168, order: 4 },
      ],
    },
    {
      id: "edu-comparison",
      kind: "w1-comparison",
      narration:
        "A steep river cuts fast and carries everything. A lazy river drops its load and builds. Same water, two different lands.",
      durationMs: 8000,
      landscape: [
        { assetId: "bar-chart", dx: 420, dy: 280, designScale: 1.5 },
        { assetId: "clock", dx: 980, dy: 300, designScale: 1.3, order: 2 },
      ],
      portrait: [
        { assetId: "bar-chart", dx: 80, dy: 760, designScale: 1.25 },
        { assetId: "clock", dx: 570, dy: 780, designScale: 1.1, order: 2 },
      ],
    },
    {
      id: "edu-phrase",
      kind: "w1-phrase",
      narration:
        "If you remember one pair of words, make it these: erode up high, deposit down low.",
      durationMs: 7000,
      landscape: [{ assetId: "close-card", dx: 400, dy: 340, designScale: 1.2 }],
      portrait: [{ assetId: "close-card", dx: 50, dy: 720, designScale: 1.0 }],
    },
    {
      id: "edu-conclusion",
      kind: "w1-conclusion",
      narration:
        "Now you can read a landscape the way the river wrote it: the canyon, the bend, the fan of soil at the mouth.",
      durationMs: 7000,
      landscape: [
        { assetId: "check-badge", dx: 480, dy: 320, designScale: 1.4 },
        { assetId: "graduation-cap", dx: 920, dy: 320, designScale: 1.4, order: 2 },
      ],
      portrait: [
        { assetId: "check-badge", dx: 130, dy: 800, designScale: 1.25 },
        { assetId: "graduation-cap", dx: 520, dy: 800, designScale: 1.25, order: 2 },
      ],
    },
  ],
};

/** Subject ids that carry their own authored scenes (science rides the
 *  frozen W1 set — that IS its scenario set). */
export const SUBJECT_IDS = ["engineering", "islamic-history", "business", "general-education"] as const;
export type SubjectId = (typeof SUBJECT_IDS)[number];

export const SUBJECT_PREFIX: Record<SubjectId, string> = {
  engineering: "eng",
  "islamic-history": "isl",
  business: "biz",
  "general-education": "edu",
};

/** The five scene ids for one subject, in the frozen type order. */
export function subjectSceneIds(subjectId: SubjectId): string[] {
  const prefix = SUBJECT_PREFIX[subjectId];
  return W1_SCENE_IDS.map((kind) => `${prefix}-${SUBJECT_SCENE_KIND_IDS[kind]}`);
}

/** Subject scenes for one subject id — science resolves to the frozen W1
 *  set (kind === id there), the other four to their authored sets. */
export function subjectScenes(subjectId: SubjectId | "science"): SubjectDesignScene[] {
  if (subjectId === "science") {
    return DESIGN_SCENES.map((s) => ({ ...s, kind: s.id }));
  }
  return SUBJECT_DESIGN_SCENES[subjectId];
}

/** Generic scene spans (the W1 clock generalised) — kind strings via the
 *  frozen W1_SCENE_KINDS labels, so receipts read the same row labels. */
export function subjectSpans(subjectId: SubjectId | "science"):
  { id: string; kind: string; startMs: number; durationMs: number; endMs: number }[] {
  let t = 0;
  return subjectScenes(subjectId).map((s) => {
    const startMs = t;
    t += s.durationMs;
    return { id: s.id, kind: W1_SCENE_KINDS[s.kind], startMs, durationMs: s.durationMs, endMs: t };
  });
}

/** Total duration for one subject's clock (ms). */
export function subjectTotalDurationMs(subjectId: SubjectId | "science"): number {
  const spans = subjectSpans(subjectId);
  return spans[spans.length - 1].endMs;
}

/** Generic sample plan — 60% into each scene's span (the W1 lens). */
export function subjectSamplePlan(subjectId: SubjectId | "science"):
  { id: string; kind: string; tSec: number }[] {
  return subjectSpans(subjectId).map((s) => ({
    id: s.id,
    kind: s.kind,
    tSec: Math.round(s.startMs + s.durationMs * 0.6) / 1000,
  }));
}

/** Generic seam plan — the same ffmpeg-boundary arithmetic as W1's. */
export function subjectSeamPlan(subjectId: SubjectId | "science"):
  { between: [string, string]; lastTSec: number; firstTSec: number }[] {
  const spans = subjectSpans(subjectId);
  const frameMs = 1000 / W1_FPS;
  const seams: { between: [string, string]; lastTSec: number; firstTSec: number }[] = [];
  for (let i = 0; i < spans.length - 1; i++) {
    seams.push({
      between: [spans[i].id, spans[i + 1].id],
      lastTSec: Math.round(spans[i].endMs - 1.5 * frameMs) / 1000,
      firstTSec: spans[i].endMs / 1000,
    });
  }
  return seams;
}

/** The I.8 authoring law, as data: assets the islamic-history subject may
 *  place. The library has no figure assets at all — the allowlist pins
 *  THAT fact explicitly, so a future library addition cannot silently
 *  enter the islamic lane (the pin fails until the set is lawfully
 *  extended). */
export const ISLAMIC_SUBJECT_ASSET_ALLOWLIST: readonly string[] = [
  "title-hero",
  "close-card",
  "flow-steps",
  "open-book",
  "globe",
  "bar-chart",
  "arrow-curve",
  "arrow-return",
  "check-badge",
  "lightbulb",
];

/** Build the benchmark project for one SUBJECT + aspect — PURE,
 *  deterministic (two calls deep-equal). The frozen buildBenchmarkProject
 *  is byte-identical to its pre-fill shape; this builder rides BESIDE it.
 *  The islamic-history subject enforces the I.8 asset allowlist at build
 *  time — an out-of-allowlist placement is a build error, not a render
 *  surprise. */
export function buildSubjectBenchmarkProject(subjectId: SubjectId | "science", aspect: W1AspectId): WhiteboardProject {
  const { width, height } = W1_ASPECTS[aspect];
  const fit = fitFor(aspect);
  const scenes: WhiteboardScene[] = subjectScenes(subjectId).map((s) => {
    const items = aspect === "9:16" ? s.portrait : s.landscape;
    const placements = items.map((it) => {
      const vb = W1_ASSET_VIEWBOX[it.assetId];
      if (!vb) throw new Error(`subject scene ${s.id} references unmapped asset ${it.assetId}`);
      if (subjectId === "islamic-history" && !ISLAMIC_SUBJECT_ASSET_ALLOWLIST.includes(it.assetId)) {
        throw new Error(`subject scene ${s.id}: asset ${it.assetId} is outside the islamic-history allowlist (I.8)`);
      }
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
    title: `W1 subject benchmark — ${subjectId}`,
    width,
    height,
    fps: W1_FPS,
    hand: { style: "marker", scale: 1 },
    scenes,
  };
}

/** The five-subject benchmark suite slots (the operator's five benchmark
 *  subjects): NAMED in P0-8 with placeholder topics + policy ids, FILLED
 *  in the benchmark stage (this fill). The islamic-history slot carries
 *  its content policy from day one — the I.8 constraint is a property of
 *  the SLOT, not an afterthought; its authored set enforces the object-
 *  only allowlist at build time and the unit battery pins the narration
 *  scan. Science rides the frozen W1 set (that IS its scenario set). */
export const W1_SUBJECT_SLOTS: readonly {
  id: string;
  topic: string;
  policyId: "standard" | "islamic-history";
  scenarioIds: readonly string[];
  status: "active" | "placeholder";
}[] = [
  {
    id: "science",
    topic: "How Your Heart Works",
    policyId: "standard",
    scenarioIds: W1_SCENE_IDS,
    status: "active",
  },
  {
    id: "engineering",
    topic: "How a Suspension Bridge Holds",
    policyId: "standard",
    scenarioIds: subjectSceneIds("engineering"),
    status: "active",
  },
  {
    id: "islamic-history",
    topic: "The House of Wisdom, Baghdad",
    policyId: "islamic-history",
    scenarioIds: subjectSceneIds("islamic-history"),
    status: "active",
  },
  {
    id: "business",
    topic: "Why Startups Run Out of Cash",
    policyId: "standard",
    scenarioIds: subjectSceneIds("business"),
    status: "active",
  },
  {
    id: "general-education",
    topic: "How Rivers Shape the Land",
    policyId: "standard",
    scenarioIds: subjectSceneIds("general-education"),
    status: "active",
  },
];

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
