// Key-based storage abstraction (Stage 3, T-3.7 — closes the local-FS blocker).
//
// Keys are POSIX-style relative paths and intentionally mirror the historical
// uploads/ layout 1:1 ("<videoId>/final.mp4", "_music/track-128.mp3",
// "_voicepreviews/<hash>.wav"). The LocalDisk driver maps key →
// <root>/<key>, so existing installs keep working with ZERO data migration;
// flipping TUBEFORGE_STORAGE_DRIVER=s3 switches delivery to object storage
// without touching call sites again.
//
// Drivers:
//   local (default) — root = TUBEFORGE_UPLOAD_ROOT || <cwd>/uploads
//   s3              — TUBEFORGE_S3_* env; ZERO-DEPENDENCY SigV4 signer over
//                     fetch(). Works with AWS S3, Cloudflare R2 and MinIO
//                     (path-style addressing). presign() returns a signed GET
//                     URL so the client downloads straight from the CDN/edge,
//                     which closes D-23/D-24 the ROADMAP way.
//
// Quotas (ROADMAP "Storage quotas"): every non-system put() passes through an
// ATOMIC quota admission (S101 / P0.3) — the ceiling check and a durable
// in-flight hold (StorageReservation row) land in ONE serializable
// transaction, so two concurrent uploads can never both pass, and a crash
// mid-upload leaves a hold the expiry sweep reclaims. The per-organization
// byte counter lives in StorageUsage — O(1) on both drivers. `system: true`
// marks platform assets (music library seed, bundled fonts) that must not
// burn user quota.
//
// ffmpeg constraint: encoders need seekable file PATHS, not streams. Render
// pipelines therefore write to a scratch dir and finish with putFromPath();
// consumers that need a path (ffmpeg inputs, Playwright screenshot targets)
// use withLocalFile()/materialize() — a zero-copy passthrough on local, a
// content-hash-cached download on s3.

import { createHash } from "crypto";
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { Readable } from "stream";
import { currentCtx } from "./tenant";
import { s3Config, s3Fetch, s3Presign } from "./storage-s3";
import { bumpUsage, reserveStorageBytes, storageQuotaBytes, type StoragePutReservation } from "./storage-quota";

// The two extracted halves re-export through the facade — every existing
// importer of "./storage" keeps its import sites unchanged.
export {
  storageQuotaBytes,
  StorageQuotaError,
  usageBytes,
  reserveStorageBytes,
  sweepExpiredStorageReservations,
  type StoragePutReservation,
} from "./storage-quota";
import { log } from "./log";

// ---------------------------------------------------------------------------
// Configuration

export type StorageDriverKind = "local" | "s3";

export function storageDriverKind(): StorageDriverKind {
  return process.env.TUBEFORGE_STORAGE_DRIVER === "s3" ? "s3" : "local";
}

/** Local root — also the scratch root for generated artifacts (both drivers). */
export const UPLOAD_ROOT = process.env.TUBEFORGE_UPLOAD_ROOT
  ? path.resolve(process.env.TUBEFORGE_UPLOAD_ROOT)
  : path.join(process.cwd(), "uploads");


export interface PutOptions {
  /** Platform asset (music library seed, fonts) — skips the org quota. */
  system?: boolean;
  /** Known size when data is a stream (unused for Buffer inputs). */
}

export interface StatResult {
  size: number;
  mtime: Date;
}

// ---------------------------------------------------------------------------
// Key hygiene

/** Normalize + guard a storage key (no absolute paths, no "..", no drive letters). */
export function normalizeKey(key: string): string {
  const parts = key.split(/[\\/]+/).filter((p) => p.length > 0 && p !== ".");
  if (parts.some((p) => p === "..")) throw new Error(`storage: illegal key "${key}"`);
  const norm = parts.join("/");
  if (!norm) throw new Error("storage: empty key");
  return norm;
}

// ---------------------------------------------------------------------------
// Local disk driver

function localPathForKey(key: string): string {
  return path.join(UPLOAD_ROOT, ...normalizeKey(key).split("/"));
}

async function ensureDirFor(file: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
}


const S3_CACHE = process.env.TUBEFORGE_S3_CACHE_DIR
  ? path.resolve(process.env.TUBEFORGE_S3_CACHE_DIR)
  : path.join(os.tmpdir(), "tubeforge-s3-cache");

function cacheFileFor(key: string, etag: string): string {
  const h = createHash("sha256").update(key).digest("hex").slice(0, 32);
  const last = normalizeKey(key).split("/").pop() ?? "object";
  const safe = last.replace(/[^\w.-]/g, "_");
  return path.join(S3_CACHE, `${h}-${etag.replace(/[^\w-]/g, "")}-${safe}`);
}

