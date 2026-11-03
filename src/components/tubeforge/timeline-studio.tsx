"use client";

// timeline-studio.tsx — the Timeline Studio: TubeForge's pro editing surface.
//
// Replaces the Stage-6 Editing Studio card with full parity — trim, reorder,
// per-scene audio levels, transitions, captions, undo/redo, save — plus the
// layer the old card never had:
//
//   • a horizontal multi-lane timeline (video / voice / captions) with a
//     shared ruler, playhead scrubbing, zoom and snapping;
//   • a LIVE canvas preview that resolves any frame instantly — approximate
//     Ken Burns camera, the transition catalog, burned captions — synced to
//     the real per-scene voiceover WAVs;
//   • an inspector for the selected clip;
//   • keyboard transport + shortcuts (space, arrows, home/end, ⌘Z, ⌘S).
//
// Data flow is unchanged from the old card:
//   GET  /api/videos/[id]/assemble   → timeline (auto-load when voiceover exists)
//   POST /api/videos/[id]/assemble   → re-assemble from the current scenes/plan
//   PUT  /api/videos/[id]/assemble   → save; sceneOrder rides along so the
//                                      ROW's scenes reorder with the doc
//                                      (the render maps durations by POSITION
//                                      onto the row — the two must agree).
//
// Honesty contract (what the RENDER honors vs what the preview shows):
//   • durationSec edits   → honored by the render (existing T-6.10 contract).
//   • order (sceneOrder)   → row + doc saved in lockstep; render follows.
//   • split / duplicate / delete → POST /studio/clip: the ROW's scenes, the
//     per-scene art/WAV assets, the merged voiceover.wav and the timeline
//     doc all move together in ONE server update. A split re-voices both
//     halves with the video's own voice; a duplicate is a byte copy of the
//     same read. These are row mutations — after one, the undo history
//     resets with the server's new doc (a deleted scene cannot be un-deleted
//     by a client-side undo).
//   • audio levels + transition labels → preview + saved doc; their render
//     wiring lands with S2 — the inspector says so explicitly.
//
// The preview is an approximation by design: the render (ffmpeg) stays the
// source of truth. Everything the preview needs is deterministic and lives
// in the pure preview-lanes module (unit-tested).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  horizontalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  AudioLines,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  GripVertical,
  Music2,
  Pause,
  Play,
  RotateCcw,
  Redo2,
  RefreshCw,
  Save,
  Scissors,
  SkipBack,
  SkipForward,
  Subtitles,
  Trash2,
  Undo2,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
  Maximize2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { clsx } from "clsx";
import { useToast } from "@/hooks/use-toast";
import type {
  VideoDTO,
  SceneDTO,
  AssembledTimelineDTO,
  TimelineSceneDTO,
} from "@/lib/tubeforge/types";
import { TRANSITIONS } from "@/lib/tubeforge/transitions";
import {
  formatTimecode,
  previewSettingsFrom,
  resolveFrame,
  snapToBoundaries,
  seamBoundaries,
  speakableSpan,
  type PreviewSettings,
  type SpeakableSpan,
} from "@/lib/tubeforge/preview-lanes";

const HISTORY_CAP = 50;
const DENSITY_MIN = 16; // px per second (zoomed way out)
const DENSITY_MAX = 320; // px per second (zoomed way in)
const DENSITY_DEFAULT = 72;
const LANE_H_VIDEO = 64;
const LANE_H_AUDIO = 30;
const SNAP_PX = 8; // playhead snap radius in pixels

export interface TimelineStudioProps {
  videoId: string;
  video: VideoDTO;
  scenes: SceneDTO[];
  /** Whether the video has a voiceover (the assemble prerequisite). */
  canAssemble: boolean;
  /** Whether a render is in flight (disables Save during renders). */
  renderInFlight: boolean;
  /** Called after a successful Save so the parent can refresh the row. */
  onSaved?: () => void;
}

/** POST /studio/clip — row-mutating clip operations (server contract). */
interface ClipOpResponse {
  timeline: AssembledTimelineDTO;
  sceneOrder: number[];
  newIndex: number | null;
  activity: string;
  /** Fresh per-scene read lengths after the op (a split re-voices). */
  wavDurations?: Record<number, number>;
}

type ClipAction = "split" | "duplicate" | "delete";

// ---------- working-copy helpers (history + recompute) ----------

interface HistoryState {
  past: AssembledTimelineDTO[];
  present: AssembledTimelineDTO | null;
  future: AssembledTimelineDTO[];
}

const emptyHistory: HistoryState = { past: [], present: null, future: [] };

function cloneTimeline(t: AssembledTimelineDTO): AssembledTimelineDTO {
  return {
    scenes: t.scenes.map((s) => ({
      ...s,
      audio: {
        voice: { ...s.audio.voice },
        music: { ...s.audio.music },
        sfx: { ...s.audio.sfx },
        ambient: { ...s.audio.ambient },
      },
      caption: s.caption ? { ...s.caption } : null,
    })),
    sceneCount: t.sceneCount,
    totalDurationSec: t.totalDurationSec,
    generatedAt: t.generatedAt,
  };
}

/** Recompute start/end + total from per-scene durations (keeps windows sequential). */
/**
 * Repair a loaded timeline doc. The PUT schema is deliberately permissive
 * (only index/start/end/duration are required), so a doc saved by any client
 * can lack audio mixes, captions, titles or transitions. The studio's render
 * and edit paths read those fields directly — normalize ONCE at the load
 * choke point and every downstream read is safe.
 */
function normalizeTimelineDoc(t: AssembledTimelineDTO | null): AssembledTimelineDTO | null {
  if (!t || !Array.isArray(t.scenes) || t.scenes.length === 0) return t;
  const num = (v: unknown, fallback: number, min: number, max: number) => {
    const n = typeof v === "number" && Number.isFinite(v) ? v : fallback;
    return Math.min(max, Math.max(min, n));
  };
  return {
    ...t,
    totalDurationSec: num(t.totalDurationSec, 0, 0, Number.MAX_SAFE_INTEGER),
    scenes: t.scenes.map((s) => {
      const a = s.audio;
      return {
        ...s,
        title: typeof s.title === "string" && s.title ? s.title : `Scene ${s.index}`,
        narration: s.narration ?? "",
        visual: s.visual ?? "",
        transitionIn: s.transitionIn ?? null,
        transitionOut: s.transitionOut ?? null,
        caption:
          s.caption && typeof s.caption.text === "string" && s.caption.text.trim()
            ? { text: s.caption.text, startSec: s.startSec ?? 0, endSec: s.endSec ?? 0 }
            : null,
        source: s.source ?? "ai",
        stockSource: s.stockSource ?? null,
        stockQuery: s.stockQuery ?? null,
        shot: s.shot ?? null,
        audio: {
          voice: a?.voice ?? { enabled: true, level: 1 },
          music: a?.music ?? { enabled: true, level: 0.6, ducking: true },
          sfx: a?.sfx ?? { enabled: false, level: 0, kind: null },
          ambient: a?.ambient ?? { enabled: false, level: 0, kind: null },
        },
      };
    }),
  };
}

function recomputeTimes(t: AssembledTimelineDTO): AssembledTimelineDTO {
  let cursor = 0;
  const scenes = t.scenes.map((s) => {
    const durationSec = Math.max(0.5, Math.round(s.durationSec * 100) / 100);
    const startSec = Math.round(cursor * 100) / 100;
    const endSec = Math.round((cursor + durationSec) * 100) / 100;
    cursor += durationSec;
    const caption = s.caption ? { ...s.caption, startSec, endSec } : null;
    return { ...s, startSec, endSec, durationSec, caption };
  });
  return {
    ...t,
    scenes,
    sceneCount: scenes.length,
    totalDurationSec: Math.round(cursor * 100) / 100,
  };
}

