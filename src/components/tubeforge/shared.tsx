"use client";

import { useEffect, useSyncExternalStore, useState } from "react";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import * as SelectPrimitive from "@radix-ui/react-select";
import { CheckIcon, Loader2, Play, Square } from "lucide-react";
import { STATUS_META, VOICES, type VideoStatus } from "@/lib/tubeforge/types";
import type { LucideIcon } from "lucide-react";
import { clsx } from "clsx";

/** Voice catalog of the ACTIVE voiceover provider (Z.ai or OpenAI-compatible).
 *  Falls back to the built-in Z.ai list until the endpoint answers.
 *  Cloned voices arrive merged in the same payload (zhipu provider) and every
 *  picker live-updates when a voice is cloned or deleted. */
export const VOICES_CHANGED_EVENT = "tubeforge:voices-changed";

export function useVoices() {
  const [voices, setVoices] = useState<{ id: string; label: string }[]>(() =>
    VOICES.map((v) => ({ id: v.id, label: v.label }))
  );
  const [provider, setProvider] = useState("zai");
  const [canClone, setCanClone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch("/api/settings/voices", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (cancelled || !d?.voices?.length) return;
          setVoices(d.voices);
          setProvider(d.provider ?? "zai");
          setCanClone(Boolean(d.canClone));
        })
        .catch(() => {});
    };
    load();
    // A fresh clone (or a delete) re-fetches so every open picker updates.
    window.addEventListener(VOICES_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(VOICES_CHANGED_EVENT, load);
    };
  }, []);

  return { voices, provider, canClone };
}

export function StatusBadge({
  status,
  className,
}: {
  status: VideoStatus;
  className?: string;
}) {
  const meta = STATUS_META[status] ?? STATUS_META.draft;
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium",
        meta.color,
        className
      )}
    >
      {meta.label}
    </span>
  );
}

export function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  accent,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <Card
      className={clsx(
        "glass border-white/8 rounded-2xl p-4 sm:p-5 relative overflow-hidden",
        accent && "glow-red-soft"
      )}
    >
      {accent && (
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/60 to-transparent" />
      )}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground font-medium truncate">{label}</p>
          <p className="text-2xl sm:text-[28px] font-bold tracking-tight mt-1 tabular-nums">
            {value}
          </p>
          {sub && <p className="text-[11px] text-muted-foreground mt-1 truncate">{sub}</p>}
        </div>
        <div
          className={clsx(
            "h-10 w-10 rounded-xl flex items-center justify-center shrink-0",
            accent ? "bg-brand-gradient glow-red-soft" : "bg-white/6 border border-white/10"
          )}
        >
          <Icon className={clsx("h-5 w-5", accent ? "text-white" : "text-primary")} />
        </div>
      </div>
    </Card>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
}: {
  icon: LucideIcon;
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="glass rounded-2xl p-8 sm:p-10 flex flex-col items-center text-center">
      <div className="h-16 w-16 rounded-2xl bg-primary/10 border border-primary/25 flex items-center justify-center">
        <Icon className="h-7 w-7 text-primary" />
      </div>
      <p className="mt-5 text-base font-medium tracking-tight">{title}</p>
      {hint && (
        <p className="text-sm text-muted-foreground mt-1.5 max-w-md leading-relaxed">{hint}</p>
      )}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}

export function formatDuration(sec: number | null | undefined): string {
  if (!sec || sec <= 0) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// ---------------------------------------------------------------------------
// Voice preview — "hear it before you pick it".
//
// One module-level audio element + tiny pub/sub store so ALL pickers share
// playback state: starting a new preview stops the previous one everywhere.
// Blob URLs are cached for the page lifetime; the SERVER caches the WAV per
// provider/model/voice, so repeat auditions are free.
// ---------------------------------------------------------------------------

type PreviewState = {
  loading: string | null;
  playing: string | null;
  error: string | null;
};

let previewState: PreviewState = { loading: null, playing: null, error: null };
const previewSubs = new Set<() => void>();
let previewAudio: HTMLAudioElement | null = null;
const previewBlobUrls = new Map<string, string>();
const previewInflight = new Map<string, Promise<Blob>>();

function setPreviewState(partial: Partial<PreviewState>) {
  previewState = { ...previewState, ...partial };
  previewSubs.forEach((fn) => fn());
}

function stopPreviewAudio() {
  if (previewAudio) {
    previewAudio.pause();
    previewAudio.src = "";
    previewAudio = null;
  }
  if (previewState.playing) setPreviewState({ playing: null });
}

async function fetchPreviewBlob(voiceId: string): Promise<Blob> {
  const existing = previewInflight.get(voiceId);
  if (existing) return existing;
  const promise = fetch("/api/settings/voices/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ voice: voiceId }),
  }).then(async (r) => {
    if (!r.ok) {
      const j = (await r.json().catch(() => null)) as { error?: string } | null;
      throw new Error(j?.error || `Preview failed (HTTP ${r.status})`);
    }
    return r.blob();
  });
  previewInflight.set(voiceId, promise);
  try {
    return await promise;
  } finally {
    previewInflight.delete(voiceId);
  }
}

