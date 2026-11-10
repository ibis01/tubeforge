// S73 — the Whiteboard LLM scaffold planner (E5 phase 2,
// WHITEBOARD_ENGINE_DESIGN.md §9: "phase 2 (LLM planner via aiCallJson)").
//
// The metered half of the scaffold intelligence: an LLM reads the story
// scenes and proposes which CONCEPT assets visualize each one — and where
// on the board they sit — through aiCallJson → budget.ts's single choke
// point (design §1 law 5: drawing/rendering is $0; only the optional AI
// planner and TTS are metered). Everything structural stays the engine's:
// the title/close cards, the default camera, the EMPTY event lists
// (timing.ts's fill law owns the draw schedule — a planner never writes a
// second scheduler). Scenes the LLM does not serve (skipped, or dropped to
// empty in normalization) fall back to the native rule-table pick (E5
// phase 1, whiteboard-planner.ts) — per scene, never silently. A failed
// LLM round-trip degrades the WHOLE scaffold to the native planner,
// honestly labeled in the report — never a 500, never an invented board.
//
// The whiteboard module stays a leaf (design §1 law 1): shared infra
// (budget's AiService type, llm.ts, ai.ts) + whiteboard siblings only.
// The catalog the model sees is the MERGED library (S69's one-merge law)
// — uploads included, so the planner can place the user's own assets the
// keyword rule table never learned.
import { aiCallJson } from "../ai";
import { llmChat } from "../llm";
import type { AiService } from "../budget";
import {
  scaffoldWhiteboardProject,
  type ScaffoldSceneInput,
} from "./whiteboard-planner";
import type {
  WhiteboardAssetPlacement,
  WhiteboardProject,
  WhiteboardScene,
} from "./storyboard";

// ---------------------------------------------------------------------------
// The catalog — what the model is allowed to pick
// ---------------------------------------------------------------------------

/** Assets the planner may NEVER pick: the drawing hand is engine-internal,
 * the title/close cards are the scaffold grammar's own (placed
 * deterministically by the native planner, whatever planner ran). */
export const WB_PLANNER_RESERVED_IDS = new Set([
  "hand-marker",
  "title-hero",
  "close-card",
]);

/** Concepts per scene cap. Well under the 64/scene validator budget on
 * purpose: a scaffold teaches with a few readable pieces, not a wall of
 * ink — the user edits from there. */
export const WB_PLANNER_CONCEPTS_PER_SCENE = 3;

/** Placement clamp bands (scene-space). The validator checks finiteness;
 * the planner additionally keeps the model's ink ON the board and inside
 * a sane size band — a clamped placement is USED, an unusable one is
 * DROPPED with its reason. */
const PLANNER_SCALE_BAND = { min: 0.2, max: 4 } as const;
const PLANNER_ROTATE_MAX = 180;

export interface PlannerCatalogEntry {
  id: string;
  tags: string[];
  w: number;
  h: number;
  /** True for the video's own uploads (S69 manifest) — the prompt marks
   * them so the model prefers the user's own art when it fits. */
  uploaded?: boolean;
}

/** Build the concept catalog from the merged library (built-ins + this
 * video's uploads). Reserved ids are excluded BY CONSTRUCTION — the model
 * never even sees them. Deterministic order: uploads first, then
 * built-ins alphabetically. */
export function buildPlannerCatalog(
  assets: Iterable<{ id: string; tags: string[]; viewBox: { w: number; h: number } }>
): PlannerCatalogEntry[] {
  const out: PlannerCatalogEntry[] = [];
  for (const a of assets) {
    if (WB_PLANNER_RESERVED_IDS.has(a.id)) continue;
    out.push({
      id: a.id,
      tags: a.tags.slice(0, 6),
      w: a.viewBox.w,
      h: a.viewBox.h,
      uploaded: a.tags.includes("upload"),
    });
  }
  return out.sort((a, b) =>
    a.uploaded === b.uploaded ? a.id.localeCompare(b.id) : a.uploaded ? -1 : 1
  );
}

// ---------------------------------------------------------------------------
// The model's proposal shape + PURE normalization
// ---------------------------------------------------------------------------

/** One concept pick as the model proposes it (lenient field names — the
 * validator accepts `id` or `assetId`; normalization does the policing). */
export interface LlmConceptPick {
  assetId: string;
  x: number;
  y: number;
  scale: number;
  rotateDeg?: number;
}

/** The model's per-scene row: `scene` is the STORY scene index (1-based,
 * exactly the number the prompt showed). */
export interface LlmScenePlan {
  scene: number;
  assets: LlmConceptPick[];
}

