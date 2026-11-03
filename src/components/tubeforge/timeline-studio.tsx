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
//   • per-scene transition styles → S2: the render consumes the doc's
//     transitionIn seam by seam (cut seams become hard stitch points; the
//     blend math is per-boundary in transitions.ts).
//   • per-scene captions → S2: edited text replaces that scene's cues in
//     BOTH caption paths (smart/ASR + one-per-scene fallback).
//   • per-scene audio levels → S2: voice/SFX/ambience are the segment mix
//     weights; music rides the library bed as a per-scene volume automation.
//     The synthesized-drone fallback keeps its fixed profile (it never had
//     a slider) — the inspector's Mix note says so.
//   • per-scene GRADE → S2 wave 2: the segment's finishing filter (eq +
//     colorbalance + vignette); null = the classic look, scene by scene.
//   • per-scene TITLE overlay → S2 wave 2: drawtext on the segment, animated.
//   • per-scene CAMERA KEYS → S2 wave 2: a two-key zoompan plan that
//     outranks the Director's auto camera for that scene (Ken Burns only).
//   • per-scene SPEED → S2 wave 2: narration atempo'd at render (no words
//     lost), footage setpts'd, the duration floor shrinks by the rate.
//   • per-scene voice fades → S2 wave 2: afade on the narration WAV, anchored
//     to its measured (compressed) end; drag the voice clip's edge handles.
//   • per-scene ARTWORK → S4: the inspector drives the row's scene assets —
//     re-roll, instruction-based AI edit, user upload, per-scene stock
//     re-pick (with an optional user search phrase). Row assets, not doc
//     fields: the render reads art by scene index, the doc never moves.
//     Slides mode hides the section (the deck owns the look).
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
  Layers,
  PictureInPicture2,
  FileText,
  Mic,
  Loader2,
  Wand2,
  ImagePlus,
  Film,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
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
  GRADE_PRESETS,
  sanitizeGrade,
  sanitizeTitle,
  sanitizeCamera,
  sanitizeSpeed,
  sanitizeChroma,
  sanitizePip,
  CHROMA_PRESETS,
  type SceneGrade,
  type SceneTitle,
  type SceneCameraKeys,
  type SceneChroma,
  type ScenePip,
} from "@/lib/tubeforge/studio-doc";
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

type ClipAction = "split" | "duplicate" | "delete" | "revoice";

