// Multi-tenant identity: request context, sessions, authorization.
//
// Stage 2 replaces the single-user lock (one global password in Setting) with
// User accounts + Organization workspaces. The request context (TenantCtx) is
// stored in an AsyncLocalStorage scope; requireUser() both validates the
// caller AND enters that scope, so every deeper module called from the request
// — including fire-and-forget job bodies spawned by startJob() — resolves the
// acting tenant from currentCtx(). The tenant-db client extension uses the
// same context to inject organizationId into every query (see tenant-db.ts).
//
// Tokens: HMAC-signed (auth-token.ts). Session-scope tokens carry uid + sid
// (the Session row id); requireUser resolves the Session row so revocation
// takes effect instantly. API-scope tokens (90-day bearer, for scripts) carry
// uid only — they expire with the token; rotating TUBEFORGE_AUTH_SECRET kills
// them all.

import { AsyncLocalStorage } from "node:async_hooks";
import type { NextRequest } from "next/server";
import { db as rawDb } from "@/lib/db";
import {
  API_TOKEN_MAX_AGE_SEC,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SEC,
  createSignedToken,
  getAuthSecret,
  verifyToken,
} from "./auth-token";

// ---------------------------------------------------------------------------
// Tenant context

export interface TenantCtx {
  userId: string;
  organizationId: string;
  role: string; // owner | admin | editor | viewer
}

const storage = new AsyncLocalStorage<TenantCtx | null>();

/** The acting tenant for the current async scope (null outside a request/job). */
export function currentCtx(): TenantCtx | null {
  return storage.getStore() ?? null;
}

/** Current tenant or throw — for modules that REQUIRE a user (settings reads). */
export function assertCtx(where: string): TenantCtx {
  const ctx = currentCtx();
  if (!ctx) {
    throw new Error(
      `No tenant context (${where}) — this code path must run behind requireUser() or inside a job body.`
    );
  }
  return ctx;
}

/** Run fn inside an explicit tenant scope (job bodies, tests). */
export function withCtx<T>(ctx: TenantCtx, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}

/** Run fn with NO tenant scope (boot recovery, claim migration, auth bootstrap). */
export function withCtxNull<T>(fn: () => Promise<T>): Promise<T> {
  return storage.run(null, fn);
}

function enterTenant(ctx: TenantCtx): void {
  storage.enterWith(ctx);
}

// ---------------------------------------------------------------------------
// Password hashing — PBKDF2 via Web Crypto (same format the single-user lock
// used: pbkdf2$<iters>$<saltB64>$<hashB64>), so legacy auth.password rows
// migrate into User.passwordHash unchanged.

const PBKDF2_ITERS = 120_000;
export const MIN_PASSWORD_LEN = 8;

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
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ expected[i];
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Sessions (server-side rows — revocable, 7-day expiry)

export interface SessionRecord {
  id: string;
  userId: string;
  organizationId: string;
}

export async function createSessionRecord(input: {
  userId: string;
  organizationId: string;
  userAgent?: string | null;
}): Promise<SessionRecord> {
  const expires = new Date(Date.now() + SESSION_MAX_AGE_SEC * 1000);
  const row = await rawDb.session.create({
    data: {
      userId: input.userId,
      organizationId: input.organizationId,
      userAgent: input.userAgent?.slice(0, 300) ?? null,
      expiresAt: expires,
    },
  });
  return { id: row.id, userId: row.userId, organizationId: row.organizationId };
}

