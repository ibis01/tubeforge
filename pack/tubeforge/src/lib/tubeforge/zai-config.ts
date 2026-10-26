// Runtime Z.ai provider configuration — lets users change API key / base URL /
// chat model from the Settings UI instead of hand-editing .z-ai-config.
//
// How it works: the SDK's ZAI.create() accepts NO parameters and only reads a
// `.z-ai-config` JSON file (searched: project dir → home dir → /etc). So this
// module materializes the project-dir file from Setting-table rows whenever
// they exist, and invalidates the cached SDK client after a change. When no
// settings are stored, the pre-existing file (or /etc fallback) is left alone.

import fs from "fs";
import path from "path";
import ZAI from "z-ai-web-dev-sdk";
import { db } from "@/lib/db";
import { DEFAULT_CHAT_MODEL, DEFAULT_ZAI_BASE_URL } from "./types";

export const AI_SETTING_KEYS = {
  baseUrl: "zai.baseUrl",
  apiKey: "zai.apiKey",
  chatModel: "zai.chatModel",
  visionModel: "zai.visionModel",
} as const;

export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return `${key.slice(0, 2)}…`;
  return `${key.slice(0, 5)}…${key.slice(-4)}`;
}

/** Read all provider-related settings into a clean map. */
export async function readAiSettings() {
  const rows = await db.setting.findMany({
    where: { key: { in: Object.values(AI_SETTING_KEYS) } },
  });
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    baseUrl: map.get(AI_SETTING_KEYS.baseUrl)?.trim() || "",
    apiKey: map.get(AI_SETTING_KEYS.apiKey)?.trim() || "",
    chatModel: map.get(AI_SETTING_KEYS.chatModel)?.trim() || DEFAULT_CHAT_MODEL,
    visionModel: map.get(AI_SETTING_KEYS.visionModel)?.trim() || "",
  };
}

/**
 * Materialize `.z-ai-config` in the project dir from stored settings.
 * No-op when no API key is stored (keeps any hand-created file untouched).
 */
export async function syncZaiConfigFile(): Promise<void> {
  try {
    const s = await readAiSettings();
    if (!s.apiKey) return;
    const next = `${JSON.stringify(
      { baseUrl: s.baseUrl || DEFAULT_ZAI_BASE_URL, apiKey: s.apiKey },
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

/** The chat model to send with every text completion. Stored setting wins. */
export async function getChatModel(): Promise<string> {
  try {
    const s = await readAiSettings();
    return s.chatModel || DEFAULT_CHAT_MODEL;
  } catch {
    return DEFAULT_CHAT_MODEL;
  }
}

/**
 * Vision model for the VLM quality gate. Empty string = send no model field
 * (the gateway injects its default — preserves sandbox behavior).
 */
export async function getVisionModel(): Promise<string> {
  try {
    const s = await readAiSettings();
    return s.visionModel;
  } catch {
    return "";
  }
}

/**
 * Build a throwaway client for connection tests: write the candidate config to
 * the file, create a fresh ZAI instance, and let the caller reset the shared
 * client afterwards so production calls re-sync from saved settings.
 */
export async function createZaiForTest(overrides: {
  baseUrl?: string;
  apiKey?: string;
}): Promise<Awaited<ReturnType<typeof ZAI.create>>> {
  const saved = await readAiSettings();
  const baseUrl = overrides.baseUrl?.trim() || saved.baseUrl || DEFAULT_ZAI_BASE_URL;
  const apiKey = overrides.apiKey?.trim() || saved.apiKey;
  if (!apiKey) throw new Error("No API key configured");
  const file = path.join(process.cwd(), ".z-ai-config");
  fs.writeFileSync(file, `${JSON.stringify({ baseUrl, apiKey }, null, 2)}\n`);
  return ZAI.create();
}
