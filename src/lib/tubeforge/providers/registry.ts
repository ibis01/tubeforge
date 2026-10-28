// Provider registry — the menu of AI providers per task capability.
// Pure data, safe to import from both server adapters and client UI.

import { CHAT_MODELS } from "../types";

export type CapabilityId = "chat" | "tts" | "image" | "video";

export type ProviderKind = "zai" | "openai" | "anthropic" | "gemini" | "native";

export interface ProviderMeta {
  id: string;
  label: string;
  kind: ProviderKind;
  /** Default endpoint — used when the user leaves the base URL blank. */
  defaultBaseUrl: string;
  /** Where to sign up / grab an API key. */
  keyUrl: string;
  /** Suggested models — the field stays free-text so any model id works. */
  models: { id: string; hint?: string }[];
  note?: string;
  /** Local servers (Ollama, LM Studio, vLLM) don't need an API key. */
  requiresKey?: boolean;
}

// ───────────────────────────── CHAT ─────────────────────────────
export const CHAT_PROVIDERS: ProviderMeta[] = [
  {
    id: "zai",
    kind: "zai",
    label: "Z.ai (GLM)",
    defaultBaseUrl: "https://api.z.ai/api/paas/v4",
    keyUrl: "https://z.ai/model-api",
    models: CHAT_MODELS.map((m) => ({ id: m.id, hint: m.hint })),
    note: "Flash models are free — scripts cost $0 on a fresh key.",
  },
  {
    id: "openai",
    kind: "openai",
    label: "OpenAI",
    defaultBaseUrl: "https://api.openai.com/v1",
    keyUrl: "https://platform.openai.com/api-keys",
    models: [
      { id: "gpt-4o-mini", hint: "cheap + fast — great for scripts" },
      { id: "gpt-4o" },
      { id: "gpt-4.1-mini" },
      { id: "gpt-4.1" },
      { id: "o4-mini", hint: "reasoning model" },
    ],
  },
  {
    id: "anthropic",
    kind: "anthropic",
    label: "Anthropic (Claude)",
    defaultBaseUrl: "https://api.anthropic.com",
    keyUrl: "https://console.anthropic.com/settings/keys",
    models: [
      { id: "claude-sonnet-4-5", hint: "recommended" },
      { id: "claude-opus-4-1" },
      { id: "claude-haiku-4-5", hint: "fast + affordable" },
    ],
  },
  {
    id: "gemini",
    kind: "gemini",
    label: "Google (Gemini)",
    defaultBaseUrl: "https://generativelanguage.googleapis.com",
    keyUrl: "https://aistudio.google.com/apikey",
    models: [
      { id: "gemini-2.5-flash", hint: "recommended" },
      { id: "gemini-2.5-pro" },
    ],
  },
  {
    id: "groq",
    kind: "openai",
    label: "Groq (Llama & Mixtral)",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    keyUrl: "https://console.groq.com/keys",
    models: [
      { id: "llama-3.3-70b-versatile", hint: "flagship" },
      { id: "llama-3.1-8b-instant", hint: "ultra-fast" },
    ],
  },
  {
    id: "deepseek",
    kind: "openai",
    label: "DeepSeek",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    keyUrl: "https://platform.deepseek.com/api_keys",
    models: [
      { id: "deepseek-chat", hint: "V3 general" },
      { id: "deepseek-reasoner", hint: "R1 reasoning" },
    ],
  },
  {
    id: "mistral",
    kind: "openai",
    label: "Mistral",
    defaultBaseUrl: "https://api.mistral.ai/v1",
    keyUrl: "https://console.mistral.ai/api-keys/",
    models: [{ id: "mistral-large-latest" }, { id: "pixtral-large-latest" }],
  },
  {
    id: "xai",
    kind: "openai",
    label: "xAI Grok",
    defaultBaseUrl: "https://api.x.ai/v1",
    keyUrl: "https://console.x.ai/",
    models: [{ id: "grok-4" }, { id: "grok-3" }],
  },
  {
    id: "openrouter",
    kind: "openai",
    label: "OpenRouter",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    keyUrl: "https://openrouter.ai/keys",
    models: [
      { id: "openai/gpt-4o" },
      { id: "anthropic/claude-sonnet-4.5" },
      { id: "meta-llama/llama-3.3-70b-instruct" },
    ],
  },
  {
    id: "ollama",
    kind: "openai",
    label: "Ollama (local)",
    defaultBaseUrl: "http://localhost:11434/v1",
    keyUrl: "https://ollama.com/download",
    models: [
      { id: "llama3.2" },
      { id: "qwen2.5" },
      { id: "mistral" },
      { id: "deepseek-r1" },
    ],
    note: "Runs locally. No API key needed.",
    requiresKey: false,
  },
  {
    id: "lmstudio",
    kind: "openai",
    label: "LM Studio (local)",
    defaultBaseUrl: "http://localhost:1234/v1",
    keyUrl: "https://lmstudio.ai/",
    models: [],
    note: "Local GGUF models. No key needed.",
    requiresKey: false,
  },
];

