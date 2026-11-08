// Universal AI provider configuration.
// Handles the Z.ai SDK file requirement safely on Vercel's read-only filesystem.

import fs from "fs";
import { log } from "../log";

// S57/T-57.2 — the module's logger (the old [config] prefix became a binding).
const configLog = log.child({ mod: "config" });
import path from "path";
import { readLegacyZai } from "./settings";
// NOTE: readLegacyZai is per-user in Stage 2 (UserSetting zai.* rows). The
// platform SDK gateway itself stays global — see providers/settings.ts.

export const ZAI_SETTING_KEYS = {
  baseUrl: "zai.baseUrl",
  apiKey: "zai.apiKey",
};

export async function readZaiCredentials() {
  const legacy = await readLegacyZai();
  return {
    baseUrl: legacy.baseUrl,
    apiKey: legacy.apiKey,
  };
}

export async function syncZaiConfigFile() {
  const creds = await readZaiCredentials();

  // VERCEL FIX: Vercel's filesystem is read-only except for /tmp
  const isVercel =
    process.env.VERCEL === "1" || process.env.NOW_BUILDER === "1";
  const dir = isVercel ? "/tmp" : process.cwd();
  const configPath = path.join(dir, ".z-ai-config");

  const configData = {
    baseUrl: creds.baseUrl || "https://api.z.ai/api/paas/v4",
    apiKey: creds.apiKey || "",
  };

  try {
    fs.writeFileSync(configPath, JSON.stringify(configData, null, 2), "utf-8");
  } catch (err) {
    configLog.error("failed to write Z.ai config file", { err });
  }
}