/** A pick that survived normalization: on-board, in-band, catalog-legal. */
export interface NormalizedConceptPick {
  assetId: string;
  x: number;
  y: number;
  scale: number;
  rotateDeg: number;
}

export interface NormalizedScenePlan {
  sceneIndex: number;
  picks: NormalizedConceptPick[];
}

/** A placement dropped in normalization — surfaced with its reason, never
 * silent (the E0 extraction discipline: exclusions are REPORTED). */
export interface DroppedPlacement {
  scene: number;
  assetId: string;
  reason: string;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : Number.NaN;
};

const clampNum = (n: number, lo: number, hi: number): number =>
  Math.min(Math.max(n, lo), hi);

/**
 * Normalize the model's raw scene plans against the REAL constraints:
 * the story's scene set, the concept catalog, the board geometry, the
 * per-scene cap, and the validator's no-double-placement law. PURE —
 * unit-pinned. A scene whose picks all die (or that the model never
 * mentioned) lands in `fallback` — the native rule table serves it.
 */
export function normalizeLlmScenePlans(
  raw: LlmScenePlan[],
  ctx: {
    scenes: ScaffoldSceneInput[];
    catalogIds: Set<string>;
    width: number;
    height: number;
    maxConceptsPerScene?: number;
  }
): {
  served: Map<number, NormalizedScenePlan>;
  fallback: number[];
  dropped: DroppedPlacement[];
} {
  const maxPicks = ctx.maxConceptsPerScene ?? WB_PLANNER_CONCEPTS_PER_SCENE;
  const storyIndexes = new Set(ctx.scenes.map((s) => s.index));
  const dropped: DroppedPlacement[] = [];
  // Merge rows that repeat a scene number; dedupe within the merge.
  const byScene = new Map<number, LlmConceptPick[]>();
  for (const row of raw) {
    const sceneNo = Number(row?.scene);
    if (!Number.isInteger(sceneNo) || !storyIndexes.has(sceneNo)) {
      dropped.push({
        scene: Number.isInteger(sceneNo) ? sceneNo : 0,
        assetId: "(scene)",
        reason: "scene number outside the story",
      });
      continue;
    }
    const bucket = byScene.get(sceneNo) ?? [];
    const assets = Array.isArray(row?.assets) ? row.assets : [];
    for (const a of assets) bucket.push(a);
    byScene.set(sceneNo, bucket);
  }

  const served = new Map<number, NormalizedScenePlan>();
  for (const [sceneNo, rawPicks] of byScene) {
    const picks: NormalizedConceptPick[] = [];
    const seen = new Set<string>();
    for (const p of rawPicks) {
      const assetId = String(p?.assetId ?? "").trim();
      if (!assetId) {
        dropped.push({ scene: sceneNo, assetId: "(blank)", reason: "no asset id" });
        continue;
      }
      if (WB_PLANNER_RESERVED_IDS.has(assetId)) {
        dropped.push({
          scene: sceneNo,
          assetId,
          reason: "reserved for the scaffold grammar (title/close cards, the drawing hand) — the engine places those",
        });
        continue;
      }
      if (!ctx.catalogIds.has(assetId)) {
        dropped.push({ scene: sceneNo, assetId, reason: "not in the concept catalog" });
        continue;
      }
      if (seen.has(assetId)) {
        dropped.push({
          scene: sceneNo,
          assetId,
          reason: "asset placed twice in one scene (the validator forbids double placement)",
        });
        continue;
      }
      const x = num(p?.x);
      const y = num(p?.y);
      const scale = num(p?.scale === undefined ? 1 : p?.scale);
      const rotate = num(p?.rotateDeg === undefined ? 0 : p?.rotateDeg);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(scale) || !Number.isFinite(rotate)) {
        dropped.push({ scene: sceneNo, assetId, reason: "non-finite coordinate" });
        continue;
      }
      seen.add(assetId);
      picks.push({
        assetId,
        x: Math.round(clampNum(x, 0, ctx.width)),
        y: Math.round(clampNum(y, 0, ctx.height)),
        scale: Math.round(clampNum(scale, PLANNER_SCALE_BAND.min, PLANNER_SCALE_BAND.max) * 100) / 100,
        rotateDeg: Math.round(clampNum(rotate, -PLANNER_ROTATE_MAX, PLANNER_ROTATE_MAX)),
      });
      if (picks.length >= maxPicks) break;
    }
    // Over-cap extras are dropped with the cap named (the loop above
    // stopped early — account the rest honestly).
    for (let i = maxPicks; i < rawPicks.length; i++) {
      const assetId = String(rawPicks[i]?.assetId ?? "").trim() || "(blank)";
      if (seen.has(assetId) || !ctx.catalogIds.has(assetId) || WB_PLANNER_RESERVED_IDS.has(assetId)) continue;
      dropped.push({
        scene: sceneNo,
        assetId,
        reason: `over the ${maxPicks}-concepts-per-scene cap`,
      });
    }
    if (picks.length > 0) served.set(sceneNo, { sceneIndex: sceneNo, picks });
  }

  const fallback = ctx.scenes
    .map((s) => s.index)
    .filter((idx) => !served.has(idx))
    .sort((a, b) => a - b);
  return { served, fallback, dropped };
}

