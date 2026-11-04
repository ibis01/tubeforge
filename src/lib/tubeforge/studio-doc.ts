// studio-doc.ts — S2 wave 2: the studio's per-scene CREATIVE fields.
//
// The timeline doc (Video.timeline) is the Studio's editable projection.
// S2-a wired transitions / mix / captions into the render; this module adds
// the creative layer the S2 roadmap promised:
//
//   • SceneGrade        — per-scene color grade (the render's classic
//                         eq+vignette GRADE becomes the DEFAULT, overridable
//                         scene by scene);
//   • SceneTitle        — a per-scene headline overlay (drawtext on the
//                         segment, animated in/out);
//   • SceneCameraKeys   — two-key camera keyframes (start/end framing +
//                         easing) that outrank the Director's auto camera for
//                         that scene — the first slice of keyframes;
//   • speed             — per-scene playback rate (narration atempo'd at
//                         render, footage setpts'd, preview playbackRate'd);
//   • voice fade in/out — per-scene afade on the narration clip.
//
// Every type here has ONE sanitizer that accepts anything a persisted doc
// (or a hostile client) may carry and returns either a clean value or null.
// The studio normalizes on load; the render re-sanitizes on consume — the
// two can never disagree because both call these exact functions.

// ---------- grade ----------

/** Per-scene color grade. All fields are absolute (1 = neutral) so the UI's
 *  sliders and the render's filter share one vocabulary. */
export interface SceneGrade {
  /** 0.5..1.5 — 1 neutral. Rendered as eq=brightness=(v−1)*0.3. */
  brightness: number;
  /** 0.5..1.5 — 1 neutral. */
  contrast: number;
  /** 0..2 — 1 neutral, 0 grayscale. */
  saturation: number;
  /** −1..1 — warm(+)/cool(−) white balance tilt via colorbalance. */
  temperature: number;
  /** 0..1 — 0 off; 0.5 ≈ the classic cinematic vignette. */
  vignette: number;
}

export const GRADE_PRESETS: Record<string, SceneGrade> = {
  classic: { brightness: 1, contrast: 1.05, saturation: 1.08, temperature: 0, vignette: 0.5 },
  warm: { brightness: 1.02, contrast: 1.05, saturation: 1.1, temperature: 0.45, vignette: 0.5 },
  cool: { brightness: 1.0, contrast: 1.06, saturation: 1.02, temperature: -0.45, vignette: 0.5 },
  noir: { brightness: 0.97, contrast: 1.22, saturation: 0, temperature: 0, vignette: 0.85 },
  vivid: { brightness: 1.03, contrast: 1.14, saturation: 1.35, temperature: 0.12, vignette: 0.4 },
  flat: { brightness: 1.02, contrast: 0.92, saturation: 0.95, temperature: 0, vignette: 0 },
};

const clampNum = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

export function sanitizeGrade(v: unknown): SceneGrade | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const g = v as Record<string, unknown>;
  // A doc that carries the grade block but NO fields (all defaults) is a
  // real "reset to neutral" pick — keep it as an explicit neutral grade.
  return {
    brightness: clampNum(g.brightness, 0.5, 1.5, 1),
    contrast: clampNum(g.contrast, 0.5, 1.5, 1),
    saturation: clampNum(g.saturation, 0, 2, 1),
    temperature: clampNum(g.temperature, -1, 1, 0),
    vignette: clampNum(g.vignette, 0, 1, 0),
  };
}

/** The ffmpeg filter for one scene's grade. `null` → the classic default. */
export function gradeFilter(g: SceneGrade | null | undefined): string {
  if (!g) return "eq=contrast=1.05:saturation=1.08,vignette=PI/5"; // the classic GRADE
  const parts: string[] = [];
  const eq: string[] = [];
  // eq brightness is ADDITIVE in [-1,1]: map the 0.5..1.5 slider to a gentle
  // ±0.15 exposure shift — full-range would blow out at 1.5.
  if (Math.abs(g.brightness - 1) > 0.005) eq.push(`brightness=${((g.brightness - 1) * 0.3).toFixed(3)}`);
  if (Math.abs(g.contrast - 1) > 0.005) eq.push(`contrast=${g.contrast.toFixed(3)}`);
  if (Math.abs(g.saturation - 1) > 0.005) eq.push(`saturation=${g.saturation.toFixed(3)}`);
  if (eq.length > 0) parts.push(`eq=${eq.join(":")}`);
  if (Math.abs(g.temperature) > 0.01) {
    const t = g.temperature * 0.3;
    // Warm pushes red up / blue down; cool the mirror. Green holds.
    parts.push(`colorbalance=rs=${t.toFixed(3)}:bs=${(-t).toFixed(3)}`);
  }
  if (g.vignette > 0.01) parts.push(`vignette=a=${(0.3 + 0.9 * g.vignette).toFixed(3)}`);
  return parts.length > 0 ? parts.join(",") : "null";
}

// ---------- title ----------

export type SceneTitleStyle = "clean" | "bold" | "outline" | "lower";
export type SceneTitleAnim = "none" | "fade" | "rise" | "slide";
export type SceneTitlePos = "top" | "center" | "bottom";

export interface SceneTitle {
  text: string;
  style: SceneTitleStyle;
  anim: SceneTitleAnim;
  pos: SceneTitlePos;
  /** 0.5..1.5 scale over the base face size. */
  size: number;
}

