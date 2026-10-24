"use client";

import { useEffect, useState } from "react";
import { useAppStore, type ViewId } from "@/lib/store";
import { AppSidebar, MOBILE_NAV_ITEMS, NAV_ITEMS } from "@/components/tubeforge/app-sidebar";
import { DashboardView } from "@/components/tubeforge/views/dashboard-view";
import { ResearchView } from "@/components/tubeforge/views/research-view";
import { CreateView } from "@/components/tubeforge/views/create-view";
import { LibraryView } from "@/components/tubeforge/views/library-view";
import { CalendarView } from "@/components/tubeforge/views/calendar-view";
import { ChannelsView } from "@/components/tubeforge/views/channels-view";
import { SettingsView } from "@/components/tubeforge/views/settings-view";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from "@/components/ui/sheet";
import { Menu, Plus } from "lucide-react";

const VIEW_META: Record<ViewId, { title: string; subtitle: string }> = {
  dashboard: {
    title: "Mission Control",
    subtitle: "Your faceless-channel factory at a glance",
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

  const handleNav = (v: ViewId) => {
    setView(v);
    setMobileNavOpen(false);
  };

  return (
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
          {view === "research" && <ResearchView />}
          {view === "create" && <CreateView />}
          {view === "library" && <LibraryView />}
          {view === "calendar" && <CalendarView />}
          {view === "channels" && <ChannelsView />}
          {view === "settings" && <SettingsView />}
        </main>

        {/* Sticky footer */}
        <footer className="mt-auto border-t border-white/5 px-4 sm:px-6 py-4">
          <div className="max-w-[1400px] mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-muted-foreground">
            <p>
              <span className="text-gradient font-semibold">TubeForge</span> · Automated
              faceless YouTube content engine
            </p>
            <p>GLM scripting · TTS voiceover · CogView thumbnails</p>
          </div>
        </footer>
      </div>
    </div>
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
        <div className="h-9 w-9 rounded-xl bg-brand-gradient flex items-center justify-center shadow-lg shrink-0">
          <svg viewBox="0 0 24 24" className="h-4.5 w-4.5 fill-white" aria-hidden="true">
            <path d="M8 5.5v13l11-6.5-11-6.5z" />
          </svg>
        </div>
        <div>
          <p className="font-semibold leading-tight">TubeForge</p>
          <p className="text-[11px] text-muted-foreground">Auto-Pilot Engine</p>
        </div>
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
