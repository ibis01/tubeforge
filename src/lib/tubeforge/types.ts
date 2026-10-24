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
