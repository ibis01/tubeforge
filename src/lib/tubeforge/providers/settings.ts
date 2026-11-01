// Per-capability AI provider settings — Stage 2 per-user edition.
//
// Storage model (per acting user):
//   UserSetting  ai.chat  = { provider, model, visionModel?, baseUrl? }   (non-secret)
//   UserSetting  ai.tts   = { provider, model, baseUrl? }
//   UserSetting  ai.image = { provider, model, baseUrl? }
//   UserSetting  ai.video = { provider, model, baseUrl? }
//   ProviderCredential (userId, capability, provider) = { baseUrl, apiKey } —
//   the secret half, AES-256-GCM encrypted at rest. Never inside the JSON
//   blob, never sent to the browser (publicCapability masks it).
//
// The bundled Z.ai SDK stays a platform-level credential (single .z-ai-config
// gateway) — per-user Z.ai keys arrive with the Stage 3 provider abstraction.
// Legacy zai.* rows still migrate per-user so the claiming owner's pick of
// chat/vision model keeps working (readLegacyZai below).

import { DEFAULT_CHAT_MODEL } from "../types";
import type { CapabilityId, ProviderId } from "./registry";
import { currentCtx } from "../tenant";
import { invalidateZaiClients } from "../zai-client";
import {
  getProviderCredential,
  getUserSettings,
  setUserSetting,
  upsertProviderCredential,
} from "../settings";

export interface CapabilityConfig {
  provider: ProviderId;
  /** "" = provider default. */
  model: string;
  /** Chat only — model for the artwork quality gate. "" = provider default. */
  visionModel?: string;
  /** Non-zai providers only. */
  baseUrl?: string;
  /** Non-zai providers only — lives in ProviderCredential, injected here for callers. */
  apiKey?: string;
}

const CAPABILITY_KEYS: Record<CapabilityId, string> = {
  chat: "ai.chat",
  tts: "ai.tts",
  image: "ai.image",
  video: "ai.video",
};

export const VIDEO_DEFAULT_MODEL = "fal-ai/fast-svd";

// Z.ai is the out-of-the-box default for every AI capability: the bundled
// SDK client needs no key when the app runs inside a Z.ai-equipped sandbox,
// and on a self-hosted box a free Z.ai key (z.ai/model-api — flash models
// are free) unlocks scripts, art, voiceover and the quality gates. OpenAI
// etc. remain one Settings → AI Providers switch away.
function defaultFor(capability: CapabilityId): CapabilityConfig {
  switch (capability) {
    case "chat":
      return {
        provider: "zai",
        model: DEFAULT_CHAT_MODEL,
        visionModel: "", // zai: the gateway injects its default vision model
      };
    case "video":
      // Ken Burns / stock render modes need no AI video; full animation can
      // switch here once a video key is configured.
      return { provider: "fal", model: VIDEO_DEFAULT_MODEL };
    case "image":
      return { provider: "zai", model: "" }; // CogView via the bundled SDK
    default:
      return { provider: "zai", model: "" }; // tts — 7 built-in studio voices
  }
}

/** Legacy model picks kept as plain per-user preferences (no secrets involved). */
export async function readLegacyZai(): Promise<{
  baseUrl: string;
  apiKey: string;
  chatModel: string;
  visionModel: string;
}> {
  const ctx = currentCtx();
  if (!ctx) return { baseUrl: "", apiKey: "", chatModel: "", visionModel: "" };
  const map = await getUserSettings([
    "zai.baseUrl",
    "zai.apiKey",
    "zai.chatModel",
    "zai.visionModel",
  ]);
  return {
    baseUrl: map.get("zai.baseUrl")?.trim() || "",
    apiKey: map.get("zai.apiKey")?.trim() || "",
    chatModel: map.get("zai.chatModel")?.trim() || "",
    visionModel: map.get("zai.visionModel")?.trim() || "",
  };
}

interface StoredCapability {
  provider?: string;
  model?: string;
  visionModel?: string;
  baseUrl?: string;
}

