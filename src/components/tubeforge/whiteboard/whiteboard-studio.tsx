"use client";

// S67 — the Whiteboard Studio (E9 Phase A, E1 design §5): the minimum loop
// that makes the engine a product — scaffold from the story, scrub + play
// per scene through the frame-plan seam, and render (full video / scene
// preview). Phase B (event editing) and Phase C (palette + uploads) ride
// later stages; this surface is read-only over the doc ON PURPOSE — every
// mutation it offers is scaffold/regenerate + render, so Phase A cannot
// drift from the validator's contract.
import { useCallback, useEffect, useRef, useState } from "react";

import type { WhiteboardProject } from "@/lib/tubeforge/whiteboard/storyboard";
import WbCanvas from "./wb-canvas";

interface LibraryEntry {
  id: string;
  w: number;
  h: number;
  tags: string[];
  paths: string[];
  texts: string[];
}

interface WhiteboardGetResponse {
  project: WhiteboardProject | null;
  rev: number;
  library: LibraryEntry[];
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

export default function WhiteboardStudio({ videoId, hasVideo, onRenderQueued }: WhiteboardStudioProps) {
  const [data, setData] = useState<WhiteboardGetResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ErrorState>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [sceneIndex, setSceneIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [tMs, setTMs] = useState(0);
  const [seek, setSeek] = useState<{ tMs: number; nonce: number } | null>(null);
  const seekNonce = useRef(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/videos/${videoId}/whiteboard`, { cache: "no-store" });
      const body = (await res.json()) as WhiteboardGetResponse & { error?: string };
      if (!res.ok) {
        setError(body.error ?? "Failed to load the whiteboard");
        setData(null);
      } else {
        setData(body);
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

  if (error && !data?.project) {
    return (
      <div className="rounded-xl border border-red-500/20 bg-red-500/8 px-4 py-3 text-sm text-red-200">
        {error}
        <button onClick={() => void load()} className="ml-3 underline underline-offset-2">Retry</button>
      </div>
    );
  }

  const project = data?.project ?? null;
  const scene = project?.scenes[sceneIndex] ?? null;

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

  return (
    <div className="space-y-3">
      {/* scene tabs */}
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
      </div>

      <WbCanvas
        project={project}
        sceneIndex={sceneIndex}
        playing={playing}
        seek={seek}
        onTime={setTMs}
        onEnded={() => setPlaying(false)}
      />

      {/* scrub + play */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => setPlaying((p) => !p)}
          className="rounded-lg bg-white/10 px-3 py-1.5 text-xs font-medium hover:bg-white/20"
        >
          {playing ? "Pause" : "Play"}
        </button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.001}
          value={scene.durationMs && scene.durationMs > 0 ? Math.min(1, tMs / scene.durationMs) : Math.min(1, tMs / 6000)}
          onChange={(e) => {
            setPlaying(false);
            const frac = Number(e.target.value);
            const dur = scene.durationMs && scene.durationMs > 0 ? scene.durationMs : 6000;
            seekNonce.current += 1;
            setSeek({ tMs: frac * dur, nonce: seekNonce.current });
          }}
          className="h-1 flex-1 accent-white"
          aria-label="Scrub the scene"
        />
        <span className="w-24 text-right text-xs tabular-nums text-white/50">
          {(tMs / 1000).toFixed(1)}s
        </span>
      </div>

      {/* render actions */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => void render(null)}
          disabled={busy !== null}
          className="rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-black hover:bg-white/85 disabled:opacity-50"
        >
          {busy === "render" ? "Starting…" : "Render full video"}
        </button>
        <button
          onClick={() => void render(scene.id)}
          disabled={busy !== null}
          className="rounded-lg bg-white/10 px-3 py-1.5 text-xs font-medium hover:bg-white/20 disabled:opacity-50"
        >
          {busy?.startsWith("preview-") ? "Rendering preview…" : `Preview scene ${sceneIndex + 1}`}
        </button>
        <button
          onClick={() => void scaffold(true)}
          disabled={busy !== null}
          className="rounded-lg bg-white/5 px-3 py-1.5 text-xs text-white/60 hover:bg-white/10 disabled:opacity-50"
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
        assets · timing shown is the narration estimate; the render re-times from the measured
        voiceover. Event editing arrives in Phase B.
      </p>
    </div>
  );
}
