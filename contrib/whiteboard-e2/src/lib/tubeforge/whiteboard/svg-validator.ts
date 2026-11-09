// svg-validator.ts — security allowlist for whiteboard SVG assets (E2).
//
// SVG is an attack surface (plan §6: "Disallow scripts, event handlers,
// external references and unsafe embedded content"). This module parses with
// a strict tokenizing parser that REJECTS unknown constructs rather than
// silently skipping them, then enforces an element + attribute allowlist.
//
// No DOM. Pure string + state machine → safe by construction.

import { LIMITS, type WhiteboardAsset } from "./schemas";

export class SvgValidationError extends Error {
  constructor(message: string) {
    super(`SvgValidationError: ${message}`);
    this.name = "SvgValidationError";
  }
}

const ALLOWED_ELEMENTS = new Set([
  "svg",
  "g",
  "path",
  "line",
  "polyline",
  "polygon",
  "circle",
  "ellipse",
  "rect",
  "defs",
  "title",
  "desc",
  "use", // restricted to same-document refs (see attribute check)
]);

// Attributes that always carry a security risk; rejected outright.
const DENIED_ATTR_PATTERNS = [
  /^on[a-z]+$/i, // event handlers: onclick, onload, onerror...
  /^xlink:href$/i, // remote refs (we allow only same-document #)
];

// Allowed attributes per element. Anything not listed is rejected.
const ATTR_ALLOWLIST: Record<string, Set<string>> = {
  svg: new Set(["xmlns", "viewBox", "width", "height", "preserveAspectRatio"]),
  g: new Set([
    "transform", "opacity", "id",
    // inheritance-friendly presentation attributes (so authors can set
    // stroke/fill on a <g> and have child paths inherit — the standard
    // SVG idiom and the pattern our library uses).
    "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin",
    "stroke-miterlimit", "stroke-opacity", "fill", "fill-opacity", "fill-rule",
  ]),
  path: new Set(["id", "d", "transform", "stroke", "stroke-width", "stroke-linecap",
                 "stroke-linejoin", "stroke-miterlimit", "stroke-opacity", "fill",
                 "fill-opacity", "fill-rule", "opacity"]),
  line: new Set(["x1", "y1", "x2", "y2", "transform", "stroke", "stroke-width",
                 "stroke-linecap", "stroke-linejoin", "stroke-opacity", "opacity"]),
  polyline: new Set(["points", "transform", "stroke", "stroke-width", "stroke-linecap",
                     "stroke-linejoin", "stroke-opacity", "fill", "fill-opacity", "opacity"]),
  polygon: new Set(["points", "transform", "stroke", "stroke-width", "stroke-linecap",
                   "stroke-linejoin", "stroke-opacity", "fill", "fill-opacity", "opacity"]),
  circle: new Set(["cx", "cy", "r", "transform", "stroke", "stroke-width",
                   "stroke-linecap", "stroke-linejoin", "stroke-opacity", "fill",
                   "fill-opacity", "opacity"]),
  ellipse: new Set(["cx", "cy", "rx", "ry", "transform", "stroke", "stroke-width",
                    "stroke-linecap", "stroke-linejoin", "stroke-opacity", "fill",
                    "fill-opacity", "opacity"]),
  rect: new Set(["x", "y", "width", "height", "rx", "ry", "transform", "stroke",
                 "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-opacity",
                 "fill", "fill-opacity", "opacity"]),
  defs: new Set(["transform", "opacity"]),
  use: new Set(["href", "xlink:href", "x", "y", "width", "height", "transform", "opacity"]),
  title: new Set(),
  desc: new Set(),
};

