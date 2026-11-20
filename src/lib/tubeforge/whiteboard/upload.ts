// S69 — the Whiteboard Engine: the uploaded-SVG gates (E9 Phase C / E11 §7,
// gates 1–4 — the PURE half; the rasterize probe lives in render.ts, the
// quota + storage gates in the /asset route and asset-store.ts).
//
// The design's order is the law here, each gate naming its unit-pinned
// sibling (WHITEBOARD_ENGINE_DESIGN.md §7):
//   1. Transport  — byte cap 256 KB raw (the music-upload precedent).
//   2. Sniff      — UTF-8 validity + a single root <svg> with a usable
//                   viewBox (content-type headers are advisory only).
//   3. Sanitize   — sanitizeSvg, the S64 attack-fixture battery.
//   4. Budget     — per-path countPathCommands ≤ 512 (WB_PATH_COMMAND_BUDGET),
//                   per-asset total ≤ 2,048, extractAsset(...).rejected empty
//                   (charset + command walls) — any rejection fails the upload
//                   WITH the reasons.
//
// What is stored is the SANITIZED FRAGMENT (the root <svg>'s inner markup),
// never the raw document: the pipeline neutralizes rather than punishes, and
// the manifest + storage layers only ever see bytes that already passed
// every gate. Nothing here touches fs/DB/network — the unit suite pins it.
import { countPathCommands, sanitizeSvg } from "./svg";
import { extractAsset, WB_PATH_COMMAND_BUDGET, type WhiteboardAsset } from "./assets";
import { validateAsset } from "./asset-validate";
import { traceRasterToStrokes, TraceError, type TraceReceipt } from "./trace";
import { WB_TRACED_TOTAL_BUDGET } from "./trace-budget";

/** Gate 1 — the transport wall: 256 KB raw (design §7.1). */
export const WB_UPLOAD_MAX_BYTES = 256 * 1024;

/** Gate 1 — the RASTER transport wall (P0): PNG/JPEG decode+trace pays a
 *  different byte economy than SVG text; 8 MB caps the decompression-bomb
 *  surface while sharp's decoder works on fixed working dimensions. */
export const WB_RASTER_MAX_BYTES = 8 * 1024 * 1024;

/** Gate 2 — the raster dimension ceiling (mirrors the viewBox ceiling
 *  law): a larger image is downsampled by the trace pipeline anyway, so
 *  refusing oversized sources up front names the wall readably. */
export const WB_RASTER_DIMENSION_MAX = 4096;

/** Gate 4 — the per-asset TOTAL command budget (design §7.4). */
export const WB_UPLOAD_TOTAL_COMMAND_BUDGET = 2048;

/** Gate 2 — a viewBox outside [16, 4096] on either axis cannot be placed
 * sanely (a giant viewBox with invisible ink, a sliver that collapses the
 * placement bbox) — refuse it readably at the sniff. */
export const WB_UPLOAD_VIEWBOX_MIN = 16;
export const WB_UPLOAD_VIEWBOX_MAX = 4096;

/** Gate 6 — per-video / per-org asset COUNT walls (bytes ride storage.ts's
 * assertQuota on every put; the count walls live in the manifest queries
 * the /asset route runs). Placements cap at 64/scene and scenes at 24, so
 * 48 uploads per video is generous headroom; 240 per org keeps the merged
 * library bounded no matter how many videos carry uploads. */
export const WB_UPLOADS_PER_VIDEO = 48;
export const WB_UPLOADS_PER_ORG = 240;

export interface UploadValidationOk {
  ok: true;
  /** The library-ready asset: SANITIZED fragment + viewBox + the upload tag. */
  asset: WhiteboardAsset;
  /** The extraction the gates ran (paths/texts the palette will show). */
  paths: number;
  texts: number;
  commands: number;
  /** P0 — present ONLY for raster uploads: the trace receipt (the
   *  manifest row carries the compact meta; this is the full record). */
  trace?: TraceReceipt;
}

