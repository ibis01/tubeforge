// Shared types & constants for TubeForge

export const VOICES = [
  { id: "jam", label: "Jam — British Narrator" },
  { id: "kazi", label: "Kazi — Clear Standard" },
  { id: "xiaochen", label: "Xiaochen — Calm Pro" },
  { id: "tongtong", label: "Tongtong — Warm" },
  { id: "chuichui", label: "Chuichui — Lively" },
  { id: "douji", label: "Douji — Natural Flow" },
  { id: "luodo", label: "Luodo — Expressive" },
] as const;

export const NICHES = [
  "Motivation",
  "Fun Facts",
  "History",
  "Finance",
  "Psychology",
  "Space & Science",
  "Technology",
  "Mysteries",
] as const;

export const TONES = [
  { id: "informative", label: "Informative" },
  { id: "dramatic", label: "Dramatic" },
  { id: "humorous", label: "Humorous" },
  { id: "mysterious", label: "Mysterious" },
  { id: "inspirational", label: "Inspirational" },
] as const;

export const LENGTHS = [
  { id: "short", label: "Short (~250 words)", words: 250 },
  { id: "medium", label: "Medium (~450 words)", words: 450 },
  { id: "long", label: "Long (~700 words)", words: 700 },
] as const;

export const THUMB_STYLES = [
  {
    id: "cinematic",
    label: "Cinematic",
    prompt:
      "cinematic film still, dramatic rim lighting, depth of field, epic atmosphere",
  },
  {
    id: "bold",
    label: "Bold Minimal",
    prompt:
      "bold minimalist composition, strong single focal point, high saturation, striking contrast",
  },
  {
    id: "dark",
    label: "Dark Moody",
    prompt:
      "dark moody atmosphere, subtle neon accent lighting, mysterious cinematic vibe",
  },
  {
    id: "vibrant",
    label: "Vibrant Art",
    prompt:
      "vibrant digital illustration, painterly style, rich colors, dynamic composition",
  },
] as const;

// ---------- Story engine (Phase 2) ----------

export const FORMATS = [
  {
    id: "script",
    label: "Narration script",
    desc: "Classic flowing narration + thumbnail package",
  },
  {
    id: "story",
    label: "Scene-based story",
    desc: "Scene-by-scene script, storyboard art and a rendered MP4",
  },
] as const;

export type VideoFormat = (typeof FORMATS)[number]["id"];

export const RENDER_MODES = [
  {
    id: "kenburns",
    label: "Ken Burns",
    icon: "Zap",
    desc: "Smart Motion: scene-aware pans & zooms over storyboard art — focal-locked framing, camera cuts paced per scene, SFX and a ducked music bed included",
    eta: "≈ 2–5 min",
  },
  {
    id: "stock",
    label: "Stock b-roll",
    icon: "Film",
    desc: "Real footage from Pexels & Pixabay matched per scene — Smart Motion art fills any scene without a match",
    eta: "≈ 2–5 min",
  },
  {
    id: "slides",
    label: "Keynote slides",
    icon: "Presentation",
    desc: "Vertical 9:16 kinetic-typography explainer — one designed slide per beat (huge headlines, counters, spec cards), cut like a deck, no image gen needed",
    eta: "≈ 1–3 min",
  },
  {
    id: "animated",
    label: "Full AI animation",
    icon: "Clapperboard",
    desc: "Every scene animated via image-to-video — ~4 min per scene",
    eta: "≈ 4 min / scene",
  },
] as const;

export type RenderMode = (typeof RENDER_MODES)[number]["id"];

/** A downloaded stock clip attached to one scene (stock.ts). */
export interface StockRef {
  source: "pexels" | "pixabay";
  file: string; // stock-XX.mp4 inside the video dir
  query: string; // the search terms that matched
  credit: string; // "Footage by NAME (Pexels)"
  pageUrl: string; // source page for attribution
  durationSec: number;
}

export const CAMERAS = [
  { id: "zoom-in", label: "Zoom in" },
  { id: "zoom-out", label: "Zoom out" },
  { id: "pan-left", label: "Pan left" },
  { id: "pan-right", label: "Pan right" },
  { id: "push-in", label: "Push in" },
] as const;

