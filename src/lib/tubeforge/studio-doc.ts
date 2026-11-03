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
 * graph (whose output is labeled [v]). Returns null when the scene carries
 * no title. `dur` is the segment length (the animation timeline).
 *
 * Geometry mirrors the caption grammar: face size relative to frame height,
 * high-contrast outline, inside the safe zone. The animation rides `t` —
 * drawtext sees SEGMENT-LOCAL time because the segment is built in isolation.
 */
export function titleDrawtextFilter(
  title: SceneTitle | null | undefined,
  dur: number,
  vertical: boolean
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

  return `[v]drawtext=${common}:text='${text}':x='${xExpr}':y='${yExpr}':fontsize=${face}:${look}${alpha ? `:${alpha}` : ""}[vt]`;
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
  const x =
    p.pos.endsWith("l") ? String(m) : p.pos.endsWith("r") ? `w-W-${m}` : "(w-W)/2";
  const y =
    p.pos.startsWith("t") ? String(m) : p.pos.startsWith("b") ? `h-H-${m}` : "(h-H)/2";
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
 * tier lives here because the row has no column for it. */
export interface RenderPrefs {
  quality: ExportQuality;
}

export function sanitizeRenderPrefs(v: unknown): RenderPrefs | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const q = (v as Record<string, unknown>).quality;
  return q === "draft" || q === "standard" || q === "high" ? { quality: q } : null;
}
