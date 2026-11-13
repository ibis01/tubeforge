"use client";

// S67 — the whiteboard playback canvas (E9 Phase A, E1 design §5).
// S68 — Phase B: the canvas becomes the EDIT surface.
//
// THE SEAM: this component plays a scene by calling the engine's PURE frame
// plan (timing.ts frameAt) and applying it with THE SAME page-side applier
// (wb-page.ts APPLY_FRAME_FN) inside a same-origin srcdoc iframe — the exact
// composition (composeScene) and the exact per-frame DOM contract the
// chromium renderer uses. Scrubbable playback is correct BY CONSTRUCTION:
// what the editor shows at t=12.4s is what the MP4 will contain at t=12.4s.
// There is no second animation implementation to drift.
//
// S68 viewport law: the iframe is laid out at the PROJECT's real pixel size
// (width × height — exactly the chromium viewport the renderer uses) and
// scaled to fit the dialog with a CSS transform. Phase A let the 1920px SVG
// clip inside a smaller viewport (a top-left crop, with the camera math
// assuming board.clientWidth = 1920); the transform keeps that client width
// pixel-identical to the render while showing the WHOLE board. Every
// coordinate the editing overlay computes goes through the same camera
// transform the applier applies (translate(tx,ty) scale(s), tx = W/2 − cx·s),
// so pointer hits land on the ink they appear to touch.
//
// Editing contract (Phase B scope): drag a placement to move it — the live
// drag patches the SAME transform attribute the applier writes, and the
// commit flows back to the studio (which owns the doc and PUTs it).
// Everything else (add/remove/scale/rotate/z-order, events, camera keys)
// is the studio's form work — the canvas stays the frame-plan mirror.
import { useCallback, useEffect, useRef, useState } from "react";

import { loadLibrary, type WhiteboardAsset } from "@/lib/tubeforge/whiteboard/assets";
import { composeScene, framePayload, APPLY_FRAME_FN } from "@/lib/tubeforge/whiteboard/wb-page";
import {
  buildGeometry,
  cameraAt,
  frameAt,
  frameCount,
  sceneDurationMs,
} from "@/lib/tubeforge/whiteboard/timing";
// W2 — the semantic beat compiler: the preview schedules through the same
// beatSceneEvents the renderer runs (the one-source law — preview ≡ final).
import { beatSceneEvents } from "@/lib/tubeforge/whiteboard/beat-plan";
import type { Placement } from "@/lib/tubeforge/whiteboard/svg";
import type { WhiteboardProject } from "@/lib/tubeforge/whiteboard/storyboard";

export interface WbEditing {
  selectedAssetId: string | null;
  /** Live-drag reporter (the studio mirrors it into its edit buffer). */
  onPlacementDrag: (assetId: string, placement: Placement) => void;
  /** Commit on pointer-up (the studio writes it into the project). */
  onPlacementCommit: (assetId: string, placement: Placement) => void;
  onSelect: (assetId: string | null) => void;
}

export interface WbCanvasProps {
  project: WhiteboardProject;
  sceneIndex: number;
  playing: boolean;
  /** Imperative scrub: a fresh nonce applies the tMs immediately. */
  seek: { tMs: number; nonce: number } | null;
  /** Throttled (~10 Hz) time reporter for the studio's slider. */
  onTime: (tMs: number) => void;
  onEnded: () => void;
  /** S68 — measured narration durations (scene id → ms) from the GET route;
   *  present ⇒ the canvas times the scene exactly like the render will. */
  voMs?: Record<string, number>;
  /** S68 Phase B — editing state (absent ⇒ pure playback, pointer-blind). */
  editing?: WbEditing;
  /** S69 Phase C — the video's UPLOADED assets (the GET route's wire
   *  payload): merged into the runtime library through the same
   *  loadLibrary(uploads) the server validates against — the canvas and
   *  the renderer agree on the asset universe by construction. */
  uploadedAssets?: WhiteboardAsset[];
}

