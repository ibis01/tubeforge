"use client";

// B4-2 — the motion & easing authoring panel (Creative Workspace Enhancement).
//
// The audit's verdict for the graphics lane: "the engine is ahead of the UI" —
// keyframed tweens (S129), the scene camera (S130), timed events (S131) and
// fifteen exact-op easing curves (S162) all existed behind validated seams
// while the studio exposed none of them. This panel closes that gap with NO
// renderer changes: every edit mutates the working doc the studio already
// PUTs through the validator, and everything evaluates through the existing
// frameAt/cameraAt the moment it saves.
//
// Scope (per the B4 spec §2): element insertion (closed grammar), the
// enter/exit/emphasis motion editor with the 15-curve ease dropdown, the
// tween channel/key editor, and the scene camera keys editor with the
// CAMERA_BOUNDS pins surfaced. Time-sanity stays the validator's job — this
// panel is a friendly writer, not a second wall.

import {
  CAMERA_BOUNDS,
  GRAPHICS_ELEMENT_KINDS,
  MOTION_KINDS_BY_ELEMENT,
  TWEEN_CHANNELS,
  type GraphicsEase,
  type GraphicsElement,
  type GraphicsElementKind,
  type GraphicsMotionKind,
  type GraphicsScene,
  type TweenChannel,
} from "@/lib/tubeforge/graphics/types";
import { EASE_CURVES } from "@/lib/tubeforge/anim/easing";
import type { Placement } from "@/lib/tubeforge/whiteboard/svg";

const EASE_NAMES = Object.keys(EASE_CURVES) as GraphicsEase[];

const MOTION_SLOT_LABELS = { enter: "Enter (required)", exit: "Exit", emphasis: "Emphasis" } as const;
type MotionSlot = keyof typeof MOTION_SLOT_LABELS;

/** Numeric field with blur/Enter commit — the PlacementNumber pattern. */
function Num({
  value,
  min,
  max,
  step = 1,
  width = "w-14",
  onCommit,
  ariaLabel,
}: {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  width?: string;
  onCommit: (v: number) => void;
  ariaLabel: string;
}) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(e) => {
        const v = Number(e.target.value);
        if (!Number.isFinite(v)) return;
        let out = v;
        if (min !== undefined) out = Math.max(min, out);
        if (max !== undefined) out = Math.min(max, out);
        onCommit(out);
      }}
      className={`${width} h-7 rounded-md border border-white/10 bg-white/5 px-1.5 text-xs tabular-nums text-white/85`}
      aria-label={ariaLabel}
    />
  );
}

function EaseSelect({
  value,
  onCommit,
  ariaLabel,
}: {
  value: GraphicsEase | undefined;
  onCommit: (v: GraphicsEase | undefined) => void;
  ariaLabel: string;
}) {
  return (
    <select
      value={value ?? "linear"}
      onChange={(e) => onCommit((e.target.value === "linear" ? undefined : e.target.value) as GraphicsEase | undefined)}
      className="h-7 rounded-md border border-white/10 bg-white/5 px-1 text-[11px] text-white/85"
      aria-label={ariaLabel}
    >
      {EASE_NAMES.map((n) => (
        <option key={n} value={n} className="bg-zinc-900">
          {n}
        </option>
      ))}
    </select>
  );
}

function KindSelect({
  value,
  legal,
  onCommit,
  ariaLabel,
}: {
  value: GraphicsMotionKind;
  legal: readonly GraphicsMotionKind[];
  onCommit: (v: GraphicsMotionKind) => void;
  ariaLabel: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onCommit(e.target.value as GraphicsMotionKind)}
      className="h-7 rounded-md border border-white/10 bg-white/5 px-1 text-[11px] text-white/85"
      aria-label={ariaLabel}
    >
      {legal.map((n) => (
        <option key={n} value={n} className="bg-zinc-900">
          {n}
        </option>
      ))}
    </select>
  );
}

/** B4-2 — motion, tween and camera authoring for the SELECTED element (and
 *  the scene camera). Pure doc patching; the studio's validated PUT is the
 *  only writer that lands. */
