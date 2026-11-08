"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAppStore, type ViewId } from "@/lib/store";
import { NAV_ITEMS } from "@/components/tubeforge/app-sidebar";
import { Kbd, StatusBadge } from "@/components/tubeforge/shared";
import { useHotkeys } from "@/lib/tubeforge/hotkeys";
import type { VideoDTO, VideoStatus } from "@/lib/tubeforge/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Plus, Radar, Search } from "lucide-react";

/**
 * Stage 4a (T-4.1) — ⌘K command palette + "?" shortcut sheet.
 *
 * The palette is the app's keyboard spine: jump to any of the 9 views, start
 * a new production, open a research scan, or open any recent video — without
 * touching the mouse. Mounted once at the page root; state lives in the store
 * so any component can open it programmatically.
 */

interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  status?: VideoStatus;
  group: "Actions" | "Views" | "Recent videos";
  keywords: string;
  run: () => void;
}

export function CommandPalette() {
  const paletteOpen = useAppStore((s) => s.paletteOpen);
  const setPaletteOpen = useAppStore((s) => s.setPaletteOpen);
  const setView = useAppStore((s) => s.setView);
  const setFocusVideoId = useAppStore((s) => s.setFocusVideoId);

  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<VideoDTO[]>([]);
  const [helpOpen, setHelpOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Reset the transient palette state when it opens — React's documented
  // "adjust state when a prop changes" form (setState during render, guarded
  // by a seed compare): same trigger as the old effect, one fewer paint.
  const [wasOpen, setWasOpen] = useState(paletteOpen);
  if (wasOpen !== paletteOpen) {
    setWasOpen(paletteOpen);
    if (paletteOpen) {
      setQuery("");
      setActive(0);
    }
  }

  // Recent videos load when the palette opens (cheap, capped, cache-busts).
  useEffect(() => {
    if (!paletteOpen) return;
    fetch("/api/videos?limit=8")
      .then((r) => r.json())
      .then((d) => setRecent(d.videos ?? []))
      .catch(() => setRecent([]));
    // Focus lands on the input after the dialog mounts.
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [paletteOpen]);

  const items = useMemo<PaletteItem[]>(() => {
    const actions: PaletteItem[] = [
      {
        id: "action-new-video",
        label: "New video",
        hint: "Guided brief → Auto-Pilot",
        group: "Actions",
        keywords: "create new video production start",
        run: () => setView("create"),
      },
      {
        id: "action-research",
        label: "Run a research scan",
        hint: "Topic Radar",
        group: "Actions",
        keywords: "research scan topic radar ideas keywords",
        run: () => setView("research"),
      },
    ];
    const views: PaletteItem[] = NAV_ITEMS.map((n) => ({
      id: `view-${n.id}`,
      label: n.label,
      hint: n.hint,
      group: "Views",
      keywords: `${n.label} ${n.hint} view page`.toLowerCase(),
      run: () => setView(n.id as ViewId),
    }));
    const videos: PaletteItem[] = recent.map((v) => ({
      id: `video-${v.id}`,
      label: v.title || v.topic,
      hint: v.status,
      status: v.status,
      group: "Recent videos",
      keywords: `${v.title} ${v.topic} ${v.niche} ${v.status}`.toLowerCase(),
      run: () => {
        setFocusVideoId(v.id);
        setView("library");
      },
    }));
    return [...actions, ...views, ...videos];
  }, [recent, setView, setFocusVideoId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => it.keywords.includes(q) || it.label.toLowerCase().includes(q));
  }, [items, query]);

  // Reset the cursor whenever the result set changes shape — same guarded
  // render-time adjust as the open reset above.
  const [seedQuery, setSeedQuery] = useState(query);
  if (seedQuery !== query) {
    setSeedQuery(query);
    setActive(0);
  }

  // Keep the highlighted row in view during arrow navigation.
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-palette-idx="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const runItem = (it: PaletteItem | undefined) => {
    if (!it) return;
    setPaletteOpen(false);
    // Let the close animation start before the view flips — feels snappier.
    setTimeout(it.run, 10);
  };

  const onInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      runItem(filtered[active]);
    }
  };

  // Global bindings: ⌘K toggles the palette, "?" opens the help sheet.
  useHotkeys([
    {
      key: "k",
      mod: true,
      handler: () => setPaletteOpen(!useAppStore.getState().paletteOpen),
    },
    {
      key: "?",
      handler: () => setHelpOpen((v) => !v),
    },
  ]);

  let lastGroup = "";

  return (
    <>
      <Dialog open={paletteOpen} onOpenChange={setPaletteOpen}>
        <DialogContent
          className="max-w-lg top-[12vh] translate-y-0 p-0 gap-0 overflow-hidden border-white/10 bg-[rgb(22_22_27/96%)] backdrop-blur-xl"
          onKeyDown={(e) => {
            if (e.key === "Escape") setPaletteOpen(false);
          }}
        >
          <DialogHeader className="sr-only">
            <DialogTitle>Command palette</DialogTitle>
            <DialogDescription>Jump to a view, action or recent video</DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-2.5 px-4 h-14 border-b border-white/8">
            <Search className="h-4 w-4 text-white/40 shrink-0" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onInputKeyDown}
              placeholder="Search views, actions, videos…"
              aria-label="Command palette search"
              className="flex-1 bg-transparent outline-none text-sm placeholder:text-white/35"
            />
            <Kbd>Esc</Kbd>
          </div>

          <div ref={listRef} className="max-h-[46vh] overflow-y-auto scroll-area-bar py-2">
            {filtered.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-white/45">
                Nothing matches “{query}”.
              </p>
            ) : (
              filtered.map((it, i) => {
                const showGroup = it.group !== lastGroup;
                lastGroup = it.group;
                return (
                  <div key={it.id}>
                    {showGroup && <p className="tf-kicker px-4 pt-3 pb-1.5">{it.group}</p>}
                    <button
                      data-palette-idx={i}
                      onMouseMove={() => setActive(i)}
                      onClick={() => runItem(it)}
                      className={`tf-focusable w-full flex items-center gap-3 mx-1 px-3 py-2.5 rounded-lg text-left text-sm transition-colors ${
                        i === active ? "bg-primary/15 text-white" : "text-white/75 hover:bg-white/5"
                      }`}
                      style={{ width: "calc(100% - 0.5rem)" }}
                    >
                      <span className="flex-1 min-w-0">
                        <span className="block truncate">{it.label}</span>
                        {it.hint && (
                          <span className="block text-xs text-white/40 truncate">
                            {it.group === "Recent videos" ? "" : it.hint}
                          </span>
                        )}
                      </span>
                      {it.group === "Recent videos" && it.status ? (
                        <StatusBadge status={it.status} />
                      ) : null}
                      {i === active && <Kbd>↵</Kbd>}
                    </button>
                  </div>
                );
              })
            )}
          </div>

          <div className="flex items-center justify-between px-4 h-10 border-t border-white/8 text-[11px] text-white/40">
            <span className="flex items-center gap-1.5">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> navigate <Kbd>↵</Kbd> open
            </span>
            <button
              onClick={() => {
                setPaletteOpen(false);
                setHelpOpen(true);
              }}
              className="tf-focusable hover:text-white/70 transition-colors"
            >
              All shortcuts <Kbd>?</Kbd>
            </button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
        <DialogContent className="max-w-md top-[14vh] translate-y-0">
          <DialogHeader>
            <DialogTitle className="text-base">Keyboard shortcuts</DialogTitle>
            <DialogDescription className="text-xs">
              TubeForge works fully from the keyboard.
            </DialogDescription>
          </DialogHeader>
          <ul className="space-y-2 text-sm">
            {[
              [["⌘", "K"], "Command palette — views, actions, recent videos"],
              [["?"], "This shortcut sheet"],
              [["Esc"], "Close dialogs and panels"],
              [["↵"], "Open the highlighted palette item"],
              [["↑", "↓"], "Move within lists and pickers"],
            ].map(([keys, desc]) => (
              <li key={String(desc)} className="flex items-center justify-between gap-4">
                <span className="text-white/75">{desc}</span>
                <span className="flex items-center gap-1 shrink-0">
                  {(keys as string[]).map((k) => (
                    <Kbd key={k}>{k}</Kbd>
                  ))}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-white/40 flex items-center gap-1.5">
            <Plus className="h-3 w-3" /> Tip: the palette also opens videos — type a title.
            <Radar className="h-3 w-3" />
          </p>
        </DialogContent>
      </Dialog>
    </>
  );
}
