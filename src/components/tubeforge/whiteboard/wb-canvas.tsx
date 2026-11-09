"use client";

// S67 — the whiteboard playback canvas (E9 Phase A, E1 design §5).
//
// THE SEAM: this component plays a scene by calling the engine's PURE frame
// plan (timing.ts frameAt) and applying it with THE SAME page-side applier
// (wb-page.ts APPLY_FRAME_FN) inside a same-origin srcdoc iframe — the exact
// composition (composeScene) and the exact per-frame DOM contract the
// chromium renderer uses. Scrubbable playback is correct BY CONSTRUCTION:
// what the editor shows at t=12.4s is what the MP4 will contain at t=12.4s.
// There is no second animation implementation to drift.
import { useEffect, useRef } from "react";

import { loadLibrary } from "@/lib/tubeforge/whiteboard/assets";
import { composeScene, framePayload, APPLY_FRAME_FN } from "@/lib/tubeforge/whiteboard/wb-page";
import {
  buildGeometry,
  frameAt,
  frameCount,
  scheduleScene,
  sceneDurationMs,
} from "@/lib/tubeforge/whiteboard/timing";
import type { WhiteboardProject } from "@/lib/tubeforge/whiteboard/storyboard";

export interface WbCanvasProps {
  project: WhiteboardProject;
  sceneIndex: number;
  playing: boolean;
  /** Imperative scrub: a fresh nonce applies the tMs immediately. */
  seek: { tMs: number; nonce: number } | null;
  /** Throttled (~10 Hz) time reporter for the studio's slider. */
  onTime: (tMs: number) => void;
  onEnded: () => void;
}

/** The per-scene draw schedule + geometry — built once per scene change. */
function sceneRuntime(project: WhiteboardProject, sceneIndex: number) {
  const lib = loadLibrary();
  const geometry = buildGeometry(
    [...lib.extracted.entries()].map(([id, ex]) => ({ id, paths: ex.paths }))
  );
  const scene = project.scenes[sceneIndex];
  // The editor rides the narration ESTIMATE (sceneDurationMs with no VO);
  // the render re-derives the real window from the measured WAV — the
  // plan's law that the timing engine, not the editor, owns durations.
  const durationMs = sceneDurationMs(scene, null);
  return { lib, geometry, scene, durationMs, events: scheduleScene(scene, durationMs, geometry) };
}

