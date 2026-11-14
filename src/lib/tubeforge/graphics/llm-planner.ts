// G1.4 — the motion-graphics LLM scaffold planner (S120 §5 / Part B), the
// whiteboard llm-planner's shape applied to the GraphicsDoc grammar.
//
// The metered half of the scaffold intelligence: an LLM reads the story
// scenes and proposes GRAPHICS ELEMENTS for each one — text lines, the
// stat's counter range, chart data, icon picks, placements, motions —
// through aiCallJson → budget.ts's single choke point (design law 5:
// composing structure is the only metered AI step of the scaffold;
// rendering stays $0). Everything structural stays the engine's: scene
// ids, narration, backgrounds, the scene clock (the narration estimate —
// VO-measured durations ride the render call, never the doc).
//
// PER-ELEMENT DEGRADATION (the commit's named pin): every proposed
// element is policed INDIVIDUALLY against the closed grammar — kind set,
// payload shape, motion/element compatibility (MOTION_KINDS_BY_ELEMENT),
// id law, per-scene cap, the scene clock. A dropped element never sinks
// its scene; a scene whose elements all die falls back to the native
// rule table (planner.ts) — per scene, never silently: every drop lands
// in the report with its reason. A failed LLM round-trip degrades the
// WHOLE doc to the native scaffold, honestly labeled — never a 500,
// never an invented board, and the degraded doc is BYTE-IDENTICAL to
// what the native planner would have built alone (the commit's other
// named pin).
//
// The graphics module stays a leaf: shared infra (budget's AiService
// type, llm.ts, ai.ts) + graphics siblings + the whiteboard's sentence
// splitter only. The icon catalog the model sees is planner.ts's
// GRAPHICS_ICON_LIBRARY — ONE icon source, never a second table.
import { aiCallJson } from "../ai";
import { llmChat } from "../llm";
import { countPathCommands, type Placement } from "../whiteboard/svg";
import { estimateNarrationMs } from "../whiteboard/timing";
import type { PlannerCall } from "../whiteboard/llm-planner";
import { isEaseName, type EaseName } from "../anim/easing";
import {
  GRAPHICS_BUDGETS,
  legalMotions,
  validGraphicsId,
  type BarDatum,
  type BarPayload,
  type CalloutPayload,
  type CounterPayload,
  type ElementMotion,
  type GraphicsDoc,
  type GraphicsElement,
  type GraphicsElementKind,
  type GraphicsMotionKind,
  type GraphicsScene,
  type IconPayload,
  type ShapePayload,
  type TextPayload,
} from "./types";
import {
  GRAPHICS_ICON_LIBRARY,
  nativeEnterFor,
  nativePlacementFor,
  type GraphicsSceneInput,
  scaffoldGraphicsDoc,
} from "./planner";

// ---------------------------------------------------------------------------
// Tunables — the planner's own walls (all under the validator's named
// walls on purpose: a scaffold teaches with a few readable pieces)
// ---------------------------------------------------------------------------

/** Elements per scene cap (under the 32-element validator wall). */
export const GRAPHICS_PLANNER_ELEMENTS_PER_SCENE = 6;

/** Chart rows cap hint — the validator's barDataMax is the hard wall; the
 *  prompt asks for fewer. Extras over barDataMax drop in normalization. */
export const GRAPHICS_PLANNER_CHART_ROWS = 5;

/** Icon paths cap per icon element (each path still individually budgeted
 *  by countPathCommands). */
export const GRAPHICS_PLANNER_ICON_PATHS = 4;

/** The shortest motion span the planner will keep (ms) — a motion that
 *  cannot fit this much before the scene clock dies. */
export const GRAPHICS_PLANNER_MIN_MOTION_MS = 250;

/** Placement clamp bands (scene-space) — the whiteboard planner's law. */
const PLANNER_SCALE_BAND = { min: 0.2, max: 4 } as const;
const PLANNER_ROTATE_MAX = 180;

// ---------------------------------------------------------------------------
// The model's proposal shape (lenient) + the normalized result
// ---------------------------------------------------------------------------

/** One element as the model proposes it — every field lenient; the
 *  normalization does the policing. Motion slots accept a bare kind
 *  string ("rise") or a partial motion object ({kind, durationMs,
 *  delayMs, ease}). */
