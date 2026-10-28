"use client";

import { useEffect, useState } from "react";
import { useAppStore, type ViewId } from "@/lib/store";
import { TubeForgeLogo, TubeForgeWordmark } from "@/components/tubeforge/logo";
import {
  LayoutDashboard,
  TrendingUp,
  Radar,
  Wand2,
  Library,
  Users,
  CalendarDays,
  Radio,
  Settings,
  LogOut,
} from "lucide-react";

export const NAV_ITEMS: {
  id: ViewId;
  label: string;
  icon: typeof LayoutDashboard;
  hint: string;
}[] = [
  {
    id: "dashboard",
    label: "Dashboard",
    icon: LayoutDashboard,
    hint: "Mission control",
  },
  {
    id: "analytics",
    label: "Analytics",
    icon: TrendingUp,
    hint: "YouTube performance",
  },
  {
    id: "research",
    label: "Topic Radar",
    icon: Radar,
    hint: "Keyword research",
  },
  { id: "create", label: "Create", icon: Wand2, hint: "Auto-pilot studio" },
  { id: "library", label: "Library", icon: Library, hint: "Video queue" },
  { id: "cast", label: "Cast", icon: Users, hint: "Recurring characters" },
  {
    id: "calendar",
    label: "Calendar",
    icon: CalendarDays,
    hint: "Publishing schedule",
  },
  { id: "channels", label: "Channels", icon: Radio, hint: "Channel lineup" },
  { id: "settings", label: "Settings", icon: Settings, hint: "Preferences" },
];

export const MOBILE_NAV_ITEMS = NAV_ITEMS;

export function AppSidebar() {
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const [gateOn, setGateOn] = useState(false);

  useEffect(() => {
    const onGate = (e: Event) =>
      setGateOn(Boolean((e as CustomEvent).detail?.enabled));
    window.addEventListener("tf-gate", onGate);
    return () => window.removeEventListener("tf-gate", onGate);
  }, []);

  return (
    <aside className="hidden lg:flex w-60 shrink-0 flex-col border-r border-white/5 bg-sidebar sticky top-0 h-screen">
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-5 h-16 border-b border-white/5">
        <TubeForgeLogo size={36} />
        <TubeForgeWordmark />
      </div>

      {/* Nav */}
      <nav aria-label="Main navigation" className="flex-1 px-3 py-4">
        <ul className="space-y-1.5">
          {NAV_ITEMS.map((item) => {
            const active = view === item.id;
            return (
              <li key={item.id}>
                <button
                  onClick={() => setView(item.id)}
                  aria-current={active ? "page" : undefined}
                  className={`w-full group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-all duration-200 ${
                    active
                      ? "bg-primary/15 text-primary font-medium shadow-[inset_0_0_0_1px_rgb(255_45_45/20%)]"
                      : "text-muted-foreground hover:bg-white/5 hover:text-foreground"
                  }`}
                >
                  <item.icon
                    className={`h-4.5 w-4.5 shrink-0 transition-transform group-hover:scale-105 ${
                      active ? "text-primary" : ""
                    }`}
                  />
                  <span className="flex-1 text-left">{item.label}</span>
                  {active && (
                    <span className="h-1.5 w-1.5 rounded-full bg-primary glow-red-soft" />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Auto-pilot status card + session */}
      <div className="px-3 pb-4 space-y-2">
        <div className="glass rounded-xl p-3.5">
          <div className="flex items-center gap-2">
            <span className="animate-pulse-dot h-2 w-2 rounded-full bg-primary shrink-0" />
            <p className="text-xs font-medium">Auto-Pilot Active</p>
          </div>
          <p className="text-[11px] text-muted-foreground mt-1.5 leading-relaxed">
            Script → Voice → Thumbnail → Ready. Zero manual work.
          </p>
        </div>
        {/* Sign out only makes sense while the lock is active (AuthGate broadcasts it) */}
        {gateOn && (
          <button
            onClick={() => {
              void fetch("/api/auth/logout", { method: "POST" }).then(() =>
                window.location.reload(),
              );
            }}
            className="w-full flex items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-xs text-muted-foreground hover:text-foreground hover:bg-white/5 transition-colors"
            aria-label="Sign out"
          >
            <LogOut className="h-3.5 w-3.5" />
            Sign out
          </button>
        )}
      </div>
    </aside>
  );
}