const TITLE_STYLES: SceneTitleStyle[] = ["clean", "bold", "outline", "lower"];
const TITLE_ANIMS: SceneTitleAnim[] = ["none", "fade", "rise", "slide"];
const TITLE_POS: SceneTitlePos[] = ["top", "center", "bottom"];

export function sanitizeTitle(v: unknown): SceneTitle | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const t = v as Record<string, unknown>;
  const text = typeof t.text === "string" ? t.text.trim().slice(0, 90) : "";
  if (!text) return null; // an empty title IS no title
  return {
    text,
    style: TITLE_STYLES.includes(t.style as SceneTitleStyle) ? (t.style as SceneTitleStyle) : "clean",
    anim: TITLE_ANIMS.includes(t.anim as SceneTitleAnim) ? (t.anim as SceneTitleAnim) : "fade",
    pos: TITLE_POS.includes(t.pos as SceneTitlePos) ? (t.pos as SceneTitlePos) : "bottom",
    size: clampNum(t.size, 0.5, 1.5, 1),
  };
}

/** Escape a string for a drawtext `text=` value (colon/quote/backslash/%). */
export function escapeDrawtext(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\u2019") // typographic apostrophe — no filter escape needed
    .replace(/%/g, "\\%")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/,/g, "\\,")
    .replace(/\n/g, " ");
}

/**
 * The drawtext chain for one scene's title, appended to the segment's visual
 * graph (whose output is labeled [v] by default — S3 chains chroma/PIP links
 * ahead of the title, so the chain's INPUT label is a parameter). Returns
 * null when the scene carries no title. `dur` is the segment length (the
 * animation timeline).
 *
 * Geometry mirrors the caption grammar: face size relative to frame height,
 * high-contrast outline, inside the safe zone. The animation rides `t` —
 * drawtext sees SEGMENT-LOCAL time because the segment is built in isolation.
 */
export function titleDrawtextFilter(
  title: SceneTitle | null | undefined,
  dur: number,
  vertical: boolean,
  inLabel = "[v]"
): string | null {
  if (!title) return null;
  const D = Math.max(dur, 0.5);
  const face = Math.round(480 * (vertical ? 0.05 : 0.062) * title.size); // ≈30px @1080p
  const margin = vertical ? Math.round(480 * 0.09) : Math.round(480 * 0.075);
  const text = escapeDrawtext(title.text);
  const common = `fontfile=${process.env.TUBEFORGE_TITLE_FONT ?? "/usr/share/fonts/truetype/chinese/NotoSansSC-Regular.ttf"}`;

  // Style → weight / box / outline.
  let look: string;
  switch (title.style) {
    case "bold":
      look = `fontcolor=white:borderw=${Math.max(3, Math.round(face * 0.14))}:bordercolor=black@0.85:shadowx=2:shadowy=3:shadowcolor=black@0.5`;
      break;
    case "outline":
      look = `fontcolor=white:borderw=${Math.max(4, Math.round(face * 0.2))}:bordercolor=black@0.95`;
      break;
    case "lower":
      look = `fontcolor=white:box=1:boxcolor=black@0.45:boxborderw=${Math.round(face * 0.55)}`;
      break;
    default:
      look = `fontcolor=white:borderw=2:bordercolor=black@0.55:shadowx=1:shadowy=2:shadowcolor=black@0.4`;
  }

  // Position — drawtext anchors by the text's TOP-LEFT; `th` is its height.
  let y: string;
  switch (title.pos) {
    case "top":
      y = String(margin);
      break;
    case "center":
      y = "(h-th)/2";
      break;
    default:
      y = `h-th-${margin}`;
  }

  // Animation (segment-local t): fade in 0.4s, out over the last 0.5s;
  // rise = ease-out slide up from 40px; slide = push in from the left edge.
  let alpha = "";
  let xExpr = "(w-tw)/2";
  let yExpr = y;
  const fadeIn = `if(lt(t\\,0.4)\\,t/0.4\\,1)`;
  const fadeOut = `if(gt(t\\,${(D - 0.5).toFixed(2)})\\,max(0\\,(${D.toFixed(2)}-t)/0.5)\\,1)`;
  switch (title.anim) {
    case "none":
      break;
    case "fade":
      alpha = `alpha='min(${fadeIn}\\,${fadeOut})'`;
      break;
    case "rise": {
      alpha = `alpha='min(${fadeIn}\\,${fadeOut})'`;
      yExpr = `(${y})+40*pow(1-min(t/0.6\\,1)\\,2)`;
      break;
    }
    case "slide": {
      alpha = `alpha='min(${fadeIn}\\,${fadeOut})'`;
      xExpr = `(w-tw)/2+w*0.12*pow(1-min(t/0.55\\,1)\\,2)`;
      break;
    }
  }

  return `[v]drawtext=${common}:text='${text}':x='${xExpr}':y='${yExpr}':fontsize=${face}:${look}${alpha ? `:${alpha}` : ""}[vt]`.replace(
    "[v]drawtext",
    `${inLabel}drawtext`
  );
}

// ---------- camera keyframes ----------

/** One camera key: window scale (1..2.2, 1 = full frame) + the window CENTER
 *  as a fraction of the frame (0..1). Mirrors preview-lanes' CameraTransform
 *  vocabulary so the preview and the render speak the same numbers. */
export interface CameraKey {
  scale: number;
  x: number;
  y: number;
}

