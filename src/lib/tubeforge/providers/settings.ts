// Per-capability AI provider settings — Stage 2 per-user edition.

import { DEFAULT_CHAT_MODEL } from "../types";
import {
  PROVIDERS_BY_CAPABILITY,
  type CapabilityId,
  type ProviderId,
} from "./registry";
import { currentCtx } from "../tenant";
import { invalidateZaiClients } from "../zai-client";
import {
  getProviderCredential,
  getUserSettings,
  setUserSetting,
  upsertProviderCredential,
} from "../settings";

export { getProviderCredential };

export interface CapabilityConfig {
  provider: ProviderId;
  model: string;
  visionModel?: string;
  baseUrl?: string;
  apiKey?: string;
}

const CAPABILITY_KEYS: Record<CapabilityId, string> = {
  chat: "ai.chat",
  tts: "ai.tts",
  image: "ai.image",
  video: "ai.video",
};

export const VIDEO_DEFAULT_MODEL = "fal-ai/fast-svd";

function defaultFor(capability: CapabilityId): CapabilityConfig {
  switch (capability) {
    case "chat":
      return {
        provider: "zai",
        model: DEFAULT_CHAT_MODEL,
        visionModel: "",
      };
    case "video":
      return { provider: "fal", model: VIDEO_DEFAULT_MODEL };
    case "image":
      return { provider: "zai", model: "" };
    default:
      return { provider: "zai", model: "" };
  }
}

export async function readLegacyZai(): Promise<{
  baseUrl: string;
  apiKey: string;
  chatModel: string;
  visionModel: string;
  provider: string;
}> {
  const ctx = currentCtx();
  if (!ctx)
    return {
      baseUrl: "",
      apiKey: "",
      chatModel: "",
      visionModel: "",
      provider: "zai",
    };
  const map = await getUserSettings([
    "zai.baseUrl",
    "zai.apiKey",
    "zai.chatModel",
    "zai.visionModel",
    "zai.provider",
  ]);
  return {
    baseUrl: map.get("zai.baseUrl")?.trim() || "",
    apiKey: map.get("zai.apiKey")?.trim() || "",
    chatModel: map.get("zai.chatModel")?.trim() || "",
    visionModel: map.get("zai.visionModel")?.trim() || "",
    provider: map.get("zai.provider")?.trim() || "zai",
  };
}

interface StoredCapability {
  provider?: string;
  model?: string;
  visionModel?: string;
  baseUrl?: string;
}

export async function getCapability(
  capability: CapabilityId,
  overrides?: Partial<CapabilityConfig>,
): Promise<CapabilityConfig> {
  const config = defaultFor(capability);
  try {
    const legacy = await readLegacyZai();
    const map = await getUserSettings([CAPABILITY_KEYS[capability]]);
    const row = map.get(CAPABILITY_KEYS[capability]);
    const parsed = row ? (JSON.parse(row) as StoredCapability) : null;

    // Check if the shared provider supports this capability
    const sharedSupportsCap =
      PROVIDERS_BY_CAPABILITY[capability]?.some(
        (p) => p.id === legacy.provider,
      ) ?? false;

    if (parsed && typeof parsed.provider === "string") {
      // A specific capability config was explicitly saved
      config.provider = parsed.provider as ProviderId;
      config.model = parsed.model ?? config.model;
      config.visionModel = parsed.visionModel ?? config.visionModel;
      config.baseUrl = parsed.baseUrl ?? config.baseUrl;
    } else if (legacy.provider !== "zai" && sharedSupportsCap) {
      // No specific override, but shared provider is non-default and supports this — inherit
      config.provider = legacy.provider as ProviderId;
      config.baseUrl = legacy.baseUrl;
      config.apiKey = legacy.apiKey;
    } else if (capability === "chat") {
      if (legacy.chatModel) config.model = legacy.chatModel;
      if (legacy.visionModel) config.visionModel = legacy.visionModel;
    }

    // Secret half — ProviderCredential (encrypted at rest)
    if (!config.apiKey) {
      const cred = await getProviderCredential(capability, config.provider);
      config.apiKey = cred?.apiKey ?? "";
      config.baseUrl = config.baseUrl || cred?.baseUrl || "";
    }
  } catch {
    /* corrupt row — fall back to defaults */
  }
  const merged = { ...config, ...overrides };
  merged.model = merged.model?.trim() ?? "";
  return merged;
}

export async function saveCapability(
  capability: CapabilityId,
  patch: Partial<CapabilityConfig>,
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

  if (patch.apiKey === "") {
    next.apiKey = current.apiKey;
  }

  const ctx = currentCtx();
  if (!ctx) throw new Error("saveCapability requires an authenticated context");

  const blob: StoredCapability = {
    provider: next.provider,
    model: next.model,
    baseUrl: next.baseUrl?.trim() || undefined,
  };
  if (capability === "chat") blob.visionModel = next.visionModel ?? "";
  await setUserSetting(CAPABILITY_KEYS[capability], JSON.stringify(blob));

  if (next.apiKey) {
    await upsertProviderCredential(ctx.userId, capability, next.provider, {
      baseUrl: next.baseUrl?.trim() || "",
      apiKey: next.apiKey,
    });
  }

  invalidateZaiClients();

  return next;
}

export function effectiveModel(
  capability: CapabilityId,
  config: CapabilityConfig,
  providerDefault: string,
): string {
  return config.model?.trim() || providerDefault;
}

export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return `${key.slice(0, 2)}…`;
  return `${key.slice(0, 5)}…${key.slice(-4)}`;
}

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