/**
 * Scene count per script length. Tuned for retention pacing: shorter scenes
 * mean more visual changes, more hooks and tighter narration. The render
 * engine adds scene-aware Ken Burns shots on top (Smart Motion), so the
 * on-screen view changes far more often than the scene count alone implies.
 */
export const SCENE_COUNTS: Record<string, number> = {
  short: 8,
  medium: 12,
  long: 16,
};

/**
 * SFX cues the script LLM can attach to a scene (see sfx.ts for synthesis).
 * Palette is deliberately LOW and DARK only — no bright "pop"/"ding" kinds;
 * those read as UI/game noises, not cinema.
 */
export const SFX_KINDS = ["whoosh", "boom", "riser", "sting"] as const;
export type SfxKind = (typeof SFX_KINDS)[number];

/**
 * Per-scene art styles — the "edit each storyboard image to suit my taste"
 * palette. Every scene can override the default cinematic pipeline look with
 * a distinct art direction; the suffix is appended to the scene's visual
 * prompt at generation time (see story.ts generateSceneImage).
 * "default" = the standard pipeline prompt, no extra style clause.
 */
export const SCENE_ART_STYLES = [
  { id: "default", label: "Standard", prompt: "" },
  { id: "photoreal", label: "Photo Real", prompt: "ultra-realistic photograph, 50mm lens, natural light, true-to-life textures, editorial photography quality" },
  { id: "anime", label: "Anime", prompt: "high-quality anime key visual, crisp cel shading, expressive characters, professional anime film art direction" },
  { id: "watercolor", label: "Watercolor", prompt: "soft watercolor painting, visible brush strokes, textured paper, gentle washes of color" },
  { id: "comic", label: "Comic Ink", prompt: "bold comic-book ink illustration, strong outlines, halftone shading, dynamic graphic composition" },
  { id: "render3d", label: "3D Render", prompt: "stylized 3D render, soft global illumination, subsurface materials, high-end animation film look" },
  { id: "noir", label: "Dark Noir", prompt: "black-and-white film noir still, extreme contrast, deep shadows, hard key light" },
  { id: "vintage", label: "Vintage Film", prompt: "vintage 1970s film still, warm faded colors, organic grain, anamorphic haze" },
  { id: "neon", label: "Neon Nights", prompt: "cyberpunk neon-lit scene, saturated accent glows, moody nocturnal atmosphere, reflective wet surfaces" },
  { id: "pastel", label: "Soft Pastel", prompt: "soft pastel illustration, gentle palette, dreamy diffused light, storybook charm" },
  { id: "epic", label: "Epic Fantasy", prompt: "epic fantasy matte painting, sweeping scale, dramatic god rays, highly detailed environment art" },
] as const;

export type SceneArtStyleId = (typeof SCENE_ART_STYLES)[number]["id"];

const SCENE_STYLE_IDS = new Set<string>(SCENE_ART_STYLES.map((s) => s.id));

/** Validate a stored scene style id (unknown/legacy → "default"). */
export function sanitizeSceneStyle(v: unknown): SceneArtStyleId {
  return typeof v === "string" && SCENE_STYLE_IDS.has(v)
    ? (v as SceneArtStyleId)
    : "default";
}

/** The prompt suffix a scene style contributes ("" for the standard look). */
export function sceneStylePrompt(style: string | null | undefined): string {
  return SCENE_ART_STYLES.find((s) => s.id === sanitizeSceneStyle(style))?.prompt ?? "";
}

/**
 * Story-mood presets for the background-music picker (the "music that
 * matches the story" control). Each id maps onto the library's mood-tag
 * vocabulary in music.ts; "auto" defers to the niche mapping. Lives here
 * (not music.ts) so client components can share the list without pulling
 * in the database.
 */
export const MUSIC_MOODS = [
  { id: "auto", label: "Auto — match the niche" },
  { id: "suspenseful", label: "Suspenseful" },
  { id: "cinematic", label: "Cinematic" },
  { id: "emotional", label: "Emotional" },
  { id: "uplifting", label: "Uplifting" },
  { id: "calm", label: "Calm" },
] as const;

