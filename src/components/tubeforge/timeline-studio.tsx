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
//   • per-scene SOUND PICKS → S5: the inspector chooses the scene's SFX cue
//     (whoosh/boom/riser/sting) and ambience bed (room/city/rain/wind/waves/
//     crowd/nature) — the doc's kinds outrank the plan's at the render; the
//     audition button plays the exact synthesized wav the render will mix.
//   • CAPTION STYLE → S6: the studio picks the look the render burns when
//     captions are on (classic/bold pop/clean box/top line/amber warm) —
//     doc-level (the burn is one global pass), mapped to the SAME ASS params
//     the render uses; the preview mirrors the geometry. Junk can only ever
//     select a catalog look.
//   • MUSIC PICK → S7: the studio picks the bed the render lays under the
//     voice (follow settings / auto match / story mood / pinned library
//     track / mute) — doc-level, re-topping the resolver's chain (doc >
//     plan > row); "off" ships true silence, not the drone fallback. The
//     audition button plays the EXACT bed the render will mix, and the mix
//     preview rides the same chain.
//   • NARRATOR → S8: the studio picks WHO reads. Unlike S6/S7 this is not a
//     doc field — the voice is baked into the per-scene WAVs, so the pick is
//     a deliberate server ACTION: stage it in the picker, audition it on
//     the video's own opening line, commit with the two-step Re-voice. The
//     server re-reads EVERY scene with the new voice, re-derives every doc
//     window (creative fields carried across), rebuilds voiceover.wav and
//     drops only the stale renders. History resets — a row mutation is not
//     doc-undoable (the same doctrine as the clip ops).
//   • PACE → S11: the narrator's sibling axis — HOW FAST the read goes.
//     ttsSpeed was frozen at the create form's slider until S11; the studio
//     pick is the same deliberate server ACTION one axis over: stage the
//     tempo in the picker, audition the CURRENT narrator at that tempo on
//     the video's own opening line, commit with the two-step Re-read. The
//     server re-reads EVERY scene with the same voice at the new speed
//     (windows re-derive, creative fields survive, voiceover.wav rebuilds,
//     only the stale renders die — the narrator swap's machinery).
//   • COVER STYLE → S12: the subject's sibling axis (S9 picked WHICH
//     moment the cover depicts, this picks WHAT the art looks like). A
//     cheap row pick — PATCHes immediately, invalidates nothing; the
//     poster cluster's Regenerate arm is the action that spends the
//     generation, painting the picked subject in the picked style. The
//     A/B variants set leads with the row style (pickVariantStyles).
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
  Square,
  Subtitles,
  Trash2,
  Type,
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
  Smartphone,
  Gauge,
  Palette,
  Frame,
  FileDown,
  Move,
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
  SelectGroup,
  SelectItem,
  SelectLabel,
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
import { TRANSITIONS, resolveTransition } from "@/lib/tubeforge/transitions";
import { MOTION_MODES, sanitizeMotion } from "@/lib/tubeforge/motion";
import { MUSIC_MOODS as MUSIC_MOOD_PRESETS, THUMB_STYLES, RENDER_ASPECTS, RENDER_FRAME_RATES } from "@/lib/tubeforge/types";
import {
  GRADE_PRESETS,
  sanitizeGrade,
  sanitizeTitle,
  sanitizeCamera,
  sanitizeSpeed,
  sanitizeChroma,
  sanitizePip,
  CHROMA_PRESETS,
  CAPTION_STYLES,
  captionPreview,
  sanitizeCaptionStyle,
  docMusicPick,
  sanitizeMusicPick,
  docPosterPick,
  sanitizePosterPick,
  docShortPick,
  sanitizeShortPick,
  type ExportQuality,
  type MusicPick,
  type PosterPick,
  type ShortPick,
  type SceneGrade,
  type SceneTitle,
  type SceneCameraKeys,
  type SceneChroma,
  type ScenePip,
} from "@/lib/tubeforge/studio-doc";
import {
  AMBIENCE_CATALOG,
  SFX_CATALOG,
  sanitizeAmbienceKind,
  sanitizeSfxKind,
  soundChoice,
} from "@/lib/tubeforge/studio-sound";
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

/** S11 — the pacing ladder the studio picker offers (create-slider
 *  granularity, curated to the tempos a narrator actually reads at). */
const PACE_LADDER = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

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

/** POST /studio/voice — S8: the narrator swap (server contract). A row
 * mutation like the clip ops — the studio swaps its doc in whole. */
interface VoiceSwapResponse {
  timeline: AssembledTimelineDTO;
  sceneOrder: number[];
  activity: string;
  /** The narrator now baked into every scene WAV. */
  voice: string;
  /** Fresh per-scene read lengths after the swap (every scene re-read). */
  wavDurations?: Record<number, number>;
}

/** POST /studio/pace — S11: the pacing change (server contract). A row
 * mutation like the narrator swap — the studio swaps its doc in whole. */
interface PaceChangeResponse {
  timeline: AssembledTimelineDTO;
  sceneOrder: number[];
  activity: string;
  /** The pace now baked into every scene WAV. */
  ttsSpeed: number;
  /** Fresh per-scene read lengths after the change (every scene re-read). */
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
    // S6 — the caption pick re-sanitizes at the load choke point (the same
    // studio-doc function the render side reads, so a hostile persisted
    // pick can only ever be a catalog look or nothing).
    // S7 — the music pick rides the same choke point.
    // S9 — the poster pick rides it too (junk reads as "no opinion" — the
    // cover depicts the opening scene, the pre-S9 behavior).
    // S10 — the short pick rides it too (junk reads as "no opinion" — the
    // hook heuristic picks the moment, the pre-S10 behavior).
    renderPrefs: t.renderPrefs
      ? {
          quality: t.renderPrefs.quality ?? "standard",
          captionStyle: sanitizeCaptionStyle(t.renderPrefs.captionStyle),
          music: sanitizeMusicPick(t.renderPrefs.music),
          poster: sanitizePosterPick(t.renderPrefs.poster),
          short: sanitizeShortPick(t.renderPrefs.short),
        }
      : t.renderPrefs,
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
          // S5 — the sound kinds re-sanitize at the load choke point (the
          // render's extractor calls the exact same studio-sound functions,
          // so a hostile persisted doc can never reach the render raw).
          sfx: {
            enabled: a?.sfx?.enabled ?? false,
            level: a?.sfx?.level ?? 0,
            kind: sanitizeSfxKind(a?.sfx?.kind),
          },
          ambient: {
            enabled: a?.ambient?.enabled ?? false,
            level: a?.ambient?.level ?? 0,
            kind: sanitizeAmbienceKind(a?.ambient?.kind),
          },
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

  /** S5 — the sound stage: picking a scene's SFX cue / ambience bed writes
   *  the doc's kind; the render resolves doc > plan > row. One pick = one
   *  undo step. Picking from "none" seeds the level with the sound's own
   *  default (the number the render assumes); clearing the pick parks the
   *  level at 0 — the assembly seed's exact shape. */
  const setSoundKind = useCallback(
    (index: number, bank: "sfx" | "ambient", kind: string | null) => {
      if (!timeline) return;
      const next = cloneTimeline(timeline);
      const i = next.scenes.findIndex((s) => s.index === index);
      if (i === -1) return;
      const track = next.scenes[i].audio[bank];
      const choice = kind ? soundChoice(kind, bank === "sfx" ? "sfx" : "ambience") : null;
      next.scenes[i].audio = {
        ...next.scenes[i].audio,
        [bank]: {
          ...track,
          kind,
          enabled: kind !== null,
          level: kind ? (track.level > 0 ? track.level : (choice?.defaultLevel ?? 0.35)) : 0,
        },
      };
      applyEdit(next);
    },
    [timeline, applyEdit]
  );

  /** S6 — the caption look: one doc-level pick riding renderPrefs (the burn
   *  is one global subtitles pass, so the style is per-VIDEO, not per-scene).
   *  null = the classic look. One pick = one undo step; the autosave
   *  persists it with every other doc field. */
  const setCaptionStyle = useCallback(
    (id: string | null) => {
      if (!timeline) return;
      const next = cloneTimeline(timeline);
      const prefs = next.renderPrefs ?? { quality: "standard" as const };
      next.renderPrefs = { ...prefs, captionStyle: id };
      applyEdit(next);
    },
    [timeline, applyEdit]
  );

