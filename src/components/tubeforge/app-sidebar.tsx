"use client";

import { useEffect, useState } from "react";
import { useAppStore, type ViewId } from "@/lib/store";
import { TubeForgeLogo, TubeForgeWordmark } from "@/components/tubeforge/logo";
import {
  House,
  Clapperboard,
  Boxes,
  TrendingUp,
  Settings,
  LogOut,
} from "lucide-react";

/**
 * B1 navigation architecture (docs/design/B1_DESIGN_SPECIFICATION.md §3):
 * exactly four destinations + Settings at the top level. The specialist
 * modules are NOT removed — Cast/World/Voice Studio live inside Assets and
 * Analytics/Topic Radar/Calendar/Channels live inside Insights as hub tabs.
 *
 * Nav ids are ViewIds, so the ⌘K palette and every programmatic
 * `setView(...)` keep working unchanged.
 */
export const NAV_ITEMS: {
  id: ViewId;
  label: string;
  icon: typeof House;
  hint: string;
}[] = [
  {
    id: "dashboard",
    label: "Home",
    icon: House,
    hint: "Recent projects & activity",
  },
  {
    id: "library",
    label: "Projects",
    icon: Clapperboard,
    hint: "Create & continue videos",
  },
  {
    id: "assets",
    label: "Assets",
    icon: Boxes,
    hint: "Cast, world & voice studio",
  },
  {
    id: "insights",
    label: "Insights",
    icon: TrendingUp,
    hint: "Analytics, research & publishing",
  },
  { id: "settings", label: "Settings", icon: Settings, hint: "Preferences" },
];

export const MOBILE_NAV_ITEMS = NAV_ITEMS;

/** Which destination owns the currently active view (drives sidebar state). */
export function activeNavId(view: ViewId): ViewId {
  switch (view) {
    case "cast":
    case "world":
    case "voice":
      return "assets";
    case "analytics":
    case "research":
    case "calendar":
    case "channels":
      return "insights";
    case "create":
    case "workspace":
      return "library";
    default:
      return view;
  }
}

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

  const active = activeNavId(view);

  return (
    <aside className="hidden lg:flex w-60 shrink-0 flex-col border-r border-white/5 bg-sidebar sticky top-0 h-screen">
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-5 h-16 border-b border-white/5">
        <TubeForgeLogo size={38} />
        <TubeForgeWordmark />
      </div>

      {/* Destinations */}
      <nav aria-label="Main navigation" className="flex-1 px-3 py-4">
        <ul className="space-y-1.5">
          {NAV_ITEMS.map((item) => {
            const isActive = active === item.id;
            return (
              <li key={item.id}>
                <button
                  onClick={() => setView(item.id)}
                  aria-current={isActive ? "page" : undefined}
                  className={`w-full group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-all duration-200 ${
                    isActive
                      ? "bg-primary/15 text-primary font-medium shadow-[inset_0_0_0_1px_rgb(34_211_238/20%)]"
                      : "text-muted-foreground hover:bg-white/5 hover:text-foreground"
                  }`}
                >
                  <item.icon
                    className={`h-4.5 w-4.5 shrink-0 transition-transform group-hover:scale-105 ${
                      isActive ? "text-primary" : ""
                    }`}
                  />
                  <span className="flex-1 text-left">{item.label}</span>
                  {isActive && (
                    <span className="h-1.5 w-1.5 rounded-full bg-primary glow-brand-soft" />
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Studio status card + session */}
      <div className="px-3 pb-4 space-y-2">
        <div className="glass rounded-xl p-3.5">
          <div className="flex items-center gap-2">
            <span className="animate-pulse-dot h-2 w-2 rounded-full bg-primary shrink-0" />
            <p className="text-xs font-medium">You direct · AI assists</p>
          </div>
          <p className="text-[11px] text-muted-foreground mt-1.5 leading-relaxed">
            Idea → Script → Scenes → Ship. You approve every step.
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