export type MusicMoodId = (typeof MUSIC_MOODS)[number]["id"];

/** A single story beat — narration drives TTS, visual drives storyboard art. */
export interface Scene {
  index: number; // 1-based
  title: string;
  narration: string;
  visual: string; // image prompt (subject, setting, action, composition)
  camera: string; // ken burns direction / i2v motion intent
  mood: string; // color + lighting keywords
  caption: string; // punchy on-screen subtitle (<= 45 chars)
  hostInScene: boolean; // does the recurring host appear in this scene?
  rehook: boolean; // attention pivot — punch-zoom + sting at scene start
  sfx: string; // one of SFX_KINDS or "none"
  focal?: string; // where the eye must stay (Smart Motion) — e.g. "upper-right"
  stock?: StockRef; // matched real-footage clip (render mode "stock")
  style?: string; // per-scene art style override (SCENE_ART_STYLES id; default = pipeline look)
  seedVariant?: number; // generation-take counter — bumped on every explicit
  // re-roll so pinned seeds (identity locking on text-to-image providers)
  // still yield a NEW image; absent = first take (variant 0)
}

export interface SceneDTO {
  index: number;
  title: string;
  narration: string;
  visual: string;
  camera: string;
  cameraLabel: string;
  mood: string;
  caption: string;
  hostInScene: boolean;
  rehook: boolean;
  sfx: string;
  focal: string; // focal hint ("center" when unset)
  style: string; // art style id ("default" = pipeline look)
  hasImage: boolean;
  imageUrl: string | null;
  generating: boolean; // single-scene re-roll in flight
  hasStock: boolean;
  stockUrl: string | null;
  stockSource: string | null; // "pexels" | "pixabay"
  stockQuery: string | null;
  stockCredit: string | null;
}

export const CHAT_MODELS = [
  {
    id: "glm-5.3-flash",
    label: "GLM-5.3 Flash",
    hint: "Current flash generation — native multimodal, budget tier",
  },
  {
    id: "glm-5.3",
    label: "GLM-5.3",
    hint: "Flagship — open SOTA quality, paid",
  },
  {
    id: "glm-4.7-flash",
    label: "GLM-4.7 Flash",
    hint: "Previous-gen flash",
  },
  {
    id: "glm-4.5-flash",
    label: "GLM-4.5 Flash",
    hint: "Legacy — delisted from docs but still served, $0",
  },
  {
    id: "glm-4.6",
    label: "GLM-4.6",
    hint: "Paid — deep quality, needs credit",
  },
  {
    id: "glm-4.5",
    label: "GLM-4.5",
    hint: "Paid — long-context flagship",
  },
] as const;

export const DEFAULT_CHAT_MODEL = "glm-4.5-flash";
export const DEFAULT_ZAI_BASE_URL = "https://api.z.ai/api/paas/v4";

export type VideoStatus =
  | "draft"
  | "scripted"
  | "voiced"
  | "ready"
  | "published"
  | "failed";

export const STATUS_ORDER: VideoStatus[] = [
  "draft",
  "scripted",
  "voiced",
  "ready",
  "published",
];

export const STATUS_META: Record<
  VideoStatus,
  { label: string; color: string; step: number }
> = {
  draft: {
    label: "Draft",
    color: "text-zinc-400 bg-zinc-500/10 border-zinc-500/20",
    step: 0,
  },
  scripted: {
    label: "Scripted",
    color: "text-amber-300 bg-amber-500/10 border-amber-500/20",
    step: 1,
  },
  voiced: {
    label: "Voiced",
    color: "text-sky-300 bg-sky-500/10 border-sky-500/20",
    step: 2,
  },
  ready: {
    label: "Ready",
    color: "text-emerald-300 bg-emerald-500/10 border-emerald-500/20",
    step: 3,
  },
  published: {
    label: "Published",
    color: "text-red-300 bg-red-500/15 border-red-500/25",
    step: 4,
  },
  failed: {
    label: "Failed",
    color: "text-red-300 bg-red-500/10 border-red-500/20",
    step: -1,
  },
};

