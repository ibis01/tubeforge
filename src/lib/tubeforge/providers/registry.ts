// Provider registry — the menu of AI providers per task capability.
// Pure data, safe to import from both server adapters and client UI.

import { CHAT_MODELS } from "../types";

export type ProviderId = "zai" | "openai" | "anthropic" | "gemini";
export type CapabilityId = "chat" | "tts" | "image" | "video";

export interface ProviderMeta {
  id: ProviderId;
  label: string;
  /** Default endpoint — used when the user leaves the base URL blank. */
  defaultBaseUrl: string;
  /** Where to sign up / grab an API key. */
  keyUrl: string;
  /** Suggested models — the field stays free-text so any model id works. */
  models: { id: string; hint?: string }[];
  note?: string;
}

/** Text generation: scripts, research, engagement kits, character bibles. */
export const CHAT_PROVIDERS: ProviderMeta[] = [
  {
    id: "zai",
    label: "Z.ai (GLM)",
    defaultBaseUrl: "https://api.z.ai/api/paas/v4",
    keyUrl: "https://z.ai/model-api",
    models: CHAT_MODELS.map((m) => ({ id: m.id, hint: m.hint })),
    note: "Flash models are free — scripts cost $0 on a fresh key.",
  },
  {
    id: "openai",
    label: "OpenAI-compatible (OpenAI, OpenRouter, Groq, DeepSeek, Ollama…)",
    defaultBaseUrl: "https://api.openai.com/v1",
    keyUrl: "https://platform.openai.com/api-keys",
    models: [
      { id: "gpt-4o-mini", hint: "cheap + fast — great for scripts" },
      { id: "gpt-4o" },
      { id: "gpt-4.1-mini" },
      { id: "gpt-4.1" },
      { id: "o4-mini", hint: "reasoning model" },
    ],
    note: "Works with any server that speaks the OpenAI /chat/completions dialect.",
  },
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    defaultBaseUrl: "https://api.anthropic.com",
    keyUrl: "https://console.anthropic.com/settings/keys",
    models: [
      { id: "claude-sonnet-4-5", hint: "recommended" },
      { id: "claude-opus-4-1" },
      { id: "claude-haiku-4-5", hint: "fast + affordable" },
      { id: "claude-3-7-sonnet-latest" },
    ],
  },
  {
    id: "gemini",
    label: "Google (Gemini)",
    defaultBaseUrl: "https://generativelanguage.googleapis.com",
    keyUrl: "https://aistudio.google.com/apikey",
    models: [
      { id: "gemini-2.5-flash", hint: "recommended — generous free tier" },
      { id: "gemini-2.5-pro" },
      { id: "gemini-2.0-flash" },
    ],
    note: "API keys from Google AI Studio include a free quota.",
  },
];

/** Voiceover TTS + narration ASR (audio tasks share one provider choice). */
export const TTS_PROVIDERS: ProviderMeta[] = [
  {
    id: "zai",
    label: "Z.ai TTS",
    defaultBaseUrl: "https://api.z.ai/api/paas/v4",
    keyUrl: "https://z.ai/model-api",
    models: [],
    note: "7 built-in studio voices.",
  },
  {
    id: "openai",
    label: "OpenAI-compatible (OpenAI /audio/speech)",
    defaultBaseUrl: "https://api.openai.com/v1",
    keyUrl: "https://platform.openai.com/api-keys",
    models: [
      { id: "tts-1", hint: "standard" },
      { id: "tts-1-hd", hint: "higher fidelity" },
      { id: "gpt-4o-mini-tts", hint: "newest, most voices" },
    ],
    note: "Only servers that expose /audio/speech (OpenAI itself or a mirror).",
  },
];

/** Thumbnails, storyboard scenes, portraits, pose sheets. */
export const IMAGE_PROVIDERS: ProviderMeta[] = [
  {
    id: "zai",
    label: "Z.ai CogView",
    defaultBaseUrl: "https://api.z.ai/api/paas/v4",
    keyUrl: "https://z.ai/model-api",
    models: [],
    note: "Built-in default art model, supports identity-locked edits.",
  },
  {
    id: "openai",
    label: "OpenAI-compatible (DALL·E / gpt-image)",
    defaultBaseUrl: "https://api.openai.com/v1",
    keyUrl: "https://platform.openai.com/api-keys",
    models: [
      { id: "dall-e-3", hint: "vivid; edits unsupported" },
      { id: "gpt-image-1", hint: "supports image edits (host likeness)" },
    ],
    note: "Only servers that expose /images/generations in OpenAI shape.",
  },
];

/** Scene animation (image-to-video). CogVideoX is the only engine wired in. */
export const VIDEO_PROVIDERS: ProviderMeta[] = [
  {
    id: "zai",
    label: "Z.ai CogVideoX (only option)",
    defaultBaseUrl: "https://api.z.ai/api/paas/v4",
    keyUrl: "https://z.ai/model-api",
    models: [{ id: "cogvideox-3", hint: "5s 1080p clips" }],
    note: "Ken Burns render mode needs no AI video at all.",
  },
];

export const PROVIDERS_BY_CAPABILITY: Record<CapabilityId, ProviderMeta[]> = {
  chat: CHAT_PROVIDERS,
  tts: TTS_PROVIDERS,
  image: IMAGE_PROVIDERS,
  video: VIDEO_PROVIDERS,
};

export const CAPABILITY_META: Record<
  CapabilityId,
  { label: string; icon: string; desc: string }
> = {
  chat: {
    label: "Script writing",
    icon: "PenLine",
    desc: "Scripts, topic research, engagement kits, character bibles",
  },
  tts: {
    label: "Voiceover",
    icon: "Mic",
    desc: "Text-to-speech narration (and audio transcription)",
  },
  image: {
    label: "Artwork",
    icon: "Image",
    desc: "Thumbnails, storyboard scenes, portraits",
  },
  video: {
    label: "Scene animation",
    icon: "Clapperboard",
    desc: "Animated 5s scene clips (image-to-video)",
  },
};

// ---------- Voice catalogs ----------

/** OpenAI TTS voices. The classic six work on every tts model. */
export const OPENAI_VOICES = [
  { id: "alloy", label: "Alloy — neutral, clear", classic: true },
  { id: "echo", label: "Echo — grounded, calm", classic: true },
  { id: "fable", label: "Fable — expressive, storyteller", classic: true },
  { id: "onyx", label: "Onyx — deep, authoritative", classic: true },
  { id: "nova", label: "Nova — bright, energetic", classic: true },
  { id: "shimmer", label: "Shimmer — warm, friendly", classic: true },
  { id: "ash", label: "Ash — raspy, confident", classic: false },
  { id: "coral", label: "Coral — lively, upbeat", classic: false },
  { id: "sage", label: "Sage — soft, thoughtful", classic: false },
  { id: "ballad", label: "Ballad — emotional, gentle", classic: false },
] as const;

export function providerMeta(
  capability: CapabilityId,
  id: string
): ProviderMeta | undefined {
  return PROVIDERS_BY_CAPABILITY[capability].find((p) => p.id === id);
}
