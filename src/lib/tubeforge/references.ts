// S51 — the reference-image seam. `Character.referenceImages` shipped in the
// Stage 5 migration with a reader (runContinuityCheck) but no writer;
// `Location.referenceImages` / `Prop.referenceImages` had neither. This module
// is the ONE shared landing for all three libraries: validation, HEIC decode,
// ffmpeg normalization, storage keys, and the JSON-array contract.
//
// The JSON column holds a stringified array of storage keys, OLDEST FIRST —
// the array order is the truth (keys are just addresses). The newest
// reference (last element) is the generation seed: characters derive their
// portrait from it, locations seed their scene edits with it.

import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { sniffImageFormat, decodeHeicPng } from "./image-upload";
import * as storage from "./storage";

const execFileAsync = promisify(execFile);

/** Same class of guard the Scene Studio upload takes (slightly tighter —
 *  reference photos never need 4K). */
export const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;

/** References ride VLM checks as base64 and edit requests as seeds — a long
 *  edge of 1024 keeps both lean without losing identity detail. Never
 *  upscales: smaller originals pass through at their own size. */
export const REFERENCE_LONG_EDGE = 1024;

/** Per-library caps. Characters are the deepest library (identity); world
 *  items are recurring set pieces — four angles is plenty. */
export const CHARACTER_REFERENCE_CAP = 6;
export const WORLD_REFERENCE_CAP = 4;

/** Parse the JSON column defensively — a corrupt/legacy value reads as "no
 *  references", never as a crash (the same fail-open law the pipeline's
 *  other JSON columns follow). */
export function parseReferenceKeys(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

/** A reference key is valid for a prefix when it lives INSIDE that prefix and
 *  matches the ref file pattern — the DELETE route's first line of defense
 *  against path tricks (`?key=../../...` dies here). */
export function isReferenceKey(prefix: string, key: string): boolean {
  return key === `${prefix}/${referenceFileFromKey(key)}` && /^ref-\d+\.png$/.test(key.slice(prefix.length + 1));
}

function referenceFileFromKey(key: string): string {
  return key.split("/").pop() ?? "";
}

/** Allocate the next storage key: the LOWEST unused slot. With the array
 *  capped, pigeonhole keeps indices within [1..cap] forever — deleted slots
 *  get reused, the column never grows unbounded numbers. */
export function nextReferenceKey(prefix: string, existing: string[]): string {
  const used = new Set(existing.map((k) => referenceFileFromKey(k)));
  for (let i = 1; i <= existing.length + 1; i++) {
    const file = `ref-${i}.png`;
    if (!used.has(file)) return `${prefix}/${file}`;
  }
  throw new Error("reference slot exhaustion"); // unreachable with the caps
}

/** Validate + normalize one uploaded reference: sniff the format (PNG/JPEG/
 *  WebP/HEIC — the S43 catalog), decode HEIC via the WASM pass, then scale
 *  the long edge down to REFERENCE_LONG_EDGE and re-encode as PNG so every
 *  consumer (VLM base64, edit seeds, the GET routes) sees one shape.
 *  Returns the stored key + written bytes. */
export async function saveReferenceImage(
  prefix: string,
  existingKeys: string[],
  upload: Buffer
): Promise<{ key: string; bytes: number }> {
  if (upload.length < 1000) throw new Error("That file is too small to be a real image");
  if (upload.length > MAX_REFERENCE_BYTES)
    throw new Error(`Image exceeds the ${MAX_REFERENCE_BYTES / 1024 / 1024} MB limit`);
  const sniffed = sniffImageFormat(upload);
  if (!sniffed)
    throw new Error("Unsupported image — upload a PNG, JPEG, WebP or HEIC file");

  const input = sniffed === "heic" ? await decodeHeicPng(upload) : upload;
  const key = nextReferenceKey(prefix, existingKeys);

  const tmpIn = path.join(os.tmpdir(), `tf-ref-in-${Date.now()}-${process.pid}`);
  const tmpOut = path.join(os.tmpdir(), `tf-ref-out-${Date.now()}-${process.pid}.png`);
  fs.writeFileSync(tmpIn, input);
  try {
    // min(iw,edge) boxes the target so small originals pass through at
    // their own size; decrease preserves the aspect ratio.
    await execFileAsync(
      "ffmpeg",
      [
        "-y", "-i", tmpIn,
        "-vf",
        `scale=w='min(iw,${REFERENCE_LONG_EDGE})':h='min(ih,${REFERENCE_LONG_EDGE})':force_original_aspect_ratio=decrease,setsar=1`,
        "-frames:v", "1",
        tmpOut,
      ],
      { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }
    );
    const normalized = fs.readFileSync(tmpOut);
    if (normalized.length < 1000) throw new Error("Could not process that image — the file may be corrupt");
    await storage.put(key, normalized);
    return { key, bytes: normalized.length };
  } finally {
    fs.rmSync(tmpIn, { force: true });
    fs.rmSync(tmpOut, { force: true });
  }
}

/** Remove one reference's file from storage. Best-effort on the file itself
 *  (the column is the truth; a missing file just reads as absent). */
export async function removeReferenceFile(key: string): Promise<void> {
  await storage.remove(key).catch(() => {});
}

/** Stat every key against storage for the list routes (missing files are
 *  reported with bytes 0 — surfaced, not hidden). */
export async function referenceInfos(
  keys: string[],
  urlFor: (key: string) => string
): Promise<{ key: string; url: string; bytes: number }[]> {
  const out: { key: string; url: string; bytes: number }[] = [];
  for (const key of keys) {
    const stat = await storage.stat(key).catch(() => null);
    out.push({ key, url: urlFor(key), bytes: stat?.size ?? 0 });
  }
  return out;
}