export default function WbCanvas({ project, sceneIndex, playing, seek, onTime, onEnded }: WbCanvasProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const runtimeRef = useRef<ReturnType<typeof sceneRuntime> | null>(null);
  const tRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const lastReportRef = useRef(0);
  const setupRef = useRef<(() => void) | null>(null);
  const applyFrameRef = useRef<((tMs: number) => void) | null>(null);
  const cbRef = useRef({ onTime, onEnded });
  useEffect(() => {
    // The latest-callback ref — assigned in an effect, never during render
    // (React's ref rules; the loop reads it at frame time).
    cbRef.current = { onTime, onEnded };
  }, [onTime, onEnded]);

  // Rebuild the page when the scene changes; reset the clock.
  useEffect(() => {
    tRef.current = 0;
    runtimeRef.current = null; // rebuilt lazily below, after setContent
    const iframe = iframeRef.current;
    if (!iframe) return;
    const rt = (runtimeRef.current ??= sceneRuntime(project, sceneIndex));
    const composed = composeScene(rt.scene, project, rt.lib.assets);
    const setup = () => {
      const doc = iframe.contentDocument;
      const win = iframe.contentWindow;
      if (!doc || !win) return;
      // The same three setup passes render.ts runs inside chromium:
      // (1) defs root + hand asset + scale, (2) the plan-key → element-id
      // maps, (3) per-path dasharrays from OUR geometry.
      const board = doc.getElementById("board");
      const handAssetEl = doc.getElementById("hand-asset");
      const hand = doc.getElementById("hand");
      if (!board || !handAssetEl || !hand) return;
      const defs = doc.createElementNS("http://www.w3.org/2000/svg", "defs");
      defs.id = "defs-root";
      board.appendChild(defs);
      handAssetEl.innerHTML = rt.lib.assets.get("hand-marker")?.svg ?? "";
      hand.setAttribute("data-scale", String(project.hand.scale));
      const w = win as unknown as {
        __wbDraw?: Map<string, string>;
        __wbText?: Map<string, string>;
        __wbApply?: (payloadJson: string) => boolean;
      };
      w.__wbDraw = new Map(composed.pathEls);
      w.__wbText = new Map(composed.textEls);
      for (const [key, elId] of composed.pathEls) {
        const [assetId, pathId] = key.split("::");
        const segs = rt.geometry.get(assetId)?.paths.get(pathId);
        if (!segs) continue;
        let len = 0;
        for (const g of segs) len += g.lengths[g.lengths.length - 1] ?? 0;
        const el = doc.getElementById(elId);
        if (!el) continue;
        el.dataset.len = String(len);
        el.setAttribute("stroke-dasharray", `${len} ${len}`);
        el.setAttribute("stroke-dashoffset", String(len));
        (el as unknown as { style: CSSStyleDeclaration }).style.opacity = "0";
      }
      for (const [, elId] of composed.textEls) {
        const el = doc.getElementById(elId);
        if (el) (el as unknown as { style: CSSStyleDeclaration }).style.opacity = "0";
      }
      // The applier itself, injected once — the page then drives it exactly
      // like the renderer's page.evaluate does.
      const script = doc.createElement("script");
      script.textContent = `window.__wbApply = (${APPLY_FRAME_FN});`;
      doc.body.appendChild(script);
      // First frame paints immediately.
      applyFrame(0);
    };

    const applyFrame = (tMs: number) => {
      const rt2 = runtimeRef.current;
      const win = iframe.contentWindow;
      if (!rt2 || !win) return;
      const frame = frameAt(project, rt2.scene, rt2.events, rt2.geometry, tMs);
      const payload = framePayload(frame, project.width, project.height);
      (win as unknown as { __wbApply?: (p: string) => boolean }).__wbApply?.(payload);
    };
    // expose for the loop below
    applyFrameRef.current = applyFrame;
    setupRef.current = setup;

    iframe.srcdoc = composed.html;
  }, [project, sceneIndex]);

  // The iframe fires onLoad for every srcdoc swap.
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const onLoad = () => setupRef.current?.();
    iframe.addEventListener("load", onLoad);
    return () => iframe.removeEventListener("load", onLoad);
  }, []);

  // The playback loop: rAF drives the clock; the plan applies per frame.
  useEffect(() => {
    if (!playing) {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      return;
    }
    const step = (now: number) => {
      const rt = runtimeRef.current;
      if (!rt) return;
      const frames = frameCount(rt.durationMs, project.fps);
      const frameDurMs = 1000 / project.fps;
      tRef.current += frameDurMs;
      applyFrameRef.current?.(Math.min(tRef.current, rt.durationMs));
      if (now - lastReportRef.current > 100) {
        lastReportRef.current = now;
        cbRef.current.onTime(Math.min(tRef.current, rt.durationMs));
      }
      if (tRef.current >= rt.durationMs + frameDurMs * Math.min(2, frames)) {
        cbRef.current.onEnded();
        return;
      }
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [playing, project.fps]);

  // Imperative scrub.
  useEffect(() => {
    if (!seek) return;
    const rt = runtimeRef.current;
    if (!rt) return;
    tRef.current = Math.max(0, Math.min(rt.durationMs, seek.tMs));
    applyFrameRef.current?.(tRef.current);
    cbRef.current.onTime(tRef.current);
  }, [seek]);

  return (
    <div className="w-full overflow-hidden rounded-xl border border-white/10 bg-black/40" style={{ aspectRatio: `${project.width} / ${project.height}` }}>
      <iframe
        ref={iframeRef}
        title="Whiteboard preview"
        sandbox="allow-same-origin allow-scripts"
        className="h-full w-full border-0"
      />
    </div>
  );
}
