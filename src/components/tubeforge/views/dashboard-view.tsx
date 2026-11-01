"use client";

import { useEffect, useState } from "react";
import { useAppStore } from "@/lib/store";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  StatCard,
  EmptyState,
  StatusBadge,
  timeAgo,
  formatDuration,
  compactNumber,
  Sparkline,
  TrendDelta,
} from "@/components/tubeforge/shared";
import { AttentionPanel } from "@/components/tubeforge/attention-panel";
import type { StatsDTO, VideoDTO } from "@/lib/tubeforge/types";
import {
  Film,
  Rocket,
  Loader2,
  Wand2,
  FileText,
  Mic,
  Image as ImageIcon,
  Radio,
  AlertTriangle,
  ArrowRight,
  Eye,
  Heart,
  MessageCircle,
  Radar,
  PlayCircle,
  CheckCircle2,
} from "lucide-react";

const STAGE_ICONS: Record<string, typeof FileText> = {
  create: Wand2,
  script: FileText,
  voiceover: Mic,
  thumbnail: ImageIcon,
  publish: Rocket,
  ready: Rocket,
  channel: Radio,
};

/** Quick-start chips — one tap pre-fills the Create brief (T-4.2). */
const QUICK_TOPICS = [
  "Why the ocean has two layers that never mix",
  "The bankruptcy that built Las Vegas",
  "5 sleep experiments that went too far",
  "How container ships broke global trade",
];

