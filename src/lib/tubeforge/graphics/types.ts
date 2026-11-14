// G1.1 — the motion-graphics doc contract + validator (S120 §5 / the
// reconciliation roadmap §5). Drafted externally (Part F), landed here as
// the first code commit of G1.
//
// THE HOUSE DOC LAWS (S88's, verbatim — the Scene3D precedent):
// versioned (an unknown version reads as absent and is never
// overwritten), tolerant parse (null on unreadable — junk fields fall
// back honestly), strict write (exactly the declared fields, version
// first), byte-stable round-trip.
//
// The v1 element set is CLOSED (risk register row 5: grammar sprawl is
// G1's named risk — new element variants require a design-doc slice,
// never a drive-by union member). The motion/element compatibility table
// below is the grammar's enforcement surface — closed like the kind set.
//
// PURE — no fs, no DOM, no clock, no randomness (the S64 law
// generalizes); the composer (G1.3) and the render engine (G1.5) own the
// side effects. Leaf-module law: this file imports the anim/ substrate
// (Stage S) and two whiteboard siblings (svg, timing) — never the
// reverse.
//
// Validator split (the whiteboard's own shape — validate integrity once,
// schedule purely everywhere else):
//   errors   → structural nonsense: unreadable version shape, missing
//              scenes, id-law violations, named-wall violations, broken
//              payload shapes for a KNOWN kind, motion/element
//              incompatibility, group integrity. `doc` comes back null.
//   warnings → unknown-but-harmless extras a v1 reader drops on read:
//              unknown element kinds, unknown fields, v-next versions,
//              junk OPTIONAL fields (dropped — absent stays absent), a
//              payload absent for a kind that has one (the composer
//              falls back; parse never refuses — the Part F law).
//   clamps   → present-and-numeric values outside a named range are
//              clamped to it, with a warning (scene3d's clamp law, now
//              with a channel to say so).
import { countPathCommands, type Placement } from "../whiteboard/svg";
import { ANIM_FRAME_BUDGET } from "../anim/clock";
import { isEaseName, type EaseName } from "../anim/easing";
import { estimateNarrationMs } from "../whiteboard/timing";

// ---------------------------------------------------------------------------
// Version + id law
// ---------------------------------------------------------------------------

export const GRAPHICS_VERSION = 1;

/** Legal element/scene id — the whiteboard's id-charset law verbatim
 *  (WB_ID_RE + the separator ban, storyboard.ts): ids ride
 *  DOM-namespace-shaped keys; a `--` or `::` inside an id corrupts that
 *  seam (the storyboard defense-in-depth receipt applies to graphics ids
 *  as-is). */
export const GRAPHICS_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

export function validGraphicsId(id: string): boolean {
  return GRAPHICS_ID_RE.test(id) && !id.includes("--") && !id.includes("::");
}

// ---------------------------------------------------------------------------
// Stage-S aliases — ONE wall, TWO engines (the Part G.3 resolution)
// ---------------------------------------------------------------------------

/** The anim/easing.ts curve table (Stage S / commit G1.0) — re-exported
 *  under the graphics name so the grammar reads standalone; the TYPE is
 *  the same union, the runtime check delegates to `isEaseName` (one
 *  source of curve truth). */
export type GraphicsEase = EaseName;

/** THE shared frame-budget wall (anim/clock.ts, Stage S) — one wall, two
 *  engines. 25,920 frames = 18 min at 24 fps; the render pre-flight
 *  (G1.5) refuses over-budget docs BEFORE chromium launches. Re-exported
 *  (not re-declared) so a budget change lands once. */
export const GRAPHICS_FRAME_BUDGET = ANIM_FRAME_BUDGET;

// ---------------------------------------------------------------------------
// Motion grammar
// ---------------------------------------------------------------------------

export const GRAPHICS_MOTION_KINDS = [
  "fade", "rise", "slide", "pop", "wipe", "count", "grow", "draw",
] as const;
export type GraphicsMotionKind = (typeof GRAPHICS_MOTION_KINDS)[number];

export interface ElementMotion {
  kind: GraphicsMotionKind;
  /** > 0, validator-pinned. */
  durationMs: number;
  /** ≥ 0, validator-pinned. */
  delayMs: number;
  ease: GraphicsEase;
}

export const GRAPHICS_ELEMENT_KINDS = [
  "headline", "subhead", "bullet", "counter", "bar", "barChart",
  "icon", "callout", "shape", "group",
] as const;
export type GraphicsElementKind = (typeof GRAPHICS_ELEMENT_KINDS)[number];

/** Which motions are legal per element kind — the compatibility table the
 *  validator enforces (a "count" on a headline is a doc bug, not a
 *  renderer branch; a "draw" on a text element has no stroke to draw).
 *  The table IS the grammar's enforcement surface — closed like the kind
 *  set. */
export const MOTION_KINDS_BY_ELEMENT: Readonly<
  Record<GraphicsElementKind, readonly GraphicsMotionKind[]>
> = {
  headline: ["fade", "rise", "slide", "pop"],
  subhead:  ["fade", "rise", "slide", "pop"],
  bullet:   ["fade", "rise", "slide", "pop"],
  counter:  ["fade", "rise", "slide", "pop", "count"],
  bar:      ["fade", "slide", "wipe", "grow"],
  barChart: ["fade", "slide", "wipe", "grow"],
  icon:     ["fade", "slide", "pop", "draw"],
  callout:  ["fade", "rise", "slide", "pop"],
  shape:    ["fade", "slide", "wipe", "grow", "draw"],
  group:    ["fade", "rise", "slide", "pop"],
};

/** Runtime lookup with the closed-table guarantee restated (the Record is
 *  compile-total; the fallback exists only for the type checker's
 *  indexed access). */
export function legalMotions(kind: GraphicsElementKind): readonly GraphicsMotionKind[] {
  return MOTION_KINDS_BY_ELEMENT[kind] ?? GRAPHICS_MOTION_KINDS;
}

