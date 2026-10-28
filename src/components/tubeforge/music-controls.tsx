"use client";

// Shared background-music UI. One hook (useMusicLibrary) + two components:
//   • MusicPickerCard — per-video controls (Create + video detail dialog)
//   • TrackPreviewButton — play/stop a library track inline
//
// The library list streams from GET /api/music (auto-seeds originals on first
// open); settings live in the Setting table (music.* keys).

import { useCallback, useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Music2, Play, Square, BadgeCheck, Sparkles } from "lucide-react";
import { toast } from "sonner";

export interface MusicTrackDTO {
  id: string;
  name: string;
  moods: string[];
  genre: string | null;
  durationSec: number;
  fileSizeBytes: number;
  isOriginal: boolean;
  license: {
    type: string;
    sourceUrl: string | null;
    commercialUse: boolean;
    attributionRequired: boolean;
    attributionText: string | null;
    licenseEvidence: string | null;
    downloadedAt: string;
    contentIdNotes: string | null;
  };
  isActive: boolean;
  previewUrl: string;
  createdAt: string;
}

export interface MusicSettingsDTO {
  enabled: boolean;
  mode: "auto" | "manual";
  trackId: string | null;
  volume: number;
  fadeInSec: number;
  fadeOutSec: number;
}

export function useMusicLibrary() {
  const [tracks, setTracks] = useState<MusicTrackDTO[]>([]);
  const [settings, setSettings] = useState<MusicSettingsDTO | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/music", { cache: "no-store" });
      const d = (await res.json()) as { tracks: MusicTrackDTO[]; settings: MusicSettingsDTO };
      setTracks(d.tracks ?? []);
      setSettings(d.settings ?? null);
    } catch {
      toast.error("Could not load the music library");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { tracks, settings, loading, reload: load, setSettings };
}

/** Save music.* settings keys (partial updates). */
export async function saveMusicSettings(patch: Partial<MusicSettingsDTO>) {
  const res = await fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      Object.fromEntries(
        Object.entries({
          "music.enabled": patch.enabled,
          "music.mode": patch.mode,
          "music.trackId": patch.trackId,
          "music.volume": patch.volume,
          "music.fadeInSec": patch.fadeInSec,
          "music.fadeOutSec": patch.fadeOutSec,
        }).filter(([, v]) => v !== undefined)
      )
    ),
  });
  if (!res.ok) toast.error("Could not save music settings");
  else toast.success("Music settings saved");
}

/** Single shared <audio> so starting a preview stops the previous one. */
const previewState = { audio: null as HTMLAudioElement | null, id: null as string | null };

export function TrackPreviewButton({ track, size = "icon" }: { track: MusicTrackDTO; size?: "icon" | "sm" }) {
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    // Stop reflecting state when another preview took over the singleton.
    const onChange = () => setPlaying(previewState.id === track.id && !previewState.audio?.paused);
    document.addEventListener("tf-preview-change", onChange);
    return () => document.removeEventListener("tf-preview-change", onChange);
  }, [track.id]);

  const toggle = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const a = previewState.audio;
    if (a && previewState.id === track.id && !a.paused) {
      a.pause();
      setPlaying(false);
      document.dispatchEvent(new Event("tf-preview-change"));
      return;
    }
    if (a) a.pause();
    const audio = new Audio(track.previewUrl);
    previewState.audio = audio;
    previewState.id = track.id;
    audio
      .play()
      .then(() => {
        setPlaying(true);
        document.dispatchEvent(new Event("tf-preview-change"));
      })
      .catch(() => toast.error("Preview failed — check your session"));
    audio.addEventListener("ended", () => {
      setPlaying(false);
      document.dispatchEvent(new Event("tf-preview-change"));
    });
  };

  return (
    <Button
      type="button"
      variant="outline"
      size={size}
      onClick={toggle}
      aria-label={playing ? `Stop ${track.name}` : `Preview ${track.name}`}
      className="h-7 w-7 p-0 rounded-full border-white/15"
    >
      {playing ? <Square className="h-3 w-3" /> : <Play className="h-3 w-3" />}
    </Button>
  );
}

