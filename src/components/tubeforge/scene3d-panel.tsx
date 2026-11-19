"use client";

// B4-3 — the Scene3D editor panel (Creative Workspace Enhancement).
//
// The 3D lane was API-only (audit §B3): POST scaffolded + rendered, the doc
// and clip answered GET, and no product surface touched either. This card
// closes that gap over the EXISTING seams — no engine rewrite, no second
// writer:
//   GET  /api/videos/[id]/scene3d          → { generating, error, doc, hasClip }
//   POST /api/videos/[id]/scene3d          → deterministic scaffold + render
//   PUT  /api/videos/[id]/scene3d          → the validated save (B4 route)
//   GET  /api/videos/[id]/scene3d?clip=1   → the rendered MP4 stream
// The working copy is a local Scene3D; save rides the PUT whose parse law
// (parseScene3D) is the same tolerant read the renderer consumes — what the
// creator edits is what renders.

import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Loader2, Play, RefreshCw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Scene3D } from "@/lib/tubeforge/scene3d";

interface Scene3DState {
  generating: boolean;
  error: string | null;
  doc: Scene3D | null;
  hasClip: boolean;
}

/** Numeric field with blur/Enter commit and optional clamp — the draft
 *  pattern (no sync effect): local text only while editing, the prop value
 *  shows otherwise. */
function Num({
  label,
  value,
  min,
  max,
  step = 1,
  onCommit,
  width = "w-16",
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onCommit: (v: number) => void;
  width?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(value);
  const commit = () => {
    if (draft === null) return;
    const v = Number(draft);
    setDraft(null);
    if (!Number.isFinite(v)) return;
    let out = v;
    if (min !== undefined) out = Math.max(min, out);
    if (max !== undefined) out = Math.min(max, out);
    onCommit(out);
  };
  return (
    <label className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
      {label}
      <input
        type="number"
        value={shown}
        min={min}
        max={max}
        step={step}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className={`${width} h-7 rounded-md border border-white/10 bg-white/5 px-1.5 text-xs tabular-nums text-white/85`}
        aria-label={label}
      />
    </label>
  );
}

/** Three-axis vector of Num fields. */
function Vec({
  label,
  value,
  step,
  onCommit,
}: {
  label: string;
  value: [number, number, number];
  step?: number;
  onCommit: (v: [number, number, number]) => void;
}) {
  const axes = ["x", "y", "z"] as const;
  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      {axes.map((a, i) => (
        <Num
          key={a}
          label={a}
          value={value[i]}
          step={step}
          width="w-14"
          onCommit={(v) => {
            const next = [...value] as [number, number, number];
            next[i] = v;
            onCommit(next);
          }}
        />
      ))}
    </span>
  );
}

function Color({ label, value, onCommit }: { label: string; value: string; onCommit: (v: string) => void }) {
  return (
    <label className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
      {label}
      <input
        type="color"
        value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : "#111827"}
        onChange={(e) => onCommit(e.target.value)}
        className="h-7 w-8 cursor-pointer rounded-md border border-white/10 bg-white/5"
        aria-label={label}
      />
    </label>
  );
}

