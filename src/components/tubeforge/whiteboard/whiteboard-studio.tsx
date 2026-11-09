"use client";

// S67 — the Whiteboard Studio (E9 Phase A, E1 design §5): scaffold from the
// story, scrub + play per scene through the frame-plan seam, and render.
//
// S68 — Phase B: the studio becomes an EDITOR. The doc's own shapes are the
// editing surface (placements, the four AnimationEvent kinds, camera
// keyframes) — mutated in an immutable working buffer, saved through the
// validated PUT route (rev echo, 409-with-current on conflict, the engine
// validator's verbatim errors). The scheduler's precedence law does the
// heavy lifting: an explicit event is SENIOR, so hand-authored timing pins
// that element and the fill law schedules only the unclaimed rest. The
// canvas stays the frame-plan mirror — what you drag is what renders.
//
// Phase C (palette raw SVG + uploads → E11) and VO-measured editor timing
// of hand-authored scenes stay in their lanes; the measured durations the
// GET route returns (`voMs`) already time scene playback like the render.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AnimationEvent, CameraEvent, WhiteboardProject } from "@/lib/tubeforge/whiteboard/storyboard";
import type { Placement } from "@/lib/tubeforge/whiteboard/svg";
import { sceneDurationMs } from "@/lib/tubeforge/whiteboard/timing";
import WbCanvas, { type WbEditing } from "./wb-canvas";

interface LibraryEntry {
  id: string;
  w: number;
  h: number;
  tags: string[];
  paths: string[];
  texts: string[];
  /** S69 (Phase C): present on UPLOADED assets — the sanitized fragment
   *  rides the wire (built-ins ship in the client bundle), with the
   *  manifest provenance for the palette's delete affordance. */
  uploaded?: boolean;
  svg?: string;
  bytes?: number;
  uploadedBy?: string;
}

interface WhiteboardGetResponse {
  project: WhiteboardProject | null;
  rev: number;
  library: LibraryEntry[];
  voMs: Record<string, number>;
  budgets: Record<string, number>;
}

export interface WhiteboardStudioProps {
  videoId: string;
  /** The video row's hasVideo — lets the surface show the standing render. */
  hasVideo: boolean;
  /** Called after an accepted render enqueue so the dialog refreshes the DTO. */
  onRenderQueued: () => void;
}

type ErrorState = string | null;

const btn =
  "rounded-lg px-3 py-1.5 text-xs font-medium disabled:opacity-50";
const btnSolid = `${btn} bg-white text-black hover:bg-white/85`;
const btnGhost = `${btn} bg-white/10 hover:bg-white/20`;
const btnFaint = `${btn} bg-white/5 text-white/60 hover:bg-white/10`;
const inputCls =
  "w-20 rounded-md border border-white/15 bg-black/30 px-1.5 py-0.5 text-xs tabular-nums text-white";

