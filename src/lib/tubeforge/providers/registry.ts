// Provider registry — the menu of AI providers per task capability.
// Pure data, safe to import from both server adapters and client UI.

import { CHAT_MODELS } from "../types";

export type CapabilityId = "chat" | "tts" | "image" | "video";

export type ProviderKind = "zai" | "openai" | "anthropic" | "gemini" | "native";
export type ProviderId = string;

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
    label: "Groq",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    keyUrl: "https://console.groq.com/keys",
    models: [
      { id: "openai/gpt-oss-120b", hint: "recommended — fast + free tier" },
      { id: "openai/gpt-oss-20b", hint: "cheaper, smaller" },
      { id: "meta-llama/llama-4-scout-17b-16e-instruct", hint: "long context" },
      { id: "meta-llama/llama-4-maverick-17b-128e-instruct" },
      { id: "qwen/qwen3-32b" },
      { id: "deepseek-r1-distill-llama-70b", hint: "reasoning" },
    ],
    note: "gpt-oss-120b/20b are the free-tier successors to the retired Llama 3.x lineup.",
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
    id: "zhipu",
    kind: "native",
    label: "Zhipu GLM-TTS (voice cloning)",
    defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    keyUrl: "https://bigmodel.cn/usercenter/proj-mgmt/apikeys",
    models: [
      { id: "glm-tts", hint: "same 7 studio voices + your cloned voices" },
    ],
    note: "Clone any voice from a 3-second sample (Video → Voice → Clone), then narrate with it. Same studio voices as Z.ai plus every voice you clone.",
  },
  {
    id: "heygen",
    kind: "native",
    label: "HeyGen Voice (free)",
    defaultBaseUrl: "https://api.heygen.com",
    keyUrl: "https://platform.heygen.com/api-keys",
    models: [
      { id: "heygen-voice-1-turbo-free", hint: "free until 2026-11-30" },
    ],
    note: "Free API tier — 30 req/min. Pick a public voice id (e.g. Nadine 83548de556df48ba8c09c42a57c51d85).",
  },
  {
    id: "selfhost",
    kind: "native",
    label: "My Machine (self-hosted clone)",
    defaultBaseUrl: "http://localhost:8931",
    keyUrl: "https://github.com/resemble-ai/chatterbox",
    models: [
      { id: "chatterbox", hint: "English — MIT, commercial-OK (recommended)" },
      { id: "chatterbox-multilingual", hint: "23 languages" },
    ],
    note: "Free forever: open-source Chatterbox (MIT) on a host you control — your PC (voice-server/README.md), an Oracle Cloud Always Free VM, 24/7 (voice-server/oracle/README.md), or a free Hugging Face Space (voice-server/hf-space/README.md). Paste the host's URL as Base URL and its secret (--key / VOICE_KEY) as the API key. CPU speed — slower than paid APIs, but $0, no rate limits.",
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
    id: "pollinations",
    kind: "native",
    label: "Pollinations.ai (free, no key)",
    defaultBaseUrl: "https://image.pollinations.ai",
    keyUrl: "https://enter.pollinations.ai",
    models: [
      { id: "flux", hint: "best quality (recommended)" },
      { id: "turbo", hint: "faster, slightly lower quality" },
      { id: "flux-realism", hint: "photorealistic" },
    ],
    note: "No API key. Free tier is 1 image / 45s / IP (a 16-scene storyboard takes ~12 min). Buy a pollen key for unlimited at enter.pollinations.ai. No identity-locked edits (host scenes fall back to prompt-seeded generation).",
    requiresKey: false,
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
  {
    id: "replicate",
    kind: "native",
    label: "Replicate",
    defaultBaseUrl: "https://api.replicate.com/v1",
    keyUrl: "https://replicate.com/account/api-tokens",
    models: [
      { id: "black-forest-labs/flux-1.1-pro", hint: "FLUX Pro" },
      { id: "stability-ai/sdxl", hint: "SDXL" },
    ],
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
    id: "fal",
    kind: "native",
    label: "fal.ai Video (Free Credits)",
    defaultBaseUrl: "https://fal.run",
    keyUrl: "https://fal.ai/dashboard/keys",
    models: [
      { id: "fal-ai/fast-svd", hint: "Stable Video Diffusion" },
      {
        id: "fal-ai/minimax/video-01/image-to-video",
        hint: "MiniMax Hailuo Video",
      },
    ],
    note: "Includes free starting credits. Fast generation.",
  },
  {
    id: "magichour",
    kind: "native",
    label: "Magic Hour",
    defaultBaseUrl: "https://api.magichour.ai/v1",
    keyUrl: "https://magichour.ai/developer",
    models: [
      { id: "ltx-2.5", hint: "default, fast (up to 60s)" },
      { id: "wan-2.2", hint: "strong physics & camera motion" },
      { id: "kling-3.0", hint: "best cinematic quality" },
      { id: "minimax-h3", hint: "native audio" },
    ],
    note: "400 free credits on signup + 100 free credits daily. No credit card required.",
  },
  {
    id: "replicate",
    kind: "native",
    label: "Replicate Video (Free Credits)",
    defaultBaseUrl: "https://api.replicate.com/v1",
    keyUrl: "https://replicate.com/account/api-tokens",
    models: [{ id: "minimax/video-01", hint: "Hailuo Video" }],
    note: "Includes $5 free credits on signup.",
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

/**
 * Fail-fast registry lookup — for adapters that have already dispatched on
 * the provider id and need the registry row to exist. A missing row is a
 * deployment/build bug (adapter and registry out of sync), so it throws a
 * named error instead of letting a `!` surface as a TypeError three lines
 * later. S58/T-58.1.
 */
export function providerMetaRequired(
  capability: CapabilityId,
  id: string,
): ProviderMeta {
  const meta = providerMeta(capability, id);
  if (!meta) {
    throw new Error(
      `provider registry has no ${capability} provider "${id}" — adapter and registry are out of sync`,
    );
  }
  return meta;
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