export interface LlmElementProposal {
  kind?: unknown;
  id?: unknown;
  x?: unknown;
  y?: unknown;
  scale?: unknown;
  rotateDeg?: unknown;
  text?: unknown;
  sizePx?: unknown;
  weight?: unknown;
  color?: unknown;
  align?: unknown;
  from?: unknown;
  to?: unknown;
  unit?: unknown;
  decimals?: unknown;
  data?: unknown;
  max?: unknown;
  horizontal?: unknown;
  iconId?: unknown;
  paths?: unknown;
  strokeWidth?: unknown;
  pointsAt?: unknown;
  shape?: unknown;
  w?: unknown;
  h?: unknown;
  r?: unknown;
  stroke?: unknown;
  fill?: unknown;
  children?: unknown;
  enter?: unknown;
  exit?: unknown;
  emphasis?: unknown;
  opacity?: unknown;
}

export interface LlmGraphicsScenePlan {
  scene: number;
  elements: LlmElementProposal[];
}

/** A validated element: grammar-legal payload + motions, placement
 *  clamped onto the board, a scene-unique id. */
export interface NormalizedGraphicsScene {
  sceneIndex: number;
  elements: GraphicsElement[];
}

/** A proposal (element, slot, payload row, path) dropped in
 *  normalization — surfaced with its reason, never silent (the E0
 *  extraction discipline: exclusions are REPORTED). */
export interface DroppedProposal {
  scene: number;
  /** The element kind, or a slot/row qualifier ("headline", "chart row 3",
   *  "icon path 2", "group child", "exit on callout-1"). */
  subject: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// Module-private parse helpers (pure)
// ---------------------------------------------------------------------------

const GRAPHICS_MOTION_KIND_SET: ReadonlySet<string> = new Set([
  "fade", "rise", "slide", "pop", "wipe", "count", "grow", "draw",
]);

const GRAPHICS_ELEMENT_KIND_SET: ReadonlySet<string> = new Set([
  "headline", "subhead", "bullet", "counter", "bar", "barChart",
  "icon", "callout", "shape", "group",
]);

const TEXT_ALIGN_SET: ReadonlySet<string> = new Set(["left", "center", "right"]);

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : Number.NaN;
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

const clampNum = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi);

/** Element id police: a proposed id that passes the grammar's id law
 *  (validGraphicsId — ONE id law, never a second) and is scene-unused
 *  rides as-is; anything else synthesizes a deterministic unique id
 *  (kind-counted, collision-bumped). */
function policeId(
  raw: unknown,
  kind: GraphicsElementKind,
  used: Set<string>,
  perKindCount: number,
): string {
  const proposed = str(raw).trim();
  if (proposed !== "" && !used.has(proposed) && validGraphicsId(proposed)) {
    return proposed;
  }
  let id = `${kind}-${perKindCount + 1}`;
  let seq = perKindCount + 1;
  while (used.has(id)) {
    seq += 1;
    id = `${kind}-${seq}`;
  }
  return id;
}

/** One motion slot proposal → a legal, in-clock ElementMotion, or null
 *  (the caller decides: enter null ⇒ the element dies; exit/emphasis
 *  null ⇒ the slot drops). Defaults ride the native table — the planner
 *  never invents a second default set. */