/** The per-scene draw schedule + geometry — built once per scene change. */
function sceneRuntime(
  project: WhiteboardProject,
  sceneIndex: number,
  voMs: Record<string, number> | undefined,
  uploadedAssets: WhiteboardAsset[] | undefined
) {
  const lib = loadLibrary(uploadedAssets ?? []);
  const geometry = buildGeometry(
    [...lib.extracted.entries()].map(([id, ex]) => ({ id, paths: ex.paths }))
  );
  const scene = project.scenes[sceneIndex];
  // S68 — the editor rides the MEASURED VO when one exists (the GET route's
  // voMs), else the narration estimate: the same precedence
  // (explicit > VO-measured > estimate) the render's sceneDurationMs applies.
  const durationMs = sceneDurationMs(scene, voMs?.[scene.id] ?? null);
  // W2 — the matcher's vocabulary (the same build the renderer makes): the
  // beat plan is a pure function of (scene, duration, geometry, tags), so
  // the preview and the final render agree frame-for-frame.
  const assetTags = new Map<string, string[]>(
    [...lib.assets.values()].map((a) => [a.id, a.tags])
  );
  return { lib, geometry, scene, durationMs, events: beatSceneEvents(scene, durationMs, geometry, assetTags) };
}

/** Placement bbox corners in SCENE space: R(rot)·s·(u,v) + (x,y) over the
 *  asset's viewBox corners. The overlay outline and the hit-test share it. */
