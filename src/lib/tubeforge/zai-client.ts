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
import fs from "fs";
import path from "path";
import ZAI from "z-ai-web-dev-sdk";
import { currentCtx } from "./tenant";
import { rawDatabase as rawDb } from "./tenant-db";
import { decryptSecret } from "./crypto";
import { readZaiCredentials } from "./zai-config";
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

/** Materialize `.z-ai-config` from the legacy rows (platform path). */
async function syncZaiConfigFile(): Promise<void> {
  try {
    const { baseUrl, apiKey } = await readZaiCredentials();
    if (!apiKey) return;
    const next = `${JSON.stringify(
      { baseUrl: baseUrl || DEFAULT_ZAI_BASE_URL, apiKey },
      null,
      2
    )}\n`;
    const file = path.join(process.cwd(), ".z-ai-config");
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (existing.trim() !== next.trim()) fs.writeFileSync(file, next);
  } catch {
    /* read-only filesystem — fall back to the existing file */
  }
}

/** The shared platform client (the pre-T-3.10 behavior). */
async function platformZaiClient(): Promise<ZaiClient> {
  if (platformClient) return platformClient;
  // VERCEL FIX: point HOME at /tmp so the SDK's fallback search works there.
  if (process.env.VERCEL === "1" || process.env.NOW_BUILDER === "1") {
    process.env.HOME = "/tmp";
  }
  platformClient = await withFileLock(async () => {
    await syncZaiConfigFile();
    return ZAI.create();
  });
  return platformClient;
}

/**
 * The Z.ai client for the CURRENT request: per-user when the acting user
 * stored a zai key, the shared platform client otherwise.
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

  // Critical section: the SDK's only configuration surface is the file in
  // process.cwd() — writes from concurrent users MUST be serialized.
  const client = await withFileLock(async () => {
    const file = path.join(process.cwd(), ".z-ai-config");
    fs.writeFileSync(
      file,
      `${JSON.stringify({ baseUrl: user.baseUrl, apiKey: user.apiKey }, null, 2)}\n`,
      { mode: 0o600 }
    );
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