// ───────────────────────────── TTS ─────────────────────────────
export const TTS_PROVIDERS: ProviderMeta[] = [
  {
    id: "zai",
    kind: "zai",
    label: "Z.ai TTS",
    defaultBaseUrl: "https://api.z.ai/api/paas/v4",
    keyUrl: "https://z.ai/model-api",
    models: [],
    note: "7 built-in studio voices.",
  },
  {
    id: "openai",
    kind: "openai",
    label: "OpenAI TTS",
    defaultBaseUrl: "https://api.openai.com/v1",
    keyUrl: "https://platform.openai.com/api-keys",
    models: [
      { id: "tts-1", hint: "standard" },
      { id: "tts-1-hd", hint: "higher fidelity" },
      { id: "gpt-4o-mini-tts", hint: "newest, most voices" },
    ],
  },
  {
    id: "elevenlabs",
    kind: "native",
    label: "ElevenLabs",
    defaultBaseUrl: "https://api.elevenlabs.io/v1",
    keyUrl: "https://elevenlabs.io/app/settings/api-keys",
    models: [{ id: "eleven_multilingual_v2" }, { id: "eleven_turbo_v2_5" }],
  },
];

// ───────────────────────────── IMAGE ─────────────────────────────
export const IMAGE_PROVIDERS: ProviderMeta[] = [
  {
    id: "zai",
    kind: "zai",
    label: "Z.ai CogView",
    defaultBaseUrl: "https://api.z.ai/api/paas/v4",
    keyUrl: "https://z.ai/model-api",
    models: [],
    note: "Built-in default art model, supports identity-locked edits.",
  },
  {
    id: "openai",
    kind: "native",
    label: "OpenAI Images",
    defaultBaseUrl: "https://api.openai.com/v1",
    keyUrl: "https://platform.openai.com/api-keys",
    models: [
      { id: "gpt-image-1", hint: "supports image edits" },
      { id: "dall-e-3", hint: "classic" },
    ],
  },
  {
    id: "stability",
    kind: "native",
    label: "Stability AI",
    defaultBaseUrl: "https://api.stability.ai",
    keyUrl: "https://platform.stability.ai/account/keys",
    models: [{ id: "sd3.5-large" }, { id: "sd3.5-medium" }],
  },
  {
    id: "fal",
    kind: "native",
    label: "fal.ai (Flux)",
    defaultBaseUrl: "https://fal.run",
    keyUrl: "https://fal.ai/dashboard/keys",
    models: [{ id: "fal-ai/flux-pro/v1.1" }, { id: "fal-ai/flux/dev" }],
  },
];

// ───────────────────────────── VIDEO ─────────────────────────────
export const VIDEO_PROVIDERS: ProviderMeta[] = [
  {
    id: "zai",
    kind: "zai",
    label: "Z.ai CogVideoX",
    defaultBaseUrl: "https://api.z.ai/api/paas/v4",
    keyUrl: "https://z.ai/model-api",
    models: [{ id: "cogvideox-3", hint: "5s 1080p clips" }],
    note: "Ken Burns render mode needs no AI video at all.",
  },
  {
    id: "runway",
    kind: "native",
    label: "Runway",
    defaultBaseUrl: "https://api.dev.runwayml.com/v1",
    keyUrl: "https://dev.runwayml.com/",
    models: [{ id: "gen4_turbo" }, { id: "gen3a_turbo" }],
  },
  {
    id: "luma",
    kind: "native",
    label: "Luma Dream Machine",
    defaultBaseUrl: "https://api.lumalabs.ai/dream-machine/v1",
    keyUrl: "https://lumalabs.ai/dream-machine/api/keys",
    models: [{ id: "ray-2" }, { id: "ray-flash-2" }],
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

export function providerMeta(
  capability: CapabilityId,
  id: string,
): ProviderMeta | undefined {
  return PROVIDERS_BY_CAPABILITY[capability].find((p) => p.id === id);
}

/** OpenAI TTS voices. The classic six work on every tts model. */
export const OPENAI_VOICES = [
  { id: "alloy", label: "Alloy — neutral, clear", classic: true },
  { id: "echo", label: "Echo — grounded, calm", classic: true },
  { id: "fable", label: "Fable — expressive, storyteller", classic: true },
  { id: "onyx", label: "Onyx — deep, authoritative", classic: true },
  { id: "nova", label: "Nova — bright, energetic", classic: true },
  { id: "shimmer", label: "Shimmer — warm, friendly", classic: true },
] as const;
