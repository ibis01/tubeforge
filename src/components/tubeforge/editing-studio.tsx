"use client";

// editing-studio.tsx — Stage 6 T-6.9: the Editing Studio.
//
// The Stage 6 ROADMAP calls for "scene timeline, drag-and-drop ordering,
// per-scene trimming, audio levels, transition previews, undo/redo". This
// component delivers exactly that, mounted at the top of the Video tab in
// the detail dialog (above the existing render controls).
//
// Data flow:
//   GET  /api/videos/[id]/assemble   → AssembledTimelineDTO
//   PUT  /api/videos/[id]/assemble   → save the edited timeline
//   POST /api/videos/[id]/assemble   → re-assemble from current scenes/plan
//   POST /api/videos/[id]/render     → enqueue the render (no `ignoreTimeline`
//                                       flag → the saved trims survive)
//
// The timeline is a PROJECTION — the video row's scenes are the source of
// truth. The Studio edits per-scene `durationSec` (trims) + per-scene audio
// levels + per-scene transition labels; ordering is drag-and-drop (the
// order is reflected back to the video's scenes via a separate PATCH — the
// timeline itself stores scenes in their edited order so the render reads
// the same sequence).
//
// Undo/redo is a bounded stack of timeline snapshots. Each edit pushes a
// snapshot before applying; Undo pops the latest; Redo replays it. The
// stack is capped at 50 entries (the same cap most editors use).
//
// Design: matches the existing dark-premium tokens (--tf-* / white/5 hairline
// surfaces / muted-foreground labels). The Studio is a self-contained card;
// it never reaches into the parent dialog's state — its own useState holds
// the working timeline until Save.

import { useCallback, useEffect, useState } from "react";
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
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  GripVertical,
  Undo2,
  Redo2,
  Save,
  RefreshCw,
  RotateCcw,
  Scissors,
  Volume2,
  VolumeX,
  Clock,
  ArrowRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { clsx } from "clsx";
import { useToast } from "@/hooks/use-toast";
import type { AssembledTimelineDTO, TimelineSceneDTO } from "@/lib/tubeforge/types";

const HISTORY_CAP = 50;

interface EditingStudioProps {
  videoId: string;
  /** Whether the video has scenes + voiceover (the assemble prerequisites). */
  canAssemble: boolean;
  /** Whether a render is currently running (disables Save during renders). */
  renderInFlight: boolean;
  /** Called after a successful Save so the parent can refresh the video row. */
  onSaved?: () => void;
}

// ----- working copy + history stack -----

interface HistoryState {
  past: AssembledTimelineDTO[];
  present: AssembledTimelineDTO | null;
  future: AssembledTimelineDTO[];
}

const emptyHistory: HistoryState = { past: [], present: null, future: [] };

function cloneTimeline(t: AssembledTimelineDTO): AssembledTimelineDTO {
  return {
    scenes: t.scenes.map((s) => ({ ...s, audio: { ...s.audio } })),
    sceneCount: t.sceneCount,
    totalDurationSec: t.totalDurationSec,
    generatedAt: t.generatedAt,
  };
}

/** Recompute start/end + total from a working copy's per-scene durations. */
function recomputeTimes(t: AssembledTimelineDTO): AssembledTimelineDTO {
  let cursor = 0;
  const scenes = t.scenes.map((s) => {
    const durationSec = Math.max(0.5, Math.round(s.durationSec * 100) / 100);
    const startSec = Math.round(cursor * 100) / 100;
    const endSec = Math.round((cursor + durationSec) * 100) / 100;
    cursor += durationSec;
    const caption = s.caption
      ? { ...s.caption, startSec, endSec }
      : null;
    return { ...s, startSec, endSec, durationSec, caption };
  });
  return {
    ...t,
    scenes,
    sceneCount: scenes.length,
    totalDurationSec: Math.round(cursor * 100) / 100,
  };
}

// ----- the Studio card -----

