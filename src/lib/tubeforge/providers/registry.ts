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
  /** Affordability tier — the settings UI sorts and badges by it. */
  tier?: ProviderTier;
  /** One-line pricing hint (the UI shows it under the model picker). */
  pricing?: string;
  /** The per-provider setup walkthrough (the UI's "How to set this up" panel). */
  setup?: ProviderSetup;
}

/** Affordability tiers. "free" = a usable $0 lane (free tier or keyless),
 *  "local" = your own machine ($0 forever, you host it), "budget" = the
 *  cheapest paid lanes (pennies per generation or free credits),
 *  "premium" = flagship pricing. Advisory — the test button's confirmCost
 *  gate is the enforcement. */
export type ProviderTier = "free" | "local" | "budget" | "premium";

export interface ProviderSetup {
  /** Numbered setup steps, shown verbatim when the provider is selected. */
  steps: string[];
  /** The console/dashboard URL (create the account, manage keys). */
  consoleUrl?: string;
  /** The docs home for this provider's API. */
  docsUrl?: string;
  /** The pricing page. */
  pricingUrl?: string;
  /** What the API key looks like (prefix/shape) — paste-check for the user. */
  keyFormat?: string;
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
      { id: "gpt-6.1-terra", hint: "recommended — current gen, $1/$5 per 1M" },
      { id: "gpt-6-luna", hint: "cheapest — $0.10/$0.50 per 1M, fast" },
      { id: "gpt-6.1-sol", hint: "$2/$10 — deeper quality" },
      { id: "gpt-6-astra", hint: "flagship — $10/$50 per 1M" },
      { id: "gpt-4o-mini", hint: "legacy — prior gen, still callable" },
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
      { id: "gemini-3.6-flash", hint: "recommended — current flash gen" },
      { id: "gemini-3.5-flash-lite", hint: "fast + cheap" },
      { id: "gemini-2.5-pro", hint: "legacy — deep reasoning, deprecation pending" },
      { id: "gemini-2.5-flash", hint: "legacy — prior gen, still served" },
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
      { id: "meta-llama/llama-4-scout-17b-16e-instruct", hint: "legacy — being phased out" },
      { id: "meta-llama/llama-4-maverick-17b-128e-instruct", hint: "legacy — being phased out" },
      { id: "qwen/qwen3-32b" },
      { id: "deepseek-r1-distill-llama-70b", hint: "legacy — old distill" },
    ],
    note: "gpt-oss-120b/20b are the free-tier workhorses; the Llama 3.x/4 lineup is being phased out on Groq.",
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
    models: [
      { id: "grok-4", hint: "recommended — $3/$15 per 1M" },
      { id: "grok-4.1-fast", hint: "newer 4.1 Fast gen" },
    ],
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
      { id: "voxcpm2", hint: "Apache-2.0 — commercial-OK (recommended)" },
      { id: "cosyvoice", hint: "Apache-2.0 — commercial-OK" },
      { id: "kittentts", hint: "Apache-2.0, CPU-only — commercial-OK" },
      {
        id: "omnivoice",
        hint: "the default engine — CC-BY-NC weights, non-commercial",
      },
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
    id: "kokoro",
    kind: "openai",
    label: "Kokoro (local, lightweight)",
    defaultBaseUrl: "http://localhost:8880/v1",
    keyUrl: "https://huggingface.co/hexgrad/Kokoro-82M",
    models: [
      { id: "kokoro", hint: "Apache-2.0 — commercial-OK; 82M params, CPU-friendly" },
    ],
    note: "S173's lightweight local candidate: Apache-2.0 weights, an OpenAI-compatible server (kokoro-fastapi), and a small footprint that runs where Chatterbox is too heavy — the same $0-per-generation contract as selfhost. Paste the server URL as Base URL; no key needed.",
    requiresKey: false,
  },
  {
    id: "openai",
    kind: "openai",
    label: "OpenAI TTS",
    defaultBaseUrl: "https://api.openai.com/v1",
    keyUrl: "https://platform.openai.com/api-keys",
    models: [
      { id: "gpt-4o-mini-tts", hint: "recommended — newest; retires Jan 6, 2027" },
      { id: "tts-1-hd", hint: "legacy — retires Jan 6, 2027" },
      { id: "tts-1", hint: "classic — retires Jan 6, 2027" },
    ],
    note: "OpenAI announced the TTS shutdown (tts-1, tts-1-hd, gpt-4o-mini-tts) for Jan 6, 2027 — all still fully served until then; plan a Voiceover migration if you stay on OpenAI.",
  },
  {
    id: "elevenlabs",
    kind: "native",
    label: "ElevenLabs",
    defaultBaseUrl: "https://api.elevenlabs.io/v1",
    keyUrl: "https://elevenlabs.io/app/settings/api-keys",
    models: [{ id: "eleven_multilingual_v2" }, { id: "eleven_turbo_v2_5" }],
  },
  {
    id: "gemini",
    kind: "gemini",
    label: "Google (Gemini TTS)",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    keyUrl: "https://aistudio.google.com/apikey",
    models: [
      { id: "gemini-3.8-flash-tts", hint: "highly expressive (recommended)" },
      { id: "gemini-3.8-flash-lite-tts", hint: "faster, cheaper" },
    ],
    note: "Native Gemini TTS via generateContent. Returns WAV audio. Ensure your Google AI Studio key has access to TTS models.",
  },
  {
    id: "cartesia",
    kind: "native",
    label: "Cartesia (Sonic)",
    defaultBaseUrl: "https://api.cartesia.ai",
    keyUrl: "https://play.cartesia.ai/console",
    models: [
      { id: "sonic-3.6", hint: "recommended — current gen" },
      { id: "sonic-3.5", hint: "legacy — Older Models doc" },
      { id: "sonic-3", hint: "legacy — Older Models doc" },
    ],
    note: "Ultra-low latency, highly emotive TTS. Requires X-API-Key and Cartesia-Version headers. Voice pickers load YOUR account's voices live (custom voices included) — anything else falls back to a real account voice, never a stale hard-coded id.",
  },
  {
    id: "deepgram",
    kind: "native",
    label: "Deepgram (Aura)",
    defaultBaseUrl: "https://api.deepgram.com/v1",
    keyUrl: "https://console.deepgram.com/",
    models: [
      { id: "aura-2-thalia-en", hint: "recommended female" },
      { id: "aura-2-asteria-en", hint: "expressive female" },
      { id: "aura-2-orpheus-en", hint: "deep male" },
      { id: "aura-2-arcas-en", hint: "casual male" },
    ],
    note: "Deepgram Aura-2 voices. New accounts get $200 free credits.",
  },
  {
    id: "playht",
    kind: "native",
    label: "PlayHT",
    defaultBaseUrl: "https://api.play.ht/api/v2",
    keyUrl: "https://play.ht/studio/api-access",
    models: [
      { id: "Play3.0-mini", hint: "realtime, low-latency" },
      { id: "PlayDialog", hint: "expressive conversational" },
      { id: "PlayHT2.0-turbo", hint: "fast turbo" },
    ],
    note: "Requires both X-USER-ID and Authorization headers. Enter your credentials as 'userId:apiKey' in the API Key field.",
  },
];