// ---------------------------------------------------------------------------
// Element payloads — one optional payload per kind (the Scene3D flat
// shape): the validator enforces payload-per-kind; tolerant parse never
// refuses on an absent payload for a kind that has one.
// ---------------------------------------------------------------------------

export interface TextPayload {
  text: string;
  /** default 48 at compose, clamped 12..288 by the validator. */
  sizePx?: number;
  /** 100..900, default 700 at compose; clamped by the validator. */
  weight?: number;
  /** #rrggbb. */
  color?: string;
  align?: "left" | "center" | "right";
}

export interface CounterPayload {
  /** finite; from < to enforced (the v1 count-up law — a count-down is a
   *  design-doc slice, not a drive-by sign flip). */
  from: number;
  /** finite. */
  to: number;
  /** "%", "×", "k" … rendered after the number. */
  unit?: string;
  decimals?: 0 | 1 | 2;
}

export interface BarDatum { label: string; value: number; } // value finite, ≥ 0

export interface BarPayload {
  /** 1..GRAPHICS_BUDGETS.barDataMax rows. */
  data: BarDatum[];
  unit?: string;
  /** scale ceiling; absent ⇒ max(data) at compose. */
  max?: number;
  /** default false. */
  horizontal?: boolean;
}

export interface IconPayload {
  /** SVG path `d` strings — parsed (command budget; countPathCommands is
   *  the unit of account) at validation; sanitized at compose time (G1.3,
   *  svg.ts#sanitizeSvg). */
  paths: string[];
  color?: string;
  strokeWidth?: number;
}

export interface CalloutPayload {
  text: string;
  /** scene units — the tail's target. */
  pointsAt?: { x: number; y: number };
}

export interface ShapePayload {
  kind: "rect" | "line" | "circle";
  w?: number;  // rect / line extent
  h?: number;  // rect
  r?: number;  // circle
  stroke?: string;
  fill?: string;
  strokeWidth?: number;
}

export interface GroupPayload {
  /** Member element ids — must exist, must not reference the group itself
   *  or an ancestor (acyclic); v1: groups do not nest (the groupDepthMax
   *  wall — which also makes reference cycles unreachable by
   *  construction). */
  children: string[];
}

export interface GraphicsElement {
  id: string;
  kind: GraphicsElementKind;
  /** Scene-space placement — the whiteboard's Placement (svg.ts): one
   *  placement shape across engines, never a second one. Junk/absent
   *  falls back honestly to the origin placement (the scene3d position
   *  law) with a warning. */
  at: Placement;
  /** The payload for `kind` (typed above); validator checks presence +
   *  shape per kind. */
  text?: TextPayload;
  counter?: CounterPayload;
  bar?: BarPayload;
  icon?: IconPayload;
  callout?: CalloutPayload;
  shape?: ShapePayload;
  group?: GroupPayload;
  /** Choreography: enter is REQUIRED (an element that cannot enter has
   *  no reason to exist in this grammar); exit/emphasis optional. The
   *  frame engine composes with fixed precedence emphasis > exit > enter
   *  (G1.2's pin). */
  enter: ElementMotion;
  exit?: ElementMotion;
  emphasis?: ElementMotion;
  /** base opacity 0..1, default 1 at compose; clamped by the validator. */
  opacity?: number;
}

// ---------------------------------------------------------------------------
// Scene + doc
// ---------------------------------------------------------------------------

export interface GraphicsScene {
  id: string;
  narration: string;
  /** Explicit clock override; absent ⇒ the house 2.6-wps estimate
   *  (whiteboard timing.ts estimateNarrationMs — ONE clock model, reused,
   *  not re-implemented). VO-measured duration rides the render call, not
   *  the doc (the anchors-are-inputs law, same as W4). */
  durationMs?: number;
  /** #rrggbb — a designed choice: junk is an ERROR, never silently
   *  substituted (unlike optional palette fields, which drop honestly). */
  background: string;
  elements: GraphicsElement[];
}

export interface GraphicsDoc {
  /** GRAPHICS_VERSION — first field on write (strict write). */
  version: number;
  title: string;
  /** Output surface — one of the three house aspects' native sizes:
   *  1920×1080 (16:9), 1080×1920 (9:16), 1080×1080 (1:1). */
  width: number;
  height: number;
  fps: 24 | 30;
  scenes: GraphicsScene[];
}

// ---------------------------------------------------------------------------
// Named walls — the WB_BUDGETS shape (storyboard.ts): constants cited by
// the validator, the tests, and the design doc — ONE source. Values are
// the implementer's receipts to tune; the NAMES are the contract.
// ---------------------------------------------------------------------------

export const GRAPHICS_BUDGETS = {
  /** Max elements per scene (counted on the KEPT set — what the v1 reader
   *  will actually render; v-next drops land before the wall, so a v-next
   *  doc is never refused for elements its v1 reader cannot see). */
  elementsPerScene: 32,
  /** Max scenes per project (the whiteboard's number). */
  scenesPerProject: 24,
  /** Max EXPLICIT scene duration (estimates clamp lower — the timing
   *  law's 4s..30s band). */
  sceneDurationMsMax: 120_000,
  /** Max Σ explicit scene durations (VO-measured totals are bounded at
   *  the render pre-flight by GRAPHICS_FRAME_BUDGET instead). */
  projectExplicitDurationMsMax: 900_000,
  /** Max data rows per bar/barChart. */
  barDataMax: 8,
  /** v1: groups do not nest (which also makes reference cycles
   *  unreachable by construction). */
  groupDepthMax: 1,
  /** Parsed command budget per icon path — countPathCommands is the unit
   *  of account (the EXPANDED count: implicit repeats cost what the
   *  flattener and the rasterizer pay). The WB_PATH_COMMAND_BUDGET
   *  number. */
  iconPathCommandBudget: 512,
} as const;

