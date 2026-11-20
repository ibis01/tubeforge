// Universal AI provider configuration — the file-based .z-ai-config seam.
//
// DEDUPED (this file was the weaker legacy-only copy of syncZaiConfigFile):
// the ONE implementation lives in zai-config.ts — it reads the per-user
// zai.* UserSetting rows first and falls back to ANY active zai
// ProviderCredential row (the ddeeee5 law: jobs/worker/boot must not
// starve ZAI.create while a Settings-saved key exists). Every importer
// (routes, client, tests) rides that one law through this barrel.
export {
  syncZaiConfigFile,
  readZaiCredentials,
  ZAI_SETTING_KEYS,
} from "../zai-config";
