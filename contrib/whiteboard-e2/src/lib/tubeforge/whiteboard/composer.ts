// composer.ts — pure FrameState → SVG string (E2 §5, design §6).
//
// Emits a self-contained SVG document (single `<svg>` root, no external refs,
// no scripts). The rasterizer turns it into a PNG; the encoder pipes PNGs
// through ffmpeg. The composer is the ONLY module that knows how to turn
// path/layer/hand/camera state into valid SVG markup.

import { assetRegistry } from "./asset-registry";
import type { FrameState, FrameLayer, FrameHand, FrameCamera, FramePath } from "./animator";

const SVG_NS = "http://www.w3.org/2000/svg";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmt(n: number): string {
  // Stable formatting: trim trailing zeros, max 3 decimals. Avoids 0.30000000001.
  const r = Math.round(n * 1000) / 1000;
  if (Number.isInteger(r)) return String(r);
  return r.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * Compose a complete SVG document for one frame.
 *
 * The output frame has the dimensions specified by `outWidth/outHeight`
 * (the project's settings). The virtual canvas (1920×1080) is mapped onto
 * the output via the camera transform.
 */
export function composeFrameSvg(
  state: FrameState,
  outWidth: number,
  outHeight: number,
  opts: { handStyle: "right" | "left" | "none" },
): string {
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="${SVG_NS}" width="${outWidth}" height="${outHeight}" viewBox="0 0 ${outWidth} ${outHeight}">`,
  );
  // Background
  parts.push(
    `<rect x="0" y="0" width="${outWidth}" height="${outHeight}" fill="${esc(state.background)}" />`,
  );

  // Camera transform: map virtual canvas (1920×1080) → output frame.
  // We compute a transform group: translate output center, scale by camera scale,
  // translate by -camera center.
  const cam = state.camera;
  const outCx = outWidth / 2;
  const outCy = outHeight / 2;
  const cameraTransform = `translate(${fmt(outCx)} ${fmt(outCy)}) scale(${fmt(cam.scale)}) translate(${fmt(-cam.x)} ${fmt(-cam.y)})`;
  parts.push(`<g transform="${cameraTransform}">`);

  // Clip to the virtual canvas so the camera pan never reveals the void.
  parts.push(
    `<defs><clipPath id="canvasClip"><rect x="0" y="0" width="1920" height="1080" /></clipPath></defs>`,
  );
  parts.push(`<g clip-path="url(#canvasClip)">`);

  // Layers
  for (const layer of state.layers) {
    parts.push(renderLayer(layer));
  }
  parts.push(`</g>`); // clip group

  // Hand (drawn ON TOP of the clipped content; outside the clip so it can
  // extend toward the bottom edge of the frame, like a real hand entering
  // from off-canvas).
  if (state.hand && opts.handStyle !== "none") {
    parts.push(renderHand(state.hand, opts.handStyle));
  }
  parts.push(`</g>`); // camera group
  parts.push(`</svg>`);
  return parts.join("");
}

function renderLayer(layer: FrameLayer): string {
  if (layer.opacity <= 0) return "";
  const transform = `translate(${fmt(layer.x)} ${fmt(layer.y)}) scale(${fmt(layer.scale)}) translate(${fmt(layer.translateX / layer.scale)} ${fmt(layer.translateY / layer.scale)})`;
  const parts: string[] = [];
  const groupAttrs = [`transform="${transform}"`];
  if (layer.opacity < 1) groupAttrs.push(`opacity="${fmt(layer.opacity)}"`);
  parts.push(`<g ${groupAttrs.join(" ")}>`);
  for (const p of layer.paths) {
    parts.push(renderPath(p));
  }
  parts.push(`</g>`);
  return parts.join("");
}

function renderPath(p: FramePath): string {
  const attrs: string[] = [`d="${esc(p.d)}"`];
  attrs.push(`stroke="${esc(p.stroke)}"`);
  attrs.push(`stroke-width="${fmt(p.strokeWidth)}"`);
  attrs.push(`stroke-linecap="${p.strokeLinecap}"`);
  attrs.push(`stroke-linejoin="${p.strokeLinejoin}"`);
  if (p.dashArray > 0 && p.dashOffset < p.dashArray) {
    // Partially-drawn state — use dash to hide the un-revealed tail.
    attrs.push(`stroke-dasharray="${fmt(p.dashArray)} ${fmt(p.dashArray + 1)}"`);
    attrs.push(`stroke-dashoffset="${fmt(p.dashOffset)}"`);
  } else if (p.dashArray > 0 && p.dashOffset <= 0) {
    // Fully drawn — no dash needed (cleaner rasterization)
    // (dashOffset 0 + dasharray L L+1 would also work; no-dash is faster)
  }
  if (p.fill) {
    attrs.push(`fill="${esc(p.fill)}"`);
    if (p.fillOpacity < 1) attrs.push(`fill-opacity="${fmt(p.fillOpacity)}"`);
  } else {
    attrs.push(`fill="none"`);
  }
  return `<path ${attrs.join(" ")} />`;
}

function renderHand(hand: FrameHand, style: "right" | "left"): string {
  const registry = assetRegistry();
  const source = registry.handSvg();
  // The hand SVG is authored with the pen tip at (0,0). Place it with a
  // transform so the tip lands at hand.x,hand.y and the body rotates by
  // hand.angleDeg. For the left-handed style we mirror horizontally first.
  const transform = style === "right"
    ? `translate(${fmt(hand.x)} ${fmt(hand.y)}) rotate(${fmt(hand.angleDeg)})`
    : `translate(${fmt(hand.x)} ${fmt(hand.y)}) rotate(${fmt(hand.angleDeg)}) scale(-1 1)`;
  return `<g transform="${transform}" opacity="${hand.visible ? 1 : 0}">${stripSvgRoot(source)}</g>`;
}

/** Strip the outer <svg>…</svg> wrapper so the inner content can be embedded in a <g>. */
function stripSvgRoot(svg: string): string {
  const start = svg.indexOf(">");
  const end = svg.lastIndexOf("</svg>");
  if (start === -1 || end === -1) return svg;
  return svg.slice(start + 1, end).trim();
}