export interface SceneCameraKeys {
  from: CameraKey;
  to: CameraKey;
  ease: "smooth" | "linear" | "pop";
}

export function sanitizeCameraKey(v: unknown, fallback: CameraKey): CameraKey {
  if (!v || typeof v !== "object" || Array.isArray(v)) return fallback;
  const k = v as Record<string, unknown>;
  return {
    scale: clampNum(k.scale, 1, 2.2, fallback.scale),
    x: clampNum(k.x, 0, 1, fallback.x),
    y: clampNum(k.y, 0, 1, fallback.y),
  };
}

export function sanitizeCamera(v: unknown): SceneCameraKeys | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const c = v as Record<string, unknown>;
  const ease = c.ease === "linear" || c.ease === "pop" ? c.ease : "smooth";
  const from = sanitizeCameraKey(c.from, { scale: 1, x: 0.5, y: 0.5 });
  const to = sanitizeCameraKey(c.to, { scale: from.scale, x: from.x, y: from.y });
  return { from, to, ease };
}

/** Eased progress 0..1 — the exact curves the render's zoompan uses. */
export function cameraEase(ease: SceneCameraKeys["ease"], p: number): number {
  const c = Math.min(1, Math.max(0, p));
  if (ease === "linear") return c;
  if (ease === "pop") return 1 - (1 - c) * (1 - c); // ease-out quad
  return (1 - Math.cos(Math.PI * c)) / 2; // easeInOutSine — the cinematic default
}

/** Interpolate the camera at progress p — shared by preview and tests. */
export function cameraAtKeys(k: SceneCameraKeys, p: number): { scale: number; cx: number; cy: number } {
  const t = cameraEase(k.ease, p);
  return {
    scale: k.from.scale + (k.to.scale - k.from.scale) * t,
    cx: k.from.x + (k.to.x - k.from.x) * t,
    cy: k.from.y + (k.to.y - k.from.y) * t,
  };
}

// ---------- speed ----------

/** Per-scene playback rate — narration atempo, footage setpts, preview
 *  playbackRate. Clamped to atempo's single-filter range. */
export function sanitizeSpeed(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n) || Math.abs(n - 1) < 0.02) return null; // 1 (±2%) = no override
  return Math.min(2, Math.max(0.5, n));
}

// ---------- voice fades ----------

export interface VoiceFades {
  inSec: number;
  outSec: number;
}

export function sanitizeVoiceFades(vin: unknown, vout: unknown): VoiceFades | null {
  const fin = clampNum(vin, 0, 3, 0);
  const fout = clampNum(vout, 0, 3, 0);
  if (fin < 0.02 && fout < 0.02) return null;
  return { inSec: fin, outSec: fout };
}

// ---------- chroma key (S3) ----------

/** Per-scene green/blue-screen keying. The keyed pixels reveal a solid
 * background fill. Colors are "#rrggbb" in the doc (the UI's native color
 * grammar); the filter builder converts to ffmpeg's 0xRRGGBB. */
export interface SceneChroma {
  /** Key color ("#00FF00" = classic green screen). */
  color: string;
  /** 0.01..0.35 — chroma distance counted as keyed (bigger = hungrier key). */
  similarity: number;
  /** 0..0.2 — edge softness between keyed and kept pixels. */
  blend: number;
  /** What shows through the keyed pixels ("#000000" = black). */
  background: string;
}

export const CHROMA_PRESETS: { id: string; label: string; color: string }[] = [
  { id: "green", label: "Green", color: "#00FF00" },
  { id: "blue", label: "Blue", color: "#0038FF" },
  { id: "magenta", label: "Magenta", color: "#FF00FF" },
];

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function sanitizeHex(v: unknown, fallback: string): string {
  return typeof v === "string" && HEX_RE.test(v.trim()) ? v.trim().toUpperCase() : fallback;
}

export function sanitizeChroma(v: unknown): SceneChroma | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const c = v as Record<string, unknown>;
  return {
    color: sanitizeHex(c.color, "#00FF00"),
    similarity: clampNum(c.similarity, 0.01, 0.35, 0.12),
    blend: clampNum(c.blend, 0, 0.2, 0.02),
    background: sanitizeHex(c.background, "#000000"),
  };
}

const hexToFfmpeg = (hex: string): string => `0x${hex.slice(1)}`;

/**
 * The chroma-key chain for one scene's visual graph. `inLabel` is the base
 * graph's tail (post camera/motion, PRE grade on purpose: the grade's
 * saturation/contrast shift would move the key color and poison the key).
 * The grade is re-applied to the composite so the scene keeps its look.
 * Returns the chain + the label the next link consumes.
 */
export function chromaFilterChain(
  c: SceneChroma,
  opts: { w: number; h: number; dur: number; fps: number; inLabel?: string; grade?: string }
): { chain: string; outLabel: string } {
  const inLabel = opts.inLabel ?? "[v]";
  const grade = opts.grade && opts.grade !== "null" ? opts.grade : "null";
  return {
    chain: [
      `${inLabel}chromakey=${hexToFfmpeg(c.color)}:${c.similarity.toFixed(3)}:${c.blend.toFixed(3)}[vck]`,
      `color=c=${hexToFfmpeg(c.background)}:s=${opts.w}x${opts.h}:r=${opts.fps}:d=${(opts.dur + 0.5).toFixed(3)}[vcbg]`,
      `[vcbg][vck]overlay=0:0:shortest=1,${grade}[vc]`,
    ].join(";"),
    outLabel: "[vc]",
  };
}