// ---------------------------------------------------------------------------
// Composition — swap the native concept picks for the served ones
// ---------------------------------------------------------------------------

/**
 * Compose the LLM scaffold from the native base: for every SERVED scene,
 * keep the structural placements (title/close cards — the grammar) and
 * replace the native concept pick(s) with the model's normalized picks;
 * unserved scenes pass through byte-identical (the native rule table's
 * work). Camera keys, backgrounds, narration and the EMPTY event lists
 * are never touched — the fill law stays the only scheduler. PURE.
 */
export function composeLlmScaffold(
  native: WhiteboardProject,
  scenes: ScaffoldSceneInput[],
  served: Map<number, NormalizedScenePlan>
): WhiteboardProject {
  const out: WhiteboardScene[] = native.scenes.map((scene, i) => {
    const plan = served.get(scenes[i]?.index);
    if (!plan) return scene; // untouched — the native fallback scene
    const structural = scene.placements.filter((p) =>
      WB_PLANNER_RESERVED_IDS.has(p.assetId)
    );
    const picks: WhiteboardAssetPlacement[] = plan.picks.map((pick, j) => ({
      assetId: pick.assetId,
      placement: {
        x: pick.x,
        y: pick.y,
        scale: pick.scale,
        rotateDeg: pick.rotateDeg,
      },
      order: structural.length + j,
    }));
    return { ...scene, placements: [...structural, ...picks] };
  });
  return { ...native, scenes: out };
}

// ---------------------------------------------------------------------------
// The prompts
// ---------------------------------------------------------------------------

const PLANNER_SYSTEM_PROMPT = `You are a whiteboard video storyboard planner. You read a video's story scenes and choose concept assets from a fixed catalog that visualize what each scene's narration actually says, then place them on the board. Output STRICT JSON only:

{
  "scenes": [
    { "scene": 1, "assets": [ { "id": "coin", "x": 900, "y": 420, "scale": 1.6, "rotateDeg": 0 } ] }
  ]
}

Rules: every id MUST come from the catalog. "scene" is the story scene number you were given. x and y are the asset's center in scene-space on the board you were told about — keep every asset fully on the board and clear of the title card (top) and close card areas. scale between 0.5 and 3, rotateDeg between -180 and 180. One to three assets per scene; prefer fewer, larger, readable pieces over clutter. Never repeat an asset within one scene. Serve EVERY scene. Assets marked "your upload" belong to this video's author — prefer them when they genuinely fit. Never wrap in markdown fences. Never add commentary.`;

