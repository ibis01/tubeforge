"use client";

// Shared scene-transition UI — one card used by the Create form and the video
// detail dialog. Mirrors the motion-controls pattern:
//   • value uses nulls to mean "follow the built-in default" (crossfade 0.5s)
//   • Create sends the fields on POST /api/videos
//   • the detail dialog PATCHes them (debounced by the caller)
//
// The renderer (src/lib/tubeforge/transitions.ts) is the source of truth:
// "cut" keeps the classic hard-cut concat; every other style runs one chained
// xfade/acrossfade pass so scenes blend with matching audio crossfades.

import { Card } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { Blend } from "lucide-react";
import { clsx } from "clsx";
import {
  TRANSITIONS,
  TRANSITION_DEFAULT,
  type TransitionStyle,
} from "@/lib/tubeforge/transitions";

export interface TransitionPickerValue {
  style: string | null; // transitions.ts catalog id (null = default fade)
  durationSec: number | null; // 0.2..1.5 (null = 0.5)
}

export const TRANSITION_PICKER_DEFAULTS = TRANSITION_DEFAULT;

/** The active settings after applying defaults (for display + payload). */
export function effectiveTransition(v: TransitionPickerValue) {
  return {
    style: (v.style ?? TRANSITION_DEFAULT.style) as TransitionStyle,
    durationSec: v.durationSec ?? TRANSITION_DEFAULT.durationSec,
  };
}

/** "Current configuration" one-liner (mirrors the renderer summary). */
export function transitionSummaryLine(v: TransitionPickerValue): string {
  const t = effectiveTransition(v);
  if (t.style === "cut") return "Hard cuts — scenes switch instantly";
  const def = TRANSITIONS.find((x) => x.id === t.style);
  return `${def?.label ?? t.style} · ${t.durationSec.toFixed(1)}s blend, audio crossfades to match`;
}

/**
 * Scene Transitions card. `disabled` greys everything (busy renders);
 * `compact` trims the description footnotes for the Create form.
 */
export function TransitionControlsCard({
  value,
  onChange,
  compact = false,
  disabled = false,
  note,
}: {
  value: TransitionPickerValue;
  onChange: (v: TransitionPickerValue) => void;
  compact?: boolean;
  disabled?: boolean;
  note?: string | null;
}) {
  const t = effectiveTransition(value);
  const isCut = t.style === "cut";

  return (
    <Card className="glass border-white/10 p-4 space-y-4">
      <div className="flex items-center gap-2 min-w-0">
        <Blend className="h-4 w-4 text-primary shrink-0" />
        <div className="min-w-0">
          <p className="text-sm font-medium leading-none">Scene transitions</p>
          <p className="text-[11px] text-muted-foreground mt-1 truncate">
            How scenes flow into each other — video and audio blend together
          </p>
        </div>
      </div>

      {/* Style grid */}
      <div className={clsx("space-y-1.5", disabled && "opacity-50 pointer-events-none")}>
        <Label className="text-xs text-muted-foreground">Transition style</Label>
        <div className="grid grid-cols-3 gap-1.5">
          {TRANSITIONS.map((def) => (
            <button
              key={def.id}
              type="button"
              disabled={disabled}
              onClick={() => onChange({ ...value, style: def.id })}
              title={def.desc}
              aria-pressed={t.style === def.id}
              className={clsx(
                "rounded-lg border px-2 py-1.5 text-[11px] leading-tight transition-all text-left",
                t.style === def.id
                  ? "border-primary/50 bg-primary/8 text-foreground"
                  : "border-white/10 bg-white/3 hover:border-white/25 text-muted-foreground"
              )}
            >
              {def.label}
            </button>
          ))}
        </div>
        <p className="text-[10px] text-muted-foreground/80 pt-0.5">
          {TRANSITIONS.find((x) => x.id === t.style)?.desc}
        </p>
      </div>

      {/* Blend length */}
      {!isCut && (
        <div className={clsx("space-y-2", disabled && "opacity-50 pointer-events-none")}>
          <div className="flex items-center justify-between">
            <Label className="text-xs text-muted-foreground">Blend length</Label>
            <span className="text-xs font-medium tabular-nums text-primary">
              {t.durationSec.toFixed(1)}s
            </span>
          </div>
          <Slider
            value={[t.durationSec]}
            min={0.2}
            max={1.5}
            step={0.1}
            disabled={disabled}
            onValueChange={([v]) => onChange({ ...value, durationSec: v })}
            aria-label="Transition blend length in seconds"
          />
          <div className="flex justify-between text-[10px] text-muted-foreground/70">
            <span>Snappy</span>
            <span>Cinematic</span>
          </div>
        </div>
      )}

      {/* Current configuration — mirrors what the renderer will do */}
      <p className="text-[10px] text-muted-foreground leading-relaxed border-t border-white/5 pt-2.5">
        <span className="text-foreground/70">Current configuration:</span>{" "}
        {transitionSummaryLine(value)} — applied at render time; narration sits
        inside the scene lead/tail silence so blends never clip words.
      </p>
      {note && !compact && (
        <p className="text-[10px] text-sky-300/90 leading-relaxed -mt-1.5">{note}</p>
      )}
    </Card>
  );
}