// ---------- picture-in-picture / logo overlay (S3) ----------

/** A per-scene corner overlay (the video's brand logo). 9-grid position,
 * size as a fraction of frame width, opacity, optional white hairline. */
export type PipPos = "tl" | "tc" | "tr" | "ml" | "mc" | "mr" | "bl" | "bc" | "br";

export interface ScenePip {
  pos: PipPos;
  /** Logo width as a fraction of the frame width, 0.06..0.4. */
  size: number;
  /** 0.1..1 opacity. */
  opacity: number;
  /** White hairline frame around the logo. */
  border: boolean;
  /** Distance from the frame edge as a fraction of width, 0.01..0.08. */
  margin: number;
}

const PIP_POS: PipPos[] = ["tl", "tc", "tr", "ml", "mc", "mr", "bl", "bc", "br"];

export function sanitizePip(v: unknown): ScenePip | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const p = v as Record<string, unknown>;
  return {
    pos: PIP_POS.includes(p.pos as PipPos) ? (p.pos as PipPos) : "br",
    size: clampNum(p.size, 0.06, 0.4, 0.18),
    opacity: clampNum(p.opacity, 0.1, 1, 1),
    border: p.border === true,
    margin: clampNum(p.margin, 0.01, 0.08, 0.03),
  };
}

/**
 * The PIP overlay link: scales the logo input, fades it by opacity, then
 * overlays it at the 9-grid position. `pipInput` is the logo's input index
 * in the ffmpeg invocation; `inLabel`/`outLabel` chain like chroma's.
 */
export function pipOverlayFilter(
  p: ScenePip,
  opts: { pipInput: number; frameW: number; frameH: number; inLabel?: string }
): { chain: string; outLabel: string } {
  const inLabel = opts.inLabel ?? "[v]";
  const w = Math.max(32, Math.round(opts.frameW * p.size));
  const m = Math.round(opts.frameW * p.margin);
  const bt = Math.max(2, Math.round(opts.frameW * 0.002));
  // NOTE: long variable names only (main_w/overlay_w) — this ffmpeg build
  // rejects overlay's short w/W/h/H aliases (evaluated to NaN → hidden).
  const x =
    p.pos.endsWith("l") ? String(m) : p.pos.endsWith("r") ? `main_w-overlay_w-${m}` : "(main_w-overlay_w)/2";
  const y =
    p.pos.startsWith("t") ? String(m) : p.pos.startsWith("b") ? `main_h-overlay_h-${m}` : "(main_h-overlay_h)/2";
  return {
    chain: [
      `[${opts.pipInput}:v]scale=${w}:-2,format=rgba,colorchannelmixer=aa=${p.opacity.toFixed(2)}${
        p.border ? `,drawbox=color=white@0.9:t=${bt}` : ""
      }[vpi]`,
      `${inLabel}[vpi]overlay=x='${x}':y='${y}':format=auto[vp]`,
    ].join(";"),
    outLabel: "[vp]",
  };
}

// ---------- export presets (S3) ----------

export type ExportQuality = "draft" | "standard" | "high";

/** x264 encode settings per quality tier (segments + final master). */
export const QUALITY_ENCODING: Record<ExportQuality, { crf: string; preset: string }> = {
  draft: { crf: "26", preset: "ultrafast" },
  standard: { crf: "20", preset: "veryfast" },
  high: { crf: "18", preset: "medium" },
};

export interface ExportPreset {
  id: string;
  label: string;
  note: string;
  aspect: "16:9" | "9:16" | "1:1";
  fps: 24 | 30 | 60;
  quality: ExportQuality;
  burnSubtitles: boolean;
}

export const EXPORT_PRESETS: ExportPreset[] = [
  { id: "yt-standard", label: "YouTube 1080p", note: "16:9 · 30 fps · standard, captions burned", aspect: "16:9", fps: 30, quality: "standard", burnSubtitles: true },
  { id: "yt-cinema", label: "Cinematic master", note: "16:9 · 24 fps · high quality, captions burned", aspect: "16:9", fps: 24, quality: "high", burnSubtitles: true },
  { id: "reels", label: "Reels / TikTok", note: "9:16 · 30 fps · vertical with big captions", aspect: "9:16", fps: 30, quality: "standard", burnSubtitles: true },
  { id: "shorts-60", label: "Shorts 60 fps", note: "9:16 · 60 fps · extra-smooth motion", aspect: "9:16", fps: 60, quality: "standard", burnSubtitles: true },
  { id: "square", label: "Square social", note: "1:1 · 30 fps · feed post", aspect: "1:1", fps: 30, quality: "standard", burnSubtitles: true },
  { id: "clean-draft", label: "Clean draft", note: "16:9 · 30 fps · fast draft, no captions", aspect: "16:9", fps: 30, quality: "draft", burnSubtitles: false },
];

/** Render preferences persisted on the timeline doc's root. Aspect / fps /
 * burnCaptions live on the video row (renderDefaultsSchema); the quality
 * tier + the caption-style pick live here because the row has no column
 * for them. */