// ---------- the studio ----------

export function TimelineStudio({
  videoId,
  video,
  scenes,
  canAssemble,
  renderInFlight,
  onSaved,
}: TimelineStudioProps) {
  const { toast } = useToast();
  const [history, setHistory] = useState<HistoryState>(emptyHistory);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [density, setDensity] = useState(DENSITY_DEFAULT);
  const [selected, setSelected] = useState<number | null>(null);
  const [mediaVersion, setMediaVersion] = useState(0); // bump → redraw preview
  const [brokenVo, setBrokenVo] = useState<Set<number>>(new Set());
  const [clipBusy, setClipBusy] = useState<ClipAction | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);
  /** Per-scene read lengths from the server (assemble GET/POST, clip ops) —
   *  makes the razor's speakable-span guard exact instead of estimated.
   *  Missing entries fall back to the doc-duration estimate. */
  const [wavDurations, setWavDurations] = useState<Record<number, number>>({});

  const timeline = history.present;
  const canUndo = history.past.length > 0;
  const canRedo = history.future.length > 0;

  const settings: PreviewSettings = useMemo(
    () =>
      previewSettingsFrom({
        aspectRatio: video.renderMode === "slides" ? "9:16" : video.aspectRatio,
        frameRate: video.frameRate,
        motionIntensity: video.motionIntensity,
        motionCurve: video.motionCurve,
        motionVary: video.motionVary,
        transitionDurationSec: video.transitionDuration,
      }),
    [video.renderMode, video.aspectRatio, video.frameRate, video.motionIntensity, video.motionCurve, video.motionVary, video.transitionDuration]
  );

  const scenesByIdx = useMemo(() => {
    const m = new Map<number, SceneDTO>();
    for (const s of scenes) m.set(s.index, s);
    return m;
  }, [scenes]);

  // ---------- load / assemble / save ----------

  const loadTimeline = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/videos/${videoId}/assemble`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        timeline: AssembledTimelineDTO | null;
        wavDurations?: Record<number, number>;
      };
      setHistory({ past: [], present: normalizeTimelineDoc(data.timeline), future: [] });
      setWavDurations(data.wavDurations ?? {});
      setDirty(false);
      setPlayhead(0);
      setPlaying(false);
      setSelected(null);
    } catch (err) {
      toast({
        title: "Could not load timeline",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [videoId, toast]);

  useEffect(() => {
    if (canAssemble) void loadTimeline();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId, canAssemble]);

  const assemble = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/videos/${videoId}/assemble`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as {
        timeline: AssembledTimelineDTO;
        wavDurations?: Record<number, number>;
      };
      setHistory({ past: [], present: normalizeTimelineDoc(data.timeline), future: [] });
      setWavDurations(data.wavDurations ?? {});
      setDirty(false);
      setPlayhead(0);
      setPlaying(false);
      toast({
        title: "Timeline assembled",
        description: `${data.timeline.sceneCount} scenes · ${data.timeline.totalDurationSec.toFixed(1)}s (edits replaced)`,
      });
    } catch (err) {
      toast({
        title: "Assembly failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [videoId, toast]);

  const save = useCallback(async () => {
    if (!timeline || !dirty) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/videos/${videoId}/assemble`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        // sceneOrder rides along — the row's scenes reorder with the doc so
        // the render (which maps durations by POSITION onto the row) and the
        // timeline can never disagree about play order.
        body: JSON.stringify({
          ...timeline,
          sceneOrder: timeline.scenes.map((s) => s.index),
        }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      setDirty(false);
      onSaved?.();
      toast({ title: "Timeline saved", description: "The render will honor your trims and order." });
    } catch (err) {
      toast({
        title: "Save failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  }, [videoId, timeline, dirty, onSaved, toast]);

  // ---------- undo / redo / reset ----------

  const undo = useCallback(() => {
    setHistory((h) => {
      if (h.past.length === 0) return h;
      const present = h.past[h.past.length - 1];
      const past = h.past.slice(0, -1);
      const future = [h.present ?? present, ...h.future].filter(Boolean) as AssembledTimelineDTO[];
      return { past, present, future };
    });
    setDirty(true);
  }, []);

  const redo = useCallback(() => {
    setHistory((h) => {
      if (h.future.length === 0) return h;
      const present = h.future[0];
      const future = h.future.slice(1);
      const past = h.present ? [...h.past, h.present] : h.past;
      return { past, present, future };
    });
    setDirty(true);
  }, []);

  const reset = useCallback(() => {
    setHistory((h) => {
      if (!h.present) return h;
      const past = [...h.past, h.present];
      if (past.length > HISTORY_CAP) past.shift();
      const original = past[0] ?? h.present;
      return { past, present: cloneTimeline(original), future: [] };
    });
    setDirty(true);
  }, []);

  /**
   * Apply an edit. "push" opens a new undo step; "replace" mutates the
   * present WITHOUT a new step — used mid-gesture (trim drags, typing,
   * slider scrubbing) so one gesture = one undo step.
   */
  const applyEdit = useCallback(
    (next: AssembledTimelineDTO, mode: "push" | "replace" = "push") => {
      setHistory((h) => {
        if (!h.present) return { ...h, present: next };
        if (mode === "replace") return { ...h, present: next };
        const past = [...h.past, h.present];
        if (past.length > HISTORY_CAP) past.shift();
        return { past, present: next, future: [] };
      });
      setDirty(true);
    },
    []
  );

  /**
   * Grouped edits: a new undo step when the edit KEY changes or the user
   * paused (> 800ms); rapid same-key changes (typing, slider scrubbing)
   * replace the present without new steps — one gesture, one undo.
   */
  const editKeyRef = useRef<string | null>(null);
  const lastEditAtRef = useRef(0);
  const groupedEdit = useCallback(
    (key: string, next: AssembledTimelineDTO) => {
      const now = Date.now();
      const first = editKeyRef.current !== key || now - lastEditAtRef.current > 800;
      editKeyRef.current = key;
      lastEditAtRef.current = now;
      applyEdit(next, first ? "push" : "replace");
    },
    [applyEdit]
  );

  // ---------- per-scene edits ----------

  const patchScene = useCallback(
    (
      index: number,
      patch: Partial<TimelineSceneDTO>,
      opts?: { key?: string; mode?: "push" | "replace" }
    ) => {
      if (!timeline) return;
      const next = cloneTimeline(timeline);
      const i = next.scenes.findIndex((s) => s.index === index);
      if (i === -1) return;
      next.scenes[i] = { ...next.scenes[i], ...patch };
      const withTimes = recomputeTimes(next);
      if (opts?.mode) applyEdit(withTimes, opts.mode);
      else if (opts?.key) groupedEdit(opts.key, withTimes);
      else applyEdit(withTimes);
    },
    [timeline, applyEdit, groupedEdit]
  );

  /** Trim gestures: the ROW signals push (first move) vs replace (rest) —
   *  one drag = exactly one undo step. */
  const trimScene = useCallback(
    (index: number, durationSec: number, mode: "push" | "replace") => {
      patchScene(index, { durationSec }, { mode });
    },
    [patchScene]
  );

  /** Transition edits keep the doc's convention: transitionOut[k] mirrors
   *  transitionIn[k+1] (the SAME seam seen from both sides). */
  const setTransitionIn = useCallback(
    (index: number, style: string) => {
      if (!timeline) return;
      const next = cloneTimeline(timeline);
      const i = next.scenes.findIndex((s) => s.index === index);
      if (i === -1) return;
      const v = style === "cut" ? null : style;
      next.scenes[i].transitionIn = v;
      if (i > 0) next.scenes[i - 1].transitionOut = v;
      applyEdit(recomputeTimes(next));
    },
    [timeline, applyEdit]
  );

  const setAudioLevel = useCallback(
    (index: number, track: "voice" | "music" | "sfx" | "ambient", level: number) => {
      if (!timeline) return;
      const next = cloneTimeline(timeline);
      const i = next.scenes.findIndex((s) => s.index === index);
      if (i === -1) return;
      next.scenes[i].audio = {
        ...next.scenes[i].audio,
        [track]: { ...next.scenes[i].audio[track], level, enabled: level > 0 },
      };
      groupedEdit(`audio:${index}:${track}`, next);
    },
    [timeline, groupedEdit]
  );

  // ---------- drag-and-drop reorder ----------

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const onDragEnd = useCallback(
    (e: DragEndEvent) => {
      const { active, over } = e;
      if (!over || active.id === over.id || !timeline) return;
      const from = timeline.scenes.findIndex((s) => String(s.index) === String(active.id));
      const to = timeline.scenes.findIndex((s) => String(s.index) === String(over.id));
      if (from === -1 || to === -1) return;
      const next = cloneTimeline(timeline);
      next.scenes = arrayMove(next.scenes, from, to);
      applyEdit(recomputeTimes(next));
    },
    [timeline, applyEdit]
  );

  // ---------- playhead / transport ----------

  const total = timeline?.totalDurationSec ?? 0;

  const stepFrame = useCallback(
    (dir: 1 | -1, big = false) => {
      setPlaying(false);
      setPlayhead((p) => {
        const delta = big ? 1 : 1 / settings.frameRate;
        return Math.min(Math.max(0, p + dir * delta), Math.max(0, total - 0.001));
      });
    },
    [settings.frameRate, total]
  );

  const seek = useCallback(
    (t: number) => {
      if (!timeline) return;
      const bounds = seamBoundaries(timeline);
      // Snap radius scales with zoom: a fixed PIXEL radius, not seconds.
      const snapped = snapToBoundaries(Math.min(Math.max(0, t), Math.max(0, total - 0.001)), bounds, SNAP_PX / density);
      setPlayhead(snapped);
    },
    [timeline, total, density]
  );

  // Playback clock.
  useEffect(() => {
    if (!playing || !timeline) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      let stop = false;
      setPlayhead((p) => {
        const nextT = p + dt;
        if (nextT >= (timeline.totalDurationSec - 0.001)) {
          stop = true;
          return timeline.totalDurationSec;
        }
        return nextT;
      });
      if (stop) {
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, timeline]);

  // ---------- preview media pools (images / stock video) ----------

  const imagePool = useRef(new Map<number, HTMLImageElement>());
  const stockPool = useRef(new Map<number, HTMLVideoElement>());
  const bump = useCallback(() => setMediaVersion((v) => v + 1), []);

  useEffect(() => {
    for (const s of scenes) {
      if (s.imageUrl && !imagePool.current.has(s.index)) {
        const img = new Image();
        img.onload = bump;
        img.onerror = bump;
        img.src = s.imageUrl;
        imagePool.current.set(s.index, img);
      }
      if (s.stockUrl && !stockPool.current.has(s.index)) {
        const vid = document.createElement("video");
        vid.preload = "auto";
        vid.muted = true;
        vid.playsInline = true;
        vid.onloadeddata = bump;
        vid.onerror = bump;
        vid.src = s.stockUrl;
        stockPool.current.set(s.index, vid);
      }
    }
  }, [scenes, bump]);

  // ---------- preview audio pool (per-scene voiceover WAVs) ----------

  const voPool = useRef(new Map<number, HTMLAudioElement>());

  // Sync the active scene's narration to the playhead. One Audio element per
  // scene, created lazily on first play; a 404 marks the scene silent for the
  // session (no retry storm).
  useEffect(() => {
    if (!timeline) return;
    const f = resolveFrame(playhead, timeline, settings);
    if (!f) return;
    const scene = timeline.scenes.find((s) => s.index === f.activeIndex);
    const pool = voPool.current;
    for (const [idx, el] of pool) {
      if (idx !== f.activeIndex && !el.paused) el.pause();
    }
    if (!scene) return;
    const level = scene.audio.voice.level;
    const enabled = scene.audio.voice.enabled && level > 0 && !brokenVo.has(scene.index);
    if (!enabled) return;
    let el = pool.get(scene.index);
    if (!el) {
      el = new Audio(`/api/videos/${videoId}/vo/${scene.index}`);
      el.preload = "auto";
      el.addEventListener("error", () => {
        setBrokenVo((prev) => {
          if (prev.has(scene.index)) return prev;
          const next = new Set(prev);
          next.add(scene.index);
          return next;
        });
      });
      pool.set(scene.index, el);
    }
    if (brokenVo.has(scene.index)) return;
    el.volume = Math.min(1, Math.max(0, level));
    const want = f.localSec;
    if (Number.isFinite(want) && Math.abs(el.currentTime - want) > 0.25) {
      try {
        el.currentTime = want;
      } catch {
        /* seeking before metadata lands — the next tick retries */
      }
    }
    if (playing && el.paused) void el.play().catch(() => {});
    if (!playing && !el.paused) el.pause();
  }, [playhead, playing, timeline, settings, videoId, brokenVo]);

  // ---------- clip operations (server row edits: split / duplicate / delete) ----------

  /** The clip every row-level op targets: the selection if set, else the clip
   *  under the playhead. The razor additionally requires the playhead to sit
   *  INSIDE that clip — it cuts where the playhead is. */
  const activeClip = useMemo(() => {
    if (!timeline) return null;
    if (selected != null) {
      const s = timeline.scenes.find((x) => x.index === selected);
      if (s) return s;
    }
    return timeline.scenes.find((x) => playhead >= x.startSec && playhead < x.endSec) ?? null;
  }, [timeline, selected, playhead]);

  const playheadInClip =
    activeClip != null && playhead >= activeClip.startSec && playhead < activeClip.endSec;

  const clipOp = useCallback(
    async (action: ClipAction) => {
      if (!timeline || clipBusy || saving || loading || renderInFlight) return;
      const target = activeClip;
      if (!target) {
        toast({
          title: "Select a clip first",
          description: "Click a clip in the lanes, or park the playhead over one.",
        });
        return;
      }
      if (action === "split" && !playheadInClip) {
        toast({
          title: "Park the playhead inside the clip",
          description:
            "The razor cuts where the playhead is — move it into the middle of the narration, away from the scene's edges.",
        });
        return;
      }
      // The razor needs the playhead inside the SPOKEN READ, not just the
      // clip: every scene window carries lead silence + tail breathing room
      // the server refuses to cut. Mirror splitNarrationAt's window here so
      // the refusal is local, precise and instant — the server's 400 stays
      // the backstop when the estimate drifts (trimmed durations).
      const span =
        action === "split"
          ? speakableSpan(target.startSec, target.durationSec, wavDurations[target.index])
          : null;
      if (action === "split" && (!span || playhead < span.startSec || playhead > span.endSec)) {
        toast({
          title: span ? "Park the playhead inside the narration" : "This scene is too short to split",
          description: span
            ? `The read runs ${formatTimecode(span.startSec, settings.frameRate)}–${formatTimecode(
                span.endSec,
                settings.frameRate
              )} — the bright band on the voice clip. Lead-in and tail are padding; the razor needs words on both sides of the cut.`
            : "The narration inside this scene is too short (or not synthesized yet) for both halves to carry words.",
        });
        return;
      }
      setDeleteArmed(false);
      setClipBusy(action);
      try {
        // Flush pending edits first — the op works on the SAVED row + doc.
        if (dirty) await save();
        const res = await fetch(`/api/videos/${videoId}/studio/clip`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            sceneIndex: target.index,
            ...(action === "split" ? { atSec: playhead - target.startSec } : {}),
          }),
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(err.error ?? `HTTP ${res.status}`);
        }
        const data = (await res.json()) as ClipOpResponse;
        // A row mutation is not doc-undoable — history resets with the new doc.
        setHistory({ past: [], present: normalizeTimelineDoc(data.timeline), future: [] });
        setDirty(false);
        if (data.wavDurations) setWavDurations(data.wavDurations);
        // The per-scene WAVs changed on disk (split re-voices; duplicate adds a
        // file) — drop every cached Audio so the pool re-fetches lazily.
        for (const el of voPool.current.values()) el.pause();
        voPool.current.clear();
        setBrokenVo(new Set());
        if (data.newIndex != null) {
          setSelected(data.newIndex);
          const fresh = data.timeline.scenes.find((s) => s.index === data.newIndex);
          if (fresh) {
            setPlaying(false);
            seek(fresh.startSec + 0.001);
          }
        } else {
          setSelected(null);
          setPlaying(false);
          seek(Math.min(playhead, Math.max(0, data.timeline.totalDurationSec - 0.001)));
        }
        bump(); // repaint the preview with the refreshed pools
        onSaved?.(); // the parent refreshes the row (the scene list gains/loses a scene)
        toast({
          title:
            action === "split" ? "Scene split" : action === "duplicate" ? "Scene duplicated" : "Scene deleted",
          description: data.activity,
        });
      } catch (err) {
        toast({
          title: "Clip operation failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      } finally {
        setClipBusy(null);
      }
    },
    [
      timeline,
      clipBusy,
      saving,
      loading,
      renderInFlight,
      activeClip,
      playheadInClip,
      dirty,
      save,
      videoId,
      playhead,
      wavDurations,
      settings.frameRate,
      seek,
      bump,
      onSaved,
      toast,
    ]
  );

  // Two-step delete: the first press arms, the second within 4s executes.
  // Arming clears when the target changes or any other op runs.
  useEffect(() => {
    if (!deleteArmed) return;
    const t = setTimeout(() => setDeleteArmed(false), 4000);
    return () => clearTimeout(t);
  }, [deleteArmed]);

  useEffect(() => {
    setDeleteArmed(false);
  }, [activeClip?.index]);

  // ---------- the preview canvas ----------

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Lanes region — ctrl/⌘ + wheel zooms; needs a NON-passive listener or the
  // browser treats it as pinch-zoom and the preventDefault is ignored.
  const lanesWrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = lanesWrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      setDensity((d) =>
        Math.min(DENSITY_MAX, Math.max(DENSITY_MIN, Math.round(d * (e.deltaY < 0 ? 1.15 : 1 / 1.15))))
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 });

  // The preview wrapper only exists once a timeline is loaded (the whole
  // surface renders inside that branch) — so the observer must (re)attach
  // when the timeline arrives, not just on first mount. A [] dep would
  // leave wrapRef.current null forever on a studio that mounted without one.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setCanvasSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [timeline]);

  const draw = useCallback(() => {
    // mediaVersion is a redraw TRIGGER (image/video pool load or error) —
    // consumed here so the dependency is real, not decorative.
    void mediaVersion;
    const canvas = canvasRef.current;
    if (!canvas || !timeline || canvasSize.w < 10) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = canvasSize.w;
    const H = canvasSize.h;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const f = resolveFrame(playhead, timeline, settings);
    if (!f) return;

    const drawLayer = (idx: number, localSec: number, cam: { scale: number; dx: number; dy: number }) => {
      const img = imagePool.current.get(idx);
      const vid = stockPool.current.get(idx);
      const src: HTMLImageElement | HTMLVideoElement | null =
        img && img.complete && img.naturalWidth > 0
          ? img
          : vid && vid.readyState >= 2
            ? vid
            : null;
      if (!src) {
        // Slate: no art yet (or still loading) — title card, honest about it.
        const sc = scenesByIdx.get(idx);
        ctx.fillStyle = "#0b0d12";
        ctx.fillRect(0, 0, W, H);
        ctx.strokeStyle = "rgba(255,255,255,0.12)";
        ctx.lineWidth = 1;
        ctx.strokeRect(8.5, 8.5, W - 17, H - 17);
        const fs = Math.max(12, Math.round(H * 0.05));
        ctx.font = `600 ${fs}px "Noto Sans SC", system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "rgba(255,255,255,0.85)";
        ctx.fillText(sc?.title ?? `Scene ${idx}`, W / 2, H / 2 - fs * 0.3, W * 0.86);
        ctx.font = `500 ${Math.round(fs * 0.7)}px "Noto Sans SC", system-ui, sans-serif`;
        ctx.fillStyle = "rgba(255,255,255,0.4)";
        ctx.fillText("no art loaded for this scene", W / 2, H / 2 + fs * 0.8);
        return;
      }
      const sw = "naturalWidth" in src ? src.naturalWidth : src.videoWidth;
      const sh = "naturalHeight" in src ? src.naturalHeight : src.videoHeight;
      if (!sw || !sh) return;
      // Video elements follow the playhead coarsely (a seek per ~0.5s of
      // drift) — exact frame sync during playback is not worth the seeks.
      if (src instanceof HTMLVideoElement) {
        if (Math.abs(src.currentTime - localSec) > 0.5) {
          try {
            src.currentTime = localSec;
          } catch {
            /* not seekable yet */
          }
        }
        if (playing && src.paused) void src.play().catch(() => {});
        if (!playing && !src.paused) src.pause();
      }
      const cover = Math.max(W / sw, H / sh);
      const s = cover * cam.scale;
      const dw = sw * s;
      const dh = sh * s;
      ctx.drawImage(src, (W - dw) / 2 + cam.dx * W, (H - dh) / 2 + cam.dy * H, dw, dh);
    };

    const black = (a: number) => {
      ctx.fillStyle = `rgba(0,0,0,${a})`;
      ctx.fillRect(0, 0, W, H);
    };
    const white = (a: number) => {
      ctx.fillStyle = `rgba(255,255,255,${a})`;
      ctx.fillRect(0, 0, W, H);
    };

    const p = f.blend?.progress ?? 0;
    if (f.blend && f.layers.length === 2) {
      const [out, inn] = f.layers;
      const drawOut = () => drawLayer(out.sceneIndex, out.localSec, out.camera);
      const drawIn = () => drawLayer(inn.sceneIndex, inn.localSec, inn.camera);
      switch (f.blend.style) {
        case "fade":
        case "dissolve":
        case "hblur":
        case "radial":
        case "pixelize":
          // Approximated as a crossfade (noted in the module docs).
          drawOut();
          ctx.globalAlpha = p;
          drawIn();
          ctx.globalAlpha = 1;
          break;
        case "fadeblack":
          if (p < 0.5) {
            drawOut();
            black(p * 2);
          } else {
            drawIn();
            black((1 - p) * 2);
          }
          break;
        case "fadewhite":
          if (p < 0.5) {
            drawOut();
            white(p * 2);
          } else {
            drawIn();
            white((1 - p) * 2);
          }
          break;
        case "wipeleft":
          drawOut();
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, 0, W * p, H);
          ctx.clip();
          drawIn();
          ctx.restore();
          break;
        case "wiperight":
          drawOut();
          ctx.save();
          ctx.beginPath();
          ctx.rect(W * (1 - p), 0, W * p, H);
          ctx.clip();
          drawIn();
          ctx.restore();
          break;
        case "smoothup":
          drawOut();
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, H * (1 - p), W, H * p);
          ctx.clip();
          drawIn();
          ctx.restore();
          break;
        case "smoothdown":
          drawOut();
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, 0, W, H * p);
          ctx.clip();
          drawIn();
          ctx.restore();
          break;
        case "circleopen": {
          drawOut();
          ctx.save();
          ctx.beginPath();
          ctx.arc(W / 2, H / 2, p * Math.hypot(W, H) / 2, 0, Math.PI * 2);
          ctx.clip();
          drawIn();
          ctx.restore();
          break;
        }
        case "slideleft":
          ctx.save();
          ctx.translate(-W * p, 0);
          drawOut();
          ctx.restore();
          ctx.save();
          ctx.translate(W * (1 - p), 0);
          drawIn();
          ctx.restore();
          break;
        case "slideright":
          ctx.save();
          ctx.translate(W * p, 0);
          drawOut();
          ctx.restore();
          ctx.save();
          ctx.translate(-W * (1 - p), 0);
          drawIn();
          ctx.restore();
          break;
        default:
          drawOut();
          ctx.globalAlpha = p;
          drawIn();
          ctx.globalAlpha = 1;
      }
    } else {
      const layer = f.layers[0];
      if (layer) drawLayer(layer.sceneIndex, layer.localSec, layer.camera);
    }

    // Burned captions — mirrors the render's subtitle geometry (phone-first
    // face size, high-contrast outline, inside the safe zone).
    if (f.caption) {
      const vertical = settings.aspectRatio !== "16:9";
      const fs = Math.max(11, Math.round(H * (vertical ? 0.042 : 0.055)));
      ctx.font = `600 ${fs}px "Noto Sans SC", system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      const maxW = W * 0.86;
      const words = f.caption.split(/\s+/);
      const lines: string[] = [];
      let line = "";
      for (const w of words) {
        const attempt = line ? `${line} ${w}` : w;
        if (ctx.measureText(attempt).width > maxW && line) {
          lines.push(line);
          line = w;
          if (lines.length === 3) break;
        } else {
          line = attempt;
        }
      }
      if (line && lines.length < 3) lines.push(line);
      const lh = fs * 1.25;
      const bottom = H - Math.round(H * (vertical ? 0.075 : 0.032));
      ctx.lineJoin = "round";
      for (let i = 0; i < Math.min(3, lines.length); i++) {
        const y = bottom - (Math.min(3, lines.length) - 1 - i) * lh;
        ctx.lineWidth = Math.max(2, fs * 0.18);
        ctx.strokeStyle = "rgba(0,0,0,0.72)";
        ctx.strokeText(lines[i], W / 2, y);
        ctx.fillStyle = "#ffffff";
        ctx.fillText(lines[i], W / 2, y);
      }
    }
  }, [playhead, timeline, settings, canvasSize, playing, scenesByIdx, mediaVersion]);

  useEffect(() => {
    draw();
  }, [draw]);

  // ---------- keyboard transport + shortcuts ----------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // Text-entry surfaces own their keys entirely.
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      )
        return;
      // A focused BUTTON keeps only Enter (it clicks the button). Every other
      // key — Space (transport), ⌘Z/⌘S, S/D/⌫ (clip ops), arrows (frames) —
      // is the studio's; the switch's preventDefault suppresses the browser's
      // Space-activates-button default. (The old guard inverted this: it let
      // Space through and swallowed everything else, killing S/D/⌫ in the
      // most common flow — click a clip (a button), then razor it.)
      if (target && target.tagName === "BUTTON" && e.key === "Enter") return;
      if (!timeline || loading || saving || clipBusy) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (dirty) void save();
        return;
      }
      switch (e.key) {
        case " ":
          e.preventDefault();
          if (playhead >= total - 0.001) setPlayhead(0);
          setPlaying((v) => !v);
          break;
        case "s":
        case "S":
          e.preventDefault();
          void clipOp("split");
          break;
        case "d":
        case "D":
          e.preventDefault();
          void clipOp("duplicate");
          break;
        case "Backspace":
        case "Delete":
          e.preventDefault();
          if (deleteArmed) {
            void clipOp("delete");
          } else if (activeClip) {
            setDeleteArmed(true);
            toast({
              title: "Press ⌫ again to delete",
              description: `Scene ${activeClip.index} will leave the row everywhere — this is not undoable.`,
            });
          } else {
            toast({ title: "Select a clip first", description: "Click a clip in the lanes, or park the playhead over one." });
          }
          break;
        case "ArrowLeft":
          e.preventDefault();
          stepFrame(-1, e.shiftKey);
          break;
        case "ArrowRight":
          e.preventDefault();
          stepFrame(1, e.shiftKey);
          break;
        case "Home":
          e.preventDefault();
          setPlaying(false);
          setPlayhead(0);
          break;
        case "End":
          e.preventDefault();
          setPlaying(false);
          setPlayhead(Math.max(0, total - 0.001));
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [timeline, loading, saving, clipBusy, dirty, total, playhead, undo, redo, save, stepFrame, clipOp, deleteArmed, activeClip]);

  // ---------- render gate ----------

  if (!canAssemble) return null; // the Studio is for scene videos with a voiceover

  const selectedScene = timeline?.scenes.find((s) => s.index === selected) ?? null;
  const contentW = Math.max(total * density + 32, 320);

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-4">
      {/* header */}
      <header className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Scissors className="h-4 w-4 text-primary/80" />
          <h3 className="text-sm font-semibold">Timeline Studio</h3>
          {timeline && (
            <Badge variant="outline" className="text-[10px] font-mono">
              {timeline.sceneCount} scenes · {timeline.totalDurationSec.toFixed(1)}s
            </Badge>
          )}
          {dirty && (
            <Badge className="text-[10px] bg-amber-500/15 text-amber-200 border-amber-500/30">
              unsaved
            </Badge>
          )}
        </div>
        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={undo} disabled={!canUndo || saving || loading} title="Undo (⌘Z)">
            <Undo2 className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="ghost" onClick={redo} disabled={!canRedo || saving || loading} title="Redo (⌘⇧Z)">
            <Redo2 className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="ghost" onClick={reset} disabled={!timeline || saving || loading} title="Reset to loaded state">
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
          <span className="h-5 w-px bg-white/10 mx-1" aria-hidden />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void assemble()}
            disabled={loading || saving || renderInFlight}
            title="Re-assemble from current scenes + plan (replaces edits)"
          >
            <RefreshCw className={clsx("h-3.5 w-3.5", loading && "animate-spin")} />
            <span className="ml-1.5 text-xs">Re-assemble</span>
          </Button>
          <Button
            size="sm"
            onClick={() => void save()}
            disabled={!dirty || saving || renderInFlight || !timeline}
            title="Save (⌘S) — trims and order are honored by the render"
          >
            <Save className="h-3.5 w-3.5" />
            <span className="ml-1.5 text-xs">{saving ? "Saving…" : "Save"}</span>
          </Button>
        </div>
      </header>

      {!timeline ? (
        <div className="py-8 text-center text-xs text-muted-foreground">
          {loading ? "Loading the timeline…" : 'No timeline yet. Click "Re-assemble" to build one.'}
        </div>
      ) : timeline.scenes.length === 0 ? (
        <div className="py-8 text-center text-xs text-muted-foreground">
          The timeline has no scenes. Generate the script + storyboard first.
        </div>
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
            {/* preview + transport */}
            <div className="space-y-3 min-w-0">
              <div
                ref={wrapRef}
                className="relative mx-auto w-full overflow-hidden rounded-lg border border-white/10 bg-black"
                style={
                  settings.aspectRatio === "9:16"
                    ? { aspectRatio: "9 / 16", maxWidth: Math.round(420 * (9 / 16)) }
                    : settings.aspectRatio === "1:1"
                      ? { aspectRatio: "1 / 1", maxWidth: 420 }
                      : { aspectRatio: "16 / 9" }
                }
              >
                <canvas ref={canvasRef} className="block h-full w-full" aria-label="Timeline preview" />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="ghost" onClick={() => seek(0)} title="Start (Home)">
                    <SkipBack className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      if (playhead >= total - 0.001) setPlayhead(0);
                      setPlaying((v) => !v);
                    }}
                    title="Play/Pause (Space)"
                  >
                    {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => seek(Math.max(0, total - 0.001))} title="End (End)">
                    <SkipForward className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => stepFrame(-1)} title="Previous frame (←)">
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => stepFrame(1)} title="Next frame (→)">
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <span className="h-5 w-px bg-white/10 mx-0.5" aria-hidden />
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void clipOp("split")}
                    disabled={!playheadInClip || clipBusy != null || saving || loading || renderInFlight}
                    title="Split at the playhead (S) — park the playhead mid-narration; both halves are re-voiced with the video's own voice"
                  >
                    <Scissors className={clsx("h-3.5 w-3.5", clipBusy === "split" && "animate-pulse")} />
                    <span className="ml-1.5 text-xs">{clipBusy === "split" ? "Splitting…" : "Split"}</span>
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void clipOp("duplicate")}
                    disabled={activeClip == null || clipBusy != null || saving || loading || renderInFlight}
                    title="Duplicate the selected clip (D) — same read, same art, a fresh scene in the row"
                  >
                    <Copy className={clsx("h-3.5 w-3.5", clipBusy === "duplicate" && "animate-pulse")} />
                    <span className="ml-1.5 text-xs">{clipBusy === "duplicate" ? "Copying…" : "Duplicate"}</span>
                  </Button>
                  <Button
                    size="sm"
                    variant={deleteArmed ? "destructive" : "ghost"}
                    onClick={() => {
                      if (deleteArmed) {
                        void clipOp("delete");
                      } else if (activeClip) {
                        setDeleteArmed(true);
                        toast({
                          title: "Press again to delete",
                          description: `Scene ${activeClip.index} will leave the row everywhere — this is not undoable.`,
                        });
                      } else {
                        toast({ title: "Select a clip first", description: "Click a clip in the lanes, or park the playhead over one." });
                      }
                    }}
                    disabled={activeClip == null || clipBusy != null || saving || loading || renderInFlight}
                    title={deleteArmed ? "Confirm delete (⌫)" : "Delete the selected clip (⌫) — removes the scene from the row; not undoable"}
                  >
                    <Trash2 className={clsx("h-3.5 w-3.5", clipBusy === "delete" && "animate-pulse")} />
                    <span className="ml-1.5 text-xs">
                      {clipBusy === "delete" ? "Deleting…" : deleteArmed ? "Confirm" : "Delete"}
                    </span>
                  </Button>
                </div>
                <span className="font-mono text-xs tabular-nums text-foreground/90">
                  {formatTimecode(playhead, settings.frameRate)}
                  <span className="text-muted-foreground"> / {formatTimecode(total, settings.frameRate)}</span>
                </span>
                <div className="ml-auto flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setDensity((d) => Math.max(DENSITY_MIN, Math.round(d / 1.4)))}
                    title="Zoom out"
                  >
                    <ZoomOut className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setDensity((d) => Math.min(DENSITY_MAX, Math.round(d * 1.4)))}
                    title="Zoom in"
                  >
                    <ZoomIn className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      const el = wrapRef.current;
                      if (!el || total <= 0) return;
                      const w = el.getBoundingClientRect().width;
                      setDensity(Math.min(DENSITY_MAX, Math.max(DENSITY_MIN, (w - 48) / total)));
                    }}
                    title="Fit the whole video"
                  >
                    <Maximize2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                Live preview — approximate camera &amp; blends; narration synced from the real per-scene
                WAVs. The render (ffmpeg) stays the source of truth.
                Split re-voices both halves with the video's own voice; duplicate/delete move the row,
                the merged voiceover and the doc together.
                {brokenVo.size > 0 && " Some scene voiceovers are missing — those scenes preview silently."}
              </p>
            </div>

            {/* inspector */}
            {selectedScene ? (
              <Inspector
                scene={selectedScene}
                scenesMeta={scenesByIdx.get(selectedScene.index) ?? null}
                disabled={saving || loading || renderInFlight}
                onDuration={(v) => patchScene(selectedScene.index, { durationSec: v }, { key: `dur:${selectedScene.index}` })}
                onTransition={(v) => setTransitionIn(selectedScene.index, v)}
                onCaption={(v) => patchScene(selectedScene.index, { caption: v ? { ...v } : null }, { key: `cap:${selectedScene.index}` })}
                onAudio={(track, level) => setAudioLevel(selectedScene.index, track, level)}
                onSeekScene={(t) => {
                  setPlaying(false);
                  seek(t);
                }}
              />
            ) : (
              <div className="hidden lg:flex rounded-lg border border-dashed border-white/10 items-center justify-center p-6 text-center text-xs text-muted-foreground">
                Select a clip to edit its timing, transition, caption and mix.
              </div>
            )}
          </div>

          {/* lanes */}
          <div
            ref={lanesWrapRef}
            className="relative overflow-x-auto rounded-lg border border-white/10 bg-black/20"
          >
            <div className="relative" style={{ width: contentW }}>
              {/* ruler */}
              <Ruler total={total} density={density} value={playhead} onSeek={seek} />
              {/* lanes */}
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                <SortableContext
                  items={timeline.scenes.map((s) => String(s.index))}
                  strategy={horizontalListSortingStrategy}
                >
                  <div className="space-y-1.5 pb-2 pr-4">
                    <LaneLabelRow />
                    {timeline.scenes.map((scene) => (
                      <SceneClipRow
                        key={scene.index}
                        scene={scene}
                        meta={scenesByIdx.get(scene.index) ?? null}
                        density={density}
                        selected={selected === scene.index}
                        disabled={saving || loading || renderInFlight}
                        narration={speakableSpan(
                          scene.startSec,
                          scene.durationSec,
                          wavDurations[scene.index]
                        )}
                        onSelect={() => {
                          setSelected(scene.index);
                          setPlaying(false);
                          seek(scene.startSec + 0.001);
                        }}
                        onTrim={(dur, mode) => trimScene(scene.index, dur, mode)}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
              {/* playhead */}
              <div
                className="pointer-events-none absolute top-0 bottom-0 z-20 w-px bg-primary/90"
                style={{ left: playhead * density }}
              >
                <span className="absolute -left-[5px] top-0 h-2.5 w-2.5 rotate-45 bg-primary/90 rounded-[2px]" />
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ---------- ruler ----------

function Ruler({
  total,
  density,
  value,
  onSeek,
}: {
  total: number;
  density: number;
  value: number;
  onSeek: (t: number) => void;
}) {
  const step = density < 36 ? 5 : density < 72 ? 2 : 1; // labeled seconds
  const ticks: { t: number; major: boolean }[] = [];
  const minorStep = density >= 90 ? 0.5 : density >= 45 ? 1 : step;
  for (let t = 0; t <= total + 0.001; t += minorStep) {
    const rounded = Math.round(t * 100) / 100;
    if (rounded > total) break;
    ticks.push({ t: rounded, major: Math.abs(rounded % step) < 0.001 });
  }
  const label = (t: number) => {
    const s = Math.round(t);
    const mm = Math.floor(s / 60);
    const ss = s % 60;
    return `${mm}:${String(ss).padStart(2, "0")}`;
  };
  const seeking = useRef(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const seekFromEvent = (clientX: number) => {
    const el = ref.current;
    if (!el) return;
    const x = clientX - el.getBoundingClientRect().left;
    onSeek(Math.max(0, x / density));
  };
  return (
    <div
      ref={ref}
      role="slider"
      aria-label="Playhead position"
      aria-valuemin={0}
      aria-valuemax={Math.round(total * 10) / 10}
      aria-valuenow={Math.round(value * 10) / 10}
      tabIndex={0}
      className="relative h-7 cursor-ew-resize select-none border-b border-white/10 bg-white/[0.02]"
      onPointerDown={(e) => {
        seeking.current = true;
        // Seek FIRST — pointer capture is an optimization (drag scrubbing
        // stays smooth outside the element), never a precondition: a capture
        // failure on an exotic pointer must not swallow the seek.
        seekFromEvent(e.clientX);
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* synthetic/unknown pointer id — drag still works via move events */
        }
      }}
      onPointerMove={(e) => {
        if (seeking.current) seekFromEvent(e.clientX);
      }}
      onPointerUp={() => {
        seeking.current = false;
      }}
      onPointerCancel={() => {
        seeking.current = false;
      }}
    >
      {ticks.map((tk) => (
        <span
          key={tk.t}
          className={clsx("absolute top-0", tk.major ? "text-[9px] text-muted-foreground" : "text-transparent")}
          style={{ left: tk.t * density }}
        >
          <span
            className={clsx(
              "absolute w-px",
              tk.major ? "h-3 bg-white/40" : "h-1.5 bg-white/20"
            )}
            style={{ left: 0 }}
          />
          {tk.major && (
            <span className="absolute left-1.5 top-2.5 font-mono tabular-nums" style={{ lineHeight: "10px" }}>
              {label(tk.t)}
            </span>
          )}
        </span>
      ))}
    </div>
  );
}

// ---------- lanes ----------

function LaneLabelRow() {
  return (
    <div className="flex items-center gap-3 pt-1 pb-0.5 text-[9px] uppercase tracking-[0.14em] text-muted-foreground/80">
      <span className="flex items-center gap-1">
        <Scissors className="h-2.5 w-2.5" /> video
      </span>
      <span className="flex items-center gap-1">
        <AudioLines className="h-2.5 w-2.5" /> voice
      </span>
      <span className="flex items-center gap-1">
        <Subtitles className="h-2.5 w-2.5" /> captions
      </span>
      <span className="flex items-center gap-1 text-muted-foreground/50">
        <Music2 className="h-2.5 w-2.5" /> music bed is per-video (Settings)
      </span>
    </div>
  );
}

interface SceneClipRowProps {
  scene: TimelineSceneDTO;
  meta: SceneDTO | null;
  density: number;
  selected: boolean;
  disabled: boolean;
  /** Where the spoken read lives inside this window — the razor's legal
   *  cut range, shown as the bright band on the voice clip. */
  narration: SpeakableSpan | null;
  onSelect: () => void;
  onTrim: (durationSec: number, mode: "push" | "replace") => void;
}

function SceneClipRow({ scene, meta, density, selected, disabled, narration, onSelect, onTrim }: SceneClipRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: String(scene.index),
  });
  const [trimming, setTrimming] = useState(false);
  const trimGesture = useRef(false); // first move pushes history; the rest replace

  const startTrim = (e: React.PointerEvent) => {
    if (disabled) return;
    e.stopPropagation();
    e.preventDefault();
    setTrimming(true);
    trimGesture.current = false;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const moveTrim = (e: React.PointerEvent) => {
    if (!trimming || disabled) return;
    const next = Math.min(300, Math.max(0.5, Math.round((scene.durationSec + e.movementX / density) * 10) / 10));
    if (next !== scene.durationSec) {
      // First applied move opens the undo step; the rest of the gesture
      // replaces the present — one drag, one undo.
      const mode: "push" | "replace" = trimGesture.current ? "replace" : "push";
      trimGesture.current = true;
      onTrim(next, mode);
    }
  };

  const endTrim = () => {
    setTrimming(false);
    trimGesture.current = false;
  };

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const w = Math.max(10, scene.durationSec * density);
  const art = meta?.imageUrl ?? null;

  return (
    <div
      ref={setNodeRef}
      style={{ ...style, paddingLeft: scene.startSec * density }}
      className="relative"
    >
      {/* video clip */}
      <div
        className={clsx(
          "group relative overflow-hidden rounded-md border bg-white/[0.04]",
          selected ? "border-primary ring-1 ring-primary/40" : "border-white/10",
          isDragging && "opacity-60 z-10",
          trimming && "select-none"
        )}
        style={{ width: w, height: LANE_H_VIDEO }}
      >
        {art && (
          <img src={art} alt="" className="absolute inset-0 h-full w-full object-cover opacity-80" draggable={false} />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/30 to-black/10" />
        <div className="relative flex h-full items-start gap-1.5 p-1.5 pr-10">
          <button
            type="button"
            className="touch-none text-muted-foreground/80 hover:text-foreground"
            aria-label="Drag to reorder"
            {...attributes}
            {...listeners}
          >
            <GripVertical className="h-3.5 w-3.5" />
          </button>
          <button type="button" className="flex-1 min-w-0 text-left" onClick={onSelect} disabled={disabled}>
            <div className="truncate text-[11px] font-medium leading-tight text-white/95 drop-shadow">
              {scene.title || `Scene ${scene.index}`}
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[9px] font-mono text-white/70">
              <Clock className="h-2.5 w-2.5" />
              {scene.durationSec.toFixed(1)}s
              {scene.transitionIn && (
                <span className="rounded bg-white/15 px-1 py-px">{scene.transitionIn}</span>
              )}
              {scene.source === "stock" && (
                <span className="rounded bg-emerald-500/20 px-1 py-px text-emerald-200">stock</span>
              )}
              {scene.source === "slides" && (
                <span className="rounded bg-sky-500/20 px-1 py-px text-sky-200">slide</span>
              )}
            </div>
          </button>
        </div>
        {/* trim handle — right edge = this scene's duration. The left seam
            belongs to the PREVIOUS scene (durations are sequential); the
            inspector's numeric field covers sub-0.5 fine-tuning. */}
        <button
          type="button"
          className={clsx(
            "absolute right-0 top-0 h-full w-2.5 cursor-ew-resize touch-none opacity-0 transition-opacity",
            "bg-primary/0 hover:bg-primary/25 group-hover:opacity-100",
            trimming && "opacity-100 bg-primary/30"
          )}
          aria-label="Trim scene duration"
          title="Drag to trim (0.5–300s)"
          disabled={disabled}
          onPointerDown={startTrim}
          onPointerMove={moveTrim}
          onPointerUp={endTrim}
          onPointerCancel={endTrim}
        />
      </div>
      {/* voice clip */}
      <div
        className={clsx(
          "absolute rounded border px-1.5 flex items-center gap-1 text-[9px] font-mono",
          scene.audio.voice.enabled && scene.audio.voice.level > 0
            ? "border-sky-400/30 bg-sky-400/10 text-sky-200"
            : "border-white/10 bg-white/[0.02] text-muted-foreground/60 line-through"
        )}
        style={{ left: 0, top: LANE_H_VIDEO + 6, width: w, height: LANE_H_AUDIO - 4 }}
        onClick={onSelect}
        title={
          narration
            ? `Narration runs ${narration.startSec.toFixed(1)}–${narration.endSec.toFixed(
                1
              )}s — the razor (S) cuts inside this band`
            : "No speakable narration in this scene — the razor refuses"
        }
      >
        {scene.audio.voice.enabled && scene.audio.voice.level > 0 ? (
          <Volume2 className="h-2.5 w-2.5 shrink-0" />
        ) : (
          <VolumeX className="h-2.5 w-2.5 shrink-0" />
        )}
        <span className="truncate">{scene.audio.voice.enabled ? `vo ${Math.round(scene.audio.voice.level * 100)}%` : "muted"}</span>
        {/* the spoken read — the razor's legal cut range. Lead silence and
            tail breathing room stay dim; the band is where words are. */}
        {narration && (
          <span
            aria-hidden
            className="absolute bottom-0 left-0 h-[3px] rounded-b-sm bg-sky-300/80"
            style={{
              marginLeft: (narration.startSec - scene.startSec) * density,
              width: Math.max(2, (narration.endSec - narration.startSec) * density),
            }}
          />
        )}
      </div>
      {/* caption clip */}
      {scene.caption?.text && (
        <div
          className="absolute rounded border border-amber-400/25 bg-amber-400/10 px-1.5 flex items-center text-[9px] italic text-amber-100/90"
          style={{ left: 0, top: LANE_H_VIDEO + 6 + LANE_H_AUDIO + 2, width: w, height: LANE_H_AUDIO - 4 }}
          onClick={onSelect}
        >
          <span className="truncate">“{scene.caption.text}”</span>
        </div>
      )}
    </div>
  );
}

// ---------- inspector ----------

interface InspectorProps {
  scene: TimelineSceneDTO;
  scenesMeta: SceneDTO | null;
  disabled: boolean;
  onDuration: (v: number) => void;
  onTransition: (style: string) => void;
  onCaption: (c: { text: string; startSec: number; endSec: number } | null) => void;
  onAudio: (track: "voice" | "music" | "sfx" | "ambient", level: number) => void;
  onSeekScene: (t: number) => void;
}

const PREVIEW_ONLY = (
  <Badge
    variant="outline"
    className="text-[9px] border-sky-400/30 bg-sky-400/10 text-sky-200 shrink-0"
    title="Live in the preview and saved with the doc; the render reads these from S2."
  >
    preview
  </Badge>
);

function Inspector({ scene, scenesMeta, disabled, onDuration, onTransition, onCaption, onAudio, onSeekScene }: InspectorProps) {
  const shot = scene.shot;
  return (
    <div className="space-y-3 rounded-lg border border-white/10 bg-white/[0.02] p-3">
      <div className="flex items-center gap-2">
        <Badge variant="secondary" className="text-[10px] font-mono">#{scene.index}</Badge>
        <button
          type="button"
          className="truncate text-left text-sm font-medium hover:underline"
          onClick={() => onSeekScene(scene.startSec + 0.001)}
          title="Jump the playhead to this scene"
        >
          {scene.title || `Scene ${scene.index}`}
        </button>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
          {scene.startSec.toFixed(1)}–{scene.endSec.toFixed(1)}s
        </span>
      </div>

      {/* timing */}
      <section className="space-y-1.5">
        <header className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
          <Clock className="h-3 w-3" /> Timing
          <span className="ml-auto rounded bg-emerald-500/15 px-1.5 py-px text-[9px] normal-case tracking-normal text-emerald-200">
            render honors
          </span>
        </header>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={0.5}
            max={300}
            step={0.1}
            disabled={disabled}
            value={Math.round(scene.durationSec * 10) / 10}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v >= 0.5 && v <= 300) onDuration(Math.round(v * 10) / 10);
            }}
            className="h-7 w-24 font-mono text-xs"
            aria-label="Scene duration in seconds"
          />
          <span className="text-xs text-muted-foreground">sec</span>
          <div className="ml-auto flex gap-1">
            <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onDuration(Math.max(0.5, scene.durationSec - 0.5))} title="−0.5s">
              −0.5
            </Button>
            <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onDuration(Math.min(300, scene.durationSec + 0.5))} title="+0.5s">
              +0.5
            </Button>
          </div>
        </div>
      </section>

      {/* transition */}
      <section className="space-y-1.5">
        <header className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
          <Scissors className="h-3 w-3" /> Transition in {PREVIEW_ONLY}
        </header>
        <Select
          value={scene.transitionIn ?? "cut"}
          onValueChange={onTransition}
          disabled={disabled}
        >
          <SelectTrigger className="h-7 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TRANSITIONS.map((t) => (
              <SelectItem key={t.id} value={t.id} className="text-xs">
                {t.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[10px] leading-snug text-muted-foreground">
          The seam into this scene. Video-level default lives in Render controls.
        </p>
      </section>

      {/* caption */}
      <section className="space-y-1.5">
        <header className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
          <Subtitles className="h-3 w-3" /> Caption {PREVIEW_ONLY}
        </header>
        <Textarea
          rows={2}
          disabled={disabled}
          value={scene.caption?.text ?? ""}
          placeholder="No caption — type one for this scene"
          onChange={(e) => {
            const text = e.target.value.slice(0, 220);
            onCaption(text ? { text, startSec: scene.startSec, endSec: scene.endSec } : null);
          }}
          className="text-xs leading-snug"
        />
      </section>

      {/* audio */}
      <section className="space-y-2">
        <header className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
          <AudioLines className="h-3 w-3" /> Mix {PREVIEW_ONLY}
        </header>
        {(
          [
            ["voice", "Voice"],
            ["music", "Music bed"],
            ["sfx", `SFX${scene.audio.sfx.kind ? ` (${scene.audio.sfx.kind})` : ""}`],
            ["ambient", `Ambience${scene.audio.ambient.kind ? ` (${scene.audio.ambient.kind})` : ""}`],
          ] as const
        ).map(([track, label]) => (
          <div key={track} className="flex items-center gap-2">
            <span className="w-24 shrink-0 text-[10px] text-muted-foreground">{label}</span>
            <Slider
              className="h-1.5 flex-1"
              value={[Math.round((scene.audio[track].level ?? 0) * 100)]}
              min={0}
              max={100}
              step={5}
              disabled={disabled}
              onValueChange={(v) => onAudio(track, (v[0] ?? 0) / 100)}
            />
            <span className="w-9 text-right font-mono text-[10px] text-muted-foreground">
              {Math.round((scene.audio[track].level ?? 0) * 100)}%
            </span>
          </div>
        ))}
      </section>

      {/* meta */}
      {(shot || scenesMeta?.stockQuery || scene.stockQuery) && (
        <section className="space-y-1 border-t border-white/10 pt-2 text-[10px] text-muted-foreground">
          {shot && (
            <p>
              <span className="text-foreground/70">Shot:</span> {shot.framing ?? "—"} · {shot.camera ?? "—"}
              {shot.motion ? ` · ${shot.motion}` : ""}
            </p>
          )}
          {(scene.stockQuery || scenesMeta?.stockQuery) && (
            <p>
              <span className="text-foreground/70">Stock:</span> {scene.stockQuery ?? scenesMeta?.stockQuery} (
              {scene.stockSource ?? scenesMeta?.stockSource ?? "—"})
            </p>
          )}
          <p className="line-clamp-2 italic leading-snug opacity-80">{scene.narration}</p>
        </section>
      )}
    </div>
  );
}