export function Scene3DPanel({ videoId, onChanged }: { videoId: string; onChanged?: () => void }) {
  const [state, setState] = useState<Scene3DState | null>(null);
  const [doc, setDoc] = useState<Scene3D | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<"scaffold" | "save" | "rerender" | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [clipStamp, setClipStamp] = useState(0);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(`/api/videos/${videoId}/scene3d`, { cache: "no-store" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? "Failed to load the 3D scene");
      const data = (await res.json()) as Scene3DState;
      if (!aliveRef.current) return;
      setState(data);
      setDoc(data.doc);
    } catch (e) {
      if (!aliveRef.current) return;
      setState({ generating: false, error: e instanceof Error ? e.message : String(e), doc: null, hasClip: false });
    }
  }, [videoId]);

  useEffect(() => {
    // Deferred so lint's set-state-in-effect rule is satisfied (the house
    // pattern, graphics-studio + whiteboard-studio): the fetch's first
    // setState leaves the effect's synchronous stack.
    queueMicrotask(() => void load());
  }, [load]);

  // While a render runs, poll until it settles (the studio pattern: the job
  // queue is the truth; the panel only watches). When the render lands, the
  // preview stamp bumps once so the <video> re-mounts on the fresh bytes.
  const wasGenerating = useRef(false);
  useEffect(() => {
    if (state?.generating) {
      wasGenerating.current = true;
      const t = setInterval(() => void load(), 2500);
      return () => clearInterval(t);
    }
    if (wasGenerating.current) {
      wasGenerating.current = false;
      setClipStamp(Date.now());
    }
  }, [state?.generating, load]);

  const patch = (fn: (d: Scene3D) => Scene3D): void => {
    setDoc((d) => (d ? fn(d) : d));
    setDirty(true);
    setMsg(null);
  };

  const scaffold = async (): Promise<void> => {
    setBusy("scaffold");
    setMsg(null);
    try {
      const res = await fetch(`/api/videos/${videoId}/scene3d`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aspect: "16:9", fps: 30, durationSec: 5 }),
      });
      const data = (await res.json()) as { doc?: Scene3D; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Scaffold failed");
      setDoc(data.doc ?? null);
      setDirty(false);
      setMsg("3D scene scaffolded — the deterministic render is queued.");
      onChanged?.();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      void load();
    }
  };

  const save = async (rerender: boolean): Promise<void> => {
    if (!doc) return;
    setBusy(rerender ? "rerender" : "save");
    setMsg(null);
    try {
      const res = await fetch(`/api/videos/${videoId}/scene3d`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doc, rerender }),
      });
      const data = (await res.json()) as { ok?: boolean; doc?: Scene3D; error?: string; rerenderQueued?: boolean };
      if (!res.ok) throw new Error(data.error ?? "Save failed");
      setDoc(data.doc ?? doc);
      setDirty(false);
      setMsg(rerender ? "Saved — the 3D render is queued." : "Saved.");
      onChanged?.();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      void load();
    }
  };

  const generating = state?.generating ?? false;

  return (
    <div className="rounded-xl border border-white/10 bg-white/3 p-4 space-y-3" data-testid="scene3d-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Box className="h-4 w-4 text-sky-300" />
          <div>
            <p className="text-sm font-semibold text-white/90">3D scene clip</p>
            <p className="text-[10px] text-muted-foreground">
              Optional layer — a staged 3D shot (camera, lights, materials) rendered by the native engine.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {generating && (
            <span className="inline-flex items-center gap-1 text-[11px] text-sky-200">
              <Loader2 className="h-3 w-3 animate-spin" /> Rendering…
            </span>
          )}
          {!doc && !generating && (
            <Button
              size="sm"
              className="h-7 text-[11px] bg-brand-gradient hover:opacity-90 text-white font-semibold"
              disabled={busy !== null}
              onClick={() => void scaffold()}
            >
              {busy === "scaffold" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Box className="h-3 w-3" />}
              Scaffold 3D scene
            </Button>
          )}
          {doc && (
            <>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-[11px] border-white/15 bg-white/4"
                disabled={busy !== null || !dirty}
                onClick={() => void save(false)}
              >
                {busy === "save" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                Save
              </Button>
              <Button
                size="sm"
                className="h-7 text-[11px] bg-brand-gradient hover:opacity-90 text-white font-semibold"
                disabled={busy !== null}
                onClick={() => void save(true)}
              >
                {busy === "rerender" ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                Save &amp; re-render
              </Button>
            </>
          )}
        </div>
      </div>

      {msg && (
        <p className="text-[11px] text-sky-200 bg-sky-500/8 border border-sky-500/20 rounded-lg px-2.5 py-1.5">{msg}</p>
      )}
      {state?.error && (
        <p className="text-[11px] text-red-300 bg-red-500/8 border border-red-500/20 rounded-lg px-2.5 py-1.5">{state.error}</p>
      )}

      {!doc ? (
        <p className="text-xs text-muted-foreground">
          No 3D scene yet. Scaffold one — the topic seeds a deterministic arrangement
          (objects, lights, camera keys) that you can then edit here and re-render.
        </p>
      ) : (
        <div className="space-y-4">
          {doc.aspect} · {doc.width}×{doc.height} @ {doc.fps}fps · {doc.durationSec}s
          {(state?.hasClip || generating) && (
            <div className="mt-1">
              {state?.hasClip ? (
                <video
                  key={clipStamp}
                  src={`/api/videos/${videoId}/scene3d?clip=1&v=${clipStamp}`}
                  controls
                  className="w-full max-w-md rounded-lg border border-white/10"
                  aria-label="3D scene preview"
                />
              ) : (
                <p className="inline-flex items-center gap-1.5 text-[11px] text-sky-200">
                  <Loader2 className="h-3 w-3 animate-spin" /> The clip appears here when the render lands.
                </p>
              )}
              {state?.hasClip && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-[10px] px-2 ml-2"
                  onClick={() => setClipStamp(Date.now())}
                >
                  <Play className="h-2.5 w-2.5" /> Reload preview
                </Button>
              )}
            </div>
          )}

          {/* Camera */}
          <div className="rounded-lg border border-white/10 bg-white/4 p-3 space-y-2">
            <p className="text-[11px] font-medium text-white/80">Camera</p>
            <div className="flex flex-wrap items-center gap-2">
              <Num
                label="fov"
                value={doc.camera.fov}
                min={20}
                max={110}
                onCommit={(v) => patch((d) => ({ ...d, camera: { ...d.camera, fov: v } }))}
              />
              <Num
                label="pushIn"
                value={doc.camera.pushIn ?? 0}
                min={0}
                max={0.9}
                step={0.05}
                onCommit={(v) =>
                  patch((d) => ({
                    ...d,
                    camera: { ...d.camera, pushIn: v > 0 ? v : undefined },
                  }))
                }
              />
              <Num
                label="shake"
                value={doc.camera.shake?.strength ?? 0}
                min={0}
                max={2}
                step={0.1}
                onCommit={(v) =>
                  patch((d) => ({
                    ...d,
                    camera: {
                      ...d.camera,
                      shake:
                        v > 0
                          ? { strength: v, seed: d.camera.shake?.seed ?? 7, octaves: d.camera.shake?.octaves ?? 4, frequency: d.camera.shake?.frequency ?? 2.1 }
                          : undefined,
                    },
                  }))
                }
              />
              <span className="text-[10px] text-white/40">{doc.camera.keyframes.length} camera keys</span>
            </div>
            {doc.camera.keyframes.length > 0 && (
              <div className="space-y-1">
                {doc.camera.keyframes.map((k, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-1.5 rounded bg-white/4 px-2 py-1">
                    <Num
                      label="t"
                      value={k.t}
                      min={0}
                      max={1}
                      step={0.05}
                      onCommit={(v) =>
                        patch((d) => {
                          const keys = d.camera.keyframes.map((kk, j) => (j === i ? { ...kk, t: v } : kk));
                          return { ...d, camera: { ...d.camera, keyframes: keys } };
                        })
                      }
                    />
                    <Vec
                      label="pos"
                      value={k.position}
                      onCommit={(v) =>
                        patch((d) => {
                          const keys = d.camera.keyframes.map((kk, j) => (j === i ? { ...kk, position: v } : kk));
                          return { ...d, camera: { ...d.camera, keyframes: keys } };
                        })
                      }
                    />
                    <Vec
                      label="lookAt"
                      value={k.lookAt}
                      onCommit={(v) =>
                        patch((d) => {
                          const keys = d.camera.keyframes.map((kk, j) => (j === i ? { ...kk, lookAt: v } : kk));
                          return { ...d, camera: { ...d.camera, keyframes: keys } };
                        })
                      }
                    />
                    <button
                      type="button"
                      className="ml-auto rounded px-1.5 py-0.5 text-[10px] text-red-300 hover:bg-red-500/10"
                      onClick={() =>
                        patch((d) => ({
                          ...d,
                          camera: { ...d.camera, keyframes: d.camera.keyframes.filter((_, j) => j !== i) },
                        }))
                      }
                      aria-label={`Remove camera key ${i + 1}`}
                    >
                      remove
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Look */}
          <div className="rounded-lg border border-white/10 bg-white/4 p-3 space-y-2">
            <p className="text-[11px] font-medium text-white/80">Look</p>
            <div className="flex flex-wrap items-center gap-2">
              <Color
                label="bg"
                value={doc.background}
                onCommit={(v) => patch((d) => ({ ...d, background: v }))}
              />
              <Color
                label="sky top"
                value={doc.sky?.top ?? "#1e3a8a"}
                onCommit={(v) => patch((d) => ({ ...d, sky: { top: v, horizon: d.sky?.horizon ?? "#93c5fd" } }))}
              />
              <Color
                label="horizon"
                value={doc.sky?.horizon ?? "#93c5fd"}
                onCommit={(v) => patch((d) => ({ ...d, sky: { top: d.sky?.top ?? "#1e3a8a", horizon: v } }))}
              />
              <label className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <input
                  type="checkbox"
                  checked={doc.shadows ?? false}
                  onChange={(e) => patch((d) => ({ ...d, shadows: e.target.checked }))}
                  className="accent-sky-400"
                />
                sun shadows
              </label>
            </div>
          </div>

          {/* Objects */}
          <div className="rounded-lg border border-white/10 bg-white/4 p-3 space-y-2">
            <p className="text-[11px] font-medium text-white/80">Objects · {doc.objects.length}</p>
            <div className="space-y-1.5">
              {doc.objects.map((o, i) => (
                <div key={o.id} className="rounded bg-white/4 px-2 py-1.5 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[11px] font-medium text-white/85">
                      {o.kind} · {o.id}
                    </span>
                    <Vec
                      label="pos"
                      value={o.position}
                      onCommit={(v) =>
                        patch((d) => ({
                          ...d,
                          objects: d.objects.map((oo, j) => (j === i ? { ...oo, position: v } : oo)),
                        }))
                      }
                    />
                    <Vec
                      label="rot"
                      value={o.rotation ?? [0, 0, 0]}
                      onCommit={(v) =>
                        patch((d) => ({
                          ...d,
                          objects: d.objects.map((oo, j) => (j === i ? { ...oo, rotation: v } : oo)),
                        }))
                      }
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Color
                      label="color"
                      value={o.material.color}
                      onCommit={(v) =>
                        patch((d) => ({
                          ...d,
                          objects: d.objects.map((oo, j) => (j === i ? { ...oo, material: { ...oo.material, color: v } } : oo)),
                        }))
                      }
                    />
                    <Num
                      label="metal"
                      value={o.material.metalness ?? 0}
                      min={0}
                      max={1}
                      step={0.05}
                      onCommit={(v) =>
                        patch((d) => ({
                          ...d,
                          objects: d.objects.map((oo, j) => (j === i ? { ...oo, material: { ...oo.material, metalness: v } } : oo)),
                        }))
                      }
                    />
                    <Num
                      label="rough"
                      value={o.material.roughness ?? 0.5}
                      min={0}
                      max={1}
                      step={0.05}
                      onCommit={(v) =>
                        patch((d) => ({
                          ...d,
                          objects: d.objects.map((oo, j) => (j === i ? { ...oo, material: { ...oo.material, roughness: v } } : oo)),
                        }))
                      }
                    />
                    <Num
                      label="opacity"
                      value={o.material.opacity ?? 1}
                      min={0}
                      max={1}
                      step={0.05}
                      onCommit={(v) =>
                        patch((d) => ({
                          ...d,
                          objects: d.objects.map((oo, j) => (j === i ? { ...oo, material: { ...oo.material, opacity: v } } : oo)),
                        }))
                      }
                    />
                    {o.keyframes && o.keyframes.length > 0 && (
                      <span className="text-[10px] text-white/40">{o.keyframes.length} keyframes</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Lights */}
          <div className="rounded-lg border border-white/10 bg-white/4 p-3 space-y-2">
            <p className="text-[11px] font-medium text-white/80">Lights · {doc.lights.length}</p>
            <div className="space-y-1.5">
              {doc.lights.map((l, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2 rounded bg-white/4 px-2 py-1.5">
                  <span className="text-[11px] font-medium text-white/85">{l.kind}</span>
                  <Num
                    label="intensity"
                    value={l.intensity}
                    min={0}
                    max={10}
                    step={0.1}
                    onCommit={(v) =>
                      patch((d) => ({ ...d, lights: d.lights.map((ll, j) => (j === i ? { ...ll, intensity: v } : ll)) }))
                    }
                  />
                  <Color
                    label="color"
                    value={l.color ?? "#ffffff"}
                    onCommit={(v) =>
                      patch((d) => ({ ...d, lights: d.lights.map((ll, j) => (j === i ? { ...ll, color: v } : ll)) }))
                    }
                  />
                  {l.kind === "directional" && (
                    <Vec
                      label="dir"
                      value={l.direction ?? [0, -1, 0]}
                      onCommit={(v) =>
                        patch((d) => ({ ...d, lights: d.lights.map((ll, j) => (j === i ? { ...ll, direction: v } : ll)) }))
                      }
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
