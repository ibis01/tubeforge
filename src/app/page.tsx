"use client";

import { useEffect, useState } from "react";
import { useAppStore, type ViewId } from "@/lib/store";
import {
  AppSidebar,
  MOBILE_NAV_ITEMS,
  NAV_ITEMS,
} from "@/components/tubeforge/app-sidebar";
import { AuthGate } from "@/components/tubeforge/auth-gate";
import { DashboardView } from "@/components/tubeforge/views/dashboard-view";
import { AnalyticsView } from "@/components/tubeforge/views/analytics-view";
import { ResearchView } from "@/components/tubeforge/views/research-view";
import { CreateView } from "@/components/tubeforge/views/create-view";
import { LibraryView } from "@/components/tubeforge/views/library-view";
import { CastView } from "@/components/tubeforge/views/cast-view";
import { WorldView } from "@/components/tubeforge/views/world-view";
import { VoiceView } from "@/components/tubeforge/views/voice-view";
import { CalendarView } from "@/components/tubeforge/views/calendar-view";
import { ChannelsView } from "@/components/tubeforge/views/channels-view";
import { SettingsView } from "@/components/tubeforge/views/settings-view";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTrigger,
  SheetTitle,
} from "@/components/ui/sheet";
import { Menu, Plus, Search } from "lucide-react";
import { TubeForgeLogo, TubeForgeWordmark } from "@/components/tubeforge/logo";
import { CommandPalette } from "@/components/tubeforge/command-palette";

const VIEW_META: Record<ViewId, { title: string; subtitle: string }> = {
  dashboard: {
    title: "Mission Control",
    subtitle: "Your faceless-channel factory at a glance",
  },
  analytics: {
    title: "Analytics",
    subtitle: "Real YouTube performance feeding the Topic Radar",
  },
  research: {
    title: "Topic Radar",
    subtitle: "AI keyword research — find what to make next",
  },
  create: {
    title: "Auto-Pilot Studio",
    subtitle: "Topic in — finished video package out",
  },
  library: {
    title: "Video Library",
    subtitle: "Every asset the pipeline has produced",
  },
  cast: {
    title: "Cast",
    subtitle: "Recurring characters with locked-in visual identity",
  },
  world: {
    title: "World",
    subtitle: "Recurring places & things for set continuity",
  },
  voice: {
    title: "Voice Studio",
    subtitle: "Narration voices, clones and the default narrator",
  },
  calendar: {
    title: "Publishing Calendar",
    subtitle: "Plan, schedule and ship uploads without gaps",
  },
  channels: {
    title: "Channels",
    subtitle: "Manage your faceless channel lineup",
  },
  settings: {
    title: "Settings",
    subtitle: "Automation defaults & preferences",
  },
};

