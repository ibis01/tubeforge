// Per-capability AI provider settings.
//
// Storage model (Prisma Setting table, JSON string values):
//   ai.chat  = { provider, model, visionModel?, baseUrl?, apiKey? }
//   ai.tts   = { provider, model, baseUrl?, apiKey? }
//   ai.image = { provider, model, baseUrl?, apiKey? }
//   ai.video = { provider, model, baseUrl?, apiKey? }
//
// Z.ai credentials stay GLOBAL in the legacy keys (zai.baseUrl / zai.apiKey)
// because the Z.ai SDK is a shared singleton reading one .z-ai-config file.
// Non-Z.ai providers carry their credentials per capability right here.

import { db } from "@/lib/db";
import { DEFAULT_CHAT_MODEL } from "../types";
import type { CapabilityId, ProviderId } from "./registry";

export interface CapabilityConfig {
  provider: ProviderId;
  /** "" = provider default. */
  model: string;
  /** Chat only — model for the artwork quality gate. "" = provider default. */
  visionModel?: string;
  /** Non-zai providers only. */
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

/** Read the legacy global Z.ai settings (shared with the SDK config sync). */
export async function readLegacyZai(): Promise<{
  baseUrl: string;
  apiKey: string;
  chatModel: string;
  visionModel: string;
}> {
  const rows = await db.setting.findMany({
    where: {
      key: {
        in: ["zai.baseUrl", "zai.apiKey", "zai.chatModel", "zai.visionModel"],
      },
    },
  });
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    baseUrl: map.get("zai.baseUrl")?.trim() || "",
    apiKey: map.get("zai.apiKey")?.trim() || "",
    chatModel: map.get("zai.chatModel")?.trim() || "",
    visionModel: map.get("zai.visionModel")?.trim() || "",
  };
}

/** Effective config for a capability, with legacy migration baked in. */
export async function getCapability(
  capability: CapabilityId,
  overrides?: Partial<CapabilityConfig>,
): Promise<CapabilityConfig> {
  let config = defaultFor(capability);
  try {
    const row = await db.setting.findUnique({
      where: { key: CAPABILITY_KEYS[capability] },
    });
    if (row) {
      const parsed = JSON.parse(row.value) as Partial<CapabilityConfig>;
      if (parsed && typeof parsed.provider === "string") {
        config = {
          ...config,
          ...parsed,
          model: parsed.model ?? config.model,
        };
      }
    } else if (capability === "chat") {
      // Migrate: first read after the upgrade picks up the legacy model pick.
      const legacy = await readLegacyZai();
      if (legacy.chatModel) config.model = legacy.chatModel;
      if (legacy.visionModel) config.visionModel = legacy.visionModel;
    }
  } catch {
    /* corrupt row — fall back to defaults */
  }
  const merged = { ...config, ...overrides };
  merged.model = merged.model?.trim() ?? "";
  return merged;
}

/** Persist a capability config (partial updates merge with what's stored). */
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

  // Empty key = "keep the saved one" so the masked field can stay blank.
  if (patch.apiKey === "") {
    next.apiKey = current.apiKey;
  }

  if (next.provider === "zai") {
    // zai credentials are global — never store them per capability.
    delete next.baseUrl;
    delete next.apiKey;
  }

  await db.setting.upsert({
    where: { key: CAPABILITY_KEYS[capability] },
    update: { value: JSON.stringify(next) },
    create: { key: CAPABILITY_KEYS[capability], value: JSON.stringify(next) },
  });

  return next;
}

/** The effective model for a provider, falling back to sensible defaults. */
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
