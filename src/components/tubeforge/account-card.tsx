"use client";

// The account surface (S23) — the front door for three routes that have been
// standing since Stage 3/4 with nobody knocking:
//   GET  /api/account/usage   — per-capability AI aggregates (T-3.8 named a
//                               dashboard that never existed)
//   GET  /api/account/export  — the GDPR data bundle
//   POST /api/account/delete  — the irreversible one; { confirm: "DELETE" }
// Usage is read-only math. Export is a download. Delete is guarded twice:
// an expand-to-reveal danger zone, then a typed confirmation — a stray
// click can never wipe a studio (the route's own law, now honored by UI).

import { useCallback, useEffect, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  BarChart3,
  Download,
  Loader2,
  Trash2,
  AlertTriangle,
  HardDrive,
  Activity,
} from "lucide-react";
import { clsx } from "clsx";

interface CapabilityRow {
  capability: string;
  calls: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
  avgLatencyMs: number | null;
  maxLatencyMs: number | null;
}

interface UsageResponse {
  window: { days: number };
  totals: { calls: number; costMicroUsd: number; costUsd: number };
  capabilities: CapabilityRow[];
  storage: { driver: string; usedBytes: number; quotaBytes: number };
}

const fmtBytes = (n: number) => {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};

const fmtCost = (usd: number) =>
  usd === 0 ? "$0" : usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;

const fmtLatency = (ms: number | null) =>
  ms == null ? "—" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;

const CAPABILITY_LABEL: Record<string, string> = {
  chat: "Script & direction (LLM)",
  tts: "Voiceover synthesis",
  image: "Art & thumbnails",
  video: "Video generation",
  search: "Web grounding",
  asr: "Caption alignment",
  render: "Render & encode",
};