export const PIPELINE_STAGES = [
  { id: "script", label: "AI Script", icon: "FileText" },
  { id: "voiceover", label: "Voiceover", icon: "Mic" },
  { id: "thumbnail", label: "Thumbnail", icon: "Image" },
  { id: "publish", label: "Ready to Upload", icon: "Rocket" },
] as const;

export interface VideoDTO {
  id: string;
  title: string | null;
  topic: string;
  niche: string;
  tone: string;
  length: string;
  script: string | null;
  description: string | null;
  tags: string | null;
  status: VideoStatus;
  voice: string;
  ttsSpeed: number;
  thumbStyle: string;
  voiceSource: string; // "tts" = built-in voices | "custom" = user-provided audio
  voiceLabel: string | null; // display name of the custom voice (file / URL)
  hasVoiceover: boolean;
  hasThumbnail: boolean;
  audioDuration: number | null;
  wordCount: number | null;
  error: string | null;
  channelId: string | null;
  channelName?: string | null;
  characterId: string | null;
  characterName?: string | null;
  characterPortraitUrl?: string | null;
  // Story engine
  format: string;
  renderMode: string;
  scenes?: SceneDTO[] | null; // populated in detail/create responses only
  sceneCount?: number;
  hasStoryboard: boolean;
  hasVideo: boolean;
  videoDuration: number | null;
  videoUrl: string | null;
  previewUrl: string | null;
  hasComments: boolean; // engagement kit generated (Phase 4)
  youtubeUrl: string | null; // set after a successful OAuth upload (Phase 4)
  publishedAt: string | null; // real YouTube publish date once synced (Phase 5)
  // Auto-Short (Phase 5)
  hasShort: boolean;
  shortUrl: string | null;
  shortDuration: number | null;
  shortScene: number | null;
  // Background music (per-video overrides; null = Settings defaults)
  musicEnabled: boolean | null;
  musicTrackId: string | null;
  musicVolume: number | null;
  musicFadeIn: number | null;
  musicFadeOut: number | null;
  musicDucking: boolean | null;
  musicDuckingIntensity: string | null; // subtle | standard | strong
  musicMood: string | null; // auto | suspenseful | cinematic | emotional | uplifting | calm
  // Smart Motion (Ken Burns) per-video overrides; null = built-in defaults
  motionMode: string | null; // smart | zoom | pan | off
  motionIntensity: number | null; // 0..30 (% zoom amplitude, default 12)
  motionCurve: string | null; // smooth | linear
  motionVary: boolean | null; // vary direction between scenes
  // Scene transitions per-video overrides; null = built-in default (fade 0.5s)
  transitionStyle: string | null; // transitions.ts catalog id ("cut" = hard cuts)
  transitionDuration: number | null; // blend length seconds (0.2..1.5)
  // Brand kit (keynote slides) — accent recolor + corner logo badge
  brandAccent: string | null; // #rrggbb, null = built-in per-slide catalog accents
  brandHasLogo: boolean; // a brand-logo.* file exists for this video
  brandLogoOn: boolean; // false only when the badge was explicitly switched off
  // Post-render quality gate (qc.ts) — parsed report or null
  qc: QcReportDTO | null;
  // Latest synced performance (Phase 5, null before the first sync)
  stats: { views: number; likes: number; comments: number } | null;
  createdAt: string;
  updatedAt: string;
}

export interface QcCheckDTO {
  id: string;
  label: string;
  pass: boolean;
  value: string;
  detail?: string;
}

/** One designed slide of the keynote deck (render mode "slides"). */
export interface SlideDTO {
  index: number; // scene index the slide illustrates
  layout: string; // slides.ts SLIDE_LAYOUTS id
  accent: string; // slides.ts SLIDE_ACCENTS id (may be overridden by the brand kit)
  badge: string | null;
  headline: string;
  useImage: boolean; // photo layout — embeds the scene's storyboard art
  hasPng: boolean; // rendered slide-NN.png exists (deck was screenshotted)
  pngUrl: string | null;
  generating: boolean; // per-slide design re-roll in flight
}