export interface MusicPickerValue {
  enabled: boolean | null;
  trackId: string | null;
  volume: number | null;
  fadeIn: number | null;
  fadeOut: number | null;
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

/**
 * Per-video music card: default/auto follows Settings; "Custom" pins a track
 * and volume/fades on the video row. Compact enough for the Create form and
 * the video detail dialog.
 */
export function MusicPickerCard({
  value,
  onChange,
  compact = false,
}: {
  value: MusicPickerValue;
  onChange: (v: MusicPickerValue) => void;
  compact?: boolean;
}) {
  const { tracks, settings, loading } = useMusicLibrary();
  const pinned = tracks.find((t) => t.id === value.trackId) ?? null;

  // Default = follow global settings; show what that would do.
  const globalAuto = settings?.mode === "auto";
  const effectiveEnabled = value.enabled ?? settings?.enabled ?? true;

  return (
    <Card className="glass border-white/10 p-4 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Music2 className="h-4 w-4 text-primary shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-medium leading-none">Background music</p>
            {!compact && (
              <p className="text-[11px] text-muted-foreground mt-1 truncate">
                {pinned
                  ? `Pinned: ${pinned.name}`
                  : effectiveEnabled
                    ? `Auto mood-match by niche${settings && !globalAuto && settings.trackId ? " (manual default from Settings)" : ""}`
                    : "Follows Settings (music off)"}
              </p>
            )}
          </div>
        </div>
        <Switch
          checked={effectiveEnabled}
          onCheckedChange={(v) => onChange({ ...value, enabled: v })}
          aria-label="Toggle background music for this video"
        />
      </div>

      {effectiveEnabled && (
        <>
          <div className="flex items-center gap-2">
            <Select
              value={value.trackId ?? "auto"}
              onValueChange={(v) => onChange({ ...value, trackId: v === "auto" ? null : v })}
            >
              <SelectTrigger className="flex-1 h-8 text-xs" aria-label="Track selection">
                <SelectValue placeholder={loading ? "Loading library…" : "Track"} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto" className="text-xs">
                  <span className="flex items-center gap-1.5">
                    <Sparkles className="h-3 w-3 text-primary" /> Auto mood-match ({globalAuto ? "by niche" : "Settings default"})
                  </span>
                </SelectItem>
                {tracks.filter((t) => t.isActive).map((t) => (
                  <SelectItem key={t.id} value={t.id} className="text-xs">
                    <span className="flex items-center gap-1.5">
                      {t.name}
                      <span className="text-muted-foreground">· {fmt(t.durationSec)}</span>
                      {t.isOriginal && <BadgeCheck className="h-3 w-3 text-emerald-400" />}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {pinned && <TrackPreviewButton track={pinned} />}
          </div>

          <div className="space-y-2.5">
            <div className="flex items-center gap-3">
              <span className="text-[11px] text-muted-foreground w-14 shrink-0">Volume</span>
              <Slider
                value={[Math.round((value.volume ?? settings?.volume ?? 0.5) * 100)]}
                min={0}
                max={100}
                step={5}
                onValueChange={([v]) => onChange({ ...value, volume: v / 100 })}
                aria-label="Music volume"
                className="flex-1"
              />
              <span className="text-[11px] w-8 text-right tabular-nums">
                {Math.round((value.volume ?? settings?.volume ?? 0.5) * 100)}%
              </span>
            </div>
            {!compact && (
              <div className="flex items-center gap-3">
                <span className="text-[11px] text-muted-foreground w-14 shrink-0">Fade in/out</span>
                <Slider
                  value={[
                    value.fadeIn ?? settings?.fadeInSec ?? 1.5,
                    value.fadeOut ?? settings?.fadeOutSec ?? 2.5,
                  ]}
                  min={0.5}
                  max={8}
                  step={0.5}
                  onValueChange={([a, b]) => onChange({ ...value, fadeIn: a, fadeOut: b })}
                  aria-label="Fade in and out seconds"
                  className="flex-1"
                />
                <span className="text-[11px] w-14 text-right tabular-nums">
                  {(value.fadeIn ?? settings?.fadeInSec ?? 1.5).toFixed(1)}/{(value.fadeOut ?? settings?.fadeOutSec ?? 2.5).toFixed(1)}s
                </span>
              </div>
            )}
          </div>

          <p className="text-[10px] text-muted-foreground">
            Every track carries a license record — originals are synthesized in-app (zero Content ID risk).
            {pinned?.license.attributionRequired && pinned.license.attributionText
              ? ` This track needs credit: “${pinned.license.attributionText}”`
              : ""}
          </p>
        </>
      )}
    </Card>
  );
}
