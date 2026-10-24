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
  { id: "cinematic", label: "Cinematic", prompt: "cinematic film still, dramatic rim lighting, depth of field, epic atmosphere" },
  { id: "bold", label: "Bold Minimal", prompt: "bold minimalist composition, strong single focal point, high saturation, striking contrast" },
  { id: "dark", label: "Dark Moody", prompt: "dark moody atmosphere, subtle neon accent lighting, mysterious cinematic vibe" },
  { id: "vibrant", label: "Vibrant Art", prompt: "vibrant digital illustration, painterly style, rich colors, dynamic composition" },
] as const;

// ---------- Story engine (Phase 2) ----------

export const FORMATS = [
  { id: "script", label: "Narration script", desc: "Classic flowing narration + thumbnail package" },
  { id: "story", label: "Scene-based story", desc: "Scene-by-scene script, storyboard art and a rendered MP4" },
] as const;

export type VideoFormat = (typeof FORMATS)[number]["id"];

export const RENDER_MODES = [
  {
    id: "kenburns",
    label: "Ken Burns",
    icon: "Zap",
    desc: "Cinematic pans & zooms over storyboard art — fast (~2 min)",
    eta: "≈ 2 min",
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

export const CAMERAS = [
  { id: "zoom-in", label: "Zoom in" },
  { id: "zoom-out", label: "Zoom out" },
  { id: "pan-left", label: "Pan left" },
  { id: "pan-right", label: "Pan right" },
  { id: "push-in", label: "Push in" },
] as const;

/** Scene count derived from script length — keeps narration density consistent. */
export const SCENE_COUNTS: Record<string, number> = {
  short: 4,
  medium: 6,
  long: 8,
};

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
  hasImage: boolean;
  imageUrl: string | null;
  generating: boolean; // single-scene re-roll in flight
}

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
  draft: { label: "Draft", color: "text-zinc-400 bg-zinc-500/10 border-zinc-500/20", step: 0 },
  scripted: { label: "Scripted", color: "text-amber-300 bg-amber-500/10 border-amber-500/20", step: 1 },
  voiced: { label: "Voiced", color: "text-sky-300 bg-sky-500/10 border-sky-500/20", step: 2 },
  ready: { label: "Ready", color: "text-emerald-300 bg-emerald-500/10 border-emerald-500/20", step: 3 },
  published: { label: "Published", color: "text-red-300 bg-red-500/15 border-red-500/25", step: 4 },
  failed: { label: "Failed", color: "text-red-300 bg-red-500/10 border-red-500/20", step: -1 },
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
  scenes?: Scene[] | null; // populated in detail/create responses only
  sceneCount?: number;
  hasStoryboard: boolean;
  hasVideo: boolean;
  videoDuration: number | null;
  videoUrl: string | null;
  previewUrl: string | null;
  createdAt: string;
  updatedAt: string;
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
  { id: "cinematic", label: "Cinematic Real", prompt: "semi-realistic cinematic digital portrait, dramatic studio lighting, shallow depth of field, rich color grading" },
  { id: "stylized", label: "Stylized Art", prompt: "stylized digital illustration portrait, painterly rendering, vibrant but tasteful palette, clean shapes" },
  { id: "anime", label: "Anime", prompt: "high-quality anime portrait, crisp cel shading, expressive eyes, professional key visual" },
  { id: "comic", label: "Comic Ink", prompt: "bold comic-book inked portrait, dynamic halftone accents, strong outlines, high contrast" },
  { id: "noir", label: "Dark Noir", prompt: "moody noir portrait, low-key lighting with a single accent glow, mysterious atmosphere, film grain" },
] as const;

export const POSES = [
  { id: "explaining", label: "Explaining", desc: "gesturing with one hand raised mid-explanation, engaged open-mouth expression, waist-up shot" },
  { id: "thinking", label: "Thinking", desc: "pensive pose, hand on chin, thoughtful narrowed eyes looking slightly upward, waist-up shot" },
  { id: "welcoming", label: "Welcoming", desc: "both arms open in a warm welcoming gesture, confident smile facing camera, waist-up shot" },
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

export type JobStatusDTO = "running" | "done" | "failed" | "interrupted";

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