export interface QcReportDTO {
  passed: boolean;
  checkedAt: string;
  durationSec: number;
  checks: QcCheckDTO[];
}

export interface ChannelDTO {
  id: string;
  name: string;
  niche: string;
  description: string | null;
  isActive: boolean;
  videoCount?: number;
  createdAt: string;
}

export interface ActivityDTO {
  id: string;
  videoId: string | null;
  videoTitle?: string | null;
  stage: string;
  message: string;
  level: string;
  createdAt: string;
}

export interface StatsDTO {
  total: number;
  byStatus: Record<string, number>;
  ready: number;
  inPipeline: number;
  published: number;
  failed: number;
  audioMinutes: number;
  channels: number;
  perDay: { day: string; count: number }[];
  recent: ActivityDTO[];
}

// ---------- Topic Radar (keyword research) ----------

export interface ResearchIdea {
  id: string;
  title: string;
  angle: string;
  keywords: string[];
  searchVolume: string;
  competition: string;
  viralScore: number;
  suggestedLength: string;
  why: string;
  // Phase 5 — performance feedback loop (optional, set after a boost/rescore)
  perfBoost?: number; // points added by real channel performance (can be negative)
  boostReason?: string; // why the boost was applied
}

export interface ResearchSessionDTO {
  id: string;
  niche: string;
  query: string;
  nicheSummary: string;
  ideas: ResearchIdea[];
  createdAt: string;
}

// ---------- Publishing calendar ----------

export const SLOT_TIMES = [
  "07:00",
  "09:00",
  "12:00",
  "15:00",
  "18:00",
  "21:00",
] as const;

export interface SlotDTO {
  id: string;
  videoId: string | null;
  videoTitle: string | null;
  videoStatus: VideoStatus | null;
  hasThumbnail: boolean;
  channelId: string | null;
  channelName: string | null;
  title: string;
  slotDate: string; // ISO date (calendar day)
  timeOfDay: string;
  note: string | null;
  done: boolean;
  createdAt: string;
}

// ---------- Thumbnail A/B variants ----------

export interface VariantDTO {
  style: string;
  label: string;
  url: string;
  isPrimary: boolean;
}

// ---------- Characters (Cast) ----------

export const ART_STYLES = [
  {
    id: "cinematic",
    label: "Cinematic Real",
    prompt:
      "semi-realistic cinematic digital portrait, dramatic studio lighting, shallow depth of field, rich color grading",
  },
  {
    id: "stylized",
    label: "Stylized Art",
    prompt:
      "stylized digital illustration portrait, painterly rendering, vibrant but tasteful palette, clean shapes",
  },
  {
    id: "anime",
    label: "Anime",
    prompt:
      "high-quality anime portrait, crisp cel shading, expressive eyes, professional key visual",
  },
  {
    id: "comic",
    label: "Comic Ink",
    prompt:
      "bold comic-book inked portrait, dynamic halftone accents, strong outlines, high contrast",
  },
  {
    id: "noir",
    label: "Dark Noir",
    prompt:
      "moody noir portrait, low-key lighting with a single accent glow, mysterious atmosphere, film grain",
  },
] as const;

export const POSES = [
  {
    id: "explaining",
    label: "Explaining",
    desc: "gesturing with one hand raised mid-explanation, engaged open-mouth expression, waist-up shot",
  },
  {
    id: "thinking",
    label: "Thinking",
    desc: "pensive pose, hand on chin, thoughtful narrowed eyes looking slightly upward, waist-up shot",
  },
  {
    id: "welcoming",
    label: "Welcoming",
    desc: "both arms open in a warm welcoming gesture, confident smile facing camera, waist-up shot",
  },
] as const;

export type PoseId = (typeof POSES)[number]["id"];

