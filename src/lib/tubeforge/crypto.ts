// At-rest secret encryption (AES-256-GCM) + token hashing.
//
// Used for ProviderCredential.apiKey, YouTubeAccount.refreshToken/accessToken
// and any other column that must never sit in the database in plaintext.
// Key source: TUBEFORGE_ENCRYPTION_KEY (>= 16 chars) in .env — see .env.example.
// The key is stretched with scrypt into a 32-byte AES key; every value carries
// its own random 12-byte IV, so identical plaintexts never share ciphertext.
//
// Encrypted format (all base64url):
//   v1.<iv>.<gcm-tag>.<ciphertext>
//
// sha256Hex() is for one-time tokens (email verification / password reset):
// only the hash is stored; the raw token lives in the link alone.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from "node:crypto";

const PREFIX = "v1.";
const SCRYPT_SALT = "tubeforge-at-rest-v1"; // static KDF salt — per-record IVs carry the randomness
const KEY_CACHE = (globalThis as typeof globalThis & { __tfEncKey?: Buffer }).__tfEncKey;

function requireKey(): Buffer {
  const g = globalThis as typeof globalThis & { __tfEncKey?: Buffer };
  if (g.__tfEncKey) return g.__tfEncKey;
  const raw = process.env.TUBEFORGE_ENCRYPTION_KEY ?? "";
  if (raw.length < 16) {
    throw new Error(
      "TUBEFORGE_ENCRYPTION_KEY is missing or too short (<16 chars) — secrets cannot be encrypted. Set it in .env (see .env.example); rotating it invalidates stored secrets."
    );
  }
  const key = scryptSync(raw, SCRYPT_SALT, 32);
  g.__tfEncKey = key;
  return key;
}

function toB64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

/** Encrypt a secret for storage. Fails closed when the key is missing. */
export function encryptSecret(plaintext: string): string {
  const key = requireKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${toB64url(iv)}.${toB64url(tag)}.${toB64url(ct)}`;
}

/** Decrypt a stored secret. Throws on tampering (GCM tag) or bad format. */
export function decryptSecret(stored: string): string {
  if (!stored.startsWith(PREFIX)) {
    throw new Error("Malformed encrypted value (expected v1. prefix)");
  }
  const [iv, tag, ct] = stored.slice(PREFIX.length).split(".");
  if (!iv || !tag || !ct) throw new Error("Malformed encrypted value (truncated)");
  const key = requireKey();
  const decipher = createDecipheriv("aes-256-gcm", key, fromB64url(iv));
  decipher.setAuthTag(fromB64url(tag));
  const plain = Buffer.concat([
    decipher.update(fromB64url(ct)),
    decipher.final(),
  ]);
  return plain.toString("utf8");
}

/** True when the value looks like an encrypted secret (v1. format). */
export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(PREFIX);
}

/** SHA-256 hex digest — for storing one-time tokens (verify/reset links). */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Random URL-safe one-time token (raw form — hand to the user, store only sha256Hex(token)). */
export function randomToken(): string {
  return randomBytes(24).toString("base64url");
}

void KEY_CACHE;