// Color value helpers — only hex (#RRGGBB / #RGB) and named basics.
const NAMED_COLORS = new Set([
  "none", "transparent", "black", "white", "red", "green", "blue", "yellow",
  "orange", "purple", "gray", "grey", "pink", "brown", "cyan", "magenta",
]);
function isSafeColor(v: string): boolean {
  const s = v.trim().toLowerCase();
  if (NAMED_COLORS.has(s)) return true;
  if (/^#[0-9a-f]{3}$/.test(s) || /^#[0-9a-f]{6}$/.test(s)) return true;
  return false;
}

function isSafeOpacity(v: string): boolean {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 1;
}

function isSafeLength(v: string): boolean {
  const s = v.trim();
  // plain int or int with px unit; no calc(), no expressions.
  return /^-?\d+(\.\d+)?(px)?$/.test(s);
}

function isSafeTransform(v: string): boolean {
  // Only translate/scale/rotate/matrix with numeric args. No url(#...).
  return /^(matrix|translate|scale|rotate)\(([^()]*?\([^()]*\)[^()]*?|[^()]*)\)$/.test(v.trim())
    || /^((matrix|translate|scale|rotate)\([^()]+\)\s*)+$/.test(v.trim());
}

// Validate a single attribute value for an allowed attribute.
function validateAttrValue(el: string, attr: string, value: string): void {
  // Refuse dangerous patterns anywhere.
  for (const p of DENIED_ATTR_PATTERNS) {
    if (p.test(attr)) {
      throw new SvgValidationError(`<${el}> uses denied attribute "${attr}"`);
    }
  }
  if (attr === "href" || attr === "xlink:href") {
    // only same-document fragment refs permitted
    if (!value.startsWith("#")) {
      throw new SvgValidationError(`<${el}> ${attr} must be a same-document fragment ("#id"); got "${value}"`);
    }
    return;
  }
  const colorAttrs = new Set(["stroke", "fill"]);
  const opacityAttrs = new Set(["opacity", "stroke-opacity", "fill-opacity"]);
  const lengthAttrs = new Set([
    "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry",
    "width", "height", "rx", "ry", "stroke-width", "stroke-miterlimit",
  ]);
  if (colorAttrs.has(attr) && value !== "") {
    if (!isSafeColor(value)) {
      throw new SvgValidationError(`<${el}> ${attr}="${value}" is not an allowed color`);
    }
    return;
  }
  if (opacityAttrs.has(attr)) {
    if (!isSafeOpacity(value)) {
      throw new SvgValidationError(`<${el}> ${attr}="${value}" must be a number in [0,1]`);
    }
    return;
  }
  if (lengthAttrs.has(attr)) {
    if (!isSafeLength(value)) {
      throw new SvgValidationError(`<${el}> ${attr}="${value}" is not a safe length`);
    }
    return;
  }
  if (attr === "transform") {
    if (!isSafeTransform(value)) {
      throw new SvgValidationError(`<${el}> transform="${value}" is not an allowed transform`);
    }
    return;
  }
  if (attr === "viewBox") {
    if (!/^[-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+$/.test(value.trim())) {
      throw new SvgValidationError(`svg viewBox="${value}" is malformed`);
    }
    return;
  }
  if (attr === "preserveAspectRatio") {
    if (!/^(none|xMidYMid meet|xMidYMid slice)$/.test(value.trim())) {
      throw new SvgValidationError(`preserveAspectRatio="${value}" not allowed`);
    }
    return;
  }
  if (attr === "points" || attr === "d") {
    // raw path/points — no url(), no ;, no <, no >
    if (/[<>;]/.test(value) || /url\(/i.test(value)) {
      throw new SvgValidationError(`<${el}> ${attr} contains forbidden characters`);
    }
    return;
  }
  // For xmlns + numeric enums, accept if simple alnum/dash/colon
  if (!/^[a-zA-Z0-9:.\-+_/\s]*$/.test(value)) {
    throw new SvgValidationError(`<${el}> ${attr}="${value}" has unsafe characters`);
  }
}

interface Element {
  name: string;
  attrs: Record<string, string>;
  children: Element[];
  text: string;
}

/**
 * Strict tokenizer: parses tags, attributes, text. Throws on malformed input.
 * This is intentionally NOT a full XML parser — it is the smallest parser
 * that accepts our allowlist cleanly and rejects everything else.
 */
function parseXml(input: string): Element {
  const s = input.trim();
  if (!s.startsWith("<")) throw new SvgValidationError("input is not XML");
  let i = 0;
  const stack: Element[] = [];
  let root: Element | null = null;

  function skipWs() { while (i < s.length && /\s/.test(s[i])) i++; }

  function parseName(): string {
    const start = i;
    while (i < s.length && /[a-zA-Z0-9:_-]/.test(s[i])) i++;
    if (i === start) throw new SvgValidationError(`expected element name at offset ${i}`);
    return s.slice(start, i);
  }

  function parseAttrValue(): string {
    if (s[i] !== '"' && s[i] !== "'") {
      throw new SvgValidationError(`expected quote at offset ${i}`);
    }
    const quote = s[i++];
    const start = i;
    while (i < s.length && s[i] !== quote) {
      if (s[i] === "<") throw new SvgValidationError("`<` inside attribute value");
      i++;
    }
    if (i >= s.length) throw new SvgValidationError("unterminated attribute value");
    const v = s.slice(start, i);
    i++; // consume quote
    // decode minimal entity set only
    return v
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
  }

  function parseAttrs(): Record<string, string> {
    const attrs: Record<string, string> = {};
    while (i < s.length) {
      skipWs();
      if (s[i] === ">" || s[i] === "/") break;
      const name = parseName();
      skipWs();
      if (s[i] !== "=") {
        throw new SvgValidationError(`attribute "${name}" must have a value`);
      }
      i++; // =
      skipWs();
      attrs[name] = parseAttrValue();
    }
    return attrs;
  }

  function parseElement(): Element {
    if (s[i] !== "<") throw new SvgValidationError(`expected "<" at offset ${i}`);
    // Skip benign XML comments <!-- ... --> (they cannot carry executable
    // content; the alternative — rejecting them outright — would forbid
    // authoring comments in library assets for no security benefit).
    if (s.slice(i, i + 4) === "<!--") {
      const end = s.indexOf("-->", i + 4);
      if (end === -1) throw new SvgValidationError(`unterminated comment at offset ${i}`);
      i = end + 3;
      return parseElement();
    }
    i++; // <
    const name = parseName();
    const attrs = parseAttrs();
    skipWs();
    const el: Element = { name, attrs, children: [], text: "" };
    if (s[i] === "/") {
      i++; // /
      if (s[i] !== ">") throw new SvgValidationError(`expected "/>" at offset ${i}`);
      i++; // >
      return el;
    }
    if (s[i] !== ">") throw new SvgValidationError(`expected ">" at offset ${i}`);
    i++; // >
    // parse children + text until matching close tag
    while (i < s.length) {
      if (s[i] === "<") {
        if (s[i + 1] === "/") {
          i += 2; // </
          const closeName = parseName();
          if (closeName !== name) {
            throw new SvgValidationError(`mismatched close tag </${closeName}> for <${name}>`);
          }
          skipWs();
          if (s[i] !== ">") throw new SvgValidationError(`expected ">" after </${closeName}>`);
          i++; // >
          return el;
        }
        if (s[i + 1] === "!" || s[i + 1] === "?") {
          // Allow benign comments <!-- ... --> (cannot carry executable content).
          if (s.slice(i, i + 4) === "<!--") {
            const end = s.indexOf("-->", i + 4);
            if (end === -1) throw new SvgValidationError(`unterminated comment at offset ${i}`);
            i = end + 3;
            continue;
          }
          throw new SvgValidationError(`declarations / processing instructions not permitted (offset ${i})`);
        }
        el.children.push(parseElement());
      } else {
        // text — accept only whitespace and basic alnum/punctuation (no scripts)
        const start = i;
        while (i < s.length && s[i] !== "<") i++;
        const txt = s.slice(start, i).trim();
        if (txt) {
          // very strict text: alnum, whitespace, basic punctuation. No < > ; or entity chains.
          if (/[<>;{}]/.test(txt) && !/^&[a-z]+;$/.test(txt)) {
            throw new SvgValidationError(`text content "${txt.slice(0, 40)}" contains forbidden characters`);
          }
          el.text += txt;
        }
      }
    }
    throw new SvgValidationError(`unterminated element <${name}>`);
  }

  root = parseElement();
  if (i !== s.length) {
    // trailing junk — usually a sign of injection attempt
    skipWs();
    if (i !== s.length) {
      throw new SvgValidationError(`unexpected trailing content after root element (offset ${i})`);
    }
  }
  return root;
}

function walk(el: Element, stats: { pathCount: number }) {
  if (!ALLOWED_ELEMENTS.has(el.name)) {
    throw new SvgValidationError(`element <${el.name}> is not allowed`);
  }
  const allowedAttrs = ATTR_ALLOWLIST[el.name] || new Set<string>();
  for (const attr of Object.keys(el.attrs)) {
    // explicit denials first (covers xlink:href remote refs even if present in allowlist)
    for (const p of DENIED_ATTR_PATTERNS) {
      if (p.test(attr)) {
        throw new SvgValidationError(`<${el.name}> uses denied attribute "${attr}"`);
      }
    }
    if (!allowedAttrs.has(attr)) {
      throw new SvgValidationError(`<${el.name}> attribute "${attr}" is not allowed on this element`);
    }
    validateAttrValue(el.name, attr, el.attrs[attr]);
  }
  if (el.name === "path") {
    if (!el.attrs.d) {
      throw new SvgValidationError("<path> must have a `d` attribute");
    }
    stats.pathCount++;
    if (stats.pathCount > LIMITS.MAX_PATHS_PER_ASSET) {
      throw new SvgValidationError(
        `asset exceeds MAX_PATHS_PER_ASSET (${LIMITS.MAX_PATHS_PER_ASSET})`,
      );
    }
  }
  if (el.name === "use") {
    // already validated to be "#..." same-document; refuse if target not a def (basic check)
    // (full reference resolution is the extractor's job; here we only prevent remote fetch)
  }
  for (const c of el.children) walk(c, stats);
}

export interface ValidatedSvg {
  root: Element;
  sizeBytes: number;
  pathCount: number;
}

export function validateSvg(source: string): ValidatedSvg {
  if (source.length === 0) throw new SvgValidationError("empty SVG source");
  if (source.length > LIMITS.MAX_ASSET_BYTES) {
    throw new SvgValidationError(
      `SVG is ${source.length} bytes, exceeds MAX_ASSET_BYTES (${LIMITS.MAX_ASSET_BYTES})`,
    );
  }
  // Fast reject of obviously dangerous patterns before parsing.
  if (/<script/i.test(source)) throw new SvgValidationError("<script> is forbidden");
  if (/<foreignObject/i.test(source)) throw new SvgValidationError("<foreignObject> is forbidden");
  if (/javascript:/i.test(source)) throw new SvgValidationError("javascript: URIs are forbidden");
  if (/<!ENTITY/i.test(source)) throw new SvgValidationError("XML entity declarations are forbidden");
  if (/<!DOCTYPE/i.test(source)) throw new SvgValidationError("DOCTYPE declarations are forbidden");
  if (/data:text\/html/i.test(source)) throw new SvgValidationError("data:text/html URIs are forbidden");

  const root = parseXml(source);
  if (root.name !== "svg") {
    throw new SvgValidationError(`root element must be <svg>, got <${root.name}>`);
  }
  const stats = { pathCount: 0 };
  walk(root, stats);
  return { root, sizeBytes: source.length, pathCount: stats.pathCount };
}

/**
 * Returns true if the source passes the validator. Used by tests + the
 * asset registry's defensive re-check at load time.
 */
export function isSafeSvg(source: string): boolean {
  try {
    validateSvg(source);
    return true;
  } catch {
    return false;
  }
}

/** Shape check: did the validator reject for a specific reason? (test helper) */
export function assertSvgRejected(source: string, reasonContains?: string): void {
  let threw = false;
  let msg = "";
  try { validateSvg(source); } catch (e) { threw = true; msg = (e as Error).message; }
  if (!threw) throw new Error("expected SVG to be rejected, but it was accepted");
  if (reasonContains && !msg.toLowerCase().includes(reasonContains.toLowerCase())) {
    throw new Error(`expected rejection to mention "${reasonContains}", got: ${msg}`);
  }
}

/** Used by the asset registry to attach the safe parsed tree to an asset record. */
export function validatedRoot(source: string): Element {
  return validateSvg(source).root;
}

/** Internal — exposed for tests + the path extractor. */
export type { Element as SvgElement };