/** Ensure key exists as a local file; returns its path (cached). Local: passthrough. */
export async function materialize(key: string): Promise<string> {
  const k = normalizeKey(key);
  if (storageDriverKind() === "local") return localPathForKey(k);

  const cfg = s3Config();
  if (!cfg) throw new Error("storage: s3 driver selected but TUBEFORGE_S3_* env is incomplete");

  const head = await s3Fetch("HEAD", k, cfg);
  if (head.status === 404) throw new Error(`storage: missing object "${k}"`);
  if (!head.ok) throw new Error(`storage: HEAD "${k}" → ${head.status}`);
  const etag = head.headers.get("etag") ?? "none";

  const dest = cacheFileFor(k, etag);
  if (fs.existsSync(dest)) return dest; // cache hit (etag-pinned)

  const res = await s3Fetch("GET", k, cfg);
  if (!res.ok) throw new Error(`storage: GET "${k}" → ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await ensureDirFor(dest);
  await fsp.writeFile(dest, buf);
  return dest;
}

/**
 * Run fn(filePath) with the key available on local disk. Local driver: the
 * real uploads/ path, zero copies. s3: materialized cache path.
 */
export async function withLocalFile<T>(key: string, fn: (filePath: string) => Promise<T>): Promise<T> {
  const p = await materialize(key);
  return fn(p);
}

// ---------------------------------------------------------------------------
// Public API

export async function put(key: string, data: Buffer | Uint8Array, opts: PutOptions = {}): Promise<void> {
  const k = normalizeKey(key);
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const kind = storageDriverKind();

  // quota — system assets skip; otherwise attribute to the acting org.
  // S101: admission is ATOMIC (ceiling check + durable hold in one
  // serialized transaction) and the hold settles at the REAL byte count
  // after the object lands; a failed upload releases its hold.
  let reservation: StoragePutReservation | null = null;
  if (!opts.system) {
    const ctx = currentCtx();
    if (ctx) {
      const prior = await stat(k);
      reservation = await reserveStorageBytes(ctx.organizationId, k, buf.length, prior ? prior.size : 0);
    }
  }

  try {
    if (kind === "s3") {
      const cfg = s3Config();
      if (!cfg) throw new Error("storage: s3 driver selected but TUBEFORGE_S3_* env is incomplete");
      const res = await s3Fetch("PUT", k, cfg, buf);
      if (!res.ok) throw new Error(`storage: PUT "${k}" → ${res.status} ${await res.text().catch(() => "")}`);
    } else {
      const dest = localPathForKey(k);
      await ensureDirFor(dest);
      await fsp.writeFile(dest, buf);
    }
  } catch (err) {
    await reservation?.release().catch(() => {}); // the failed upload frees its hold
    throw err;
  }

  await reservation?.commit(buf.length);
}

/**
 * Move/copy a locally generated artifact (ffmpeg output, Playwright
 * screenshot) into storage. Local driver: a fast same-volume rename when
 * possible. `system` follows put() semantics.
 */
export async function putFromPath(key: string, localFile: string, opts: PutOptions = {}): Promise<void> {
  const k = normalizeKey(key);
  const size = (await fsp.stat(localFile)).size;

  // S101 — the same atomic admission as put(): hold first, write second,
  // settle the real size third; the write failing releases the hold.
  let reservation: StoragePutReservation | null = null;
  if (!opts.system) {
    const ctx = currentCtx();
    if (ctx) {
      const prior = await stat(k);
      reservation = await reserveStorageBytes(ctx.organizationId, k, size, prior ? prior.size : 0);
    }
  }

  try {
    if (storageDriverKind() === "s3") {
      const cfg = s3Config();
      if (!cfg) throw new Error("storage: s3 driver selected but TUBEFORGE_S3_* env is incomplete");
      const buf = await fsp.readFile(localFile);
      const res = await s3Fetch("PUT", k, cfg, buf);
      if (!res.ok) throw new Error(`storage: PUT "${k}" → ${res.status}`);
      // The scratch copy STAYS: downstream pipeline steps (QC probe, Short
      // cutting, ffmpeg re-reads) hit the local cache instead of re-fetching
      // from the bucket. Scratch lifetime is a deployment concern (tmp cleaner
      // or TUBEFORGE_SCRATCH_ROOT on a scratch volume).
    } else {
      const dest = localPathForKey(k);
      if (path.resolve(localFile) === path.resolve(dest)) {
        // artifact already written straight into the uploads layout (ffmpeg
        // wrote final.mp4 into videoDir) — nothing to move, only account it.
      } else {
        await ensureDirFor(dest);
        if (path.dirname(localFile) === path.dirname(dest)) {
          await fsp.rename(localFile, dest);
        } else {
          await fsp.copyFile(localFile, dest);
          await fsp.rm(localFile, { force: true });
        }
      }
    }
  } catch (err) {
    await reservation?.release().catch(() => {}); // the failed upload frees its hold
    throw err;
  }

  await reservation?.commit(size);
}

export async function get(key: string): Promise<Buffer> {
  const k = normalizeKey(key);
  if (storageDriverKind() === "s3") {
    const cfg = s3Config();
    if (!cfg) throw new Error("storage: s3 driver selected but TUBEFORGE_S3_* env is incomplete");
    const res = await s3Fetch("GET", k, cfg);
    if (res.status === 404) throw new Error(`storage: missing object "${k}"`);
    if (!res.ok) throw new Error(`storage: GET "${k}" → ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  return fsp.readFile(localPathForKey(k));
}

/** Web ReadableStream for HTTP delivery; optional byte range [start, end] inclusive. */
export async function readStream(key: string, range?: { start: number; end: number }): Promise<ReadableStream<Uint8Array>> {
  const k = normalizeKey(key);
  if (storageDriverKind() === "s3") {
    const cfg = s3Config();
    if (!cfg) throw new Error("storage: s3 driver selected but TUBEFORGE_S3_* env is incomplete");
    const res = await (range
      ? fetch(s3Presign(cfg, k, 300), { headers: { Range: `bytes=${range.start}-${range.end}` } })
      : fetch(s3Presign(cfg, k, 300)));
    const r = await res;
    if (!r.ok && r.status !== 206) throw new Error(`storage: GET "${k}" → ${r.status}`);
    if (!r.body) throw new Error(`storage: empty body for "${k}"`);
    return r.body as ReadableStream<Uint8Array>;
  }
  const nodeStream = fs.createReadStream(localPathForKey(k), range ? { start: range.start, end: range.end } : undefined);
  return Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>;
}

export async function stat(key: string): Promise<StatResult | null> {
  const k = normalizeKey(key);
  if (storageDriverKind() === "s3") {
    const cfg = s3Config();
    if (!cfg) return null;
    const res = await s3Fetch("HEAD", k, cfg);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`storage: HEAD "${k}" → ${res.status}`);
    const len = res.headers.get("content-length");
    const lastMod = res.headers.get("last-modified");
    return { size: len ? Number(len) : 0, mtime: lastMod ? new Date(lastMod) : new Date() };
  }
  try {
    const s = await fsp.stat(localPathForKey(k));
    return { size: s.size, mtime: s.mtime };
  } catch {
    return null;
  }
}

