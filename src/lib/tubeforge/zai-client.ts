// Per-user Z.ai client resolution (Stage 3, T-3.10 — closes Stage 2
// deviation 2).
//
// History: the Z.ai SDK reads a `.z-ai-config` FILE at create() time — no
// constructor parameters — so TubeForge historically ran ONE platform-level
// client for every user. Stage 2 stored per-user zai rows but could not use
// them per request.
//
// This module closes that gap:
//   * The ACTING USER's zai credential (ProviderCredential, AES-256-GCM at
//     rest, per capability) takes priority — each user's creative work bills
//     to their own key.
//   * Fallback chain: current capability → any other capability's zai row →
//     the platform file (the historical behavior; sandbox/self-host default).
//   * Client instances are cached per (userId, key-hash). The unavoidable
//     write-file-then-create dance runs inside a GLOBAL MUTEX so two users'
//     first calls can never read each other's config file.
//
// Caches invalidate on saveCapability() (see providers/settings.ts) so a key
// change takes effect on the very next call.

import crypto from "crypto";
import ZAI from "z-ai-web-dev-sdk";
import { currentCtx } from "./tenant";
import { rawDatabase as rawDb } from "./tenant-db";
import { decryptSecret } from "./crypto";
import { ensureVercelZaiHome, syncZaiConfigFile, writeZaiConfigFile } from "./zai-config";
import { DEFAULT_ZAI_BASE_URL } from "./types";
import { log } from "./log";

const zaiLog = log.child({ mod: "zai" });

type ZaiClient = Awaited<ReturnType<typeof ZAI.create>>;

/** userId + key hash → client. Bounded: evicted wholesale at 64 users. */
const clientCache = new Map<string, ZaiClient>();

/** The historical platform singleton (sandbox / self-host default). */
let platformClient: ZaiClient | null = null;

/** Serializes the config-file write + ZAI.create() critical section. */
let fileLock: Promise<unknown> = Promise.resolve();

function withFileLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = fileLock.then(fn, fn);
  fileLock = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

interface ResolvedZaiCredential {
  baseUrl: string;
  apiKey: string;
  /** "user" = per-user ProviderCredential; "platform" = file / SDK default. */
  scope: "user" | "platform";
}

/**
 * The acting user's zai key, or null on the platform path. Looks in the
 * current capability first, then any other capability (users typically own
 * one zai account; a key saved under Chat is their key everywhere).
 */
async function resolveUserZaiCredential(capability: string): Promise<ResolvedZaiCredential | null> {
  const ctx = currentCtx();
  if (!ctx) return null;
  try {
    const rows = await rawDb.providerCredential.findMany({
      where: { userId: ctx.userId, provider: "zai", isActive: true },
    });
    if (!rows.length) return null;
    const preferred = rows.find((r) => r.capability === capability) ?? rows[0];
    const apiKey = decryptSecret(preferred.apiKey);
    if (!apiKey) return null;
    return {
      baseUrl: preferred.baseUrl || DEFAULT_ZAI_BASE_URL,
      apiKey,
      scope: "user",
    };
  } catch (err) {
    zaiLog.warn("user zai credential lookup failed — platform fallback", {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** The shared platform client (the pre-T-3.10 behavior). */
async function platformZaiClient(): Promise<ZaiClient> {
  if (platformClient) return platformClient;
  // VERCEL FIX: point HOME at /tmp so the SDK's fallback search works there
  // (the one law lives in zai-config.ts — ensureVercelZaiHome; the write seam
  // and this search must meet at /tmp).
  ensureVercelZaiHome();
  platformClient = await withFileLock(async () => {
    await syncZaiConfigFile();
    try {
      return await ZAI.create();
    } catch (err) {
      // The SDK's raw message ("Configuration file not found or invalid…")
      // reads like an operator error to an end user. What it actually means
      // for THEM: no usable provider exists anywhere — no key saved in
      // Settings → AI Providers, no platform .z-ai-config on the server.
      // Say that instead; log the raw cause for the operator.
      zaiLog.error("platform zai client unavailable", {
        err: err instanceof Error ? err.message : String(err),
      });
      throw new Error(
        "No AI provider configured — add a key in Settings → AI Providers (or provide a .z-ai-config file on the server)"
      );
    }
  });
  return platformClient;
}

/**
 * The Z.ai client for the CURRENT request: per-user when the acting user
 * stored a zai key, the shared platform client otherwise.
 *
 * The platform path materializes `.z-ai-config` from stored settings via
 * syncZaiConfigFile (zai-config.ts) — the acting user's legacy rows first,
 * then any active zai ProviderCredential row, so a job/worker/boot without
 * a request context still finds the key a user saved in Settings.
 *
 * @param capability which capability is calling ("chat" | "tts" | "image" |
 *                  "video" | "asr") — only picks WHICH credential row wins.
 */
export async function zaiClientFor(capability: string): Promise<ZaiClient> {
  const user = await resolveUserZaiCredential(capability);
  if (!user) return platformZaiClient();

  const cacheKey = `${currentCtx()?.userId ?? "anon"}:${crypto
    .createHash("sha256")
    .update(user.apiKey)
    .digest("hex")
    .slice(0, 16)}`;
  const cached = clientCache.get(cacheKey);
  if (cached) return cached;

  // Critical section: the SDK's only configuration surface is the ONE config
  // file — writes from concurrent users MUST be serialized, and the write
  // rides zai-config.ts's seam (project dir, then the home dir on read-only
  // hosts like Vercel — where it lands in /tmp, exactly where HOME points).
  const client = await withFileLock(async () => {
    const written = writeZaiConfigFile(
      `${JSON.stringify({ baseUrl: user.baseUrl, apiKey: user.apiKey }, null, 2)}\n`
    );
    if (!written) {
      throw new Error(
        "could not write .z-ai-config — project dir and home dir are both read-only"
      );
    }
    return ZAI.create();
  });

  if (clientCache.size > 64) clientCache.clear(); // crude bound; clients are small
  clientCache.set(cacheKey, client);
  zaiLog.debug("per-user zai client created", { capability });
  return client;
}

/** Drop cached clients (key saved/rotated, tests). */
export function invalidateZaiClients(): void {
  clientCache.clear();
  platformClient = null;
}
