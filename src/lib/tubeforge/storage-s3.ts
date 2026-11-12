// S3 driver (S106 / P1.2 extraction) — the zero-dependency SigV4 signer
// behind storage.ts's s3 mode: config from TUBEFORGE_S3_* env, request
// signing, presigned GETs, and the fetch envelope. Works with AWS S3,
// Cloudflare R2 and MinIO (path-style addressing). Pure crypto + fetch —
// no storage/quota imports (the dependency arrow points one way: the
// facade imports THIS, never the reverse).

import { createHash, createHmac } from "crypto";

export interface S3Config {
  bucket: string;
  region: string;
  endpoint: string; // origin only, e.g. https://acct.r2.cloudflarestorage.com
  accessKeyId: string;
  secretAccessKey: string;
}

export function s3Config(): S3Config | null {
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

  // Keys arrive PRE-NORMALIZED — the facade normalizes every key at its
  // boundary (normalizeKey); the signer must not re-import the facade.
  const encodedKey = encodeS3Key(key);
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

/** Presigned GET URL (query-string signature — no Authorization header).
 *  The key must arrive pre-normalized (the facade guarantees it). */
export function s3Presign(cfg: S3Config, key: string, ttlSeconds: number): string {
  const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);
  const host = new URL(cfg.endpoint).host;

  const canonicalUri = `/${cfg.bucket}/${encodeS3Key(key)}`;
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

export async function s3Fetch(
  method: string,
  key: string,
  cfg: S3Config,
  body?: Buffer,
  extraQuery?: Record<string, string>
): Promise<Response> {
  const { url, headers } = sigv4Headers(cfg, method, key, body ?? Buffer.alloc(0), extraQuery);
  return fetch(url, { method, headers, body: body ? new Uint8Array(body) : undefined });
}
