// Per-capability AI provider settings — Stage 2 per-user edition.

import { DEFAULT_CHAT_MODEL } from "../types";
import { log } from "../log";
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
  asr: "ai.asr",
  image: "ai.image",
  video: "ai.video",
};

export const VIDEO_DEFAULT_MODEL = "cogvideox-3";

function defaultFor(capability: CapabilityId): CapabilityConfig {
  switch (capability) {
    case "chat":
      return {
        provider: "zai",
        model: DEFAULT_CHAT_MODEL,
        visionModel: "",
      };
    case "video":
      // The zai default rides the SHARED-credentials story (one account,
      // every capability); fal remains available in the registry.
      return { provider: "zai", model: VIDEO_DEFAULT_MODEL };
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

const settingsLog = log.child({ mod: "providers/settings" });

/**
 * S186 — the NO-SILENT-DEFAULTS law.
 *
 * getCapability used to wrap its ENTIRE read (saved row parse + credential
 * decrypt) in one try/catch whose catch arm returned `defaultFor(capability)`.
 * Any single failure — a rotated TUBEFORGE_ENCRYPTION_KEY, a DB hiccup, a
 * corrupt row — therefore read as "the user never saved anything": the UI
 * showed zai defaults over a row that still said groq, which is exactly the
 * "settings revert to default after I save and log back in" incident.
 *
 * The law now: the PERSISTED SELECTION (provider/model/baseUrl) survives any
 * secret-half failure. Each failure mode is isolated, logged loudly, and only
 * degrades what it actually broke — a unreadable API key reports hasKey:false
 * (the UI prompts to re-enter it), it NEVER resets the provider choice.
 */
export async function getCapability(
  capability: CapabilityId,
  overrides?: Partial<CapabilityConfig>,
): Promise<CapabilityConfig> {
  // S121 — the asr capability FOLLOWS the tts capability until an ai.asr row
  // is saved: the historical transcription-rode-TTS behavior IS the default.
  // One inheritance point (here), one way out (save an ai.asr row) — callers
  // never branch on "is asr configured". Byte-identical behavior when unset.
  // (The probe is outside getCapability's own try/catch on purpose: a missing
  // tenant context must land on the tts answer, never throw through here.)
  if (capability === "asr") {
    let savedRow: string | null = null;
    try {
      savedRow = (await getUserSettings([CAPABILITY_KEYS.asr])).get(CAPABILITY_KEYS.asr) ?? null;
    } catch {
      savedRow = null; // no tenant context / DB hiccup → follow tts
    }
    if (!savedRow) return getCapability("tts", overrides);
  }
  const config = defaultFor(capability);

  // -- Half 1: the persisted selection (non-secret) -------------------------
  // Isolated: a corrupt row or DB hiccup degrades to the capability default
  // WITHOUT dragging the secret half (or the legacy shared provider) down.
  try {
    const map = await getUserSettings([CAPABILITY_KEYS[capability]]);
    const row = map.get(CAPABILITY_KEYS[capability]);
    const parsed = row ? (JSON.parse(row) as StoredCapability) : null;
    if (parsed && typeof parsed.provider === "string") {
      // A specific capability config was explicitly saved — the durable truth.
      config.provider = parsed.provider as ProviderId;
      config.model = parsed.model ?? config.model;
      config.visionModel = parsed.visionModel ?? config.visionModel;
      config.baseUrl = parsed.baseUrl ?? config.baseUrl;
    } else {
      // No specific override — the legacy shared-provider inheritance.
      const legacy = await readLegacyZai();
      const sharedSupportsCap =
        PROVIDERS_BY_CAPABILITY[capability]?.some(
          (p) => p.id === legacy.provider,
        ) ?? false;
      if (legacy.provider !== "zai" && sharedSupportsCap) {
        config.provider = legacy.provider as ProviderId;
        config.baseUrl = legacy.baseUrl;
        config.apiKey = legacy.apiKey;
      } else if (capability === "chat") {
        if (legacy.chatModel) config.model = legacy.chatModel;
        if (legacy.visionModel) config.visionModel = legacy.visionModel;
      }
    }
  } catch (err) {
    settingsLog.error(
      `[getCapability:${capability}] the saved selection row could not be read — ` +
        `serving the capability default until the storage issue is fixed`,
      { detail: err instanceof Error ? err.message : String(err) },
    );
  }

  // -- Half 2: the secret (ProviderCredential, encrypted at rest) -----------
  // Isolated: a decrypt failure (rotated TUBEFORGE_ENCRYPTION_KEY is the
  // historical trigger) must NOT erase the selection above. The capability
  // reports "no usable key" and the settings UI asks the user to re-enter it.
  if (!config.apiKey) {
    try {
      const cred = await getProviderCredential(capability, config.provider);
      config.apiKey = cred?.apiKey ?? "";
      config.baseUrl = config.baseUrl || cred?.baseUrl || "";
    } catch (err) {
      settingsLog.error(
        `[getCapability:${capability}] the saved credential for provider ` +
          `"${config.provider}" could not be decrypted — the key reports ` +
          `missing (re-enter it in Settings) instead of resetting the provider`,
        { detail: err instanceof Error ? err.message : String(err) },
      );
      config.apiKey = "";
    }
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

  // S159 — THE NO-INHERIT LAW. Switching providers never carries the old
  // provider's secret into the new provider's row. The old logic
  // (`patch.apiKey === "" → next.apiKey = current.apiKey`) read the ACTIVE
  // provider's key — so a provider switch saved with a blank key field
  // silently WROTE provider A's key into provider B's credential row
  // (cross-contamination), and a later synthesis on B authenticated as A.
  // Now: unchanged provider + blank field keeps today's "keep the saved
  // key" behavior; a provider switch resolves the NEW provider's OWN saved
  // credential (or none — a readable needs-a-key error at synthesis beats a
  // foreign key silently riding the wire).
  const providerChanged = next.provider !== current.provider;
  if (providerChanged && !(patch.apiKey ?? "").trim()) {
    // S186 — the NEW provider's saved credential, decoded in isolation: a
    // decrypt failure here (rotated encryption key) degrades to "no saved
    // key" — the save proceeds and the UI asks for the key — it never 400s
    // the whole provider switch.
    try {
      const cred = await getProviderCredential(capability, next.provider);
      next.apiKey = cred?.apiKey ?? "";
      next.baseUrl = next.baseUrl?.trim() || cred?.baseUrl || "";
    } catch {
      next.apiKey = "";
    }
  } else if (patch.apiKey === "") {
    next.apiKey = current.apiKey;
  }

  const ctx = currentCtx();
  if (!ctx) throw new Error("saveCapability requires an authenticated context");

  // S186 — the SAVE pre-flight. An unusable encryption key used to surface as
  // a raw Node crypto error AFTER the provider row was already written (a
  // partial save with a cryptic 400). Detect it BEFORE any write and answer
  // with the exact operator fix.
  if (next.apiKey && !encryptionKeyUsable()) {
    throw new Error(
      "TUBEFORGE_ENCRYPTION_KEY is missing or too short — the API key cannot be stored securely. " +
        "Set it (64 hex chars, openssl rand -hex 32) in your hosting environment variables, " +
        "then redeploy. Your provider/model selection is NOT lost — only the key save was refused.",
    );
  }

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

/** S186 — can secrets be encrypted in THIS process? (save pre-flight + the
 *  settings GET's storage.health probe). True when the env key is present and
 *  ≥16 chars — the same contract requireKey enforces. */
export function encryptionKeyUsable(): boolean {
  return (process.env.TUBEFORGE_ENCRYPTION_KEY ?? "").length >= 16;
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