export async function exists(key: string): Promise<boolean> {
  return (await stat(key)) !== null;
}

/**
 * List every object key under a prefix (Stage 4a, T-4.0). Backs targeted
 * invalidation passes (render.ts, the script-edit route) and directory-style
 * reads (character pose sheets) — patterns the raw-fs code used readdir for.
 * Local driver: recursive readdir. s3: ListObjectsV2 with continuation tokens.
 * A missing prefix is an empty list, never an error.
 */
export async function list(prefix: string): Promise<string[]> {
  const p = normalizeKey(prefix);
  if (storageDriverKind() === "local") {
    const target = localPathForKey(p);
    const out: string[] = [];
    try {
      for (const f of await fsp.readdir(target, { recursive: true, withFileTypes: true })) {
        if (f.isFile()) {
          const rel = path.relative(target, path.join(f.parentPath, f.name)).split(path.sep).join("/");
          out.push(`${p}/${rel}`);
        }
      }
    } catch {
      /* prefix absent — empty list */
    }
    return out;
  }

  const cfg = s3Config();
  if (!cfg) throw new Error("storage: s3 driver selected but TUBEFORGE_S3_* env is incomplete");
  const keys: string[] = [];
  let token: string | null = null;
  for (;;) {
    let url = `${cfg.endpoint}/${cfg.bucket}?list-type=2&prefix=${encodeURIComponent(p + "/")}&max-keys=1000`;
    if (token) url += `&continuation-token=${encodeURIComponent(token)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`storage: LIST "${p}" → ${res.status}`);
    const text = await res.text();
    for (const m of text.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(decodeURIComponent(m[1]));
    const next = text.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
    if (!next) break;
    token = next[1];
  }
  return keys;
}

export async function remove(key: string): Promise<void> {
  const k = normalizeKey(key);
  const prior = await stat(k);
  if (storageDriverKind() === "s3") {
    const cfg = s3Config();
    if (!cfg) throw new Error("storage: s3 driver selected but TUBEFORGE_S3_* env is incomplete");
    const res = await s3Fetch("DELETE", k, cfg);
    if (!res.ok && res.status !== 404) throw new Error(`storage: DELETE "${k}" → ${res.status}`);
  } else {
    await fsp.rm(localPathForKey(k), { force: true });
  }
  const ctx = currentCtx();
  if (ctx && prior) await bumpUsage(ctx.organizationId, -prior.size);
}

/** Wipe every object under a prefix (DELETE /api/videos/[id] cleanup). */
export async function removePrefix(prefix: string): Promise<number> {
  const p = normalizeKey(prefix);
  if (storageDriverKind() === "local") {
    const target = localPathForKey(p);
    let bytes = 0;
    try {
      for (const f of await fsp.readdir(target, { recursive: true, withFileTypes: true })) {
        if (f.isFile()) bytes += (await fsp.stat(path.join(f.parentPath, f.name))).size;
      }
      await fsp.rm(target, { recursive: true, force: true });
    } catch {
      /* already gone */
    }
    const ctx = currentCtx();
    if (ctx && bytes > 0) await bumpUsage(ctx.organizationId, -bytes);
    return bytes;
  }

  // s3 — delete-by-prefix. Continuation-token listing via ListObjectsV2.
  const cfg = s3Config();
  if (!cfg) throw new Error("storage: s3 driver selected but TUBEFORGE_S3_* env is incomplete");
  let removed = 0;
  for (;;) {
    const listRes = await fetch(
      `${cfg.endpoint}/${cfg.bucket}?list-type=2&prefix=${encodeURIComponent(p + "/")}&max-keys=1000`
    );
    if (!listRes.ok) throw new Error(`storage: LIST "${p}" → ${listRes.status}`);
    const text = await listRes.text();
    const keys = [...text.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
    if (!keys.length) break;
    for (const objectKey of keys) {
      const res = await s3Fetch("DELETE", decodeURIComponent(objectKey), cfg);
      if (res.ok || res.status === 404) removed += 1;
    }
    if (!/<IsTruncated>true<\/IsTruncated>/.test(text)) break;
  }
  return removed;
}

/**
 * Signed GET URL for direct client delivery (ROADMAP: mp4/export redirect to
 * presigned URLs so bytes never transit the app). Returns null when the
 * driver cannot presign (local) — callers then stream via readStream().
 */
export async function presign(key: string, ttlSeconds = 900): Promise<string | null> {
  if (storageDriverKind() !== "s3") return null;
  const cfg = s3Config();
  if (!cfg) return null;
  return s3Presign(cfg, normalizeKey(key), ttlSeconds);
}

// ---------------------------------------------------------------------------
// Diagnostics

/**
 * Render workspace (ffmpeg playground). Local driver: the uploads dir itself
 * (videoDir keeps its historical behavior — zero churn). s3 driver: a local
 * scratch dir — the pipeline writes there and uploads finished artifacts with
 * putFromPath(); inputs are materialized with materialize()/withLocalFile().
 */
export function scratchDir(name: string): string {
  const root =
    storageDriverKind() === "s3"
      ? process.env.TUBEFORGE_SCRATCH_ROOT
        ? path.resolve(process.env.TUBEFORGE_SCRATCH_ROOT)
        : path.join(os.tmpdir(), "tubeforge-scratch")
      : UPLOAD_ROOT;
  const dir = path.join(root, ...normalizeKey(name).split("/"));
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch {
    // Read-only filesystem (e.g. Vercel serverless /var/task): return the
    // path anyway. This function is called at MODULE EVALUATION (music.ts's
    // MUSIC_DIR) — a throw here killed every cold start on Vercel and took
    // the whole deployment down with it (see instrumentation.ts). Callers
    // that genuinely WRITE fail loudly at write time instead; on serverless
    // the s3 driver + /tmp scratch is the supported configuration.
  }
  return dir;
}

export function storageInfo(): {
  driver: StorageDriverKind;
  root: string;
  quotaBytes: number;
  s3Configured: boolean;
} {
  return {
    driver: storageDriverKind(),
    root: UPLOAD_ROOT,
    quotaBytes: storageQuotaBytes(),
    s3Configured: s3Config() !== null,
  };
}

const storageLog = log.child({ mod: "storage" });
storageLog.debug("storage layer initialized", { ...storageInfo() });