export default function WhiteboardStudio({ videoId, hasVideo, onRenderQueued }: WhiteboardStudioProps) {
  const [data, setData] = useState<WhiteboardGetResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ErrorState>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Phase B working state: the buffer is the doc-under-edit; `dirty` marks
  // unsaved changes; the canvas plays the BUFFER so edits preview live.
  const [buffer, setBuffer] = useState<WhiteboardProject | null>(null);
  const [dirty, setDirty] = useState(false);
  const [editing, setEditing] = useState(false);
  const [selAsset, setSelAsset] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ rev: number; project: WhiteboardProject } | null>(null);

  const [sceneIndex, setSceneIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [tMs, setTMs] = useState(0);
  const [seek, setSeek] = useState<{ tMs: number; nonce: number } | null>(null);
  const seekNonce = useRef(0);

  // The live drag mirror — committed into the buffer on pointer-up.
  const dragBufRef = useRef(new Map<string, Placement>());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/videos/${videoId}/whiteboard`, { cache: "no-store" });
      const body = (await res.json()) as WhiteboardGetResponse & { error?: string };
      if (!res.ok) {
        setError(body.error ?? "Failed to load the whiteboard");
        setData(null);
        setBuffer(null);
      } else {
        setData(body);
        setBuffer(body.project);
        setDirty(false);
        setSelAsset(null);
        setSceneIndex(0);
        setTMs(0);
        setPlaying(false);
      }
    } catch {
      setError("Failed to load the whiteboard");
    } finally {
      setLoading(false);
    }
  }, [videoId]);

  useEffect(() => {
    // Deferred so lint's set-state-in-effect rule is satisfied (the house
    // pattern, pwa.tsx): the fetch's first setState leaves the effect's
    // synchronous stack.
    queueMicrotask(() => void load());
  }, [load]);

  // Editing pauses playback at the toggle (no effect: the overlay math
  // assumes a fixed clock, and the click is where the intent lives).

  const project = buffer ?? data?.project ?? null;
  const scene = project?.scenes[sceneIndex] ?? null;
  const sceneMs = scene ? sceneDurationMs(scene, data?.voMs?.[scene.id] ?? null) : 0;
  const libraryById = useMemo(() => {
    const m = new Map<string, LibraryEntry>();
    for (const e of data?.library ?? []) m.set(e.id, e);
    return m;
  }, [data?.library]);

  // S69 — the uploads as engine assets, for the canvas's merged library
  // (the same loadLibrary(uploads) merge the server validates against).
  const uploadedAssets = useMemo(() => {
    const list: { id: string; viewBox: { w: number; h: number }; tags: string[]; svg: string }[] = [];
    for (const e of data?.library ?? []) {
      if (e.uploaded && e.svg) list.push({ id: e.id, viewBox: { w: e.w, h: e.h }, tags: e.tags, svg: e.svg });
    }
    return list;
  }, [data?.library]);
  const uploadFileRef = useRef<HTMLInputElement | null>(null);

  // ---- Phase B mutations (all immutable, all mark dirty) -----------------

  const mutateScene = useCallback(
    (fn: (s: WhiteboardProject["scenes"][number]) => WhiteboardProject["scenes"][number]) => {
      setBuffer((p) => {
        if (!p) return p;
        const scenes = p.scenes.map((s, i) => (i === sceneIndex ? fn(s) : s));
        return { ...p, scenes };
      });
      setDirty(true);
    },
    [sceneIndex]
  );

  const addPlacement = (assetId: string) => {
    if (!project || !scene) return;
    if (scene.placements.some((pl) => pl.assetId === assetId)) {
      setSelAsset(assetId);
      return; // one placement per asset (move_object animates it)
    }
    const n = scene.placements.length;
    const spot: Placement = {
      x: Math.round(project.width * 0.4 + (n % 5) * 44),
      y: Math.round(project.height * 0.38 + (n % 5) * 36),
      scale: 1,
      rotateDeg: 0,
    };
    mutateScene((s) => ({
      ...s,
      placements: [...s.placements, { assetId, placement: spot, order: n }],
    }));
    setSelAsset(assetId);
  };

  const patchPlacement = useCallback(
    (assetId: string, patch: Partial<Placement>) => {
      mutateScene((s) => ({
        ...s,
        placements: s.placements.map((pl) =>
          pl.assetId === assetId ? { ...pl, placement: { ...pl.placement, ...patch } } : pl
        ),
      }));
    },
    [mutateScene]
  );

  const removePlacement = (assetId: string) => {
    // Dropping a placement drops its explicit events too — events for an
    // unplaced asset are invisible ink (composeScene only emits placed
    // assets), so keeping them would be silent dead data.
    mutateScene((s) => ({
      ...s,
      placements: s.placements
        .filter((pl) => pl.assetId !== assetId)
        .map((pl, i) => ({ ...pl, order: i })), // z-order = array order, renumbered
      animations: s.animations.filter((e) => e.assetId !== assetId),
    }));
    setSelAsset(null);
  };

  const reorderPlacement = (assetId: string, dir: -1 | 1) => {
    if (!scene) return;
    const idx = scene.placements.findIndex((pl) => pl.assetId === assetId);
    const to = idx + dir;
    if (idx < 0 || to < 0 || to >= scene.placements.length) return;
    mutateScene((s) => {
      const placements = [...s.placements];
      const [moved] = placements.splice(idx, 1);
      placements.splice(to, 0, moved);
      return { ...s, placements: placements.map((pl, i) => ({ ...pl, order: i })) };
    });
  };

  const updateEvent = (idx: number, patch: Partial<AnimationEvent>) => {
    mutateScene((s) => ({
      ...s,
      animations: s.animations.map((e, i) => (i === idx ? ({ ...e, ...patch } as AnimationEvent) : e)),
    }));
  };

  const removeEvent = (idx: number) => {
    mutateScene((s) => ({ ...s, animations: s.animations.filter((_, i) => i !== idx) }));
  };

  const addEvent = (ev: AnimationEvent) => {
    mutateScene((s) => ({ ...s, animations: [...s.animations, ev] }));
  };

  const updateCamera = (idx: number, patch: Partial<CameraEvent>) => {
    mutateScene((s) => ({
      ...s,
      camera: s.camera.map((c, i) => (i === idx ? { ...c, ...patch } : c)),
    }));
  };

  const addCameraKey = () => {
    if (!project || !scene) return;
    mutateScene((s) => ({
      ...s,
      camera: [
        ...s.camera,
        {
          cx: Math.round(project.width / 2),
          cy: Math.round(project.height / 2),
          scale: 1,
          startMs: Math.round(sceneMs),
          durationMs: 800,
        },
      ],
    }));
  };

  const removeCameraKey = (idx: number) => {
    mutateScene((s) => ({ ...s, camera: s.camera.filter((_, i) => i !== idx) }));
  };

  // ---- canvas editing callbacks (memoized: the canvas rebinds on identity)
  const onPlacementDrag = useCallback((assetId: string, placement: Placement) => {
    dragBufRef.current.set(assetId, placement);
  }, []);
  const onPlacementCommit = useCallback(
    (assetId: string, placement: Placement) => {
      dragBufRef.current.delete(assetId);
      patchPlacement(assetId, placement);
    },
    // patchPlacement closes over sceneIndex; keep the identity stable per scene
    [patchPlacement]
  );
  const onSelect = useCallback((assetId: string | null) => setSelAsset(assetId), []);
  const editingProps: WbEditing | undefined = useMemo(
    () =>
      editing
        ? { selectedAssetId: selAsset, onPlacementDrag, onPlacementCommit, onSelect }
        : undefined,
    [editing, selAsset, onPlacementDrag, onPlacementCommit, onSelect]
  );

  // ---- Phase C loop (upload / delete — the §7 gates live server-side) ----

  const uploadAsset = async (file: File) => {
    setBusy("upload");
    setError(null);
    setNotice(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`/api/videos/${videoId}/whiteboard/asset`, {
        method: "POST",
        body: form,
      });
      const body = (await res.json()) as {
        assetId?: string;
        bytes?: number;
        probeMs?: number;
        error?: string;
        errors?: string[];
      };
      if (!res.ok) {
        setError(body.errors?.length ? body.errors.join(" · ") : (body.error ?? "Upload failed"));
        return;
      }
      setNotice(`Uploaded "${body.assetId}" (${body.bytes ?? 0} B stored, raster probe ${body.probeMs ?? "?"} ms)`);
      await load(); // refresh the palette + the merged library
    } catch {
      setError("Upload failed");
    } finally {
      setBusy(null);
      if (uploadFileRef.current) uploadFileRef.current.value = "";
    }
  };

  const deleteAsset = async (assetId: string) => {
    setBusy(`delete:${assetId}`);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/videos/${videoId}/whiteboard/asset?assetId=${encodeURIComponent(assetId)}`, {
        method: "DELETE",
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(body.error ?? "Delete failed");
        return;
      }
      setNotice(`Deleted "${assetId}"`);
      await load();
    } catch {
      setError("Delete failed");
    } finally {
      setBusy(null);
    }
  };

  // ---- save / conflict ----------------------------------------------------

  const save = async () => {
    if (!project || !data) return;
    setBusy("save");
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/videos/${videoId}/whiteboard`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project, rev: data.rev }),
      });
      if (res.status === 409) {
        const body = (await res.json()) as {
          error?: string;
          current?: { rev: number; project: WhiteboardProject };
        };
        if (body.current) setConflict({ rev: body.current.rev, project: body.current.project });
        setError(body.error ?? "This whiteboard changed under you");
        return;
      }
      const body = (await res.json()) as {
        rev?: number;
        project?: WhiteboardProject;
        errors?: string[];
        error?: string;
      };
      if (!res.ok) {
        // The engine validator's verbatim errors (design §4 law).
        setError(body.errors?.length ? body.errors.join(" · ") : (body.error ?? "Save failed"));
        return;
      }
      setData((d) => (d ? { ...d, rev: body.rev ?? d.rev + 1, project: body.project ?? project } : d));
      setBuffer(body.project ?? project);
      setDirty(false);
      setNotice("Whiteboard saved — rendered artifacts invalidated");
    } catch {
      setError("Save failed");
    } finally {
      setBusy(null);
    }
  };

  // ---- Phase A loop (scaffold / render) -----------------------------------

  const scaffold = async (force: boolean) => {
    setBusy("scaffold");
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/videos/${videoId}/whiteboard/scaffold`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(force ? { force: true } : {}),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(body.error ?? "Scaffold failed");
        return;
      }
      setNotice(force ? "Whiteboard regenerated from the story scenes" : "Whiteboard scaffolded from the story scenes");
      await load();
    } finally {
      setBusy(null);
    }
  };

  const render = async (sceneId: string | null) => {
    if (dirty) {
      setError("Save your edits first — renders use the saved doc");
      return;
    }
    setBusy(sceneId ? `preview-${sceneId}` : "render");
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/videos/${videoId}/whiteboard/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sceneId ? { sceneId } : {}),
      });
      const body = (await res.json()) as { error?: string; accepted?: boolean };
      if (!res.ok) {
        setError(body.error ?? "Render failed to start");
        return;
      }
      setNotice(
        body.accepted === false
          ? "A whiteboard render is already running"
          : sceneId
            ? "Scene preview rendering — it lands in the Video tab"
            : "Full render started — progress and the result live in the Video tab"
      );
      onRenderQueued();
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-8 text-center text-sm text-white/50">Loading the whiteboard…</div>;
  }

  if (error && !project) {
    return (
      <div className="rounded-xl border border-red-500/20 bg-red-500/8 px-4 py-3 text-sm text-red-200">
        {error}
        <button onClick={() => void load()} className="ml-3 underline underline-offset-2">Retry</button>
      </div>
    );
  }

  if (!project || !scene) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-6 text-sm">
        <p className="text-white/70">
          No whiteboard yet. The native scaffold builds a starter board from this video&apos;s
          story scenes — narration per scene, library assets from a keyword rule table, and the
          engine&apos;s fill-law draw schedule. Zero AI, zero cost.
        </p>
        <button
          onClick={() => void scaffold(false)}
          disabled={busy !== null}
          className="mt-3 rounded-lg bg-white/10 px-3 py-1.5 text-xs font-medium hover:bg-white/20 disabled:opacity-50"
        >
          {busy === "scaffold" ? "Scaffolding…" : "Scaffold from the story"}
        </button>
        {error && <p className="mt-2 text-xs text-red-300">{error}</p>}
      </div>
    );
  }

  const sceneCount = project.scenes.length;
  const placedAssets = scene.placements;
  const selEntry = selAsset ? libraryById.get(selAsset) : null;

  return (
    <div className="space-y-3">
      {/* scene tabs + edit toggle */}
      <div className="flex flex-wrap items-center gap-1.5">
        {project.scenes.map((s, i) => (
          <button
            key={s.id}
            onClick={() => {
              setSceneIndex(i);
              setPlaying(false);
              setTMs(0);
            }}
            className={`rounded-md px-2.5 py-1 text-xs ${
              i === sceneIndex ? "bg-white/20 font-medium text-white" : "bg-white/5 text-white/60 hover:bg-white/10"
            }`}
          >
            {i + 1}. {s.narration.slice(0, 22) || s.id}
            {s.narration.length > 22 ? "…" : ""}
          </button>
        ))}
        <button
          onClick={() => {
            setEditing((v) => !v);
            setSelAsset(null);
            setPlaying(false);
          }}
          className={`ml-auto rounded-md px-2.5 py-1 text-xs ${
            editing ? "bg-cyan-500/25 font-medium text-cyan-100" : "bg-white/5 text-white/60 hover:bg-white/10"
          }`}
        >
          {editing ? "Editing ✓" : "Edit board"}
        </button>
      </div>

      <WbCanvas
        project={project}
        sceneIndex={sceneIndex}
        playing={playing}
        seek={seek}
        onTime={setTMs}
        onEnded={() => setPlaying(false)}
        voMs={data?.voMs}
        editing={editingProps}
        uploadedAssets={uploadedAssets}
      />

      {/* scrub + play */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => setPlaying((p) => !p)}
          disabled={editing}
          className={`${btnGhost} disabled:opacity-40`}
        >
          {playing ? "Pause" : "Play"}
        </button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.001}
          value={sceneMs > 0 ? Math.min(1, tMs / sceneMs) : 0}
          onChange={(e) => {
            setPlaying(false);
            const frac = Number(e.target.value);
            seekNonce.current += 1;
            setSeek({ tMs: frac * sceneMs, nonce: seekNonce.current });
          }}
          className="h-1 flex-1 accent-white"
          aria-label="Scrub the scene"
        />
        <span className="w-24 text-right text-xs tabular-nums text-white/50">
          {(tMs / 1000).toFixed(1)}s / {(sceneMs / 1000).toFixed(1)}s
        </span>
      </div>

      {/* ---- Phase B editor panels ---- */}
      {editing && (
        <div className="space-y-3 rounded-xl border border-white/10 bg-white/5 p-3">
          {/* library palette — built-ins (client bundle) + uploads (wire) */}
          <div>
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-white/40">
              Library — click to place {selAsset ? "· selected: " + selAsset : ""}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {(data?.library ?? [])
                .filter((a) => !a.uploaded)
                .map((a) => (
                  <button
                    key={a.id}
                    onClick={() => addPlacement(a.id)}
                    title={a.tags.join(", ")}
                    className={`rounded-md px-2 py-1 text-[11px] ${
                      placedAssets.some((pl) => pl.assetId === a.id)
                        ? "bg-white/15 text-white/70"
                        : "bg-white/5 text-white/80 hover:bg-white/15"
                    }`}
                  >
                    {a.id}
                  </button>
                ))}
            </div>
          </div>

          {/* S69 Phase C — uploads: the §7 gates' palette surface */}
          <div className="rounded-lg border border-white/10 bg-black/20 p-2.5">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-white/40">
                Uploads — your SVGs (256 KB cap, sanitized + budgeted)
              </p>
              <label className={`${btnGhost} cursor-pointer`} title="Upload an SVG through the seven gates">
                {busy === "upload" ? "Uploading…" : "+ Upload SVG"}
                <input
                  ref={uploadFileRef}
                  type="file"
                  accept=".svg,image/svg+xml"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void uploadAsset(f);
                  }}
                />
              </label>
            </div>
            {(data?.library ?? []).filter((a) => a.uploaded).length === 0 ? (
              <p className="text-[11px] text-white/35">
                No uploads yet — add a drawing, logo or diagram you own the rights to.
              </p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {(data?.library ?? [])
                  .filter((a) => a.uploaded)
                  .map((a) => (
                    <div
                      key={a.id}
                      className={`flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] ${
                        placedAssets.some((pl) => pl.assetId === a.id)
                          ? "bg-white/15 text-white/80"
                          : "bg-white/5 text-white/80"
                      }`}
                    >
                      {/* the per-asset drawable preview — sanitized server-side */}
                      {a.svg && (
                        <svg
                          viewBox={`0 0 ${a.w} ${a.h}`}
                          className="h-6 w-6 shrink-0"
                          aria-hidden
                          dangerouslySetInnerHTML={{ __html: a.svg }}
                        />
                      )}
                      <button
                        onClick={() => addPlacement(a.id)}
                        title={a.tags.join(", ")}
                        className="hover:underline"
                      >
                        {a.id}
                      </button>
                      <button
                        onClick={() => void deleteAsset(a.id)}
                        disabled={busy === `delete:${a.id}`}
                        title={
                          placedAssets.some((pl) => pl.assetId === a.id)
                            ? "Remove the placements first — deleting a placed asset would brick the doc"
                            : "Delete this upload"
                        }
                        className="rounded px-1 text-white/40 hover:bg-red-500/20 hover:text-red-200 disabled:opacity-40"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
              </div>
            )}
          </div>

          {/* placement inspector */}
          {selAsset && (
            <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/5 p-2.5">
              <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-cyan-200/70">
                {selAsset} — {selEntry ? `${selEntry.w}×${selEntry.h} asset` : "placed"}
              </p>
              {(() => {
                const pl = placedAssets.find((x) => x.assetId === selAsset);
                if (!pl) return null;
                return (
                  <div className="flex flex-wrap items-center gap-3 text-xs text-white/70">
                    <label className="flex items-center gap-1.5">
                      x
                      <input
                        type="number"
                        value={pl.placement.x}
                        step={10}
                        onChange={(e) => patchPlacement(selAsset, { x: Number(e.target.value) })}
                        className={inputCls}
                      />
                    </label>
                    <label className="flex items-center gap-1.5">
                      y
                      <input
                        type="number"
                        value={pl.placement.y}
                        step={10}
                        onChange={(e) => patchPlacement(selAsset, { y: Number(e.target.value) })}
                        className={inputCls}
                      />
                    </label>
                    <label className="flex items-center gap-1.5">
                      scale
                      <input
                        type="range"
                        min={0.2}
                        max={4}
                        step={0.05}
                        value={pl.placement.scale}
                        onChange={(e) => patchPlacement(selAsset, { scale: Number(e.target.value) })}
                        className="w-24 accent-white"
                      />
                      <span className="w-8 tabular-nums">{pl.placement.scale.toFixed(2)}</span>
                    </label>
                    <label className="flex items-center gap-1.5">
                      rotate
                      <input
                        type="range"
                        min={-180}
                        max={180}
                        step={5}
                        value={pl.placement.rotateDeg}
                        onChange={(e) => patchPlacement(selAsset, { rotateDeg: Number(e.target.value) })}
                        className="w-24 accent-white"
                      />
                      <span className="w-10 tabular-nums">{Math.round(pl.placement.rotateDeg)}°</span>
                    </label>
                    <button onClick={() => reorderPlacement(selAsset, -1)} className={btnFaint} title="Send back">◀ z</button>
                    <button onClick={() => reorderPlacement(selAsset, 1)} className={btnFaint} title="Bring forward">z ▶</button>
                    <button onClick={() => removePlacement(selAsset)} className={`${btn} bg-red-500/15 text-red-200 hover:bg-red-500/25`}>
                      Remove (+its events)
                    </button>
                  </div>
                );
              })()}
            </div>
          )}

          {/* events */}
          <div>
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-white/40">
              Events — explicit timing is senior; the fill law schedules the unclaimed rest
            </p>
            <div className="space-y-1.5">
              {scene.animations.map((ev, i) => (
                <div key={`${ev.type}-${i}`} className="flex flex-wrap items-center gap-2 rounded-md bg-black/20 px-2 py-1.5 text-xs">
                  <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px] text-white/70">{ev.type}</span>
                  <span className="text-white/60">{ev.assetId}</span>
                  {ev.type === "draw_path" && <span className="font-mono text-white/50">{ev.pathId}</span>}
                  {ev.type === "write_text" && <span className="font-mono text-white/50">{ev.textId}</span>}
                  {ev.type === "reveal_color" && ev.pathId && <span className="font-mono text-white/50">{ev.pathId}</span>}
                  <label className="ml-auto flex items-center gap-1 text-white/50">
                    start
                    <input
                      type="number"
                      min={0}
                      step={100}
                      value={ev.startMs}
                      onChange={(e) => updateEvent(i, { startMs: Math.max(0, Number(e.target.value)) })}
                      className={inputCls}
                    />
                  </label>
                  <label className="flex items-center gap-1 text-white/50">
                    dur
                    <input
                      type="number"
                      min={50}
                      step={100}
                      value={ev.durationMs}
                      onChange={(e) => updateEvent(i, { durationMs: Math.max(50, Number(e.target.value)) })}
                      className={inputCls}
                    />
                  </label>
                  {ev.type === "move_object" && (
                    <>
                      <label className="flex items-center gap-1 text-white/50">
                        toX
                        <input
                          type="number"
                          step={10}
                          value={ev.to.x}
                          onChange={(e) => updateEvent(i, { to: { ...ev.to, x: Number(e.target.value) } })}
                          className={inputCls}
                        />
                      </label>
                      <label className="flex items-center gap-1 text-white/50">
                        toY
                        <input
                          type="number"
                          step={10}
                          value={ev.to.y}
                          onChange={(e) => updateEvent(i, { to: { ...ev.to, y: Number(e.target.value) } })}
                          className={inputCls}
                        />
                      </label>
                    </>
                  )}
                  <button onClick={() => removeEvent(i)} className={`${btn} bg-red-500/10 px-2 text-red-200 hover:bg-red-500/20`}>×</button>
                </div>
              ))}
              {scene.animations.length === 0 && (
                <p className="text-xs text-white/40">No explicit events — every drawable rides the fill law.</p>
              )}
            </div>
            <AddEventRow placed={placedAssets} library={libraryById} onAdd={addEvent} />
          </div>

          {/* camera keys */}
          <div>
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-white/40">
              Camera keys — eased between keys; the permanent drift rides on top
            </p>
            <div className="space-y-1.5">
              {scene.camera.map((c, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2 rounded-md bg-black/20 px-2 py-1.5 text-xs">
                  <span className="text-white/50">#{i + 1}</span>
                  <label className="flex items-center gap-1 text-white/50">
                    cx
                    <input type="number" step={20} value={c.cx} onChange={(e) => updateCamera(i, { cx: Number(e.target.value) })} className={inputCls} />
                  </label>
                  <label className="flex items-center gap-1 text-white/50">
                    cy
                    <input type="number" step={20} value={c.cy} onChange={(e) => updateCamera(i, { cy: Number(e.target.value) })} className={inputCls} />
                  </label>
                  <label className="flex items-center gap-1 text-white/50">
                    zoom
                    <input
                      type="number"
                      min={0.2}
                      max={4}
                      step={0.1}
                      value={c.scale}
                      onChange={(e) => updateCamera(i, { scale: Math.min(4, Math.max(0.2, Number(e.target.value))) })}
                      className={inputCls}
                    />
                  </label>
                  <label className="flex items-center gap-1 text-white/50">
                    start
                    <input
                      type="number"
                      min={0}
                      step={100}
                      value={c.startMs}
                      onChange={(e) => updateCamera(i, { startMs: Math.max(0, Number(e.target.value)) })}
                      className={inputCls}
                    />
                  </label>
                  <label className="flex items-center gap-1 text-white/50">
                    dur
                    <input
                      type="number"
                      min={0}
                      step={100}
                      value={c.durationMs}
                      onChange={(e) => updateCamera(i, { durationMs: Math.max(0, Number(e.target.value)) })}
                      className={inputCls}
                    />
                  </label>
                  {scene.camera.length > 1 && (
                    <button onClick={() => removeCameraKey(i)} className={`${btn} bg-red-500/10 px-2 text-red-200 hover:bg-red-500/20`}>×</button>
                  )}
                </div>
              ))}
            </div>
            <button onClick={addCameraKey} disabled={scene.camera.length >= (data?.budgets.cameraKeysPerScene ?? 32)} className={`${btnFaint} mt-1.5`}>
              + camera key
            </button>
          </div>

          {/* save bar */}
          <div className="flex flex-wrap items-center gap-2 border-t border-white/10 pt-2.5">
            <button onClick={() => void save()} disabled={!dirty || busy !== null} className={btnSolid}>
              {busy === "save" ? "Saving…" : dirty ? "Save board" : "Saved"}
            </button>
            {dirty && (
              <button
                onClick={() => {
                  setBuffer(data?.project ?? null);
                  setDirty(false);
                  setSelAsset(null);
                }}
                className={btnFaint}
              >
                Discard edits
              </button>
            )}
            {dirty && <span className="text-xs text-amber-300/80">unsaved changes</span>}
            {!dirty && <span className="text-xs text-emerald-300/70">rev {data?.rev ?? 0}</span>}
            {conflict && (
              <button
                onClick={() => {
                  setBuffer(conflict.project);
                  setData((d) => (d ? { ...d, rev: conflict.rev, project: conflict.project } : d));
                  setDirty(false);
                  setConflict(null);
                }}
                className={btnGhost}
              >
                Load server version (rev {conflict.rev})
              </button>
            )}
          </div>
        </div>
      )}

      {/* render actions */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => void render(null)}
          disabled={busy !== null || dirty}
          className={btnSolid}
          title={dirty ? "Save your edits first" : undefined}
        >
          {busy === "render" ? "Starting…" : "Render full video"}
        </button>
        <button
          onClick={() => void render(scene.id)}
          disabled={busy !== null || dirty}
          className={btnGhost}
          title={dirty ? "Save your edits first" : undefined}
        >
          {busy?.startsWith("preview-") ? "Rendering preview…" : `Preview scene ${sceneIndex + 1}`}
        </button>
        <button
          onClick={() => void scaffold(true)}
          disabled={busy !== null}
          className={btnFaint}
        >
          Regenerate from story
        </button>
        {hasVideo && (
          <span className="text-xs text-emerald-300/80">rendered — see the Video tab</span>
        )}
      </div>

      {notice && <p className="text-xs text-emerald-300/90">{notice}</p>}
      {error && <p className="text-xs text-red-300">{error}</p>}

      <p className="text-[11px] leading-relaxed text-white/40">
        rev {data?.rev ?? 0} · {sceneCount} scene{sceneCount === 1 ? "" : "s"} · {data?.library.length ?? 0} library
        assets ·{" "}
        {data?.voMs?.[scene.id]
          ? `timed to the measured voiceover (${(data.voMs[scene.id] / 1000).toFixed(1)}s)`
          : "timing from the narration estimate; the render re-times from the measured voiceover"}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add-event row — the placed asset's drawables from the GET palette.
