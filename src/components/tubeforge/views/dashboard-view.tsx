"use client";

import { useEffect, useState } from "react";
import { useAppStore } from "@/lib/store";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { StatCard, EmptyState, timeAgo } from "@/components/tubeforge/shared";
import { AttentionPanel } from "@/components/tubeforge/attention-panel";
import type { StatsDTO } from "@/lib/tubeforge/types";
import {
  Film,
  Rocket,
  Loader2,
  Timer,
  Wand2,
  FileText,
  Mic,
  Image as ImageIcon,
  Radio,
  AlertTriangle,
  ArrowRight,
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

export function DashboardView() {
  const refreshKey = useAppStore((s) => s.refreshKey);
  const setView = useAppStore((s) => s.setView);
  const [stats, setStats] = useState<StatsDTO | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/stats")
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) {
          setStats(data.stats ?? null);
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

  return (
    <div className="space-y-6">
      {/* Hero banner */}
      <Card className="glass rounded-2xl overflow-hidden relative">
        <div
          className="absolute inset-0 bg-grid opacity-60"
          aria-hidden="true"
        />
        <div
          className="absolute -top-24 -right-16 h-56 w-56 rounded-full bg-primary/15 blur-3xl"
          aria-hidden="true"
        />
        <div className="relative p-5 sm:p-7 flex flex-col md:flex-row md:items-center gap-5">
          <div className="flex-1 min-w-0">
            <div className="inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary/10 px-3 py-1 text-[11px] font-medium text-red-300">
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
          <Button
            onClick={() => setView("create")}
            size="lg"
            className="bg-brand-gradient hover:opacity-90 font-semibold glow-red shrink-0"
          >
            <Wand2 className="h-4.5 w-4.5" />
            Generate a Video
          </Button>
        </div>
      </Card>

      {/* Stat cards */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        <StatCard
          icon={Film}
          label="Total Videos"
          value={String(stats.total)}
          sub={`${stats.channels} channel${stats.channels === 1 ? "" : "s"} connected`}
          accent
        />
        <StatCard
          icon={Rocket}
          label="Ready to Upload"
          value={String(stats.ready)}
          sub="Packaged & waiting"
        />
        <StatCard
          icon={Loader2}
          label="In Pipeline"
          value={String(stats.inPipeline)}
          sub="Scripting / voicing / art"
        />
        <StatCard
          icon={Timer}
          label="Audio Produced"
          value={`${stats.audioMinutes}m`}
          sub="Narration runtime"
        />
      </div>

      {/* Needs attention + generating now (Mission Control audit points) */}
      <AttentionPanel />

      <div className="grid lg:grid-cols-5 gap-4">
        {/* Production chart */}
        <Card className="glass rounded-2xl p-5 lg:col-span-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold">Production Volume</h3>
              <p className="text-xs text-muted-foreground">
                Videos created · last 7 days
              </p>
            </div>
          </div>
          <div
            className="mt-6 h-44 flex items-end gap-2 sm:gap-3"
            role="img"
            aria-label="Bar chart of videos created per day over the last 7 days"
          >
            {stats.perDay.map((d) => {
              const max = Math.max(1, ...stats.perDay.map((x) => x.count));
              const h = Math.max(6, Math.round((d.count / max) * 100));
              return (
                <div
                  key={d.day}
                  className="flex-1 h-full flex flex-col items-center justify-end gap-1.5 min-w-0"
                >
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    {d.count > 0 ? d.count : ""}
                  </span>
                  <div className="flex-1 w-full max-w-12 flex items-end">
                    <div
                      className="w-full rounded-t-lg bg-gradient-to-t from-primary/80 to-primary/30 transition-all duration-500"
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
        </Card>

        {/* Pipeline breakdown */}
        <Card className="glass rounded-2xl p-5 lg:col-span-2">
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
          </ul>
        </Card>
      </div>

      {/* Activity feed */}
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
                return (
                  <li
                    key={a.id}
                    className="flex items-start gap-3 rounded-xl px-3 py-2.5 hover:bg-white/4 transition-colors"
                  >
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
