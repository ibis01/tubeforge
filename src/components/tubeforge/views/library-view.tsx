"use client";

import { useCallback, useEffect, useState } from "react";
import { useAppStore } from "@/lib/store";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { StatusBadge, EmptyState, formatDuration, timeAgo } from "@/components/tubeforge/shared";
import { VideoDetailDialog } from "@/components/tubeforge/video-detail-dialog";
import type { VideoDTO } from "@/lib/tubeforge/types";
import {
  Film,
  Wand2,
  AudioLines,
  Trash2,
  Clapperboard,
  Library as LibraryIcon,
} from "lucide-react";

const FILTERS = [
  { id: "all", label: "All" },
  { id: "draft", label: "Drafts" },
  { id: "scripted", label: "Scripted" },
  { id: "voiced", label: "Voiced" },
  { id: "ready", label: "Ready" },
  { id: "published", label: "Published" },
  { id: "failed", label: "Failed" },
];

export function LibraryView() {
  const refreshKey = useAppStore((s) => s.refreshKey);
  const focusVideoId = useAppStore((s) => s.focusVideoId);
  const setFocusVideoId = useAppStore((s) => s.setFocusVideoId);
  const setView = useAppStore((s) => s.setView);
  const setPrefillTopic = useAppStore((s) => s.setPrefillTopic);

  const [videos, setVideos] = useState<VideoDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState<VideoDTO | null>(null);

  const load = useCallback(() => {
    return fetch(`/api/videos?status=${filter}`)
      .then((r) => r.json())
      .then((d) => {
        setVideos(d.videos ?? []);
        setLoading(false);
      })
      .catch(() => {
        setVideos([]);
        setLoading(false);
      });
  }, [filter]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  // Open a video when focused from another view
  useEffect(() => {
    if (!focusVideoId) return;
    fetch(`/api/videos/${focusVideoId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.video) setSelected(d.video);
      })
      .catch(() => undefined)
      .finally(() => setFocusVideoId(null));
  }, [focusVideoId, setFocusVideoId]);

  const quickDelete = async (id: string) => {
    const res = await fetch(`/api/videos/${id}`, { method: "DELETE" });
    if (res.ok) {
      setVideos((vs) => vs.filter((v) => v.id !== id));
      useAppStore.getState().bumpRefresh();
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <Tabs value={filter} onValueChange={setFilter} className="w-full sm:w-auto">
          <TabsList className="bg-white/4 border border-white/8 h-10 w-full sm:w-auto overflow-x-auto scroll-area-bar">
            {FILTERS.map((f) => (
              <TabsTrigger
                key={f.id}
                value={f.id}
                className="data-[state=active]:bg-primary/20 data-[state=active]:text-red-200 px-3 text-xs sm:text-13px h-8"
              >
                {f.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <p className="text-xs text-muted-foreground shrink-0">
          {videos.length} video{videos.length === 1 ? "" : "s"}
        </p>
      </div>

      {loading ? (
        <div className="grid md:grid-cols-2 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-40 rounded-2xl bg-white/5" />
          ))}
        </div>
      ) : videos.length === 0 ? (
        <EmptyState
          icon={LibraryIcon}
          title={filter === "all" ? "Library is empty" : "No videos in this stage"}
          hint={
            filter === "all"
              ? "Fire up Auto-Pilot to produce your first complete video package."
              : "Try another filter, or produce new videos with Auto-Pilot."
          }
          action={
            <Button
              onClick={() => setView("create")}
              className="bg-brand-gradient hover:opacity-90 font-medium"
            >
              <Wand2 className="h-4 w-4" />
              Generate a Video
            </Button>
          }
        />
      ) : (
        <div className="grid md:grid-cols-2 gap-4">
          {videos.map((v) => (
            <Card
              key={v.id}
              className="glass rounded-2xl overflow-hidden group hover:border-primary/25 transition-all duration-300"
            >
              <div className="flex flex-col">
                {/* Thumb strip */}
                <button
                  onClick={() => setSelected(v)}
                  className="relative w-full aspect-[2.4/1] bg-white/4 overflow-hidden text-left"
                  aria-label={`Open details for ${v.title ?? v.topic}`}
                >
                  {v.hasThumbnail ? (
                    <img
                      src={`/api/videos/${v.id}/thumbnail`}
                      alt={`Thumbnail for ${v.title ?? v.topic}`}
                      className="absolute inset-0 h-full w-full object-cover"
                    />
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <Film className="h-8 w-8 text-white/15" />
                    </div>
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent" />
                  <div className="absolute bottom-2.5 left-3 right-3 flex items-center gap-2 flex-wrap">
                    <StatusBadge status={v.status} />
                    {v.hasVideo && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/80 backdrop-blur px-2 py-0.5 text-[11px] text-white font-medium">
                        <Clapperboard className="h-3 w-3" />
                        MP4
                      </span>
                    )}
                    {v.hasVoiceover && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-black/60 backdrop-blur px-2 py-0.5 text-[11px] text-white/85">
                        <AudioLines className="h-3 w-3" />
                        {formatDuration(v.audioDuration)}
                      </span>
                    )}
                  </div>
                </button>

                {/* Meta */}
                <div className="p-4">
                  <div className="flex items-start justify-between gap-2">
                    <button onClick={() => setSelected(v)} className="min-w-0 text-left flex-1">
                      <p className="font-medium leading-snug line-clamp-2 group-hover:text-red-200 transition-colors">
                        {v.title ?? v.topic}
                      </p>
                      <p className="text-[11px] text-muted-foreground mt-1 truncate">
                        {v.niche} · {v.wordCount ?? 0}w · {timeAgo(v.createdAt)}
                        {v.channelName ? ` · ${v.channelName}` : ""}
                      </p>
                    </button>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-foreground hover:bg-white/8"
                        onClick={() =>
                          setPrefillTopic(v.topic)
                        }
                        aria-label="Reuse this topic"
                      >
                        <Wand2 className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground hover:text-red-300 hover:bg-red-500/10"
                        onClick={() => quickDelete(v.id)}
                        aria-label="Delete video"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <VideoDetailDialog
        video={selected}
        onClose={() => setSelected(null)}
        onChanged={(v) => {
          setSelected(v);
          load();
        }}
        onDeleted={() => {
          setSelected(null);
          load();
        }}
      />
    </div>
  );
}