export function DashboardView() {
  const refreshKey = useAppStore((s) => s.refreshKey);
  const setView = useAppStore((s) => s.setView);
  const setPrefillTopic = useAppStore((s) => s.setPrefillTopic);
  const setFocusVideoId = useAppStore((s) => s.setFocusVideoId);
  const [stats, setStats] = useState<StatsDTO | null>(null);
  const [videos, setVideos] = useState<VideoDTO[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/stats").then((r) => r.json()),
      fetch("/api/videos?limit=6").then((r) => r.json()),
    ])
      .then(([statsData, videosData]) => {
        if (!cancelled) {
          setStats(statsData.stats ?? null);
          setVideos(videosData.videos ?? []);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  if (loading && !stats) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-2xl bg-white/5" />
          ))}
        </div>
        <div className="grid lg:grid-cols-5 gap-4">
          <Skeleton className="h-72 rounded-2xl bg-white/5 lg:col-span-3" />
          <Skeleton className="h-72 rounded-2xl bg-white/5 lg:col-span-2" />
        </div>
      </div>
    );
  }

  if (!stats) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Could not load dashboard"
        hint="The stats service did not respond. Please retry."
        action={
          <Button
            onClick={() => useAppStore.getState().bumpRefresh()}
            variant="outline"
          >
            Retry
          </Button>
        }
      />
    );
  }

  const pipelineData = [
    { label: "Draft", value: stats.byStatus["draft"] ?? 0, cls: "bg-zinc-400" },
    {
      label: "Scripted",
      value: stats.byStatus["scripted"] ?? 0,
      cls: "bg-amber-400",
    },
    {
      label: "Voiced",
      value: stats.byStatus["voiced"] ?? 0,
      cls: "bg-sky-400",
    },
    {
      label: "Ready",
      value: stats.byStatus["ready"] ?? 0,
      cls: "bg-emerald-400",
    },
    {
      label: "Published",
      value: stats.byStatus["published"] ?? 0,
      cls: "bg-primary",
    },
  ];
  const maxPipeline = Math.max(1, ...pipelineData.map((p) => p.value));
  const chartTotal = stats.perDay.reduce((acc, d) => acc + d.count, 0);

  // "Continue where you left off" — the most recent video still in flight
  // (T-4.2). Published/failed videos are done; everything else is resumable.
  const continueVideo =
    videos.find(
      (v) => v.status !== "published" && v.status !== "failed" && v.status !== "ready"
    ) ?? null;
  const perf = stats.performance;

  const openVideo = (id: string) => {
    setFocusVideoId(id);
    setView("library");
  };

  return (
    <div className="space-y-6">
      {/* Quick-start hero (T-4.2) — actions + one-tap topic chips */}
      <Card className="glass rounded-2xl overflow-hidden relative">
        <div className="absolute inset-0 bg-grid opacity-60" aria-hidden="true" />
        <div
          className="absolute -top-24 -right-16 h-56 w-56 rounded-full bg-primary/15 blur-3xl"
          aria-hidden="true"
        />
        <div className="relative p-5 sm:p-7">
          <div className="flex flex-col md:flex-row md:items-center gap-5">
            <div className="flex-1 min-w-0">
              <div className="inline-flex items-center gap-2 rounded-full border border-primary/35 bg-primary/15 px-3 py-1 text-[11px] font-medium text-red-200">
                <span className="animate-pulse-dot h-1.5 w-1.5 rounded-full bg-primary" />
                Auto-Pilot Online
              </div>
              <h2 className="mt-3 text-xl sm:text-2xl font-bold tracking-tight">
                Your faceless channel, fully automated.
              </h2>
              <p className="text-sm text-muted-foreground mt-2 max-w-lg leading-relaxed">
                Drop a topic — AI writes the script, generates the narration, and
                paints the thumbnail. You just hit publish.
              </p>
            </div>
            <div className="flex flex-col sm:flex-row gap-2.5 shrink-0">
              <Button
                onClick={() => setView("create")}
                size="lg"
                className="bg-brand-gradient hover:opacity-90 font-semibold glow-red"
              >
                <Wand2 className="h-4.5 w-4.5" />
                Generate a Video
              </Button>
              <Button
                onClick={() => setView("research")}
                size="lg"
                variant="outline"
                className="border-white/15"
              >
                <Radar className="h-4.5 w-4.5" />
                Research a Topic
              </Button>
            </div>
          </div>
          {/* One-tap starts — prefill the guided brief (wired in T-4.3) */}
          {videos.length === 0 && (
            <div className="mt-5 pt-4 border-t border-white/8">
              <p className="tf-kicker mb-2.5">Start in one tap</p>
              <div className="flex flex-wrap gap-2">
                {QUICK_TOPICS.map((t) => (
                  <button
                    key={t}
                    onClick={() => {
                      setPrefillTopic(t);
                      setView("create");
                    }}
                    className="tf-focusable text-left text-xs rounded-full border border-white/12 bg-white/4 hover:bg-white/8 hover:border-white/20 px-3.5 py-2 text-white/70 hover:text-white transition-colors"
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </Card>

      {/* KPI row (T-4.2) — published + failed finally surfaced */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        <StatCard
          icon={Film}
          label="Total Videos"
          value={String(stats.total)}
          sub={`${stats.channels} channel${stats.channels === 1 ? "" : "s"} connected`}
          accent
        />
        <StatCard
          icon={Loader2}
          label="In Pipeline"
          value={String(stats.inPipeline)}
          sub="Scripting / voicing / art"
        />
        <StatCard
          icon={Rocket}
          label="Ready to Upload"
          value={String(stats.ready)}
          sub="Packaged & waiting"
        />
        <StatCard
          icon={CheckCircle2}
          label="Published"
          value={String(stats.published)}
          sub={
            stats.failed > 0
              ? `${stats.failed} failed — check Library`
              : "Live on YouTube"
          }
        />
      </div>

      {/* Performance strip (T-4.2) — real YouTube numbers from VideoStat */}
      {perf && perf.syncedVideos > 0 && (
        <Card className="glass rounded-2xl p-5">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <h3 className="font-semibold flex items-center gap-2">
                <Eye className="h-4 w-4 text-primary" />
                Channel Performance
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Across {perf.syncedVideos} synced video
                {perf.syncedVideos === 1 ? "" : "s"} · YouTube Data API
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => setView("analytics")}
            >
              Full analytics
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="flex items-center gap-3.5">
              <Sparkline values={perf.viewsSeries} width={84} height={30} />
              <div className="min-w-0">
                <p className="text-2xl font-bold tf-num tracking-tight">
                  {compactNumber(perf.views)}
                </p>
                <div className="flex items-center gap-2">
                  <p className="text-xs text-muted-foreground">Total views</p>
                  <TrendDelta value={perf.viewsDelta7d} />
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3.5">
              <div className="h-10 w-10 rounded-xl bg-rose-500/12 border border-rose-500/25 flex items-center justify-center shrink-0">
                <Heart className="h-4.5 w-4.5 text-rose-300" />
              </div>
              <div className="min-w-0">
                <p className="text-2xl font-bold tf-num tracking-tight">
                  {compactNumber(perf.likes)}
                </p>
                <p className="text-xs text-muted-foreground">Likes</p>
              </div>
            </div>
            <div className="flex items-center gap-3.5">
              <div className="h-10 w-10 rounded-xl bg-sky-500/12 border border-sky-500/25 flex items-center justify-center shrink-0">
                <MessageCircle className="h-4.5 w-4.5 text-sky-300" />
              </div>
              <div className="min-w-0">
                <p className="text-2xl font-bold tf-num tracking-tight">
                  {compactNumber(perf.comments)}
                </p>
                <p className="text-xs text-muted-foreground">Comments</p>
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* Needs attention + generating now (Mission Control audit points) */}
      <AttentionPanel />

      {/* Continue where you left off (T-4.2) */}
      {continueVideo && (
        <Card className="glass rounded-2xl p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center gap-4">
          <div className="h-11 w-11 rounded-xl bg-primary/12 border border-primary/25 flex items-center justify-center shrink-0">
            <PlayCircle className="h-5 w-5 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="tf-kicker">Continue where you left off</p>
            <p className="text-sm font-medium truncate mt-1">
              {continueVideo.title || continueVideo.topic}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {continueVideo.status} · {continueVideo.sceneCount
                ? `${continueVideo.sceneCount} scenes · `
                : ""}
              updated {timeAgo(continueVideo.updatedAt ?? continueVideo.createdAt)}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="border-white/15 shrink-0"
            onClick={() => openVideo(continueVideo.id)}
          >
            Resume production
            <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </Card>
      )}

      <div className="grid lg:grid-cols-5 gap-4 items-stretch">
        {/* Production chart */}
        <Card className="glass rounded-2xl p-5 lg:col-span-3 h-full flex flex-col">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold">Production Volume</h3>
              <p className="text-xs text-muted-foreground">
                Videos created · last 7 days
              </p>
            </div>
          </div>
          {chartTotal === 0 ? (
            <div className="mt-6 h-44 rounded-xl border border-dashed border-white/12 bg-white/[0.02] flex flex-col items-center justify-center text-center px-6">
              <p className="text-sm font-medium">No videos yet</p>
              <p className="text-xs text-muted-foreground mt-1 leading-relaxed max-w-xs">
                Your first generation will chart here, day by day.
              </p>
            </div>
          ) : (
          <div
            className="mt-6 h-44 flex items-end gap-2 sm:gap-3"
            role="img"
            aria-label={`Bar chart of videos created per day over the last 7 days: ${stats.perDay
              .map((d) => `${d.day} ${d.count}`)
              .join(", ")}`}
          >
            {stats.perDay.map((d) => {
              const max = Math.max(1, ...stats.perDay.map((x) => x.count));
              const h = Math.max(6, Math.round((d.count / max) * 100));
              return (
                <div
                  key={d.day}
                  className="flex-1 h-full flex flex-col items-center justify-end gap-1.5 min-w-0 group"
                  title={`${d.day}: ${d.count} video${d.count === 1 ? "" : "s"}`}
                >
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    {d.count > 0 ? d.count : ""}
                  </span>
                  <div className="flex-1 w-full max-w-12 flex items-end">
                    <div
                      className="w-full rounded-t-lg bg-gradient-to-t from-primary/80 to-primary/30 transition-all duration-500 group-hover:from-primary group-hover:to-primary/50"
                      style={{
                        height: `${h}%`,
                        opacity: d.count > 0 ? 1 : 0.12,
                      }}
                    />
                  </div>
                  <span className="text-[10px] text-muted-foreground truncate">
                    {d.day}
                  </span>
                </div>
              );
            })}
          </div>
          )}
        </Card>

        {/* Pipeline breakdown */}
        <Card className="glass rounded-2xl p-5 lg:col-span-2 h-full flex flex-col">
          <h3 className="font-semibold">Pipeline Breakdown</h3>
          <p className="text-xs text-muted-foreground">
            Where your videos currently sit
          </p>
          <ul className="mt-5 space-y-3.5">
            {pipelineData.map((p) => (
              <li key={p.label}>
                <div className="flex items-center justify-between text-xs mb-1.5">
                  <span className="text-muted-foreground">{p.label}</span>
                  <span className="font-semibold tabular-nums">{p.value}</span>
                </div>
                <div className="h-2 rounded-full bg-white/6 overflow-hidden">
                  <div
                    className={`h-full rounded-full ${p.cls} transition-all duration-500`}
                    style={{ width: `${(p.value / maxPipeline) * 100}%` }}
                  />
                </div>
              </li>
            ))}
            {stats.failed > 0 && (
              <li>
                <div className="flex items-center justify-between text-xs mb-1.5">
                  <span className="text-red-300/90">Failed</span>
                  <span className="font-semibold tabular-nums text-red-300">
                    {stats.failed}
                  </span>
                </div>
                <div className="h-2 rounded-full bg-white/6 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-red-400/80 transition-all duration-500"
                    style={{ width: `${(stats.failed / maxPipeline) * 100}%` }}
                  />
                </div>
              </li>
            )}
          </ul>
          {stats.failed > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="mt-4 text-red-300 hover:text-red-200 hover:bg-red-500/10 self-start"
              onClick={() => setView("library")}
            >
              Review failed videos
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          )}
        </Card>
      </div>

      {/* Recent projects (T-4.2) — clickable, thumbnail-first */}
      {videos.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className="font-semibold">Recent Projects</h3>
              <p className="text-xs text-muted-foreground">
                Pick up any production — click to open
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => setView("library")}
            >
              Library
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
            {videos.slice(0, 6).map((v) => (
              <button
                key={v.id}
                onClick={() => openVideo(v.id)}
                className="tf-focusable tf-card tf-card-hover text-left overflow-hidden group"
              >
                <div className="relative aspect-video bg-white/4 overflow-hidden">
                  {v.hasThumbnail ? (
                    <img
                      src={`/api/videos/${v.id}/thumbnail`}
                      alt=""
                      className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                    />
                  ) : (
                    <div className="h-full w-full bg-gradient-to-br from-primary/15 via-transparent to-white/5 flex items-center justify-center">
                      <Film className="h-7 w-7 text-white/15" />
                    </div>
                  )}
                  <div className="absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-black/70 to-transparent" />
                  <div className="absolute bottom-2 left-2.5 flex items-center gap-2">
                    <StatusBadge status={v.status} />
                    {v.videoDuration ? (
                      <span className="tf-num text-[11px] text-white/85 px-1.5 py-0.5 rounded bg-black/55">
                        {formatDuration(v.videoDuration)}
                      </span>
                    ) : null}
                  </div>
                  {v.stats?.views ? (
                    <span className="tf-num absolute top-2 right-2 flex items-center gap-1 text-[11px] text-white/85 px-1.5 py-0.5 rounded bg-black/55">
                      <Eye className="h-3 w-3" />
                      {compactNumber(v.stats.views)}
                    </span>
                  ) : null}
                </div>
                <div className="p-3.5">
                  <p className="text-sm font-medium leading-snug line-clamp-1">
                    {v.title || v.topic}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1 truncate">
                    {v.niche} · {timeAgo(v.createdAt)}
                  </p>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Activity feed — rows drill into the video (T-4.2) */}
      <Card className="glass rounded-2xl p-5">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold">Recent Activity</h3>
            <p className="text-xs text-muted-foreground">
              Live from the automation floor
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => setView("library")}
          >
            Library
            <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </div>
        {stats.recent.length === 0 ? (
          <p className="text-sm text-muted-foreground mt-6">
            Nothing yet — generate your first video to see the pipeline in
            action.
          </p>
        ) : (
          <div className="mt-4 max-h-80 overflow-y-auto scroll-area-bar pr-1">
            <ul className="space-y-1">
              {stats.recent.map((a) => {
                const Icon = STAGE_ICONS[a.stage] ?? Wand2;
                const isError = a.level === "error";
                const videoId = a.videoId;
                const inner = (
                  <>
                    <div
                      className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 ${
                        isError
                          ? "bg-red-500/15 text-red-300"
                          : "bg-white/6 text-muted-foreground"
                      }`}
                    >
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm leading-snug">{a.message}</p>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        {a.stage} · {timeAgo(a.createdAt)}
                      </p>
                    </div>
                    {videoId && (
                      <ArrowRight className="h-3.5 w-3.5 text-white/25 shrink-0 mt-1.5" />
                    )}
                  </>
                );
                return (
                  <li key={a.id}>
                    {videoId ? (
                      <button
                        onClick={() => openVideo(videoId)}
                        className="tf-focusable w-full flex items-start gap-3 rounded-xl px-3 py-2.5 hover:bg-white/4 transition-colors text-left"
                      >
                        {inner}
                      </button>
                    ) : (
                      <div className="flex items-start gap-3 rounded-xl px-3 py-2.5">
                        {inner}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </Card>
    </div>
  );
}
