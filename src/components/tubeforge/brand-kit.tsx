"use client";

// Brand kit — per-video accent color + corner logo badge for the keynote
// slides renderer (render mode "slides"). Self-saving like the music /
// motion / transition cards: every change hits /api/videos/[id]/brand,
// which re-screenshots nothing itself but invalidates the cached slide
// PNGs + rendered MP4s so the next render bakes the brand in.
//
//   • Accent — "Auto" (the built-in per-slide accent catalog) or a hex
//     color that recolors EVERY slide's badge/highlight/price/bar system
//   • Logo   — PNG / WebP / SVG upload, drawn as a small top-right badge
//     on every slide; optional (switch it off without deleting the file)

import { useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Palette, ImageUp, Loader2, Trash2, BadgeCheck } from "lucide-react";
import { clsx } from "clsx";
import { toast } from "sonner";

export interface BrandKitValue {
  accent: string | null; // null = auto (catalog accents)
  hasLogo: boolean;
  showLogo: boolean;
}

const PRESETS = [
  "#FFC918", // keynote yellow (the format's signature)
  "#0A7CFF", // electric blue
  "#00A64F", // emerald
  "#FF3B30", // signal red
  "#8B5CF6", // violet
  "#EC4899", // pink
  "#14B8A6", // teal
  "#F97316", // orange
];