export function AccountDataCard() {
  const { toast } = useToast();

  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [usageDays, setUsageDays] = useState(30);
  const [usageLoading, setUsageLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  const [dangerOpen, setDangerOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [deleting, setDeleting] = useState(false);

  const loadUsage = useCallback((days: number) => {
    setUsageLoading(true);
    fetch(`/api/account/usage?days=${days}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: UsageResponse) => setUsage(d))
      .catch(() => setUsage(null))
      .finally(() => setUsageLoading(false));
  }, []);

  useEffect(() => {
    loadUsage(usageDays);
  }, [loadUsage, usageDays]);

  const exportData = async () => {
    setExporting(true);
    try {
      const res = await fetch("/api/account/export");
      if (!res.ok) {
        toast({ title: "The export failed — try again", variant: "destructive" });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "tubeforge-export.json";
      a.click();
      URL.revokeObjectURL(url);
      toast({ title: "Your data, packed and downloaded" });
    } finally {
      setExporting(false);
    }
  };

  const deleteAccount = async () => {
    setDeleting(true);
    try {
      const res = await fetch("/api/account/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: confirmText }),
      });
      if (res.status === 400) {
        toast({ title: 'Type DELETE — exactly — to arm the wipe', variant: "destructive" });
        return;
      }
      if (!res.ok) {
        toast({ title: "The deletion failed — nothing was touched", variant: "destructive" });
        return;
      }
      // The route cleared the session cookie: the reload lands on the
      // register door, the studio gone behind us.
      window.location.reload();
    } finally {
      setDeleting(false);
    }
  };

  const st = usage?.storage;
  const storagePct =
    st && st.quotaBytes > 0 ? Math.min(100, (st.usedBytes / st.quotaBytes) * 100) : 0;

  return (
    <Card className="glass rounded-2xl p-5 sm:p-6">
      <div className="flex items-center gap-2.5 mb-1">
        <div className="h-9 w-9 rounded-xl bg-emerald-500/90 flex items-center justify-center shrink-0 shadow-[0_0_18px_rgba(16,185,129,0.25)]">
          <Activity className="h-4.5 w-4.5 text-white" />
        </div>
        <div>
          <h3 className="font-semibold leading-tight">Account &amp; data</h3>
          <p className="text-xs text-muted-foreground">
            What the studio spent, what it holds — and how to take it all back.
          </p>
        </div>
      </div>

      {/* Usage — the aggregates T-3.8 promised a dashboard for */}
      <div className="mt-5 rounded-xl border border-white/6 bg-white/2 p-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
            <BarChart3 className="h-3.5 w-3.5" />
            AI usage
          </p>
          <div className="flex items-center gap-1">
            {[7, 30, 90].map((d) => (
              <button
                key={d}
                onClick={() => setUsageDays(d)}
                className={clsx(
                  "h-7 px-2.5 rounded-lg text-[11px] transition-colors",
                  usageDays === d
                    ? "bg-primary/15 text-primary font-medium"
                    : "text-muted-foreground hover:bg-white/5"
                )}
              >
                {d}d
              </button>
            ))}
          </div>
        </div>

        {usageLoading ? (
          <div className="flex items-center gap-2 py-6 justify-center text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Counting…
          </div>
        ) : !usage ? (
          <p className="text-xs text-muted-foreground py-4">
            The usage service did not answer. It will be here next time.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-3 mt-3">
              <div>
                <p className="text-lg font-semibold leading-none">{usage.totals.calls}</p>
                <p className="text-[11px] text-muted-foreground mt-1">AI calls</p>
              </div>
              <div>
                <p className="text-lg font-semibold leading-none">{fmtCost(usage.totals.costUsd)}</p>
                <p className="text-[11px] text-muted-foreground mt-1">estimated spend</p>
              </div>
              <div>
                <p className="text-lg font-semibold leading-none flex items-center gap-1.5">
                  <HardDrive className="h-4 w-4 text-muted-foreground" />
                  {fmtBytes(st?.usedBytes ?? 0)}
                </p>
                <p className="text-[11px] text-muted-foreground mt-1">
                  of {fmtBytes(st?.quotaBytes ?? 0)} storage
                </p>
              </div>
            </div>

            {st && st.quotaBytes > 0 && (
              <div className="mt-3 h-1.5 rounded-full bg-white/6 overflow-hidden">
                <div
                  className="h-full bg-brand-gradient rounded-full"
                  style={{ width: `${storagePct}%` }}
                />
              </div>
            )}

            {usage.capabilities.length > 0 && (
              <div className="mt-4 space-y-1.5">
                {usage.capabilities.map((c) => (
                  <div
                    key={c.capability}
                    className="flex items-center justify-between gap-3 text-xs py-1.5 border-t border-white/4 first:border-t-0"
                  >
                    <span className="truncate">
                      {CAPABILITY_LABEL[c.capability] ?? c.capability}
                      {c.failures > 0 && (
                        <span className="text-red-300/80 ml-1.5">({c.failures} failed)</span>
                      )}
                    </span>
                    <span className="text-muted-foreground shrink-0 tabular-nums">
                      {c.calls} call{c.calls === 1 ? "" : "s"} · {fmtLatency(c.avgLatencyMs)} avg
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Export — the GDPR bundle */}
      <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-white/6 bg-white/2 p-4">
        <div className="min-w-0">
          <p className="text-sm font-medium">Export your data</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Every row the studio holds about you, as one JSON bundle.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="shrink-0 border-white/10 bg-white/3 hover:bg-white/6"
          onClick={exportData}
          disabled={exporting}
        >
          {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          Download
        </Button>
      </div>

      {/* Danger zone — the irreversible one */}
      <div className="mt-4 rounded-xl border border-red-500/15 bg-red-500/4 p-4">
        {!dangerOpen ? (
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-red-300">Delete this account</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Every video, channel, character and asset — gone for good.
              </p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="shrink-0 text-red-300 hover:text-red-200 hover:bg-red-500/10"
              onClick={() => {
                setDangerOpen(true);
                setConfirmText("");
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-red-200/90 flex items-start gap-1.5 leading-relaxed">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              This wipes the entire studio — uploads included — and signs you
              out at the register door. There is no undo. Type{" "}
              <code className="tf-kbd mx-0.5">DELETE</code> to arm it.
            </p>
            <Input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder='Type "DELETE"'
              aria-label='Type DELETE to confirm account deletion'
              className="h-9 bg-red-500/5 border-red-500/20 text-sm"
            />
            <div className="flex items-center gap-2 justify-end">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDangerOpen(false);
                  setConfirmText("");
                }}
              >
                Keep my studio
              </Button>
              <Button
                size="sm"
                className="bg-red-600 hover:bg-red-500 text-white font-medium"
                disabled={deleting || confirmText !== "DELETE"}
                onClick={deleteAccount}
              >
                {deleting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Delete forever
              </Button>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