// ---------------------------------------------------------------------------

function AddEventRow({
  placed,
  library,
  onAdd,
}: {
  placed: { assetId: string; placement: Placement }[];
  library: Map<string, LibraryEntry>;
  onAdd: (ev: AnimationEvent) => void;
}) {
  const [type, setType] = useState<AnimationEvent["type"]>("draw_path");
  const [assetId, setAssetId] = useState<string>("");
  const [targetId, setTargetId] = useState<string>("");
  const [startMs, setStartMs] = useState(0);
  const [durationMs, setDurationMs] = useState(1200);

  // DERIVED, not effect-synced: the effective asset/target fall back to the
  // first valid choice whenever the raw state points at something that is
  // no longer placed/available (scene switches, removals). No cascades.
  const effAssetId = placed.some((p) => p.assetId === assetId) ? assetId : (placed[0]?.assetId ?? "");
  const entry = library.get(effAssetId);
  const targets = type === "write_text" ? (entry?.texts ?? []) : (entry?.paths ?? []);
  const effTargetId = targets.includes(targetId) ? targetId : (targets[0] ?? "");

  if (placed.length === 0) {
    return <p className="mt-1.5 text-xs text-white/40">Place an asset first to author events.</p>;
  }

  const add = () => {
    if (!effAssetId) return;
    if (type === "draw_path" && effTargetId)
      onAdd({ type, assetId: effAssetId, pathId: effTargetId, startMs, durationMs });
    else if (type === "write_text" && effTargetId)
      onAdd({ type, assetId: effAssetId, textId: effTargetId, startMs, durationMs });
    else if (type === "reveal_color")
      onAdd({ type, assetId: effAssetId, pathId: effTargetId || undefined, startMs, durationMs });
    else if (type === "move_object")
      onAdd({
        type,
        assetId: effAssetId,
        startMs,
        durationMs,
        to: { x: 1200, y: 600, scale: 1, rotateDeg: 0 },
      });
  };

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
      <select
        value={type}
        onChange={(e) => setType(e.target.value as AnimationEvent["type"])}
        className="rounded-md border border-white/15 bg-black/40 px-1.5 py-0.5 text-xs text-white"
      >
        <option value="draw_path">draw_path</option>
        <option value="write_text">write_text</option>
        <option value="reveal_color">reveal_color</option>
        <option value="move_object">move_object</option>
      </select>
      <select
        value={effAssetId}
        onChange={(e) => setAssetId(e.target.value)}
        className="rounded-md border border-white/15 bg-black/40 px-1.5 py-0.5 text-xs text-white"
      >
        {placed.map((p) => (
          <option key={p.assetId} value={p.assetId}>
            {p.assetId}
          </option>
        ))}
      </select>
      {type !== "move_object" && (
        <select
          value={effTargetId}
          onChange={(e) => setTargetId(e.target.value)}
          className="rounded-md border border-white/15 bg-black/40 px-1.5 py-0.5 text-xs text-white"
        >
          {targets.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      )}
      <label className="flex items-center gap-1 text-white/50">
        start
        <input
          type="number"
          min={0}
          step={100}
          value={startMs}
          onChange={(e) => setStartMs(Math.max(0, Number(e.target.value)))}
          className={inputCls}
        />
      </label>
      <label className="flex items-center gap-1 text-white/50">
        dur
        <input
          type="number"
          min={50}
          step={100}
          value={durationMs}
          onChange={(e) => setDurationMs(Math.max(50, Number(e.target.value)))}
          className={inputCls}
        />
      </label>
      <button onClick={add} className={btnGhost}>+ add event</button>
    </div>
  );
}