export function BrandKitCard({
  videoId,
  value,
  onSaved,
  disabled = false,
}: {
  videoId: string;
  value: BrandKitValue;
  /** Called after ANY successful change so the parent refreshes the video. */
  onSaved: () => void;
  disabled?: boolean;
}) {
  const [accent, setAccent] = useState<string | null>(value.accent);
  const [savingAccent, setSavingAccent] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const patchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Re-seed when a different video (or fresh server state) arrives.
  useEffect(() => {
    setAccent(value.accent);
  }, [videoId, value.accent]);

  useEffect(
    () => () => {
      if (patchTimer.current) clearTimeout(patchTimer.current);
    },
    []
  );

  const patch = async (body: Record<string, unknown>, optimistic?: () => void) => {
    try {
      const res = await fetch(`/api/videos/${videoId}/brand`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "Could not save brand settings");
      optimistic?.();
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save brand settings");
      setAccent(value.accent); // roll back to the server truth
    } finally {
      setSavingAccent(false);
    }
  };

  const pickAccent = (hex: string | null) => {
    if (disabled) return;
    setAccent(hex);
    setSavingAccent(true);
    if (patchTimer.current) clearTimeout(patchTimer.current);
    // Debounced: the color picker fires a stream of events while dragging.
    patchTimer.current = setTimeout(() => void patch({ accent: hex }), 500);
  };

  const onUpload = async () => {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      toast.error("Choose a logo image first");
      return;
    }
    setUploading(true);
    try {
      const form = new FormData();
      form.set("file", file);
      const res = await fetch(`/api/videos/${videoId}/brand`, { method: "POST", body: form });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "Logo upload failed");
      toast.success("Logo added to every slide", {
        description: "Render again to bake the badge into the video.",
      });
      if (fileRef.current) fileRef.current.value = "";
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Logo upload failed");
    } finally {
      setUploading(false);
    }
  };

  const onRemove = async () => {
    setUploading(true);
    try {
      const res = await fetch(`/api/videos/${videoId}/brand`, { method: "DELETE" });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "Could not remove the logo");
      toast.success("Logo removed");
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not remove the logo");
    } finally {
      setUploading(false);
    }
  };

  return (
    <Card className="glass border-white/10 p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Palette className="h-4 w-4 text-primary shrink-0" />
        <div className="min-w-0">
          <p className="text-sm font-medium leading-none">Brand kit</p>
          <p className="text-[11px] text-muted-foreground mt-1">
            Keynote slides only — your accent + logo on every slide
          </p>
        </div>
      </div>

      {/* Accent */}
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">Accent color</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            disabled={disabled}
            onClick={() => pickAccent(null)}
            aria-pressed={accent === null}
            title="Auto — the art director picks a per-slide accent"
            className={clsx(
              "h-8 rounded-lg border px-2.5 text-[11px] transition-all",
              accent === null
                ? "border-primary/50 bg-primary/10 text-foreground"
                : "border-white/10 bg-white/3 text-muted-foreground hover:border-white/25"
            )}
          >
            Auto
          </button>
          {PRESETS.map((hex) => (
            <button
              key={hex}
              type="button"
              disabled={disabled}
              onClick={() => pickAccent(hex)}
              aria-pressed={accent === hex}
              title={hex}
              className={clsx(
                "h-8 w-8 rounded-lg ring-1 ring-white/15 transition-all",
                accent === hex && "ring-2 ring-primary ring-offset-1 ring-offset-background"
              )}
              style={{ background: hex }}
            />
          ))}
          <label
            title="Custom color"
            className={clsx(
              "relative h-8 w-8 rounded-lg ring-1 ring-white/15 cursor-pointer overflow-hidden",
              disabled && "pointer-events-none opacity-50",
              accent && !PRESETS.includes(accent) && "ring-2 ring-primary ring-offset-1 ring-offset-background"
            )}
            style={
              accent && !PRESETS.includes(accent)
                ? { background: accent }
                : {
                    background:
                      "conic-gradient(#ef4444, #f59e0b, #22c55e, #0ea5e9, #8b5cf6, #ec4899, #ef4444)",
                  }
            }
          >
            <input
              type="color"
              value={accent ?? "#8B5CF6"}
              disabled={disabled}
              onChange={(e) => pickAccent(e.target.value)}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            />
          </label>
          {savingAccent && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        </div>
        <p className="text-[10px] text-muted-foreground/80">
          {accent
            ? `${accent.toUpperCase()} replaces every slide accent (badges, highlights, price chips) — ink contrast is auto-picked.`
            : "Auto — each slide keeps its own accent from the design pass."}
        </p>
      </div>

      {/* Logo badge */}
      <div className="space-y-2.5 rounded-xl border border-white/10 bg-white/3 p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <ImageUp className="h-3.5 w-3.5 text-primary shrink-0" />
            <p className="text-xs font-medium truncate">Logo badge</p>
          </div>
          {value.hasLogo && (
            <div className="flex items-center gap-2">
              <Switch
                checked={value.showLogo}
                disabled={disabled || uploading}
                onCheckedChange={(v) => void patch({ showLogo: v })}
              />
              <span className="text-[10px] text-muted-foreground w-8">
                {value.showLogo ? "On" : "Off"}
              </span>
            </div>
          )}
        </div>

        {value.hasLogo ? (
          <div className="flex items-center gap-3">
            {/* no-cache upstream — always the current logo */}
            <img
              src={`/api/videos/${videoId}/brand`}
              alt="Brand logo"
              className="h-10 w-16 rounded-md bg-white/6 object-contain p-1"
            />
            <p className="text-[10px] text-muted-foreground flex-1 leading-snug">
              {value.showLogo
                ? "Shows top-right on every slide, ~7% of frame height."
                : "Uploaded but hidden — flip the switch to show it."}
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || uploading}
              onClick={onRemove}
              className="h-7 text-[11px] border-white/15 text-red-300 hover:bg-red-500/10 hover:text-red-200"
            >
              {uploading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
              Remove
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-[10px] text-muted-foreground leading-snug">
              PNG / WebP / SVG up to 5 MB — transparency looks best. It sits in
              the top-right corner of every slide.
            </p>
            <div className="flex items-center gap-2">
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/webp,image/svg+xml"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files?.[0]) void onUpload();
                }}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={disabled || uploading}
                onClick={() => fileRef.current?.click()}
                className="h-7 text-[11px] border-white/15 bg-white/4"
              >
                {uploading ? <Loader2 className="h-3 w-3 animate-spin" /> : <ImageUp className="h-3 w-3" />}
                Upload logo…
              </Button>
              <BadgeCheck className="h-3.5 w-3.5 text-emerald-300/70" />
              <span className="text-[10px] text-muted-foreground">optional — slides work without it</span>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
