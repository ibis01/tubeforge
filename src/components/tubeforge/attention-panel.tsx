"use client";

// Mission Control "Needs attention" + "Generating now" panels — the two
// questions the audit asked the dashboard to answer instantly:
//   1. What videos are currently generating?
//   2. Which jobs need attention (with a one-click Resume)?

import { useCallback, useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/lib/store";
import { useToast } from "@/hooks/use-toast";
import type { JobDTO } from "@/lib/tubeforge/types";
import {
  AlertTriangle,
  Loader2,
  RotateCcw,
  Ban,
  FileText,
  Mic,
  ImageIcon,
  LayoutGrid,
  Clapperboard,
  SearchCheck,
  Layers,
  RefreshCcwDot,
} from "lucide-react";

const KIND_META: Record<
  string,
  { label: string; icon: typeof FileText; endpoint: (id: string) => [string, string] | null }
> = {
  script: {
    label: "script",
    icon: FileText,
    endpoint: (id) => [`/api/videos/${id}/script`, "POST"],
  },
  voiceover: {
    label: "voiceover",
    icon: Mic,
    endpoint: (id) => [`/api/videos/${id}/voiceover`, "POST"],
  },
  thumbnail: {
    label: "thumbnail",
    icon: ImageIcon,
    endpoint: (id) => [`/api/videos/${id}/thumbnail`, "POST"],
  },
  storyboard: {
    label: "storyboard",
    icon: LayoutGrid,
    endpoint: (id) => [`/api/videos/${id}/storyboard`, "POST"],
  },
  render: {
    label: "render",
    icon: Clapperboard,
    endpoint: (id) => [`/api/videos/${id}/render`, "POST-JSON"],
  },
  convert: {
    label: "scene split",
    icon: RefreshCcwDot,
    endpoint: (id) => [`/api/videos/${id}/convert`, "POST"],
  },
  verify: {
    label: "narration check",
    icon: SearchCheck,
    endpoint: (id) => [`/api/videos/${id}/verify`, "POST"],
  },
  variants: {
    label: "A/B thumbnails",
    icon: Layers,
    endpoint: (id) => [`/api/videos/${id}/variants`, "POST"],
  },
};

const NEEDS_ATTENTION: JobDTO["status"][] = ["failed", "interrupted"];
const videoIdOf = (entityId: string) => entityId.split("#")[0];

export function AttentionPanel() {
  const { toast } = useToast();
  const bumpRefresh = useAppStore((s) => s.bumpRefresh);
  const setView = useAppStore((s) => s.setView);
  const [jobs, setJobs] = useState<JobDTO[] | null>(null);
  const [resuming, setResuming] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/jobs?limit=40", { cache: "no-store" });
      const d = (await res.json()) as { jobs: JobDTO[] };
      setJobs(d.jobs ?? []);
    } catch {
      setJobs([]);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 8000); // live while renders run
    return () => clearInterval(t);
  }, [load, useAppStore((s) => s.refreshKey)]);

  if (jobs === null) return null;

  const running = jobs.filter((j) => j.status === "running");
  const attention = jobs
    .filter((j) => NEEDS_ATTENTION.includes(j.status))
    .filter((j) => KIND_META[j.kind]); // only kinds we know how to resume

  const resume = async (job: JobDTO) => {
    const meta = KIND_META[job.kind];
    if (!meta) return;
    const vid = videoIdOf(job.entityId);
    const [url, method] = meta.endpoint(vid)!;
    setResuming(job.id);
    try {
      const res = await fetch(url, {
        method: "POST",
        ...(method === "POST-JSON"
          ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) }
          : {}),
      });
      if (!res.ok && res.status !== 202 && res.status !== 200) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error ?? `HTTP ${res.status}`);
      }
      toast({ title: `${meta.label} resumed`, description: "Running in the background — watch it in the video detail." });
      await load();
      bumpRefresh();
    } catch (e) {
      toast({
        title: "Could not resume",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setResuming(null);
    }
  };

  const cancelAll = async (job: JobDTO) => {
    const vid = videoIdOf(job.entityId);
    await fetch(`/api/videos/${vid}/cancel`, { method: "POST" }).catch(() => {});
    toast({ title: "Cancel requested", description: "Stops after the current step." });
    setTimeout(() => void load(), 1500);
  };

  if (running.length === 0 && attention.length === 0) return null;

  return (
    <div className="grid lg:grid-cols-5 gap-4 [&>*]:min-w-0">
      {/* Generating now */}
      {running.length > 0 && (
        <Card className="glass rounded-2xl p-5 lg:col-span-2 border-primary/20">
          <div className="flex items-center gap-2 mb-1">
            <Loader2 className="h-4 w-4 text-primary animate-spin" />
            <h3 className="font-semibold">Generating now</h3>
            <span className="ml-auto text-xs tabular-nums text-muted-foreground">
              {running.length} job{running.length > 1 ? "s" : ""}
            </span>
          </div>
          <ul className="mt-3 space-y-2">
            {running.slice(0, 5).map((j) => {
              const meta = KIND_META[j.kind];
              const Icon = meta?.icon ?? Loader2;
              return (
                <li key={j.id} className="flex items-center gap-2.5 rounded-xl px-3 py-2 bg-white/4">
                  <Icon className="h-3.5 w-3.5 text-primary shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium truncate">
                      {j.entityTitle ?? j.entityId}
                    </p>
                    <p className="text-[10px] text-muted-foreground truncate">
                      {meta?.label ?? j.kind}
                      {j.label ? ` · ${j.label}` : ""}
                      {j.progress != null ? ` · ${Math.round(j.progress * 100)}%` : ""}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-[10px] text-red-300 hover:bg-red-500/10"
                    onClick={() => void cancelAll(j)}
                    aria-label={`Cancel ${meta?.label ?? j.kind}`}
                  >
                    <Ban className="h-3 w-3" />
                  </Button>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {/* Needs attention */}
      {attention.length > 0 && (
        <Card className="glass rounded-2xl p-5 border-amber-500/20 lg:col-span-3">
          <div className="flex items-center gap-2 mb-1">
            <AlertTriangle className="h-4 w-4 text-amber-400" />
            <h3 className="font-semibold">Needs attention</h3>
            <span className="ml-auto text-xs tabular-nums text-muted-foreground">
              {attention.length} failed / interrupted
            </span>
          </div>
          <ul className="mt-3 space-y-2">
            {attention.slice(0, 6).map((j) => {
              const meta = KIND_META[j.kind];
              const Icon = meta?.icon ?? AlertTriangle;
              return (
                <li
                  key={j.id}
                  className="flex items-center gap-2.5 rounded-xl px-3 py-2 bg-amber-500/5 border border-amber-500/15"
                >
                  <Icon className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium truncate">
                      {j.entityTitle ?? j.entityId}{" "}
                      <span className="font-normal text-muted-foreground">
                        — {meta?.label ?? j.kind}
                      </span>
                    </p>
                    <p className="text-[10px] text-muted-foreground truncate" title={j.error ?? ""}>
                      {j.status === "interrupted" ? "Server restarted mid-stage" : (j.error ?? "failed")}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={resuming === j.id}
                    onClick={() => void resume(j)}
                    className="h-7 px-2.5 text-[11px] border-amber-500/30 text-amber-200 hover:bg-amber-500/10 shrink-0"
                  >
                    {resuming === j.id ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <RotateCcw className="h-3 w-3" />
                    )}
                    Resume
                  </Button>
                </li>
              );
            })}
          </ul>
          <Button
            variant="ghost"
            size="sm"
            className="mt-3 text-xs text-muted-foreground"
            onClick={() => setView("library")}
          >
            Open the library
          </Button>
        </Card>
      )}
    </div>
  );
}