function placementCorners(
  assetW: number,
  assetH: number,
  pl: Placement
): { x: number; y: number }[] {
  const r = (pl.rotateDeg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return (
    [
      { u: 0, v: 0 },
      { u: assetW, v: 0 },
      { u: assetW, v: assetH },
      { u: 0, v: assetH },
    ] as const
  ).map(({ u, v }) => ({
    x: pl.x + (u * cos - v * sin) * pl.scale,
    y: pl.y + (u * sin + v * cos) * pl.scale,
  }));
}

/** Ray-cast point-in-polygon (scene space). */
function pointInPoly(p: { x: number; y: number }, poly: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const intersect =
      yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export default function WbCanvas({
  project,
  sceneIndex,
  playing,
  seek,
  onTime,
  onEnded,
  voMs,
  editing,
  uploadedAssets,
}: WbCanvasProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<SVGSVGElement>(null);
  const runtimeRef = useRef<ReturnType<typeof sceneRuntime> | null>(null);
  const tRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const lastReportRef = useRef(0);
  const setupRef = useRef<(() => void) | null>(null);
  const applyFrameRef = useRef<((tMs: number) => void) | null>(null);
  const cbRef = useRef({ onTime, onEnded });
  const lastDragRef = useRef(new Map<string, Placement>());

  // The fit scale: state drives the render (transform + overlay viewBox);
  // the ref mirrors it for EVENT-TIME math (the pointer handlers must never
  // read a stale closure — they read the ref).
  const [scaleK, setScaleK] = useState(1);
  const scaleKRef = useRef(1);

  useEffect(() => {
    // The latest-callback ref — assigned in an effect, never during render
    // (React's ref rules; the loop reads it at frame time).
    cbRef.current = { onTime, onEnded };
  }, [onTime, onEnded]);

  // The fit-to-dialog scale: container width / project width. The iframe
  // itself stays at the project's real pixel size (the renderer's layout).
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => {
      const k = wrap.clientWidth / project.width;
      const clamped = Number.isFinite(k) && k > 0 ? k : 1;
      scaleKRef.current = clamped;
      setScaleK(clamped);
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [project.width]);

  // Rebuild the page when the scene changes; reset the clock. S68: an EDIT
  // commit changes `project` without changing the scene — rebuild the page
  // (fresh compose + schedule from the new doc) but KEEP the scrub position.
  const prevSceneRef = useRef(-1);
  useEffect(() => {
    const sceneChanged = prevSceneRef.current !== sceneIndex;
    prevSceneRef.current = sceneIndex;
    if (sceneChanged) tRef.current = 0;
    runtimeRef.current = null; // rebuilt lazily below, after setContent
    const iframe = iframeRef.current;
    if (!iframe) return;
    const rt = (runtimeRef.current ??= sceneRuntime(project, sceneIndex, voMs, uploadedAssets));
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
      // First frame paints immediately (at the preserved scrub position).
      applyFrame(tRef.current);
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
  }, [project, sceneIndex, voMs, uploadedAssets]);

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

  // ---- S68 Phase B — the editing overlay --------------------------------
  // Scene-space ↔ wrapper-pixel through the SAME transform the applier
  // applies to the camera group: q = s·p + (W/2 − s·cx, H/2 − s·cy), then
  // the CSS scale k. cameraAt includes the deterministic drift, so the
  // overlay tracks the ink exactly at the scrub position. The geom closure
  // is refreshed into a ref every render; pointer handlers read the ref
  // (never a stale render's closure).
  type Geom = {
    rt: ReturnType<typeof sceneRuntime>;
    s: number;
    toPx: (p: { x: number; y: number }) => { x: number; y: number };
    fromPx: (px: number, py: number) => { x: number; y: number };
  };
  const geomRef = useRef<(() => Geom | null) | null>(null);
  const computeGeom = useCallback((): Geom | null => {
    const rt = runtimeRef.current;
    const k = scaleKRef.current;
    if (!rt || !k) return null;
    const cam = cameraAt(rt.scene, project.width, project.height, tRef.current);
    const s = cam.scale;
    const tx = project.width / 2 - cam.cx * s;
    const ty = project.height / 2 - cam.cy * s;
    const toPx = (p: { x: number; y: number }) => ({
      x: (p.x * s + tx) * k,
      y: (p.y * s + ty) * k,
    });
    const fromPx = (px: number, py: number) => ({
      x: (px / k - tx) / s,
      y: (py / k - ty) / s,
    });
    return { rt, s, toPx, fromPx };
  }, [project.width, project.height]);
  // The pointer handlers + overlay read THIS ref — refreshed after every
  // render so event-time math never sees a stale closure.
  useEffect(() => {
    geomRef.current = computeGeom;
  }, [computeGeom]);

  const drawOverlay = useCallback(() => {
    const svg = overlayRef.current;
    const geom = geomRef.current?.() ?? null;
    if (!svg) return;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (!editing || !geom) return;
    for (const pl of geom.rt.scene.placements) {
      const asset = geom.rt.lib.assets.get(pl.assetId);
      if (!asset) continue;
      // The live drag wins over the committed doc — the outline tracks the
      // pointer, not the last save.
      const live = lastDragRef.current.get(pl.assetId);
      const shown = live ?? pl.placement;
      const selected = pl.assetId === editing.selectedAssetId;
      const pts = placementCorners(asset.viewBox.w, asset.viewBox.h, shown)
        .map(geom.toPx)
        .map((p) => `${p.x},${p.y}`)
        .join(" ");
      const poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
      poly.setAttribute("points", pts);
      poly.setAttribute("fill", "none");
      poly.setAttribute("stroke", selected ? "#22d3ee" : "rgba(255,255,255,0.28)");
      poly.setAttribute("stroke-width", selected ? "2.5" : "1.5");
      poly.setAttribute("stroke-dasharray", selected ? "" : "6 4");
      svg.appendChild(poly);
    }
  }, [editing]);
  useEffect(() => {
    drawOverlay();
  }, [drawOverlay, project, sceneIndex, seek, scaleK, voMs]);

  // Pointer interactions (edit mode only): hit-test topmost, drag moves.
  useEffect(() => {
    const svg = overlayRef.current;
    if (!svg || !editing) return;
    let drag: { assetId: string; grabDX: number; grabDY: number; orig: Placement } | null = null;

    const localPoint = (e: PointerEvent) => {
      const rect = svg.getBoundingClientRect();
      return { px: e.clientX - rect.left, py: e.clientY - rect.top };
    };
    const hitTest = (px: number, py: number) => {
      const geom = geomRef.current?.() ?? null;
      if (!geom) return null;
      const p = geom.fromPx(px, py);
      // Topmost = LAST in the array (composeScene draws in array order).
      for (let i = geom.rt.scene.placements.length - 1; i >= 0; i--) {
        const pl = geom.rt.scene.placements[i];
        const asset = geom.rt.lib.assets.get(pl.assetId);
        if (!asset) continue;
        if (pointInPoly(p, placementCorners(asset.viewBox.w, asset.viewBox.h, pl.placement)))
          return pl;
      }
      return null;
    };

    const onPointerDown = (e: PointerEvent) => {
      const { px, py } = localPoint(e);
      const hit = hitTest(px, py);
      const geom = geomRef.current?.() ?? null;
      if (!hit || !geom) {
        editing.onSelect(null);
        return;
      }
      editing.onSelect(hit.assetId);
      const p = geom.fromPx(px, py);
      drag = {
        assetId: hit.assetId,
        grabDX: p.x - hit.placement.x,
        grabDY: p.y - hit.placement.y,
        orig: { ...hit.placement },
      };
      try {
        svg.setPointerCapture(e.pointerId);
      } catch {
        /* pointer already gone */
      }
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!drag) return;
      const geom = geomRef.current?.() ?? null;
      const iframe = iframeRef.current;
      if (!geom || !iframe) return;
      const { px, py } = localPoint(e);
      const p = geom.fromPx(px, py);
      const next: Placement = {
        x: Math.round(p.x - drag.grabDX),
        y: Math.round(p.y - drag.grabDY),
        scale: drag.orig.scale,
        rotateDeg: drag.orig.rotateDeg,
      };
      // Live patch — the SAME attribute write the applier performs for
      // placements (wb-page APPLY_FRAME_FN's placements loop).
      const g = iframe.contentDocument?.getElementById(`g-${drag.assetId}`);
      if (g)
        g.setAttribute(
          "transform",
          `translate(${next.x} ${next.y}) rotate(${next.rotateDeg}) scale(${next.scale})`
        );
      lastDragRef.current.set(drag.assetId, next);
      editing.onPlacementDrag(drag.assetId, next);
      drawOverlay();
    };
    const onPointerUp = (e: PointerEvent) => {
      if (!drag) return;
      try {
        svg.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
      const last = lastDragRef.current.get(drag.assetId);
      if (last) editing.onPlacementCommit(drag.assetId, last);
      lastDragRef.current.delete(drag.assetId);
      drag = null;
    };
    svg.addEventListener("pointerdown", onPointerDown);
    svg.addEventListener("pointermove", onPointerMove);
    svg.addEventListener("pointerup", onPointerUp);
    svg.addEventListener("pointercancel", onPointerUp);
    return () => {
      svg.removeEventListener("pointerdown", onPointerDown);
      svg.removeEventListener("pointermove", onPointerMove);
      svg.removeEventListener("pointerup", onPointerUp);
      svg.removeEventListener("pointercancel", onPointerUp);
    };
    // The handlers read editing + drawOverlay through the closure — rebind
    // per identity change (the studio passes memoized objects/callbacks).
  }, [editing, drawOverlay]);

  return (
    <div
      ref={wrapRef}
      className="relative w-full overflow-hidden rounded-xl border border-white/10 bg-black/40"
      style={{ aspectRatio: `${project.width} / ${project.height}` }}
    >
      <div
        className="absolute left-0 top-0 origin-top-left"
        style={{
          width: project.width,
          height: project.height,
          transform: `scale(${scaleK})`,
        }}
      >
        <iframe
          ref={iframeRef}
          title="Whiteboard preview"
          sandbox="allow-same-origin allow-scripts"
          className="border-0"
          style={{ width: project.width, height: project.height }}
        />
      </div>
      {editing && (
        <svg
          ref={overlayRef}
          className="absolute inset-0 h-full w-full cursor-move touch-none"
          viewBox={`0 0 ${project.width * scaleK} ${project.height * scaleK}`}
        />
      )}
    </div>
  );
}