// ───────────────────────────── ASR ─────────────────────────────
export const ASR_PROVIDERS: ProviderMeta[] = [
  {
    id: "voicestudio",
    kind: "native",
    label: "VoiceStudio (self-hosted)",
    defaultBaseUrl: "http://127.0.0.1:3900",
    keyUrl: "https://github.com/debpalash/VoiceStudio",
    models: [
      {
        id: "whisperx",
        hint: "verified word timestamps (±10-30 ms) — recommended",
      },
      { id: "faster-whisper", hint: "word timestamps" },
      { id: "moonshine", hint: "CPU-friendly, NO word timestamps" },
    ],
    note: "Word-level timestamps upgrade captions and the whiteboard anchors from derived to MEASURED timing. Same server as the VoiceStudio TTS row.",
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
    id: "groq",
    kind: "openai",
    label: "Groq Whisper (fast, free tier)",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    keyUrl: "https://console.groq.com/keys",
    models: [
      { id: "whisper-large-v3-turbo", hint: "recommended — fast, word timestamps via verbose_json" },
      { id: "whisper-large-v3", hint: "legacy — highest accuracy" },
    ],
    note: "The same Groq key as Script writing — OpenAI-compatible transcription shape (verbose_json word timestamps supported). Free tier covers a regular posting habit.",
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
      { id: "black-forest-labs/flux.2-klein-4b", hint: "newer, faster" },
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
  {
    id: "ideogram",
    kind: "native",
    label: "Ideogram (text in images)",
    defaultBaseUrl: "https://api.ideogram.ai/v1",
    keyUrl: "https://ideogram.ai",
    models: [{ id: "ideogram-v3", hint: "legible TEXT inside images — posters, thumbnails" }],
    note: "The specialty model for words rendered inside the picture — thumbnails and title cards that read correctly.",
  },
  {
    id: "recraft",
    kind: "native",
    label: "Recraft (vector-style art)",
    defaultBaseUrl: "https://external.api.recraft.ai/v1",
    keyUrl: "https://www.recraft.ai",
    models: [{ id: "recraftv3", hint: "vector-style sets, brand icons" }],
    note: "Vector-STYLE art and brand-consistent icon sets — a good artwork lane for clean design looks.",
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
    models: [
      { id: "kling-v2-master", hint: "recommended — current 2.x gen" },
      { id: "kling-v1", hint: "legacy — v1 still served" },
    ],
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
    models: [{ id: "gen4_turbo", hint: "recommended" }],
    note: "gen3a_turbo was retired (Aug 2026 deprecated-tools sweep). 125 one-time free credits on signup.",
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

// ─────────────────────────────────────────────────────────────────────────
// The friendly layer: affordability tiers + per-provider setup guides.
//
// KEYS ARE `${capability}:${providerId}` — one record, both surfaces read
// it: the settings UI (the "How to set this up" panel + the tier badges)
// and the registry battery (completeness pin: every provider with
// requiresKey or a paid tier MUST carry a setup entry — a new registry
// row without one fails the battery, so the UI can never show a blank
// panel).
//
// Pricing hints are ADVISORY (the S98 law): they change upstream without
// notice, so they read "as of late 2026" and the confirmCost gate stays
// the enforcement. Steps describe the CURRENT console flows.
// ─────────────────────────────────────────────────────────────────────────

interface ProviderEnrichment {
  tier: ProviderTier;
  pricing: string;
  setup: ProviderSetup;
}

const ENRICHMENT: Record<string, ProviderEnrichment> = {
  // ── CHAT (script writing) ──
  "chat:zai": {
    tier: "free",
    pricing: "glm-4.5-flash: free. Flagship GLM models: pennies per script.",
    setup: {
      steps: [
        "Nothing to configure — the built-in gateway works out of the box with the shared credentials below.",
        "Optional: create your own z.ai account (z.ai/model-api) and copy your API key.",
        "Paste the key into Shared AI credentials — every capability left on Z.ai uses it, including background jobs.",
        "Pick a model: glm-4.5-flash is the $0 workhorse; flagship models cost more and read better.",
        "Hit Test — script writing routes through your key the moment it is saved.",
      ],
      consoleUrl: "https://z.ai/model-api",
      docsUrl: "https://docs.z.ai/guides/llm/glm-4.5",
      pricingUrl: "https://z.ai/model-api",
      keyFormat: "long hex/base64 token from the z.ai console",
    },
  },
  "chat:openai": {
    tier: "premium",
    pricing: "gpt-6-luna $0.10/$0.50 per 1M; gpt-6.1-terra $1/$5; flagship $10/$50.",
    setup: {
      steps: [
        "Create an OpenAI account and add prepaid credit (Billing → Add payment, from $5 — the API is prepaid, not subscription).",
        "platform.openai.com/api-keys → Create a new secret key (starts sk-).",
        "Paste the key here. Keys are encrypted at rest and never leave this deployment.",
        "Pick gpt-6-luna to keep script costs near zero, gpt-6.1-terra for the current-gen quality floor.",
        "Test — a full script generation costs fractions of a cent on the cheap models.",
      ],
      consoleUrl: "https://platform.openai.com/api-keys",
      docsUrl: "https://platform.openai.com/docs",
      pricingUrl: "https://openai.com/api/pricing",
      keyFormat: "sk-...",
    },
  },
  "chat:groq": {
    tier: "free",
    pricing: "Free tier: generous daily token limits, resets daily. Paid lane is cheap.",
    setup: {
      steps: [
        "Sign up at console.groq.com — no credit card needed.",
        "console.groq.com/keys → Create API Key (starts gsk_).",
        "Paste the key here.",
        "Pick openai/gpt-oss-120b — the free-tier workhorse, extremely fast.",
        "Test — free tier rate-limits by tokens/day; a daily script habit fits comfortably.",
      ],
      consoleUrl: "https://console.groq.com/keys",
      docsUrl: "https://console.groq.com/docs/openai",
      pricingUrl: "https://groq.com/pricing",
      keyFormat: "gsk_...",
    },
  },
  "chat:gemini": {
    tier: "free",
    pricing: "AI Studio key: free tier with daily limits; flash-lite is cents per 1M.",
    setup: {
      steps: [
        "Open aistudio.google.com with any Google account.",
        "Get API key → Create API key (free tier activates automatically, no card).",
        "Paste the key here.",
        "Pick gemini-3.6-flash for daily driving; flash-lite when volume matters.",
        "Test — free tier limits reset daily; paid billing is per-token and cheap.",
      ],
      consoleUrl: "https://aistudio.google.com/apikey",
      docsUrl: "https://ai.google.dev/gemini-api/docs",
      pricingUrl: "https://ai.google.dev/pricing",
      keyFormat: "AIza...",
    },
  },
  "chat:deepseek": {
    tier: "budget",
    pricing: "deepseek-flash peak $0.30/$1.20 per 1M — among the cheapest paid lanes.",
    setup: {
      steps: [
        "Sign up at platform.deepseek.com.",
        "API Keys → Create new key.",
        "Top up from $2 (card or crypto) — pure pay-as-you-go, no subscription.",
        "Paste the key here and pick deepseek-flash (fast) or deepseek-v4-pro (reasoning).",
        "Test — one script costs well under a cent.",
      ],
      consoleUrl: "https://platform.deepseek.com/api_keys",
      docsUrl: "https://api-docs.deepseek.com",
      pricingUrl: "https://api-docs.deepseek.com/quick_start/pricing",
      keyFormat: "sk-...",
    },
  },
  "chat:anthropic": {
    tier: "premium",
    pricing: "claude-haiku-4-5 is the affordable lane; Sonnet is the quality lane.",
    setup: {
      steps: [
        "Create a console.anthropic.com account.",
        "Settings → Keys → Create key.",
        "Add prepaid credit (Billing, from $5).",
        "Paste the key here; pick claude-haiku-4-5 for affordable scripts or claude-sonnet-4-5 for depth.",
        "Test — a script costs a fraction of a cent on Haiku.",
      ],
      consoleUrl: "https://console.anthropic.com/settings/keys",
      docsUrl: "https://docs.anthropic.com",
      pricingUrl: "https://www.anthropic.com/pricing",
      keyFormat: "sk-ant-...",
    },
  },
  "chat:mistral": {
    tier: "budget",
    pricing: "Free experiment tier on signup; paid per-token afterwards.",
    setup: {
      steps: [
        "Sign up at console.mistral.ai (the free experiment tier needs no card).",
        "API Keys → Create new key.",
        "Paste the key here.",
        "Pick mistral-large-latest (the free tier serves the small models).",
        "Test — the response confirms the key and the model.",
      ],
      consoleUrl: "https://console.mistral.ai/api-keys/",
      docsUrl: "https://docs.mistral.ai",
      pricingUrl: "https://mistral.ai/pricing",
      keyFormat: "long alpha token",
    },
  },
  "chat:xai": {
    tier: "premium",
    pricing: "grok-4 $3/$15 per 1M; grok-4.1-fast is the cheaper lane.",
    setup: {
      steps: [
        "Sign up at console.x.ai.",
        "API Keys → Create key.",
        "Add prepaid credit.",
        "Paste the key here and pick grok-4.1-fast for value or grok-4 for flagship quality.",
        "Test — the response confirms the key and the model.",
      ],
      consoleUrl: "https://console.x.ai/",
      docsUrl: "https://docs.x.ai",
      pricingUrl: "https://x.ai/api",
      keyFormat: "xai-...",
    },
  },
  "chat:openrouter": {
    tier: "budget",
    pricing: "Models suffixed :free cost $0; paid models pass through at provider price.",
    setup: {
      steps: [
        "Sign up at openrouter.ai.",
        "Keys → Create key (starts sk-or-).",
        "Optional: add $5 credit to unlock the paid catalog (the :free models work without it).",
        "Paste the key here; try meta-llama/llama-3.3-70b-instruct:free for $0 scripts.",
        "Test — the response names the route it took.",
      ],
      consoleUrl: "https://openrouter.ai/keys",
      docsUrl: "https://openrouter.ai/docs",
      pricingUrl: "https://openrouter.ai/models",
      keyFormat: "sk-or-...",
    },
  },
  "chat:ollama": {
    tier: "local",
    pricing: "$0 forever — runs on your machine.",
    setup: {
      steps: [
        "Install Ollama from ollama.com/download.",
        "Pull a model: ollama pull llama3.2 (or qwen2.5 / deepseek-r1).",
        "Keep the server running (it starts automatically; default port 11434).",
        "Paste http://localhost:11434/v1 as Base URL if you changed it — no API key needed.",
        "Test — the model runs locally, so nothing leaves your machine.",
      ],
      consoleUrl: "https://ollama.com/download",
      docsUrl: "https://github.com/ollama/ollama/blob/main/docs/api.md",
      keyFormat: "none — leave the key blank",
    },
  },
  "chat:lmstudio": {
    tier: "local",
    pricing: "$0 forever — runs on your machine.",
    setup: {
      steps: [
        "Install LM Studio from lmstudio.ai and download any GGUF chat model.",
        "Start the local server: Developer tab → Start Server (default port 1234).",
        "Paste http://localhost:1234/v1 as Base URL — no key needed.",
        "Leave the model blank to use whatever the server has loaded.",
        "Test — the response confirms the key and the model.",
      ],
      consoleUrl: "https://lmstudio.ai/",
      docsUrl: "https://lmstudio.ai/docs/app/api",
      keyFormat: "none — leave the key blank",
    },
  },

  // ── TTS (voiceover) ──
  "tts:zai": {
    tier: "free",
    pricing: "7 built-in studio voices via the shared key — voiceover is $0 on flash tiers.",
    setup: {
      steps: [
        "Works out of the box with the shared credentials — no separate signup.",
        "Optional: your own z.ai key in Shared AI credentials gives you the same 7 voices on your account.",
        "Pick a voice in Video → Voice; the provider test confirms access.",
      ],
      consoleUrl: "https://z.ai/model-api",
      docsUrl: "https://docs.z.ai",
      keyFormat: "shared key — or leave blank for the built-in gateway",
    },
  },
  "tts:voicestudio": {
    tier: "local",
    pricing: "$0 — your own server (Apache-2.0 engines).",
    setup: {
      steps: [
        "Run the VoiceStudio server on any machine you control (github.com/debpalash/VoiceStudio — docker one-liner in its README).",
        "Keep its default port 3900, or paste your server URL as Base URL.",
        "Loopback servers need no key; remote ones take the OMNIVOICE_API_KEY value as the API key.",
        "Pick voxcpm2 or cosyvoice (both Apache-2.0, commercial-OK) — kittentts runs CPU-only.",
        "Test — word-perfect for the voiceover lane and it powers word-timed ASR too.",
      ],
      consoleUrl: "https://github.com/debpalash/VoiceStudio",
      docsUrl: "https://github.com/debpalash/VoiceStudio/blob/main/README.md",
      keyFormat: "OMNIVOICE_API_KEY value (remote only)",
    },
  },
  "tts:selfhost": {
    tier: "local",
    pricing: "$0 forever — open-source Chatterbox (MIT) on a host you control.",
    setup: {
      steps: [
        "Host Chatterbox yourself: your PC (voice-server/README.md in this repo), an Oracle Always-Free VM (voice-server/oracle/README.md), or a free Hugging Face Space (voice-server/hf-space/README.md).",
        "Note the host's URL and its secret (--key / VOICE_KEY).",
        "Paste the URL as Base URL and the secret as the API key.",
        "Pick chatterbox (English, MIT, commercial-OK) or chatterbox-multilingual (23 languages).",
        "Test — CPU speed is slower than paid APIs but there are no rate limits and no bill.",
      ],
      consoleUrl: "https://github.com/resemble-ai/chatterbox",
      docsUrl: "https://github.com/resemble-ai/chatterbox",
      keyFormat: "the host's VOICE_KEY secret",
    },
  },
  "tts:kokoro": {
    tier: "local",
    pricing: "$0 — 82M-param Apache-2.0 model, CPU-friendly.",
    setup: {
      steps: [
        "Run kokoro-fastapi (github.com/reinsbreadcrumbs/kokoro-fastapi — docker) or any OpenAI-compatible Kokoro server.",
        "Paste the server URL as Base URL (default http://localhost:8880/v1).",
        "No key needed.",
        "Pick the kokoro model.",
        "Test — the lightweight lane where Chatterbox is too heavy.",
      ],
      consoleUrl: "https://huggingface.co/hexgrad/Kokoro-82M",
      docsUrl: "https://huggingface.co/hexgrad/Kokoro-82M",
      keyFormat: "none — leave the key blank",
    },
  },
  "tts:zhipu": {
    tier: "budget",
    pricing: "GLM-TTS is pay-per-character on Zhipu; very cheap at script lengths.",
    setup: {
      steps: [
        "Create a bigmodel.cn account.",
        "User Center → API Keys → create one.",
        "Paste the key here.",
        "Pick glm-tts — the same 7 studio voices plus any voice you clone (Video → Voice → Clone, a 3-second sample).",
        "Test — the response confirms the key and the model.",
      ],
      consoleUrl: "https://bigmodel.cn/usercenter/proj-mgmt/apikeys",
      docsUrl: "https://docs.bigmodel.cn",
      keyFormat: "hex token id.secret",
    },
  },
  "tts:heygen": {
    tier: "free",
    pricing: "Free API tier — 30 req/min, free turbo voice until 2026-11-30.",
    setup: {
      steps: [
        "Create a HeyGen account at platform.heygen.com.",
        "Settings → API Keys → create one.",
        "Paste the key here.",
        "Pick heygen-voice-1-turbo-free; the note lists a known public voice id you can paste as the model.",
        "Test — 30 requests/minute on the free tier.",
      ],
      consoleUrl: "https://platform.heygen.com/api-keys",
      docsUrl: "https://docs.heygen.com",
      keyFormat: "hex key from HeyGen settings",
    },
  },
  "tts:openai": {
    tier: "premium",
    pricing: "gpt-4o-mini-tts ~$0.015/min class; all TTS models retire Jan 6, 2027.",
    setup: {
      steps: [
        "Use the SAME OpenAI key as Script writing (or a separate one from platform.openai.com/api-keys).",
        "Paste the key here, or use the 'Use the same account as Script writing' button.",
        "Pick gpt-4o-mini-tts (the newest voice model).",
        "Heads-up: OpenAI retires its TTS models Jan 6, 2027 — plan a migration to another voice provider.",
        "Test — the response confirms the key and the model.",
      ],
      consoleUrl: "https://platform.openai.com/api-keys",
      docsUrl: "https://platform.openai.com/docs/guides/text-to-speech",
      pricingUrl: "https://openai.com/api/pricing",
      keyFormat: "sk-...",
    },
  },
  "tts:elevenlabs": {
    tier: "premium",
    pricing: "Free tier: 10k credits/month; paid from $5/mo.",
    setup: {
      steps: [
        "Create an elevenlabs.io account.",
        "Profile → API Keys → create one.",
        "Paste the key here.",
        "Pick eleven_multilingual_v2 (quality) or eleven_turbo_v2_5 (faster, cheaper).",
        "Test — the free tier's monthly credits cover a handful of narrations.",
      ],
      consoleUrl: "https://elevenlabs.io/app/settings/api-keys",
      docsUrl: "https://elevenlabs.io/docs",
      pricingUrl: "https://elevenlabs.io/pricing",
      keyFormat: "32-char hex key",
    },
  },
  "tts:gemini": {
    tier: "budget",
    pricing: "Flash-TTS classes are cents per million characters; free tier covers trials.",
    setup: {
      steps: [
        "Use any AI Studio key (aistudio.google.com/apikey) with TTS-model access.",
        "Paste the key here (or copy from the Script writing row).",
        "Pick gemini-3.8-flash-tts (expressive) or gemini-3.8-flash-lite-tts (cheaper).",
        "Test — returns WAV audio.",
      ],
      consoleUrl: "https://aistudio.google.com/apikey",
      docsUrl: "https://ai.google.dev/gemini-api/docs/speech-generation",
      keyFormat: "AIza...",
    },
  },
  "tts:cartesia": {
    tier: "premium",
    pricing: "Free tier available; paid from ~$5/mo — ultra-low latency.",
    setup: {
      steps: [
        "Create an account at play.cartesia.ai.",
        "Console → API Keys → create one.",
        "Paste the key here.",
        "Pick sonic-3.6 (current gen).",
        "Test — voice pickers load YOUR account's voices live, custom voices included.",
      ],
      consoleUrl: "https://play.cartesia.ai/console",
      docsUrl: "https://docs.cartesia.ai",
      keyFormat: "X-API-Key value",
    },
  },
  "tts:deepgram": {
    tier: "budget",
    pricing: "$200 free credits on new accounts — months of narration at Aura prices.",
    setup: {
      steps: [
        "Create a console.deepgram.com account (the $200 credit activates on signup, no card).",
        "API Keys → create one.",
        "Paste the key here.",
        "Pick an aura-2 voice (thalia/asteria/orpheus/arcas).",
        "Test — the response confirms the key and the model.",
      ],
      consoleUrl: "https://console.deepgram.com/",
      docsUrl: "https://developers.deepgram.com",
      keyFormat: "32-char hex key",
    },
  },
  "tts:playht": {
    tier: "budget",
    pricing: "Free trial credits; paid per-character afterwards.",
    setup: {
      steps: [
        "Create a play.ht account and open Studio → API Access.",
        "Copy BOTH the User ID and the API Key.",
        "Enter them as 'userId:apiKey' in the API Key field (the colon format is required).",
        "Pick Play3.0-mini for realtime narration.",
        "Test — the response confirms the key and the model.",
      ],
      consoleUrl: "https://play.ht/studio/api-access",
      docsUrl: "https://docs.play.ht",
      keyFormat: "userId:apiKey (both, colon-separated)",
    },
  },

  // ── ASR (transcription) ──
  "asr:voicestudio": {
    tier: "local",
    pricing: "$0 — word-timestamp ASR on your own server.",
    setup: {
      steps: [
        "Run the same VoiceStudio server as the Voiceover row (port 3900 by default).",
        "Pick whisperx — verified word timestamps that upgrade captions and whiteboard anchors from derived to MEASURED timing.",
        "faster-whisper is the fallback; moonshine runs CPU-only but has NO word timestamps.",
        "No key for loopback servers.",
        "Test — the response confirms the key and the model.",
      ],
      consoleUrl: "https://github.com/debpalash/VoiceStudio",
      keyFormat: "OMNIVOICE_API_KEY value (remote only)",
    },
  },
  "asr:groq": {
    tier: "free",
    pricing: "Free tier on whisper-large-v3-turbo; paid lane is ~$0.04/hour of audio.",
    setup: {
      steps: [
        "The SAME Groq key as Script writing works here (console.groq.com/keys).",
        "Paste the key, or use the 'Use the same account as Script writing' button after configuring Groq there.",
        "Pick whisper-large-v3-turbo.",
        "Test — Groq serves the OpenAI transcription shape (word timestamps via verbose_json).",
      ],
      consoleUrl: "https://console.groq.com/keys",
      docsUrl: "https://console.groq.com/docs/speech-to-text",
      pricingUrl: "https://groq.com/pricing",
      keyFormat: "gsk_...",
    },
  },
  "asr:openai": {
    tier: "budget",
    pricing: "whisper-1 ~$0.006/min — pennies per narration.",
    setup: {
      steps: [
        "Use the same OpenAI key as Script writing.",
        "Paste the key (or copy from the Script writing row).",
        "Pick whisper-1 — word timestamps via verbose_json.",
        "Test — the response confirms the key and the model.",
      ],
      consoleUrl: "https://platform.openai.com/api-keys",
      docsUrl: "https://platform.openai.com/docs/guides/speech-to-text",
      keyFormat: "sk-...",
    },
  },
  "asr:zai": {
    tier: "free",
    pricing: "Bundled SDK transcription via the shared key — $0.",
    setup: {
      steps: [
        "Works out of the box with the shared credentials.",
        "No word timestamps — the silence ladder derives timing instead (captions stay aligned).",
        "Pick this when you do not need measured word timing.",
      ],
      consoleUrl: "https://z.ai/model-api",
      keyFormat: "shared key — or leave blank for the built-in gateway",
    },
  },

  // ── IMAGE (artwork) ──
  "image:zai": {
    tier: "free",
    pricing: "CogView via the shared key; thumbnails and storyboard art are $0 on flash tiers.",
    setup: {
      steps: [
        "Works out of the box with the shared credentials.",
        "Supports identity-locked edits (character consistency across scenes).",
        "Optional: your own z.ai key in Shared AI credentials.",
        "Test — the response confirms the key and the model.",
      ],
      consoleUrl: "https://z.ai/model-api",
      keyFormat: "shared key — or leave blank for the built-in gateway",
    },
  },
  "image:pollinations": {
    tier: "free",
    pricing: "$0, keyless — watermarked, 1 image/45s anonymous lane.",
    setup: {
      steps: [
        "No account, no key — pick it and Test.",
        "Know the trade-offs: every image is watermarked and the anonymous lane allows 1 image per 45s per IP (a 16-scene storyboard takes ~12 min).",
        "For watermark-free free images use Cloudflare, Together (-Free), Hugging Face, or NVIDIA instead.",
      ],
      consoleUrl: "https://enter.pollinations.ai",
      docsUrl: "https://github.com/pollinations/pollinations/blob/master/APIS.md",
      keyFormat: "none — leave the key blank",
    },
  },
  "image:cloudflare": {
    tier: "free",
    pricing: "10,000 Neurons/day free (~500 FLUX-schnell images), no card.",
    setup: {
      steps: [
        "Create a Cloudflare account (free).",
        "Copy your Account ID (Workers & Pages → sidebar).",
        "Paste it into the Base URL, replacing YOUR_ACCOUNT_ID.",
        "dash.cloudflare.com/profile/api-tokens → Create token (Workers AI permission) → paste it here.",
        "Pick @cf/black-forest-labs/flux-1-schnell (the free lane) and Test.",
      ],
      consoleUrl: "https://dash.cloudflare.com/profile/api-tokens",
      docsUrl: "https://developers.cloudflare.com/workers-ai/models/",
      keyFormat: "Cloudflare API token",
    },
  },
  "image:huggingface": {
    tier: "free",
    pricing: "~300 requests/hour free; models cold-start 30-90s.",
    setup: {
      steps: [
        "Create a huggingface.co account (free, no card).",
        "Settings → Access Tokens → create a token with read access (hf_...).",
        "Paste the token here.",
        "Pick black-forest-labs/FLUX.1-schnell for speed or FLUX.1-dev for quality.",
        "Test — a cold model answers with a retryable rate limit; try again after 30-90s.",
      ],
      consoleUrl: "https://huggingface.co/settings/tokens",
      docsUrl: "https://huggingface.co/docs/api-inference",
      keyFormat: "hf_...",
    },
  },
  "image:nvidia": {
    tier: "free",
    pricing: "1,000 credits/month free, no card.",
    setup: {
      steps: [
        "Create an NVIDIA build account (build.nvidia.com).",
        "Grab an API key from the model page (starts nvapi-).",
        "Paste the key here.",
        "Pick black-forest-labs/flux.1-dev or flux.2-klein-4b.",
        "Test — the response confirms the key and the model.",
      ],
      consoleUrl: "https://build.nvidia.com/explore/visual",
      docsUrl: "https://docs.api.nvidia.com",
      keyFormat: "nvapi-...",
    },
  },
  "image:together": {
    tier: "free",
    pricing: "FLUX.1-schnell-Free is $0 (~10 img/min); paid schnell ~$0.004/image.",
    setup: {
      steps: [
        "Sign up at api.together.ai — NOTE: a one-time $15 credit purchase is required before the key is issued (refundable if unused).",
        "Settings → API Keys → create one.",
        "Paste the key here.",
        "Pick black-forest-labs/FLUX.1-schnell-Free — real FLUX quality, NO watermark, ~10 images/min.",
        "Test — the -Free model is always the $0 lane.",
      ],
      consoleUrl: "https://api.together.ai/settings/api-keys",
      docsUrl: "https://docs.together.ai",
      pricingUrl: "https://www.together.ai/pricing",
      keyFormat: "64-char hex key",
    },
  },
  "image:openai": {
    tier: "premium",
    pricing: "gpt-image-1 ~$0.02-0.19/image by quality; dall-e-3 ~$0.04-0.12.",
    setup: {
      steps: [
        "Use the same OpenAI key as Script writing (prepaid credit required).",
        "Pick gpt-image-1 — the only OpenAI image model with identity-locked EDITS.",
        "dall-e-3 for classic generations.",
        "Test (confirmCost applies — OpenAI images are not free).",
      ],
      consoleUrl: "https://platform.openai.com/api-keys",
      docsUrl: "https://platform.openai.com/docs/guides/image-generation",
      keyFormat: "sk-...",
    },
  },
  "image:stability": {
    tier: "premium",
    pricing: "SD3.5-large ~$0.065/image; credits-based.",
    setup: {
      steps: [
        "Create a platform.stability.ai account.",
        "Account → API Keys → create one.",
        "Prepaid credits (from $10).",
        "Pick sd3.5-large and Test.",
      ],
      consoleUrl: "https://platform.stability.ai/account/keys",
      docsUrl: "https://platform.stability.ai/docs/api-reference",
      keyFormat: "sk-...",
    },
  },
  "image:fal": {
    tier: "budget",
    pricing: "Free starting credits; FLUX ~$0.003-0.05/image.",
    setup: {
      steps: [
        "Create a fal.ai account.",
        "Dashboard → Keys → create one.",
        "Paste the key here.",
        "Pick fal-ai/flux-pro/v1.1 (quality) or fal-ai/flux/dev (fast).",
        "Test — starting credits cover plenty of thumbnails.",
      ],
      consoleUrl: "https://fal.ai/dashboard/keys",
      docsUrl: "https://fal.ai/models",
      keyFormat: "hex key id:secret",
    },
  },
  "image:replicate": {
    tier: "budget",
    pricing: "$5 free credits on signup; SDXL ~$0.002-0.01/image.",
    setup: {
      steps: [
        "Create a replicate.com account (the $5 credit activates on signup).",
        "Account → API tokens → create one (r8_...).",
        "Paste the token here.",
        "Pick black-forest-labs/flux-1.1-pro or stability-ai/sdxl.",
        "Test — the response confirms the key and the model.",
      ],
      consoleUrl: "https://replicate.com/account/api-tokens",
      docsUrl: "https://replicate.com/docs",
      keyFormat: "r8_...",
    },
  },
  "image:ideogram": {
    tier: "budget",
    pricing: "Free daily credits; paid per-image from ~$0.02.",
    setup: {
      steps: [
        "Create an ideogram.ai account.",
        "Profile → API Keys → create one.",
        "Paste the key here.",
        "Ideogram's specialty is TEXT INSIDE IMAGES — posters, thumbnails with legible words.",
        "Test — the response confirms the key and the model.",
      ],
      consoleUrl: "https://ideogram.ai",
      docsUrl: "https://ideogram.ai/docs/api",
      keyFormat: "hex key",
    },
  },
  "image:recraft": {
    tier: "budget",
    pricing: "Free tier: 50 credits/day; paid from $0.04/image.",
    setup: {
      steps: [
        "Create a recraft.ai account.",
        "Dashboard → API keys → create one.",
        "Paste the key here.",
        "Recraft's specialty is VECTOR-STYLE art and brand-consistent icon sets.",
        "Test — the response confirms the key and the model.",
      ],
      consoleUrl: "https://www.recraft.ai",
      docsUrl: "https://docs.recraft.ai",
      keyFormat: "long token",
    },
  },

  // ── VIDEO (scene animation) ──
  "video:zai": {
    tier: "budget",
    pricing: "CogVideoX-3: paid per 5s clip (cents-class); Ken Burns mode needs NO AI video at all.",
    setup: {
      steps: [
        "Works with the shared credentials — the same z.ai key powers scripts, art and animation.",
        "Pick cogvideox-3 (5s 1080p clips).",
        "Remember: Ken Burns render mode is free and needs no AI video — animated mode calls the provider per scene.",
        "Test (confirmCost applies — each clip bills).",
      ],
      consoleUrl: "https://z.ai/model-api",
      keyFormat: "shared key — or leave blank for the built-in gateway",
    },
  },
  "video:agnes": {
    tier: "free",
    pricing: "Completely free — 720P clips, async polling.",
    setup: {
      steps: [
        "Create an account at platform.agnes-ai.com — no credit card.",
        "Copy your API key.",
        "Paste the key here and pick agnes-video-2.5.",
        "Test — clips render 720P with async polling, free.",
      ],
      consoleUrl: "https://platform.agnes-ai.com",
      keyFormat: "API key from the Agnes platform",
    },
  },
  "video:nvidia": {
    tier: "free",
    pricing: "1,000 credits/month free — Wan2.2 clips on the house.",
    setup: {
      steps: [
        "Same NVIDIA account as the Artwork row (build.nvidia.com).",
        "Grab the nvapi- key.",
        "Pick wan-ai/wan2.2-animate-2-14b.",
        "Test — free tier credits cover a handful of animated scenes per month.",
      ],
      consoleUrl: "https://build.nvidia.com/explore/visual",
      keyFormat: "nvapi-...",
    },
  },
  "video:kling": {
    tier: "budget",
    pricing: "Daily free credits + one-time signup credits; paid per 5s clip.",
    setup: {
      steps: [
        "Create an account at app.klingai.com/dev.",
        "Generate an API credential pair (access key + secret) and paste as directed.",
        "Pick kling-v2-master (current 2.x gen).",
        "Test — new users get one-time free credits plus daily refresh credits.",
      ],
      consoleUrl: "https://app.klingai.com/dev",
      keyFormat: "access-key:secret-key",
    },
  },
  "video:hailuo": {
    tier: "budget",
    pricing: "200 free credits on signup; Hailuo-02 1080P/6s clips.",
    setup: {
      steps: [
        "Create a platform.minimax.io account (200 free credits activate on signup).",
        "API Keys → create one.",
        "Paste the key here.",
        "Pick MiniMax-Hailuo-02 (1080P, 6s) or MiniMax-Hailuo-2.3 (newer, faster).",
        "Test — the response confirms the key and the model.",
      ],
      consoleUrl: "https://platform.minimax.io",
      keyFormat: "eyJ... JWT key",
    },
  },
  "video:ltxstudio": {
    tier: "budget",
    pricing: "800 one-time free credits on signup; LTX 2.5 fast lane is the cheap one.",
    setup: {
      steps: [
        "Create an account at ltx.studio.",
        "Developer settings → generate an API key.",
        "Paste the key here.",
        "Pick ltx-2-5-fast for cost, ltx-2-5-pro for quality (8s clips).",
        "Test — the response confirms the key and the model.",
      ],
      consoleUrl: "https://ltx.studio",
      keyFormat: "API key from LTX developer settings",
    },
  },
  "video:magichour": {
    tier: "free",
    pricing: "400 credits on signup + 100 credits DAILY — no card.",
    setup: {
      steps: [
        "Create an account at magichour.ai/developer (no card needed).",
        "API Keys → create one.",
        "Paste the key here.",
        "Pick ltx-2.5 (fast default), wan-2.2 (physics), kling-3.0 (cinematic) or minimax-h3 (native audio).",
        "Test — the daily credit drip covers a regular posting schedule.",
      ],
      consoleUrl: "https://magichour.ai/developer",
      keyFormat: "API key from Magic Hour developer settings",
    },
  },
  "video:replicate": {
    tier: "budget",
    pricing: "$5 free credits on signup; per-clip pricing by model.",
    setup: {
      steps: [
        "Same Replicate account as the Artwork row ($5 signup credit).",
        "Paste the r8_ token here.",
        "Pick minimax/video-01.",
        "Test — the response confirms the key and the model.",
      ],
      consoleUrl: "https://replicate.com/account/api-tokens",
      keyFormat: "r8_...",
    },
  },
  "video:runway": {
    tier: "budget",
    pricing: "125 one-time free credits; gen4_turbo per-clip pricing.",
    setup: {
      steps: [
        "Create a dev.runwayml.com account.",
        "Account → API Keys → create one.",
        "Paste the key here.",
        "Pick gen4_turbo (gen3a_turbo was retired Aug 2026).",
        "Test — the response confirms the key and the model.",
      ],
      consoleUrl: "https://dev.runwayml.com/",
      docsUrl: "https://docs.dev.runwayml.com",
      keyFormat: "key_...",
    },
  },
  "video:luma": {
    tier: "premium",
    pricing: "Ray-2 class pricing — premium lane.",
    setup: {
      steps: [
        "Create a lumalabs.ai account.",
        "Dream Machine → API Keys → create one.",
        "Paste the key here.",
        "Pick ray-2 (quality) or ray-flash-2 (faster, cheaper).",
        "Test — the response confirms the key and the model.",
      ],
      consoleUrl: "https://lumalabs.ai/dream-machine/api/keys",
      docsUrl: "https://lumalabs.ai/api",
      keyFormat: "luma-... API key",
    },
  },
  "video:fal": {
    tier: "budget",
    pricing: "Free starting credits; fast-svd is the cheapest lane.",
    setup: {
      steps: [
        "Same fal.ai account as the Artwork row.",
        "Paste the key here.",
        "Pick fal-ai/fast-svd (cheapest) or fal-ai/minimax/video-01/image-to-video (Hailuo quality).",
        "Test — the response confirms the key and the model.",
      ],
      consoleUrl: "https://fal.ai/dashboard/keys",
      keyFormat: "hex key id:secret",
    },
  },
};

/** Merge the enrichment onto the registry arrays — one lookup surface for
 *  both the UI (tier badges, setup panel, pricing hints) and the battery
 *  (completeness pins). Pure data, client-safe. */
function enrich(list: ProviderMeta[], capability: CapabilityId): ProviderMeta[] {
  return list.map((p) => {
    const e = ENRICHMENT[`${capability}:${p.id}`];
    if (!e) return p;
    return { ...p, tier: e.tier, pricing: e.pricing, setup: e.setup };
  });
}

export const PROVIDERS_BY_CAPABILITY: Record<CapabilityId, ProviderMeta[]> = {
  chat: enrich(CHAT_PROVIDERS, "chat"),
  tts: enrich(TTS_PROVIDERS, "tts"),
  asr: enrich(ASR_PROVIDERS, "asr"),
  image: enrich(IMAGE_PROVIDERS, "image"),
  video: enrich(VIDEO_PROVIDERS, "video"),
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