function policeMotion(
  raw: unknown,
  kind: GraphicsElementKind,
  slot: "enter" | "exit" | "emphasis",
  clockMs: number,
  order: number,
  dropped: DroppedProposal[],
  sceneNo: number,
  subject: string,
): ElementMotion | null {
  const base = nativeEnterFor(kind, order);
  let motionKind: string;
  let durationMs = base.durationMs;
  let delayMs = slot === "enter" ? base.delayMs : slot === "exit" ? Math.max(0, clockMs - 450) : base.delayMs;
  let ease: EaseName = "ease-out";

  if (typeof raw === "string") {
    motionKind = raw.trim();
  } else if (typeof raw === "object" && raw !== null) {
    const r = raw as Record<string, unknown>;
    motionKind = str(r.kind).trim();
    const d = num(r.durationMs);
    if (Number.isFinite(d) && d > 0) durationMs = d;
    const dl = num(r.delayMs);
    if (Number.isFinite(dl) && dl >= 0) delayMs = dl;
    const e = str(r.ease).trim();
    if (isEaseName(e)) ease = e;
    // junk ease/numbers silently default — the whiteboard's clamp law
    // (a clamped/defaulted field is USED, an illegal KIND is DROPPED)
  } else if (raw === undefined) {
    motionKind = base.kind; // absent slot → the native default motion
  } else {
    dropped.push({ scene: sceneNo, subject, reason: `${slot} motion unreadable — not a kind string or motion object` });
    return null;
  }

  if (!(GRAPHICS_MOTION_KIND_SET as ReadonlySet<string>).has(motionKind)) {
    dropped.push({ scene: sceneNo, subject, reason: `${slot} motion kind "${motionKind.slice(0, 32)}" is not in the closed motion set` });
    return null;
  }
  if (!legalMotions(kind).includes(motionKind as GraphicsMotionKind)) {
    dropped.push({
      scene: sceneNo,
      subject,
      reason: `${slot} motion "${motionKind}" is not legal on a "${kind}" (allowed: ${legalMotions(kind).join(", ")})`,
    });
    return null;
  }

  // The scene clock: pull the duration back inside the clock when the
  // span overruns; a motion that starts too late to ever fit dies here
  // (the validator would refuse the doc — normalization guarantees it
  // never gets there).
  if (delayMs > clockMs - GRAPHICS_PLANNER_MIN_MOTION_MS) {
    dropped.push({
      scene: sceneNo,
      subject,
      reason: `${slot} motion at ${Math.round(delayMs)}ms cannot fit the scene clock (${Math.round(clockMs)}ms)`,
    });
    return null;
  }
  const clampedDuration = Math.min(durationMs, clockMs - delayMs);
  return {
    kind: motionKind as GraphicsMotionKind,
    durationMs: Math.round(clampedDuration),
    delayMs: Math.round(delayMs),
    ease,
  };
}

/** Placement police: readable members clamp onto the board; absent/junk
 *  falls back to the native per-kind default (the degradation law — a
 *  clamped placement is USED, an unusable element is the payload's job
 *  to catch). */
function policePlacement(
  raw: unknown,
  kind: GraphicsElementKind,
  width: number,
  height: number,
): Placement {
  const def = nativePlacementFor(kind, width, height);
  if (raw === undefined || raw === null || typeof raw !== "object" || Array.isArray(raw)) return def;
  const r = raw as Record<string, unknown>;
  const x = num(r.x);
  const y = num(r.y);
  const scaleRaw = r.scale;
  const scale = scaleRaw === undefined ? def.scale : num(scaleRaw);
  const rotateRaw = r.rotateDeg;
  const rotate = rotateRaw === undefined ? def.rotateDeg : num(rotateRaw);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(scale) || !Number.isFinite(rotate)) {
    return def; // junk placement → the native default, honestly
  }
  return {
    x: Math.round(clampNum(x, 0, width)),
    y: Math.round(clampNum(y, 0, height)),
    scale: Math.round(clampNum(scale, PLANNER_SCALE_BAND.min, PLANNER_SCALE_BAND.max) * 100) / 100,
    rotateDeg: Math.round(clampNum(rotate, -PLANNER_ROTATE_MAX, PLANNER_ROTATE_MAX)),
  };
}

/** Payload police per kind — returns the element's payload slot fields
 *  (typed), or null when the element must die. Row/path-level junk drops
 *  WITH its reason; shape violations on the whole payload kill the
 *  element (the validator would error on them — normalization
 *  guarantees the composed doc never errors). */
