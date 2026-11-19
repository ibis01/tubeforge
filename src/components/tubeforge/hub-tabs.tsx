"use client";

import type { ReactNode } from "react";
import { useAppStore, type ViewId } from "@/lib/store";
import { cn } from "@/lib/utils";

/**
 * B1 destination hub (docs/design/B1_DESIGN_SPECIFICATION.md §3): the
 * specialist modules stay exactly as built — the hub adds the tab context so
 * the sidebar only needs four destinations. Tab ids are ViewIds; switching a
 * tab navigates the store, so deep jumps (`setView("voice")` from the clone
 * deep-link) land on the same surface with the right tab lit.
 */
export function HubTabs({
  active,
  tabs,
  panels,
}: {
  active: ViewId;
  tabs: { id: ViewId; label: string }[];
  panels: Partial<Record<ViewId, ReactNode>>;
}) {
  const setView = useAppStore((s) => s.setView);

  // Landing on the destination root ("assets" / "insights") resolves to the
  // first tab's panel, so a destination is never a bare tab strip.
  const isRoot = !tabs.some((t) => t.id === active);
  const effective = isRoot ? tabs[0].id : active;

  return (
    <div className="space-y-5">
      <div
        role="tablist"
        aria-label="Workspace sections"
        className="flex items-center gap-1.5 overflow-x-auto scroll-area-bar -mx-1 px-1 pb-1"
      >
        {tabs.map((tab) => {
          const isActive = effective === tab.id;
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              onClick={() => setView(tab.id)}
              className={cn(
                "tf-focusable shrink-0 rounded-full px-4 py-2 text-sm transition-colors min-h-[36px] border",
                isActive
                  ? "bg-primary/15 text-primary border-primary/30 font-medium"
                  : "text-muted-foreground border-white/10 bg-white/3 hover:bg-white/6 hover:text-foreground",
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      <div role="tabpanel">{panels[effective] ?? null}</div>
    </div>
  );
}