/** P0 — the compact trace provenance the manifest row stores (asset-store
 *  WhiteboardUploadRow.traced; the plan's P0-4 shape, additive JSON). */
export interface TracedUploadMeta {
  strokes: number;
  commands: number;
  sourceBytes: number;
  sourceFormat: "png" | "jpeg";
  ms: number;
  quality: string;
  /** P0-7 — recorded ONLY on AI-generated assets (the bridge route). */
  prompt?: string;
  policyId?: string;
}

export interface UploadValidationErr {
  ok: false;
  errors: string[];
}

export type UploadValidation = UploadValidationOk | UploadValidationErr;

/** Gate 2 — decode + structure sniff. Returns the sanitized inner markup
 * and the root viewBox, or readable errors. PURE. */
export function sniffSvgUpload(raw: Buffer): { svg: string; viewBox: { w: number; h: number } } | { errors: string[] } {
  // UTF-8 validity — TextDecoder fatal mode replaces nothing; invalid byte
  // sequences throw instead of silently becoming U+FFFD.
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return { errors: ["the file is not valid UTF-8 — export plain SVG text"] };
  }
  if (text.includes("\u0000")) {
    return { errors: ["the file contains a NUL byte"] };
  }
  // A single root <svg …>…</svg>: strip a BOM/prolog/doctype first (the
  // sanitizer would too, but the sniff needs the ROOT, not a neutered one).
  const body = text.replace(/^\uFEFF/, "").replace(/<\?[\s\S]*?\?>/g, "").replace(/<!DOCTYPE[\s\S]*?>/gi, "").trim();
  const open = body.search(/<svg[\s>]/i);
  if (open === -1) return { errors: ["no root <svg> element found"] };
  const before = body.slice(0, open).trim();
  if (before.length > 0)
    return { errors: [`content before the root <svg> (${before.slice(0, 40).replace(/\s+/g, " ")}…) — exactly one root element is allowed`] };
  const close = body.toLowerCase().lastIndexOf("</svg>");
  if (close === -1) return { errors: ["the <svg> root is never closed"] };
  const after = body.slice(close + 6).trim();
  if (after.length > 0)
    return { errors: [`content after the root </svg> (${after.slice(0, 40).replace(/\s+/g, " ")}…) — exactly one root element is allowed`] };
  const rootTag = /<svg\b[^>]*>/i.exec(body.slice(open))?.[0] ?? "";
  const inner = body.slice(open + rootTag.length, close);
  // viewBox — required: placement geometry is viewBox-space, and guessing it
  // from width/height attrs (often absent in exported fragments) would put
  // uploads on a different law than the built-in library.
  const vb = /\sviewBox\s*=\s*["']\s*([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)\s+([-\d.eE]+)\s*["']/i.exec(rootTag);
  if (!vb) return { errors: ["the root <svg> needs a viewBox=\"minX minY width height\" attribute"] };
  const w = Number(vb[3]);
  const h = Number(vb[4]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0)
    return { errors: [`viewBox "${vb[0].trim()}" is not a usable positive rectangle`] };
  if (w < WB_UPLOAD_VIEWBOX_MIN || h < WB_UPLOAD_VIEWBOX_MIN)
    return { errors: [`viewBox ${w}×${h} is below the ${WB_UPLOAD_VIEWBOX_MIN}px minimum on an axis`] };
  if (w > WB_UPLOAD_VIEWBOX_MAX || h > WB_UPLOAD_VIEWBOX_MAX)
    return { errors: [`viewBox ${w}×${h} exceeds the ${WB_UPLOAD_VIEWBOX_MAX}px maximum on an axis`] };
  return { svg: inner, viewBox: { w: Math.round(w), h: Math.round(h) } };
}

/** Derive the library asset id from the upload's filename: lowercase,
 * [a-z0-9-] runs from the stem, charset-legal by construction (collision
 * checks against built-ins + existing uploads happen in the route — a
 * collision there is a 409, not a silent renumber). */
