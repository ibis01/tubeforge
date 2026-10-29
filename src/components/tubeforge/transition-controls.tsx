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
//
// Visual previews (globals.css `.tf-tx-*`): every style plays on a two-frame
// micro-stage — indigo frame A, amber frame B — with the reveal window fixed
// at 30–60% of the cycle. Tiles rest PAUSED at the cycle midpoint (a scannable
// "frozen mid-transition" catalog), play on hover, and loop when selected.
// The hero strip always loops the current style at the chosen blend length so
// the slider has visible cause-and-effect.

import type { CSSProperties } from "react";
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

/** Preview cycle length — holds + the reveal window scale with the blend. */
function previewCycleSec(style: TransitionStyle, blendSec: number): number {
  if (style === "cut") return 1.4;
  return Math.max(1.15, 1.05 + blendSec);
}

/**
 * The two-frame transition stage. `mode`:
 *   • "run"   — loop continuously (hero strip, selected tile)
 *   • "hover" — paused at the cycle midpoint; plays while hovered
 * Frames + keyframe families live in globals.css (`.tf-tx-*`).
 */
export function TransitionStage({
  style,
  cycleSec,
  mode,
  className,
}: {
  style: TransitionStyle;
  cycleSec: number;
  mode: "run" | "hover";
  className?: string;
}) {
  const dip = style === "fadeblack" || style === "fadewhite";
  return (
    <div
      className={clsx(
        "tf-tx",
        `tf-tx-${style}`,
        mode === "run" ? "tf-tx-run" : "tf-tx-hover",
        className
      )}
      style={{ "--tf-t": `${cycleSec.toFixed(2)}s` } as CSSProperties}
      aria-hidden
    >
      <div className="tf-tx-frame tf-tx-a" />
      {dip && (
        <div
          className={clsx(
            "tf-tx-frame tf-tx-o",
            style === "fadeblack" ? "tf-o-black" : "tf-o-white"
          )}
        />
      )}
      <div className="tf-tx-frame tf-tx-b" />
    </div>
  );
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
  const cycle = previewCycleSec(t.style, t.durationSec);

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

      {/* Live preview — always looping the current style at the chosen
          blend length, so dragging the slider visibly retimes it. */}
      <div className={clsx(disabled && "opacity-50")}>
        <div className="relative rounded-lg overflow-hidden border border-white/10">
          <TransitionStage style={t.style} cycleSec={cycle} mode="run" className="h-20" />
          <span className="absolute bottom-1.5 left-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[9px] font-medium text-white pointer-events-none">
            SCENE A
          </span>
          <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[9px] font-medium text-white pointer-events-none">
            SCENE B
          </span>
          <span className="absolute top-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[9px] tabular-nums text-white pointer-events-none">
            {isCut ? "instant" : `${t.durationSec.toFixed(1)}s blend`}
          </span>
        </div>
      </div>

      {/* Style grid — every tile previews its style on hover; the selected
          one loops. At rest the grid reads as a frozen mid-transition
          catalog (hard cut shows its A|B split). */}
      <div className={clsx("space-y-1.5", disabled && "opacity-50 pointer-events-none")}>
        <Label className="text-xs text-muted-foreground">Transition style</Label>
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-1.5">
          {TRANSITIONS.map((def) => {
            const selected = t.style === def.id;
            return (
              <button
                key={def.id}
                type="button"
                disabled={disabled}
                onClick={() => onChange({ ...value, style: def.id })}
                title={def.desc}
                aria-pressed={selected}
                className={clsx(
                  "group rounded-lg border px-1 py-1.5 transition-all text-center",
                  selected
                    ? "border-primary/50 bg-primary/8"
                    : "border-white/10 bg-white/3 hover:border-white/25"
                )}
              >
                <TransitionStage
                  style={def.id}
                  cycleSec={cycle}
                  mode={selected ? "run" : "hover"}
                  className={clsx(
                    "h-8",
                    selected
                      ? "ring-1 ring-primary/40"
                      : "opacity-80 group-hover:opacity-100"
                  )}
                />
                <span
                  className={clsx(
                    "block mt-1 text-[10px] leading-tight",
                    selected ? "text-foreground font-medium" : "text-muted-foreground"
                  )}
                >
                  {def.label}
                </span>
              </button>
            );
          })}
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