export interface RenderPrefs {
  quality: ExportQuality;
  /** S6 — the caption look the render burns (null/absent = "classic"). */
  captionStyle?: string | null;
  /** S7 — the music pick the render lays under the voice (absent = follow
   *  the per-video Settings exactly as before S7). */
  music?: MusicPick | null;
  /** S9 — the poster pick: which scene the cover art depicts (absent =
   *  scene 1, exactly as before S9). */
  poster?: PosterPick | null;
  /** S10 — the short pick: which scene the vertical cut centers on (absent
   *  = the hook heuristic, exactly as before S10). */
  short?: ShortPick | null;
}

export function sanitizeRenderPrefs(v: unknown): RenderPrefs | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const rec = v as Record<string, unknown>;
  const q = rec.quality;
  if (q !== "draft" && q !== "standard" && q !== "high") return null;
  // S6 — the caption pick re-sanitizes at the same choke point; absent or
  // junk reads as no pick (the classic look) and the key is omitted so a
  // legacy doc serializes byte-stable.
  const cs = sanitizeCaptionStyle(rec.captionStyle);
  // S7 — the music pick: same doctrine, absent/junk reads as "no opinion"
  // (follow the Settings chain) and the key is omitted for byte-stability.
  const mp = sanitizeMusicPick(rec.music);
  // S9 — the poster pick: same doctrine, absent/junk reads as "no opinion"
  // (the cover depicts scene 1, the pre-S9 behavior) and the key is omitted
  // for byte-stability.
  const pp = sanitizePosterPick(rec.poster);
  // S10 — the short pick: same doctrine, absent/junk reads as "no opinion"
  // (the hook heuristic picks the moment, the pre-S10 behavior) and the key
  // is omitted for byte-stability.
  const sp = sanitizeShortPick(rec.short);
  return {
    quality: q,
    ...(cs ? { captionStyle: cs } : {}),
    ...(mp ? { music: mp } : {}),
    ...(pp ? { poster: pp } : {}),
    ...(sp ? { short: sp } : {}),
  };
}

// ---------- S7: the music pick — the score the render lays under ----------
//
// Until now the music bed was decided entirely OUTSIDE the studio: per-video
// row overrides → account Settings → the auto-match engine, with the APPROVED
// plan's mood riding between. S7 makes the bed a studio pick on the doc root
// (the bed is one global pass, so the pick is per-VIDEO like the caption
// style, not per-scene). The priority doctrine is the sprint's: doc pick >
// plan > row. "off" is a real pick — the studio mutes the bed outright (true
// silence, not the synthesized drone fallback).
//
// PURE on purpose (this module imports nothing): shape validation only.
// CATALOG validation happens one layer out, at the resolver — a hostile
// moodId/trackId can only ever fall down the existing precedence chain
// (row pin → settings pin → auto-match), never select a path or a crash.

export type MusicPickMode = "auto" | "mood" | "track" | "off";

export interface MusicPick {
  mode: MusicPickMode;
  /** mode "mood" — a story-mood preset id (the resolver validates against
   *  the client-safe MUSIC_MOODS catalog). */
  moodId?: string;
  /** mode "track" — a MusicTrack row id (the resolver validates against the
   *  org-scoped, active library). */
  trackId?: string;
}

const MUSIC_PICK_MODES: readonly MusicPickMode[] = ["auto", "mood", "track", "off"];

/** Track/mood ids are slugs or cuids — anything else (paths, script, SQL)
 *  is junk before it ever reaches the resolver. */
const MUSIC_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** The doc boundary: accept anything a persisted doc may carry and return a
 *  clean pick or null (null + junk = "no opinion" — follow the Settings
 *  chain). Fields irrelevant to the mode are dropped so a pick is always
 *  self-consistent ("mood" carries moodId, "track" carries trackId). */
export function sanitizeMusicPick(v: unknown): MusicPick | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const rec = v as Record<string, unknown>;
  const mode = rec.mode;
  if (typeof mode !== "string") return null;
  const m = mode.trim().toLowerCase();
  if (!MUSIC_PICK_MODES.includes(m as MusicPickMode)) return null;
  const cleanId = (x: unknown): string | undefined => {
    if (typeof x !== "string") return undefined;
    const s = x.trim().toLowerCase();
    return MUSIC_ID_RE.test(s) ? s : undefined;
  };
  if (m === "mood") {
    const moodId = cleanId(rec.moodId);
    return moodId ? { mode: "mood", moodId } : null;
  }
  if (m === "track") {
    const trackId = cleanId(rec.trackId);
    return trackId ? { mode: "track", trackId } : null;
  }
  return { mode: m as MusicPickMode };
}

/** The doc's pick, already sanitized (the render + preview + audition read
 *  this). Absent or junk → null ("no opinion" — the pre-S7 chain decides). */
export function docMusicPick(
  prefs: RenderPrefs | null | undefined
): MusicPick | null {
  return sanitizeMusicPick(prefs?.music);
}

// ---------- S14: the delivery — the grade the render encodes, the captions'
// shipping form ----------
//
// The last two export decisions held captive by the detail dialog's preset
// row. Their fates differed, and the difference matters:
//   · the GRADE (draft/standard/high) rode the doc's renderPrefs and the
//     render JOB read it (aligned doc only) — but only the dialog could
//     WRITE it (a preset click), and the route's own comment promised a
//     chain its code never ran: the route passed the body tier through
//     verbatim and left the doc fallback to the job, one layer down, so
//     nothing resolved the chain in one place and the response echoed
//     nothing.
//   · the BURN (captions into the frame vs a sidecar SRT) was written by
//     the presets onto the row and honored by NOBODY through HTTP: the
//     route pre-resolved `body?.subtitles ?? mode !== "slides"` into a
//     DEFINITE boolean, and the job's own row fallback
//     (`opts.subtitles ?? projectBurn ?? mode default`) was unreachable
//     behind it — a bare render ignored every standing burn pick.
// S14 gives both decisions ONE shared resolution law (here, so the render
// route, the probes and any future caller share a single truth), a studio
// pick each, and a response that echoes what the job will actually honor.
//
// PURE on purpose (this module imports nothing): shape validation only.