/** Borrowed readable-ink wall (the whiteboard's WB_STROKE_WIDTH_MAX
 *  number): a wider icon/shape stroke stops tracking the aesthetic.
 *  Module-private — a validator detail, not a grammar wall. */
const STROKE_WIDTH_MAX = 64;

// ---------------------------------------------------------------------------
// The result shape
// ---------------------------------------------------------------------------

export interface GraphicsValidationResult {
  doc: GraphicsDoc | null;
  /** Structural nonsense — the doc did not parse (doc is null). */
  errors: string[];
  /** Tolerant-read notes: unknown element kinds / unknown fields / unknown
   *  version / junk optional fields dropped / clamps applied — the doc
   *  still parses, the notes explain what was ignored (the additive-parse
   *  law: v-next docs load in v1 readers). */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Parsing helpers (module-private, pure)
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;

const isObj = (v: unknown): v is Rec =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** The declared element keys — anything else on a known element is an
 *  unknown field (warning + dropped). */
const ELEMENT_KEYS = new Set([
  "id", "kind", "at", "text", "counter", "bar", "icon", "callout",
  "shape", "group", "enter", "exit", "emphasis", "opacity",
]);

const DOC_KEYS = new Set(["version", "title", "width", "height", "fps", "scenes"]);
const SCENE_KEYS = new Set(["id", "narration", "durationMs", "background", "elements"]);

const TEXT_PAYLOAD_KEYS = new Set(["text", "sizePx", "weight", "color", "align"]);
const COUNTER_PAYLOAD_KEYS = new Set(["from", "to", "unit", "decimals"]);
const BAR_PAYLOAD_KEYS = new Set(["data", "unit", "max", "horizontal"]);
const ICON_PAYLOAD_KEYS = new Set(["paths", "color", "strokeWidth"]);
const CALLOUT_PAYLOAD_KEYS = new Set(["text", "pointsAt"]);
const SHAPE_PAYLOAD_KEYS = new Set(["kind", "w", "h", "r", "stroke", "fill", "strokeWidth"]);
const GROUP_PAYLOAD_KEYS = new Set(["children"]);

/** The output-surface law: exactly the three house aspects' native sizes. */
const SURFACES: ReadonlyArray<readonly [number, number]> = [
  [1920, 1080], // 16:9
  [1080, 1920], // 9:16
  [1080, 1080], // 1:1
];

function warnUnknownKeys(raw: Rec, declared: ReadonlySet<string>, where: string, warnings: string[]): void {
  for (const key of Object.keys(raw)) {
    if (!declared.has(key)) warnings.push(`${where}: unknown field "${key}" ignored`);
  }
}

/** Optional color: junk drops honestly with a warning; well-formed hex
 *  lowers (the scene3d hex law). */
function parseColor(raw: unknown, where: string, field: string, warnings: string[]): string | undefined {
  const s = str(raw);
  if (s === null) {
    if (raw !== undefined) warnings.push(`${where}: ${field} dropped — not a string`);
    return undefined;
  }
  if (!HEX_RE.test(s)) {
    warnings.push(`${where}: ${field} dropped — not #rrggbb`);
    return undefined;
  }
  return s.toLowerCase();
}

function parseStrokeWidth(raw: unknown, where: string, warnings: string[]): number | undefined {
  const v = num(raw);
  if (v === null) {
    if (raw !== undefined) warnings.push(`${where}: strokeWidth dropped — not a finite number`);
    return undefined;
  }
  if (v <= 0) {
    warnings.push(`${where}: strokeWidth dropped — must be > 0`);
    return undefined;
  }
  if (v > STROKE_WIDTH_MAX) {
    warnings.push(`${where}: strokeWidth ${v} clamped to ${STROKE_WIDTH_MAX} (the readable-ink wall)`);
    return STROKE_WIDTH_MAX;
  }
  return v;
}

/** Placement — the whiteboard shape, four finite numbers. Absent/junk
 *  falls back honestly to the origin placement (the scene3d position
 *  law) with a warning; readable members are kept, the rest defaulted. */
function parsePlacement(raw: unknown, where: string, warnings: string[]): Placement {
  if (!isObj(raw)) {
    if (raw !== undefined) warnings.push(`${where}: "at" unreadable — origin placement assumed`);
    return { x: 0, y: 0, scale: 1, rotateDeg: 0 };
  }
  const x = num(raw.x);
  const y = num(raw.y);
  const scale = num(raw.scale);
  const rotateDeg = num(raw.rotateDeg);
  if (x === null || y === null || scale === null || rotateDeg === null) {
    warnings.push(`${where}: "at" has unreadable members — kept what reads, defaulted the rest`);
  }
  return {
    x: x ?? 0,
    y: y ?? 0,
    scale: scale !== null && scale > 0 ? scale : 1,
    rotateDeg: rotateDeg ?? 0,
  };
}

/** Motion parse. `required=true` is the enter slot (an unreadable enter is
 *  structural); optional slots (exit/emphasis) drop honestly with a
 *  warning. */
function parseMotion(
  raw: unknown,
  where: string,
  slot: string,
  warnings: string[],
  errors: string[],
  required: boolean,
): ElementMotion | null {
  if (raw === undefined) return null;
  const reject = (msg: string): null => {
    if (required) errors.push(`${where}: the ${slot} motion is unreadable — ${msg}`);
    else warnings.push(`${where}: ${slot} motion dropped — ${msg}`);
    return null;
  };
  if (!isObj(raw)) return reject("not an object");
  const kind = str(raw.kind);
  if (kind === null || !GRAPHICS_MOTION_KINDS.includes(kind as GraphicsMotionKind)) {
    return reject(`kind "${String(raw.kind)}" is not in the closed motion set`);
  }
  const durationMs = num(raw.durationMs);
  if (durationMs === null || durationMs <= 0) return reject("durationMs must be finite > 0");
  const delayMs = num(raw.delayMs);
  if (delayMs === null || delayMs < 0) return reject("delayMs must be finite ≥ 0");
  const ease = str(raw.ease);
  if (ease === null || !isEaseName(ease)) return reject(`ease "${String(raw.ease)}" is not a Stage-S curve`);
  warnUnknownKeys(raw, new Set(["kind", "durationMs", "delayMs", "ease"]), `${where} ${slot} motion`, warnings);
  return { kind: kind as GraphicsMotionKind, durationMs, delayMs, ease };
}

// --- per-kind payload parsers: shape violations are ERRORS (a payload
// that CLAIMS to be the kind's payload but is broken is structural);
// optional junk fields drop honestly with warnings. -------------------------

function parseTextPayload(raw: unknown, where: string, warnings: string[], errors: string[]): TextPayload | null {
  if (raw === undefined) return null; // absent — the caller warns; tolerant parse never refuses
  if (!isObj(raw)) { errors.push(`${where}: text payload unreadable — not an object`); return null; }
  const text = str(raw.text);
  if (text === null || text.trim() === "") {
    errors.push(`${where}: text payload requires a non-empty "text" string`);
    return null;
  }
  const out: TextPayload = { text };
  const sizePx = num(raw.sizePx);
  if (sizePx !== null) {
    if (sizePx < 12 || sizePx > 288) {
      warnings.push(`${where}: sizePx ${sizePx} clamped to 12..288`);
      out.sizePx = clamp(sizePx, 12, 288);
    } else out.sizePx = sizePx;
  } else if (raw.sizePx !== undefined) {
    warnings.push(`${where}: sizePx dropped — not a finite number`);
  }
  const weight = num(raw.weight);
  if (weight !== null) {
    if (weight < 100 || weight > 900) {
      warnings.push(`${where}: weight ${weight} clamped to 100..900`);
      out.weight = clamp(weight, 100, 900);
    } else out.weight = weight;
  } else if (raw.weight !== undefined) {
    warnings.push(`${where}: weight dropped — not a finite number`);
  }
  const color = parseColor(raw.color, where, "color", warnings);
  if (color !== undefined) out.color = color;
  const align = str(raw.align);
  if (align === "left" || align === "center" || align === "right") out.align = align;
  else if (raw.align !== undefined) warnings.push(`${where}: align dropped — not left|center|right`);
  warnUnknownKeys(raw, TEXT_PAYLOAD_KEYS, `${where} text payload`, warnings);
  return out;
}

function parseCounterPayload(raw: unknown, where: string, warnings: string[], errors: string[]): CounterPayload | null {
  if (raw === undefined) return null; // absent — the caller warns; tolerant parse never refuses
  if (!isObj(raw)) { errors.push(`${where}: counter payload unreadable — not an object`); return null; }
  const from = num(raw.from);
  const to = num(raw.to);
  if (from === null || to === null) {
    errors.push(`${where}: counter payload requires finite "from" and "to"`);
    return null;
  }
  if (from >= to) {
    errors.push(`${where}: counter from (${from}) must be < to (${to}) — the v1 count-up law`);
    return null;
  }
  const out: CounterPayload = { from, to };
  const unit = str(raw.unit);
  if (unit !== null) out.unit = unit;
  else if (raw.unit !== undefined) warnings.push(`${where}: unit dropped — not a string`);
  const decimals = num(raw.decimals);
  if (decimals === 0 || decimals === 1 || decimals === 2) out.decimals = decimals;
  else if (raw.decimals !== undefined) warnings.push(`${where}: decimals dropped — must be 0|1|2`);
  warnUnknownKeys(raw, COUNTER_PAYLOAD_KEYS, `${where} counter payload`, warnings);
  return out;
}

function parseBarPayload(raw: unknown, where: string, warnings: string[], errors: string[]): BarPayload | null {
  if (raw === undefined) return null; // absent — the caller warns; tolerant parse never refuses
  if (!isObj(raw)) { errors.push(`${where}: bar payload unreadable — not an object`); return null; }
  if (!Array.isArray(raw.data)) {
    errors.push(`${where}: bar payload requires a "data" array`);
    return null;
  }
  if (raw.data.length === 0) {
    errors.push(`${where}: bar payload requires 1..${GRAPHICS_BUDGETS.barDataMax} data rows`);
    return null;
  }
  if (raw.data.length > GRAPHICS_BUDGETS.barDataMax) {
    errors.push(
      `${where}: ${raw.data.length} bar rows exceeds the barDataMax wall (${GRAPHICS_BUDGETS.barDataMax})`,
    );
    return null;
  }
  const data: BarDatum[] = [];
  for (const row of raw.data) {
    if (!isObj(row)) { errors.push(`${where}: bar data row unreadable — not an object`); return null; }
    const label = str(row.label);
    const value = num(row.value);
    if (label === null || label.trim() === "" || value === null || value < 0) {
      errors.push(`${where}: bar data rows require a non-empty "label" and a finite "value" ≥ 0`);
      return null;
    }
    data.push({ label, value });
  }
  const out: BarPayload = { data };
  const unit = str(raw.unit);
  if (unit !== null) out.unit = unit;
  else if (raw.unit !== undefined) warnings.push(`${where}: unit dropped — not a string`);
  const max = num(raw.max);
  if (max !== null && max > 0) out.max = max;
  else if (raw.max !== undefined) warnings.push(`${where}: max dropped — must be finite > 0`);
  if (typeof raw.horizontal === "boolean") out.horizontal = raw.horizontal;
  else if (raw.horizontal !== undefined) warnings.push(`${where}: horizontal dropped — not a boolean`);
  warnUnknownKeys(raw, BAR_PAYLOAD_KEYS, `${where} bar payload`, warnings);
  return out;
}

function parseIconPayload(raw: unknown, where: string, warnings: string[], errors: string[]): IconPayload | null {
  if (raw === undefined) return null; // absent — the caller warns; tolerant parse never refuses
  if (!isObj(raw)) { errors.push(`${where}: icon payload unreadable — not an object`); return null; }
  if (!Array.isArray(raw.paths) || raw.paths.length === 0) {
    errors.push(`${where}: icon payload requires a non-empty "paths" array`);
    return null;
  }
  const paths: string[] = [];
  for (const p of raw.paths) {
    const d = str(p);
    if (d === null || d.trim() === "") {
      errors.push(`${where}: icon paths must be non-empty path-data strings`);
      return null;
    }
    const commands = countPathCommands(d);
    if (commands === 0) {
      errors.push(`${where}: icon path does not parse — "${d.slice(0, 32)}"`);
      return null;
    }
    if (commands > GRAPHICS_BUDGETS.iconPathCommandBudget) {
      errors.push(
        `${where}: icon path with ${commands} commands exceeds the iconPathCommandBudget wall (${GRAPHICS_BUDGETS.iconPathCommandBudget})`,
      );
      return null;
    }
    paths.push(d);
  }
  const out: IconPayload = { paths };
  const color = parseColor(raw.color, where, "color", warnings);
  if (color !== undefined) out.color = color;
  const strokeWidth = parseStrokeWidth(raw.strokeWidth, where, warnings);
  if (strokeWidth !== undefined) out.strokeWidth = strokeWidth;
  warnUnknownKeys(raw, ICON_PAYLOAD_KEYS, `${where} icon payload`, warnings);
  return out;
}

function parseCalloutPayload(raw: unknown, where: string, warnings: string[], errors: string[]): CalloutPayload | null {
  if (raw === undefined) return null; // absent — the caller warns; tolerant parse never refuses
  if (!isObj(raw)) { errors.push(`${where}: callout payload unreadable — not an object`); return null; }
  const text = str(raw.text);
  if (text === null || text.trim() === "") {
    errors.push(`${where}: callout payload requires a non-empty "text" string`);
    return null;
  }
  const out: CalloutPayload = { text };
  if (raw.pointsAt !== undefined) {
    const px = isObj(raw.pointsAt) ? num(raw.pointsAt.x) : null;
    const py = isObj(raw.pointsAt) ? num(raw.pointsAt.y) : null;
    if (px !== null && py !== null) out.pointsAt = { x: px, y: py };
    else warnings.push(`${where}: pointsAt dropped — must be {x, y} finite`);
  }
  warnUnknownKeys(raw, CALLOUT_PAYLOAD_KEYS, `${where} callout payload`, warnings);
  return out;
}

function parseShapePayload(raw: unknown, where: string, warnings: string[], errors: string[]): ShapePayload | null {
  if (raw === undefined) return null; // absent — the caller warns; tolerant parse never refuses
  if (!isObj(raw)) { errors.push(`${where}: shape payload unreadable — not an object`); return null; }
  const kind = str(raw.kind);
  if (kind !== "rect" && kind !== "line" && kind !== "circle") {
    errors.push(`${where}: shape payload requires kind rect|line|circle — got "${String(raw.kind)}"`);
    return null;
  }
  const out: ShapePayload = { kind };
  for (const dim of ["w", "h", "r"] as const) {
    const v = num(raw[dim]);
    if (v !== null && v > 0) out[dim] = v;
    else if (raw[dim] !== undefined) warnings.push(`${where}: ${dim} dropped — must be finite > 0`);
  }
  const stroke = parseColor(raw.stroke, where, "stroke", warnings);
  if (stroke !== undefined) out.stroke = stroke;
  const fill = parseColor(raw.fill, where, "fill", warnings);
  if (fill !== undefined) out.fill = fill;
  const strokeWidth = parseStrokeWidth(raw.strokeWidth, where, warnings);
  if (strokeWidth !== undefined) out.strokeWidth = strokeWidth;
  warnUnknownKeys(raw, SHAPE_PAYLOAD_KEYS, `${where} shape payload`, warnings);
  return out;
}

function parseGroupPayload(raw: unknown, where: string, warnings: string[], errors: string[]): GroupPayload | null {
  if (raw === undefined) return null; // absent — the caller warns; tolerant parse never refuses
  if (!isObj(raw)) { errors.push(`${where}: group payload unreadable — not an object`); return null; }
  if (!Array.isArray(raw.children) || raw.children.length === 0) {
    errors.push(`${where}: group payload requires a non-empty "children" id array`);
    return null;
  }
  const children: string[] = [];
  for (const c of raw.children) {
    const id = str(c);
    if (id === null) {
      errors.push(`${where}: group children must be element ids (strings)`);
      return null;
    }
    children.push(id);
  }
  warnUnknownKeys(raw, GROUP_PAYLOAD_KEYS, `${where} group payload`, warnings);
  return { children };
}

/** The payload slot per kind — the closed mapping (compile-total). */
const PAYLOAD_SLOT: Readonly<Record<GraphicsElementKind, string>> = {
  headline: "text", subhead: "text", bullet: "text",
  counter: "counter", bar: "bar", barChart: "bar",
  icon: "icon", callout: "callout", shape: "shape", group: "group",
};

const PAYLOAD_SLOTS = new Set(["text", "counter", "bar", "icon", "callout", "shape", "group"]);

function parseElement(
  raw: unknown,
  sceneWhere: string,
  sceneMs: number,
  warnings: string[],
  errors: string[],
): GraphicsElement | null {
  if (!isObj(raw)) { errors.push(`${sceneWhere}: element unreadable — not an object`); return null; }
  const id = str(raw.id);
  if (id === null || !validGraphicsId(id)) {
    errors.push(`${sceneWhere}: element id violates the id law (${String(raw.id)})`);
    return null;
  }
  const where = `${sceneWhere} element "${id}"`;
  warnUnknownKeys(raw, ELEMENT_KEYS, where, warnings);
  const kind = str(raw.kind);
  if (kind === null || !GRAPHICS_ELEMENT_KINDS.includes(kind as GraphicsElementKind)) {
    warnings.push(`${where}: unknown element kind "${String(raw.kind)}" dropped (the v1 set is closed)`);
    return null;
  }
  const elKind = kind as GraphicsElementKind;

  // Choreography — enter is REQUIRED (an element that cannot enter has no
  // reason to exist in this grammar); exit/emphasis drop honestly when
  // absent/junk.
  if (raw.enter === undefined) {
    errors.push(`${where}: enter is required — an element that cannot enter has no reason to exist in this grammar`);
    return null;
  }
  const enter = parseMotion(raw.enter, where, "enter", warnings, errors, true);
  if (enter === null) return null;
  const exit = parseMotion(raw.exit, where, "exit", warnings, errors, false);
  const emphasis = parseMotion(raw.emphasis, where, "emphasis", warnings, errors, false);
  const motions: Array<{ slot: string; motion: ElementMotion }> = [
    { slot: "enter", motion: enter },
    ...(exit ? [{ slot: "exit", motion: exit }] : []),
    ...(emphasis ? [{ slot: "emphasis", motion: emphasis }] : []),
  ];

  // Motion/element compatibility + time sanity — enforced HERE, not at
  // render (the Part F law: a doc that reaches the frame engine is
  // guaranteed legal, so frameAt carries no defensive branches).
  const legal = legalMotions(elKind);
  for (const { slot, motion } of motions) {
    if (!legal.includes(motion.kind)) {
      errors.push(
        `${where}: the ${slot} motion "${motion.kind}" is not legal on a "${elKind}" (the compatibility table allows: ${legal.join(", ")})`,
      );
      return null;
    }
    const spanEnd = motion.delayMs + motion.durationMs;
    if (spanEnd > sceneMs) {
      errors.push(
        `${where}: the ${slot} motion ends at ${spanEnd}ms, past the scene clock (${sceneMs}ms)`,
      );
      return null;
    }
  }

  // Payload-per-kind: payloads parked under the WRONG slot are
  // unknown-field noise to a v1 reader (warning + ignored); the element's
  // own slot parses strictly (shape violations are errors); an absent
  // payload for a kind that has one warns but never refuses.
  const ownSlot = PAYLOAD_SLOT[elKind];
  for (const key of Object.keys(raw)) {
    if (PAYLOAD_SLOTS.has(key) && key !== ownSlot && raw[key] !== undefined) {
      warnings.push(`${where}: a "${key}" payload on a "${elKind}" is ignored (payload-per-kind)`);
    }
  }

  const el: GraphicsElement = {
    id,
    kind: elKind,
    at: parsePlacement(raw.at, where, warnings),
    enter,
  };
  const ownRaw = raw[ownSlot];
  let ownParsed = false;
  switch (ownSlot) {
    case "text": {
      const p = parseTextPayload(ownRaw, where, warnings, errors);
      if (errors.length > 0) return null;
      if (p !== null) { el.text = p; ownParsed = true; }
      break;
    }
    case "counter": {
      const p = parseCounterPayload(ownRaw, where, warnings, errors);
      if (errors.length > 0) return null;
      if (p !== null) { el.counter = p; ownParsed = true; }
      break;
    }
    case "bar": {
      const p = parseBarPayload(ownRaw, where, warnings, errors);
      if (errors.length > 0) return null;
      if (p !== null) { el.bar = p; ownParsed = true; }
      break;
    }
    case "icon": {
      const p = parseIconPayload(ownRaw, where, warnings, errors);
      if (errors.length > 0) return null;
      if (p !== null) { el.icon = p; ownParsed = true; }
      break;
    }
    case "callout": {
      const p = parseCalloutPayload(ownRaw, where, warnings, errors);
      if (errors.length > 0) return null;
      if (p !== null) { el.callout = p; ownParsed = true; }
      break;
    }
    case "shape": {
      const p = parseShapePayload(ownRaw, where, warnings, errors);
      if (errors.length > 0) return null;
      if (p !== null) { el.shape = p; ownParsed = true; }
      break;
    }
    case "group": {
      const p = parseGroupPayload(ownRaw, where, warnings, errors);
      if (errors.length > 0) return null;
      if (p !== null) { el.group = p; ownParsed = true; }
      break;
    }
  }
  if (!ownParsed) {
    warnings.push(
      `${where}: the "${ownSlot}" payload is absent — the composer falls back (tolerant parse never refuses)`,
    );
  }
  if (exit) el.exit = exit;
  if (emphasis) el.emphasis = emphasis;
  const opacity = num(raw.opacity);
  if (opacity !== null) {
    if (opacity < 0 || opacity > 1) {
      warnings.push(`${where}: opacity ${opacity} clamped to 0..1`);
      el.opacity = clamp(opacity, 0, 1);
    } else el.opacity = opacity;
  } else if (raw.opacity !== undefined) {
    warnings.push(`${where}: opacity dropped — not a finite number`);
  }
  return el;
}

function parseScene(
  raw: unknown,
  index: number,
  warnings: string[],
  errors: string[],
): GraphicsScene | null {
  const sceneNo = `scene #${index + 1}`;
  if (!isObj(raw)) { errors.push(`${sceneNo}: unreadable — not an object`); return null; }
  warnUnknownKeys(raw, SCENE_KEYS, sceneNo, warnings);
  const id = str(raw.id);
  if (id === null || !validGraphicsId(id)) {
    errors.push(`${sceneNo}: scene id violates the id law (${String(raw.id)})`);
    return null;
  }
  const where = `scene "${id}"`;
  const narration = str(raw.narration);
  if (narration === null) {
    errors.push(`${where}: narration must be a string (the clock model reads it)`);
    return null;
  }
  const background = str(raw.background);
  if (background === null || !HEX_RE.test(background)) {
    errors.push(`${where}: background must be #rrggbb — a junk background is refused, never substituted`);
    return null;
  }
  const explicitMs = num(raw.durationMs);
  if (raw.durationMs !== undefined && (explicitMs === null || explicitMs <= 0)) {
    errors.push(`${where}: durationMs must be finite > 0`);
    return null;
  }
  if (explicitMs !== null && explicitMs > GRAPHICS_BUDGETS.sceneDurationMsMax) {
    errors.push(
      `${where}: explicit durationMs ${explicitMs} exceeds the sceneDurationMsMax wall (${GRAPHICS_BUDGETS.sceneDurationMsMax})`,
    );
    return null;
  }
  if (!Array.isArray(raw.elements)) {
    errors.push(`${where}: elements must be an array`);
    return null;
  }
  // The scene clock: explicit > the house 2.6-wps estimate (ONE clock
  // model — timing.ts, never re-implemented).
  const sceneMs = explicitMs !== null && explicitMs > 0 ? explicitMs : estimateNarrationMs(narration);
  const elements: GraphicsElement[] = [];
  const ids = new Set<string>();
  for (const elRaw of raw.elements) {
    const el = parseElement(elRaw, where, sceneMs, warnings, errors);
    if (errors.length > 0) return null;
    if (el === null) continue; // dropped (unknown kind) — warned
    if (ids.has(el.id)) {
      errors.push(`${where}: duplicate element id "${el.id}" — ids are the group seam, they must be unique`);
      return null;
    }
    ids.add(el.id);
    elements.push(el);
  }
  // Second phase — group referential integrity (the first phase parsed
  // payloads; ids are now known). The groupDepthMax wall (groups do not
  // nest) makes reference cycles unreachable by construction.
  for (const el of elements) {
    if (el.kind !== "group" || el.group === undefined) continue;
    const seen = new Set<string>();
    const children: string[] = [];
    for (const child of el.group.children) {
      if (child === el.id) {
        errors.push(`${where}: group "${el.id}" references itself`);
        return null;
      }
      if (!ids.has(child)) {
        errors.push(`${where}: group "${el.id}" references missing element "${child}"`);
        return null;
      }
      const childEl = elements.find((c) => c.id === child);
      if (childEl !== undefined && childEl.kind === "group") {
        errors.push(
          `${where}: group "${el.id}" nests group "${child}" — the groupDepthMax wall (${GRAPHICS_BUDGETS.groupDepthMax}) forbids nested groups`,
        );
        return null;
      }
      if (seen.has(child)) {
        warnings.push(`${where}: group "${el.id}" lists "${child}" twice — deduplicated`);
        continue;
      }
      seen.add(child);
      children.push(child);
    }
    el.group = { children };
  }
  if (elements.length > GRAPHICS_BUDGETS.elementsPerScene) {
    errors.push(
      `${where}: ${elements.length} elements exceeds the elementsPerScene wall (${GRAPHICS_BUDGETS.elementsPerScene})`,
    );
    return null;
  }
  const scene: GraphicsScene = { id, narration, background, elements };
  if (explicitMs !== null && explicitMs > 0) scene.durationMs = explicitMs;
  return scene;
}

function parseDoc(raw: unknown, warnings: string[], errors: string[]): GraphicsDoc | null {
  if (!isObj(raw)) { errors.push("the doc must be a JSON object"); return null; }
  warnUnknownKeys(raw, DOC_KEYS, "doc", warnings);
  // Version check — the Scene3D law: an unknown version reads as absent
  // and is never overwritten. A HIGHER integer is the additive law (v-next
  // loads in v1 readers, warned); a junk/missing shape is unreadable.
  const version = num(raw.version);
  if (version === null || !Number.isInteger(version)) {
    errors.push(`doc version must be the integer ${GRAPHICS_VERSION} — got ${String(raw.version)}`);
    return null;
  }
  if (version > GRAPHICS_VERSION) {
    warnings.push(`doc version ${version} is newer than this reader (${GRAPHICS_VERSION}) — parsed as v1, unknown fields dropped`);
  } else if (version < GRAPHICS_VERSION) {
    errors.push(`doc version ${version} predates ${GRAPHICS_VERSION} — nothing to read`);
    return null;
  }
  const title = str(raw.title);
  if (title === null || title.trim() === "") {
    errors.push("doc title must be a non-empty string");
    return null;
  }
  const width = num(raw.width);
  const height = num(raw.height);
  const onSurface = SURFACES.some(([w, h]) => width === w && height === h);
  if (width === null || height === null || !onSurface) {
    errors.push(
      `doc size ${String(raw.width)}×${String(raw.height)} is not a house surface (${SURFACES.map(([w, h]) => `${w}×${h}`).join(", ")})`,
    );
    return null;
  }
  const fps = num(raw.fps);
  if (fps !== 24 && fps !== 30) {
    errors.push(`doc fps must be 24 or 30 — got ${String(raw.fps)}`);
    return null;
  }
  if (!Array.isArray(raw.scenes)) {
    errors.push("doc scenes must be an array");
    return null;
  }
  if (raw.scenes.length === 0) {
    errors.push("doc scenes is empty — a doc with no scenes renders nothing");
    return null;
  }
  if (raw.scenes.length > GRAPHICS_BUDGETS.scenesPerProject) {
    errors.push(
      `${raw.scenes.length} scenes exceeds the scenesPerProject wall (${GRAPHICS_BUDGETS.scenesPerProject})`,
    );
    return null;
  }
  const scenes: GraphicsScene[] = [];
  const sceneIds = new Set<string>();
  let explicitTotalMs = 0;
  for (let i = 0; i < raw.scenes.length; i++) {
    const scene = parseScene(raw.scenes[i], i, warnings, errors);
    if (errors.length > 0) return null;
    if (scene === null) continue;
    if (sceneIds.has(scene.id)) {
      errors.push(`duplicate scene id "${scene.id}" — scene ids ride the S87 tracks, they must be unique`);
      return null;
    }
    sceneIds.add(scene.id);
    if (scene.durationMs !== undefined) explicitTotalMs += scene.durationMs;
    scenes.push(scene);
  }
  if (explicitTotalMs > GRAPHICS_BUDGETS.projectExplicitDurationMsMax) {
    errors.push(
      `Σ explicit scene durations (${explicitTotalMs}ms) exceeds the projectExplicitDurationMsMax wall (${GRAPHICS_BUDGETS.projectExplicitDurationMsMax})`,
    );
    return null;
  }
  return {
    version: GRAPHICS_VERSION,
    title,
    width,
    height,
    fps: fps as 24 | 30,
    scenes,
  };
}

// ---------------------------------------------------------------------------
// Validation entries
// ---------------------------------------------------------------------------

/** Full validation: version check, id law on every id, walls, per-kind
 *  payload shapes, motion/element compatibility (MOTION_KINDS_BY_ELEMENT),
 *  group referential integrity + depth, time sanity (durationMs > 0,
 *  delayMs ≥ 0, enter required, motion spans within the scene clock), icon
 *  path parse under the command budget, color/#rrggbb shape, fps ∈ {24,
 *  30}, surface ∈ the three house sizes. PURE — same input, same result. */
export function validateGraphicsDoc(raw: unknown): GraphicsValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const doc = parseDoc(raw, warnings, errors);
  if (errors.length > 0) return { doc: null, errors, warnings };
  return { doc, errors, warnings };
}

