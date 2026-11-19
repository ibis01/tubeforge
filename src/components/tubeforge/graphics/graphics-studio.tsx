"use client";

// S123 (G1) P4 — the Motion Graphics Studio (the whiteboard-studio mirror,
// scaled to the graphics v1 surface): scaffold from the story (native rule
// table or the metered LLM pass), scrub + play the WHOLE DOC through the
// frame-truth seam (graphics-canvas.tsx — one applier, two callers), edit
// the scene-level doc fields (narration, explicit duration, background,
// text payloads) through the validated PUT, and render — labelled drafts
// at a viewport scale or the full render through the engine lane.
//
// The doc clock IS the timeline — S152: the clock HOLDS the narration. The
// studio surfaces the measured VO (voMs) as CLOCK truth — an unplanned
// scene extends to its narration + tail (the render law), so the transport
// and the scene labels read the delivered windows; only an EXPLICIT
// durationMs owns the boundary, and a VO that overruns it is flagged
// honestly instead of silently re-cutting the doc.
//
// S124 — the element editor (the Layout mode): select/drag/scale/z-order
// on the closed grammar, laws in docs/design/s124-graphics-element-editor
// .md. The studio owns selection and the working buffer; the canvas
// reports hits and committed gestures; every commit rides the validated
// PUT (no client-side validation fork, no second doc writer). The pure
// laws live in graphics/editor.ts (hit-test, placement math, the slots
// -law z-order) and are unit-pinned there.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import GraphicsCanvas from "./graphics-canvas";
import { graphicsGroupClaims } from "@/lib/tubeforge/graphics/compose";
import { GRAPHICS_VO_TAIL_MS } from "@/lib/tubeforge/graphics/frame";
import {
  applyZOrder,
  ELEMENT_EDITOR_LIMITS,
  type ZOrderAction,
} from "@/lib/tubeforge/graphics/editor";
import type { Placement } from "@/lib/tubeforge/whiteboard/svg";
import type { GraphicsDoc, GraphicsElement, GraphicsElementKind, GraphicsScene } from "@/lib/tubeforge/graphics/types";
import { GraphicsMotionPanel, defaultElementFor } from "@/components/tubeforge/graphics/motion-panel";

interface GraphicsBudgetReport {
  fps: 24 | 30;
  frames: number;
  totalMs: number;
  wall: number;
  capSec: number;
  ok: boolean;
  refusal: string | null;
}

interface GraphicsQcRow {
  id: string;
  label: string;
  status: "pass" | "fail" | "unmeasured";
  value: string;
  detail?: string;
}

interface GraphicsGetResponse {
  doc: GraphicsDoc | null;
  voMs: Record<string, number>;
  preflight: GraphicsBudgetReport | null;
  qc: { passed: boolean; rows: GraphicsQcRow[] } | null;
  budgets: Record<string, unknown>;
}

export interface GraphicsStudioProps {
  videoId: string;
  /** The video row's hasVideo — lets the surface show the standing render. */
  hasVideo: boolean;
  /** Called after an accepted render enqueue so the dialog refreshes the DTO. */
  onRenderQueued: () => void;
}

const btn =
  "rounded-lg px-3 py-1.5 text-xs font-medium disabled:opacity-50";
const btnSolid = `${btn} bg-white text-black hover:bg-white/85`;
const btnGhost = `${btn} bg-white/10 hover:bg-white/20`;
const btnFaint = `${btn} bg-white/5 text-white/60 hover:bg-white/10`;
const inputCls =
  "rounded-md border border-white/15 bg-black/30 px-1.5 py-0.5 text-xs text-white";

const SURFACES: Array<{ id: string; label: string; w: number; h: number }> = [
  { id: "16:9", label: "16:9 · 1920×1080", w: 1920, h: 1080 },
  { id: "9:16", label: "9:16 · 1080×1920", w: 1080, h: 1920 },
  { id: "1:1", label: "1:1 · 1080×1080", w: 1080, h: 1080 },
];

const DRAFT_SCALES = [0.5, 0.75, 1.0] as const;

const fmtSec = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

