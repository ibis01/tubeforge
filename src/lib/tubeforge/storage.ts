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

import { createHash, createHmac, randomUUID } from "crypto";
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { Readable } from "stream";
import { rawDatabase as rawDb } from "./tenant-db";
import { Prisma } from "@prisma/client";
import { currentCtx } from "./tenant";
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

/** Per-organization quota ceiling. Default 10 GiB; 0 = unlimited. */
export function storageQuotaBytes(): number {
  const gb = Number(process.env.TUBEFORGE_STORAGE_QUOTA_GB ?? "");
  if (!Number.isFinite(gb) || gb <= 0) return 10 * 1024 ** 3;
  return Math.floor(gb * 1024 ** 3);
}

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

// ---------------------------------------------------------------------------
// S3 driver — zero-dependency SigV4

interface S3Config {
  bucket: string;
  region: string;
  endpoint: string; // origin only, e.g. https://acct.r2.cloudflarestorage.com
  accessKeyId: string;
  secretAccessKey: string;
}

function s3Config(): S3Config | null {
  const bucket = process.env.TUBEFORGE_S3_BUCKET;
  const accessKeyId = process.env.TUBEFORGE_S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.TUBEFORGE_S3_SECRET_ACCESS_KEY;
  if (!bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    bucket,
    region: process.env.TUBEFORGE_S3_REGION ?? "auto",
    endpoint: (process.env.TUBEFORGE_S3_ENDPOINT ?? `https://s3.${process.env.TUBEFORGE_S3_REGION ?? "auto"}.amazonaws.com`).replace(/\/+$/, ""),
    accessKeyId,
    secretAccessKey,
  };
}

/** S3 key encoding: encode everything except unreserved chars and "/". */
function encodeS3Key(key: string): string {
  return key
    .split("/")
    .map((seg) =>
      seg
        .split("")
        .map((ch) => {
          const code = ch.charCodeAt(0);
          const unreserved =
            (code >= 0x41 && code <= 0x5a) || // A-Z
            (code >= 0x61 && code <= 0x7a) || // a-z
            (code >= 0x30 && code <= 0x39) || // 0-9
            "-._~".includes(ch);
          return unreserved ? ch : `%${code.toString(16).toUpperCase().padStart(2, "0")}`;
        })
        .join("")
    )
    .join("/");
}

const sha256Hex = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data).digest();