  // ---------- S7 — the music pick ----------
  // The score: one doc-level pick riding renderPrefs (the bed is one global
  // mix pass, so the pick is per-VIDEO, like the caption style). "Follow
  // Settings" (null) keeps the pre-S7 chain intact; auto/mood/track re-top
  // the resolver's chain (doc > plan > row); "off" mutes the bed outright.
  // One pick = one undo step; the autosave persists it with every other doc
  // field. The library list is fetched once for the picker; a failed fetch
  // degrades to the mood presets (the render resolves ids independently).
  const [musicTracks, setMusicTracks] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    let dead = false;
    void (async () => {
      try {
        const res = await fetch("/api/music", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { tracks?: { id: string; name: string; isActive?: boolean }[] };
        if (!dead && Array.isArray(data.tracks))
          setMusicTracks(
            data.tracks
              .filter((t) => t.isActive !== false)
              .map((t) => ({ id: t.id, name: t.name }))
          );
      } catch {
        /* the picker degrades to the mood presets */
      }
    })();
    return () => {
      dead = true;
    };
  }, []);

  const setMusicPick = useCallback(
    (pick: MusicPick | null) => {
      if (!timeline) return;
      const next = cloneTimeline(timeline);
      const prefs = next.renderPrefs ?? { quality: "standard" as const };
      next.renderPrefs = { ...prefs, music: pick };
      applyEdit(next);
    },
    [timeline, applyEdit]
  );

  // The score's ears — the audition plays the EXACT bed the render will mix
  // (the route resolves through the same chain: doc pick > plan > row). One
  // element, stopped on unmount.
  const musicAuditionRef = useRef<HTMLAudioElement | null>(null);
  const [musicAuditioning, setMusicAuditioning] = useState(false);
  const stopMusicAudition = useCallback(() => {
    musicAuditionRef.current?.pause();
    musicAuditionRef.current = null;
    setMusicAuditioning(false);
  }, []);
  useEffect(() => stopMusicAudition, [stopMusicAudition]);
  const toggleMusicAudition = useCallback(() => {
    if (musicAuditioning) {
      stopMusicAudition();
      return;
    }
    stopMusicAudition();
    const el = new Audio(`/api/videos/${videoId}/studio/sound?bank=music`);
    el.addEventListener("ended", stopMusicAudition);
    el.addEventListener("error", stopMusicAudition);
    musicAuditionRef.current = el;
    setMusicAuditioning(true);
    void el.play().catch(stopMusicAudition);
  }, [musicAuditioning, stopMusicAudition, videoId]);

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

  // ---------- S8 — the narrator pick ----------
  // The voice: unlike the caption/music picks this is NOT a doc field — the
  // narrator is baked into the per-scene WAVs, so the pick is a deliberate
  // server ACTION (a row mutation + real TTS), never a casual dropdown
  // flip. The picker STAGES a pending voice, the audition plays it on the
  // video's own opening line, and the two-step Re-voice commits: the server
  // re-reads every scene, re-derives every doc window (creative fields
  // carried across), rebuilds voiceover.wav and drops only the stale
  // renders. The voice catalog is fetched once for the picker; a failed
  // fetch degrades to the current narrator.
  const [voices, setVoices] = useState<{ id: string; label: string; clone: boolean }[]>([]);
  useEffect(() => {
    let dead = false;
    void (async () => {
      try {
        const res = await fetch("/api/settings/voices", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { voices?: { id: string; label: string }[] };
        if (!dead && Array.isArray(data.voices))
          setVoices(
            data.voices.map((v) => ({
              id: v.id,
              label: v.label,
              clone: v.id.startsWith("voice_clone_"),
            }))
          );
      } catch {
        /* the picker degrades to the current narrator */
      }
    })();
    return () => {
      dead = true;
    };
  }, []);

  /** Staged pick (null = keep the current narrator). */
  const [voicePick, setVoicePick] = useState<string | null>(null);
  const [voiceBusy, setVoiceBusy] = useState<"audition" | "swap" | null>(null);
  /** Two-step commit, like the delete arm — a swap re-reads every scene. */
  const [voiceArmed, setVoiceArmed] = useState(false);

  // The narrator's ears — the audition synthesizes the PICKED voice on the
  // video's own opening line (the preview route's one-off text), so what
  // you hear is what the swap will re-read. One element, stopped on unmount.
  const voiceAuditionRef = useRef<HTMLAudioElement | null>(null);
  const stopVoiceAudition = useCallback(() => {
    voiceAuditionRef.current?.pause();
    voiceAuditionRef.current = null;
    setVoiceBusy((b) => (b === "audition" ? null : b));
  }, []);
  useEffect(() => stopVoiceAudition, [stopVoiceAudition]);

  const auditionVoice = useCallback(
    async (voice: string) => {
      stopVoiceAudition();
      if (!voice) return;
      setVoiceBusy("audition");
      try {
        const line =
          timeline?.scenes.find((s) => (s.narration ?? "").trim())?.narration ?? "";
        const res = await fetch("/api/settings/voices/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ voice, ...(line ? { text: line.slice(0, 200) } : {}) }),
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(err.error ?? `HTTP ${res.status}`);
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const el = new Audio(url);
        el.addEventListener("ended", () => {
          URL.revokeObjectURL(url);
          stopVoiceAudition();
        });
        el.addEventListener("error", () => {
          URL.revokeObjectURL(url);
          stopVoiceAudition();
        });
        voiceAuditionRef.current = el;
        await el.play();
      } catch (err) {
        stopVoiceAudition();
        toast({
          title: "Audition failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      }
    },
    [timeline, stopVoiceAudition, toast]
  );

  // The commit: flush the doc, POST the swap, hot-swap the doc in whole
  // (history resets — a row mutation is not doc-undoable), drop every
  // cached per-scene WAV so the voice lane + preview re-fetch lazily.
  const voiceSwap = useCallback(
    async () => {
      if (!voicePick || !timeline || voiceBusy || clipBusy || saving || loading || renderInFlight)
        return;
      setVoiceArmed(false);
      stopVoiceAudition();
      setVoiceBusy("swap");
      try {
        // Flush pending edits first — the swap works on the SAVED row + doc.
        if (dirty) await save();
        const res = await fetch(`/api/videos/${videoId}/studio/voice`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ voice: voicePick }),
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(err.error ?? `HTTP ${res.status}`);
        }
        const data = (await res.json()) as VoiceSwapResponse;
        setHistory({ past: [], present: normalizeTimelineDoc(data.timeline), future: [] });
        setDirty(false);
        if (data.wavDurations) setWavDurations(data.wavDurations);
        for (const el of voPool.current.values()) el.pause();
        voPool.current.clear();
        setBrokenVo(new Set());
        setWavVersion((v) => v + 1);
        setPlaying(false);
        seek(Math.min(playhead, Math.max(0, data.timeline.totalDurationSec - 0.001)));
        setVoicePick(null);
        bump();
        onSaved?.(); // the parent re-fetches the row (the picker shows the new narrator)
        toast({ title: "Narrator swapped", description: data.activity });
      } catch (err) {
        toast({
          title: "Voice swap failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      } finally {
        setVoiceBusy(null);
      }
    },
    [
      voicePick,
      timeline,
      voiceBusy,
      clipBusy,
      saving,
      loading,
      renderInFlight,
      dirty,
      save,
      videoId,
      playhead,
      seek,
      bump,
      onSaved,
      toast,
      stopVoiceAudition,
    ]
  );

  // Two-step commit: the first press arms (4 s window), the second executes;
  // re-picking a voice disarms. A swap re-reads every scene — the pause is
  // the cost disclosure.
  useEffect(() => {
    if (!voiceArmed) return;
    const t = setTimeout(() => setVoiceArmed(false), 4000);
    return () => clearTimeout(t);
  }, [voiceArmed]);
  useEffect(() => {
    setVoiceArmed(false);
  }, [voicePick]);

  // ---------- S11 — the pacing pick ----------
  // The narrator's sibling axis: HOW FAST the read goes. ttsSpeed is set
  // once at the create form and until S11 was frozen — the only override
  // was the settings-style PATCH, whose invalidation burns every read-
  // keyed artifact down. Like the narrator this pick is a server ACTION
  // (a row mutation + real TTS re-read of every scene), never a casual
  // dropdown flip: the picker STAGES a pending pace, the audition plays
  // the CURRENT narrator at the staged tempo on the video's own opening
  // line, and the two-step Re-read commits — same voice, new speed,
  // windows re-derive, creative edits survive.
  /** The ladder the picker offers lives at module scope (PACE_LADDER). */
  /** Staged pace (null = keep the current tempo). */
  const [pacePick, setPacePick] = useState<number | null>(null);
  const [paceBusy, setPaceBusy] = useState<"audition" | "change" | null>(null);
  /** Two-step commit, like the narrator arm — a re-read of every scene. */
  const [paceArmed, setPaceArmed] = useState(false);

  // The pace's ears — the audition synthesizes the CURRENT narrator at the
  // STAGED tempo on the video's own opening line (the preview route's
  // one-off text), so what you hear is the tempo the re-read will use.
  // One element, stopped on unmount.
  const paceAuditionRef = useRef<HTMLAudioElement | null>(null);
  const stopPaceAudition = useCallback(() => {
    paceAuditionRef.current?.pause();
    paceAuditionRef.current = null;
    setPaceBusy((b) => (b === "audition" ? null : b));
  }, []);
  useEffect(() => stopPaceAudition, [stopPaceAudition]);

  const auditionPace = useCallback(
    async (speed: number) => {
      stopPaceAudition();
      if (!speed) return;
      setPaceBusy("audition");
      try {
        const line =
          timeline?.scenes.find((s) => (s.narration ?? "").trim())?.narration ?? "";
        const res = await fetch("/api/settings/voices/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            voice: video.voice,
            speed,
            ...(line ? { text: line.slice(0, 200) } : {}),
          }),
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(err.error ?? `HTTP ${res.status}`);
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const el = new Audio(url);
        el.addEventListener("ended", () => {
          URL.revokeObjectURL(url);
          stopPaceAudition();
        });
        el.addEventListener("error", () => {
          URL.revokeObjectURL(url);
          stopPaceAudition();
        });
        paceAuditionRef.current = el;
        await el.play();
      } catch (err) {
        stopPaceAudition();
        toast({
          title: "Audition failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      }
    },
    [video.voice, timeline, stopPaceAudition, toast]
  );

  // The commit: flush the doc, POST the pace change, hot-swap the doc in
  // whole (history resets — a row mutation is not doc-undoable), drop
  // every cached per-scene WAV so the voice lane + preview re-fetch
  // lazily. The machinery mirrors the narrator swap one axis over.
  const paceChange = useCallback(
    async () => {
      if (pacePick == null || !timeline || paceBusy || voiceBusy || clipBusy || saving || loading || renderInFlight)
        return;
      setPaceArmed(false);
      stopPaceAudition();
      setPaceBusy("change");
      try {
        // Flush pending edits first — the re-read works on the SAVED row + doc.
        if (dirty) await save();
        const res = await fetch(`/api/videos/${videoId}/studio/pace`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ speed: pacePick }),
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(err.error ?? `HTTP ${res.status}`);
        }
        const data = (await res.json()) as PaceChangeResponse;
        setHistory({ past: [], present: normalizeTimelineDoc(data.timeline), future: [] });
        setDirty(false);
        if (data.wavDurations) setWavDurations(data.wavDurations);
        for (const el of voPool.current.values()) el.pause();
        voPool.current.clear();
        setBrokenVo(new Set());
        setWavVersion((v) => v + 1);
        setPlaying(false);
        seek(Math.min(playhead, Math.max(0, data.timeline.totalDurationSec - 0.001)));
        setPacePick(null);
        bump();
        onSaved?.(); // the parent re-fetches the row (every ttsSpeed reader shows the new pace)
        toast({ title: "Pacing changed", description: data.activity });
      } catch (err) {
        toast({
          title: "Pace change failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      } finally {
        setPaceBusy(null);
      }
    },
    [
      pacePick,
      timeline,
      paceBusy,
      voiceBusy,
      clipBusy,
      saving,
      loading,
      renderInFlight,
      dirty,
      save,
      videoId,
      playhead,
      seek,
      bump,
      onSaved,
      toast,
      stopPaceAudition,
    ]
  );

  // Two-step commit: the first press arms (4 s window), the second
  // executes; re-picking a pace disarms.
  useEffect(() => {
    if (!paceArmed) return;
    const t = setTimeout(() => setPaceArmed(false), 4000);
    return () => clearTimeout(t);
  }, [paceArmed]);
  useEffect(() => {
    setPaceArmed(false);
  }, [pacePick]);

  // ---------- S9: the poster — the scene the cover depicts ----------
  // The cover art's SUBJECT was a pipeline default: the concept derived
  // from the opening scene, always, and wanting the poster to tease a
  // different moment meant rewriting the script's opening. The pick is
  // doc-level (one poster per video, like the caption style and the score):
  // which scene's visual + mood the CogView concept derives from. The PICK
  // rides the autosave; the ARTWORK is a generation — the two-step
  // Regenerate arm is the cost disclosure (a real concept → CogView → VLM
  // gate pass), and the thumb beside the picker shows what the world
  // currently sees (cache-busted per regeneration).
  const setPosterPick = useCallback(
    (pick: PosterPick | null) => {
      if (!timeline) return;
      const next = cloneTimeline(timeline);
      const prefs = next.renderPrefs ?? { quality: "standard" as const };
      next.renderPrefs = { ...prefs, poster: pick };
      applyEdit(next);
    },
    [timeline, applyEdit]
  );
  /** Two-step commit, like the delete arm — a regeneration paints real art. */
  const [posterArmed, setPosterArmed] = useState(false);
  const [posterBusy, setPosterBusy] = useState(false);
  const [posterEpoch, setPosterEpoch] = useState(0); // thumb cache-buster per regen
  useEffect(() => {
    if (!posterArmed) return;
    const t = setTimeout(() => setPosterArmed(false), 4000);
    return () => clearTimeout(t);
  }, [posterArmed]);

  // ---------- S12 — the cover's style ----------
  // The subject's sibling axis (S9 picked WHICH moment, this picks WHAT
  // the art looks like): the thumbnail's art direction, frozen at the
  // create form's dropdown until S12. The pick is row-level and cheap —
  // a style flip invalidates NOTHING (the standing cover stays until the
  // Regenerate arm repaints it; the job reads the row fresh at generation
  // time) — so unlike the narrator/pace it PATCHes immediately, no staged
  // pending pick and no two-step arm. The Regenerate button beside it is
  // the action that spends the generation.
  const [styleSaving, setStyleSaving] = useState(false);
  const pickCoverStyle = useCallback(
    async (style: string) => {
      if (styleSaving || style === video.thumbStyle) return;
      setStyleSaving(true);
      try {
        const res = await fetch(`/api/videos/${videoId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ thumbStyle: style }),
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(err.error ?? `HTTP ${res.status}`);
        }
        onSaved?.(); // the parent re-fetches the row (the picker shows the new style)
        toast({
          title: "Cover style picked",
          description: `${THUMB_STYLES.find((t) => t.id === style)?.label ?? style} — Regenerate repaints the cover in it.`,
        });
      } catch (err) {
        toast({
          title: "Style pick failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      } finally {
        setStyleSaving(false);
      }
    },
    [styleSaving, video.thumbStyle, videoId, onSaved, toast]
  );

  // The apply: flush the doc, POST the thumbnail job (the concept
  // re-derives from the PICKED scene server-side — the same
  // posterSceneFor truth the A/B variants ride), then poll the job state
  // until it settles and bust the thumb's cache. A pick without a
  // regeneration still rides the doc — the next thumbnail pass honors it.
  const regeneratePoster = useCallback(
    async () => {
      if (posterBusy || saving || loading || renderInFlight) return;
      setPosterArmed(false);
      setPosterBusy(true);
      try {
        if (dirty) await save();
        const res = await fetch(`/api/videos/${videoId}/thumbnail`, { method: "POST" });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(err.error ?? `HTTP ${res.status}`);
        }
        // Poll the background job (the same state the variants route
        // exposes). Only an error that SETTLES with the job fails the arm.
        let settled = false;
        for (let i = 0; i < 120 && !settled; i++) {
          await new Promise((r) => setTimeout(r, 2500));
          const s = await fetch(`/api/videos/${videoId}/thumbnail?status=1`, { cache: "no-store" });
          if (!s.ok) continue;
          const st = (await s.json()) as { generating?: boolean; error?: string | null };
          if (st.generating) continue;
          settled = true;
          if (st.error) throw new Error(st.error);
        }
        setPosterEpoch((e) => e + 1);
        const pick = docPosterPick(timeline?.renderPrefs);
        // S12 — name the STYLE the repaint wore (the row's standing pick
        // directed the generation; the toast says what actually happened).
        const styleLabel =
          THUMB_STYLES.find((t) => t.id === video.thumbStyle)?.label ?? video.thumbStyle;
        toast({
          title: settled ? "Poster regenerated" : "Poster still painting",
          description: settled
            ? pick?.mode === "scene"
              ? `The cover now depicts scene ${pick.sceneIndex} in ${styleLabel} style.`
              : `The cover depicts the opening scene in ${styleLabel} style.`
            : "The generation is taking longer than expected — it will land on the video page.",
        });
      } catch (err) {
        toast({
          title: "Poster regeneration failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      } finally {
        setPosterBusy(false);
      }
    },
    [posterBusy, saving, loading, renderInFlight, dirty, save, videoId, timeline, video.thumbStyle, toast]
  );

  // ---------- S10: the short — the moment the vertical cut frames ----------
  // The 9:16 cut's moment was a pipeline default: a hook regex scored the
  // scenes and the highest scorer got framed, always — the studio had no
  // say in the vertical derivative. The pick is doc-level (one short per
  // video, like the poster and the score): which scene the cut centers on.
  // The PICK rides the autosave; the CUT is an ffmpeg slice of the ALREADY
  // RENDERED master — no generation pass, no cost disclosure, so the arm
  // is single-step (unlike the poster's two-step CogView disclosure); it
  // only needs the master to exist.
  const setShortPick = useCallback(
    (pick: ShortPick | null) => {
      if (!timeline) return;
      const next = cloneTimeline(timeline);
      const prefs = next.renderPrefs ?? { quality: "standard" as const };
      next.renderPrefs = { ...prefs, short: pick };
      applyEdit(next);
    },
    [timeline, applyEdit]
  );
  const [shortBusy, setShortBusy] = useState(false);

  // The apply: flush the doc (a just-made pick must be on disk before the
  // job reads it), POST the short job with NO body (the standing pick
  // resolves server-side — body > doc > hook), then poll the job state
  // until it settles. A pick without a cut still rides the doc — the next
  // cut (studio arm or dialog) honors it.
  const cutShort = useCallback(
    async () => {
      if (shortBusy || saving || loading || renderInFlight || !video.hasVideo) return;
      setShortBusy(true);
      try {
        if (dirty) await save();
        const res = await fetch(`/api/videos/${videoId}/short`, { method: "POST" });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(err.error ?? `HTTP ${res.status}`);
        }
        // Poll the background job until it settles (the same state the
        // detail dialog polls). Only an error that SETTLES without a file
        // fails the arm.
        let settled: { sceneIndex?: number | null; durationSec?: number | null } | null = null;
        for (let i = 0; i < 80 && !settled; i++) {
          await new Promise((r) => setTimeout(r, 1500));
          const s = await fetch(`/api/videos/${videoId}/short`, { cache: "no-store" });
          if (!s.ok) continue;
          const st = (await s.json()) as {
            generating?: boolean; hasShort?: boolean; error?: string | null;
            sceneIndex?: number | null; durationSec?: number | null;
          };
          if (st.generating) continue;
          if (st.error && !st.hasShort) throw new Error(st.error);
          settled = st;
        }
        onSaved?.(); // refresh the parent row — hasShort/shortScene/shortDuration
        const pick = docShortPick(timeline?.renderPrefs);
        toast({
          title: settled ? "Vertical Short ready" : "Short still cutting",
          description: settled
            ? `The cut frames scene ${settled.sceneIndex} — ${settled.durationSec?.toFixed(1)}s 9:16 with punch-in zoom and big captions.`
            : `The cut is taking longer than expected — ${
                pick?.mode === "scene" ? `scene ${pick.sceneIndex}` : "the best hook"
              } will land on the video page.`,
        });
      } catch (err) {
        toast({
          title: "Short cut failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      } finally {
        setShortBusy(false);
      }
    },
    [shortBusy, saving, loading, renderInFlight, dirty, save, videoId, video, timeline, onSaved, toast]
  );

  // ---------- S13 — the frame: the picture's shape + smoothness ----------
  // The last render-frame decisions that lived outside the studio: the
  // aspect and frame rate were set once on the detail dialog's export
  // presets (or never — the row defaults, 16:9 / 30), while the studio's
  // OWN preview geometry and timecodes already followed them. The pick is
  // row-level and CHEAP — a frame flip invalidates nothing (the standing
  // render stays; the NEXT render draws the picked frame) — so like S12's
  // style it PATCHes immediately: no staged pick, no arm, no disclosure.
  // The preview + timecodes re-derive on the parent's re-fetch, and slides
  // mode locks the aspect vertical (the deck's PNG is the frame — 9:16 is
  // the only geometry the render will ever draw there).
  const [frameSaving, setFrameSaving] = useState(false);
  // The RESOLVED truth the pickers show (the same expression the preview's
  // settings derive): slides forces 9:16, null falls back to the defaults
  // (16:9 / 30) — the dropdown never shows a value the render won't draw.
  const resolvedAspect =
    video.renderMode === "slides" ? "9:16" : (video.aspectRatio ?? "16:9");
  const resolvedFps = video.frameRate ?? 30;
  const pickFrame = useCallback(
    async (patch: { aspectRatio?: string; frameRate?: number }) => {
      if (frameSaving) return;
      setFrameSaving(true);
      try {
        const res = await fetch(`/api/videos/${videoId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(err.error ?? `HTTP ${res.status}`);
        }
        onSaved?.(); // the parent re-fetches the row — preview + timecodes re-derive
        toast({
          title: "Frame picked",
          description:
            patch.aspectRatio != null
              ? `${RENDER_ASPECTS.find((a) => a.id === patch.aspectRatio)?.label ?? patch.aspectRatio} (${patch.aspectRatio}) — the preview wears it now; the next render draws it.`
              : `${patch.frameRate} fps — timecodes re-count now; the next render runs at it.`,
        });
      } catch (err) {
        toast({
          title: "Frame pick failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      } finally {
        setFrameSaving(false);
      }
    },
    [frameSaving, videoId, onSaved, toast]
  );

  // ---------- S14 — the delivery: the grade + the captions' shipping form ----------
  // The last two export decisions held captive by the dialog's preset row —
  // and the studio displayed a file it couldn't spec: the render job read
  // the doc's grade (aligned doc), but only a dialog preset click could
  // WRITE it; the row's burn pick was written by the presets and honored
  // by NOBODY through HTTP (the route's pre-resolution shadowed the job's
  // row fallback). S14 wires one chain for each (body > pick > default, a
  // shared resolver the render route calls) and gives the studio the picks:
  //   · the GRADE is doc-level (rides renderPrefs like the caption style —
  //     one undo step, the autosave persists it; the render route resolves
  //     body > doc > standard);
  //   · the BURN is row-level and CHEAP (a flip invalidates nothing — the
  //     next render ships captions the picked way; the dialog's per-render
  //     override still wins), so it PATCHes immediately like S13's frame.
  const setQualityPick = useCallback(
    (q: ExportQuality) => {
      if (!timeline) return;
      const next = cloneTimeline(timeline);
      const prefs = next.renderPrefs ?? { quality: "standard" as const };
      next.renderPrefs = { ...prefs, quality: q };
      applyEdit(next);
    },
    [timeline, applyEdit]
  );
  const [burnSaving, setBurnSaving] = useState(false);
  // The RESOLVED truth the toggle shows — the same expression the render
  // route's chain lands on when no per-render override rides the body:
  // row pick > format default (burned for video modes, off for slides).
  const resolvedBurn = video.burnCaptions ?? video.renderMode !== "slides";
  const pickBurn = useCallback(
    async (burn: boolean) => {
      if (burnSaving || burn === resolvedBurn) return;
      setBurnSaving(true);
      try {
        const res = await fetch(`/api/videos/${videoId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ burnCaptions: burn }),
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(err.error ?? `HTTP ${res.status}`);
        }
        onSaved?.(); // the parent re-fetches the row — the toggle shows the pick
        toast({
          title: "Caption delivery picked",
          description: burn
            ? "The next render burns the captions into the frame (the style pick applies)."
            : "The next render ships a sidecar SRT beside the frame — clean plate, portable captions.",
        });
      } catch (err) {
        toast({
          title: "Caption delivery pick failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      } finally {
        setBurnSaving(false);
      }
    },
    [burnSaving, resolvedBurn, videoId, onSaved, toast]
  );

  // ---------- S15 — the motion: the camera + the seam ----------
  // The last render tier the studio PREVIEWED but couldn't shape: the
  // preview lanes already re-derived their zoom amplitude, easing and
  // seam blend from the row's motion + transition overrides, while the
  // picks lived only on the detail dialog — and the PATCH route accepted
  // the family with the old silent drop/clamp, so a hostile pick looked
  // like it worked. S15 gives the family the law every tier since S12
  // wears: the catalog-gated PATCH (a present-but-illegal value dies with
  // a readable 400 before any write — the gate reads the SAME catalogs
  // these pickers render) plus studio picks beside the frame and the
  // delivery. Row-level picks that re-derive the preview immediately —
  // like S13's frame they PATCH and the parent's re-fetch redraws the
  // lanes; the standing render stays until the next one honors them.
  // The deep controls (easing curve, direction variation) stay on the
  // dialog's card; the studio carries the four decisive axes.
  const [motionSaving, setMotionSaving] = useState(false);
  // The RESOLVED truth the pickers show — the SAME shared resolvers the
  // render job runs (motion.ts / transitions.ts): null falls back to the
  // built-in defaults (smart / 12% / crossfade 0.5s), and a slides row
  // with no seam pick hard-cuts (the deck's designed beats land clean).
  // The dropdowns never show a move or a seam the render won't draw.
  const resolvedMotion = sanitizeMotion({
    mode: video.motionMode,
    intensity: video.motionIntensity,
    curve: video.motionCurve,
    vary: video.motionVary,
  });
  const resolvedTransition = resolveTransition(
    {
      transitionStyle: video.transitionStyle,
      transitionDuration: video.transitionDuration,
    },
    video.renderMode
  );
  const pickMotion = useCallback(
    async (
      patch: Partial<{
        motionMode: string;
        motionIntensity: number;
        transitionStyle: string;
        transitionDuration: number;
      }>
    ) => {
      if (motionSaving) return;
      setMotionSaving(true);
      const isSeam =
        patch.transitionStyle !== undefined || patch.transitionDuration !== undefined;
      try {
        const res = await fetch(`/api/videos/${videoId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(err.error ?? `HTTP ${res.status}`);
        }
        onSaved?.(); // the parent re-fetches the row — the preview lanes re-derive
        toast({
          title: isSeam ? "Transition picked" : "Motion picked",
          description: isSeam
            ? "The seam between scenes blends the picked way — the timeline's blend debt re-derives now; the next render composites it."
            : "The camera treats still art the picked way — the preview's move re-derives now; the next render shoots it.",
        });
      } catch (err) {
        toast({
          title: isSeam ? "Transition pick failed" : "Motion pick failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      } finally {
        setMotionSaving(false);
      }
    },
    [motionSaving, videoId, onSaved, toast]
  );

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

    // Burned captions — S6: the picked caption style's geometry, mirrored
    // from the render's ASS params (face sizes stay RELATIVE to the classic
    // look the preview always drew; box/top/uppercase variants included).
    if (f.caption) {
      const vertical = settings.aspectRatio !== "16:9";
      const cp = captionPreview(timeline?.renderPrefs?.captionStyle, vertical);
      const raw = cp.uppercase ? f.caption.toUpperCase() : f.caption;
      const fs = Math.max(11, Math.round(H * (vertical ? 0.042 : 0.055) * cp.faceMul));
      ctx.font = `${cp.weight} ${fs}px "Noto Sans SC", system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      const maxW = W * 0.86;
      const words = raw.split(/\s+/);
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
      const shown = Math.min(3, lines.length);
      const margin = Math.round(H * cp.marginRatio);
      ctx.lineJoin = "round";
      for (let i = 0; i < shown; i++) {
        const y =
          cp.align === "top"
            ? margin + fs + i * lh
            : H - margin - (shown - 1 - i) * lh;
        if (cp.box) {
          const wpx = ctx.measureText(lines[i]).width;
          ctx.fillStyle = cp.box;
          ctx.fillRect(W / 2 - wpx / 2 - fs * 0.45, y - fs, wpx + fs * 0.9, fs * 1.38);
        } else {
          ctx.lineWidth = Math.max(2, fs * cp.strokeRatio);
          ctx.strokeStyle = cp.stroke;
          ctx.strokeText(lines[i], W / 2, y);
        }
        ctx.fillStyle = cp.fill;
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
          {/* S6 — the caption look: doc-level, burned by the render whenever
              captions are on; the preview mirrors it. Junk can only ever
              select a catalog look (sanitizeCaptionStyle at both ends). */}
          <div className="flex items-center gap-1.5 mr-1">
            <Type className="h-3.5 w-3.5 text-muted-foreground" />
            <Select
              value={timeline?.renderPrefs?.captionStyle ?? "classic"}
              onValueChange={(v) => setCaptionStyle(v === "classic" ? null : v)}
              disabled={saving || loading || renderInFlight}
            >
              <SelectTrigger
                className="h-7 w-[126px] text-[11px]"
                title="The caption look the render burns when captions are on — the preview mirrors it"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CAPTION_STYLES.map((s) => (
                  <SelectItem key={s.id} value={s.id} className="text-[11px]">
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <span className="h-5 w-px bg-white/10" aria-hidden />
          {/* S7 — the score: doc-level music pick. The render + the mix
              preview resolve through the SAME chain (doc > plan > row);
              "Follow Settings" keeps the pre-S7 behavior, "Mute bed" ships
              true silence, and the audition button plays the resolved bed. */}
          <div className="flex items-center gap-1.5 mr-1">
            <Music2 className="h-3.5 w-3.5 text-muted-foreground" />
            <Select
              value={
                (() => {
                  const p = docMusicPick(timeline?.renderPrefs);
                  if (!p) return "follow";
                  return p.mode === "mood"
                    ? `mood:${p.moodId}`
                    : p.mode === "track"
                      ? `track:${p.trackId}`
                      : p.mode;
                })()
              }
              onValueChange={(v) => {
                if (v === "follow") return setMusicPick(null);
                if (v === "auto" || v === "off") return setMusicPick({ mode: v });
                const i = v.indexOf(":");
                const kind = i === -1 ? v : v.slice(0, i);
                const id = i === -1 ? "" : v.slice(i + 1);
                if (kind === "mood" && id) return setMusicPick({ mode: "mood", moodId: id });
                if (kind === "track" && id) return setMusicPick({ mode: "track", trackId: id });
              }}
              disabled={saving || loading || renderInFlight}
            >
              <SelectTrigger
                className="h-7 w-[138px] text-[11px]"
                title="The music bed the render lays under the voice — a studio pick outranks the plan and Settings; the audition button plays the resolved bed"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel className="text-[10px]">Bed</SelectLabel>
                  <SelectItem value="follow" className="text-[11px]">
                    Follow Settings
                  </SelectItem>
                  <SelectItem value="auto" className="text-[11px]">
                    Auto match
                  </SelectItem>
                  <SelectItem value="off" className="text-[11px]">
                    Mute bed
                  </SelectItem>
                </SelectGroup>
                <SelectGroup>
                  <SelectLabel className="text-[10px]">Story mood</SelectLabel>
                  {MUSIC_MOOD_PRESETS.filter((m) => m.id !== "auto").map((m) => (
                    <SelectItem key={m.id} value={`mood:${m.id}`} className="text-[11px]">
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
                {musicTracks.length > 0 ? (
                  <SelectGroup>
                    <SelectLabel className="text-[10px]">Library tracks</SelectLabel>
                    {musicTracks.map((t) => (
                      <SelectItem key={t.id} value={`track:${t.id}`} className="text-[11px]">
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ) : null}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0"
              onClick={toggleMusicAudition}
              disabled={saving || loading || renderInFlight}
              title="Audition the bed the render will mix (30 s)"
            >
              {musicAuditioning ? <Square className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
            </Button>
          </div>
          <span className="h-5 w-px bg-white/10" aria-hidden />
          {/* S8 — the narrator: unlike S6/S7 this pick is a server ACTION
              (real TTS re-reads every scene), so it stages PENDING, auditions
              on the video's own opening line, and commits through a two-step
              button — never a casual dropdown flip. */}
          <div className="flex items-center gap-1.5 mr-1">
            <Mic className="h-3.5 w-3.5 text-muted-foreground" />
            <Select
              value={voicePick ?? video.voice}
              onValueChange={(v) => {
                stopVoiceAudition();
                setVoicePick(v === video.voice ? null : v);
              }}
              disabled={saving || loading || renderInFlight || clipBusy != null || voiceBusy != null || paceBusy != null}
            >
              <SelectTrigger
                className="h-7 w-[150px] text-[11px]"
                title="Who narrates — pick to stage the swap, audition to hear it on your own opening line, Re-voice to re-read every scene"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {/* degraded mode: catalog fetch failed → still show the row's
                    narrator so the control never lies about the current state */}
                {!voices.some((v) => v.id === video.voice) ? (
                  <SelectItem value={video.voice} className="text-[11px]">
                    {video.voice} (current)
                  </SelectItem>
                ) : null}
                {voices.filter((v) => !v.clone).length > 0 ? (
                  <SelectGroup>
                    <SelectLabel className="text-[10px]">Studio voices</SelectLabel>
                    {voices
                      .filter((v) => !v.clone)
                      .map((v) => (
                        <SelectItem key={v.id} value={v.id} className="text-[11px]">
                          {v.label}
                        </SelectItem>
                      ))}
                  </SelectGroup>
                ) : null}
                {voices.some((v) => v.clone) ? (
                  <SelectGroup>
                    <SelectLabel className="text-[10px]">Your clones</SelectLabel>
                    {voices
                      .filter((v) => v.clone)
                      .map((v) => (
                        <SelectItem key={v.id} value={v.id} className="text-[11px]">
                          {v.label}
                        </SelectItem>
                      ))}
                  </SelectGroup>
                ) : null}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0"
              onClick={() =>
                voiceBusy === "audition"
                  ? stopVoiceAudition()
                  : void auditionVoice(voicePick ?? video.voice)
              }
              disabled={saving || loading || renderInFlight || voiceBusy === "swap" || clipBusy != null || paceBusy != null}
              title="Audition this voice reading your own opening line"
            >
              {voiceBusy === "audition" ? (
                <Square className="h-3.5 w-3.5" />
              ) : (
                <Volume2 className="h-3.5 w-3.5" />
              )}
            </Button>
            <Button
              size="sm"
              variant={voiceArmed ? "destructive" : "ghost"}
              className="h-7 px-2"
              onClick={() => (voiceArmed ? void voiceSwap() : setVoiceArmed(true))}
              disabled={
                !voicePick ||
                voicePick === video.voice ||
                saving ||
                loading ||
                renderInFlight ||
                clipBusy != null ||
                voiceBusy != null ||
                paceBusy != null
              }
              title="Re-voice the whole video — every scene is re-read with the picked voice (a real TTS pass), windows re-derive, creative edits survive"
            >
              {voiceBusy === "swap" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Mic className="h-3.5 w-3.5" />
              )}
              <span className="ml-1.5 text-xs">
                {voiceBusy === "swap"
                  ? `Re-reading ${timeline?.sceneCount ?? ""} scenes…`
                  : voiceArmed
                    ? `Re-voice ${timeline?.sceneCount ?? ""} scenes?`
                    : "Re-voice"}
              </span>
            </Button>
          </div>
          <span className="h-5 w-px bg-white/10" aria-hidden />
          {/* S11 — the pacing: the narrator's sibling axis, staged the same
              way (a real TTS re-read of every scene, so a two-step commit —
              the pause is the cost disclosure), with its own ears: the
              audition plays the CURRENT narrator at the staged tempo on
              the video's own opening line. */}
          <div className="flex items-center gap-1.5 mr-1">
            <Gauge className="h-3.5 w-3.5 text-muted-foreground" />
            <Select
              value={(() => {
                const p = pacePick ?? video.ttsSpeed;
                return `pace:${p}`;
              })()}
              onValueChange={(v) => {
                stopPaceAudition();
                const n = Number(v.slice(5));
                setPacePick(Math.abs(n - video.ttsSpeed) < 1e-9 ? null : n);
              }}
              disabled={saving || loading || renderInFlight || clipBusy != null || paceBusy != null || voiceBusy != null}
            >
              <SelectTrigger
                className="h-7 w-[92px] text-[11px]"
                title="How fast the narrator reads — pick to stage the tempo, audition to hear it on your own opening line, Re-read to commit (a real TTS pass; windows re-derive, creative edits survive)"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel className="text-[10px]">Narrator pace</SelectLabel>
                  {/* degraded mode: a standing speed off the ladder (the
                      create slider is continuous) still shows itself so the
                      control never lies about the current tempo */}
                  {PACE_LADDER.every((p) => Math.abs(p - (pacePick ?? video.ttsSpeed)) > 1e-9) ? (
                    <SelectItem
                      value={`pace:${pacePick ?? video.ttsSpeed}`}
                      className="text-[11px]"
                    >
                      {(pacePick ?? video.ttsSpeed).toFixed(2).replace(/\.?0+$/, "")}× (current)
                    </SelectItem>
                  ) : null}
                  {PACE_LADDER.map((p) => (
                    <SelectItem key={p} value={`pace:${p}`} className="text-[11px]">
                      {p === 1 ? "1× — normal" : `${p.toString().replace(/\.0$/, "")}×`}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0"
              onClick={() =>
                paceBusy === "audition"
                  ? stopPaceAudition()
                  : void auditionPace(pacePick ?? video.ttsSpeed)
              }
              disabled={saving || loading || renderInFlight || paceBusy === "change" || clipBusy != null || voiceBusy != null}
              title="Hear the narrator at this tempo on your own opening line"
            >
              {paceBusy === "audition" ? (
                <Square className="h-3.5 w-3.5" />
              ) : (
                <Volume2 className="h-3.5 w-3.5" />
              )}
            </Button>
            <Button
              size="sm"
              variant={paceArmed ? "destructive" : "ghost"}
              className="h-7 px-2"
              onClick={() => (paceArmed ? void paceChange() : setPaceArmed(true))}
              disabled={
                pacePick == null ||
                saving ||
                loading ||
                renderInFlight ||
                clipBusy != null ||
                paceBusy != null ||
                voiceBusy != null
              }
              title="Re-read the whole video at the picked pace — every scene is re-read with the same voice (a real TTS pass), windows re-derive, creative edits survive"
            >
              {paceBusy === "change" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Gauge className="h-3.5 w-3.5" />
              )}
              <span className="ml-1.5 text-xs">
                {paceBusy === "change"
                  ? `Re-reading at ${pacePick}×…`
                  : paceArmed
                    ? `Re-read at ${pacePick}×?`
                    : "Re-read"}
              </span>
            </Button>
          </div>
          <span className="h-5 w-px bg-white/10" aria-hidden />
          {/* S9 — the poster: doc-level scene pick. The cover art's concept
              derives from the PICKED scene's visual + mood (junk or an
              out-of-range index falls back to the opening scene); the thumb
              shows what the world sees, the two-step Regenerate runs the
              CogView pass (the cost disclosure). */}
          <div className="flex items-center gap-1.5 mr-1">
            <ImagePlus className="h-3.5 w-3.5 text-muted-foreground" />
            <Select
              value={(() => {
                const p = docPosterPick(timeline?.renderPrefs);
                return p?.mode === "scene" ? `scene:${p.sceneIndex}` : "auto";
              })()}
              onValueChange={(v) =>
                v === "auto"
                  ? setPosterPick(null) // absent = the pre-S9 chain (opening scene)
                  : setPosterPick({ mode: "scene", sceneIndex: Number(v.slice(6)) })
              }
              disabled={saving || loading || renderInFlight}
            >
              <SelectTrigger
                className="h-7 w-[158px] text-[11px]"
                title="Which scene the cover art depicts — the concept (and the CogView art) derives from the picked scene's visual + mood; Auto keeps the opening scene"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel className="text-[10px]">Poster subject</SelectLabel>
                  <SelectItem value="auto" className="text-[11px]">
                    Auto — opening scene
                  </SelectItem>
                  {timeline?.scenes.map((s) => (
                    <SelectItem key={s.index} value={`scene:${s.index}`} className="text-[11px]">
                      Scene {s.index} — {s.title}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {/* S12 — the cover's STYLE (the subject's sibling axis): what
                the art looks like. A cheap row pick — PATCHes immediately,
                invalidates nothing (the standing cover stays until the
                Regenerate arm beside it repaints in the picked style). */}
            <Select
              value={video.thumbStyle}
              onValueChange={(v) => void pickCoverStyle(v)}
              disabled={saving || loading || renderInFlight || styleSaving}
            >
              <SelectTrigger
                className="h-7 w-[128px] text-[11px]"
                title="What the cover art looks like — the picked style directs the next generation (the Regenerate arm paints it); the A/B variants set leads with it too"
              >
                <Palette className="h-3 w-3 shrink-0 text-muted-foreground" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel className="text-[10px]">Cover style</SelectLabel>
                  {THUMB_STYLES.map((t) => (
                    <SelectItem key={t.id} value={t.id} className="text-[11px]">
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {/* the world's view — the current cover, cache-busted per regen;
                hidden until one exists (the onError arm) */}
            <img
              src={`/api/videos/${videoId}/thumbnail?v=${posterEpoch}`}
              alt="Current poster"
              className="h-7 w-12 rounded-[3px] object-cover border border-white/10 bg-white/5"
              onError={(e) => {
                (e.target as HTMLImageElement).style.visibility = "hidden";
              }}
            />
            <Button
              size="sm"
              variant={posterArmed ? "destructive" : "ghost"}
              className="h-7 px-2"
              onClick={() => (posterArmed ? void regeneratePoster() : setPosterArmed(true))}
              disabled={saving || loading || renderInFlight || posterBusy}
              title="Regenerate the cover from the picked scene — a real image-generation pass (concept → art → quality gate)"
            >
              {posterBusy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ImagePlus className="h-3.5 w-3.5" />
              )}
              <span className="ml-1.5 text-xs">
                {posterBusy ? "Painting…" : posterArmed ? "Regenerate?" : "Regenerate"}
              </span>
            </Button>
          </div>
          <span className="h-5 w-px bg-white/10" aria-hidden />
          {/* S10 — the short: doc-level moment pick. The vertical cut
              centers on the PICKED scene (junk or an out-of-range index
              falls back to the hook heuristic); the arm cuts the 9:16 Short
              from the rendered master — an ffmpeg slice, no generation
              pass, so it is single-step (no cost disclosure needed). */}
          <div className="flex items-center gap-1.5 mr-1">
            <Smartphone className="h-3.5 w-3.5 text-muted-foreground" />
            <Select
              value={(() => {
                const p = docShortPick(timeline?.renderPrefs);
                return p?.mode === "scene" ? `scene:${p.sceneIndex}` : "auto";
              })()}
              onValueChange={(v) =>
                v === "auto"
                  ? setShortPick(null) // absent = the pre-S10 chain (hook heuristic)
                  : setShortPick({ mode: "scene", sceneIndex: Number(v.slice(6)) })
              }
              disabled={saving || loading || renderInFlight}
            >
              <SelectTrigger
                className="h-7 w-[150px] text-[11px]"
                title="Which scene the vertical Short centers on — the cut frames the picked scene; Auto lets the retention-hook heuristic decide"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel className="text-[10px]">Short moment</SelectLabel>
                  <SelectItem value="auto" className="text-[11px]">
                    Auto — best hook
                  </SelectItem>
                  {timeline?.scenes.map((s) => (
                    <SelectItem key={s.index} value={`scene:${s.index}`} className="text-[11px]">
                      Scene {s.index} — {s.title}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            {/* the current cut — what exists on disk; opens the Short */}
            {video.hasShort && video.shortUrl && video.shortScene != null && (
              <a
                href={video.shortUrl}
                target="_blank"
                rel="noreferrer"
                className="shrink-0 rounded-[3px] border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-white/80 hover:bg-white/10"
                title={`Open the current Short — scene ${video.shortScene}, ${(video.shortDuration ?? 0).toFixed(1)}s 9:16`}
              >
                S{video.shortScene} · {(video.shortDuration ?? 0).toFixed(1)}s
              </a>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              onClick={() => void cutShort()}
              disabled={saving || loading || renderInFlight || shortBusy || !video.hasVideo}
              title={
                video.hasVideo
                  ? "Cut the 9:16 vertical Short from the picked scene — an ffmpeg slice of the rendered master (no generation pass)"
                  : "Render the final video first — the Short is cut from the rendered master"
              }
            >
              {shortBusy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Smartphone className="h-3.5 w-3.5" />
              )}
              <span className="ml-1.5 text-xs">
                {shortBusy ? "Cutting…" : video.hasShort ? "Re-cut" : "Cut Short"}
              </span>
            </Button>
          </div>
          <span className="h-5 w-px bg-white/10" aria-hidden />
          {/* S13 — the frame: the picture's shape + smoothness. The studio's
              preview geometry and timecodes ALWAYS followed the row's aspect
              + fps, but the pick lived only on the dialog's export presets —
              the studio displayed a frame it couldn't shape. Cheap row picks
              (PATCH immediate, the standing render stays; the next render
              draws the picked frame). Slides locks the aspect vertical — the
              deck's PNG IS the frame, the render only ever draws 9:16 there. */}
          <div className="flex items-center gap-1.5 mr-1">
            <Frame className="h-3.5 w-3.5 text-muted-foreground" />
            <Select
              value={resolvedAspect}
              onValueChange={(v) => {
                if (v === resolvedAspect) return; // a resolved no-op is not a pick
                void pickFrame({ aspectRatio: v });
              }}
              disabled={
                saving || loading || renderInFlight || frameSaving || video.renderMode === "slides"
              }
            >
              <SelectTrigger
                className="h-7 w-[132px] text-[11px]"
                title={
                  video.renderMode === "slides"
                    ? "Slides are always 9:16 — the deck's designed PNG is the frame; the render never draws another shape for it"
                    : "The picture's shape — the preview re-shapes immediately; the next render draws it (the standing render stays until then)"
                }
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel className="text-[10px]">Frame</SelectLabel>
                  {RENDER_ASPECTS.map((a) => (
                    <SelectItem key={a.id} value={a.id} className="text-[11px]">
                      {a.id} — {a.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Select
              value={String(resolvedFps)}
              onValueChange={(v) => {
                const n = Number(v);
                if (n === resolvedFps) return; // a resolved no-op is not a pick
                void pickFrame({ frameRate: n });
              }}
              disabled={saving || loading || renderInFlight || frameSaving}
            >
              <SelectTrigger
                className="h-7 w-[104px] text-[11px]"
                title="How smoothly motion plays — timecodes re-count immediately (the frames column); the next render runs at it"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel className="text-[10px]">Frame rate</SelectLabel>
                  {RENDER_FRAME_RATES.map((r) => (
                    <SelectItem key={r.fps} value={String(r.fps)} className="text-[11px]">
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          <span className="h-5 w-px bg-white/10" aria-hidden />
          {/* S14 — the delivery: the encode grade + where captions ship.
              Both were dialog-only AND unread (a bare render ignored every
              standing pick); the chains are wired now (body > pick >
              default). The grade is a doc pick (autosave persists); the
              burn is a row pick (PATCH immediate, the standing render
              stays — the next render ships captions the picked way). */}
          <div className="flex items-center gap-1.5 mr-1">
            <FileDown className="h-3.5 w-3.5 text-muted-foreground" />
            <Select
              value={timeline?.renderPrefs?.quality ?? "standard"}
              onValueChange={(v) => {
                if (v === (timeline?.renderPrefs?.quality ?? "standard")) return; // a resolved no-op is not a pick
                setQualityPick(v as ExportQuality);
              }}
              disabled={saving || loading || renderInFlight}
            >
              <SelectTrigger
                className="h-7 w-[104px] text-[11px]"
                title="The encode tier the next render masters at — a doc pick, saved with the timeline; the dialog's per-render preset still overrides for one render"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel className="text-[10px]">Export grade</SelectLabel>
                  <SelectItem value="draft" className="text-[11px]">
                    Draft — fast
                  </SelectItem>
                  <SelectItem value="standard" className="text-[11px]">
                    Standard
                  </SelectItem>
                  <SelectItem value="high" className="text-[11px]">
                    High — master
                  </SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            <Switch
              checked={resolvedBurn}
              onCheckedChange={(b) => void pickBurn(b)}
              disabled={saving || loading || renderInFlight || burnSaving}
              className="scale-90"
              title="Where captions ship — burned into the frame (the style pick applies) or beside it as a sidecar SRT. The next render honors the pick; the dialog's per-render override still wins."
            />
            <span className="w-[64px] shrink-0 text-[10px] leading-tight text-muted-foreground" title="The resolved truth the next render applies when no per-render override rides the body">
              {burnSaving ? "saving…" : resolvedBurn ? "burned in" : "sidecar SRT"}
            </span>
          </div>
          <span className="h-5 w-px bg-white/10" aria-hidden />
          {/* S15 — the motion: the camera + the seam. The preview lanes
              ALWAYS followed the row's motion + transition overrides; the
              picks lived only on the dialog (and the route silently dropped
              hostile shapes). Row-level picks that re-derive the preview —
              PATCH immediate like the frame; the standing render stays.
              Amplitude sleeps when the camera is off, the blend length
              when the seam is a hard cut — the disabled control says why,
              and a standing off-stair pick (the dialog's sliders write
              any legal integer / in-window step) shows as its own item so
              the trigger never blanks. */}
          <div className="flex items-center gap-1.5 mr-1">
            <Move className="h-3.5 w-3.5 text-muted-foreground" />
            <Select
              value={resolvedMotion.mode}
              onValueChange={(v) => {
                if (v === resolvedMotion.mode) return; // a resolved no-op is not a pick
                void pickMotion({ motionMode: v });
              }}
              disabled={saving || loading || renderInFlight || motionSaving}
            >
              <SelectTrigger
                className="h-7 w-[118px] text-[11px]"
                title="How the camera treats still art — the preview's move re-derives now; the next render shoots it (curve + direction variation live on the dialog's card)"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel className="text-[10px]">Camera</SelectLabel>
                  {MOTION_MODES.map((m) => (
                    <SelectItem key={m.id} value={m.id} className="text-[11px]">
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Select
              value={String(resolvedMotion.intensity)}
              onValueChange={(v) => {
                const n = Number(v);
                if (n === resolvedMotion.intensity) return; // a resolved no-op is not a pick
                void pickMotion({ motionIntensity: n });
              }}
              disabled={
                saving || loading || renderInFlight || motionSaving || resolvedMotion.mode === "off"
              }
            >
              <SelectTrigger
                className="h-7 w-[108px] text-[11px]"
                title={
                  resolvedMotion.mode === "off"
                    ? "The camera is off — scenes hold still, amplitude has nothing to say"
                    : "The zoom amplitude (the default is 12%) — the preview's push re-derives now; the next render moves with it"
                }
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel className="text-[10px]">Amplitude</SelectLabel>
                  {![0, 6, 12, 18, 24, 30].includes(resolvedMotion.intensity) && (
                    <SelectItem value={String(resolvedMotion.intensity)} className="text-[11px]">
                      {resolvedMotion.intensity}% — custom
                    </SelectItem>
                  )}
                  {[0, 6, 12, 18, 24, 30].map((n) => (
                    <SelectItem key={n} value={String(n)} className="text-[11px]">
                      {n}% — {n === 0 ? "still" : n === 12 ? "standard" : n >= 18 ? "strong" : "subtle"}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Select
              value={resolvedTransition.style}
              onValueChange={(v) => {
                if (v === resolvedTransition.style) return; // a resolved no-op is not a pick
                void pickMotion({ transitionStyle: v });
              }}
              disabled={saving || loading || renderInFlight || motionSaving}
            >
              <SelectTrigger
                className="h-7 w-[124px] text-[11px]"
                title={
                  video.renderMode === "slides"
                    ? "Slides default to hard cuts (the deck's designed beats land clean) — an explicit pick is honored"
                    : "How scenes hand off — the timeline's blend debt re-derives now; the next render composites it"
                }
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel className="text-[10px]">Seam</SelectLabel>
                  {TRANSITIONS.map((t) => (
                    <SelectItem key={t.id} value={t.id} className="text-[11px]">
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Select
              value={String(resolvedTransition.durationSec)}
              onValueChange={(v) => {
                const n = Number(v);
                if (n === resolvedTransition.durationSec) return; // a resolved no-op is not a pick
                void pickMotion({ transitionDuration: n });
              }}
              disabled={
                saving || loading || renderInFlight || motionSaving || resolvedTransition.style === "cut"
              }
            >
              <SelectTrigger
                className="h-7 w-[92px] text-[11px]"
                title={
                  resolvedTransition.style === "cut"
                    ? "A hard cut is the absence of a blend — there is no length to pick"
                    : "The blend length (the default is 0.5s) — the timeline's seam debt re-derives now"
                }
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel className="text-[10px]">Blend</SelectLabel>
                  {![0.2, 0.3, 0.5, 0.7, 1, 1.5].includes(resolvedTransition.durationSec) && (
                    <SelectItem value={String(resolvedTransition.durationSec)} className="text-[11px]">
                      {resolvedTransition.durationSec}s — custom
                    </SelectItem>
                  )}
                  {[0.2, 0.3, 0.5, 0.7, 1, 1.5].map((n) => (
                    <SelectItem key={n} value={String(n)} className="text-[11px]">
                      {n}s — {n === 0.5 ? "standard" : n <= 0.3 ? "quick" : n >= 1 ? "slow" : "easy"}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
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
                onSoundKind={(bank, kind) => setSoundKind(selectedScene.index, bank, kind)}
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
      <span className="flex items-center gap-1 text-muted-foreground/80">
        <Music2 className="h-2.5 w-2.5" /> music — the studio picks the bed (S7)
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
  /** S5 — the sound stage: pick the scene's SFX cue / ambience bed
   *  (null = follow the plan's pick). Writes the doc's kind. */
  onSoundKind: (bank: "sfx" | "ambient", kind: string | null) => void;
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

function Inspector({ scene, scenesMeta, disabled, onDuration, onTransition, onCaption, onAudio, onSoundKind, onSeekScene, onGrade, onTitle, onCamera, onSpeed, onChroma, onPip, onRevoice, revoicing, hasLogo, slidesMode, videoId, stockMode, onArtChanged }: InspectorProps) {
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

  // ---------- audition (S5) ----------
  // The sound stage's ears: each pick can play the EXACT synthesized wav the
  // render will mix (the audition route streams the same cached file
  // ensureSfx / ensureAmbience materialize). One element, one sound at a
  // time; stopped on unmount — an <audio> must never outlive its panel.
  const auditionRef = useRef<HTMLAudioElement | null>(null);
  const [auditioning, setAuditioning] = useState<string | null>(null); // `${bank}:${kind}`
  const stopAudition = useCallback(() => {
    auditionRef.current?.pause();
    auditionRef.current = null;
    setAuditioning(null);
  }, []);
  useEffect(() => stopAudition, [stopAudition]);
  const toggleAudition = useCallback(
    (bank: "sfx" | "ambient", kind: string) => {
      const key = `${bank}:${kind}`;
      if (auditioning === key) {
        stopAudition();
        return;
      }
      stopAudition();
      const el = new Audio(
        `/api/videos/${videoId}/studio/sound?bank=${bank === "sfx" ? "sfx" : "ambience"}&kind=${encodeURIComponent(kind)}`
      );
      el.addEventListener("ended", stopAudition);
      el.addEventListener("error", stopAudition);
      auditionRef.current = el;
      setAuditioning(key);
      void el.play().catch(stopAudition);
    },
    [auditioning, stopAudition, videoId]
  );

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
        {(["voice", "music"] as const).map((track) => (
          <div key={track} className="flex items-center gap-2">
            <span className="w-24 shrink-0 text-[10px] text-muted-foreground">
              {track === "voice" ? "Voice" : "Music bed"}
            </span>
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

        {/* S5 — the sound stage: the scene's own SFX cue + ambience bed. The
            doc pick outranks the plan's (the render resolves doc > plan >
            row); the audition button plays the exact synthesized wav the
            render will mix. Slides mode keeps the stage — sound is not a
            look; the deck owns only the visuals. */}
        {(
          [
            ["sfx", "SFX cue", SFX_CATALOG],
            ["ambient", "Ambience bed", AMBIENCE_CATALOG],
          ] as const
        ).map(([bank, label, catalog]) => {
          const docKind = bank === "sfx" ? scene.audio.sfx.kind : scene.audio.ambient.kind;
          const bankId = bank === "sfx" ? "sfx" : "ambience";
          const picked = soundChoice(docKind, bankId);
          // When following the plan, the SFX pick IS visible client-side
          // (the row's sfx field); ambience is decided server-side from the
          // approved shot plan — the honest label says so.
          const planSfx = bank === "sfx" && scenesMeta?.sfx && scenesMeta.sfx !== "none" ? scenesMeta.sfx : null;
          const effectiveKind = docKind ?? planSfx;
          const effective = soundChoice(effectiveKind, bankId);
          const note = picked?.note ?? null;
          return (
            <div key={bank} className="space-y-1 rounded-md border border-white/10 bg-white/[0.03] p-2">
              <div className="flex items-center gap-1.5">
                <span className="w-16 shrink-0 text-[10px] font-medium text-foreground/80">{label}</span>
                <Select
                  value={docKind ?? "auto"}
                  onValueChange={(v) => onSoundKind(bank, v === "auto" ? null : v)}
                  disabled={disabled}
                >
                  <SelectTrigger className="h-6 flex-1 text-[11px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto" className="text-[11px]">
                      {bank === "sfx"
                        ? planSfx
                          ? `Auto — plan: ${planSfx}`
                          : "Auto — no cue planned"
                        : "Auto — the Director's bed"}
                    </SelectItem>
                    {catalog.map((c) => (
                      <SelectItem key={c.id} value={c.id} className="text-[11px]">
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 w-6 shrink-0 px-0"
                  disabled={disabled || !effective}
                  onClick={() => effective && toggleAudition(bank, effective.id)}
                  title={
                    effective
                      ? `${auditioning === `${bank}:${effective.id}` ? "Stop" : "Audition"} — the exact synthesized sound the render will mix`
                      : "Nothing to audition — follow the plan's pick or choose a sound"
                  }
                >
                  {auditioning === `${bank}:${effective?.id ?? ""}` ? (
                    <Square className="h-3 w-3" />
                  ) : (
                    <Volume2 className="h-3 w-3" />
                  )}
                </Button>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-16 shrink-0 text-[10px] text-muted-foreground">Level</span>
                <Slider
                  className="h-1.5 flex-1"
                  value={[Math.round(((bank === "sfx" ? scene.audio.sfx.level : scene.audio.ambient.level) ?? 0) * 100)]}
                  min={0}
                  max={100}
                  step={5}
                  disabled={disabled}
                  onValueChange={(v) => onAudio(bank, (v[0] ?? 0) / 100)}
                />
                <span className="w-9 text-right font-mono text-[10px] text-muted-foreground">
                  {Math.round(((bank === "sfx" ? scene.audio.sfx.level : scene.audio.ambient.level) ?? 0) * 100)}%
                </span>
              </div>
              {note && <p className="text-[10px] leading-snug text-muted-foreground">{note}</p>}
            </div>
          );
        })}
        <p className="text-[10px] leading-snug text-muted-foreground">
          Voice/music are the render's mix weights. The SFX cue and ambience bed are the
          studio's own picks — saved in the doc, honored by the render ahead of the plan;
          “Auto” follows the Director. The synthesized fallback bed keeps its fixed profile.
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