/**
 * The delivery grade the render encodes at. The chain, now run in ONE
 * place: a per-render body override (the dialog's preset picker) > the
 * doc's standing pick (renderPrefs.quality — the ONE required renderPrefs
 * key, so a doc that passed sanitize always carries it) > the standard
 * tier (the pre-S14 default). Junk in either slot is simply not a pick —
 * it falls through. (The job keeps its own aligned-doc read as the
 * crash-resume path; the route's resolved value is the same answer.)
 */
export function resolveDeliveryQuality(
  bodyQuality: unknown,
  doc: RenderPrefs | null | undefined
): ExportQuality {
  if (bodyQuality === "draft" || bodyQuality === "standard" || bodyQuality === "high")
    return bodyQuality;
  const docQ = doc?.quality;
  if (docQ === "draft" || docQ === "standard" || docQ === "high") return docQ;
  return "standard";
}

/**
 * Where captions ship. The chain: a per-render body override (the dialog's
 * preset picker) > the row's standing pick (burnCaptions) > the format
 * default (burned for video modes, off for slides — the deck's headlines
 * already carry the words). A boolean body wins even when false: an
 * explicit "no burn" is a decision, not an absence.
 */
export function resolveBurnSubtitles(
  bodySubtitles: unknown,
  rowBurn: boolean | null | undefined,
  mode: string
): boolean {
  if (typeof bodySubtitles === "boolean") return bodySubtitles;
  if (typeof rowBurn === "boolean") return rowBurn;
  return mode !== "slides";
}

// ---------- S9: the poster — the scene the cover depicts ----------
//
// The cover art's SUBJECT was decided outside the studio: the thumbnail
// concept derives from scene 1's visual, always, and wanting the poster to
// tease a different moment meant regenerating the script's opening. S9
// makes the subject a doc-level pick: which scene's visual + mood the
// concept (and therefore the CogView art) derives from. "auto" keeps the
// pre-S9 behavior — scene 1, the hook-first doctrine.
//
// PURE on purpose (this module imports nothing): shape validation only.
// RANGE validation (the scene actually exists) happens one layer out at
// the concept derivation — a hostile/absent sceneIndex can only ever fall
// back to scene 1, never select a path or crash.

export type PosterPickMode = "auto" | "scene";

export interface PosterPick {
  mode: PosterPickMode;
  /** mode "scene" — the ROW scene's index (the stable identity the doc's
   *  scenes also carry); validated against the scene list at the
   *  derivation, junk falls back to scene 1. */
  sceneIndex?: number;
}

/** The doc boundary: accept anything a persisted doc may carry and return a
 * clean pick or null (null + junk = "no opinion" — the cover depicts scene
 * 1). Fields irrelevant to the mode are dropped so a pick is always
 * self-consistent ("scene" carries sceneIndex). */
export function sanitizePosterPick(v: unknown): PosterPick | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const rec = v as Record<string, unknown>;
  const mode = rec.mode;
  if (typeof mode !== "string") return null;
  const m = mode.trim().toLowerCase();
  if (m === "auto") return { mode: "auto" };
  if (m !== "scene") return null;
  // A scene index is a small positive integer — floats, strings, huge
  // numbers and NaN are junk before they ever reach the scene list.
  const raw = rec.sceneIndex;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 999)
    return null;
  return { mode: "scene", sceneIndex: raw };
}

/** The doc's pick, already sanitized (the thumbnail + variants jobs read
 *  this). Absent or junk → null ("no opinion" — scene 1 decides). */
export function docPosterPick(
  prefs: RenderPrefs | null | undefined
): PosterPick | null {
  return sanitizePosterPick(prefs?.poster);
}

// ---------- S10: the short — the moment the cut frames ----------
//
// The vertical cut's MOMENT was decided outside the studio: a hook regex
// (pickBestScene) scored the scenes and the highest scorer got framed,
// always — unless someone knew about the detail dialog's per-request body
// override. The studio, where every other creative pick now lives (the
// cue, the bed, the words' face, the score, the narrator, the cover's
// subject), had no say in the 9:16 derivative at all. S10 makes the moment
// a doc-level pick: which scene the Short centers on. "auto" keeps the
// pre-S10 behavior — the hook heuristic decides.
//
// PURE on purpose (this module imports nothing): shape validation only.
// RANGE validation (the scene actually exists) happens one layer out at
// shortSceneIndexFor — a hostile/absent sceneIndex can only ever fall back
// to the heuristic, never select a path or crash.

export type ShortPickMode = "auto" | "scene";

export interface ShortPick {
  mode: ShortPickMode;
  /** mode "scene" — the ROW scene's index (the stable identity the doc's
   *  scenes also carry); validated against the scene list at the
   *  resolution, junk falls back to the hook heuristic. */
  sceneIndex?: number;
}