function sigv4Headers(
  cfg: S3Config,
  method: string,
  key: string,
  payload: Buffer | string,
  extraQuery: Record<string, string> = {}
): { url: string; headers: Record<string, string> } {
  const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(payload);
  const host = new URL(cfg.endpoint).host;

  const encodedKey = encodeS3Key(normalizeKey(key));
  const canonicalUri = `/${cfg.bucket}/${encodedKey}`;

  const query: Record<string, string> = { ...extraQuery };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`)
    .join("&");

  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const signedHeaders = Object.keys(headers).sort().join(";");
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map((k) => `${k}:${headers[k]}\n`)
    .join("");

  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

  const kDate = hmac(`AWS4${cfg.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, cfg.region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  headers["authorization"] =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const qs = canonicalQuery ? `?${canonicalQuery}` : "";
  return { url: `${cfg.endpoint}${canonicalUri}${qs}`, headers };
}

/** Presigned GET URL (query-string signature — no Authorization header). */
function s3Presign(cfg: S3Config, key: string, ttlSeconds: number): string {
  const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);
  const host = new URL(cfg.endpoint).host;

  const canonicalUri = `/${cfg.bucket}/${encodeS3Key(normalizeKey(key))}`;
  const query: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${cfg.accessKeyId}/${dateStamp}/${cfg.region}/s3/aws4_request`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(Math.max(1, Math.min(ttlSeconds, 7 * 24 * 3600))),
    "X-Amz-SignedHeaders": "host",
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`)
    .join("&");

  const canonicalRequest = ["GET", canonicalUri, canonicalQuery, `host:${host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

  const kDate = hmac(`AWS4${cfg.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, cfg.region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

  return `${cfg.endpoint}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

async function s3Fetch(
  method: string,
  key: string,
  cfg: S3Config,
  body?: Buffer,
  extraQuery?: Record<string, string>
): Promise<Response> {
  const { url, headers } = sigv4Headers(cfg, method, key, body ?? Buffer.alloc(0), extraQuery);
  return fetch(url, { method, headers, body: body ? new Uint8Array(body) : undefined });
}

// ---------------------------------------------------------------------------
// S3 materialize cache — ffmpeg/Playwright need real paths.

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
// Quota accounting (StorageUsage — per-org byte counter)

export class StorageQuotaError extends Error {
  constructor(public readonly organizationId: string, public readonly used: number, public readonly quota: number) {
    super(`Storage quota exceeded for organization (${used} of ${quota} bytes) — delete old videos or ask an admin to raise the cap.`);
    this.name = "StorageQuotaError";
  }
}

async function currentUsage(orgId: string): Promise<number> {
  const row = await rawDb.storageUsage.findUnique({ where: { organizationId: orgId } });
  return row ? Number(row.bytes) : 0;
}

/** Org usage in bytes (0 when the driver-level quota is disabled). */
export async function usageBytes(orgId: string): Promise<number> {
  return currentUsage(orgId);
}

async function bumpUsage(orgId: string, delta: number): Promise<void> {
  await rawDb.storageUsage.upsert({
    where: { organizationId: orgId },
    update: { bytes: { increment: delta } },
    create: { organizationId: orgId, bytes: BigInt(Math.max(0, delta)) },
  });
}

// ---------------------------------------------------------------------------
// Reservations (S101 / P0.3 — atomic quota admission with durable holds)
//
// The old flow was read-check-write-write: assertQuota read the counter, the
// object was written, bumpUsage moved the counter AFTER the bytes landed —
// two concurrent uploads could both pass the check and exceed the org cap.
// Admission is now ONE serializable transaction (Serializable on Postgres;
// SQLite is single-writer — the S32 spend-admission pattern): read the
// committed counter, sum the org's live holds, check the ceiling, insert
// THIS upload's hold. The DB serializes the racers — the loser sees the
// winner's hold and is refused.
//
// Counter semantics: StorageUsage.bytes counts COMMITTED bytes only. A hold
// is the durable record of in-flight bytes: a process that dies between
// admission and settle leaves the hold behind, and sweepExpiredStorage
// Reservations() drops it — a hold never moved the committed counter, so
// dropping one always frees exactly the bytes it reserved. Settle (the
// object landed) deletes the hold and moves the REAL delta (actual -
// replaces) into the counter, atomically with the hold's removal.

function reservationTtlMs(): number {
  const v = Number(process.env.TUBEFORGE_STORAGE_RESERVATION_TTL_MS ?? "");
  return Number.isFinite(v) && v > 0 ? v : 60 * 60_000;
}

export interface StoragePutReservation {
  /** The upload failed — drop the hold (quota freed). Idempotent. */
  release(): Promise<void>;
  /** The object landed — settle the REAL byte delta and drop the hold. */
  commit(actualBytes: number): Promise<void>;
}

/** Serializable on Postgres with P2034 conflict retry; default on SQLite. */
async function storageAdmissionTx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const serializable = !`${process.env.DATABASE_URL ?? ""}`.startsWith("file:");
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await rawDb.$transaction(fn, serializable ? { isolationLevel: "Serializable" } : undefined);
    } catch (err) {
      // P2034 — the transaction conflict Serializable exists to produce.
      // Retry against the winner's committed rows (spend.ts's
      // admitWithConflictRetry law).
      if ((err as { code?: string })?.code === "P2034" && attempt < 4) {
        await new Promise((r) => setTimeout(r, 25 * attempt));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Atomically admit `incomingBytes` for an org (accounting for `replacesBytes`
 * freed by an overwrite) and return the hold that settles or releases it.
 * Throws StorageQuotaError when the ceiling would be crossed — concurrently
 * SAFE: the check and the hold are one serialized transaction.
 */
export async function reserveStorageBytes(
  organizationId: string,
  key: string,
  incomingBytes: number,
  replacesBytes: number,
  ttlMs: number = reservationTtlMs(),
): Promise<StoragePutReservation> {
  const quota = storageQuotaBytes();

  // Quota disabled — no admission gate, but the counter still tracks real bytes.
  if (quota <= 0) {
    return {
      release: async () => {},
      commit: async (actual) => {
        if (actual - replacesBytes !== 0) await bumpUsage(organizationId, actual - replacesBytes);
      },
    };
  }

  const holdId = `stor-${randomUUID()}`;
  await storageAdmissionTx(async (tx) => {
    // Write FIRST: ensure the counter row exists (an org's FIRST upload has
    // none). On SQLite this takes the database write lock at transaction
    // open, so concurrent admissions serialize HERE — the loser's reads see
    // the winner's hold. On Postgres the Serializable snapshot does the
    // same job; the upsert also guarantees the counter row the settle path
    // increments actually exists.
    await tx.storageUsage.upsert({
      where: { organizationId },
      update: {},
      create: { organizationId, bytes: 0 },
    });
    const [usage, holds] = await Promise.all([
      tx.storageUsage.findUnique({ where: { organizationId } }),
      tx.storageReservation.aggregate({
        _sum: { bytes: true },
        where: { organizationId, expiresAt: { gt: new Date() } }, // LIVE holds only
      }),
    ]);
    const committed = usage ? Number(usage.bytes) : 0;
    const inFlight = holds._sum.bytes ? Number(holds._sum.bytes) : 0;
    if (committed + inFlight - replacesBytes + Math.max(0, incomingBytes) > quota) {
      throw new StorageQuotaError(organizationId, committed + inFlight, quota);
    }
    await tx.storageReservation.create({
      data: {
        id: holdId,
        organizationId,
        key,
        bytes: BigInt(Math.max(0, incomingBytes)),
        expiresAt: new Date(Date.now() + ttlMs),
      },
    });
  });

  return {
    release: async () => {
      await rawDb.storageReservation.deleteMany({ where: { id: holdId } });
    },
    commit: async (actual) => {
      // Settle atomically: the hold comes off and the REAL delta lands in
      // the counter in one transaction (a crash cannot split them).
      const delta = actual - replacesBytes;
      await storageAdmissionTx(async (tx) => {
        await tx.storageReservation.deleteMany({ where: { id: holdId } });
        if (delta !== 0) {
          await tx.storageUsage.upsert({
            where: { organizationId },
            update: { bytes: { increment: delta } },
            create: { organizationId, bytes: BigInt(Math.max(0, delta)) },
          });
        }
      });
    },
  };
}

/** Drop every expired hold (crashed uploaders' TTL passed). Holds never
 *  moved the committed counter, so dropping is pure quota reclaim. */
export async function sweepExpiredStorageReservations(): Promise<number> {
  const rows = await rawDb.storageReservation.findMany({
    where: { expiresAt: { lt: new Date() } },
    select: { id: true },
    take: 200,
  });
  for (const r of rows) {
    await rawDb.storageReservation.deleteMany({ where: { id: r.id } }).catch(() => {});
  }
  if (rows.length) log.info("storage: expired reservations swept (quota freed)", { count: rows.length });
  return rows.length;
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