function plannerUserPrompt(
  input: { topic: string; scenes: ScaffoldSceneInput[] },
  catalog: PlannerCatalogEntry[],
  width: number,
  height: number
): string {
  const catalogLines = catalog
    .map((c) => `- ${c.id} (${c.uploaded ? "your upload; " : ""}${c.tags.join(", ")})`)
    .join("\n");
  const sceneLines = input.scenes
    .map(
      (s) =>
        `scene ${s.index} — ${s.title ? `${s.title}: ` : ""}${s.narration.slice(0, 600)}`
    )
    .join("\n");
  return [
    `Topic: ${input.topic}`,
    `Board: ${width} x ${height} (x/y are scene-space centers)`,
    "",
    "Catalog (id — meaning tags):",
    catalogLines,
    "",
    "Scenes:",
    sceneLines,
    "",
    "Output the STRICT JSON now.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The wrapper — aiCallJson, honest degradation, the injectable seams
// ---------------------------------------------------------------------------

/** aiCallJson's structural `call` stand-in (the fake-driven unit tests pass
 * a pass-through; production rides the real budgeting aiCall). */
export type PlannerCall = <U>(
  service: AiService,
  label: string,
  fn: () => Promise<U>,
  retryOpts?: { attempts?: number; baseDelayMs?: number }
) => Promise<U>;

export interface WhiteboardLlmPlannerReport {
  /** "llm" when the model served at least one scene; "native" when the
   * whole scaffold degraded to the rule table. The honest label. */
  planner: "llm" | "native";
  /** Scenes the LLM served with at least one valid concept placement. */
  servedScenes: number;
  /** Story scene indexes served by the native rule table instead. */
  fallbackScenes: number[];
  /** Placements dropped in normalization, each with its reason. */
  dropped: DroppedPlacement[];
  /** True when the LLM round-trip failed entirely — the project is the
   * NATIVE scaffold, labeled here, never presented as model work. */
  degraded: boolean;
  degradeReason?: string;
}

/** aiCallJson's validate: lenient about content (normalization polices),
 * strict about structure — throws (→ one fresh generation) only when the
 * reply carries no usable scene rows at all. */
function validateScenePlans(parsed: Record<string, unknown>): LlmScenePlan[] {
  const rows = Array.isArray(parsed.scenes) ? parsed.scenes : null;
  if (!rows) throw new Error("the planner reply has no scenes array");
  const out: LlmScenePlan[] = [];
  for (const r of rows) {
    const row = (r ?? {}) as Record<string, unknown>;
    const scene = Number(row.scene);
    if (!Number.isInteger(scene)) continue;
    const assets = Array.isArray(row.assets) ? row.assets : [];
    const picks: LlmConceptPick[] = [];
    for (const a of assets) {
      const p = (a ?? {}) as Record<string, unknown>;
      const assetId =
        typeof p.id === "string" ? p.id : typeof p.assetId === "string" ? p.assetId : "";
      picks.push({
        assetId,
        x: Number(p.x),
        y: Number(p.y),
        scale: p.scale === undefined ? 1 : Number(p.scale),
        rotateDeg: p.rotateDeg === undefined ? 0 : Number(p.rotateDeg),
      });
    }
    out.push({ scene, assets: picks });
  }
  if (out.length === 0) throw new Error("the planner reply carried no usable scene rows");
  return out;
}

/**
 * The E5 phase-2 scaffold. The deterministic base ALWAYS stands (built
 * first, clamped geometry, structural cards, camera, empty events); the
 * LLM round-trip then swaps concept picks per served scene. Any failure —
 * gateway down, quota blocked, malformed reply after its retry, an empty
 * normalization — degrades to the native scaffold with the reason in the
 * report. `opts.ask` / `opts.call` are the fake-driven unit-test seams
 * (the raw model reply / the budgeting call), exactly aiCallJson's own
 * injection discipline.
 */
export async function scaffoldWhiteboardProjectLlm(
  input: {
    scenes: ScaffoldSceneInput[];
    topic: string;
    width?: number;
    height?: number;
    fps?: number;
    catalog: PlannerCatalogEntry[];
  },
  opts: { ask?: () => Promise<string>; call?: PlannerCall } = {}
): Promise<{ project: WhiteboardProject; report: WhiteboardLlmPlannerReport }> {
  // The deterministic base — geometry clamps live here, so the prompt and
  // the normalization both use the CLAMPED board the project will carry.
  const native = scaffoldWhiteboardProject(input);
  const allFallback = input.scenes.map((s) => s.index);
  const degrade = (reason: string): { project: WhiteboardProject; report: WhiteboardLlmPlannerReport } => ({
    project: native,
    report: {
      planner: "native",
      servedScenes: 0,
      fallbackScenes: allFallback,
      dropped: [],
      degraded: true,
      degradeReason: reason.slice(0, 300),
    },
  });

  if (input.catalog.length === 0)
    return degrade("the concept catalog is empty — nothing for the planner to place");

  const ask =
    opts.ask ??
    (async () => {
      const completion = await llmChat({
        messages: [
          { role: "system", content: PLANNER_SYSTEM_PROMPT },
          {
            role: "user",
            content: plannerUserPrompt(input, input.catalog, native.width, native.height),
          },
        ],
        temperature: 0.3,
      });
      return completion.choices?.[0]?.message?.content ?? "";
    });

  try {
    const raw = await aiCallJson<LlmScenePlan[]>("llm", "whiteboard llm planner", ask, {
      validate: validateScenePlans,
      retry: { attempts: 2, baseDelayMs: 1500 },
      ...(opts.call ? { call: opts.call } : {}),
    });
    const { served, fallback, dropped } = normalizeLlmScenePlans(raw, {
      scenes: input.scenes,
      catalogIds: new Set(input.catalog.map((c) => c.id)),
      width: native.width,
      height: native.height,
    });
    if (served.size === 0)
      return degrade("every pick was dropped in normalization — no scene was servable");
    const project = composeLlmScaffold(native, input.scenes, served);
    return {
      project,
      report: {
        planner: "llm",
        servedScenes: served.size,
        fallbackScenes: fallback,
        dropped,
        degraded: false,
      },
    };
  } catch (err) {
    return degrade(err instanceof Error ? err.message : String(err));
  }
}
