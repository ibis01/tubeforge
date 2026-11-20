// Runtime Z.ai provider configuration.
//
// The Z.ai SDK's ZAI.create() accepts NO parameters and only reads a
// `.z-ai-config` JSON file (searched: project dir → home dir → /etc). Z.ai
// credentials are GLOBAL in TubeForge (one SDK singleton serves every zai
// capability), stored in the Setting table under zai.baseUrl / zai.apiKey.
// This module materializes that file from those rows whenever a key is
// stored, and builds throwaway clients for connection tests.

import fs from "fs";
import os from "os";
import path from "path";
import ZAI from "z-ai-web-dev-sdk";
import { readLegacyZai } from "./providers/settings";
import { rawDatabase as rawDb } from "./tenant-db";
import { decryptSecret } from "./crypto";
import { DEFAULT_ZAI_BASE_URL } from "./types";
import { log } from "./log";

const zaiConfigLog = log.child({ mod: "zai-config" });

export const ZAI_SETTING_KEYS = {
  baseUrl: "zai.baseUrl",
  apiKey: "zai.apiKey",
} as const;

export async function readZaiCredentials(): Promise<{ baseUrl: string; apiKey: string }> {
  const legacy = await readLegacyZai();
  return { baseUrl: legacy.baseUrl, apiKey: legacy.apiKey };
}

/**
 * Platform-global fallback: ANY active zai ProviderCredential row. The
 * legacy read above is CONTEXT-SCOPED (readLegacyZai asserts a request ctx),
 * so a background job, a queue worker, or a cold server boot — all the
 * places that call ZAI.create() without a request — would early-return here
 * and starve ZAI.create() even though a user saved a key in Settings → AI
 * Providers (those saves land in ProviderCredential rows, not the legacy
 * Setting rows). Z.ai credentials are GLOBAL in this studio (module header),
 * so the first decryptable active zai row ("chat" preferred, oldest first
 * for determinism) is exactly the platform credential.
 */
async function readAnyZaiProviderCredential(): Promise<{ baseUrl: string; apiKey: string } | null> {
  try {
    const rows = await rawDb.providerCredential.findMany({
      where: { provider: "zai", isActive: true },
      orderBy: { createdAt: "asc" },
    });
    if (!rows.length) return null;
    const preferred = rows.find((r) => r.capability === "chat") ?? rows[0];
    const apiKey = decryptSecret(preferred.apiKey);
    if (!apiKey) return null;
    return { baseUrl: preferred.baseUrl || "", apiKey };
  } catch {
    return null; // no table / no key / decrypt failure — caller falls through
  }
}

// ---------------------------------------------------------------------------
// THE WRITE SEAM — where `.z-ai-config` lands.
//
// The SDK searches project dir → home dir → /etc at create() time. On
// read-only-project hosts (Vercel's /var/task) the project dir cannot take
// the file, so the Vercel law points HOME at /tmp (the writable root) and
// the fallback write lands there — the search and the write meet again.
//
// The N4 dedupe (2026-11-20) dropped this fallback: syncZaiConfigFile wrote
// cwd-only and swallowed the EROFS, while zai-client still pointed HOME at
// /tmp — write and search never met, and EVERY z-ai capability starved on
// the deployment (TTS voiceover, the LLM storyboard/script planner — the
// "voice over pipeline and storyboard pipeline are not rendering" report).
// One seam, three call sites: syncZaiConfigFile, createZaiForTest and
// zai-client's per-user write.
export function ensureVercelZaiHome(): void {
  if (process.env.VERCEL === "1" || process.env.NOW_BUILDER === "1") {
    process.env.HOME = "/tmp";
  }
}

function zaiConfigCandidates(): string[] {
  ensureVercelZaiHome();
  return [
    path.join(process.cwd(), ".z-ai-config"),
    path.join(os.homedir(), ".z-ai-config"),
  ];
}

/**
 * Write the config where the SDK can find it: project dir first (sandbox /
 * self-host keeps the historical path), then the home dir (the Vercel /tmp
 * lifeline). Returns the path written, or null when every filesystem
 * refused — callers surface that instead of failing silently.
 */
export function writeZaiConfigFile(content: string): string | null {
  for (const file of zaiConfigCandidates()) {
    try {
      fs.writeFileSync(file, content, { mode: 0o600 });
      return file;
    } catch {
      /* read-only fs — try the next candidate */
    }
  }
  return null;
}

/** True when ANY candidate location already carries exactly this content. */
function zaiConfigUpToDate(content: string): boolean {
  for (const file of zaiConfigCandidates()) {
    try {
      if (
        fs.existsSync(file) &&
        fs.readFileSync(file, "utf8").trim() === content.trim()
      ) {
        return true;
      }
    } catch {
      /* unreadable — treat as stale */
    }
  }
  return false;
}

/**
 * Materialize `.z-ai-config` from stored settings.
 * Resolution order: the acting user's legacy Setting rows, then ANY active
 * zai ProviderCredential row (platform-global — the job/boot path's lifeline).
 * No-op when neither holds a key (keeps any hand-created file — and the
 * platform-managed /etc fallback — untouched).
 */
export async function syncZaiConfigFile(): Promise<void> {
  try {
    let { baseUrl, apiKey } = await readZaiCredentials();
    if (!apiKey) {
      const fallback = await readAnyZaiProviderCredential();
      if (fallback) {
        baseUrl = fallback.baseUrl;
        apiKey = fallback.apiKey;
      }
    }
    if (!apiKey) return;
    const next = `${JSON.stringify(
      { baseUrl: baseUrl || DEFAULT_ZAI_BASE_URL, apiKey },
      null,
      2
    )}\n`;
    if (zaiConfigUpToDate(next)) return;
    const written = writeZaiConfigFile(next);
    if (written) {
      zaiConfigLog.info("zai config materialized", { path: written });
    } else {
      zaiConfigLog.error(
        "zai config could not be written anywhere — project dir and home dir both refused; ZAI.create() will not find a key"
      );
    }
  } catch (err) {
    // settings/db read failure — never crash the caller; log for the operator
    zaiConfigLog.warn("zai config sync skipped", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Build a throwaway client for connection tests: write the candidate config
 * to the file, create a fresh ZAI instance, and let the caller reset the
 * shared client afterwards so production calls re-sync from saved settings.
 */
export async function createZaiForTest(overrides: {
  baseUrl?: string;
  apiKey?: string;
}): Promise<Awaited<ReturnType<typeof ZAI.create>>> {
  const saved = await readZaiCredentials();
  const baseUrl = overrides.baseUrl?.trim() || saved.baseUrl || DEFAULT_ZAI_BASE_URL;
  const apiKey = overrides.apiKey?.trim() || saved.apiKey;
  if (!apiKey) throw new Error("No Z.ai API key configured");
  const written = writeZaiConfigFile(
    `${JSON.stringify({ baseUrl, apiKey }, null, 2)}\n`
  );
  if (!written) {
    throw new Error(
      "could not write .z-ai-config — project dir and home dir are both read-only"
    );
  }
  return ZAI.create();
}
