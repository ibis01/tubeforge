// W4 — text becomes drawn text (S120 §3 W4).
//
// SLICE 1 (this commit): the readability law — a PURE check that a text
// element, at its placement scale, through the camera, at the final output
// size, still renders as legible pixels. The storyboard's validation (and
// the W5 camera director's framing policy) consume it; the pin rejects
// scale-0.4 placements that would collapse a label into unreadable specks.
//
// SLICE 2 (next): the glyph-outline mode — one handwriting face converted
// to SVG path outlines (deterministic, the single-face route) emitted as
// draw_path events, with the marker wipe kept as the fallback. The check
// below is mode-independent: outlined glyphs obey the same pixel law.
//
// Pure: no fs, no DOM, no clock. The text's asset-space size comes from
// the scheduler's own registry (timing.ts TEXT_ANCHORS — one source).
import { TEXT_ANCHORS } from "./timing";

/** The readability wall: a text element whose rendered glyph height is
 *  below this many OUTPUT pixels cannot be read at the final size (12 px
 *  ≈ 0.6% of the 1920-wide stage — the smallest legible label at TV
 *  distance). The W5 camera director reuses it as a framing policy. */
export const WB_TEXT_READABILITY_PX = 12;

export interface TextReadabilityRef {
  assetId: string;
  textId: string;
  /** The placement's scale (the doc's Placement.scale). */
  placementScale: number;
}

export interface TextReadabilityCamera {
  /** The camera's zoom at the text's reveal (1 = the scene plane). */
  zoom: number;
}

export interface TextReadabilityOutput {
  /** The final output width in px (e.g. 1920). */
  width: number;
  /** The scene-plane width the project was authored against. */
  sceneWidth: number;
}

export interface TextReadabilityReport {
  ok: boolean;
  /** Effective rendered glyph height in output pixels. */
  renderedPx: number;
  threshold: number;
  reason?: string;
}

/** checkReadability — effective glyph height =
 *    assetTextSize × placementScale × cameraZoom × (output / scene plane),
 *  compared against the readability wall. A text the registry doesn't
 *  know (an unregistered id) fails CLOSED with a reason — an unreadable
 *  guess must never pass silently. */
export function checkReadability(
  text: TextReadabilityRef,
  camera: TextReadabilityCamera,
  output: TextReadabilityOutput
): TextReadabilityReport {
  const anchor = TEXT_ANCHORS.get(`${text.assetId}::${text.textId}`);
  if (!anchor || !(anchor.size > 0)) {
    return {
      ok: false,
      renderedPx: 0,
      threshold: WB_TEXT_READABILITY_PX,
      reason: `text "${text.assetId}::${text.textId}" is not in the scheduler's text registry — nothing to measure`,
    };
  }
  const zoom = Number.isFinite(camera.zoom) && camera.zoom > 0 ? camera.zoom : 1;
  const plane =
    Number.isFinite(output.sceneWidth) && output.sceneWidth > 0 ? output.sceneWidth : output.width;
  const factor = plane > 0 ? output.width / plane : 1;
  const scale = Number.isFinite(text.placementScale) && text.placementScale > 0 ? text.placementScale : 0;
  const renderedPx = (anchor.size * scale * zoom * factor) || 0;
  const ok = renderedPx >= WB_TEXT_READABILITY_PX;
  return {
    ok,
    renderedPx: Math.round(renderedPx * 100) / 100,
    threshold: WB_TEXT_READABILITY_PX,
    ...(ok
      ? {}
      : {
          reason: `text "${text.assetId}::${text.textId}" renders at ${renderedPx.toFixed(1)}px — below the ${WB_TEXT_READABILITY_PX}px readability wall at this placement/camera/output`,
        }),
  };
}