/** Effective config for a capability, with the credential injected server-side. */
export async function getCapability(
  capability: CapabilityId,
  overrides?: Partial<CapabilityConfig>
): Promise<CapabilityConfig> {
  const config = defaultFor(capability);
  try {
    const map = await getUserSettings([CAPABILITY_KEYS[capability]]);
    const row = map.get(CAPABILITY_KEYS[capability]);
    const parsed = row ? (JSON.parse(row) as StoredCapability) : null;
    if (parsed && typeof parsed.provider === "string") {
      config.provider = parsed.provider as ProviderId;
      config.model = parsed.model ?? config.model;
      config.visionModel = parsed.visionModel ?? config.visionModel;
      config.baseUrl = parsed.baseUrl ?? config.baseUrl;
    } else if (capability === "chat") {
      // Migrate: first read after the upgrade picks up the legacy model pick.
      const legacy = await readLegacyZai();
      if (legacy.chatModel) config.model = legacy.chatModel;
      if (legacy.visionModel) config.visionModel = legacy.visionModel;
    }
    // Secret half — ProviderCredential (encrypted at rest, decrypted here).
    const cred = await getProviderCredential(capability, config.provider);
    config.apiKey = cred?.apiKey ?? "";
    config.baseUrl = config.baseUrl || cred?.baseUrl || "";
  } catch {
    /* corrupt row — fall back to defaults */
  }
  const merged = { ...config, ...overrides };
  merged.model = merged.model?.trim() ?? "";
  return merged;
}

/** Persist a capability config: preferences to UserSetting, the key to ProviderCredential. */
export async function saveCapability(
  capability: CapabilityId,
  patch: Partial<CapabilityConfig>
): Promise<CapabilityConfig> {
  const current = await getCapability(capability);
  const next: CapabilityConfig = {
    ...current,
    ...patch,
    provider: (patch.provider ?? current.provider) as ProviderId,
    model: (patch.model ?? current.model)?.trim() ?? "",
  };

  if (capability === "chat") {
    next.visionModel = (next.visionModel ?? "")?.trim() ?? "";
  }

  // Empty key = "keep the saved one" so the masked field can stay blank.
  if (patch.apiKey === "") {
    next.apiKey = current.apiKey;
  }

  const ctx = currentCtx();
  if (!ctx) throw new Error("saveCapability requires an authenticated context");

  // Stage 3 (T-3.10): zai keys are PER-USER now (ProviderCredential, encrypted
  // at rest) — the same path as every other provider. A user without a
  // stored key falls back to the platform client (zai-client.ts), so the
  // out-of-the-box sandbox experience is unchanged.

  // 1) Non-secret config blob (NO apiKey inside — ever).
  const blob: StoredCapability = {
    provider: next.provider,
    model: next.model,
    baseUrl: next.baseUrl?.trim() || undefined,
  };
  if (capability === "chat") blob.visionModel = next.visionModel ?? "";
  await setUserSetting(CAPABILITY_KEYS[capability], JSON.stringify(blob));

  // 2) Secret half — any provider with a key (zai included since T-3.10).
  if (next.apiKey) {
    await upsertProviderCredential(ctx.userId, capability, next.provider, {
      baseUrl: next.baseUrl?.trim() || "",
      apiKey: next.apiKey,
    });
  }

  // Fresh key → fresh SDK client on the next call.
  invalidateZaiClients();

  return next;
}

/** The effective model for a provider, falling back to sensible defaults. */
export function effectiveModel(
  capability: CapabilityId,
  config: CapabilityConfig,
  providerDefault: string
): string {
  return config.model?.trim() || providerDefault;
}

export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return `${key.slice(0, 2)}…`;
  return `${key.slice(0, 5)}…${key.slice(-4)}`;
}

/** Public (client-safe) view of a capability — the key is never sent in full. */
export function publicCapability(config: CapabilityConfig) {
  return {
    provider: config.provider,
    model: config.model ?? "",
    visionModel: config.visionModel ?? "",
    baseUrl: config.provider === "zai" ? "" : (config.baseUrl?.trim() ?? ""),
    hasKey: Boolean(config.apiKey),
    maskedKey: maskKey(config.apiKey ?? ""),
  };
}
