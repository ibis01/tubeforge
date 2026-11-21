"use client";

import { create } from "zustand";

export type ViewId =
  | "dashboard"
  | "assets"
  | "insights"
  | "analytics"
  | "research"
  | "create"
  | "library"
  | "workspace"
  | "cast"
  | "world"
  | "voice"
  | "calendar"
  | "channels"
  | "settings";

interface AppState {
  view: ViewId;
  setView: (v: ViewId) => void;

  /** Monotonic counter — bump to trigger data refresh across views */
  refreshKey: number;
  bumpRefresh: () => void;

  /** Video id used to open the production workspace (B3) — set alongside
   *  setView("workspace") by every entry point (Projects cards, Home continue
   *  row, palette, Create, Topic Radar, Calendar, Analytics, Cast). */
  focusVideoId: string | null;
  setFocusVideoId: (id: string | null) => void;

  /** Topic prefill when jumping from another view into Create */
  prefillTopic: string | null;
  setPrefillTopic: (t: string | null) => void;

  /** Stage 5 (module A) — research sources riding the topic prefill (the
   * radar idea's web grounding follows it into the created video). */
  prefillSources: import("./tubeforge/types").ResearchSource[] | null;
  setPrefillSources: (s: import("./tubeforge/types").ResearchSource[] | null) => void;

  /** Slot date prefill when jumping into Calendar */
  prefillSlotDate: string | null;
  setPrefillSlotDate: (d: string | null) => void;

  /** Video to preselect in the Calendar "new slot" dialog */
  scheduleVideoId: string | null;
  setScheduleVideoId: (id: string | null) => void;

  /** Stage 4a — ⌘K command palette open state (page-level singleton) */
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
}

export const useAppStore = create<AppState>((set) => ({
  view: "dashboard",
  setView: (v) => set({ view: v }),

  refreshKey: 0,
  bumpRefresh: () => set((s) => ({ refreshKey: s.refreshKey + 1 })),

  focusVideoId: null,
  setFocusVideoId: (id) => set({ focusVideoId: id }),

  prefillTopic: null,
  setPrefillTopic: (t) => set({ prefillTopic: t }),

  prefillSources: null,
  setPrefillSources: (s) => set({ prefillSources: s }),

  prefillSlotDate: null,
  setPrefillSlotDate: (d) => set({ prefillSlotDate: d }),

  scheduleVideoId: null,
  setScheduleVideoId: (id) => set({ scheduleVideoId: id }),

  paletteOpen: false,
  setPaletteOpen: (open) => set({ paletteOpen: open }),
}));

// ---------------------------------------------------------------------------
// URL-anchored views — reload keeps you where you were.
//
// The store alone is memory: every reload rebooted the studio on Home no
// matter how deep the operator was — mid-workspace, mid-settings, anywhere.
// The law now: setView/setFocusVideoId stay pure state writes; the page shell
// (src/app/page.tsx) mirrors (view, focusVideoId) into the URL hash via
// replaceState and restores it on boot + hashchange. The hash is the
// persistence medium — no server round-trip, no rewrite rules on any host
// (Vercel / fly / static), it survives the 401 auto-reload, and every surface
// becomes deep-linkable (paste /#/settings and the other side lands there).
// Prefills (topic/sources/slot/schedule) stay ephemeral BY DESIGN: replaying
// a stale jump payload on reload would re-trigger a jump nobody asked for.
// Port of Studio's reload law — provenance: Ibismuh-studio (same session).
export const VIEW_IDS = [
  "dashboard",
  "assets",
  "insights",
  "analytics",
  "research",
  "create",
  "library",
  "workspace",
  "cast",
  "world",
  "voice",
  "calendar",
  "channels",
  "settings",
] as const satisfies readonly ViewId[];

/** The hash for a view state — "" for Home so "/" stays the bare entry URL. */
export function viewToHash(view: ViewId, focusVideoId: string | null): string {
  if (view === "dashboard") return "";
  return view === "workspace" && focusVideoId
    ? `#/workspace/${focusVideoId}`
    : `#/${view}`;
}

/** Apply a URL hash to the store (boot restore + hashchange deep links).
 *  Returns false when the hash carries no valid view — the caller leaves the
 *  app on Home and normalizes the URL instead. */
export function restoreViewFromHash(
  hash: string = typeof window === "undefined" ? "" : window.location.hash
): boolean {
  const m = /^#\/([a-z]+)(?:\/([A-Za-z0-9_-]+))?$/.exec(hash);
  if (!m || !VIEW_IDS.includes(m[1] as ViewId)) return false;
  const s = useAppStore.getState();
  if (m[1] === "workspace" && m[2] && m[2] !== s.focusVideoId)
    s.setFocusVideoId(m[2]);
  if (m[1] !== s.view) s.setView(m[1] as ViewId);
  return true;
}
