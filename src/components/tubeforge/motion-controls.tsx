"use client";

// Shared Smart Motion (Ken Burns) UI — one card used by the Create form and
// the video detail dialog. Mirrors the music-controls pattern:
//   • value uses nulls to mean "follow the built-in defaults"
//   • Create sends the fields on POST /api/videos
//   • the detail dialog PATCHes them (debounced by the caller)
//
// The renderer (src/lib/tubeforge/motion.ts) is the source of truth for the
// semantics: smart scene-aware plans, 12% default zoom intensity, smooth
// easing, direction variation between scenes.

import { Card } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Move3d } from "lucide-react";
import { clsx } from "clsx";

export interface MotionPickerValue {
  mode: string | null; // smart | zoom | pan | off (null = smart)
  intensity: number | null; // 0..30 (% zoom amplitude, null = 12)
  curve: string | null; // smooth | linear (null = smooth)
  vary: boolean | null; // vary direction between scenes (null = true)
}

export const MOTION_PICKER_DEFAULTS = {
  mode: "smart" as const,
  intensity: 12,
  curve: "smooth" as const,
  vary: true,
};

const MODES = [
  { id: "smart", label: "Smart Motion", desc: "Choose movement by scene" },
  { id: "zoom", label: "Zoom only", desc: "Every scene zooms" },
  { id: "pan", label: "Pan only", desc: "Pans & tilts, no zooms" },
  { id: "off", label: "Off", desc: "Static images" },
] as const;

/** The active settings after applying defaults (for display + payload). */
export function effectiveMotion(v: MotionPickerValue) {
  return {
    mode: v.mode ?? MOTION_PICKER_DEFAULTS.mode,
    intensity: v.intensity ?? MOTION_PICKER_DEFAULTS.intensity,
    curve: v.curve ?? MOTION_PICKER_DEFAULTS.curve,
    vary: v.vary ?? MOTION_PICKER_DEFAULTS.vary,
  };
}

/** "Current preview configuration" one-liner (mirrors the renderer summary). */
export function motionSummaryLine(v: MotionPickerValue): string {
  const m = effectiveMotion(v);
  if (m.mode === "off" || m.intensity < 1) return "Static images — no movement";
  const modeLine =
    m.mode === "smart"
      ? "Scene-aware zoom and pan"
      : m.mode === "zoom"
        ? "Zoom moves only"
        : "Pan moves only";
  const zone = m.intensity <= 16 ? "subtle" : "strong";
  return `${modeLine} · ${m.intensity}% zoom intensity (${zone}) · ${
    m.curve === "smooth" ? "smooth easing" : "linear"
  } · direction variation ${m.vary ? "enabled" : "off"}`;
}

function intensityZone(v: number): string {
  if (v < 1) return "None";
  return v <= 16 ? "Subtle" : "Strong";
}

/**
 * Image Motion card. `disabled` greys everything (busy renders);
 * `appliesTo` explains the scope when the current render mode ignores it.
 */
export function MotionControlsCard({
  value,
  onChange,
  compact = false,
  disabled = false,
  note,
}: {
  value: MotionPickerValue;
  onChange: (v: MotionPickerValue) => void;
  compact?: boolean;
  disabled?: boolean;
  note?: string | null;
}) {
  const m = effectiveMotion(value);
  const motionOff = m.mode === "off" || m.intensity < 1;

  return (
    <Card className="glass border-white/10 p-4 space-y-4">
      <div className="flex items-center gap-2 min-w-0">
        <Move3d className="h-4 w-4 text-primary shrink-0" />
        <div className="min-w-0">
          <p className="text-sm font-medium leading-none">Image Motion</p>
          <p className="text-[11px] text-muted-foreground mt-1 truncate">
            Ken Burns camera work over still art — focal points stay in frame
          </p>
        </div>
      </div>

      {/* Movement mode */}
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">Movement mode</Label>
        <div className={clsx("grid grid-cols-2 gap-2", disabled && "opacity-50 pointer-events-none")}>
          {MODES.map((mode) => (
            <button
              key={mode.id}
              type="button"
              disabled={disabled}
              onClick={() => onChange({ ...value, mode: mode.id })}
              className={clsx(
                "rounded-lg border p-2 text-left transition-all",
                m.mode === mode.id
                  ? "border-primary/50 bg-primary/8"
                  : "border-white/10 bg-white/3 hover:border-white/25"
              )}
            >
              <span className="text-[12px] font-medium leading-none">{mode.label}</span>
              <p className="text-[10px] text-muted-foreground mt-1 leading-snug">{mode.desc}</p>
            </button>
          ))}
        </div>
      </div>

      {/* Zoom intensity */}
      <div className={clsx("space-y-2", disabled && "opacity-50 pointer-events-none")}>
        <div className="flex items-center justify-between">
          <Label className="text-xs text-muted-foreground">Zoom intensity</Label>
          <span className="text-xs font-medium tabular-nums text-primary">
            {m.intensity}% · {intensityZone(m.intensity)}
          </span>
        </div>
        <Slider
          value={[m.intensity]}
          min={0}
          max={30}
          step={1}
          disabled={disabled}
          onValueChange={([v]) => onChange({ ...value, intensity: v })}
          aria-label="Zoom intensity percent"
        />
        <div className="flex justify-between text-[10px] text-muted-foreground/70">
          <span>None</span>
          <span>Subtle</span>
          <span>Strong</span>
        </div>
      </div>

      {/* Movement curve + direction variation */}
      {!motionOff && (
        <div className={clsx("space-y-3", disabled && "opacity-50 pointer-events-none")}>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Movement curve</Label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange({ ...value, curve: "smooth" })}
                className={clsx(
                  "rounded-lg border px-2 py-1.5 text-[11px] transition-all",
                  m.curve === "smooth"
                    ? "border-primary/50 bg-primary/8 text-foreground"
                    : "border-white/10 bg-white/3 hover:border-white/25 text-muted-foreground"
                )}
              >
                Smooth — cinematic easing
              </button>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange({ ...value, curve: "linear" })}
                className={clsx(
                  "rounded-lg border px-2 py-1.5 text-[11px] transition-all",
                  m.curve === "linear"
                    ? "border-primary/50 bg-primary/8 text-foreground"
                    : "border-white/10 bg-white/3 hover:border-white/25 text-muted-foreground"
                )}
              >
                Linear — constant speed
              </button>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <div className="min-w-0">
              <Label className="text-xs cursor-pointer">Vary direction between scenes</Label>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                Alternate zooms, pan sides and tilts so no two scenes move alike
              </p>
            </div>
            <Switch
              checked={m.vary}
              disabled={disabled}
              onCheckedChange={(v) => onChange({ ...value, vary: v })}
              aria-label="Vary movement direction between scenes"
            />
          </div>
        </div>
      )}

      {/* Current configuration — mirrors what the renderer will do */}
      <p className="text-[10px] text-muted-foreground leading-relaxed border-t border-white/5 pt-2.5">
        <span className="text-foreground/70">Current configuration:</span>{" "}
        {motionSummaryLine(value)} — applied at render time; 16:9 masters and
        9:16 Shorts each get framing shaped for their format.
      </p>
      {note && (
        <p className="text-[10px] text-sky-300/90 leading-relaxed -mt-1.5">{note}</p>
      )}
      {compact ? null : (
        <p className="text-[10px] text-muted-foreground/70 leading-relaxed -mt-1.5">
          Rehook scenes keep their punch-in hook; text-heavy art automatically
          drops to a near-static hold so captions stay readable.
        </p>
      )}
    </Card>
  );
}