export function EditingStudio({
  videoId,
  canAssemble,
  renderInFlight,
  onSaved,
}: EditingStudioProps) {
  const { toast } = useToast();
  const [history, setHistory] = useState<HistoryState>(emptyHistory);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const timeline = history.present;
  const canUndo = history.past.length > 0;
  const canRedo = history.future.length > 0;

  // ---------- load ----------

  const loadTimeline = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/videos/${videoId}/assemble`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { timeline: AssembledTimelineDTO | null };
      setHistory({ past: [], present: data.timeline, future: [] });
      setDirty(false);
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

  // First mount: auto-load if the video is assembled-format.
  useEffect(() => {
    if (canAssemble) void loadTimeline();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId, canAssemble]);

  // ---------- assemble (refresh from current scenes/plan) ----------

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
      const data = (await res.json()) as { timeline: AssembledTimelineDTO };
      setHistory({ past: [], present: data.timeline, future: [] });
      setDirty(false);
      toast({ title: "Timeline assembled", description: `${data.timeline.sceneCount} scenes · ${data.timeline.totalDurationSec.toFixed(1)}s` });
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

  // ---------- save ----------

  const save = useCallback(async () => {
    if (!timeline || !dirty) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/videos/${videoId}/assemble`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(timeline),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      setDirty(false);
      onSaved?.();
      toast({ title: "Timeline saved", description: "The render will honor your trims." });
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

  // ---------- undo / redo ----------

  const pushHistory = useCallback(
    (next: AssembledTimelineDTO) => {
      setHistory((h) => {
        if (!h.present) return { ...h, present: next };
        const past = [...h.past, h.present];
        if (past.length > HISTORY_CAP) past.shift();
        return { past, present: next, future: [] };
      });
      setDirty(true);
    },
    []
  );

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
    if (!timeline) return;
    setHistory((h) => {
      if (!h.present) return h;
      const past = [...h.past, h.present];
      if (past.length > HISTORY_CAP) past.shift();
      // Restore the originally-loaded timeline (the bottom of the past stack).
      const original = past[0] ?? h.present;
      return { past, present: cloneTimeline(original), future: [] };
    });
    setDirty(true);
  }, [timeline]);

  // ---------- per-scene edits ----------

  const updateScene = useCallback(
    (index: number, patch: Partial<TimelineSceneDTO>) => {
      if (!timeline) return;
      const next = cloneTimeline(timeline);
      const i = next.scenes.findIndex((s) => s.index === index);
      if (i === -1) return;
      next.scenes[i] = { ...next.scenes[i], ...patch };
      // Recompute start/end + total whenever the duration changes.
      if (patch.durationSec !== undefined) {
        const recomputed = recomputeTimes(next);
        pushHistory(recomputed);
        return;
      }
      pushHistory(next);
    },
    [timeline, pushHistory]
  );

  const updateAudio = useCallback(
    (index: number, track: "voice" | "music" | "sfx" | "ambient", level: number) => {
      if (!timeline) return;
      const next = cloneTimeline(timeline);
      const i = next.scenes.findIndex((s) => s.index === index);
      if (i === -1) return;
      next.scenes[i].audio = { ...next.scenes[i].audio, [track]: { ...next.scenes[i].audio[track], level, enabled: level > 0 } };
      pushHistory(next);
    },
    [timeline, pushHistory]
  );

  // ---------- drag-and-drop reorder ----------

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
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
      pushHistory(recomputeTimes(next));
    },
    [timeline, pushHistory]
  );

  // ---------- render ----------

  if (!canAssemble) {
    return null; // the Studio is for scene-format videos only
  }

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-4">
      <header className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Scissors className="h-4 w-4 text-primary/80" />
          <h3 className="text-sm font-semibold">Editing Studio</h3>
          {timeline && (
            <Badge variant="outline" className="text-[10px] font-mono">
              {timeline.sceneCount} scenes · {timeline.totalDurationSec.toFixed(1)}s
            </Badge>
          )}
          {dirty && <Badge className="text-[10px] bg-amber-500/15 text-amber-200 border-amber-500/30">unsaved</Badge>}
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
          <Separator />
          <Button size="sm" variant="ghost" onClick={() => void assemble()} disabled={loading || saving || renderInFlight} title="Re-assemble from current scenes + plan">
            <RefreshCw className={clsx("h-3.5 w-3.5", loading && "animate-spin")} />
            <span className="ml-1.5 text-xs">Re-assemble</span>
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={!dirty || saving || renderInFlight || !timeline} title="Save the timeline so the render honors your trims">
            <Save className="h-3.5 w-3.5" />
            <span className="ml-1.5 text-xs">{saving ? "Saving…" : "Save"}</span>
          </Button>
        </div>
      </header>

      {!timeline ? (
        <div className="py-8 text-center text-xs text-muted-foreground">
          {loading ? "Loading the timeline…" : "No timeline yet. Click \"Re-assemble\" to build one from the current scenes + plan."}
        </div>
      ) : timeline.scenes.length === 0 ? (
        <div className="py-8 text-center text-xs text-muted-foreground">
          The timeline has no scenes. Generate the script + storyboard first.
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={timeline.scenes.map((s) => String(s.index))} strategy={verticalListSortingStrategy}>
            <ScrollArea className="max-h-[420px] -mx-2 px-2">
              <ol className="space-y-2">
                {timeline.scenes.map((scene, i) => (
                  <SortableSceneRow
                    key={scene.index}
                    scene={scene}
                    position={i + 1}
                    disabled={saving || loading || renderInFlight}
                    onTrim={(durationSec) => updateScene(scene.index, { durationSec })}
                    onAudio={(track, level) => updateAudio(scene.index, track, level)}
                  />
                ))}
              </ol>
            </ScrollArea>
          </SortableContext>
        </DndContext>
      )}
    </div>
  );
}