/** Tolerant entry (the parseScene3D shape): null on unreadable — junk
 *  JSON, wrong version shape, structural nonsense. */
export function parseGraphicsDoc(json: string | null | undefined): GraphicsDoc | null {
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  return validateGraphicsDoc(raw).doc;
}

// ---------------------------------------------------------------------------
// Strict write — exactly the declared fields, version first, key order
// stable. Byte-stable round-trip is the pin:
// writeGraphicsDoc(parseGraphicsDoc(writeGraphicsDoc(doc))) ≡ the string.
// ---------------------------------------------------------------------------

function serializeMotion(m: ElementMotion): Rec {
  return { kind: m.kind, durationMs: m.durationMs, delayMs: m.delayMs, ease: m.ease };
}

function serializePayload(kind: GraphicsElementKind, el: GraphicsElement): Rec | null {
  switch (kind) {
    case "headline":
    case "subhead":
    case "bullet": {
      if (el.text === undefined) return null;
      const p = el.text;
      const out: Rec = { text: p.text };
      if (p.sizePx !== undefined) out.sizePx = p.sizePx;
      if (p.weight !== undefined) out.weight = p.weight;
      if (p.color !== undefined) out.color = p.color;
      if (p.align !== undefined) out.align = p.align;
      return out;
    }
    case "counter": {
      if (el.counter === undefined) return null;
      const p = el.counter;
      const out: Rec = { from: p.from, to: p.to };
      if (p.unit !== undefined) out.unit = p.unit;
      if (p.decimals !== undefined) out.decimals = p.decimals;
      return out;
    }
    case "bar":
    case "barChart": {
      if (el.bar === undefined) return null;
      const p = el.bar;
      const out: Rec = {
        data: p.data.map((d) => ({ label: d.label, value: d.value })),
      };
      if (p.unit !== undefined) out.unit = p.unit;
      if (p.max !== undefined) out.max = p.max;
      if (p.horizontal !== undefined) out.horizontal = p.horizontal;
      return out;
    }
    case "icon": {
      if (el.icon === undefined) return null;
      const p = el.icon;
      const out: Rec = { paths: [...p.paths] };
      if (p.color !== undefined) out.color = p.color;
      if (p.strokeWidth !== undefined) out.strokeWidth = p.strokeWidth;
      return out;
    }
    case "callout": {
      if (el.callout === undefined) return null;
      const p = el.callout;
      const out: Rec = { text: p.text };
      if (p.pointsAt !== undefined) out.pointsAt = { x: p.pointsAt.x, y: p.pointsAt.y };
      return out;
    }
    case "shape": {
      if (el.shape === undefined) return null;
      const p = el.shape;
      const out: Rec = { kind: p.kind };
      if (p.w !== undefined) out.w = p.w;
      if (p.h !== undefined) out.h = p.h;
      if (p.r !== undefined) out.r = p.r;
      if (p.stroke !== undefined) out.stroke = p.stroke;
      if (p.fill !== undefined) out.fill = p.fill;
      if (p.strokeWidth !== undefined) out.strokeWidth = p.strokeWidth;
      return out;
    }
    case "group": {
      if (el.group === undefined) return null;
      return { children: [...el.group.children] };
    }
  }
}