/** The doc boundary: accept anything a persisted doc may carry and return a
 * clean pick or null (null + junk = "no opinion" — the hook heuristic picks
 * the moment). Fields irrelevant to the mode are dropped so a pick is
 * always self-consistent ("scene" carries sceneIndex). */
export function sanitizeShortPick(v: unknown): ShortPick | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const rec = v as Record<string, unknown>;
  const mode = rec.mode;
  if (typeof mode !== "string") return null;
  const m = mode.trim().toLowerCase();
  if (m === "auto") return { mode: "auto" };
  if (m !== "scene") return null;
  // A scene index is a small positive integer — floats, strings, huge
  // numbers and NaN are junk before they ever reach the scene list.
  const raw = rec.sceneIndex;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > 999)
    return null;
  return { mode: "scene", sceneIndex: raw };
}

/** The doc's pick, already sanitized (the short job + the studio picker read
 *  this). Absent or junk → null ("no opinion" — the heuristic decides). */
export function docShortPick(
  prefs: RenderPrefs | null | undefined
): ShortPick | null {
  return sanitizeShortPick(prefs?.short);
}

// ---------- S6: caption styles — the words' face ----------
//
// Until now the burned captions had ONE look: two hardcoded ASS force_style
// constants in render.ts (16:9 + the slides-mode vertical variant). S6 makes
// the caption look a studio pick: the doc's renderPrefs carries a style id,
// the render maps it onto the SAME ASS params through this module, and the
// live preview mirrors the geometry. One vocabulary, both sides (the S2/S3
// choke-point doctrine) — the classic entry below reproduces the legacy
// constants BYTE-FOR-BYTE, so "no pick" is visually identical to pre-S6.
//
// PURE on purpose: no imports, no fs — the client component, the job layer
// and the render all pull this file.

/** ASS font metrics for ONE orientation (the render canvas is 1344x768
 *  wide / 768x1344 vertical). */
export interface CaptionStyleVariant {
  /** ASS FontSize (px at the render canvas). */
  face: number;
  bold: 0 | 1;
  /** Outline (px). BorderStyle 3 reuses it as the box padding. */
  outline: number;
  shadow: number;
  /** ASS colour &HAABBGGRR (alpha 00 = opaque): stroke / box face. */
  outlineColour: string;
  /** Bottom (Alignment 2) or top (Alignment 8) margin in px. */
  marginV: number;
}

export interface CaptionStyle {
  id: string;
  label: string;
  note: string;
  /** ASS colour &HAABBGGRR (alpha 00 = opaque): the caption fill. */
  primary: string;
  /** 1 = outline + shadow, 3 = opaque box behind the text. */
  borderStyle: 1 | 3;
  /** 2 = bottom-center, 8 = top-center. */
  alignment: 2 | 8;
  /** Preview-only: render the text uppercase. */
  uppercase?: boolean;
  wide: CaptionStyleVariant;
  vertical: CaptionStyleVariant;
}

const ASS_FONT = "FontName=Noto Sans SC";

/** The catalog. "classic" is the pre-S6 look pinned byte-for-byte (pinned
 *  by the S6 probe); everything else is a creator-facing variation. */
export const CAPTION_STYLES: readonly CaptionStyle[] = [
  {
    id: "classic",
    label: "Classic",
    note: "The studio default — white face, near-black outline, bottom-center",
    primary: "&H00FFFFFF",
    borderStyle: 1,
    alignment: 2,
    wide: { face: 22, bold: 0, outline: 2.4, shadow: 1.1, outlineColour: "&H20000000", marginV: 36 },
    vertical: { face: 19, bold: 1, outline: 2.2, shadow: 0, outlineColour: "&H8C000000", marginV: 190 },
  },
  {
    id: "bold-pop",
    label: "Bold pop",
    note: "Bigger bold face with a heavy outline — hooks and hard reads",
    primary: "&H00FFFFFF",
    borderStyle: 1,
    alignment: 2,
    wide: { face: 27, bold: 1, outline: 3.4, shadow: 1.5, outlineColour: "&H0A000000", marginV: 40 },
    vertical: { face: 24, bold: 1, outline: 3.0, shadow: 1.2, outlineColour: "&H0A000000", marginV: 200 },
  },
  {
    id: "clean-box",
    label: "Clean box",
    note: "Minimal face on a semi-opaque box — documentaries, interviews",
    primary: "&H00FFFFFF",
    borderStyle: 3,
    alignment: 2,
    wide: { face: 20, bold: 1, outline: 9, shadow: 0, outlineColour: "&H8C000000", marginV: 34 },
    vertical: { face: 18, bold: 1, outline: 8, shadow: 0, outlineColour: "&H8C000000", marginV: 184 },
  },
  {
    id: "top-line",
    label: "Top line",
    note: "Top-center banner — keeps the lower third clear for footage UI",
    primary: "&H00FFFFFF",
    borderStyle: 1,
    alignment: 8,
    wide: { face: 20, bold: 0, outline: 2.2, shadow: 0.8, outlineColour: "&H32000000", marginV: 40 },
    vertical: { face: 18, bold: 1, outline: 2.0, shadow: 0.6, outlineColour: "&H32000000", marginV: 44 },
  },
  {
    id: "amber-warm",
    label: "Amber warm",
    note: "Warm amber fill — lifestyle, food and golden-hour looks",
    primary: "&H0043C8FF",
    borderStyle: 1,
    alignment: 2,
    wide: { face: 23, bold: 1, outline: 2.8, shadow: 1.2, outlineColour: "&H14000000", marginV: 38 },
    vertical: { face: 20, bold: 1, outline: 2.4, shadow: 1.0, outlineColour: "&H14000000", marginV: 196 },
  },
] as const;