export function deriveUploadAssetId(filename: string): string {
  const stem = filename.replace(/\.[^.]*$/, "").toLowerCase();
  const slug = stem.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  const id = slug || "upload";
  // The charset law allows dots; the slug never emits them. Prefix keeps
  // upload ids visually distinct from the built-in library.
  return `up-${id}`;
}

/** Gates 1–4 in order. `reservedIds` lets the caller fail fast on id
 * collisions (built-ins + this video's existing uploads) without a second
 * vocabulary. PURE — the route adds the rasterize probe (gate 5), the
 * manifest/storage gates (6–7). */
export function validateUploadedSvg(
  raw: Buffer,
  filename: string,
  reservedIds: ReadonlySet<string> = new Set()
): UploadValidation {
  const errors: string[] = [];
  if (raw.length === 0) return { ok: false, errors: ["the file is empty"] };
  if (raw.length > WB_UPLOAD_MAX_BYTES)
    return {
      ok: false,
      errors: [`the SVG is ${Math.round(raw.length / 1024)} KB — the upload cap is ${WB_UPLOAD_MAX_BYTES / 1024} KB`],
    };

  const sniffed = sniffSvgUpload(raw);
  if ("errors" in sniffed) return { ok: false, errors: sniffed.errors };

  // Gate 3 — the SAME sanitizer the library runs on every load.
  const sanitized = sanitizeSvg(sniffed.svg);

  const id = deriveUploadAssetId(filename);
  if (reservedIds.has(id))
    return {
      ok: false,
      errors: [`asset id "${id}" is already taken on this video — rename the file or delete the existing asset first`],
    };

  // Gate 4 — extraction + the walls. rejected MUST be empty; the per-asset
  // command total bounds what a scene's worth of dash-reveal geometry pays.
  const asset: WhiteboardAsset = {
    id,
    viewBox: sniffed.viewBox,
    tags: ["upload"],
    svg: sanitized,
  };
  const ex = extractAsset(asset);
  for (const r of ex.rejected) {
    const reason =
      r.reason === "id-charset"
        ? `element id "${r.id}" violates the id charset (namespace separators --/:: and exotic characters are forbidden)`
        : `path "${r.id}" exceeds the ${WB_PATH_COMMAND_BUDGET}-command per-path budget`;
    errors.push(reason);
  }
  if (errors.length > 0) return { ok: false, errors };
  if (ex.paths.length === 0 && ex.texts.length === 0)
    return {
      ok: false,
      errors: [
        "no drawable content survived the gates — the file needs at least one <path id=\"…\" d=\"…\"> or <text id=\"…\"> element (scripts, embedded images and external references are stripped)",
      ],
    };
  let commands = 0;
  for (const p of ex.paths) commands += countPathCommands(p.d);
  if (commands > WB_UPLOAD_TOTAL_COMMAND_BUDGET)
    return {
      ok: false,
      errors: [`${commands} total path commands exceed the ${WB_UPLOAD_TOTAL_COMMAND_BUDGET}-command per-asset budget`],
    };

  // W3 — the stroke-authored validator (the new gate): geometry the hand
  // can actually ride. Runs LAST so budget-broken paths are named by the
  // budget walls first; the findings' reasons are already readable.
  const report = validateAsset(asset);
  if (!report.ok) {
    return { ok: false, errors: report.findings.map((f) => f.reason ?? "invalid stroke geometry") };
  }

  return { ok: true, asset, paths: ex.paths.length, texts: ex.texts.length, commands };
}

// ---------------------------------------------------------------------------
// P0 — the raster gate branch (the plan's P0-2). The gates stay SEVEN and
// in order: transport → sniff → [trace] → sanitize → budget → validator →
// probe/quota/storage. The trace step sits between the sniff and sanitize
// and its OUTPUT (the derived stroke fragment) is what every later gate
// sees — the raster never bypasses a gate, it ENTERS them one stage later.
// ---------------------------------------------------------------------------