export async function revokeSessionById(sid: string): Promise<void> {
  await rawDb.session.updateMany({
    where: { id: sid, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Drop rows long past their expiry (called from login/logout — cheap indexed delete). */
export async function sweepExpiredSessions(): Promise<void> {
  await rawDb.session.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch(() => {});
}

/** First membership = the user's primary organization (created at registration). */
async function primaryMembership(userId: string) {
  return rawDb.membership.findFirst({
    where: { userId },
    orderBy: { createdAt: "asc" },
  });
}

/** Resolve a session id into a live context (null when revoked/expired/gone). */
async function resolveSessionCtx(sid: string): Promise<TenantCtx | null> {
  const session = await rawDb.session.findUnique({ where: { id: sid } });
  if (!session || session.revokedAt || session.expiresAt.getTime() < Date.now()) return null;
  const membership = await primaryMembership(session.userId);
  if (!membership) return null;
  return {
    userId: session.userId,
    organizationId: session.organizationId,
    role: membership.role,
  };
}

/** Resolve an api-token uid into a context (no Session row — bearer semantics). */
async function resolveApiCtx(uid: string): Promise<TenantCtx | null> {
  const membership = await primaryMembership(uid);
  if (!membership) return null;
  return { userId: uid, organizationId: membership.organizationId, role: membership.role };
}

/**
 * Resolve the caller's context WITHOUT entering the scope (public endpoints
 * that must answer for signed-out users too, e.g. GET /api/auth/status).
 */
export async function resolveRequestUser(req: NextRequest): Promise<TenantCtx | null> {
  const secret = getAuthSecret();
  if (!secret) return null;
  const bearer = req.headers.get("authorization");
  const token = bearer?.startsWith("Bearer ")
    ? bearer.slice(7).trim()
    : req.cookies.get(SESSION_COOKIE)?.value;
  const payload = await verifyToken(token, secret);
  if (!payload || payload.s === "state") return null;
  if (payload.s === "session") return resolveSessionCtx(payload.jti);
  return payload.uid ? resolveApiCtx(payload.uid) : null;
}

/**
 * The caller's CURRENT Session row id (the token's jti), or null when the
 * caller rode an API bearer token, a state marker or no token at all.
 *
 * S16 (change-password): the rotation revokes every live session — including
 * the acting one — and re-signs the browser on a FRESH row, so the route
 * needs the sid to know which session it is rotating FROM. API tokens are
 * deliberately null: a leaked 90-day bearer must never be able to rotate the
 * password (the route 403s those callers — only a browser session may).
 */
export async function sessionIdFromRequest(req: NextRequest): Promise<string | null> {
  const secret = getAuthSecret();
  if (!secret) return null;
  const bearer = req.headers.get("authorization");
  const token = bearer?.startsWith("Bearer ")
    ? bearer.slice(7).trim()
    : req.cookies.get(SESSION_COOKIE)?.value;
  const payload = await verifyToken(token, secret);
  return payload?.s === "session" ? payload.jti : null;
}

// ---------------------------------------------------------------------------
// requireUser / requireRole — every protected endpoint starts with one of these.

export type AuthResult =
  | { ok: true; ctx: TenantCtx; enter: () => void }
  | { ok: false; status: number; error: string };

const AUTH_REQUIRED = "Authentication required — sign in to use TubeForge";

export async function requireUser(req: NextRequest): Promise<AuthResult> {
  const secret = getAuthSecret();
  if (!secret) {
    return {
      ok: false,
      status: 503,
      error: "TUBEFORGE_AUTH_SECRET is not configured — sign-in is unavailable",
    };
  }
  const bearer = req.headers.get("authorization");
  const token = bearer?.startsWith("Bearer ")
    ? bearer.slice(7).trim()
    : req.cookies.get(SESSION_COOKIE)?.value;

  const payload = await verifyToken(token, secret);
  if (!payload) return { ok: false, status: 401, error: AUTH_REQUIRED };
  if (payload.s === "state") return { ok: false, status: 401, error: AUTH_REQUIRED }; // OAuth markers are not credentials

  const ctx =
    payload.s === "session"
      ? await resolveSessionCtx(payload.jti) // jti doubles as the Session row id
      : payload.uid
        ? await resolveApiCtx(payload.uid)
        : null;
  if (!ctx) return { ok: false, status: 401, error: AUTH_REQUIRED };

  enterTenant(ctx);
  // enter() re-enters the ALS scope in the CALLER's frame — the await above
  // resets the async context at the call site, so an enterWith from inside
  // this function would never reach the handler's continuation. Routes call
  // auth.enter() right after the guard; job closures spawned later inherit it.
  return { ok: true, ctx, enter: () => enterTenant(ctx) };
}

/** requireUser + role check. Roles: owner > admin > editor > viewer. */
const ROLE_RANK: Record<string, number> = { owner: 4, admin: 3, editor: 2, viewer: 1 };

export async function requireRole(
  req: NextRequest,
  ...roles: string[]
): Promise<AuthResult> {
  const base = await requireUser(req);
  if (!base.ok) return base;
  if (!roles.length) return base;
  const have = ROLE_RANK[base.ctx.role] ?? 0;
  const need = Math.max(...roles.map((r) => ROLE_RANK[r] ?? 0));
  if (have < need) {
    return {
      ok: false,
      status: 403,
      error: `This action requires ${roles.join(" / ")} privileges — you are ${base.ctx.role}`,
    };
  }
  return base;
}

// ---------------------------------------------------------------------------
// Token / cookie helpers

export async function createSessionToken(uid: string, sid: string): Promise<string | null> {
  // The Session row id travels as the token's jti — requireUser() resolves it
  // back into the row, so revoking the Session kills the cookie instantly.
  return createSignedToken("session", SESSION_MAX_AGE_SEC, getAuthSecret(), {
    uid,
    jti: sid,
  });
}

export function createApiToken(uid: string): Promise<string | null> {
  return createSignedToken("api", API_TOKEN_MAX_AGE_SEC, getAuthSecret(), { uid });
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

// ---------------------------------------------------------------------------
// Login rate limiting (per IP, in-memory; Redis-backed bucket lands in Stage 3)

interface Attempt {
  count: number;
  windowStart: number;
  lockUntil: number;
}

const g = globalThis as typeof globalThis & { __tfAuthLimit?: Map<string, Attempt> };
const attempts: Map<string, Attempt> = (g.__tfAuthLimit ??= new Map());

const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCK_MS = 10 * 60 * 1000;

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
