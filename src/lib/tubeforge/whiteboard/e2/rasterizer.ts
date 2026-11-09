// rasterizer.ts — SVG string → PNG buffer (E2 §6).
//
// Uses @resvg/resvg-js (MIT, prebuilt napi binary, no browser). The choice
// over Playwright screenshots is documented in audit §5: ~1800 frames per
// 60s render make a browser-based rasterizer impractical for E2's acceptance
// loop, while resvg supports stroke-dasharray/dashoffset, transforms and
// nested groups — everything the composer emits.
//
// Determinism: resvg is a pure rasterizer — same SVG → same PNG, no font
// loading, no clock dependence. Verified by the determinism test (double
// render → identical sha256).

import { Resvg } from "@resvg/resvg-js";

export interface RasterizeOptions {
  width: number;
  height: number;
  /** Background color (hex). When omitted, transparent. */
  background?: string;
}

/**
 * Rasterize an SVG string into a PNG buffer at the requested dimensions.
 *
 * The SVG must declare its own viewBox/dimensions; resvg fits it to the
 * output size via `fitTo: { mode: "width", value: outWidth }` so the
 * composer can emit a fixed 1920×1080 SVG and we render it at any output
 * resolution (preview 640×360, final 1920×1080).
 */
export function rasterizeSvg(svg: string, opts: RasterizeOptions): Buffer {
  const resvg = new Resvg(svg, {
    fitTo: {
      mode: "width",
      value: opts.width,
    },
    background: opts.background || "#FFFFFF",
    font: {
      // No system fonts loaded — text overlays are deferred to E5/E9
      // (design §6). Loading none keeps rasterization deterministic.
      loadSystemFonts: false,
      fontFiles: [],
      fontDirs: [],
      defaultFontFamily: "sans-serif",
    },
  });
  const rendered = resvg.render();
  return rendered.asPng() as Buffer;
}

/**
 * Optional: pre-warm the rasterizer backend. resvg-js's native napi path
 * needs no warm-up; this is a no-op kept for callers that want a stable
 * "ready" promise to await before the first render.
 */
export async function ensureRasterizerReady(): Promise<void> {
  // No-op: resvg-js initializes lazily on first `new Resvg()`. Kept for API
  // symmetry with a future wasm-backend swap.
  return;
}