/** Gate 2 (raster) — the magic-byte sniff + header dimension parse.
 *  Content-type headers are advisory only (the SVG sniff's law); the BYTES
 *  are the truth. PNG IHDR / JPEG SOF scans are exact, so an oversized or
 *  broken source is named BEFORE the decoder sees it. Returns null when
 *  the bytes are neither PNG nor JPEG (the caller defers to the SVG path). */
export function sniffRasterImage(raw: Buffer): { format: "png" | "jpeg"; width: number; height: number } | null {
  if (raw.length < 24) return null;
  // PNG: the 8-byte signature, then an IHDR chunk (length 13) whose body
  // starts with the big-endian width/height pair.
  if (
    raw[0] === 0x89 && raw[1] === 0x50 && raw[2] === 0x4e && raw[3] === 0x47 &&
    raw[4] === 0x0d && raw[5] === 0x0a && raw[6] === 0x1a && raw[7] === 0x0a
  ) {
    if (raw.length < 24 || raw.readUInt32BE(8) !== 13 || raw.toString("ascii", 12, 16) !== "IHDR") return null;
    return { format: "png", width: raw.readUInt32BE(16), height: raw.readUInt32BE(20) };
  }
  // JPEG: SOI marker, then the segment walk to the first SOFx frame header
  // (height at +5, width at +7, big-endian). RSTn/temple markers carry no
  // length prefix — everything else does.
  if (raw[0] === 0xff && raw[1] === 0xd8 && raw[2] === 0xff) {
    let off = 2;
    while (off + 4 <= raw.length) {
      if (raw[off] !== 0xff) {
        off++;
        continue;
      }
      const marker = raw[off + 1];
      if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        off += 2;
        continue;
      }
      if (off + 9 > raw.length) return null;
      const segLen = raw.readUInt16BE(off + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { format: "jpeg", width: raw.readUInt16BE(off + 7), height: raw.readUInt16BE(off + 5) };
      }
      off += 2 + segLen;
    }
    return null;
  }
  return null;
}

const TRACE_REJECT_REASON: Record<string, (r: { inkRatio: number; components: number }) => string> = {
  blank: (r) =>
    `the image is essentially blank (${(r.inkRatio * 100).toFixed(1)}% ink coverage) — there is no line art to trace; check that the file exported correctly`,
  dense: (r) =>
    `the image is mostly solid ink (${(r.inkRatio * 100).toFixed(1)}% coverage) — filled artwork and photographs do not trace into drawable strokes; use outline/line-art sources`,
  noisy: (r) =>
    `the image carries photo-like noise (${r.components} components) — tracing it would produce unreadable scribble; use clean, high-contrast line art`,
  photo: (r) =>
    `the image reads as a photograph (${(r.inkRatio * 100).toFixed(1)}% ink, ${r.components} components) — the tracer draws line art; use an outline drawing, a diagram, or generate one through the AI-illustration bridge`,
};

/** Gates 1–4 mapped to raster. The trace receipt rides the ok branch
 *  (additive `trace` field — the SVG path's shape is untouched). ASYNC:
 *  the trace pipeline is a codec pipeline (sharp has no sync decode). */
