// title-font.ts — the title-overlay seam (S157).
//
// WHY THIS FILE EXISTS: the title drawtext chain and its font ladder used to
// live in studio-doc.ts — a module the CLIENT components import for its
// sanitizers and presets (timeline-studio, production-workspace). S156 added
// `import fs from "node:fs"` for the ladder, and the production build
// detonated: the whole studio-doc module — node builtin included — entered
// the browser chunk of /page, and Turbopack's browser chunking context
// refuses external modules ("the chunking context (unknown) does not
// support external modules (request: node:fs)"). Typecheck/lint/unit all
// stayed green — the failure only exists in the PRODUCTION bundler.
//
// THE LAW: studio-doc.ts rides the browser chunk and must stay free of node
// builtins — a module the client graph reaches may never import node:fs
// (or any other builtin) at module scope, not even behind a call-time guard.
// Everything that touches the disk lives HERE, imported only by the
// server-side render pipeline.

import fs from "node:fs";

import type { SceneTitle } from "./studio-doc";

// ---------- title font (S156 — the font ladder) ----------

/** The title font candidates, in preference order: the operator's explicit
 *  override wins, then the CJK-capable Noto face, then the Liberation face
 *  the shipped image installs, then DejaVu. The old default hardcoded a
 *  path that a slim image does not carry — drawtext with a missing fontfile
 *  ERRORS, so any scene with a studio title overlay failed its segment
 *  encode. The ladder resolves what EXISTS; the render skips the overlay
 *  (with a visible log note) when nothing does — a title that cannot be
 *  drawn is a degradation, never a dead render. */
const TITLE_FONT_CANDIDATES = [
  "/usr/share/fonts/truetype/chinese/NotoSansSC-Regular.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
];

export function resolveTitleFontFile(): string | null {
  const env = process.env.TUBEFORGE_TITLE_FONT;
  if (env) {
    try {
      if (fs.existsSync(env)) return env;
    } catch {
      /* stat failure → fall through the ladder */
    }
  }
  for (const candidate of TITLE_FONT_CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* stat failure → next candidate */
    }
  }
  return null;
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
  // S156 — the font ladder: resolve what the host ACTUALLY carries; a host
  // with no usable face answers null and the CALLER skips the overlay with
  // a note (the drawtext filter with a missing fontfile is a hard error —
  // the old hardcoded default failed every titled scene on slim images).
  const fontFile = resolveTitleFontFile();
  if (!fontFile) return null;
  const common = `fontfile=${fontFile}`;

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