function policePayload(
  p: LlmElementProposal,
  kind: GraphicsElementKind,
  sceneNo: number,
  subject: string,
  dropped: DroppedProposal[],
): Partial<GraphicsElement> | null {
  switch (kind) {
    case "headline":
    case "subhead":
    case "bullet": {
      const text = str(p.text).trim();
      if (text === "") {
        dropped.push({ scene: sceneNo, subject, reason: `${kind} requires a non-empty "text"` });
        return null;
      }
      const tp: TextPayload = { text };
      const sizePx = num(p.sizePx);
      if (Number.isFinite(sizePx)) tp.sizePx = Math.round(clampNum(sizePx, 12, 288));
      const weight = num(p.weight);
      if (Number.isFinite(weight)) tp.weight = Math.round(clampNum(weight, 100, 900));
      const color = str(p.color).trim();
      if (HEX_RE.test(color)) tp.color = color.toLowerCase();
      const align = str(p.align).trim();
      if (TEXT_ALIGN_SET.has(align)) tp.align = align as "left" | "center" | "right";
      const out: Partial<GraphicsElement> = { text: tp };
      return out;
    }
    case "counter": {
      const from = num(p.from);
      const to = num(p.to);
      if (!Number.isFinite(from) || !Number.isFinite(to)) {
        dropped.push({ scene: sceneNo, subject, reason: "counter requires finite from/to" });
        return null;
      }
      if (from >= to) {
        dropped.push({ scene: sceneNo, subject, reason: `counter from (${from}) must be < to (${to}) — the v1 count-up law` });
        return null;
      }
      const cp: CounterPayload = { from, to };
      const unit = str(p.unit);
      if (unit !== "") cp.unit = unit.slice(0, 12);
      const decimals = num(p.decimals);
      if (decimals === 0 || decimals === 1 || decimals === 2) cp.decimals = decimals;
      const out: Partial<GraphicsElement> = { counter: cp };
      return out;
    }
    case "bar":
    case "barChart": {
      const rows = Array.isArray(p.data) ? p.data : [];
      if (rows.length === 0) {
        dropped.push({ scene: sceneNo, subject, reason: `${kind} requires a "data" array` });
        return null;
      }
      const data: BarDatum[] = [];
      for (let i = 0; i < Math.min(rows.length, GRAPHICS_BUDGETS.barDataMax); i++) {
        const row = (rows[i] ?? {}) as Record<string, unknown>;
        const label = str(row.label).trim();
        const value = num(row.value);
        if (label === "" || !Number.isFinite(value) || value < 0) {
          dropped.push({ scene: sceneNo, subject: `${subject} row ${i + 1}`, reason: "bar rows require a non-empty label and a finite value ≥ 0" });
          continue;
        }
        data.push({ label, value });
      }
      for (let i = GRAPHICS_BUDGETS.barDataMax; i < rows.length; i++) {
        dropped.push({ scene: sceneNo, subject: `${subject} row ${i + 1}`, reason: `over the barDataMax wall (${GRAPHICS_BUDGETS.barDataMax})` });
      }
      if (data.length === 0) {
        dropped.push({ scene: sceneNo, subject, reason: "every bar row was dropped — no usable data" });
        return null;
      }
      const bp: BarPayload = { data };
      const unit = str(p.unit);
      if (unit !== "") bp.unit = unit.slice(0, 12);
      const max = num(p.max);
      if (Number.isFinite(max) && max > 0) bp.max = max;
      if (typeof p.horizontal === "boolean") bp.horizontal = p.horizontal;
      const out: Partial<GraphicsElement> = { bar: bp };
      return out;
    }
    case "icon": {
      const iconId = str(p.iconId).trim();
      let paths: string[] = [];
      const entry = GRAPHICS_ICON_LIBRARY[iconId];
      if (iconId !== "" && entry !== undefined) {
        paths = [...entry.paths];
      } else {
        if (iconId !== "") {
          dropped.push({ scene: sceneNo, subject, reason: `iconId "${iconId.slice(0, 32)}" is not in the icon library` });
        }
        const rawPaths = Array.isArray(p.paths) ? p.paths : [];
        for (let i = 0; i < Math.min(rawPaths.length, GRAPHICS_PLANNER_ICON_PATHS); i++) {
          const d = str(rawPaths[i]).trim();
          if (d === "") {
            dropped.push({ scene: sceneNo, subject: `${subject} path ${i + 1}`, reason: "icon paths must be non-empty path-data strings" });
            continue;
          }
          const commands = countPathCommands(d);
          if (commands === 0) {
            dropped.push({ scene: sceneNo, subject: `${subject} path ${i + 1}`, reason: `icon path does not parse — "${d.slice(0, 32)}"` });
            continue;
          }
          if (commands > GRAPHICS_BUDGETS.iconPathCommandBudget) {
            dropped.push({
              scene: sceneNo,
              subject: `${subject} path ${i + 1}`,
              reason: `icon path with ${commands} commands exceeds the iconPathCommandBudget wall (${GRAPHICS_BUDGETS.iconPathCommandBudget})`,
            });
            continue;
          }
          paths.push(d);
        }
        for (let i = GRAPHICS_PLANNER_ICON_PATHS; i < rawPaths.length; i++) {
          dropped.push({ scene: sceneNo, subject: `${subject} path ${i + 1}`, reason: `over the ${GRAPHICS_PLANNER_ICON_PATHS}-paths-per-icon planner cap` });
        }
      }
      if (paths.length === 0) {
        dropped.push({ scene: sceneNo, subject, reason: "no usable icon paths survived — pick an iconId from the library or provide parsable paths" });
        return null;
      }
      const ip: IconPayload = { paths };
      const color = str(p.color).trim();
      if (HEX_RE.test(color)) ip.color = color.toLowerCase();
      const sw = num(p.strokeWidth);
      if (Number.isFinite(sw) && sw > 0) ip.strokeWidth = Math.min(sw, 64);
      const out: Partial<GraphicsElement> = { icon: ip };
      return out;
    }
    case "callout": {
      const text = str(p.text).trim();
      if (text === "") {
        dropped.push({ scene: sceneNo, subject, reason: "callout requires a non-empty \"text\"" });
        return null;
      }
      const cp: CalloutPayload = { text };
      const pa = p.pointsAt;
      if (typeof pa === "object" && pa !== null && !Array.isArray(pa)) {
        const px = num((pa as Record<string, unknown>).x);
        const py = num((pa as Record<string, unknown>).y);
        if (Number.isFinite(px) && Number.isFinite(py)) cp.pointsAt = { x: px, y: py };
      }
      const out: Partial<GraphicsElement> = { callout: cp };
      return out;
    }
    case "shape": {
      const shapeKind = str(p.shape).trim();
      if (shapeKind !== "rect" && shapeKind !== "line" && shapeKind !== "circle") {
        dropped.push({ scene: sceneNo, subject, reason: `shape kind must be rect|line|circle — got "${shapeKind.slice(0, 32)}"` });
        return null;
      }
      const sp: ShapePayload = { kind: shapeKind };
      for (const field of ["w", "h", "r"] as const) {
        const v = num(p[field]);
        if (Number.isFinite(v) && v > 0) sp[field] = v;
      }
      const stroke = str(p.stroke).trim();
      if (HEX_RE.test(stroke)) sp.stroke = stroke.toLowerCase();
      const fill = str(p.fill).trim();
      if (HEX_RE.test(fill)) sp.fill = fill.toLowerCase();
      const sw = num(p.strokeWidth);
      if (Number.isFinite(sw) && sw > 0) sp.strokeWidth = Math.min(sw, 64);
      const out: Partial<GraphicsElement> = { shape: sp };
      return out;
    }
    case "group": {
      // Group police runs AFTER the scene's other elements are accepted —
      // handled by the caller (it needs the accepted-id set). Reachable
      // only through that path.
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Normalization — the per-element degradation
// ---------------------------------------------------------------------------

/**
 * Normalize the model's raw scene plans against the REAL grammar: the
 * story's scene set, the closed element/motion sets, the compatibility
 * table, the id law, the per-scene cap, the bar/icon walls, and the
 * scene clock. PURE — unit-pinned. A scene with at least one surviving
 * element is SERVED; everything else falls back to the native rule
 * table.
 */
export function normalizeGraphicsProposals(
  raw: LlmGraphicsScenePlan[],
  ctx: {
    scenes: GraphicsSceneInput[];
    width: number;
    height: number;
    maxElementsPerScene?: number;
  },
): {
  served: Map<number, NormalizedGraphicsScene>;
  fallback: number[];
  dropped: DroppedProposal[];
} {
  const maxElements = ctx.maxElementsPerScene ?? GRAPHICS_PLANNER_ELEMENTS_PER_SCENE;
  const storyIndexes = new Set(ctx.scenes.map((s) => s.index));
  const dropped: DroppedProposal[] = [];

  // Merge rows that repeat a scene number.
  const byScene = new Map<number, LlmElementProposal[]>();
  for (const row of raw) {
    const sceneNo = Number(row?.scene);
    if (!Number.isInteger(sceneNo) || !storyIndexes.has(sceneNo)) {
      dropped.push({
        scene: Number.isInteger(sceneNo) ? sceneNo : 0,
        subject: "(scene)",
        reason: "scene number outside the story",
      });
      continue;
    }
    const bucket = byScene.get(sceneNo) ?? [];
    const elements = Array.isArray(row?.elements) ? row.elements : [];
    for (const e of elements) bucket.push(e as LlmElementProposal);
    byScene.set(sceneNo, bucket);
  }

  const served = new Map<number, NormalizedGraphicsScene>();
  for (const [sceneNo, proposals] of byScene) {
    const storyScene = ctx.scenes.find((s) => s.index === sceneNo);
    if (storyScene === undefined) continue;
    const clockMs = estimateNarrationMs(storyScene.narration);
    const elements: GraphicsElement[] = [];
    const usedIds = new Set<string>();
    const perKind = new Map<GraphicsElementKind, number>();

    for (let pi = 0; pi < proposals.length; pi++) {
      const p = (proposals[pi] ?? {}) as LlmElementProposal;
      if (elements.length >= maxElements) {
        dropped.push({
          scene: sceneNo,
          subject: str(p.kind).trim() || "(element)",
          reason: `over the ${maxElements}-elements-per-scene planner cap`,
        });
        continue;
      }
      const kind = str(p.kind).trim() as GraphicsElementKind;
      if (!(GRAPHICS_ELEMENT_KIND_SET as ReadonlySet<string>).has(kind)) {
        dropped.push({ scene: sceneNo, subject: str(p.kind).trim() || "(element)", reason: `unknown element kind "${str(p.kind).trim().slice(0, 32)}" (the v1 set is closed)` });
        continue;
      }

      const perKindCount = perKind.get(kind) ?? 0;
      const id = policeId(p.id, kind, usedIds, perKindCount);
      const subject = `${kind}#${id}`;

      // Groups police against the scene's ALREADY-ACCEPTED elements
      // (referential integrity the validator would otherwise error on).
      if (kind === "group") {
        const childIds = Array.isArray(p.children) ? p.children : [];
        const children: string[] = [];
        const claimed = new Set<string>();
        for (let ci = 0; ci < childIds.length; ci++) {
          const childId = str(childIds[ci]).trim();
          if (childId === "") {
            dropped.push({ scene: sceneNo, subject: `${subject} child ${ci + 1}`, reason: "group children must be element ids" });
            continue;
          }
          const target = elements.find((e) => e.id === childId);
          if (target === undefined) {
            dropped.push({ scene: sceneNo, subject: `${subject} child ${ci + 1}`, reason: `group child "${childId.slice(0, 40)}" is not an accepted element of this scene` });
            continue;
          }
          if (target.kind === "group") {
            dropped.push({ scene: sceneNo, subject: `${subject} child ${ci + 1}`, reason: `group child "${childId.slice(0, 40)}" is itself a group — v1 groups do not nest` });
            continue;
          }
          if (claimed.has(childId)) {
            dropped.push({ scene: sceneNo, subject: `${subject} child ${ci + 1}`, reason: `group child "${childId.slice(0, 40)}" claimed twice` });
            continue;
          }
          claimed.add(childId);
          children.push(childId);
        }
        if (children.length === 0) {
          dropped.push({ scene: sceneNo, subject, reason: "no valid children survived — the group died" });
          continue;
        }
        const enter = policeMotion(p.enter, kind, "enter", clockMs, perKindCount, dropped, sceneNo, subject);
        if (enter === null) continue; // enter is REQUIRED — the group dies
        usedIds.add(id);
        perKind.set(kind, perKindCount + 1);
        elements.push({ id, kind, at: policePlacement(undefined, kind, ctx.width, ctx.height), enter, group: { children } });
        continue;
      }

      const payload = policePayload(p, kind, sceneNo, subject, dropped);
      if (payload === null) continue;

      const enter = policeMotion(p.enter, kind, "enter", clockMs, perKindCount, dropped, sceneNo, subject);
      if (enter === null) continue; // the element dies with its enter

      const exit = policeMotion(p.exit, kind, "exit", clockMs, perKindCount, dropped, sceneNo, subject);
      const emphasis = policeMotion(p.emphasis, kind, "emphasis", clockMs, perKindCount, dropped, sceneNo, subject);

      const el: GraphicsElement = { id, kind, at: policePlacement(p, kind, ctx.width, ctx.height), enter, ...payload };
      if (exit !== null) el.exit = exit;
      if (emphasis !== null) el.emphasis = emphasis;
      const opacity = num(p.opacity);
      if (Number.isFinite(opacity)) el.opacity = Math.round(clampNum(opacity, 0, 1) * 100) / 100;

      usedIds.add(id);
      perKind.set(kind, perKindCount + 1);
      elements.push(el);
    }

    if (elements.length > 0) served.set(sceneNo, { sceneIndex: sceneNo, elements });
  }

  const fallback = ctx.scenes
    .map((s) => s.index)
    .filter((idx) => !served.has(idx))
    .sort((a, b) => a - b);
  return { served, fallback, dropped };
}

// ---------------------------------------------------------------------------
// Composition — swap the served scenes' elements into the native base
// ---------------------------------------------------------------------------

/**
 * Compose the LLM doc from the native base: for every SERVED scene, keep
 * the scene's identity (id, narration, background, explicit duration)
 * and replace its elements with the normalized ones; unserved scenes
 * pass through byte-identical (the native rule table's work). PURE —
 * never mutates the native doc.
 */
export function composeGraphicsDoc(
  native: GraphicsDoc,
  scenes: GraphicsSceneInput[],
  served: Map<number, NormalizedGraphicsScene>,
): GraphicsDoc {
  const out: GraphicsScene[] = native.scenes.map((scene, i) => {
    const plan = served.get(scenes[i]?.index ?? -1);
    if (plan === undefined) return scene; // untouched — the native fallback scene
    return { ...scene, elements: plan.elements };
  });
  return { ...native, scenes: out };
}

// ---------------------------------------------------------------------------
// The prompts
// ---------------------------------------------------------------------------

const MOTION_MENU_LINES = [
  "- headline / subhead / bullet / callout / group: enter fade | rise | slide | pop",
  "- counter: fade | rise | slide | pop | count (count = the number tween)",
  "- bar / barChart: fade | slide | wipe | grow",
  "- icon: fade | slide | pop | draw (draw = the stroke draws on)",
  "- shape: fade | slide | wipe | grow | draw",
].join("\n");

const PLANNER_SYSTEM_PROMPT = `You are a motion-graphics storyboard planner. You read a video's story scenes and design the ON-SCREEN GRAPHICS for each one as a list of elements, using a fixed grammar. Output STRICT JSON only:

{
  "scenes": [
    { "scene": 1, "elements": [
      { "kind": "headline", "text": "Big idea", "x": 960, "y": 400, "sizePx": 64, "enter": { "kind": "rise", "durationMs": 600, "delayMs": 0, "ease": "ease-back" } },
      { "kind": "counter", "from": 0, "to": 87, "unit": "%", "x": 960, "y": 470 },
      { "kind": "barChart", "data": [ { "label": "2023", "value": 42 }, { "label": "2024", "value": 87 } ], "x": 960, "y": 620 },
      { "kind": "icon", "iconId": "arrow-up", "x": 960, "y": 300 }
    ] }
  ]
}

Element kinds (closed set): headline, subhead, bullet, counter, barChart, icon, callout, shape, group.
- headline/subhead/bullet/callout REQUIRE a non-empty "text" (bullet/callout ≤ 120 chars).
- counter REQUIRES finite "from" and "to" with from < to (it counts up); optional "unit" (short) and "decimals" (0|1|2).
- barChart REQUIRES "data": 1-5 rows of { "label", "value" } — value finite ≥ 0. Use ONLY numbers the scene's narration actually supports.
- icon: "iconId" MUST be one of the library ids you were given (preferred), or raw "paths" (SVG path d strings).
- callout: optional "pointsAt": { "x", "y" } the tail points to.
- shape: "shape": "rect" | "line" | "circle", optional w/h/r, stroke, fill (#rrggbb).
- group: "children" = ids of elements in the SAME scene (groups do not nest).
Every element REQUIRES an "enter" motion: { "kind", "durationMs", "delayMs", "ease" }. Motion legality per kind:
${MOTION_MENU_LINES}
"ease" is one of: linear, ease-in-out, ease-out, pop, ease-back. durationMs 200-2000, delayMs ≥ 0 — keep every motion INSIDE the scene's runtime (you were told each scene's estimated seconds).
x/y are scene-space centers on the board you were told about; scale 0.2-4, rotateDeg -180..180. Optional "opacity" 0-1, optional "exit" and "emphasis" motions (same rules).
Rules: "scene" is the story scene number you were given. At most 6 elements per scene — prefer fewer, larger, readable pieces. Never repeat an id within a scene. Serve EVERY scene. Keep all text verbatim-faithful to the story — never invent facts or numbers. Never wrap in markdown fences. Never add commentary.`;

function plannerUserPrompt(
  input: { topic: string; scenes: GraphicsSceneInput[] },
  width: number,
  height: number,
): string {
  const sceneLines = input.scenes
    .map((s) => {
      const sec = Math.round(estimateNarrationMs(s.narration) / 100) / 10;
      return `scene ${s.index} (about ${sec}s) — ${s.title ? `${s.title}: ` : ""}${s.narration.slice(0, 600)}`;
    })
    .join("\n");
  const iconLines = Object.entries(GRAPHICS_ICON_LIBRARY)
    .map(([id, icon]) => `- ${id} (${icon.tags.join(", ")})`)
    .join("\n");
  return [
    `Topic: ${input.topic}`,
    `Board: ${width} x ${height} (x/y are scene-space centers)`,
    "",
    "Icon library (iconId — meaning tags):",
    iconLines,
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

export interface GraphicsLlmPlannerReport {
  /** "llm" when the model served at least one scene; "native" when the
   *  whole doc degraded to the rule table. The honest label. */
  planner: "llm" | "native";
  /** Scenes the LLM served with at least one valid element. */
  servedScenes: number;
  /** Story scene indexes served by the native rule table instead. */
  fallbackScenes: number[];
  /** Proposals dropped in normalization, each with its reason. */
  dropped: DroppedProposal[];
  /** True when the LLM round-trip failed entirely — the doc is the
   *  NATIVE scaffold, labeled here, never presented as model work. */
  degraded: boolean;
  degradeReason?: string;
}

/** aiCallJson's validate: lenient about content (normalization polices),
 *  strict about structure — throws (→ one fresh generation) only when
 *  the reply carries no usable scene rows at all. */
function validateScenePlans(parsed: Record<string, unknown>): LlmGraphicsScenePlan[] {
  const rows = Array.isArray(parsed.scenes) ? parsed.scenes : null;
  if (rows === null) throw new Error("the planner reply has no scenes array");
  const out: LlmGraphicsScenePlan[] = [];
  for (const r of rows) {
    const row = (r ?? {}) as Record<string, unknown>;
    const scene = Number(row.scene);
    if (!Number.isInteger(scene)) continue;
    const elements = Array.isArray(row.elements) ? (row.elements as unknown[]) : [];
    out.push({ scene, elements: elements as LlmElementProposal[] });
  }
  if (out.length === 0) throw new Error("the planner reply carried no usable scene rows");
  return out;
}

/**
 * The G1 phase-2 scaffold. The deterministic base ALWAYS stands (built
 * first, surface-snapped geometry, rule-table archetypes, native motion
 * defaults); the LLM round-trip then swaps elements per served scene.
 * Any failure — gateway down, quota blocked, malformed reply after its
 * retry, an empty normalization — degrades to the native scaffold with
 * the reason in the report, BYTE-IDENTICAL to what the native planner
 * builds alone. `opts.ask` / `opts.call` are the fake-driven unit-test
 * seams, exactly the whiteboard planner's injection discipline.
 */
export async function scaffoldGraphicsDocLlm(
  input: {
    scenes: GraphicsSceneInput[];
    topic: string;
    width?: number;
    height?: number;
    fps?: number;
  },
  opts: { ask?: () => Promise<string>; call?: PlannerCall } = {},
): Promise<{ doc: GraphicsDoc; report: GraphicsLlmPlannerReport }> {
  // The deterministic base — surface snapping lives here, so the prompt
  // and the normalization both use the EXACT board the doc will carry.
  const native = scaffoldGraphicsDoc(input);
  const allFallback = input.scenes.map((s) => s.index);
  const degrade = (reason: string): { doc: GraphicsDoc; report: GraphicsLlmPlannerReport } => ({
    doc: native,
    report: {
      planner: "native",
      servedScenes: 0,
      fallbackScenes: allFallback,
      dropped: [],
      degraded: true,
      degradeReason: reason.slice(0, 300),
    },
  });

  const ask =
    opts.ask ??
    (async () => {
      const completion = await llmChat({
        messages: [
          { role: "system", content: PLANNER_SYSTEM_PROMPT },
          { role: "user", content: plannerUserPrompt(input, native.width, native.height) },
        ],
        temperature: 0.3,
      });
      return completion.choices?.[0]?.message?.content ?? "";
    });

  try {
    const raw = await aiCallJson<LlmGraphicsScenePlan[]>("llm", "graphics llm planner", ask, {
      validate: validateScenePlans,
      retry: { attempts: 2, baseDelayMs: 1500 },
      ...(opts.call ? { call: opts.call } : {}),
    });
    const { served, fallback, dropped } = normalizeGraphicsProposals(raw, {
      scenes: input.scenes,
      width: native.width,
      height: native.height,
    });
    if (served.size === 0) {
      return degrade("every element was dropped in normalization — no scene was servable");
    }
    const doc = composeGraphicsDoc(native, input.scenes, served);
    return {
      doc,
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
