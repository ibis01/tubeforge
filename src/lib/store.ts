"use client";

import { create } from "zustand";

export type ViewId =
  | "dashboard"
  | "research"
  | "create"
  | "library"
  | "cast"
  | "calendar"
  | "channels"
  | "settings";

interface AppState {
  view: ViewId;
  setView: (v: ViewId) => void;

  /** Monotonic counter — bump to trigger data refresh across views */
  refreshKey: number;
  bumpRefresh: () => void;

  /** Video id used to preselect in library / open detail */
  focusVideoId: string | null;
  setFocusVideoId: (id: string | null) => void;

  /** Topic prefill when jumping from another view into Create */
  prefillTopic: string | null;
  setPrefillTopic: (t: string | null) => void;

  /** Slot date prefill when jumping into Calendar */
  prefillSlotDate: string | null;
  setPrefillSlotDate: (d: string | null) => void;

  /** Video to preselect in the Calendar "new slot" dialog */
  scheduleVideoId: string | null;
  setScheduleVideoId: (id: string | null) => void;
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

  prefillSlotDate: null,
  setPrefillSlotDate: (d) => set({ prefillSlotDate: d }),

  scheduleVideoId: null,
  setScheduleVideoId: (id) => set({ scheduleVideoId: id }),
}));