function serializeElement(el: GraphicsElement): Rec {
  const out: Rec = {
    id: el.id,
    kind: el.kind,
    at: { x: el.at.x, y: el.at.y, scale: el.at.scale, rotateDeg: el.at.rotateDeg },
  };
  const payload = serializePayload(el.kind, el);
  if (payload !== null) out[PAYLOAD_SLOT[el.kind]] = payload;
  out.enter = serializeMotion(el.enter);
  if (el.exit !== undefined) out.exit = serializeMotion(el.exit);
  if (el.emphasis !== undefined) out.emphasis = serializeMotion(el.emphasis);
  if (el.opacity !== undefined) out.opacity = el.opacity;
  return out;
}

/** Strict write: exactly the declared fields, version first, key order
 *  stable — byte-stable round-trip is the pin. */
export function writeGraphicsDoc(doc: GraphicsDoc): string {
  return JSON.stringify({
    version: doc.version,
    title: doc.title,
    width: doc.width,
    height: doc.height,
    fps: doc.fps,
    scenes: doc.scenes.map((s) => {
      const out: Rec = { id: s.id, narration: s.narration };
      if (s.durationMs !== undefined) out.durationMs = s.durationMs;
      out.background = s.background;
      out.elements = s.elements.map(serializeElement);
      return out;
    }),
  });
}