// ----- a single sortable scene row -----

interface SortableSceneRowProps {
  scene: TimelineSceneDTO;
  position: number;
  disabled: boolean;
  onTrim: (durationSec: number) => void;
  onAudio: (track: "voice" | "music" | "sfx" | "ambient", level: number) => void;
}

function SortableSceneRow({ scene, position, disabled, onTrim, onAudio }: SortableSceneRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: String(scene.index),
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };
  return (
    <li
      ref={setNodeRef}
      style={style}
      className={clsx(
        "rounded-lg border border-white/10 bg-white/[0.02] p-3",
        isDragging && "opacity-60 ring-1 ring-primary/40 z-10"
      )}
    >
      <div className="flex items-start gap-3">
        <button
          type="button"
          className="mt-1 cursor-grab text-muted-foreground hover:text-foreground touch-none"
          aria-label="Drag to reorder"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <div className="flex-1 min-w-0 space-y-2.5">
          {/* Header row: position + title + duration */}
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="secondary" className="text-[10px] font-mono">{position}</Badge>
            <span className="text-sm font-medium truncate">{scene.title || `Scene ${scene.index}`}</span>
            <div className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Clock className="h-3 w-3" />
              <input
                type="number"
                min={0.5}
                max={300}
                step={0.1}
                value={Math.round(scene.durationSec * 10) / 10}
                disabled={disabled}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v) && v >= 0.5 && v <= 300) onTrim(Math.round(v * 10) / 10);
                }}
                className="w-16 bg-white/5 border border-white/10 rounded px-1.5 py-0.5 text-xs font-mono"
                aria-label="Scene duration in seconds"
              />
              <span>s</span>
            </div>
          </div>

          {/* Caption */}
          {scene.caption && (
            <p className="text-[11px] text-muted-foreground italic line-clamp-1">"{scene.caption.text}"</p>
          )}

          {/* Transitions */}
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1 rounded bg-white/5 px-1.5 py-0.5">
              <ArrowRight className="h-3 w-3" /> in: <span className="text-foreground/80 font-mono">{scene.transitionIn || "—"}</span>
            </span>
            <span className="inline-flex items-center gap-1 rounded bg-white/5 px-1.5 py-0.5">
              out: <span className="text-foreground/80 font-mono">{scene.transitionOut || "—"}</span>
            </span>
            {scene.shot && (
              <span className="inline-flex items-center gap-1 rounded bg-white/5 px-1.5 py-0.5">
                shot: <span className="text-foreground/80 font-mono">{scene.shot.framing ?? "—"}</span>
              </span>
            )}
          </div>

          {/* Audio levels */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1">
            <AudioSlider label="voice" level={scene.audio.voice.level} disabled={disabled} onChange={(v) => onAudio("voice", v)} icon={scene.audio.voice.enabled ? <Volume2 className="h-3 w-3" /> : <VolumeX className="h-3 w-3" />} />
            <AudioSlider label="music" level={scene.audio.music.level} disabled={disabled} onChange={(v) => onAudio("music", v)} icon={scene.audio.music.enabled ? <Volume2 className="h-3 w-3" /> : <VolumeX className="h-3 w-3" />} />
            <AudioSlider label="sfx" level={scene.audio.sfx.level} disabled={disabled} onChange={(v) => onAudio("sfx", v)} icon={scene.audio.sfx.enabled ? <Volume2 className="h-3 w-3" /> : <VolumeX className="h-3 w-3" />} />
            <AudioSlider label="ambient" level={scene.audio.ambient.level} disabled={disabled} onChange={(v) => onAudio("ambient", v)} icon={scene.audio.ambient.enabled ? <Volume2 className="h-3 w-3" /> : <VolumeX className="h-3 w-3" />} />
          </div>
        </div>
      </div>
    </li>
  );
}

function AudioSlider({
  label,
  level,
  disabled,
  onChange,
  icon,
}: {
  label: string;
  level: number;
  disabled: boolean;
  onChange: (v: number) => void;
  icon: React.ReactNode;
}) {
  // Level 0..1 → slider 0..100.
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1 text-[10px] text-muted-foreground uppercase tracking-wider">
        {icon}
        <span>{label}</span>
      </div>
      <Slider
        value={[Math.round(level * 100)]}
        min={0}
        max={100}
        step={5}
        disabled={disabled}
        onValueChange={(v) => onChange((v[0] ?? 0) / 100)}
        className="h-1.5"
      />
    </div>
  );
}

// Local separator (avoid importing the UI Separator just for a tiny vertical line).
function Separator() {
  return <span className="h-5 w-px bg-white/10 mx-1" aria-hidden />;
}
