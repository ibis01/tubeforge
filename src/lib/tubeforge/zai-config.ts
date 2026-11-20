// Runtime Z.ai provider configuration.
//
// The Z.ai SDK's ZAI.create() accepts NO parameters and only reads a
// `.z-ai-config` JSON file (searched: project dir → home dir → /etc). Z.ai
// credentials are GLOBAL in TubeForge (one SDK singleton serves every zai
// capability), stored in the Setting table under zai.baseUrl / zai.apiKey.
// This module materializes the project-dir file from those rows whenever a
// key is stored, and builds throwaway clients for connection tests.

import fs from "fs";
import path from "path";
import ZAI from "z-ai-web-dev-sdk";
import { readLegacyZai } from "./providers/settings";
import { rawDatabase as rawDb } from "./tenant-db";
import { decryptSecret } from "./crypto";
import { DEFAULT_ZAI_BASE_URL } from "./types";

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

/**
 * Materialize `.z-ai-config` in the project dir from stored settings.
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
    const file = path.join(process.cwd(), ".z-ai-config");
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (existing.trim() !== next.trim()) fs.writeFileSync(file, next);
  } catch {
    /* read-only filesystem (e.g. some hosts) — fall back to existing file */
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
  const file = path.join(process.cwd(), ".z-ai-config");
  fs.writeFileSync(file, `${JSON.stringify({ baseUrl, apiKey }, null, 2)}\n`);
  return ZAI.create();
}
