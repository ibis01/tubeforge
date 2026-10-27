// Node-runtime auth: password storage (PBKDF2 via Web Crypto), login rate
// limiting, and cookie helpers. Token sign/verify lives in auth-token.ts
// (edge-safe, no DB) so src/middleware.ts can import it directly.
//
// The access password is stored in the Setting table under "auth.password" as
//   pbkdf2$<iterations>$<saltB64>$<hashB64>
// Only the verifier ever reads the hash; nothing returns it to the browser.

import { db } from "@/lib/db";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SEC,
  API_TOKEN_MAX_AGE_SEC,
  createSignedToken,
  getAuthSecret,
} from "./auth-token";

const PASSWORD_KEY = "auth.password";
const PBKDF2_ITERS = 120_000; // ~100ms per attempt on server hardware
const MIN_PASSWORD_LEN = 8;

// ----- Password hashing (Web Crypto — works in Node 20 and edge) -----

function toB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const hash = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as unknown as ArrayBuffer, iterations: PBKDF2_ITERS, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return `pbkdf2$${PBKDF2_ITERS}$${toB64(salt)}$${toB64(new Uint8Array(hash))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iters = Number(parts[1]);
  const salt = Buffer.from(parts[2], "base64");
  const expected = Buffer.from(parts[3], "base64");
  if (!Number.isFinite(iters) || iters < 1 || salt.length < 8) return false;
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const hash = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: salt as unknown as ArrayBuffer, iterations: iters, hash: "SHA-256" },
      keyMaterial,
      256
    )
  );
  const got = Buffer.from(hash);
  if (got.length !== expected.length) return false;
  // constant-time compare
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ expected[i];
  return diff === 0;
}

// ----- Password state in the Setting table -----

export async function isAuthConfigured(): Promise<boolean> {
  const row = await db.setting.findUnique({ where: { key: PASSWORD_KEY } });
  return Boolean(row?.value);
}

export async function setPassword(password: string): Promise<void> {
  if (password.length < MIN_PASSWORD_LEN)
    throw new Error(`Password must be at least ${MIN_PASSWORD_LEN} characters`);
  await db.setting.upsert({
    where: { key: PASSWORD_KEY },
    update: { value: await hashPassword(password) },
    create: { key: PASSWORD_KEY, value: await hashPassword(password) },
  });
}

export async function checkPassword(password: string): Promise<boolean> {
  const row = await db.setting.findUnique({ where: { key: PASSWORD_KEY } });
  if (!row?.value) return false;
  return verifyPassword(password, row.value);
}

// ----- Token/cookie helpers (Node runtime) -----

export async function createSessionToken(): Promise<string | null> {
  return createSignedToken("session", SESSION_MAX_AGE_SEC, getAuthSecret());
}

export async function createApiToken(): Promise<string | null> {
  return createSignedToken("api", API_TOKEN_MAX_AGE_SEC, getAuthSecret());
}

export function sessionCookie(token: string) {
  return {
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE_SEC,
  };
}

export function clearedSessionCookie() {
  return { ...sessionCookie(""), maxAge: 0 };
}

// ----- Login rate limiting (per IP, in-memory) -----

interface Attempt {
  count: number;
  windowStart: number;
  lockUntil: number;
}

const g = globalThis as typeof globalThis & { __tfAuthLimit?: Map<string, Attempt> };
const attempts: Map<string, Attempt> = (g.__tfAuthLimit ??= new Map());

const WINDOW_MS = 10 * 60 * 1000; // sliding 10-minute window
const MAX_FAILURES = 5;
const LOCK_MS = 10 * 60 * 1000; // lock for 10 minutes

export function checkLoginAllowed(ip: string): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a) return { allowed: true, retryAfterSec: 0 };
  if (a.lockUntil > now)
    return { allowed: false, retryAfterSec: Math.ceil((a.lockUntil - now) / 1000) };
  if (now - a.windowStart > WINDOW_MS) {
    attempts.delete(ip);
    return { allowed: true, retryAfterSec: 0 };
  }
  return { allowed: true, retryAfterSec: 0 };
}

export function recordLoginFailure(ip: string): void {
  const now = Date.now();
  const a = attempts.get(ip) ?? { count: 0, windowStart: now, lockUntil: 0 };
  if (now - a.windowStart > WINDOW_MS) {
    a.count = 0;
    a.windowStart = now;
  }
  a.count += 1;
  if (a.count >= MAX_FAILURES) {
    a.lockUntil = now + LOCK_MS;
    a.count = 0;
    a.windowStart = now;
  }
  attempts.set(ip, a);
}

export function recordLoginSuccess(ip: string): void {
  attempts.delete(ip);
}

/** Client IP for rate limiting (best effort behind the preview proxy). */
export function clientIp(headers: Headers): string {
  return (
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headers.get("x-real-ip") ||
    "local"
  );
}