export function GraphicsMotionPanel({
  scene,
  selected,
  disabled,
  onPatchElement,
  onPatchScene,
  onInsertElement,
}: {
  scene: GraphicsScene;
  selected: GraphicsElement | undefined;
  disabled: boolean;
  onPatchElement: (elId: string, fn: (el: GraphicsElement) => GraphicsElement) => void;
  onPatchScene: (fn: (s: GraphicsScene) => GraphicsScene) => void;
  onInsertElement: (kind: GraphicsElementKind) => void;
}) {
  const legal = selected ? MOTION_KINDS_BY_ELEMENT[selected.kind] : undefined;

  const motionSlot = (slot: MotionSlot): React.ReactNode => {
    if (!selected) return null;
    const m = selected[slot];
    if (!m && slot === "enter") return null; // enter is required by the grammar — always present
    const legalMotions = MOTION_KINDS_BY_ELEMENT[selected.kind];
    return (
      <div key={slot} className="flex flex-wrap items-center gap-1.5 rounded bg-white/4 px-2 py-1.5">
        <span className="w-28 shrink-0 text-[10px] text-muted-foreground">{MOTION_SLOT_LABELS[slot]}</span>
        {m ? (
          <>
            <KindSelect
              value={m.kind}
              legal={legalMotions}
              ariaLabel={`${slot} motion kind`}
              onCommit={(kind) =>
                onPatchElement(selected.id, (el) => ({ ...el, [slot]: { ...m, kind } }))
              }
            />
            <Num
              value={m.durationMs}
              min={100}
              max={5000}
              step={50}
              ariaLabel={`${slot} duration ms`}
              onCommit={(durationMs) =>
                onPatchElement(selected.id, (el) => ({ ...el, [slot]: { ...m, durationMs } }))
              }
            />
            <Num
              value={m.delayMs}
              min={0}
              max={20000}
              step={50}
              ariaLabel={`${slot} delay ms`}
              onCommit={(delayMs) =>
                onPatchElement(selected.id, (el) => ({ ...el, [slot]: { ...m, delayMs } }))
              }
            />
            <EaseSelect
              value={m.ease}
              ariaLabel={`${slot} ease`}
              onCommit={(ease) =>
                onPatchElement(selected.id, (el) => ({ ...el, [slot]: { ...m, ease: ease ?? "linear" } }))
              }
            />
            {slot !== "enter" && (
              <button
                type="button"
                disabled={disabled}
                className="ml-auto rounded px-1.5 py-0.5 text-[10px] text-red-300 hover:bg-red-500/10 disabled:opacity-40"
                onClick={() =>
                  onPatchElement(selected.id, (el) => {
                    const next = { ...el };
                    delete next[slot];
                    return next;
                  })
                }
              >
                remove
              </button>
            )}
          </>
        ) : (
          <button
            type="button"
            disabled={disabled}
            className="rounded px-2 py-0.5 text-[10px] text-sky-300 hover:bg-sky-500/10 disabled:opacity-40"
            onClick={() =>
              onPatchElement(selected.id, (el) => ({
                ...el,
                [slot]: { kind: legalMotions[0], durationMs: 600, delayMs: 0, ease: "ease-out" },
              }))
            }
          >
            + add {slot}
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="mt-2 space-y-3 border-t border-white/10 pt-2" data-testid="graphics-motion-panel">
      {/* Insertion palette — the closed grammar, legal defaults per kind */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] font-medium text-white/60">Add element</span>
        {(["headline", "subhead", "bullet", "counter", "bar", "shape"] as const).map((k) => (
          <button
            key={k}
            type="button"
            disabled={disabled}
            onClick={() => onInsertElement(k)}
            className="rounded border border-white/10 bg-white/5 px-2 py-1 text-[10px] text-white/80 hover:border-white/25 disabled:opacity-40"
          >
            + {k}
          </button>
        ))}
      </div>

      {selected && legal ? (
        <div className="space-y-2">
          <p className="text-[11px] font-medium text-white/80">Motion · {selected.id}</p>
          {motionSlot("enter")}
          {motionSlot("exit")}
          {motionSlot("emphasis")}

          {/* Tween editor — S129 channels/keys over the scene clock */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium text-white/80">
                Tweens · {selected.tweens?.length ?? 0}
              </span>
              <button
                type="button"
                disabled={disabled}
                className="rounded px-2 py-0.5 text-[10px] text-sky-300 hover:bg-sky-500/10 disabled:opacity-40"
                onClick={() =>
                  onPatchElement(selected.id, (el) => ({
                    ...el,
                    tweens: [
                      ...(el.tweens ?? []),
                      { delayMs: 0, durationMs: 1000, channels: [{ channel: "dx", keys: [{ tMs: 0, value: 0 }, { tMs: 1000, value: 120 }] }] },
                    ],
                  }))
                }
              >
                + add tween
              </button>
            </div>
            {(selected.tweens ?? []).map((tw, ti) => (
              <div key={ti} className="space-y-1 rounded bg-white/4 px-2 py-1.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[10px] text-white/50">window</span>
                  <Num
                    value={tw.delayMs}
                    min={0}
                    ariaLabel={`tween ${ti + 1} delay ms`}
                    onCommit={(delayMs) =>
                      onPatchElement(selected.id, (el) => ({
                        ...el,
                        tweens: (el.tweens ?? []).map((t, j) => (j === ti ? { ...t, delayMs } : t)),
                      }))
                    }
                  />
                  <Num
                    value={tw.durationMs}
                    min={100}
                    ariaLabel={`tween ${ti + 1} duration ms`}
                    onCommit={(durationMs) =>
                      onPatchElement(selected.id, (el) => ({
                        ...el,
                        tweens: (el.tweens ?? []).map((t, j) => (j === ti ? { ...t, durationMs } : t)),
                      }))
                    }
                  />
                  <button
                    type="button"
                    disabled={disabled}
                    className="ml-auto rounded px-1.5 py-0.5 text-[10px] text-red-300 hover:bg-red-500/10 disabled:opacity-40"
                    onClick={() =>
                      onPatchElement(selected.id, (el) => ({
                        ...el,
                        tweens: (el.tweens ?? []).filter((_, j) => j !== ti),
                      }))
                    }
                  >
                    remove tween
                  </button>
                </div>
                {tw.channels.map((ch, ci) => (
                  <div key={ci} className="flex flex-wrap items-center gap-1 rounded bg-white/4 px-1.5 py-1">
                    <select
                      value={ch.channel}
                      onChange={(e) =>
                        onPatchElement(selected.id, (el) => ({
                          ...el,
                          tweens: (el.tweens ?? []).map((t, j) =>
                            j === ti
                              ? {
                                  ...t,
                                  channels: t.channels.map((c, k) =>
                                    k === ci ? { ...c, channel: e.target.value as TweenChannel } : c
                                  ),
                                }
                              : t
                          ),
                        }))
                      }
                      className="h-6 rounded border border-white/10 bg-white/5 px-1 text-[10px] text-white/85"
                      aria-label={`tween ${ti + 1} channel ${ci + 1}`}
                    >
                      {TWEEN_CHANNELS.map((c) => (
                        <option key={c} value={c} className="bg-zinc-900">
                          {c}
                        </option>
                      ))}
                    </select>
                    {ch.keys.map((k, ki) => (
                      <span key={ki} className="inline-flex items-center gap-0.5">
                        <Num
                          value={k.tMs}
                          min={0}
                          step={50}
                          width="w-12"
                          ariaLabel={`key ${ki + 1} tMs`}
                          onCommit={(tMs) =>
                            onPatchElement(selected.id, (el) => ({
                              ...el,
                              tweens: (el.tweens ?? []).map((t, j) =>
                                j === ti
                                  ? {
                                      ...t,
                                      channels: t.channels.map((c, kk) =>
                                        kk === ci
                                          ? { ...c, keys: c.keys.map((key, kj) => (kj === ki ? { ...key, tMs } : key)) }
                                          : c
                                      ),
                                    }
                                  : t
                              ),
                            }))
                          }
                        />
                        <Num
                          value={k.value}
                          step={1}
                          width="w-12"
                          ariaLabel={`key ${ki + 1} value`}
                          onCommit={(value) =>
                            onPatchElement(selected.id, (el) => ({
                              ...el,
                              tweens: (el.tweens ?? []).map((t, j) =>
                                j === ti
                                  ? {
                                      ...t,
                                      channels: t.channels.map((c, kk) =>
                                        kk === ci
                                          ? { ...c, keys: c.keys.map((key, kj) => (kj === ki ? { ...key, value } : key)) }
                                          : c
                                      ),
                                    }
                                  : t
                              ),
                            }))
                          }
                        />
                        <EaseSelect
                          value={k.ease}
                          ariaLabel={`key ${ki + 1} ease`}
                          onCommit={(ease) =>
                            onPatchElement(selected.id, (el) => ({
                              ...el,
                              tweens: (el.tweens ?? []).map((t, j) =>
                                j === ti
                                  ? {
                                      ...t,
                                      channels: t.channels.map((c, kk) =>
                                        kk === ci
                                          ? { ...c, keys: c.keys.map((key, kj) => (kj === ki ? { ...key, ease } : key)) }
                                          : c
                                      ),
                                    }
                                  : t
                              ),
                            }))
                          }
                        />
                      </span>
                    ))}
                    <button
                      type="button"
                      disabled={disabled}
                      className="rounded px-1.5 py-0.5 text-[10px] text-sky-300 hover:bg-sky-500/10 disabled:opacity-40"
                      onClick={() =>
                        onPatchElement(selected.id, (el) => ({
                          ...el,
                          tweens: (el.tweens ?? []).map((t, j) =>
                            j === ti
                              ? {
                                  ...t,
                                  channels: t.channels.map((c, k) =>
                                    k === ci
                                      ? { ...c, keys: [...c.keys, { tMs: (c.keys[c.keys.length - 1]?.tMs ?? 0) + 250, value: 0 }] }
                                      : c
                                  ),
                                }
                              : t
                          ),
                        }))
                      }
                    >
                      + key
                    </button>
                    <button
                      type="button"
                      disabled={disabled}
                      className="rounded px-1.5 py-0.5 text-[10px] text-red-300 hover:bg-red-500/10 disabled:opacity-40"
                      onClick={() =>
                        onPatchElement(selected.id, (el) => ({
                          ...el,
                          tweens: (el.tweens ?? []).map((t, j) =>
                            j === ti ? { ...t, channels: t.channels.filter((_, k) => k !== ci) } : t
                          ),
                        }))
                      }
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  disabled={disabled}
                  className="rounded px-2 py-0.5 text-[10px] text-sky-300 hover:bg-sky-500/10 disabled:opacity-40"
                  onClick={() =>
                    onPatchElement(selected.id, (el) => ({
                      ...el,
                      tweens: (el.tweens ?? []).map((t, j) =>
                        j === ti ? { ...t, channels: [...t.channels, { channel: "opacity", keys: [{ tMs: 0, value: 1 }] }] } : t
                      ),
                    }))
                  }
                >
                  + channel
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-[10px] text-white/40">
          Pick an element above — its motions, eases and tweens live here.
        </p>
      )}

      {/* Scene camera keys — S130, the CAMERA_BOUNDS pins surfaced */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium text-white/80">
            Scene camera · {scene.camera?.length ?? 0} keys
            <span className="ml-1 text-white/40">(zoom {CAMERA_BOUNDS.zoomMin}–{CAMERA_BOUNDS.zoomMax})</span>
          </span>
          <button
            type="button"
            disabled={disabled}
            className="rounded px-2 py-0.5 text-[10px] text-sky-300 hover:bg-sky-500/10 disabled:opacity-40"
            onClick={() =>
              onPatchScene((s) => ({
                ...s,
                camera: [...(s.camera ?? []), { tMs: (s.camera?.[s.camera.length - 1]?.tMs ?? 0) + 800, zoom: 1.2, tx: 0, ty: 0 }],
              }))
            }
          >
            + key
          </button>
        </div>
        {(scene.camera ?? []).map((k, i) => (
          <div key={i} className="flex flex-wrap items-center gap-1 rounded bg-white/4 px-1.5 py-1">
            <Num
              value={k.tMs}
              min={0}
              step={50}
              width="w-12"
              ariaLabel={`camera key ${i + 1} tMs`}
              onCommit={(tMs) =>
                onPatchScene((s) => ({
                  ...s,
                  camera: (s.camera ?? []).map((kk, j) => (j === i ? { ...kk, tMs } : kk)),
                }))
              }
            />
            <Num
              value={k.zoom}
              min={CAMERA_BOUNDS.zoomMin}
              max={CAMERA_BOUNDS.zoomMax}
              step={0.1}
              width="w-12"
              ariaLabel={`camera key ${i + 1} zoom`}
              onCommit={(zoom) =>
                onPatchScene((s) => ({
                  ...s,
                  camera: (s.camera ?? []).map((kk, j) => (j === i ? { ...kk, zoom } : kk)),
                }))
              }
            />
            <Num
              value={k.tx}
              step={10}
              width="w-12"
              ariaLabel={`camera key ${i + 1} tx`}
              onCommit={(tx) =>
                onPatchScene((s) => ({
                  ...s,
                  camera: (s.camera ?? []).map((kk, j) => (j === i ? { ...kk, tx } : kk)),
                }))
              }
            />
            <Num
              value={k.ty}
              step={10}
              width="w-12"
              ariaLabel={`camera key ${i + 1} ty`}
              onCommit={(ty) =>
                onPatchScene((s) => ({
                  ...s,
                  camera: (s.camera ?? []).map((kk, j) => (j === i ? { ...kk, ty } : kk)),
                }))
              }
            />
            <EaseSelect
              value={k.ease}
              ariaLabel={`camera key ${i + 1} ease`}
              onCommit={(ease) =>
                onPatchScene((s) => ({
                  ...s,
                  camera: (s.camera ?? []).map((kk, j) => (j === i ? { ...kk, ease } : kk)),
                }))
              }
            />
            <button
              type="button"
              disabled={disabled}
              className="ml-auto rounded px-1.5 py-0.5 text-[10px] text-red-300 hover:bg-red-500/10 disabled:opacity-40"
              onClick={() =>
                onPatchScene((s) => ({ ...s, camera: (s.camera ?? []).filter((_, j) => j !== i) }))
              }
              aria-label={`Remove camera key ${i + 1}`}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Legal default payloads per insertable kind — everything composes within
 *  the closed grammar (the validator re-checks on save). */
export function defaultElementFor(
  kind: GraphicsElementKind,
  id: string,
  boardW: number,
  boardH: number,
  index: number
): GraphicsElement {
  const at: Placement = {
    x: Math.round(boardW * 0.5),
    y: Math.round(boardH * (0.3 + 0.12 * (index % 4))),
    scale: 1,
    rotateDeg: 0,
  };
  const enter = { kind: "fade" as GraphicsMotionKind, durationMs: 700, delayMs: 200 * index, ease: "ease-out" as GraphicsEase };
  switch (kind) {
    case "headline":
      return { id, kind, at: { ...at, y: Math.round(boardH * 0.3) }, text: { text: "New headline", sizePx: 64, weight: 800 }, enter };
    case "subhead":
      return { id, kind, at: { ...at, y: Math.round(boardH * 0.42) }, text: { text: "New subhead", sizePx: 40, weight: 600 }, enter };
    case "bullet":
      return { id, kind, at: { ...at, x: Math.round(boardW * 0.2), y: Math.round(boardH * 0.5 + 70 * index) }, text: { text: "New bullet", sizePx: 32, weight: 500, align: "left" }, enter };
    case "counter":
      return { id, kind, at, counter: { from: 0, to: 100 }, enter: { ...enter, kind: "count" } };
    case "bar":
      return { id, kind, at, bar: { data: [{ label: "A", value: 42 }, { label: "B", value: 68 }] }, enter: { ...enter, kind: "grow" } };
    case "shape":
    default:
      return { id, kind: "shape", at, shape: { kind: "rect", w: 320, h: 180, fill: "#22D3EE", strokeWidth: 0 }, enter: { ...enter, kind: "wipe" } };
  }
}

/** The insertable palette kinds (payloads that can be composed sensibly
 *  without an external asset or group wiring). */
export const INSERTABLE_KINDS: readonly GraphicsElementKind[] = [
  "headline",
  "subhead",
  "bullet",
  "counter",
  "bar",
  "shape",
] as const satisfies readonly (typeof GRAPHICS_ELEMENT_KINDS)[number][];
