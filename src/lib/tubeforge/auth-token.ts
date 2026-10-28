// Edge-safe token utilities (NO database imports — usable from src/middleware.ts).
// Tokens are HMAC-SHA256-signed JSON payloads:
//   <b64url(payload)>.<b64url(signature)>
// Two scopes: "session" (browser cookie, 7 days) and "api" (Bearer token, 90 days).
// Rotating TUBEFORGE_AUTH_SECRET in .env invalidates every issued token.

export const SESSION_COOKIE = "tf_session";
export const SESSION_MAX_AGE_SEC = 7 * 24 * 60 * 60; // 7 days
export const API_TOKEN_MAX_AGE_SEC = 90 * 24 * 60 * 60; // 90 days

export interface TokenPayload {
  s: "session" | "api";
  exp: number; // epoch seconds
  jti: string; // unique id (random)
}

const te = new TextEncoder();
const td = new TextDecoder();

function toB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    te.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

/** Sign a payload into a compact token. Returns null when no secret is set. */
export async function signToken(
  payload: TokenPayload,
  secret: string | undefined
): Promise<string | null> {
  if (!secret) return null;
  const body = toB64url(te.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, te.encode(body));
  return `${body}.${toB64url(new Uint8Array(sig))}`;
}

/** Verify a token's signature + expiry. Returns the payload or null. */
export async function verifyToken(
  token: string | undefined | null,
  secret: string | undefined
): Promise<TokenPayload | null> {
  if (!secret || !token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  let payload: TokenPayload;
  try {
    payload = JSON.parse(td.decode(fromB64url(body))) as TokenPayload;
  } catch {
    return null;
  }
  if (payload?.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
  if (payload?.s !== "session" && payload?.s !== "api") return null;
  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    fromB64url(sig) as unknown as ArrayBuffer,
    te.encode(body) as unknown as ArrayBuffer
  );
  return ok ? payload : null;
}

/** Create a signed session/api token. */
export async function createSignedToken(
  scope: "session" | "api",
  maxAgeSec: number,
  secret: string | undefined
): Promise<string | null> {
  const jti = toB64url(crypto.getRandomValues(new Uint8Array(9)));
  return signToken(
    { s: scope, exp: Math.floor(Date.now() / 1000) + maxAgeSec, jti },
    secret
  );
}

export function getAuthSecret(): string | undefined {
  const s = process.env.TUBEFORGE_AUTH_SECRET;
  return s && s.length >= 16 ? s : undefined;
}