/** The catalog entry for a persisted pick (null = unknown / junk). */
export function captionStyle(id: unknown): CaptionStyle | null {
  if (typeof id !== "string") return null;
  return CAPTION_STYLES.find((s) => s.id === id) ?? null;
}

/**
 * S6 — the doc boundary: accept anything a persisted doc may carry and
 * return a clean catalog id or null (null + "classic" + "none" + junk all
 * read as "no pick" — the classic look). Case and whitespace normalized.
 */
export function sanitizeCaptionStyle(id: unknown): string | null {
  if (typeof id !== "string") return null;
  const v = id.trim().toLowerCase();
  if (!v || v === "none" || v === "off" || v === "classic") return null;
  return captionStyle(v) ? v : null;
}

/** The doc's pick, already sanitized (the render + preview read this). */
export function docCaptionStyle(
  prefs: RenderPrefs | null | undefined
): string | null {
  return sanitizeCaptionStyle(prefs?.captionStyle);
}

/**
 * The ONE ASS force_style mapping the render burns. Unknown/junk picks fall
 * back to classic, so the string is NEVER null and NEVER hostile — a hostile
 * doc can only ever select a catalog look. `classic` wide reproduces the
 * pre-S6 constant exactly (Bold is omitted when 0 — ASS defaults it).
 */
export function captionAssStyle(id: unknown, vertical: boolean): string {
  const s = captionStyle(id) ?? CAPTION_STYLES[0];
  const v = vertical ? s.vertical : s.wide;
  return [
    ASS_FONT,
    `FontSize=${v.face}`,
    ...(v.bold ? [`Bold=${v.bold}`] : []),
    `PrimaryColour=${s.primary}`,
    `OutlineColour=${v.outlineColour}`,
    `BorderStyle=${s.borderStyle}`,
    `Outline=${v.outline}`,
    `Shadow=${v.shadow}`,
    `Alignment=${s.alignment}`,
    `MarginV=${v.marginV}`,
  ].join(",");
}

/** ASS &HAABBGGRR → css color for the preview canvas (alpha inverted to
 *  opacity; opaque-only). Junk in, black out — the preview never crashes. */
function assColourToCss(hex: string): string {
  const m = /^&H([0-9A-Fa-f]{2})([0-9A-Fa-f]{6})$/.exec(hex.trim());
  if (!m) return "#000000";
  const alpha = parseInt(m[1], 16) / 255; // 00 = opaque → 0 transparency
  const b = parseInt(m[2].slice(0, 2), 16);
  const g = parseInt(m[2].slice(2, 4), 16);
  const r = parseInt(m[2].slice(4, 6), 16);
  return `rgba(${r},${g},${b},${(1 - alpha).toFixed(3)})`;
}

/** Preview geometry for one pick — mirrors the render's ASS params through
 *  the canvas grammar (face sizes stay RELATIVE to the classic look, whose
 *  draw the preview already had right). Pure, unit-pinned. */
export interface CaptionPreview {
  /** Face size relative to the classic look (1 = the pre-S6 preview draw). */
  faceMul: number;
  /** css font weight. */
  weight: number;
  /** Caption fill (css). */
  fill: string;
  /** Stroke color (css) — unused when `box` is set. */
  stroke: string;
  /** Stroke width relative to the face size (classic ≈ 0.18). */
  strokeRatio: number;
  /** Box fill behind the text (BorderStyle 3), else null. */
  box: string | null;
  align: "bottom" | "top";
  /** Margin fraction of frame height (bottom for Alignment 2, top for 8). */
  marginRatio: number;
  uppercase: boolean;
}

export function captionPreview(id: unknown, vertical: boolean): CaptionPreview {
  const s = captionStyle(id) ?? CAPTION_STYLES[0];
  const classic = CAPTION_STYLES[0];
  // The classic look PINS the preview draw that existed before S6 — a user
  // without a pick sees a pixel-identical canvas. Other styles derive.
  if (s.id === "classic") {
    return {
      faceMul: 1,
      weight: 600,
      fill: "#ffffff",
      stroke: "rgba(0,0,0,0.72)",
      strokeRatio: 0.18,
      box: null,
      align: "bottom",
      marginRatio: vertical ? 0.075 : 0.032,
      uppercase: false,
    };
  }
  const v = vertical ? s.vertical : s.wide;
  const cv = vertical ? classic.vertical : classic.wide;
  return {
    faceMul: v.face / cv.face,
    weight: v.bold ? 800 : 600,
    fill: assColourToCss(s.primary),
    stroke: assColourToCss(v.outlineColour),
    strokeRatio: Math.max(0.14, v.outline / v.face),
    box: s.borderStyle === 3 ? assColourToCss(v.outlineColour) : null,
    align: s.alignment === 8 ? "top" : "bottom",
    // Scale the ASS margin against the classic margin (clamped to safe zones).
    marginRatio: Math.min(
      0.16,
      Math.max(0.02, (v.marginV / cv.marginV) * (vertical ? 0.075 : 0.032))
    ),
    uppercase: s.uppercase === true,
  };
}
