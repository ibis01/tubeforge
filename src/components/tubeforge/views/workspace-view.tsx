"use client";

// WorkspaceView — the per-project host for the B3 production workspace
// (docs/design/B3_PRODUCTION_WORKSPACE_SPEC.md). The workspace is opened per
// project (Projects cards, Home continue row, palette, Create, Topic Radar,
// Calendar, Analytics, Cast) — it is never browsed, so an absent focus id
// renders a pointed empty state rather than a list.

import { useEffect, useState } from "react";
import { useAppStore } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/tubeforge/shared";
import { ProductionWorkspace } from "@/components/tubeforge/production-workspace";
import { Library as LibraryIcon, Wand2 } from "lucide-react";
import type { VideoDTO } from "@/lib/tubeforge/types";

export function WorkspaceView() {
  const focusVideoId = useAppStore((s) => s.focusVideoId);
  const setFocusVideoId = useAppStore((s) => s.setFocusVideoId);
  const refreshKey = useAppStore((s) => s.refreshKey);
  const setView = useAppStore((s) => s.setView);
  const bumpRefresh = useAppStore((s) => s.bumpRefresh);

  const [video, setVideo] = useState<VideoDTO | null>(null);

  // The store's focus id decides which project the workspace hosts. It is
  // consumed on load — the fetched DTO becomes local state, so refreshes of
  // the SAME project don't re-trigger the focus pipeline. Loading derives
  // from the unconsumed id (a pending focus id IS the loading state) — no
  // setState dances inside the effect body.
  useEffect(() => {
    if (!focusVideoId) return;
    let cancelled = false;
    fetch(`/api/videos/${focusVideoId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled) setVideo(d?.video ?? null);
      })
      .catch(() => {
        if (!cancelled) setVideo(null);
      })
      .finally(() => {
        if (!cancelled) setFocusVideoId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [focusVideoId, setFocusVideoId]);

  const loading = Boolean(focusVideoId);

  // Keep the standing DTO truthful: when any engine bumps the global refresh
  // (a render finishing elsewhere, a publish, a QC run), re-pull the project.
  useEffect(() => {
    if (!video?.id || refreshKey === 0) return;
    let cancelled = false;
    fetch(`/api/videos/${video.id}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d?.video) setVideo(d.video);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [refreshKey, video?.id]);

  if (loading) {
    return (
      <div className="space-y-5" aria-busy="true" aria-label="Loading workspace">
        <div className="flex items-center gap-3">
          <Skeleton className="h-9 w-24 rounded-lg bg-white/5" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-5 w-2/3 bg-white/5" />
            <Skeleton className="h-3.5 w-1/3 bg-white/5" />
          </div>
        </div>
        <Skeleton className="h-24 rounded-2xl bg-white/5" />
        <Skeleton className="h-10 w-full max-w-md rounded-lg bg-white/5" />
        <Skeleton className="h-64 rounded-2xl bg-white/5" />
      </div>
    );
  }

  if (!video) {
    return (
      <EmptyState
        icon={LibraryIcon}
        title="No project open"
        hint="The workspace hosts one project at a time — open one from Projects, or start something new."
        action={
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button
              onClick={() => setView("library")}
              variant="outline"
              className="border-white/15 bg-white/4"
            >
              <LibraryIcon className="h-4 w-4" />
              Browse projects
            </Button>
            <Button
              onClick={() => setView("create")}
              className="bg-brand-gradient hover:opacity-90 font-medium"
            >
              <Wand2 className="h-4 w-4" />
              New project
            </Button>
          </div>
        }
      />
    );
  }

  return (
    <ProductionWorkspace
      video={video}
      onClose={() => setView("library")}
      onChanged={(v) => {
        setVideo(v);
        bumpRefresh();
      }}
      onDeleted={() => {
        setVideo(null);
        bumpRefresh();
        setView("library");
      }}
    />
  );
}