/** One numeric placement field (S124) — a local draft committed on
 *  blur/Enter; the `key` rides the external value so a committed edit (or
 *  another buffer change) resets the draft without an effect (the house
 *  set-state-in-effect law). Non-finite input resets honestly; the caller
 *  owns any band clamps. */
function PlacementNumber({ label, value, min, max, step, onCommit }: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const commit = (): void => {
    const v = Number(draft);
    if (!Number.isFinite(v)) {
      setDraft(String(value));
      return;
    }
    const clamped = Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min ?? Number.NEGATIVE_INFINITY, v));
    if (clamped !== value) onCommit(clamped);
    setDraft(String(clamped));
  };
  return (
    <label className="flex items-center gap-1">
      <span className="text-white/50">{label}</span>
      <input
        type="number"
        className={inputCls}
        value={draft}
        min={min}
        max={max}
        step={step}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit();
            (e.target as HTMLInputElement).blur();
          }
        }}
        aria-label={`${label} placement`}
      />
    </label>
  );
}

export default function GraphicsStudio({ videoId, hasVideo, onRenderQueued }: GraphicsStudioProps) {
  const [data, setData] = useState<GraphicsGetResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [aiPlanner, setAiPlanner] = useState(false);
  const [surface, setSurface] = useState(SURFACES[0].id);
  const [fps, setFps] = useState<24 | 30>(24);

  // The doc-under-edit (the studio's working buffer) + the dirty flag.
  const [buffer, setBuffer] = useState<GraphicsDoc | null>(null);
  const [dirty, setDirty] = useState(false);

  // Playback state (whole-doc clock).
  const [playing, setPlaying] = useState(false);
  const [tMs, setTMs] = useState(0);
  const [seek, setSeek] = useState<{ tMs: number; nonce: number } | null>(null);
  const seekNonce = useRef(0);

  // Draft controls.
  const [scale, setScale] = useState<(typeof DRAFT_SCALES)[number]>(0.5);

  // S124 — the element editor: the Layout mode (the geometry editing
  // state) + the selection (the studio owns selection; the canvas reports
  // hits and committed gestures; the PUT is the wall).
  const [layoutMode, setLayoutMode] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // S126 — the import lane's preview seam: the doc's sprite bytes resolve
  // through the SAME store seam the render job runs (one resolution, both
  // callers); a missing key surfaces as the honest warning strip.
  const [spriteAssets, setSpriteAssets] = useState<Map<string, string[]> | null>(null);
  const [missingImports, setMissingImports] = useState<string[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/videos/${videoId}/graphics`, { cache: "no-store" });
      const body = (await res.json()) as GraphicsGetResponse & { error?: string };
      if (!res.ok) {
        setError(body.error ?? "Failed to load the graphics doc");
        setData(null);
        setBuffer(null);
      } else {
        setData(body);
        setBuffer(body.doc);
        setDirty(false);
        setTMs(0);
        setPlaying(false);
        setSelectedId(null); // a fresh doc ends the selection (S124)
        if (body.doc) {
          const s = SURFACES.find((x) => x.w === body.doc?.width && x.h === body.doc?.height);
          if (s) setSurface(s.id);
          setFps(body.doc.fps);
        }
        // S126 — resolve the imports when the doc references sprites (the
        // one-seam law; spriteless docs pay nothing).
        const hasSprites = body.doc?.scenes.some((s) => s.elements.some((el) => el.kind === "sprite")) ?? false;
        if (hasSprites) {
          try {
            const rres = await fetch(`/api/videos/${videoId}/graphics/import?resolve=1`, { cache: "no-store" });
            if (rres.ok) {
              const rbody = (await rres.json()) as { assets?: Record<string, string[]>; missing?: string[] };
              setSpriteAssets(new Map(Object.entries(rbody.assets ?? {})));
              setMissingImports(rbody.missing ?? []);
            }
          } catch {
            setMissingImports(["the import manifest failed to load"]);
          }
        } else {
          setSpriteAssets(null);
          setMissingImports([]);
        }
      }
    } catch {
      setError("Failed to load the graphics doc");
    } finally {
      setLoading(false);
    }
  }, [videoId]);

  useEffect(() => {
    // Deferred so lint's set-state-in-effect rule is satisfied (the house
    // pattern, pwa.tsx + whiteboard-studio): the fetch's first setState
    // leaves the effect's synchronous stack.
    queueMicrotask(() => void load());
  }, [load]);

  // S152 — the delivered clock mirror (the doc rule: explicit > measured
  // VO + tail > estimate — frame.ts's precedence, mirrored for the
  // transport labels; the canvas plays the SAME map through the SAME
  // pure rule, so the editor and the engine agree on every window).
  const voMsMap = useMemo(
    () => new Map(Object.entries(data?.voMs ?? {})),
    [data]
  );
  const sceneMs = useMemo(
    () =>
      buffer
        ? buffer.scenes.map((s) => {
            if (s.durationMs !== undefined && s.durationMs > 0) return s.durationMs;
            const vo = voMsMap.get(s.id);
            if (vo !== undefined && vo > 0) return Math.round(vo + GRAPHICS_VO_TAIL_MS);
            return estimateMs(s);
          })
        : [],
    [buffer, voMsMap]
  );
  const totalMs = useMemo(() => sceneMs.reduce((a, b) => a + b, 0), [sceneMs]);

  // The client-side estimate floor (the doc rule's last rung) — the same
  // arithmetic frame.ts applies, for the transport labels only.
  function estimateMs(scene: GraphicsScene): number {
    // 2.6 words-per-second house clock (timing.ts estimateNarrationMs) —
    // mirrored here as a display-only lower bound; the doc/explicit truth
    // always wins on the server.
    const words = scene.narration.trim().split(/\s+/).filter(Boolean).length;
    return Math.max(4000, Math.min(30_000, Math.round((words / 2.6) * 1000)));
  }

  const seekTo = useCallback((ms: number) => {
    seekNonce.current += 1;
    setSeek({ tMs: ms, nonce: seekNonce.current });
    setTMs(ms);
  }, []);

  const scaffold = async (force: boolean): Promise<void> => {
    setBusy("scaffold");
    setError(null);
    setNotice(null);
    try {
      const s = SURFACES.find((x) => x.id === surface);
      const res = await fetch(`/api/videos/${videoId}/graphics/scaffold`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          force,
          planner: aiPlanner ? "llm" : "native",
          width: s?.w,
          height: s?.h,
          fps,
        }),
      });
      const body = (await res.json()) as { error?: string; planner?: string; plannerReport?: { planner: string; degraded?: boolean; degradeReason?: string } };
      if (!res.ok) {
        setError(body.error ?? "Scaffold failed");
        return;
      }
      setNotice(
        body.planner === "llm"
          ? "The LLM planner served the doc (per-element degradation policed it against the closed grammar)"
          : "Scaffolded from the story with the native rule table ($0, deterministic)"
      );
      await load();
    } catch {
      setError("Scaffold failed");
    } finally {
      setBusy(null);
    }
  };

  const save = async (): Promise<void> => {
    if (!buffer) return;
    setBusy("save");
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/videos/${videoId}/graphics`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doc: buffer }),
      });
      const body = (await res.json()) as { doc?: GraphicsDoc; errors?: string[]; warnings?: string[]; error?: string };
      if (!res.ok) {
        setError(body.errors?.join(" · ") ?? body.error ?? "Save failed");
        return;
      }
      setBuffer(body.doc ?? buffer);
      setDirty(false);
      setNotice(
        body.warnings && body.warnings.length > 0
          ? `Saved — the validator dropped/clamped: ${body.warnings.slice(0, 3).join(" · ")}`
          : "Saved — the doc round-trips the strict write byte-stable"
      );
      await load();
    } catch {
      setError("Save failed");
    } finally {
      setBusy(null);
    }
  };

  const render = async (opts: { sceneId?: string; draft?: boolean }): Promise<void> => {
    setBusy(opts.draft ? (opts.sceneId ? `draft:${opts.sceneId}` : "draft") : "render");
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/videos/${videoId}/graphics/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scale, ...opts }),
      });
      const body = (await res.json()) as { accepted?: boolean; scope?: string; error?: string };
      if (!res.ok) {
        setError(body.error ?? "Render refused");
        return;
      }
      setNotice(
        opts.draft
          ? `Draft render queued @ ${scale}× — a labelled look: non-reviewable, no review credit`
          : "Full render queued — the engine lane renders natively at $0"
      );
      onRenderQueued();
    } catch {
      setError("Render failed");
    } finally {
      setBusy(null);
    }
  };

  // The scene-level editors mutate the working buffer.
  const patchScene = (index: number, patch: Partial<GraphicsScene>): void => {
    setBuffer((b) => {
      if (!b) return b;
      const scenes = b.scenes.map((s, i) => (i === index ? { ...s, ...patch } : s));
      return { ...b, scenes };
    });
    setDirty(true);
  };

  const patchTextElement = (sceneIndex: number, elId: string, text: string): void => {
    setBuffer((b) => {
      if (!b) return b;
      const scenes = b.scenes.map((s, i) => {
        if (i !== sceneIndex) return s;
        return {
          ...s,
          elements: s.elements.map((el) => {
            if (el.id !== elId || el.text === undefined) return el;
            // The text payload keeps its closed shape (align stays the
            // validator's union) — only the text field moves.
            return { ...el, text: { ...el.text, text } } as typeof el;
          }),
        };
      });
      return { ...b, scenes };
    });
    setDirty(true);
  };

  // S124 — the Layout mode (the geometry editing state, friction's
  // boxTransform mode restated): forces pause, syncs the canvas clock to
  // the studio's playhead (the scene resolution rides it), clean
  // selection. Exiting just flips back — playback resumes from the clock.
  const toggleLayout = (): void => {
    if (!layoutMode) {
      setPlaying(false);
      seekTo(tMs);
      setSelectedId(null);
    }
    setLayoutMode(!layoutMode);
  };

  // A committed gesture — the working buffer patch (the validated PUT is
  // the wall; nothing on the client writes a doc directly).
  const commitPlacement = useCallback((sceneIndex: number, elId: string, at: Placement): void => {
    setBuffer((b) => {
      if (!b) return b;
      const scenes = b.scenes.map((s, i) => {
        if (i !== sceneIndex) return s;
        return { ...s, elements: s.elements.map((el) => (el.id === elId ? { ...el, at } : el)) };
      });
      return { ...b, scenes };
    });
    setDirty(true);
  }, []);

  // The z-order actions — the PURE law applies (applyZOrder refuses
  // claimed members and unknown ids); the panel disables proactively, so
  // a refusal here is belt-and-braces (a silent no-op is honest — the
  // law's error belongs to the unit suite).
  const commitZOrder = (sceneIndex: number, elId: string, action: ZOrderAction): void => {
    setBuffer((b) => {
      if (!b) return b;
      const scenes = b.scenes.map((s, i) => {
        if (i !== sceneIndex) return s;
        const r = applyZOrder(s, elId, action);
        return r.ok ? { ...s, elements: r.elements } : s;
      });
      return { ...b, scenes };
    });
    setDirty(true);
  };

  // B4-2 — motion authoring: the SAME buffer → validated PUT path (no second
  // doc writer). The motion panel is a friendly writer over the closed
  // grammar; the validator stays the wall (time-sanity, kind compatibility,
  // camera bounds are its job, not the UI's).
  const patchElement = useCallback((sceneIndex: number, elId: string, fn: (el: GraphicsElement) => GraphicsElement): void => {
    setBuffer((b) => {
      if (!b) return b;
      const scenes = b.scenes.map((s, i) =>
        i !== sceneIndex ? s : { ...s, elements: s.elements.map((el) => (el.id === elId ? fn(el) : el)) }
      );
      return { ...b, scenes };
    });
    setDirty(true);
  }, []);

  const patchSceneDoc = useCallback((sceneIndex: number, fn: (s: GraphicsScene) => GraphicsScene): void => {
    setBuffer((b) => {
      if (!b) return b;
      const scenes = b.scenes.map((s, i) => (i !== sceneIndex ? s : fn(s)));
      return { ...b, scenes };
    });
    setDirty(true);
  }, []);

  const insertElement = useCallback((sceneIndex: number, kind: GraphicsElementKind): void => {
    setBuffer((b) => {
      if (!b) return b;
      const scenes = b.scenes.map((s, i) => {
        if (i !== sceneIndex) return s;
        let n = s.elements.length + 1;
        let id = `el-${n}`;
        while (s.elements.some((e) => e.id === id)) id = `el-${++n}`;
        const el = defaultElementFor(kind, id, b.width, b.height, s.elements.length);
        return { ...s, elements: [...s.elements, el] };
      });
      return { ...b, scenes };
    });
    setDirty(true);
  }, []);

  if (loading) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/3 p-6 text-sm text-white/60">
        Loading the graphics doc…
      </div>
    );
  }

  if (error && !buffer) {
    return (
      <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-300">
        {error}
        <button className={`${btnGhost} ml-3`} onClick={() => void load()}>Retry</button>
      </div>
    );
  }

  // ---- no doc yet: the scaffold card ----
  if (!buffer) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/3 p-5 space-y-4">
        <div>
          <h3 className="text-sm font-semibold">Motion graphics</h3>
          <p className="mt-1 text-xs text-white/60">
            Scaffold a declarative graphics doc from the story scenes — kinetic headlines, counters, bar charts, icons and shapes on the closed v1 grammar. The engine renders natively at $0 (no image generation).
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <label className="flex items-center gap-1.5">
            Surface
            <select className={inputCls} value={surface} onChange={(e) => setSurface(e.target.value)}>
              {SURFACES.map((s) => (
                <option key={s.id} value={s.id} className="bg-black">{s.label}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            fps
            <select
              className={inputCls}
              value={String(fps)}
              onChange={(e) => setFps(e.target.value === "30" ? 30 : 24)}
            >
              <option value="24" className="bg-black">24</option>
              <option value="30" className="bg-black">30</option>
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={aiPlanner}
              onChange={(e) => setAiPlanner(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            LLM planner (metered; degrades to the native table on failure)
          </label>
        </div>
        {error && <p className="text-xs text-red-300">{error}</p>}
        <button className={btnSolid} disabled={busy !== null} onClick={() => void scaffold(false)}>
          {busy === "scaffold" ? "Scaffolding…" : "Scaffold graphics doc"}
        </button>
      </div>
    );
  }

  // ---- the doc surface ----
  const preflight = data?.preflight ?? null;
  const qcRows = data?.qc?.rows ?? [];
  const activeSceneIndex = sceneMs.length > 0
    ? (() => {
        let cursor = 0;
        for (let i = 0; i < sceneMs.length; i++) {
          cursor += sceneMs[i];
          if (tMs < cursor) return i;
        }
        return sceneMs.length - 1;
      })()
    : 0;

  return (
    <div className="space-y-4">
      {/* Transport + canvas */}
      <GraphicsCanvas
        doc={buffer}
        playing={playing}
        seek={seek}
        onTime={setTMs}
        onEnded={() => setPlaying(false)}
        editable={layoutMode}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onPlacement={commitPlacement}
        spriteAssets={spriteAssets ?? undefined}
        voMsBySceneId={data?.voMs}
      />
      {missingImports.length > 0 && (
        <p className="text-[11px] text-amber-300 bg-amber-500/10 border border-amber-400/25 rounded-lg px-3 py-2">
          Unresolved sprite imports: {missingImports.join(", ")} — upload them through the import lane or remove the sprites (the render refuses on them).
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button className={btnGhost} onClick={() => { seekTo(0); setPlaying(false); }}>
          ⏮
        </button>
        <button className={btnSolid} disabled={layoutMode} onClick={() => setPlaying((p) => !p)}>
          {playing ? "Pause" : "Play"}
        </button>
        <button
          className={layoutMode ? btnSolid : btnGhost}
          onClick={toggleLayout}
          title="Edit element geometry — drag moves, the white handle scales, the strip reorders"
        >
          {layoutMode ? "Layout: on" : "Layout"}
        </button>
        <input
          type="range"
          min={0}
          max={Math.max(1, totalMs)}
          value={Math.min(tMs, totalMs)}
          onChange={(e) => { setPlaying(false); seekTo(Number(e.target.value)); }}
          className="h-1 min-w-[180px] flex-1 cursor-pointer appearance-none rounded bg-white/20 accent-white"
          aria-label="Timeline scrub"
        />
        <span className="text-xs tabular-nums text-white/70">
          {(tMs / 1000).toFixed(1)}s / {(totalMs / 1000).toFixed(1)}s
        </span>
        <span className="text-[10px] text-white/40">
          scene {activeSceneIndex + 1}/{buffer.scenes.length} · {buffer.width}×{buffer.height} @ {buffer.fps}fps
        </span>
      </div>

      {/* S124 — the element strip (Layout mode): doc order (the last row
          paints on top), the four z-order actions, exact placement fields
          for the selection. Claimed members render read-only with their
          owning group — the claims map is the composer's ONE truth. */}
      {layoutMode && buffer.scenes[activeSceneIndex] && (() => {
        const scene = buffer.scenes[activeSceneIndex];
        const claims = graphicsGroupClaims(scene);
        const selected = selectedId ? scene.elements.find((el) => el.id === selectedId) : undefined;
        const selectedClaim = selectedId ? claims.get(selectedId) : undefined;
        return (
          <div className="rounded-lg border border-white/10 bg-white/3 p-3 text-xs" data-testid="graphics-element-strip">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-white/80">Elements · {scene.id}</span>
              <span className="text-white/40">
                doc order — the last row paints on top · drag on the canvas moves · the white handle scales
              </span>
            </div>
            <ul className="mt-2 space-y-1">
              {scene.elements
                .filter((el) => !claims.has(el.id))
                .map((el) => {
                  const isSel = el.id === selectedId;
                  return (
                    <li
                      key={el.id}
                      className={`flex flex-wrap items-center gap-2 rounded px-2 py-1 ${isSel ? "bg-white/10" : "hover:bg-white/5"}`}
                    >
                      <button
                        type="button"
                        className="font-medium text-white/85"
                        onClick={() => setSelectedId(el.id)}
                        aria-pressed={isSel}
                      >
                        {isSel ? "\u25B8 " : ""}{el.kind} · {el.id}
                      </button>
                      <span className="tabular-nums text-white/45">
                        x {Math.round(el.at.x)} · y {Math.round(el.at.y)} · scale {el.at.scale} · {el.at.rotateDeg}°
                      </span>
                      {el.kind === "group" && <span className="text-amber-300/80">group — children ride it</span>}
                      <span className="ml-auto flex flex-wrap items-center gap-1">
                        {(["top", "raise", "lower", "bottom"] as const).map((a) => (
                          <button
                            key={a}
                            className={btnFaint}
                            disabled={busy !== null}
                            onClick={() => commitZOrder(activeSceneIndex, el.id, a)}
                            aria-label={`${a} ${el.id}`}
                          >
                            {a === "top" ? "top" : a === "raise" ? "up" : a === "lower" ? "down" : "bottom"}
                          </button>
                        ))}
                      </span>
                    </li>
                  );
                })}
              {[...claims.entries()].map(([child, owner]) => (
                <li key={child} className="flex items-center gap-2 rounded px-2 py-1 text-white/40">
                  {child}
                  <span>· member of {owner} — its z-order lives inside the group</span>
                </li>
              ))}
            </ul>
            {selected && !selectedClaim && (
              <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-white/10 pt-2">
                <span className="text-white/50">placement · {selected.id}</span>
                <PlacementNumber
                  key={`x-${selected.id}-${selected.at.x}`}
                  label="x"
                  value={selected.at.x}
                  step={1}
                  onCommit={(v) => commitPlacement(activeSceneIndex, selected.id, { ...selected.at, x: v })}
                />
                <PlacementNumber
                  key={`y-${selected.id}-${selected.at.y}`}
                  label="y"
                  value={selected.at.y}
                  step={1}
                  onCommit={(v) => commitPlacement(activeSceneIndex, selected.id, { ...selected.at, y: v })}
                />
                <PlacementNumber
                  key={`s-${selected.id}-${selected.at.scale}`}
                  label="scale"
                  value={selected.at.scale}
                  min={ELEMENT_EDITOR_LIMITS.scaleMin}
                  max={ELEMENT_EDITOR_LIMITS.scaleMax}
                  step={0.05}
                  onCommit={(v) => commitPlacement(activeSceneIndex, selected.id, { ...selected.at, scale: v })}
                />
                <span className="text-white/40">rotate {selected.at.rotateDeg}° (display-only this slice)</span>
              </div>
            )}
            {selected && selectedClaim && (
              <p className="mt-2 text-amber-300/80">
                {selectedId} is a member of {selectedClaim} — geometry and z-order ride the group (read-only here).
              </p>
            )}

            {/* B4-2 — motion & easing authoring: insertion palette, the
                enter/exit/emphasis editor with the 15-curve ease dropdown,
                tween channels/keys, and the scene camera keys. Everything
                rides the same working buffer → validated PUT. */}
            <GraphicsMotionPanel
              scene={scene}
              selected={selected && !selectedClaim ? selected : undefined}
              disabled={busy !== null}
              onPatchElement={(elId, fn) => patchElement(activeSceneIndex, elId, fn)}
              onPatchScene={(fn) => patchSceneDoc(activeSceneIndex, fn)}
              onInsertElement={(kind) => insertElement(activeSceneIndex, kind)}
            />
          </div>
        );
      })()}

      {/* Evidence: the preflight wall + the QC matrix (what the render click will judge) */}
      {preflight && (
        <div className="rounded-lg border border-white/10 bg-white/3 p-3 text-xs">
          <span className={preflight.ok ? "text-emerald-300" : "text-red-300"}>
            {preflight.ok ? "✓" : "✗"} preflight wall
          </span>
          <span className="ml-2 text-white/60">
            {preflight.frames}/{preflight.wall} delivered frames @ {preflight.fps} fps — cap {preflight.capSec.toFixed(1)}s of scenes
          </span>
          {!preflight.ok && preflight.refusal && <p className="mt-1 text-red-300">{preflight.refusal}</p>}
        </div>
      )}
      {qcRows.length > 0 && (
        <details className="rounded-lg border border-white/10 bg-white/3 p-3 text-xs">
          <summary className="cursor-pointer text-white/70">
            G1 QC matrix — {qcRows.filter((r) => r.status === "pass").length}/{qcRows.length} rows pass
          </summary>
          <ul className="mt-2 space-y-1">
            {qcRows.map((r) => (
              <li key={r.id} className="flex gap-2">
                <span
                  className={
                    r.status === "pass" ? "text-emerald-300" : r.status === "fail" ? "text-red-300" : "text-amber-300"
                  }
                >
                  {r.status === "pass" ? "✓" : r.status === "fail" ? "✗" : "?"}
                </span>
                <span className="text-white/50">{r.id}</span>
                <span className="text-white/70">{r.label}</span>
                <span className="ml-auto text-white/40">{r.value}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* Scene editors */}
      <div className="space-y-2">
        {buffer.scenes.map((scene, i) => {
          const vo = data?.voMs[scene.id];
          const clockMs = sceneMs[i];
          const voOverrun = vo !== undefined && vo > clockMs + 120;
          return (
            <details key={scene.id} className="rounded-lg border border-white/10 bg-white/3 p-3" open={i === activeSceneIndex}>
              <summary className="cursor-pointer text-xs font-medium">
                <button
                  type="button"
                  className="mr-2 text-white/50 hover:text-white"
                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); setPlaying(false); seekTo(sceneMs.slice(0, i).reduce((a, b) => a + b, 0)); }}
                >
                  ▸
                </button>
                {scene.id}
                <span className="ml-2 font-normal text-white/50">
                  {fmtSec(clockMs)} · {scene.elements.length} element{scene.elements.length === 1 ? "" : "s"}
                  {vo !== undefined ? ` · VO ${fmtSec(vo)}` : ""}
                  {voOverrun && scene.durationMs !== undefined && scene.durationMs > 0
                    ? " · VO overruns the explicit duration (the render cuts at the boundary — your explicit cut wins)"
                    : ""}
                </span>
              </summary>
              <div className="mt-2 space-y-2 text-xs">
                <label className="block">
                  <span className="text-white/50">Narration (the clock&apos;s estimate input)</span>
                  <textarea
                    className={`${inputCls} mt-1 w-full`}
                    rows={2}
                    value={scene.narration}
                    onChange={(e) => patchScene(i, { narration: e.target.value })}
                  />
                </label>
                <div className="flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={scene.durationMs !== undefined}
                      onChange={(e) => patchScene(i, { durationMs: e.target.checked ? estimateMs(scene) : undefined })}
                    />
                    <span className="text-white/50">explicit duration</span>
                  </label>
                  {scene.durationMs !== undefined && (
                    <label className="flex items-center gap-1.5">
                      ms
                      <input
                        type="number"
                        className={inputCls}
                        min={4000}
                        max={120000}
                        step={100}
                        value={scene.durationMs}
                        onChange={(e) => patchScene(i, { durationMs: Math.max(4000, Math.min(120000, Number(e.target.value) || 4000)) })}
                      />
                    </label>
                  )}
                  <label className="flex items-center gap-1.5">
                    background
                    <input
                      type="text"
                      className={inputCls}
                      value={scene.background}
                      onChange={(e) => patchScene(i, { background: e.target.value })}
                    />
                  </label>
                </div>
                {scene.elements
                  .filter((el) => el.kind === "headline" || el.kind === "subhead" || el.kind === "bullet" || el.kind === "callout")
                  .map((el) => (
                    <label key={el.id} className="block">
                      <span className="text-white/50">{el.kind} · {el.id}</span>
                      <input
                        type="text"
                        className={`${inputCls} mt-1 w-full`}
                        value={(el.text as { text: string } | undefined)?.text ?? ""}
                        onChange={(e) => patchTextElement(i, el.id, e.target.value)}
                      />
                    </label>
                  ))}
              </div>
            </details>
          );
        })}
      </div>

      {/* Save + render controls */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-white/10 bg-white/3 p-3">
        <button className={dirty ? btnSolid : btnFaint} disabled={!dirty || busy !== null} onClick={() => void save()}>
          {busy === "save" ? "Saving…" : dirty ? "Save doc" : "Saved"}
        </button>
        <span className="text-white/30">|</span>
        <label className="flex items-center gap-1.5 text-xs text-white/60">
          draft scale
          <select
            className={inputCls}
            value={String(scale)}
            onChange={(e) => setScale(e.target.value === "0.5" ? 0.5 : e.target.value === "0.75" ? 0.75 : 1.0)}
          >
            {DRAFT_SCALES.map((s) => (
              <option key={s} value={String(s)} className="bg-black">{s}×</option>
            ))}
          </select>
        </label>
        <button className={btnGhost} disabled={busy !== null} onClick={() => void render({ draft: true })}>
          {busy === "draft" ? "Rendering…" : `Draft look (${scale}×)`}
        </button>
        {buffer.scenes.map((s) => (
          <button
            key={s.id}
            className={btnFaint}
            disabled={busy !== null}
            onClick={() => void render({ sceneId: s.id })}
          >
            {busy === `draft:${s.id}` ? "…" : `draft ${s.id}`}
          </button>
        ))}
        <span className="text-white/30">|</span>
        <button
          className={btnSolid}
          disabled={busy !== null || (preflight ? !preflight.ok : false)}
          onClick={() => void render({})}
          title={preflight && !preflight.ok ? preflight.refusal ?? "the doc exceeds the budget wall" : undefined}
        >
          {busy === "render" ? "Rendering…" : "Render full video"}
        </button>
        {hasVideo && <span className="text-xs text-white/40">a standing final exists — a doc edit or re-render stales it</span>}
        <button
          className={btnFaint}
          disabled={busy !== null}
          onClick={() => {
            if (confirm("Regenerate the graphics doc from the story? The current doc is discarded."))
              void scaffold(true);
          }}
        >
          Re-scaffold
        </button>
      </div>

      {notice && <p className="text-xs text-emerald-300">{notice}</p>}
      {error && <p className="text-xs text-red-300">{error}</p>}
    </div>
  );
}