/** POST /studio/assist — the AI editor's suggestions (server contract). */
interface AssistSuggestionDTO {
  sceneIndex: number;
  kind: "transition" | "grade" | "title" | "note";
  value: string;
  reason: string;
}

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
      // S2 wave 2 — the creative layer deep-copies too (one undo step = one
      // coherent document, never a shared reference into the past).
      grade: s.grade ? { ...s.grade } : s.grade,
      titleOverlay: s.titleOverlay ? { ...s.titleOverlay } : s.titleOverlay,
      cameraKeys: s.cameraKeys
        ? { from: { ...s.cameraKeys.from }, to: { ...s.cameraKeys.to }, ease: s.cameraKeys.ease }
        : s.cameraKeys,
      speed: s.speed,
      // S3 — keying + overlay deep-copy with the rest of the creative layer.
      chroma: s.chroma ? { ...s.chroma } : s.chroma,
      pip: s.pip ? { ...s.pip } : s.pip,
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
        // S2 wave 2 — the creative layer re-sanitized at the load choke
        // point (same studio-doc functions the render's extractor calls).
        grade: sanitizeGrade(s.grade),
        titleOverlay: sanitizeTitle(s.titleOverlay),
        cameraKeys: sanitizeCamera(s.cameraKeys),
        speed: sanitizeSpeed(s.speed),
        // S3 — keying + overlay, same choke point.
        chroma: sanitizeChroma(s.chroma),
        pip: sanitizePip(s.pip),
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
  /** S3 — timestamp of the last successful save (manual or auto); drives
   *  the quiet “saved” note next to the Save button. */
  const [savedAt, setSavedAt] = useState<number | null>(null);
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

  const save = useCallback(
    async (opts?: { silent?: boolean }) => {
      const silent = opts?.silent === true;
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
        setSavedAt(Date.now());
        onSaved?.();
        // Autosaves stay quiet (a toast every 2.5 s of editing is noise);
        // failures ALWAYS surface — a silent lost save is the worst outcome.
        if (!silent)
          toast({ title: "Timeline saved", description: "The render will honor your trims and order." });
      } catch (err) {
        toast({
          title: silent ? "Autosave failed" : "Save failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      } finally {
        setSaving(false);
      }
    },
    [videoId, timeline, dirty, onSaved, toast]
  );

  // S3 — autosave: 2.5 s after the last edit, silently. ⌘S stays instant and
  // toasts; the debounce resets on every further edit, and renders/loads
  // suspend it (a save racing a server-side clip op would clobber its doc).
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!dirty || !timeline || saving || loading || renderInFlight) return;
    autosaveTimer.current = setTimeout(() => void save({ silent: true }), 2500);
    return () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    };
  }, [timeline, dirty, saving, loading, renderInFlight, save]);

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

  /** S2 wave 2 — narration fades (drag gestures on the voice clip's edges;
   *  one drag = one undo step via the mode the row signals). */
  const setVoiceFade = useCallback(
    (index: number, which: "in" | "out", sec: number, mode: "push" | "replace") => {
      if (!timeline) return;
      const next = cloneTimeline(timeline);
      const i = next.scenes.findIndex((s) => s.index === index);
      if (i === -1) return;
      next.scenes[i] = {
        ...next.scenes[i],
        audio: {
          ...next.scenes[i].audio,
          voice: {
            ...next.scenes[i].audio.voice,
            [which === "in" ? "fadeInSec" : "fadeOutSec"]: sec,
          },
        },
      };
      applyEdit(next, mode);
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
  // S3 — per-scene keyed-art cache (chroma) + the brand logo for PIP.
  const keyedArtPool = useRef(new Map<string, HTMLCanvasElement>());
  const logoImg = useRef<HTMLImageElement | null>(null);
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

  // S3 — the brand logo streams from /brand once any scene asks for a PIP
  // overlay (per-video object; one load, cached for the session).
  useEffect(() => {
    const wantsPip = timeline?.scenes.some((s) => s.pip != null) ?? false;
    if (!wantsPip || !video.brandHasLogo || logoImg.current) return;
    const img = new Image();
    img.onload = bump;
    img.onerror = bump;
    img.src = `/api/videos/${videoId}/brand`;
    logoImg.current = img;
  }, [timeline, video.brandHasLogo, videoId, bump]);

  // ---------- preview audio pool (per-scene voiceover WAVs) ----------

  const voPool = useRef(new Map<number, HTMLAudioElement>());
  /** Bumped by clip ops (which re-voice/re-copy WAVs on disk) so the
   *  waveform cache refetches — the pool reset alone covers playback. */
  const [wavVersion, setWavVersion] = useState(0);

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
    // S2 wave 2 — the doc's playback rate rides the preview element too.
    el.playbackRate = Math.min(2, Math.max(0.5, scene.speed ?? 1));
    // Fade-aware gain: the render fades the WAV itself (in from 0, out
    // before its measured end, compressed by any speed) — mirror the ramps
    // approximately from the doc's fields + the server's measured lengths.
    let gain = Math.min(1, Math.max(0, level));
    const t = el.currentTime; // wav-local seconds
    const fin = scene.audio.voice.fadeInSec ?? 0;
    const fout = scene.audio.voice.fadeOutSec ?? 0;
    const wavLen = wavDurations[scene.index];
    const compressed = wavLen && scene.speed ? wavLen / scene.speed : wavLen;
    if (fin > 0.02 && t < fin) gain *= Math.max(0, t / fin);
    if (fout > 0.02 && compressed && t > compressed - fout)
      gain *= Math.max(0, (compressed - t) / fout);
    el.volume = Math.min(1, Math.max(0, gain));
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
  }, [playhead, playing, timeline, settings, videoId, brokenVo, wavDurations]);

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
    async (action: ClipAction, extra?: { narration?: string }) => {
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
            ...(action === "revoice" ? { narration: extra?.narration ?? "" } : {}),
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
        setWavVersion((v) => v + 1); // the waveform cache refetches too
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
            action === "split"
              ? "Scene split"
              : action === "duplicate"
                ? "Scene duplicated"
                : action === "revoice"
                  ? "Scene re-voiced"
                  : "Scene deleted",
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

    // S2 wave 2 — the doc's per-scene creative layer in the preview.
    // Approximate by contract: the filter() model is multiplicative where
    // the render's eq is additive, and the vignette is a radial gradient —
    // the RENDER stays the source of truth; this is the honest rough cut.
    const gradeOf = (idx: number): SceneGrade | null | undefined =>
      timeline.scenes.find((s) => s.index === idx)?.grade;
    // S3 — the scene's chroma settings (approximated in the preview: still
    // art is keyed per-pixel into a cached offscreen canvas; stock footage
    // draws unkeyed — the render stays the source of truth).
    const chromaOf = (idx: number): SceneChroma | null | undefined =>
      timeline.scenes.find((s) => s.index === idx)?.chroma;
    const keyedArt = (idx: number, c: SceneChroma, src: HTMLImageElement): HTMLCanvasElement => {
      const key = `${idx}|${c.color}|${c.similarity.toFixed(3)}|${c.blend.toFixed(3)}|${mediaVersion}`;
      const hit = keyedArtPool.current.get(key);
      if (hit) return hit;
      const cv = document.createElement("canvas");
      cv.width = src.naturalWidth;
      cv.height = src.naturalHeight;
      const cctx = cv.getContext("2d");
      if (!cctx || cv.width < 1 || cv.height < 1) return cv;
      cctx.drawImage(src, 0, 0);
      try {
        const data = cctx.getImageData(0, 0, cv.width, cv.height);
        const kr = parseInt(c.color.slice(1, 3), 16);
        const kg = parseInt(c.color.slice(3, 5), 16);
        const kb = parseInt(c.color.slice(5, 7), 16);
        // Euclidean RGB distance ≈ the render's chroma distance for preview.
        const thr = c.similarity * 441.7;
        const soft = Math.max(1, c.blend * 441.7);
        const px = data.data;
        for (let i = 0; i < px.length; i += 4) {
          const d = Math.hypot(px[i] - kr, px[i + 1] - kg, px[i + 2] - kb);
          if (d < thr) px[i + 3] = 0;
          else if (d < thr + soft) px[i + 3] = Math.round((255 * (d - thr)) / soft);
        }
        cctx.putImageData(data, 0, 0);
      } catch {
        /* tainted canvas — fall back to the unkeyed image */
      }
      keyedArtPool.current.set(key, cv);
      return cv;
    };
    const applyGradeFilter = (g: SceneGrade | null | undefined) => {
      if (!g) return;
      ctx.filter = `brightness(${g.brightness}) contrast(${g.contrast}) saturate(${g.saturation})`;
    };
    const applyGradeOverlays = (g: SceneGrade | null | undefined) => {
      ctx.filter = "none";
      if (!g) return;
      if (Math.abs(g.temperature) > 0.01) {
        // Warm lifts toward amber, cool toward steel-blue.
        const warm = g.temperature > 0;
        ctx.fillStyle = warm
          ? `rgba(255,158,64,${(g.temperature * 0.13).toFixed(3)})`
          : `rgba(72,138,255,${(-g.temperature * 0.13).toFixed(3)})`;
        ctx.fillRect(0, 0, W, H);
      }
      if (g.vignette > 0.01) {
        const grad = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.42, W / 2, H / 2, Math.hypot(W, H) / 2);
        grad.addColorStop(0, "rgba(0,0,0,0)");
        grad.addColorStop(1, `rgba(0,0,0,${(g.vignette * 0.6).toFixed(3)})`);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, H);
      }
    };

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
      // S3 — chroma key on still art: background fill, then the keyed cache.
      const chroma = chromaOf(idx);
      if (chroma && src instanceof HTMLImageElement) {
        const keyed = keyedArt(idx, chroma, src);
        if (keyed.width > 1) {
          ctx.fillStyle = chroma.background;
          ctx.fillRect(0, 0, W, H);
          const kcover = Math.max(W / keyed.width, H / keyed.height) * cam.scale;
          const kw = keyed.width * kcover;
          const kh = keyed.height * kcover;
          const g = gradeOf(idx);
          applyGradeFilter(g);
          ctx.drawImage(keyed, (W - kw) / 2 + cam.dx * W, (H - kh) / 2 + cam.dy * H, kw, kh);
          applyGradeOverlays(g);
          return;
        }
      }
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
      const g = gradeOf(idx);
      applyGradeFilter(g);
      ctx.drawImage(src, (W - dw) / 2 + cam.dx * W, (H - dh) / 2 + cam.dy * H, dw, dh);
      applyGradeOverlays(g);
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

    // S3 — the active scene's corner logo overlay, mirroring
    // pipOverlayFilter's geometry (drawn under the title, like the render).
    const activeScene = timeline.scenes.find((s) => s.index === f.activeIndex);
    const pip = activeScene?.pip;
    const logo = logoImg.current;
    if (pip && activeScene && logo && logo.complete && logo.naturalWidth > 0) {
      const lw = Math.max(24, Math.round(W * pip.size));
      const lh = Math.round((lw * logo.naturalHeight) / logo.naturalWidth);
      const m = Math.round(W * pip.margin);
      const x = pip.pos.endsWith("l") ? m : pip.pos.endsWith("r") ? W - lw - m : (W - lw) / 2;
      const y = pip.pos.startsWith("t") ? m : pip.pos.startsWith("b") ? H - lh - m : (H - lh) / 2;
      ctx.globalAlpha = pip.opacity;
      ctx.drawImage(logo, x, y, lw, lh);
      if (pip.border) {
        ctx.strokeStyle = "rgba(255,255,255,0.9)";
        ctx.lineWidth = Math.max(1, Math.round(W * 0.002));
        ctx.strokeRect(x + 0.5, y + 0.5, lw - 1, lh - 1);
      }
      ctx.globalAlpha = 1;
    }

    // S2 wave 2 — the scene's title overlay, mirroring titleDrawtextFilter's
    // geometry (face relative to frame height, safe-zone margins) and the
    // animation curves (fade 0.4s in / 0.5s out, rise & slide ease-out).
    const ti = activeScene?.titleOverlay;
    if (ti && activeScene) {
      const D = Math.max(activeScene.durationSec, 0.5);
      const lt = f.localSec;
      let alpha = 1;
      let offY = 0;
      let offX = 0;
      if (ti.anim !== "none") {
        const fin = Math.min(1, lt / 0.4);
        const fout = lt > D - 0.5 ? Math.max(0, (D - lt) / 0.5) : 1;
        alpha = Math.min(fin, fout);
        if (ti.anim === "rise") offY = 40 * Math.pow(1 - Math.min(lt / 0.6, 1), 2) * (H / 480);
        if (ti.anim === "slide") offX = 0.12 * Math.pow(1 - Math.min(lt / 0.55, 1), 2) * W;
      }
      const vertical = settings.aspectRatio !== "16:9";
      const face = Math.max(12, Math.round(H * (vertical ? 0.05 : 0.062) * ti.size));
      const margin = Math.round(H * (vertical ? 0.09 : 0.075));
      ctx.font = `600 ${face}px "Noto Sans SC", system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      const y = ti.pos === "top" ? margin + face : ti.pos === "center" ? H / 2 + face / 2 : H - margin - (vertical ? H * 0.02 : 0);
      const x = W / 2 - offX;
      ctx.globalAlpha = Math.min(1, Math.max(0, alpha));
      if (ti.style === "lower") {
        const m = ctx.measureText(ti.text);
        ctx.fillStyle = "rgba(0,0,0,0.45)";
        ctx.fillRect(x - m.width / 2 - face * 0.55, y - face * 1.28 + offY, m.width + face * 1.1, face * 1.66);
        ctx.fillStyle = "#ffffff";
        ctx.fillText(ti.text, x, y + offY);
      } else {
        const bw = ti.style === "outline" ? face * 0.2 : ti.style === "bold" ? face * 0.14 : face * 0.05;
        ctx.lineJoin = "round";
        ctx.lineWidth = Math.max(2, bw);
        ctx.strokeStyle = ti.style === "clean" ? "rgba(0,0,0,0.55)" : "rgba(0,0,0,0.92)";
        ctx.strokeText(ti.text, x, y + offY);
        ctx.fillStyle = "#ffffff";
        ctx.fillText(ti.text, x, y + offY);
      }
      ctx.globalAlpha = 1;
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

  // S3 — AI assist: one LLM pass over the SAVED doc (flush first, the clip-op
  // contract). Suggestions apply through the studio's own edit callbacks —
  // the model never writes the doc.
  const [assistBusy, setAssistBusy] = useState(false);
  const [assist, setAssist] = useState<AssistSuggestionDTO[] | null>(null);
  const runAssist = useCallback(async () => {
    if (!timeline || assistBusy || saving || loading || renderInFlight) return;
    setAssistBusy(true);
    try {
      if (dirty) await save();
      const res = await fetch(`/api/videos/${videoId}/studio/assist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = (await res.json()) as { suggestions?: AssistSuggestionDTO[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setAssist(data.suggestions ?? []);
      if (!data.suggestions?.length)
        toast({ title: "No suggestions", description: "The editor found nothing worth changing — the cut looks good." });
    } catch (err) {
      toast({
        title: "AI assist failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setAssistBusy(false);
    }
  }, [timeline, assistBusy, saving, loading, renderInFlight, dirty, save, videoId, toast]);

  /** Apply one suggestion through the studio's own edit callbacks. */
  const applySuggestion = useCallback(
    (s: AssistSuggestionDTO) => {
      if (s.kind === "transition") {
        setTransitionIn(s.sceneIndex, s.value);
      } else if (s.kind === "grade") {
        const preset = GRADE_PRESETS[s.value];
        if (preset) patchScene(s.sceneIndex, { grade: { ...preset } }, { key: `assist-grade:${s.sceneIndex}` });
      } else if (s.kind === "title") {
        patchScene(
          s.sceneIndex,
          { titleOverlay: { text: s.value, style: "clean", anim: "fade", pos: "bottom", size: 1 } },
          { key: `assist-title:${s.sceneIndex}` }
        );
      }
      setAssist((list) => (list ? list.filter((x) => x !== s) : list));
    },
    [setTransitionIn, patchScene]
  );

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
          {dirty ? (
            <Badge className="text-[10px] bg-amber-500/15 text-amber-200 border-amber-500/30">
              unsaved
            </Badge>
          ) : savedAt ? (
            <span
              className="text-[10px] text-muted-foreground"
              title="Autosaved 2.5 s after your last edit — ⌘S saves instantly"
            >
              saved {new Date(savedAt).toLocaleTimeString()}
            </span>
          ) : null}
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
            onClick={() => void runAssist()}
            disabled={!timeline || assistBusy || saving || loading || renderInFlight}
            title="One AI pass over the saved timeline — transition, grade, title and pacing suggestions you apply one by one"
          >
            {assistBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
            <span className="ml-1.5 text-xs">{assistBusy ? "Reviewing…" : "AI assist"}</span>
          </Button>
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

      {/* S3 — the AI assist panel: suggestions apply through the studio's own
          edit callbacks (never a doc write), each with its reason. */}
      {assist != null && assist.length > 0 && (
        <div className="space-y-1.5 rounded-lg border border-primary/25 bg-primary/[0.06] p-2.5">
          <div className="flex items-center gap-2">
            <Wand2 className="h-3.5 w-3.5 text-primary/80" />
            <span className="text-xs font-medium">Editor suggestions</span>
            <span className="text-[10px] text-muted-foreground">{assist.length} left</span>
            <button
              type="button"
              className="ml-auto text-[10px] text-muted-foreground hover:text-foreground"
              onClick={() => setAssist(null)}
            >
              dismiss
            </button>
          </div>
          <div className="max-h-44 space-y-1 overflow-y-auto">
            {assist.map((s, i) => (
              <div
                key={`${s.sceneIndex}-${s.kind}-${i}`}
                className="flex items-start gap-2 rounded-md border border-white/10 bg-white/[0.03] px-2 py-1.5"
              >
                <Badge variant="secondary" className="mt-px shrink-0 font-mono text-[9px]">
                  #{s.sceneIndex}
                </Badge>
                <Badge
                  variant="outline"
                  className="mt-px shrink-0 border-white/15 text-[9px] uppercase tracking-wide text-muted-foreground"
                >
                  {s.kind}
                </Badge>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs">
                    {s.kind === "transition" || s.kind === "grade" ? (
                      <span className="font-mono text-[11px] text-primary/90">{s.value}</span>
                    ) : s.kind === "title" ? (
                      <span className="italic">“{s.value}”</span>
                    ) : (
                      <span className="text-muted-foreground">pacing note</span>
                    )}
                  </div>
                  {s.reason && (
                    <div className="text-[10px] leading-snug text-muted-foreground">{s.reason}</div>
                  )}
                </div>
                {s.kind !== "note" && (
                  <Button
                    size="sm"
                    className="h-6 shrink-0 px-2 text-[10px]"
                    disabled={saving || renderInFlight}
                    onClick={() => applySuggestion(s)}
                    title="Apply through the studio's own edit path — undo works as usual"
                  >
                    Apply
                  </Button>
                )}
              </div>
            ))}
          </div>
          <p className="text-[10px] leading-snug text-muted-foreground">
            Suggestions are validated against the studio's catalogs and applied through the
            same edits a human click makes — ⌘Z undoes any of them.
          </p>
        </div>
      )}

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
                onGrade={(g) => patchScene(selectedScene.index, { grade: g }, { key: `grade:${selectedScene.index}` })}
                onTitle={(t) => patchScene(selectedScene.index, { titleOverlay: t }, { key: `title:${selectedScene.index}` })}
                onCamera={(c) => patchScene(selectedScene.index, { cameraKeys: c }, { key: `cam:${selectedScene.index}` })}
                onSpeed={(v) => patchScene(selectedScene.index, { speed: v }, { key: `speed:${selectedScene.index}` })}
                onChroma={(c) => patchScene(selectedScene.index, { chroma: c }, { key: `chroma:${selectedScene.index}` })}
                onPip={(p) => patchScene(selectedScene.index, { pip: p }, { key: `pip:${selectedScene.index}` })}
                onRevoice={(narration) => void clipOp("revoice", { narration })}
                revoicing={clipBusy === "revoice"}
                hasLogo={video.brandHasLogo}
                slidesMode={video.renderMode === "slides"}
                videoId={videoId}
                stockMode={video.renderMode === "stock"}
                onArtChanged={() => {
                  bump(); // the preview repaints with the new art on the next frame
                  onSaved?.(); // the parent refreshes the row (fresh SceneDTOs)
                }}
              />
            ) : (
              <div className="hidden lg:flex rounded-lg border border-dashed border-white/10 items-center justify-center p-6 text-center text-xs text-muted-foreground">
                Select a clip to edit its timing, transition, caption, grade, title, camera and mix.
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
                        videoId={videoId}
                        wavVersion={wavVersion}
                        onSelect={() => {
                          setSelected(scene.index);
                          setPlaying(false);
                          seek(scene.startSec + 0.001);
                        }}
                        onTrim={(dur, mode) => trimScene(scene.index, dur, mode)}
                        onFade={(index, which, sec, mode) => setVoiceFade(index, which, sec, mode)}
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
  videoId: string;
  /** Bumped on every row-mutating clip op — the waveform cache refetches. */
  wavVersion: number;
  onSelect: () => void;
  onTrim: (durationSec: number, mode: "push" | "replace") => void;
  /** S2 wave 2 — narration fade handles on the voice clip's edges. */
  onFade: (index: number, which: "in" | "out", sec: number, mode: "push" | "replace") => void;
}

function SceneClipRow({ scene, meta, density, selected, disabled, narration, videoId, wavVersion, onSelect, onTrim, onFade }: SceneClipRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: String(scene.index),
  });
  const [trimming, setTrimming] = useState(false);
  const trimGesture = useRef(false); // first move pushes history; the rest replace
  const [fadeWhich, setFadeWhich] = useState<"in" | "out" | null>(null);
  const fadeGesture = useRef(false);

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

  // S2 wave 2 — narration fade handles: drag the clip's edge triangles to
  // shape the read's head/tail (the render afades the WAV at these seconds).
  const startFade = (which: "in" | "out") => (e: React.PointerEvent) => {
    if (disabled) return;
    e.stopPropagation();
    e.preventDefault();
    setFadeWhich(which);
    fadeGesture.current = false;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const moveFade = (which: "in" | "out") => (e: React.PointerEvent) => {
    if (fadeWhich !== which || disabled) return;
    const cur = (which === "in" ? scene.audio.voice.fadeInSec : scene.audio.voice.fadeOutSec) ?? 0;
    const next = Math.min(3, Math.max(0, Math.round((cur + e.movementX / density) * 10) / 10));
    if (next !== cur) {
      const mode: "push" | "replace" = fadeGesture.current ? "replace" : "push";
      fadeGesture.current = true;
      onFade(scene.index, which, next, mode);
    }
  };
  const endFade = () => {
    setFadeWhich(null);
    fadeGesture.current = false;
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
        <span className="truncate">
          {scene.audio.voice.enabled ? `vo ${Math.round(scene.audio.voice.level * 100)}%` : "muted"}
          {(scene.audio.voice.fadeInSec ?? 0) >= 0.1 || (scene.audio.voice.fadeOutSec ?? 0) >= 0.1
            ? ` · fade ${((scene.audio.voice.fadeInSec ?? 0) || 0).toFixed(1)}/${((scene.audio.voice.fadeOutSec ?? 0) || 0).toFixed(1)}`
            : ""}
          {scene.speed ? ` · ${scene.speed.toFixed(2)}×` : ""}
        </span>
        {/* S2 wave 2 — the narration's real shape, drawn from the WAV. */}
        <VoiceWaveform
          videoId={videoId}
          sceneIndex={scene.index}
          version={wavVersion}
          width={Math.max(10, w - 8)}
          height={LANE_H_AUDIO - 8}
          dim={!(scene.audio.voice.enabled && scene.audio.voice.level > 0)}
        />
        {/* fade ramps — the shaded wedges the handles control. */}
        {(scene.audio.voice.fadeInSec ?? 0) >= 0.1 && (
          <span
            aria-hidden
            className="pointer-events-none absolute left-0 top-0 h-full"
            style={{
              width: (scene.audio.voice.fadeInSec ?? 0) * density,
              background: "linear-gradient(90deg, rgba(2,6,23,0.85), rgba(2,6,23,0))",
            }}
          />
        )}
        {(scene.audio.voice.fadeOutSec ?? 0) >= 0.1 && (
          <span
            aria-hidden
            className="pointer-events-none absolute right-0 top-0 h-full"
            style={{
              width: (scene.audio.voice.fadeOutSec ?? 0) * density,
              background: "linear-gradient(270deg, rgba(2,6,23,0.85), rgba(2,6,23,0))",
            }}
          />
        )}
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
        {/* fade handles — drag the clip's edges to shape the read's head/tail. */}
        <button
          type="button"
          aria-label="Narration fade in — drag right to add"
          title="Drag → fade the read in (0–3s)"
          disabled={disabled}
          onPointerDown={startFade("in")}
          onPointerMove={moveFade("in")}
          onPointerUp={endFade}
          onPointerCancel={endFade}
          className={clsx(
            "absolute left-0 top-0 z-10 h-full w-2 cursor-ew-resize touch-none",
            fadeWhich === "in" ? "bg-sky-300/40" : "opacity-0 hover:opacity-100 bg-sky-300/20"
          )}
        />
        <button
          type="button"
          aria-label="Narration fade out — drag left to add"
          title="Drag ← fade the read out (0–3s)"
          disabled={disabled}
          onPointerDown={startFade("out")}
          onPointerMove={moveFade("out")}
          onPointerUp={endFade}
          onPointerCancel={endFade}
          className={clsx(
            "absolute right-0 top-0 z-10 h-full w-2 cursor-ew-resize touch-none",
            fadeWhich === "out" ? "bg-sky-300/40" : "opacity-0 hover:opacity-100 bg-sky-300/20"
          )}
        />
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

// ---------- voice waveform (S2 wave 2) ----------

// Module-level cache: one decoded peak array per (video, scene, wavVersion).
// Clip ops bump wavVersion — the new key refetches, the old entry ages out.
const waveCache = new Map<string, Float32Array>();

async function loadPeaks(videoId: string, index: number, version: number): Promise<Float32Array | null> {
  const key = `${videoId}:${index}:${version}`;
  const hit = waveCache.get(key);
  if (hit) return hit;
  try {
    const res = await fetch(`/api/videos/${videoId}/vo/${index}`);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const AC: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    const ctx = new AC();
    const audio = await ctx.decodeAudioData(buf);
    const ch = audio.getChannelData(0);
    const buckets = 240;
    const peaks = new Float32Array(buckets);
    const per = Math.floor(ch.length / buckets) || 1;
    for (let b = 0; b < buckets; b++) {
      let max = 0;
      const start = b * per;
      // Stride sampling — 240 buckets over a multi-minute read is already
      // 60× below the sample count; striding keeps the decode cheap.
      for (let i = start; i < Math.min(start + per, ch.length); i += 16) {
        const v = Math.abs(ch[i]);
        if (v > max) max = v;
      }
      peaks[b] = max;
    }
    void ctx.close();
    waveCache.set(key, peaks);
    if (waveCache.size > 60) {
      const oldest = waveCache.keys().next().value;
      if (oldest) waveCache.delete(oldest);
    }
    return peaks;
  } catch {
    return null; // undecodable/missing — the lane stays text-only
  }
}

/** The narration's real shape inside the voice clip — the honest version of
 *  the bright band: where the words ARE, drawn from the WAV itself. */
function VoiceWaveform({
  videoId,
  sceneIndex,
  version,
  width,
  height,
  dim,
}: {
  videoId: string;
  sceneIndex: number;
  version: number;
  width: number;
  height: number;
  dim: boolean;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const [peaks, setPeaks] = useState<Float32Array | null>(
    () => waveCache.get(`${videoId}:${sceneIndex}:${version}`) ?? null
  );
  useEffect(() => {
    let alive = true;
    void loadPeaks(videoId, sceneIndex, version).then((p) => {
      if (alive) setPeaks(p);
    });
    return () => {
      alive = false;
    };
  }, [videoId, sceneIndex, version]);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !peaks || width < 8) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.round(width * dpr);
    const H = Math.round(height * dpr);
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = dim ? "rgba(125,211,252,0.25)" : "rgba(125,211,252,0.7)";
    const n = peaks.length;
    const bw = width / n;
    for (let i = 0; i < n; i++) {
      const h = Math.max(1, peaks[i] * (height - 2));
      ctx.fillRect(i * bw, (height - h) / 2, Math.max(bw - 0.5, 0.75), h);
    }
  }, [peaks, width, height, dim]);
  return (
    <canvas
      ref={ref}
      aria-hidden
      className="pointer-events-none absolute inset-x-0 bottom-0"
      style={{ width, height: height }}
    />
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
  /** S2 wave 2 — the creative layer. */
  onGrade: (g: SceneGrade | null) => void;
  onTitle: (t: SceneTitle | null) => void;
  onCamera: (c: SceneCameraKeys | null) => void;
  onSpeed: (v: number | null) => void;
  /** S3 — keying + overlay. */
  onChroma: (c: SceneChroma | null) => void;
  onPip: (p: ScenePip | null) => void;
  /** S3 — transcript editing: re-read the edited narration server-side. */
  onRevoice: (narration: string) => void;
  /** A re-voice is in flight (drives the button spinner). */
  revoicing: boolean;
  /** The video has a brand logo (PIP source). */
  hasLogo: boolean;
  /** Slides mode: the designed deck owns its look — chroma/PIP hidden. */
  slidesMode: boolean;
  /** S4 — art actions. The row's scene assets move; the doc does not. */
  videoId: string;
  /** Stock-footage render mode: per-scene clip re-pick is available. */
  stockMode: boolean;
  /** Called when an art action changed the row's assets (parent refresh). */
  onArtChanged: () => void;
}

const RENDER_HONORS = (
  <Badge
    variant="outline"
    className="text-[9px] border-emerald-400/30 bg-emerald-400/10 text-emerald-200 shrink-0"
    title="Saved with the doc and consumed by the render — what you edit here is what the MP4 plays."
  >
    render honors
  </Badge>
);

function Inspector({ scene, scenesMeta, disabled, onDuration, onTransition, onCaption, onAudio, onSeekScene, onGrade, onTitle, onCamera, onSpeed, onChroma, onPip, onRevoice, revoicing, hasLogo, slidesMode, videoId, stockMode, onArtChanged }: InspectorProps) {
  const shot = scene.shot;
  const grade = scene.grade ?? null;
  const ti = scene.titleOverlay ?? null;
  const cam = scene.cameraKeys ?? null;
  const chroma = scene.chroma ?? null;
  const pip = scene.pip ?? null;
  // S3 — the staged narration (transcript editing). Local until the explicit
  // re-voice: text edits NEVER land on the row without a matching audio read,
  // the two can never drift. Resets when the scene changes or the server's
  // copy updates (a re-voice rebuilds the doc).
  const [scriptDraft, setScriptDraft] = useState(scene.narration);
  useEffect(() => setScriptDraft(scene.narration), [scene.index, scene.narration]);
  const scriptChanged = scriptDraft.trim() !== scene.narration.trim();

  // ---------- art (S4) ----------
  // The clip's face lives on the ROW's scene assets; these actions call the
  // SAME pipelines the Scene Studio uses (re-roll / AI edit / upload / stock
  // re-pick) and watch their jobs. The doc never moves — the render reads
  // art by scene index.
  const { toast } = useToast();
  const [artBusy, setArtBusy] = useState<"reroll" | "edit" | "upload" | "stock" | null>(null);
  const [artEpoch, setArtEpoch] = useState(0); // thumbnail cache-buster per repaint
  const [aiOpen, setAiOpen] = useState(false);
  const [aiDraft, setAiDraft] = useState("");
  const [stockOpen, setStockOpen] = useState(false);
  const [stockDraft, setStockDraft] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);
  useEffect(() => stopPoll, [stopPoll]); // unmount
  useEffect(() => {
    // Scene switch: the poll watches the OLD scene's job to completion is
    // wrong here — stop, and drop the transient open/draft panels.
    stopPoll();
    setArtBusy(null);
    setAiOpen(false);
    setStockOpen(false);
  }, [scene.index, stopPoll]);

  const thumbUrl = scenesMeta?.imageUrl
    ? `${scenesMeta.imageUrl}${scenesMeta.imageUrl.includes("?") ? "&" : "?"}v=${artEpoch}`
    : null;
  const artDisabled = disabled || artBusy !== null || Boolean(scenesMeta?.generating);

  /** Watch a scene-image job (re-roll / AI edit) — the Scene Studio's exact
   *  contract: poll GET /storyboard every 3s until the scene's generating
   *  flag drops, bounded at ~8 min (the job's own retries outlast us). */
  const pollImageJob = useCallback(
    (index: number, kind: "reroll" | "edit") => {
      stopPoll();
      let ticks = 0;
      pollRef.current = setInterval(async () => {
        ticks += 1;
        try {
          const res = await fetch(`/api/videos/${videoId}/storyboard`, { cache: "no-store" });
          if (!res.ok) return; // transient — keep waiting
          const d = (await res.json()) as {
            scenes?: Array<{ index: number; generating: boolean }>;
            error?: string | null;
          };
          const s = (d.scenes ?? []).find((x) => x.index === index);
          if (s && !s.generating) {
            stopPoll();
            setArtBusy(null);
            setArtEpoch((v) => v + 1);
            onArtChanged();
            if (d.error) {
              toast({ title: `Scene ${index} art job failed`, description: d.error, variant: "destructive" });
            } else {
              toast({
                title: `Scene ${index} ${kind === "edit" ? "AI-edited" : "repainted"}`,
                description: "The new frame is on the timeline — the render reads it as this scene's art.",
              });
            }
          } else if (ticks > 160) {
            stopPoll();
            setArtBusy(null);
            toast({
              title: "Still working in the background",
              description: "The art job is taking unusually long — Scene Studio shows its progress.",
            });
          }
        } catch {
          /* transient network — keep waiting */
        }
      }, 3000);
    },
    [videoId, onArtChanged, stopPoll, toast]
  );

  /** Watch a per-scene stock job: GET /stock's sceneJobs flags. The honest
   *  outcome reads off the ROW (hasStock before → after), not internals. */
  const pollStockJob = useCallback(
    (index: number, hadStock: boolean) => {
      stopPoll();
      let ticks = 0;
      pollRef.current = setInterval(async () => {
        ticks += 1;
        try {
          const res = await fetch(`/api/videos/${videoId}/stock`, { cache: "no-store" });
          if (!res.ok) return;
          const d = (await res.json()) as {
            sceneJobs?: Record<string, boolean>;
            scenes?: Array<{ index: number; hasStock: boolean }>;
          };
          const running = Boolean(d.sceneJobs?.[String(index)]);
          if (!running) {
            stopPoll();
            setArtBusy(null);
            onArtChanged();
            const now = d.scenes?.find((x) => x.index === index)?.hasStock ?? false;
            if (now) {
              toast({
                title: `Scene ${index} stock clip ${hadStock ? "replaced" : "matched"}`,
                description: "The re-picked clip is on the row — the render reads it in stock mode.",
              });
            } else {
              toast({
                title: `Scene ${index} — no clip found`,
                description: "The search came back empty; the scene keeps its storyboard art.",
              });
            }
          } else if (ticks > 60) {
            stopPoll();
            setArtBusy(null);
            toast({
              title: "Still searching…",
              description: "The stock job is taking long — the Stock panel shows overall progress.",
            });
          }
        } catch {
          /* transient network — keep waiting */
        }
      }, 3000);
    },
    [videoId, onArtChanged, stopPoll, toast]
  );

  const onReroll = async () => {
    setArtBusy("reroll");
    try {
      const res = await fetch(`/api/videos/${videoId}/storyboard`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scene: scene.index }),
      });
      const d = (await res.json().catch(() => ({}))) as { accepted?: boolean; error?: string };
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      if (!d.accepted) toast({ title: "An art job for this scene is already running — watching it" });
      pollImageJob(scene.index, "reroll");
    } catch (e) {
      setArtBusy(null);
      toast({ title: "Re-roll failed", description: e instanceof Error ? e.message : "try again", variant: "destructive" });
    }
  };

  const onAiEdit = async () => {
    const instruction = aiDraft.trim();
    if (instruction.length < 3) return;
    setArtBusy("edit");
    try {
      const res = await fetch(`/api/videos/${videoId}/storyboard`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scene: scene.index, instruction }),
      });
      const d = (await res.json().catch(() => ({}))) as { accepted?: boolean; error?: string };
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      pollImageJob(scene.index, "edit");
    } catch (e) {
      setArtBusy(null);
      toast({ title: "AI edit failed", description: e instanceof Error ? e.message : "try again", variant: "destructive" });
    }
  };

  const onUploadFile = async (file: File | null) => {
    if (!file) return;
    setArtBusy("upload");
    try {
      const form = new FormData();
      form.set("scene", String(scene.index));
      form.set("file", file);
      const res = await fetch(`/api/videos/${videoId}/storyboard/upload`, {
        method: "POST",
        body: form,
      });
      const d = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      setArtBusy(null);
      setArtEpoch((v) => v + 1);
      onArtChanged();
      toast({
        title: `Scene ${scene.index} now uses your artwork`,
        description: "Renders were invalidated — render again to rebuild the video.",
      });
    } catch (e) {
      setArtBusy(null);
      toast({ title: "Upload failed", description: e instanceof Error ? e.message : "try again", variant: "destructive" });
    }
  };

  const onStock = async () => {
    setArtBusy("stock");
    const hadStock = Boolean(scenesMeta?.hasStock);
    try {
      const res = await fetch(`/api/videos/${videoId}/stock/${scene.index}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(stockDraft.trim() ? { query: stockDraft.trim() } : {}),
      });
      const d = (await res.json().catch(() => ({}))) as { accepted?: boolean; error?: string };
      if (!res.ok) throw new Error(d.error ?? `HTTP ${res.status}`);
      pollStockJob(scene.index, hadStock);
    } catch (e) {
      setArtBusy(null);
      toast({ title: "Stock re-pick failed", description: e instanceof Error ? e.message : "try again", variant: "destructive" });
    }
  };

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

      {/* script / transcript — S3 */}
      <section className="space-y-1.5">
        <header className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
          <FileText className="h-3 w-3" /> Script {RENDER_HONORS}
        </header>
        <Textarea
          value={scriptDraft}
          disabled={disabled || revoicing}
          onChange={(e) => setScriptDraft(e.target.value)}
          className="min-h-[72px] text-xs leading-relaxed"
          aria-label="Scene narration"
        />
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground">
            {scriptDraft.trim().split(/\s+/).filter(Boolean).length} words
            {scriptChanged
              ? ` · was ${scene.narration.trim().split(/\s+/).filter(Boolean).length}`
              : ""}
          </span>
          <Button
            size="sm"
            className="ml-auto h-7"
            disabled={disabled || revoicing || !scriptDraft.trim() || !scriptChanged}
            onClick={() => onRevoice(scriptDraft.trim())}
            title="Synthesize a fresh read of the edited text with this video's own voice and pace"
          >
            {revoicing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Mic className="h-3 w-3" />}
            <span className="ml-1.5 text-xs">Re-voice scene</span>
          </Button>
        </div>
        <p className="text-[10px] leading-snug text-muted-foreground">
          Editing the script re-reads the scene with the video's own voice — the
          row, the scene WAV, the timeline window and the merged voiceover update
          in one server step. Custom-audio videos re-attach per-scene audio first.
        </p>
      </section>

      {/* artwork — S4: the clip's face. Re-roll / AI edit / upload / stock
          re-pick, all through the pipelines the Scene Studio uses. The
          thumbnail busts its cache per repaint (the art URL is static). */}
      {!slidesMode && (
        <section className="space-y-1.5">
          <header className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
            <ImagePlus className="h-3 w-3" /> Artwork
            <span className="ml-auto rounded bg-amber-500/15 px-1.5 py-px text-[9px] normal-case tracking-normal text-amber-200">
              row asset
            </span>
          </header>
          <div className="flex gap-2">
            <div className="relative h-[52px] w-[92px] shrink-0 overflow-hidden rounded border border-white/10 bg-black/40">
              {thumbUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={thumbUrl} alt={`Scene ${scene.index} artwork`} className="h-full w-full object-cover" />
              ) : (
                <div className="grid h-full place-items-center text-[9px] text-muted-foreground">no art yet</div>
              )}
              {(artBusy || scenesMeta?.generating) && (
                <div className="absolute inset-0 grid place-items-center bg-black/55">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-white" />
                </div>
              )}
            </div>
            <div className="flex min-w-0 flex-1 flex-wrap content-start items-center gap-1">
              <Button size="sm" variant="outline" className="h-7" disabled={artDisabled} onClick={() => void onReroll()} title="Paint a fresh take from the scene's prompt">
                {artBusy === "reroll" ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                <span className="ml-1 text-xs">New take</span>
              </Button>
              <Button size="sm" variant="outline" className="h-7" disabled={artDisabled} onClick={() => setAiOpen((v) => !v)} title="Edit the current image with an instruction">
                <Sparkles className="h-3 w-3" />
                <span className="ml-1 text-xs">AI edit</span>
              </Button>
              <Button size="sm" variant="outline" className="h-7" disabled={artDisabled} onClick={() => fileRef.current?.click()} title="Replace with your own artwork (cover-cropped to the canvas)">
                {artBusy === "upload" ? <Loader2 className="h-3 w-3 animate-spin" /> : <ImagePlus className="h-3 w-3" />}
                <span className="ml-1 text-xs">Upload</span>
              </Button>
              {stockMode && (
                <Button size="sm" variant="outline" className="h-7" disabled={artDisabled} onClick={() => setStockOpen((v) => !v)} title="Re-search stock footage for this scene">
                  {artBusy === "stock" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Film className="h-3 w-3" />}
                  <span className="ml-1 text-xs">Re-pick clip</span>
                </Button>
              )}
            </div>
          </div>
          {aiOpen && (
            <div className="space-y-1.5 rounded border border-white/10 p-2">
              <Input
                value={aiDraft}
                onChange={(e) => setAiDraft(e.target.value)}
                placeholder='e.g. "make it night", "warmer light", "empty street"'
                className="h-7 text-xs"
                maxLength={500}
                aria-label="AI edit instruction"
              />
              <div className="flex justify-end gap-1">
                <Button size="sm" variant="ghost" className="h-6" onClick={() => { setAiOpen(false); setAiDraft(""); }}>
                  Cancel
                </Button>
                <Button size="sm" className="h-6" disabled={artDisabled || aiDraft.trim().length < 3} onClick={() => void onAiEdit()}>
                  {artBusy === "edit" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                  <span className="ml-1 text-xs">Apply edit</span>
                </Button>
              </div>
            </div>
          )}
          {stockOpen && stockMode && (
            <div className="space-y-1.5 rounded border border-white/10 p-2">
              <Input
                value={stockDraft}
                onChange={(e) => setStockDraft(e.target.value)}
                placeholder={scenesMeta?.stockQuery ? `was: ${scenesMeta.stockQuery}` : 'Search with your own words — e.g. "city timelapse night"'}
                className="h-7 text-xs"
                maxLength={120}
                aria-label="Stock search phrase"
              />
              <div className="flex justify-end gap-1">
                <Button size="sm" variant="ghost" className="h-6" onClick={() => { setStockOpen(false); setStockDraft(""); }}>
                  Cancel
                </Button>
                <Button size="sm" className="h-6" disabled={artDisabled} onClick={() => void onStock()}>
                  {artBusy === "stock" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Film className="h-3 w-3" />}
                  <span className="ml-1 text-xs">{stockDraft.trim() ? "Search this" : "Re-pick"}</span>
                </Button>
              </div>
            </div>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => {
              void onUploadFile(e.target.files?.[0] ?? null);
              e.currentTarget.value = ""; // re-picking the same file re-fires
            }}
          />
          <p className="text-[10px] leading-snug text-muted-foreground">
            Art is a row asset (scene-{String(scene.index).padStart(2, "0")} on disk), not a doc
            field — these actions run the same pipelines as Scene Studio and
            keep the narration and window untouched. The render reads the art
            by scene index.
            {!stockMode && " Stock re-pick appears when the render mode is stock footage."}
          </p>
        </section>
      )}

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
          <Scissors className="h-3 w-3" /> Transition in {RENDER_HONORS}
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
          The seam into this scene — the render blends it exactly; “Hard Cut” stitches with no blend.
          Video-level default lives in Render controls.
        </p>
      </section>

      {/* caption */}
      <section className="space-y-1.5">
        <header className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
          <Subtitles className="h-3 w-3" /> Caption {RENDER_HONORS}
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
        <p className="text-[10px] leading-snug text-muted-foreground">
          Edited text replaces this scene's burned cues (smart captions too).
        </p>
      </section>

      {/* grade — S2 wave 2 */}
      <section className="space-y-2">
        <header className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
          <span className="h-3 w-3 rounded-sm bg-gradient-to-br from-amber-300 to-rose-400" /> Grade {RENDER_HONORS}
        </header>
        <div className="flex flex-wrap gap-1">
          {Object.entries(GRADE_PRESETS).map(([id, p]) => (
            <Button
              key={id}
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => onGrade({ ...p })}
              className="h-6 px-2 text-[10px] capitalize"
            >
              {id}
            </Button>
          ))}
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled || !grade}
            onClick={() => onGrade(null)}
            className="h-6 px-2 text-[10px]"
            title="Back to the classic look"
          >
            reset
          </Button>
        </div>
        {(
          [
            ["brightness", "Bright", 0.5, 1.5, 0.02],
            ["contrast", "Contrast", 0.5, 1.5, 0.02],
            ["saturation", "Saturate", 0, 2, 0.05],
            ["temperature", "Temp", -1, 1, 0.05],
            ["vignette", "Vignette", 0, 1, 0.05],
          ] as const
        ).map(([key, label, min, max, step]) => (
          <div key={key} className="flex items-center gap-2">
            <span className="w-16 shrink-0 text-[10px] text-muted-foreground">{label}</span>
            <Slider
              className="h-1.5 flex-1"
              value={[grade ? Math.round((grade[key] as number) * 100) : key === "temperature" || key === "vignette" ? 0 : 100]}
              min={Math.round(min * 100)}
              max={Math.round(max * 100)}
              step={Math.round(step * 100)}
              disabled={disabled}
              onValueChange={(v) =>
                onGrade({
                  brightness: grade?.brightness ?? 1,
                  contrast: grade?.contrast ?? 1,
                  saturation: grade?.saturation ?? 1,
                  temperature: grade?.temperature ?? 0,
                  vignette: grade?.vignette ?? 0,
                  [key]: (v[0] ?? 0) / 100,
                })
              }
            />
            <span className="w-9 text-right font-mono text-[10px] text-muted-foreground">
              {grade ? Math.round((grade[key] as number) * 100) : 100}%
            </span>
          </div>
        ))}
        <p className="text-[10px] leading-snug text-muted-foreground">
          Per-scene color over the AI art (Ken Burns + stock). No pick = the classic look; slides keep their tuned deck.
        </p>
      </section>

      {/* title overlay — S2 wave 2 */}
      <section className="space-y-1.5">
        <header className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
          <span className="font-black leading-none text-sm text-primary/80">T</span> Title {RENDER_HONORS}
        </header>
        <Input
          disabled={disabled}
          value={ti?.text ?? ""}
          maxLength={90}
          placeholder="No title — type a headline for this scene"
          onChange={(e) => {
            const text = e.target.value;
            onTitle(
              text.trim()
                ? { text, style: ti?.style ?? "clean", anim: ti?.anim ?? "fade", pos: ti?.pos ?? "bottom", size: ti?.size ?? 1 }
                : null
            );
          }}
          className="h-7 text-xs"
          aria-label="Title text"
        />
        {ti && (
          <div className="grid grid-cols-2 gap-1.5">
            <Select
              value={ti.style}
              disabled={disabled}
              onValueChange={(v) => onTitle({ ...ti, style: v as SceneTitle["style"] })}
            >
              <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="clean" className="text-xs">Clean</SelectItem>
                <SelectItem value="bold" className="text-xs">Bold</SelectItem>
                <SelectItem value="outline" className="text-xs">Outline</SelectItem>
                <SelectItem value="lower" className="text-xs">Lower third</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={ti.anim}
              disabled={disabled}
              onValueChange={(v) => onTitle({ ...ti, anim: v as SceneTitle["anim"] })}
            >
              <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none" className="text-xs">No motion</SelectItem>
                <SelectItem value="fade" className="text-xs">Fade</SelectItem>
                <SelectItem value="rise" className="text-xs">Rise</SelectItem>
                <SelectItem value="slide" className="text-xs">Slide</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={ti.pos}
              disabled={disabled}
              onValueChange={(v) => onTitle({ ...ti, pos: v as SceneTitle["pos"] })}
            >
              <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="top" className="text-xs">Top</SelectItem>
                <SelectItem value="center" className="text-xs">Center</SelectItem>
                <SelectItem value="bottom" className="text-xs">Bottom</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex items-center gap-2">
              <Slider
                className="h-1.5 flex-1"
                value={[Math.round(ti.size * 100)]}
                min={50}
                max={150}
                step={5}
                disabled={disabled}
                onValueChange={(v) => onTitle({ ...ti, size: (v[0] ?? 100) / 100 })}
              />
              <span className="w-8 text-right font-mono text-[10px] text-muted-foreground">{Math.round(ti.size * 100)}%</span>
            </div>
          </div>
        )}
        <p className="text-[10px] leading-snug text-muted-foreground">
          Burned onto this scene's frames, animated in/out — under the caption track.
        </p>
      </section>

      {/* camera keyframes — S2 wave 2 */}
      <section className="space-y-2">
        <header className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
          <span className="text-sm leading-none">◆</span> Camera keys {RENDER_HONORS}
        </header>
        {(
          [
            ["from", "Start"],
            ["to", "End"],
          ] as const
        ).map(([key, label]) => {
          const k = cam?.[key] ?? { scale: 1, x: 0.5, y: 0.5 };
          return (
            <div key={key} className="space-y-1 rounded-md border border-white/10 p-2">
              <div className="text-[10px] font-medium text-foreground/80">{label} framing</div>
              {(
                [
                  ["scale", "Zoom", 1, 2.2],
                  ["x", "Pan X", 0, 1],
                  ["y", "Pan Y", 0, 1],
                ] as const
              ).map(([field, label2, min, max]) => (
                <div key={field} className="flex items-center gap-2">
                  <span className="w-12 shrink-0 text-[10px] text-muted-foreground">{label2}</span>
                  <Slider
                    className="h-1 flex-1"
                    value={[Math.round(k[field] * 100)]}
                    min={Math.round(min * 100)}
                    max={Math.round(max * 100)}
                    step={5}
                    disabled={disabled}
                    onValueChange={(v) =>
                      onCamera({
                        from: cam?.from ?? { scale: 1, x: 0.5, y: 0.5 },
                        to: cam?.to ?? { scale: 1, x: 0.5, y: 0.5 },
                        ease: cam?.ease ?? "smooth",
                        [key]: { ...k, [field]: (v[0] ?? 0) / 100 },
                      })
                    }
                  />
                  <span className="w-8 text-right font-mono text-[10px] text-muted-foreground">
                    {Math.round(k[field] * 100)}%
                  </span>
                </div>
              ))}
            </div>
          );
        })}
        <div className="flex items-center gap-1.5">
          <Select
            value={cam?.ease ?? "smooth"}
            disabled={disabled || !cam}
            onValueChange={(v) => cam && onCamera({ ...cam, ease: v as SceneCameraKeys["ease"] })}
          >
            <SelectTrigger className="h-7 flex-1 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="smooth" className="text-xs">Smooth (ease in-out)</SelectItem>
              <SelectItem value="linear" className="text-xs">Linear</SelectItem>
              <SelectItem value="pop" className="text-xs">Pop (ease out)</SelectItem>
            </SelectContent>
          </Select>
          <Button size="sm" variant="ghost" disabled={disabled || !cam} onClick={() => onCamera(null)} className="h-7 text-xs">
            Auto
          </Button>
        </div>
        <p className="text-[10px] leading-snug text-muted-foreground">
          Two keyframes, start → end framing with easing — overrides the Director's auto camera for this AI-art scene.
        </p>
      </section>

      {/* speed — S2 wave 2 */}
      <section className="space-y-1.5">
        <header className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
          <Clock className="h-3 w-3" /> Speed {RENDER_HONORS}
        </header>
        <div className="flex items-center gap-2">
          <Slider
            className="h-1.5 flex-1"
            value={[Math.round((scene.speed ?? 1) * 100)]}
            min={50}
            max={200}
            step={5}
            disabled={disabled}
            onValueChange={(v) => onSpeed((v[0] ?? 100) / 100)}
          />
          <span className="w-10 text-right font-mono text-[10px] text-muted-foreground">
            {(scene.speed ?? 1).toFixed(2)}×
          </span>
          <Button size="sm" variant="ghost" disabled={disabled || !scene.speed} onClick={() => onSpeed(null)} className="h-7 px-2 text-xs">
            1×
          </Button>
        </div>
        <p className="text-[10px] leading-snug text-muted-foreground">
          The narration is time-stretched (no words lost) and footage plays at the rate;
          the scene's floor shrinks to match a faster read. AI-art stills pace by their read.
        </p>
      </section>

      {/* chroma key — S3 */}
      {!slidesMode && (
        <section className="space-y-1.5">
          <header className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
            <Layers className="h-3 w-3" /> Chroma key {RENDER_HONORS}
          </header>
          <div className="flex items-center gap-2">
            <Switch
              checked={chroma != null}
              disabled={disabled}
              onCheckedChange={(v) =>
                onChroma(v ? { color: "#00FF00", similarity: 0.12, blend: 0.02, background: "#000000" } : null)
              }
              aria-label="Toggle chroma key"
            />
            <span className="text-xs text-muted-foreground">{chroma ? "Keyed" : "Off"}</span>
            {chroma && (
              <div className="ml-auto flex gap-1">
                {CHROMA_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    disabled={disabled}
                    onClick={() => onChroma({ ...chroma, color: p.color })}
                    title={`${p.label} screen`}
                    className={clsx(
                      "h-5 w-5 rounded-md border transition-all",
                      chroma.color.toUpperCase() === p.color
                        ? "border-white/70 ring-1 ring-white/40"
                        : "border-white/20 hover:border-white/40"
                    )}
                    style={{ background: p.color }}
                  />
                ))}
              </div>
            )}
          </div>
          {chroma && (
            <>
              <div className="flex items-center gap-2">
                <span className="w-16 shrink-0 text-[10px] text-muted-foreground">Similarity</span>
                <Slider
                  className="h-1.5 flex-1"
                  value={[Math.round(chroma.similarity * 100)]}
                  min={1}
                  max={35}
                  step={1}
                  disabled={disabled}
                  onValueChange={(v) => onChroma({ ...chroma, similarity: (v[0] ?? 12) / 100 })}
                />
                <span className="w-8 text-right font-mono text-[10px] text-muted-foreground">
                  {chroma.similarity.toFixed(2)}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-16 shrink-0 text-[10px] text-muted-foreground">Edge soft</span>
                <Slider
                  className="h-1.5 flex-1"
                  value={[Math.round(chroma.blend * 100)]}
                  min={0}
                  max={20}
                  step={1}
                  disabled={disabled}
                  onValueChange={(v) => onChroma({ ...chroma, blend: (v[0] ?? 2) / 100 })}
                />
                <span className="w-8 text-right font-mono text-[10px] text-muted-foreground">
                  {chroma.blend.toFixed(2)}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-16 shrink-0 text-[10px] text-muted-foreground">Backdrop</span>
                <input
                  type="color"
                  disabled={disabled}
                  value={chroma.background}
                  onChange={(e) => onChroma({ ...chroma, background: e.target.value.toUpperCase() })}
                  className="h-6 w-10 cursor-pointer rounded border border-white/15 bg-transparent p-0.5"
                  aria-label="Backdrop color"
                />
                <span className="font-mono text-[10px] text-muted-foreground">{chroma.background}</span>
              </div>
            </>
          )}
          <p className="text-[10px] leading-snug text-muted-foreground">
            Keys this scene's art off a green/blue/magenta screen onto the backdrop —
            the render keys before grading so the key color stays honest.
          </p>
        </section>
      )}

      {/* logo overlay / PIP — S3 */}
      {!slidesMode && (
        <section className="space-y-1.5">
          <header className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
            <PictureInPicture2 className="h-3 w-3" /> Logo overlay {RENDER_HONORS}
          </header>
          {!hasLogo ? (
            <p className="text-[10px] leading-snug text-muted-foreground">
              Upload a brand logo (Brand kit) to pin it into a corner of this scene.
            </p>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <Switch
                  checked={pip != null}
                  disabled={disabled}
                  onCheckedChange={(v) =>
                    onPip(v ? { pos: "br", size: 0.18, opacity: 1, border: true, margin: 0.03 } : null)
                  }
                  aria-label="Toggle logo overlay"
                />
                <span className="text-xs text-muted-foreground">{pip ? "Pinned" : "Off"}</span>
              </div>
              {pip && (
                <>
                  <div className="grid w-[84px] grid-cols-3 gap-1">
                    {(["tl", "tc", "tr", "ml", "mc", "mr", "bl", "bc", "br"] as const).map((pos) => (
                      <button
                        key={pos}
                        type="button"
                        disabled={disabled}
                        onClick={() => onPip({ ...pip, pos })}
                        title={`Position ${pos}`}
                        className={clsx(
                          "h-5 rounded border transition-all",
                          pip.pos === pos
                            ? "border-primary/60 bg-primary/20"
                            : "border-white/15 bg-white/[0.03] hover:border-white/35"
                        )}
                      />
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="w-14 shrink-0 text-[10px] text-muted-foreground">Size</span>
                    <Slider
                      className="h-1.5 flex-1"
                      value={[Math.round(pip.size * 100)]}
                      min={6}
                      max={40}
                      step={1}
                      disabled={disabled}
                      onValueChange={(v) => onPip({ ...pip, size: (v[0] ?? 18) / 100 })}
                    />
                    <span className="w-8 text-right font-mono text-[10px] text-muted-foreground">
                      {Math.round(pip.size * 100)}%
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="w-14 shrink-0 text-[10px] text-muted-foreground">Opacity</span>
                    <Slider
                      className="h-1.5 flex-1"
                      value={[Math.round(pip.opacity * 100)]}
                      min={10}
                      max={100}
                      step={5}
                      disabled={disabled}
                      onValueChange={(v) => onPip({ ...pip, opacity: (v[0] ?? 100) / 100 })}
                    />
                    <span className="w-8 text-right font-mono text-[10px] text-muted-foreground">
                      {Math.round(pip.opacity * 100)}%
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={pip.border}
                      disabled={disabled}
                      onCheckedChange={(v) => onPip({ ...pip, border: v })}
                      aria-label="Logo border"
                    />
                    <span className="text-xs text-muted-foreground">White hairline</span>
                  </div>
                </>
              )}
            </>
          )}
        </section>
      )}

      {/* audio */}
      <section className="space-y-2">
        <header className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
          <AudioLines className="h-3 w-3" /> Mix {RENDER_HONORS}
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
        <p className="text-[10px] leading-snug text-muted-foreground">
          Voice/SFX/ambience are the render's mix weights. Music rides the library bed
          per scene — the synthesized fallback bed keeps its fixed profile.
        </p>
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
