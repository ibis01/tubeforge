// Universal AI provider configuration.
// Handles the Z.ai SDK file requirement safely on Vercel's read-only filesystem.

import { db } from "@/lib/db";
import fs from "fs";
import path from "path";

export const ZAI_SETTING_KEYS = {
  baseUrl: "zai.baseUrl",
  apiKey: "zai.apiKey",
};

export async function readZaiCredentials() {
  const rows = await db.setting.findMany({
    where: { key: { in: [ZAI_SETTING_KEYS.baseUrl, ZAI_SETTING_KEYS.apiKey] } },
  });
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    baseUrl: map.get(ZAI_SETTING_KEYS.baseUrl) || "",
    apiKey: map.get(ZAI_SETTING_KEYS.apiKey) || "",
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
    console.error("[config] Failed to write Z.ai config file:", err);
  }
}
