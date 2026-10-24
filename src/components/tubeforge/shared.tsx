"use client";

import { Card } from "@/components/ui/card";
import { STATUS_META, type VideoStatus } from "@/lib/tubeforge/types";
import type { LucideIcon } from "lucide-react";
import { clsx } from "clsx";

export function StatusBadge({
  status,
  className,
}: {
  status: VideoStatus;
  className?: string;
}) {
  const meta = STATUS_META[status] ?? STATUS_META.draft;
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium",
        meta.color,
        className
      )}
    >
      {meta.label}
    </span>
  );
}

export function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  accent,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <Card
      className={clsx(
        "glass border-white/8 rounded-2xl p-4 sm:p-5 relative overflow-hidden",
        accent && "glow-red-soft"
      )}
    >
      {accent && (
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/60 to-transparent" />
      )}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground font-medium truncate">{label}</p>
          <p className="text-2xl sm:text-[28px] font-bold tracking-tight mt-1 tabular-nums">
            {value}
          </p>
          {sub && <p className="text-[11px] text-muted-foreground mt-1 truncate">{sub}</p>}
        </div>
        <div
          className={clsx(
            "h-10 w-10 rounded-xl flex items-center justify-center shrink-0",
            accent ? "bg-brand-gradient glow-red-soft" : "bg-white/6 border border-white/10"
          )}
        >
          <Icon className={clsx("h-5 w-5", accent ? "text-white" : "text-primary")} />
        </div>
      </div>
    </Card>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
}: {
  icon: LucideIcon;
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="glass rounded-2xl p-10 flex flex-col items-center text-center">
      <div className="h-14 w-14 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center">
        <Icon className="h-6 w-6 text-muted-foreground" />
      </div>
      <p className="mt-4 font-medium">{title}</p>
      {hint && (
        <p className="text-sm text-muted-foreground mt-1 max-w-sm leading-relaxed">{hint}</p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function formatDuration(sec: number | null | undefined): string {
  if (!sec || sec <= 0) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}