function toggleVoicePreview(voiceId: string) {
  if (previewState.playing === voiceId) {
    stopPreviewAudio();
    return;
  }
  if (previewState.loading === voiceId) return;
  stopPreviewAudio();
  setPreviewState({ loading: voiceId, error: null });

  const cached = previewBlobUrls.get(voiceId);
  const ready = cached ? Promise.resolve(cached) : fetchPreviewBlob(voiceId);

  ready
    .then((blobOrUrl) => {
      // User moved on to another voice while this one loaded — keep the
      // cached blob, but don't play it.
      if (previewState.loading !== voiceId) return;
      const url = typeof blobOrUrl === "string" ? blobOrUrl : URL.createObjectURL(blobOrUrl);
      if (typeof blobOrUrl !== "string") previewBlobUrls.set(voiceId, url);
      const audio = new Audio(url);
      previewAudio = audio;
      audio.onended = () => {
        previewAudio = null;
        if (previewState.playing === voiceId) setPreviewState({ playing: null });
      };
      audio.onerror = () => {
        previewAudio = null;
        setPreviewState({ playing: null, error: "Couldn't play the preview" });
      };
      setPreviewState({ playing: voiceId, loading: null });
      return audio.play();
    })
    .catch((err: unknown) => {
      if (previewState.loading === voiceId) {
        setPreviewState({
          loading: null,
          playing: null,
          error: err instanceof Error ? err.message : "Preview failed",
        });
      }
    });
}

function subscribePreview(fn: () => void) {
  previewSubs.add(fn);
  return () => {
    previewSubs.delete(fn);
  };
}

/** Shared voice-preview state — same instance semantics in every picker. */
export function useVoicePreview(): PreviewState & {
  togglePreview: (voiceId: string) => void;
  stopPreview: () => void;
} {
  const snap = useSyncExternalStore(subscribePreview, () => previewState);
  return { ...snap, togglePreview: toggleVoicePreview, stopPreview: stopPreviewAudio };
}

/** Voice picker with a per-voice ▶ audition button that doesn't select/close. */
export function VoiceSelectWithPreview({
  value,
  onValueChange,
  voices,
  disabled,
  className,
  triggerClassName,
  itemClassName,
}: {
  value: string;
  onValueChange: (voice: string) => void;
  voices: { id: string; label: string }[];
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
  itemClassName?: string;
}) {
  const { loading, playing, error, togglePreview } = useVoicePreview();

  return (
    <div className={clsx("space-y-1", className)}>
      <Select value={value} onValueChange={onValueChange} disabled={disabled}>
        <SelectTrigger className={clsx("bg-white/5", triggerClassName)}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {voices.map((v) => {
            const isPlaying = playing === v.id;
            const isLoading = loading === v.id;
            return (
              // Raw Radix primitives: shadcn's SelectItem wraps ALL children in
              // ItemText, which Radix clones into the trigger — the play button
              // must stay OUTSIDE ItemText so only the label reaches the trigger.
              <SelectPrimitive.Item
                key={v.id}
                value={v.id}
                textValue={v.label}
                className={clsx(
                  "relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pl-2 pr-8 text-sm outline-none",
                  "focus:bg-accent focus:text-accent-foreground data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
                  "data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
                  itemClassName
                )}
              >
                <span className="absolute right-2 flex size-3.5 items-center justify-center">
                  <SelectPrimitive.ItemIndicator>
                    <CheckIcon className="size-4" />
                  </SelectPrimitive.ItemIndicator>
                </span>
                <SelectPrimitive.ItemText asChild>
                  <span className="truncate flex-1">{v.label}</span>
                </SelectPrimitive.ItemText>
                <button
                  type="button"
                  aria-label={isPlaying ? `Stop ${v.label} preview` : `Preview ${v.label}`}
                  title={isPlaying ? "Stop preview" : "Hear how it sounds"}
                  tabIndex={-1}
                  onPointerDown={(e) => e.stopPropagation()}
                  onPointerUp={(e) => e.stopPropagation()}
                  onTouchEnd={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    togglePreview(v.id);
                  }}
                  className={clsx(
                    "ml-2 grid h-6 w-6 shrink-0 place-items-center rounded-full border transition-colors",
                    isPlaying
                      ? "border-primary/60 bg-primary/20 text-primary"
                      : "border-white/10 bg-white/8 text-muted-foreground hover:bg-white/15 hover:text-foreground"
                  )}
                >
                  {isLoading ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : isPlaying ? (
                    <Square className="h-2.5 w-2.5 fill-current" />
                  ) : (
                    <Play className="h-3 w-3 fill-current" />
                  )}
                </button>
              </SelectPrimitive.Item>
            );
          })}
        </SelectContent>
      </Select>
      {error && (
        <p className="text-[11px] leading-relaxed text-red-400/90" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
