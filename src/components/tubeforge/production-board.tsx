"use client";

// S91 (ROADMAP #10) — the living production board: one compact card in the
// project studio that answers "where is this video, what needs me, what did
// it cost". Stages / checkpoints / costs / history, composed by
// GET /api/videos/[id]/board from the EXISTING database + job system —
// Backlot studied, not copied: TubeForge's board is stage-and-checkpoint
// shaped because its pipeline is stage-and-checkpoint shaped.

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Loader2,
  MinusCircle,
} from "lucide-react";

interface BoardStage {
  state: "done" | "partial" | "preview" | "running" | "missing";
  label: string;
  detail?: string;
}

interface BoardCheckpoint {
  id: string;
  label: string;
  state: "ok" | "pending" | "attention" | "na";
  detail: string;
}

interface BoardData {
  stages: Record<"script" | "storyboard" | "voiceover" | "render" | "publish", BoardStage>;
  jobs: Record<string, boolean | unknown> & { lastErrors?: Record<string, string> };
  checkpoints: BoardCheckpoint[];
  costs: {
    windowDays: number;
    totalMicroUsd: number;
    totalCalls: number;
    failedCalls: number;
    byLane: { capability: string; provider: string; calls: number; costMicroUsd: number }[];
    attributionNote: string;
  };
  history: { id: string; stage: string; message: string; level: string; createdAt: string }[];
}

const STAGE_DOT: Record<BoardStage["state"], string> = {
  done: "bg-emerald-400",
  partial: "bg-amber-400",
  preview: "bg-sky-400",
  running: "bg-indigo-400 animate-pulse",
  missing: "bg-zinc-600",
};

function timeAgo(iso: string): string {
  const s = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function ProductionBoard({ videoId }: { videoId: string }) {
  const [data, setData] = useState<BoardData | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/videos/${videoId}/board`, { cache: "no-store" });
      if (!res.ok) return;
      setData((await res.json()) as BoardData);
    } catch {
      /* the board is context, never a blocker */
    }
  }, [videoId]);

  useEffect(() => {
    // Deferred by 0ms — the codebase's settled pattern for async loads in
    // effects (no synchronous setState cascades).
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  // Live while anything generates (the queue-panel rhythm: 4s until idle).
  const anyRunning =
    data != null &&
    Object.entries(data.jobs).some(
      ([k, v]) => k !== "lastErrors" && typeof v === "boolean" && v
    );
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [anyRunning, load]);

  if (!data) return null;

  const stages = Object.values(data.stages);
  const attention = data.checkpoints.filter((c) => c.state === "attention");
  const visibleCheckpoints = data.checkpoints.filter((c) => c.state !== "na");
  const dollars = (micro: number) =>
    micro >= 1_000_000 ? `$${(micro / 1_000_000).toFixed(2)}` : `$${(micro / 1_000_000).toFixed(3)}`;
  const topLanes = data.costs.byLane
    .slice(0, 3)
    .map((l) => `${l.capability}/${l.provider}`)
    .join(" · ");
  const history = showHistory ? data.history : data.history.slice(0, 5);

  return (
    <div className="mt-3 rounded-xl border border-white/10 bg-white/[0.02] p-3 space-y-2.5">
      {/* the stage strip */}
      <div className="flex items-center gap-1 flex-wrap">
        {stages.map((s, i) => (
          <div key={s.label} className="flex items-center gap-1">
            {i > 0 && <ChevronRight className="h-3 w-3 text-zinc-600" />}
            <span
              className="inline-flex items-center gap-1.5 rounded-lg bg-white/[0.04] border border-white/8 px-2 py-1"
              title={s.detail ?? s.state}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${STAGE_DOT[s.state]}`} />
              <span className="text-[11px] text-zinc-300">{s.label}</span>
              {s.state === "running" && <Loader2 className="h-3 w-3 animate-spin text-indigo-300" />}
              {s.detail && (
                <span className="text-[10px] text-muted-foreground">{s.detail}</span>
              )}
            </span>
          </div>
        ))}
      </div>

      {/* what needs the human */}
      {attention.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          {attention.map((c) => (
            <span
              key={c.id}
              className="inline-flex items-center gap-1 rounded-lg border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-200"
            >
              <AlertTriangle className="h-3 w-3" />
              {c.label}: {c.detail}
            </span>
          ))}
        </div>
      )}

      {/* checkpoints + costs */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-1.5 flex-wrap">
          {visibleCheckpoints.map((c) => (
            <span
              key={c.id}
              className="inline-flex items-center gap-1 text-[10px] text-muted-foreground"
              title={c.detail}
            >
              {c.state === "ok" ? (
                <CheckCircle2 className="h-3 w-3 text-emerald-400" />
              ) : c.state === "attention" ? (
                <AlertTriangle className="h-3 w-3 text-amber-400" />
              ) : c.state === "pending" ? (
                <Clock className="h-3 w-3 text-zinc-400" />
              ) : (
                <MinusCircle className="h-3 w-3 text-zinc-600" />
              )}
              {c.label}
            </span>
          ))}
        </div>
        {data.costs.totalCalls > 0 && (
          <span
            className="text-[10px] text-muted-foreground"
            title={`${data.costs.totalCalls} AI calls, ${data.costs.failedCalls} failed · ${topLanes} · ${data.costs.attributionNote}`}
          >
            {dollars(data.costs.totalMicroUsd)} org AI spend · {data.costs.totalCalls} calls (
            {data.costs.windowDays}d)
          </span>
        )}
      </div>

      {/* production history */}
      <div className="border-t border-white/8 pt-2">
        <button
          type="button"
          onClick={() => setShowHistory((v) => !v)}
          className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronDown className={`h-3 w-3 transition-transform ${showHistory ? "" : "-rotate-90"}`} />
          Production history · {data.history.length} events
        </button>
        {history.length > 0 && (
          <div className="mt-1.5 space-y-0.5">
            {history.map((h) => (
              <div key={h.id} className="flex items-start gap-2 text-[11px] leading-relaxed">
                <span
                  className={`mt-1 h-1 w-1 rounded-full shrink-0 ${
                    h.level === "warn" || h.level === "error" ? "bg-amber-400" : "bg-zinc-600"
                  }`}
                />
                <span className="text-zinc-400 min-w-0 flex-1">{h.message}</span>
                <span className="text-[10px] text-zinc-600 shrink-0">{timeAgo(h.createdAt)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