export interface CharacterDTO {
  id: string;
  name: string;
  role: string | null;
  personality: string | null;
  appearance: string | null;
  identityAnchor: string | null;
  voice: string;
  artStyle: string;
  hasPortrait: boolean;
  videoCount: number;
  poseCount: number;
  portraitUrl: string | null;
  poseUrls: { pose: string; label: string; url: string }[];
  generating: { portrait: boolean; poses: boolean };
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------- Phase 3: robustness DTOs ----------

export type JobStatusDTO =
  | "running"
  | "done"
  | "failed"
  | "interrupted"
  | "cancelled";

/** One row in the Settings "Background Jobs" history panel. */
export interface JobDTO {
  id: string;
  kind: string;
  entityId: string;
  status: JobStatusDTO;
  progress: number | null;
  label: string | null;
  error: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  entityTitle: string | null;
}

/** ASR narration-check report (POST/GET /api/videos/[id]/verify). */
export interface VerifyReportDTO {
  ranAt: string;
  format: "script" | "story";
  similarity: number; // 0..1
  scriptWords: number;
  transcriptWords: number;
  verdict: "excellent" | "good" | "needs-review";
  transcriptPreview: string;
  missingWords: string[];
  scenes?: { index: number; title: string; similarity: number }[];
}

// ---------- Phase 4: growth engine DTOs ----------

/** One ready-to-post reply template for a viewer reaction archetype. */
export interface CommentReplyDTO {
  trigger: string; // the viewer reaction this reply answers
  text: string; // the ready-to-paste reply
}

/** Engagement kit generated per video (POST/GET /api/videos/[id]/comments). */
export interface CommentsKitDTO {
  pinnedComment: string; // post as the channel's pinned comment
  replies: CommentReplyDTO[]; // 4 templates for common viewer reactions
  heartTargets: string[]; // comments to look for and heart early
  strategy: string; // one-paragraph engagement playbook
  generatedAt: string;
}

/** YouTube OAuth connection state (GET /api/youtube/status). */
export interface YouTubeStatusDTO {
  configured: boolean; // client id + secret present
  connected: boolean; // refresh token present
  channelTitle: string | null;
  channelThumb: string | null;
  privacyStatus: string; // public | unlisted | private
  callbackUrl: string; // redirect URI to register in Google Cloud
  clientId?: string | null; // echoed back for the settings edit form
}

// ---------- Phase 5: performance loop DTOs ----------

/** One published video's performance row in the Analytics view. */
export interface AnalyticsRowDTO {
  videoId: string;
  title: string;
  niche: string;
  thumbnailUrl: string | null;
  youtubeUrl: string | null;
  publishedAt: string | null;
  views: number;
  likes: number;
  comments: number;
  viewDelta: number; // gained since the previous snapshot (0 on first sync)
  likeDelta: number;
  snapshots: number; // how many syncs recorded this video
  engagementRate: number; // (likes + comments) / views, 0..1
}

/** Aggregated channel performance + feedback-loop state (GET /api/analytics). */
export interface AnalyticsOverviewDTO {
  publishedCount: number; // videos with youtubeUrl
  trackedCount: number; // videos with at least one stats snapshot
  totals: { views: number; likes: number; comments: number };
  viewDelta: number; // views gained across the latest sync round
  avgEngagement: number; // 0..1 across tracked videos
  lastSyncAt: string | null;
  rows: AnalyticsRowDTO[]; // sorted by views desc
  series: { day: string; views: number }[]; // cumulative views per snapshot day
  feedback: {
    active: boolean; // boost can run (has tracked stats)
    winners: string[]; // titles of top performers feeding the loop
    topKeywords: string[]; // dominant keywords in winning videos
  };
}

/** Result of POST /api/youtube/sync. */
export interface YouTubeSyncDTO {
  synced: number; // videos whose stats were fetched
  skipped: number; // published videos missing from the API response (private/deleted)
  totals: { views: number; likes: number; comments: number };
  syncedAt: string;
}

/** Result of POST /api/analytics/rescore (performance boost on a radar session). */
export interface RescoreDTO {
  sessionId: string;
  boosted: number; // ideas that received a nonzero boost
  changed: number; // ideas whose viralScore moved
  ideas: ResearchIdea[];
}