export default function Home() {
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const meta = VIEW_META[view];

  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [view]);

  // Global 401 watcher: when a session expires mid-use, every API call starts
  // answering 401 — reload once so the AuthGate takes over and shows the lock.
  useEffect(() => {
    const orig = window.fetch.bind(window);
    window.fetch = (async (...args: Parameters<typeof fetch>) => {
      const res = await orig(...args);
      if (res.status === 401 && !res.url.includes("/api/auth/"))
        window.location.reload();
      return res;
    }) as typeof fetch;
    return () => {
      window.fetch = orig;
    };
  }, []);

  const handleNav = (v: ViewId) => {
    setView(v);
    setMobileNavOpen(false);
  };

  const setPaletteOpen = useAppStore((s) => s.setPaletteOpen);

  return (
    <AuthGate>
      <CommandPalette />
      <div className="min-h-screen flex bg-background">
        {/* Desktop sidebar */}
        <AppSidebar />

        {/* Main column */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Top bar */}
          <header className="sticky top-0 z-30 glass-strong border-b border-white/5">
            <div className="flex items-center gap-3 px-4 sm:px-6 h-16">
              {/* Mobile nav trigger */}
              <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
                <SheetTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="lg:hidden text-foreground hover:bg-white/10"
                    aria-label="Open navigation menu"
                  >
                    <Menu className="h-5 w-5" />
                  </Button>
                </SheetTrigger>
                <SheetContent
                  side="left"
                  className="w-64 p-0 bg-sidebar border-white/10"
                >
                  <SheetTitle className="sr-only">Navigation</SheetTitle>
                  <MobileNavContent onNavigate={handleNav} view={view} />
                </SheetContent>
              </Sheet>

              <div className="min-w-0 flex-1">
                <h1 className="text-base sm:text-lg font-semibold tracking-tight truncate">
                  {meta.title}
                </h1>
                <p className="text-xs text-muted-foreground truncate hidden sm:block">
                  {meta.subtitle}
                </p>
              </div>

              {/* ⌘K palette trigger (T-4.1) — also bound globally */}
              <button
                onClick={() => setPaletteOpen(true)}
                aria-label="Open command palette (Command K)"
                className="tf-focusable hidden md:flex items-center gap-2 h-9 px-3 rounded-lg border border-white/10 bg-white/3 hover:bg-white/6 text-xs text-white/45 hover:text-white/70 transition-colors"
              >
                <Search className="h-3.5 w-3.5" />
                <span>Search…</span>
                <kbd className="tf-kbd ml-1">⌘K</kbd>
              </button>

              {view !== "create" && view !== "settings" ? (
                <Button
                  onClick={() => setView("create")}
                  className="bg-brand-gradient hover:opacity-90 text-white font-semibold shadow-lg shrink-0"
                  size="sm"
                >
                  <Plus className="h-4 w-4" />
                  <span className="hidden sm:inline">New Video</span>
                  <span className="sm:hidden">New</span>
                </Button>
              ) : null}
            </div>
          </header>

          {/* View content */}
          <main className="flex-1 px-4 sm:px-6 py-6 w-full max-w-[1400px] mx-auto">
            {view === "dashboard" && <DashboardView />}
            {view === "analytics" && <AnalyticsView />}
            {view === "research" && <ResearchView />}
            {view === "create" && <CreateView />}
            {view === "library" && <LibraryView />}
            {view === "cast" && <CastView />}
            {view === "world" && <WorldView />}
            {view === "voice" && <VoiceView />}
            {view === "calendar" && <CalendarView />}
            {view === "channels" && <ChannelsView />}
            {view === "settings" && <SettingsView />}
          </main>

          {/* Sticky footer */}
          <footer className="mt-auto border-t border-white/5 px-4 sm:px-6 py-4">
            <div className="max-w-[1400px] mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-muted-foreground">
              <p>
                <span className="text-gradient font-semibold">TubeForge</span> ·
                Automated faceless YouTube content engine
              </p>
              <p>Script · Voice · Thumbnail · Render</p>
            </div>
          </footer>
        </div>
      </div>
    </AuthGate>
  );
}

function MobileNavContent({
  onNavigate,
  view,
}: {
  onNavigate: (v: ViewId) => void;
  view: ViewId;
}) {
  return (
    <nav aria-label="Main navigation" className="p-3">
      <div className="flex items-center gap-2.5 px-3 py-4">
        <TubeForgeLogo size={38} />
        <TubeForgeWordmark />
      </div>
      <ul className="space-y-1">
        {MOBILE_NAV_ITEMS.map((item) => (
          <li key={item.id}>
            <button
              onClick={() => onNavigate(item.id)}
              className={`w-full flex items-center gap-3 rounded-lg px-3 py-3 text-sm transition-colors min-h-[44px] ${
                view === item.id
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:bg-white/5 hover:text-foreground"
              }`}
            >
              <item.icon className="h-5 w-5 shrink-0" />
              {item.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

// Re-export for tree-shaking friendliness
export { NAV_ITEMS };
