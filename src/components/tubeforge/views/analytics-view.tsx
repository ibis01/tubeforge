"use client";

import { useCallback, useEffect, useState } from "react";
import { useAppStore } from "@/lib/store";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { StatCard, EmptyState, timeAgo } from "@/components/tubeforge/shared";
import type {
  AnalyticsOverviewDTO,
  YouTubeStatusDTO,
  RescoreDTO,
} from "@/lib/tubeforge/types";
import {
  Eye,
  ThumbsUp,
  MessageCircle,
  TrendingUp as TrendingIcon,
  RefreshCw,
  Loader2,
  Youtube,
  Zap,
  Radar,
  Settings,
  ArrowUpRight,
  Sparkles,
  ExternalLink,
} from "lucide-react";

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function AnalyticsView() {
  const { toast } = useToast();
  const setView = useAppStore((s) => s.setView);
  const setFocusVideoId = useAppStore((s) => s.setFocusVideoId);
  const refreshKey = useAppStore((s) => s.refreshKey);

  const [data, setData] = useState<AnalyticsOverviewDTO | null>(null);
  const [yt, setYt] = useState<YouTubeStatusDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [boosting, setBoosting] = useState(false);

  const load = useCallback(async () => {
    try {
      const [overviewRes, ytRes] = await Promise.all([
        fetch("/api/analytics", { cache: "no-store" }),
        fetch("/api/youtube/status", { cache: "no-store" }),
      ]);
      const overview = overviewRes.ok ? await overviewRes.json() : null;
      const ytData = ytRes.ok ? await ytRes.json() : null;
      if (overview && !overview.error) setData(overview);
      if (ytData?.status) setYt(ytData.status);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const syncNow = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const res = await fetch("/api/youtube/sync", { method: "POST" });
      const body = await res.json();
      if (!res.ok) {
        toast({ title: "Sync failed", description: body.error, variant: "destructive" });
      } else {
        toast({
          title: `Stats synced for ${body.synced} video${body.synced === 1 ? "" : "s"}`,
          description: `${body.totals.views.toLocaleString()} total views · ${body.totals.likes.toLocaleString()} likes`,
        });
        await load();
      }
    } catch {
      toast({ title: "Sync failed", description: "Network error — try again", variant: "destructive" });
    } finally {
      setSyncing(false);
    }
  };

  const reboostRadar = async () => {
    if (boosting) return;
    setBoosting(true);
    try {
      const res = await fetch("/api/analytics/rescore", { method: "POST" });
      const body: RescoreDTO & { error?: string } = await res.json();
      if (!res.ok) {
        toast({ title: "Boost not applied", description: body.error, variant: "destructive" });
      } else {
        toast({
          title: `Radar re-boosted — ${body.boosted} idea${body.boosted === 1 ? "" : "s"} adjusted`,
          description: "Topic Radar scores now reflect your channel's real performance.",
        });
      }
    } catch {
      toast({ title: "Boost failed", description: "Network error — try again", variant: "destructive" });
    } finally {
      setBoosting(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-2xl bg-white/5" />
          ))}
        </div>
        <Skeleton className="h-80 rounded-2xl bg-white/5" />
      </div>
    );
  }

  const hasData = data && data.trackedCount > 0;

  // No published (or synced) videos yet — explain the loop instead of an empty page.
  if (!hasData) {
    return (
      <div className="space-y-6">
        <EmptyState
          icon={TrendingIcon}
          title={data && data.publishedCount > 0 ? "Sync your channel's stats" : "Analytics wake up after your first upload"}
          hint={
            data && data.publishedCount > 0
              ? `You have ${data.publishedCount} published video${data.publishedCount === 1 ? "" : "s"} — pull their live YouTube stats to start the performance loop.`
              : "Upload a video to YouTube from a video's detail dialog, then sync here. TubeForge tracks views, likes and comments, and feeds the winners back into the Topic Radar."
          }
          action={
            <div className="flex flex-wrap gap-2 justify-center">
              {yt?.connected && (data?.publishedCount ?? 0) > 0 ? (
                <Button onClick={syncNow} disabled={syncing} className="bg-brand-gradient hover:opacity-90 font-medium">
                  {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  Sync YouTube stats
                </Button>
              ) : (
                <Button onClick={() => setView("settings")} className="bg-brand-gradient hover:opacity-90 font-medium">
                  <Settings className="h-4 w-4" />
                  Connect YouTube in Settings
                </Button>
              )}
              <Button onClick={() => setView("library")} variant="outline" className="border-white/15 bg-white/4 text-muted-foreground hover:text-foreground">
                Open Library
              </Button>
            </div>
          }
        />
      </div>
    );
  }

  const maxSeries = Math.max(1, ...data.series.map((s) => s.views));
  const top = data.rows[0];

  return (
    <div className="space-y-6">
      {/* Sync bar */}
      <Card className="glass border-white/8 rounded-2xl p-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <div className="h-9 w-9 rounded-xl bg-brand-gradient glow-red-soft flex items-center justify-center shrink-0">
            <Youtube className="h-4.5 w-4.5 text-white" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">
              {yt?.channelTitle ?? "YouTube channel"}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {data.lastSyncAt ? `Last sync ${timeAgo(data.lastSyncAt)}` : "Not synced yet"}
              {yt?.connected ? "" : " · channel not connected"}
            </p>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {yt?.connected && (
            <Button size="sm" onClick={syncNow} disabled={syncing} className="bg-brand-gradient hover:opacity-90 font-medium">
              {syncing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              <span className="hidden sm:inline">{syncing ? "Syncing…" : "Sync now"}</span>
            </Button>
          )}
          {data.feedback.active && (
            <Button
              size="sm"
              variant="outline"
              onClick={reboostRadar}
              disabled={boosting}
              className="border-white/15 bg-white/4"
              title="Re-apply channel performance to the latest Topic Radar scan"
            >
              {boosting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
              Re-boost radar
            </Button>
          )}
        </div>
      </Card>

      {/* Totals */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        <StatCard icon={Eye} label="Total views" value={formatNum(data.totals.views)} sub={`+${formatNum(data.viewDelta)} last sync`} accent />
        <StatCard icon={ThumbsUp} label="Total likes" value={formatNum(data.totals.likes)} sub={`${formatNum(data.trackedCount)} tracked videos`} />
        <StatCard icon={MessageCircle} label="Total comments" value={formatNum(data.totals.comments)} sub={`${data.publishedCount} published`} />
        <StatCard icon={Sparkles} label="Avg engagement" value={`${(data.avgEngagement * 100).toFixed(1)}%`} sub="(likes + comments) / views" />
      </div>

      <div className="grid lg:grid-cols-5 gap-4">
        {/* Per-video table */}
        <Card className="glass border-white/8 rounded-2xl p-5 lg:col-span-3">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold">Video performance</h3>
            <Badge variant="outline" className="border-white/15 bg-white/5 text-muted-foreground text-[10px]">
              sorted by views
            </Badge>
          </div>
          <div className="space-y-2">
            {data.rows.map((row, i) => (
              <button
                key={row.videoId}
                onClick={() => {
                  setFocusVideoId(row.videoId);
                  setView("library");
                }}
                className="w-full flex items-center gap-3 rounded-xl border border-white/8 bg-white/3 px-3 py-2.5 text-left transition-all hover:border-white/20 hover:bg-white/6"
              >
                <span className="text-xs tabular-nums text-muted-foreground w-4 shrink-0">{i + 1}</span>
                {row.thumbnailUrl ? (
                  <img
                    src={row.thumbnailUrl}
                    alt=""
                    className="h-9 w-16 rounded-md object-cover border border-white/10 shrink-0"
                  />
                ) : (
                  <div className="h-9 w-16 rounded-md bg-white/5 border border-white/10 shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{row.title}</p>
                  <p className="text-[11px] text-muted-foreground flex items-center gap-2">
                    <span>{formatNum(row.views)} views</span>
                    {row.viewDelta > 0 && (
                      <span className="text-emerald-300 inline-flex items-center gap-0.5">
                        <ArrowUpRight className="h-3 w-3" />
                        {formatNum(row.viewDelta)}
                      </span>
                    )}
                    <span>· {(row.engagementRate * 100).toFixed(1)}% eng</span>
                    <span>· {row.snapshots} sync{row.snapshots === 1 ? "" : "s"}</span>
                  </p>
                </div>
                {row.youtubeUrl && (
                  <a
                    href={row.youtubeUrl}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="text-muted-foreground hover:text-red-300 transition-colors shrink-0"
                    aria-label="Open on YouTube"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
              </button>
            ))}
          </div>
        </Card>

        {/* Growth + feedback loop */}
        <div className="lg:col-span-2 space-y-4">
          <Card className="glass border-white/8 rounded-2xl p-5">
            <h3 className="text-sm font-semibold mb-4">Channel views over time</h3>
            {data.series.length > 1 ? (
              <div className="flex items-end gap-2 h-40">
                {data.series.map((point) => (
                  <div key={point.day} className="flex-1 flex flex-col items-center gap-1.5 min-w-0">
                    <span className="text-[10px] text-muted-foreground tabular-nums">{formatNum(point.views)}</span>
                    <div
                      className="w-full rounded-t-md bg-brand-gradient"
                      style={{ height: `${Math.max(4, (point.views / maxSeries) * 100)}%` }}
                      title={`${point.day}: ${point.views.toLocaleString()} cumulative views`}
                    />
                    <span className="text-[9px] text-muted-foreground/70 truncate w-full text-center">
                      {point.day.slice(5)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                One sync recorded — sync again later to chart growth between snapshots.
              </p>
            )}
          </Card>

          <Card className="glass border-white/8 rounded-2xl p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold flex items-center gap-1.5">
                <Zap className="h-3.5 w-3.5 text-primary" />
                Performance feedback loop
              </h3>
              {data.feedback.active ? (
                <Badge variant="outline" className="border-emerald-500/25 bg-emerald-500/10 text-emerald-200 text-[10px]">
                  active
                </Badge>
              ) : (
                <Badge variant="outline" className="border-amber-500/25 bg-amber-500/10 text-amber-200 text-[10px]">
                  warming up
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Topic Radar scans now carry a PERFORMANCE INTELLIGENCE brief built from these
              stats — ideas sharing DNA with your winners score higher, and ones resembling
              underperformers get dinged.
            </p>
            {data.feedback.winners.length > 0 && (
              <div className="mt-3 space-y-1.5">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                  Feeding the loop
                </p>
                {data.feedback.winners.slice(0, 3).map((w) => (
                  <p key={w} className="text-xs truncate flex items-center gap-1.5">
                    <TrendingIcon className="h-3 w-3 text-emerald-300 shrink-0" />
                    {w}
                  </p>
                ))}
              </div>
            )}
            {data.feedback.topKeywords.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {data.feedback.topKeywords.map((k) => (
                  <Badge key={k} variant="outline" className="border-primary/25 bg-primary/10 text-red-200 text-[10px]">
                    {k}
                  </Badge>
                ))}
              </div>
            )}
            <Button
              size="sm"
              variant="outline"
              onClick={() => setView("research")}
              className="mt-4 w-full border-white/15 bg-white/4"
            >
              <Radar className="h-3.5 w-3.5" />
              Open Topic Radar
            </Button>
          </Card>
        </div>
      </div>
    </div>
  );
}
