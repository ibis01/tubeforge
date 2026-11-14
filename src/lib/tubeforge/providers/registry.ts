// Provider registry — the menu of AI providers per task capability.
// Pure data, safe to import from both server adapters and client UI.

import { CHAT_MODELS } from "../types";

export type CapabilityId = "chat" | "tts" | "asr" | "image" | "video";

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
      { id: "deepseek-flash", hint: "fast general — peak $0.30/$1.20 per 1M" },
      {
        id: "deepseek-v4-pro",
        hint: "pro reasoning — peak $1.32/$3.96 per 1M",
      },
    ],
  },
  {
    id: "mistral",
    kind: "openai",
    label: "Mistral",
    defaultBaseUrl: "https://api.mistral.ai/v1",
    keyUrl: "https://console.mistral.ai/api-keys/",
    models: [{ id: "mistral-large-latest" }],
  },
  {
    id: "xai",
    kind: "openai",
    label: "xAI Grok",
    defaultBaseUrl: "https://api.x.ai/v1",
    keyUrl: "https://console.x.ai/",
    models: [{ id: "grok-4" }],
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
    id: "voicestudio",
    kind: "native",
    label: "VoiceStudio (self-hosted)",
    defaultBaseUrl: "http://127.0.0.1:3900",
    keyUrl: "https://github.com/debpalash/VoiceStudio",
    models: [
      // S121 — the audited engine hints carry the LICENSE verdicts (the
      // unverified-pricing law's sibling): an engine whose weights forbid
      // commercial use never reaches a paying render by silence — see
      // model-license-policy.ts (fail-closed) + docs/design/
      // s121-integration-roadmap.md. omnivoice is VoiceStudio's DEFAULT
      // engine and its weights are CC-BY-NC; the Apache/MIT engines below
      // are the permissive lanes.
      { id: "voxcpm2", hint: "Apache-2.0 — commercial-OK (recommended)" },
      { id: "cosyvoice", hint: "Apache-2.0 — commercial-OK" },
      { id: "kittentts", hint: "Apache-2.0, CPU-only — commercial-OK" },
      { id: "omnivoice", hint: "the default engine — CC-BY-NC weights, non-commercial" },
    ],
    note: "Your own VoiceStudio server (OpenAI-compatible API, default port 3900). Loopback servers need no key; remote ones take the OMNIVOICE_API_KEY as the API key. The AGPL app stays a separate service you run — TubeForge never bundles it.",
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

// ───────────────────────────── ASR ─────────────────────────────
// S121 — transcription is its OWN capability (it historically rode the tts
// capability; the asr setting FOLLOWS tts until an ai.asr row is saved, so
// today's behavior is the default and nothing breaks when it is unset).
export const ASR_PROVIDERS: ProviderMeta[] = [
  {
    id: "voicestudio",
    kind: "native",
    label: "VoiceStudio (self-hosted)",
    defaultBaseUrl: "http://127.0.0.1:3900",
    keyUrl: "https://github.com/debpalash/VoiceStudio",
    models: [
      // S121 — whisperx is VoiceStudio's primary ASR engine and the only one
      // whose word timestamps were verified to wav2vec2 forced-alignment
      // precision (±10-30 ms). moonshine emits NO timestamps — word-level
      // work silently degrades to the silence ladder when it is active.
      { id: "whisperx", hint: "verified word timestamps (±10-30 ms) — recommended" },
      { id: "faster-whisper", hint: "word timestamps" },
      { id: "moonshine", hint: "CPU-friendly, NO word timestamps" },
    ],
    note: "Word-level timestamps (verbose_json + word granularity) upgrade captions and the whiteboard anchors from derived to MEASURED timing. Same server as the VoiceStudio TTS row.",
  },
  {
    id: "openai",
    kind: "openai",
    label: "OpenAI Whisper",
    defaultBaseUrl: "https://api.openai.com/v1",
    keyUrl: "https://platform.openai.com/api-keys",
    models: [{ id: "whisper-1", hint: "word timestamps via verbose_json" }],
  },
  {
    id: "zai",
    kind: "zai",
    label: "Z.ai ASR",
    defaultBaseUrl: "https://api.z.ai/api/paas/v4",
    keyUrl: "https://z.ai/model-api",
    models: [],
    note: "The bundled SDK transcription — no word timestamps (the silence ladder covers timing).",
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
    note: "No API key, but the anonymous tier stamps a WATERMARK on every image and allows 1 image / 45s / IP — a 16-scene storyboard takes ~12 min. For watermark-free free images switch to Cloudflare, Together AI, or Hugging Face. No identity-locked edits (host scenes fall back to prompt-seeded generation).",
    requiresKey: false,
  },
  {
    id: "cloudflare",
    kind: "native",
    label: "Cloudflare Workers AI",
    defaultBaseUrl:
      "https://api.cloudflare.com/client/v4/accounts/YOUR_ACCOUNT_ID",
    keyUrl: "https://dash.cloudflare.com/profile/api-tokens",
    models: [
      {
        id: "@cf/black-forest-labs/flux-1-schnell",
        hint: "free — ~500 images/day",
      },
      { id: "@cf/stabilityai/stable-diffusion-xl-base-1.0", hint: "SDXL" },
    ],
    note: "Replace YOUR_ACCOUNT_ID in the base URL with your Cloudflare Account ID (Workers & Pages → sidebar). Free tier: 10,000 Neurons/day ≈ 500 FLUX.1-schnell images. No credit card required.",
  },
  {
    id: "huggingface",
    kind: "native",
    label: "Hugging Face",
    defaultBaseUrl: "https://api-inference.huggingface.co",
    keyUrl: "https://huggingface.co/settings/tokens",
    models: [
      { id: "black-forest-labs/FLUX.1-dev", hint: "high quality" },
      { id: "black-forest-labs/FLUX.1-schnell", hint: "faster" },
      { id: "stabilityai/stable-diffusion-xl-base-1.0", hint: "classic SDXL" },
    ],
    note: "Free tier: ~300 requests/hour. Requires an HF_TOKEN with read access (free to create, no credit card). Models cold-start (30-90s) and surface as a retryable rate limit.",
  },
  {
    id: "nvidia",
    kind: "native",
    label: "NVIDIA NIM",
    defaultBaseUrl: "https://ai.api.nvidia.com",
    keyUrl: "https://build.nvidia.com/explore/visual",
    models: [
      { id: "black-forest-labs/flux.1-dev", hint: "high quality" },
      { id: "black-forest-labs/flux.2-klein", hint: "newer, faster" },
    ],
    note: "Free tier: 1,000 inference credits/month. No credit card required. Key starts with nvapi-.",
  },
  {
    id: "together",
    kind: "native",
    label: "Together AI (FLUX.1-schnell)",
    defaultBaseUrl: "https://api.together.xyz/v1",
    keyUrl: "https://api.together.ai/settings/api-keys",
    models: [
      {
        id: "black-forest-labs/FLUX.1-schnell-Free",
        hint: "FREE — no watermark, ~10 images/min",
      },
      {
        id: "black-forest-labs/FLUX.1-schnell",
        hint: "paid — ~$0.004/image, higher limits",
      },
      {
        id: "black-forest-labs/FLUX.1.1-pro",
        hint: "premium — ~$0.04/image, best quality",
      },
    ],
    note: "The better free lane: a free API key unlocks FLUX.1-schnell-Free — real FLUX quality with NO watermark (unlike Pollinations' anonymous tier) and ~10 images/min instead of 1 per 45s. NOTE: Together now requires a one-time $15 credit purchase before the API key is issued (they refund remaining credit if you never exceed the free tier). For a truly card-free option, use Cloudflare Workers AI, Hugging Face, or NVIDIA NIM.",
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
    id: "agnes",
    kind: "native",
    label: "Agnes AI (Free)",
    defaultBaseUrl: "https://apihub.agnes-ai.com",
    keyUrl: "https://platform.agnes-ai.com",
    models: [{ id: "agnes-video-2.5", hint: "free — 720P, async polling" }],
    note: "Completely free video generation. No credit card required.",
  },
  {
    id: "nvidia",
    kind: "native",
    label: "NVIDIA NIM Wan2.2",
    defaultBaseUrl: "https://ai.api.nvidia.com",
    keyUrl: "https://build.nvidia.com/explore/visual",
    models: [
      { id: "wan-ai/wan2.2-animate-2-14b", hint: "OpenAI-compatible endpoint" },
    ],
    note: "Free tier: 1,000 credits/month. No credit card required.",
  },
  {
    id: "kling",
    kind: "native",
    label: "Kling AI",
    defaultBaseUrl: "https://api-beijing.klingai.com",
    keyUrl: "https://app.klingai.com/dev",
    models: [{ id: "kling-v1", hint: "image-to-video" }],
    note: "New users get one-time free credits + daily free credits.",
  },
  {
    id: "hailuo",
    kind: "native",
    label: "Hailuo AI (MiniMax)",
    defaultBaseUrl: "https://api.minimax.io",
    keyUrl: "https://platform.minimax.io",
    models: [
      { id: "MiniMax-Hailuo-02", hint: "1080P, 6s" },
      { id: "MiniMax-Hailuo-2.3", hint: "newer, faster" },
    ],
    note: "New users get 200 free credits on signup.",
  },
  {
    id: "ltxstudio",
    kind: "native",
    label: "LTX Studio",
    defaultBaseUrl: "https://api.ltx.io",
    keyUrl: "https://ltx.studio",
    models: [
      { id: "ltx-2-5-pro", hint: "high quality, 8s" },
      { id: "ltx-2-5-fast", hint: "faster, lower cost" },
    ],
    note: "Free tier: 800 one-time credits on signup.",
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
    note: "125 one-time free credits on signup.",
  },
  {
    id: "luma",
    kind: "native",
    label: "Luma Dream Machine",
    defaultBaseUrl: "https://api.lumalabs.ai/dream-machine/v1",
    keyUrl: "https://lumalabs.ai/dream-machine/api/keys",
    models: [{ id: "ray-2" }, { id: "ray-flash-2" }],
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
];

export const PROVIDERS_BY_CAPABILITY: Record<CapabilityId, ProviderMeta[]> = {
  chat: CHAT_PROVIDERS,
  tts: TTS_PROVIDERS,
  asr: ASR_PROVIDERS,
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
  asr: {
    label: "Transcription",
    icon: "AudioLines",
    desc: "Word-timed ASR for captions, anchors and narration checks (follows the voiceover provider until set)",
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

/** S98 — does an image TEST dispatch on this provider/model cost $0?
 *
 *  Updated for the S98 free tier expansion:
 *   • Pollinations: keyless, always the free (watermarked) lane.
 *   • Cloudflare Workers AI: 10,000 Neurons/day free — every test is $0
 *     until the daily quota is hit.
 *   • Hugging Face: ~300 req/hr free — every test is $0 until the rate
 *     limit is hit (which surfaces as a retryable 429).
 *   • NVIDIA NIM: 1,000 credits/month free — every test is $0 until the
 *     credits are exhausted.
 *   • Together AI: the `-Free` model (or a BLANK model, which resolves to
 *     the registry default FLUX.1-schnell-Free) is $0.
 *  Every other provider/model may bill, so the paid-test confirm stays.
 *
 *  Shared by the settings test route (whether to demand confirmCost) and the
 *  settings UI (the hint under the Test button); one predicate so the two
 *  can never drift.
 *
 *  Lives HERE, not in the image adapter: settings-view is a client component
 *  and importing from image.ts would drag zai-client.ts (the server-only
 *  z-ai-web-dev-sdk) into the browser bundle — the production build caught
 *  exactly that when the predicate first shipped in the adapter module.
 *  registry.ts is already client-safe (the view imports it for the selects). */
export function imageTestFreeLane(provider: string, model: string): boolean {
  if (provider === "pollinations") return true;
  if (provider === "cloudflare") return true;
  if (provider === "huggingface") return true;
  if (provider === "nvidia") return true;
  if (provider === "together") {
    const m = model.trim();
    return m === "" || /free/i.test(m);
  }
  return false;
}