export async function validateUploadedRaster(
  raw: Buffer,
  filename: string,
  reservedIds: ReadonlySet<string> = new Set()
): Promise<UploadValidation> {
  if (raw.length === 0) return { ok: false, errors: ["the file is empty"] };
  if (raw.length > WB_RASTER_MAX_BYTES) {
    return {
      ok: false,
      errors: [
        `the image is ${(Math.round((raw.length / (1024 * 1024)) * 10) / 10).toFixed(1)} MB — the raster upload cap is ${WB_RASTER_MAX_BYTES / (1024 * 1024)} MB`,
      ],
    };
  }
  const sniffed = sniffRasterImage(raw);
  if (!sniffed) {
    return { ok: false, errors: ["not a PNG or JPEG image (the magic bytes say so) — export the file as PNG or JPEG"] };
  }
  if (sniffed.width <= 0 || sniffed.height <= 0) {
    return { ok: false, errors: ["the image header carries no usable dimensions — the file may be truncated"] };
  }
  if (sniffed.width > WB_RASTER_DIMENSION_MAX || sniffed.height > WB_RASTER_DIMENSION_MAX) {
    return {
      ok: false,
      errors: [
        `the image is ${sniffed.width}×${sniffed.height}px — the ceiling is ${WB_RASTER_DIMENSION_MAX}px on an axis (downscale it first; the tracer works at a fixed size anyway)`,
      ],
    };
  }

  const id = deriveUploadAssetId(filename);
  if (reservedIds.has(id)) {
    return {
      ok: false,
      errors: [`asset id "${id}" is already taken on this video — rename the file or delete the existing asset first`],
    };
  }

  // The trace step (between sniff and sanitize — its OUTPUT is what the
  // remaining gates see). TraceError messages are already user-shaped.
  let result;
  try {
    result = await traceRasterToStrokes(raw);
  } catch (err) {
    if (err instanceof TraceError) return { ok: false, errors: [err.message] };
    throw err;
  }

  // The quality gate (audit §4A): unsuitable images are rejected with the
  // useful explanation, never traced into poor animations.
  const reject = TRACE_REJECT_REASON[result.receipt.quality];
  if (reject) return { ok: false, errors: [reject(result.receipt)] };

  // Gate 3 — the SAME sanitizer (a property of the pipeline; the generated
  // fragment is clean by construction, the gate runs anyway).
  const sanitized = sanitizeSvg(result.svgFragment);

  // Gate 4 — extraction + the walls: per-path 512 (traced strokes emit
  // ≤ 96 by construction) and the TRACED total budget (4,096 — the raised
  // wall the plan's P0-5 names; the SVG's 2,048 stays untouched).
  const asset: WhiteboardAsset = {
    id,
    viewBox: result.viewBox,
    tags: ["upload", "traced"],
    svg: sanitized,
  };
  const errors: string[] = [];
  const ex = extractAsset(asset);
  for (const r of ex.rejected) {
    const reason =
      r.reason === "id-charset"
        ? `element id "${r.id}" violates the id charset (namespace separators --/:: and exotic characters are forbidden)`
        : `path "${r.id}" exceeds the ${WB_PATH_COMMAND_BUDGET}-command per-path budget`;
    errors.push(reason);
  }
  if (errors.length > 0) return { ok: false, errors };
  if (ex.paths.length === 0) {
    return { ok: false, errors: ["the trace produced no drawable <path> elements — internal tracer bug, please report"] };
  }
  let commands = 0;
  for (const p of ex.paths) commands += countPathCommands(p.d);
  if (commands > WB_TRACED_TOTAL_BUDGET) {
    return {
      ok: false,
      errors: [`${commands} total path commands exceed the ${WB_TRACED_TOTAL_BUDGET}-command traced-asset budget`],
    };
  }

  // W3 — the same validator the SVG path runs: single-subpath, no
  // teleport, no self-crossing, sane caps (the split law's purpose).
  const report = validateAsset(asset);
  if (!report.ok) {
    return { ok: false, errors: report.findings.map((f) => f.reason ?? "invalid stroke geometry") };
  }

  return { ok: true, asset, paths: ex.paths.length, texts: 0, commands, trace: result.receipt };
}

/** The ONE unified entry the route calls: sniff once, dispatch to the SVG
 *  or raster validator. Non-raster non-UTF-8 bytes (a WebP, a PDF, a zip)
 *  get the honest format list instead of the bare UTF-8 message. */
export async function validateUpload(
  raw: Buffer,
  filename: string,
  reservedIds: ReadonlySet<string> = new Set()
): Promise<UploadValidation> {
  if (raw.length === 0) return { ok: false, errors: ["the file is empty"] };
  if (sniffRasterImage(raw)) return validateUploadedRaster(raw, filename, reservedIds);
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return {
      ok: false,
      errors: ["only PNG, JPEG or SVG files are supported — this file is neither valid raster magic nor UTF-8 text"],
    };
  }
  return validateUploadedSvg(raw, filename, reservedIds);
}
