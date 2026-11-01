"use client";

import { useEffect, useRef } from "react";

/**
 * Stage 4a (T-4.1) — global keyboard-shortcut plumbing.
 *
 * Usage:
 *   useHotkeys([
 *     { key: "k", mod: true, handler: openPalette },
 *     { key: "?", handler: openHelp },
 *   ]);
 *
 * Rules:
 * - Plain-key hotkeys are suppressed while the user types in an input,
 *   textarea or contenteditable host (so "?" in a script editor is just a
 *   question mark). Escape and modifier combos always fire.
 * - Handler identity is kept in a ref so callers can pass fresh closures
 *   without re-binding the window listener on every render.
 */
export interface Hotkey {
  /** lowercase key for letters/digits, or the event.key name ("?", "Escape", "ArrowDown"…) */
  key: string;
  /** require Cmd (mac) / Ctrl (others) */
  mod?: boolean;
  /** require Shift */
  shift?: boolean;
  handler: (e: KeyboardEvent) => void;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

export function useHotkeys(hotkeys: Hotkey[]) {
  const ref = useRef(hotkeys);

  // Keep the ref fresh after every render (never during render — the React
  // compiler forbids render-phase ref writes).
  useEffect(() => {
    ref.current = hotkeys;
  });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mods = e.metaKey || e.ctrlKey;
      for (const hk of ref.current) {
        const keyMatch =
          hk.key.length === 1
            ? e.key.toLowerCase() === hk.key
            : e.key === hk.key;
        if (!keyMatch) continue;
        if (Boolean(hk.mod) !== mods) continue;
        if (hk.shift !== undefined && Boolean(hk.shift) !== e.shiftKey) continue;

        // Plain keys never fire while typing; Escape and modifier combos do.
        if (!hk.mod && hk.key !== "Escape" && isTypingTarget(e.target)) continue;

        e.preventDefault();
        hk.handler(e);
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
