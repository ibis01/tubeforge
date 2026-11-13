"use client";

// Scene Trust Panel — S118 (Scene-Level Editing & Repair, Stage 7): the
// operator-facing surface for the trust layer Stages 1–6 built. One panel,
// four feeds, all already-served by the stage routes:
//
//   • REVISIONS  — the immutable chain (GET /scenes/[n]/revisions) with
//                  per-version status chips and rollback-as-new-revision
//                  (POST /scenes/[n]/rollback).
//   • RECHECK    — the scene-scoped QC verdict (GET/POST /scenes/[n]/recheck):
//                  run the battery, read every check + seam verdict, and
//                  APPROVE the head (gated on a passing verdict for the
//                  head's own version — the refusal reason is shown, never
//                  hidden).
//   • SEAMS      — the boundary pairs the scene owns, with the exact render
//                  button when the media is missing (POST /render
//                  {boundaryAfter}).
//   • REPAIRS    — the approval inbox (GET/POST /scenes/[n]/repair): the
//                  VCE/critic proposals and manual repairs, each with the
//                  estimate and the affected-asset list BEFORE approval
//                  (requirement D's middle pieces, visible).
//
// Also: the one-click scene preview (POST /render {sceneIndex}).
//
// The panel is deliberately READ-ONLY about cost: every paid action is an
// explicit button with the estimate shown; nothing auto-chains.

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { clsx } from "clsx";
import {
  BadgeCheck,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  History,
  Loader2,
  ShieldCheck,
  Wrench,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

// ---------- types (the routes' shapes) ----------

interface RevisionRow {
  version: number;
  status: string;
  changeKind: string;
  origin: string;
  note: string | null;
  parentVersion: number | null;
  createdAt: string;
}

interface VerdictCheck {
  id: string;
  label: string;
  status: "pass" | "fail" | "unmeasured";
  value: string;
  detail?: string;
}

interface SeamRow {
  afterScene: number;
  status: "pass" | "fail" | "unmeasured";
  media: "boundary-preview" | "none";
  value: string;
  detail?: string;
}

interface RecheckFeed {
  sceneId: string | null;
  head: { version: number; status: string; changeKind: string; origin: string } | null;
  verdict: {
    revisionVersion: number | null;
    passed: boolean;
    checkedAt: string;
    builtFromPreview: { revisionVersion: number | null; staleness: string } | null;
    checks: VerdictCheck[];
    seams: SeamRow[];
  } | null;
  approval:
    | { ok: false; reason: string; message: string }
    | { ok: true; already: boolean };
  seams: Array<{ afterScene: number; mediaStanding: boolean }>;
}

interface RepairRow {
  id: string;
  status: string;
  origin: string;
  instruction: string;
  estimateMicroUsd: number;
  affectedAssets: { sceneKeys: string[]; videoRenders: boolean };
  sourceVersion: number;
  createdAt: string;
}

const microToUsd = (micro: number) => `$${(micro / 1_000_000).toFixed(4)}`;

const STATUS_CHIP: Record<string, string> = {
  draft: "bg-sky-500/15 text-sky-300 border-sky-400/25",
  previewing: "bg-indigo-500/15 text-indigo-300 border-indigo-400/25",
  needs_repair: "bg-amber-500/15 text-amber-300 border-amber-400/25",
  approved: "bg-emerald-500/15 text-emerald-300 border-emerald-400/25",
  superseded: "bg-zinc-500/15 text-zinc-400 border-zinc-400/25",
};

const CHECK_DOT: Record<string, string> = {
  pass: "text-emerald-400",
  fail: "text-red-400",
  unmeasured: "text-amber-400",
};

export function SceneTrustPanel({
  videoId,
  sceneIndex,
  onUpdated,
}: {
  videoId: string;
  sceneIndex: number;
  onUpdated: () => void;
}) {
  const [feed, setFeed] = useState<RecheckFeed | null>(null);
  const [revisions, setRevisions] = useState<RevisionRow[]>([]);
  const [repairs, setRepairs] = useState<RepairRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [showAllRevisions, setShowAllRevisions] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    const base = `/api/videos/${videoId}/scenes/${sceneIndex}`;
    const [recheckRes, revisionsRes, repairsRes] = await Promise.all([
      fetch(`${base}/recheck`, { cache: "no-store" }).catch(() => null),
      fetch(`${base}/revisions`, { cache: "no-store" }).catch(() => null),
      fetch(`${base}/repair`, { cache: "no-store" }).catch(() => null),
    ]);
    if (recheckRes?.ok) setFeed((await recheckRes.json()) as RecheckFeed);
    if (revisionsRes?.ok) {
      const d = (await revisionsRes.json()) as { revisions?: RevisionRow[] };
      setRevisions(d.revisions ?? []);
    }
    if (repairsRes?.ok) {
      const d = (await repairsRes.json()) as { repairs?: RepairRow[] };
      setRepairs((d.repairs ?? []).filter((r) => r.status === "proposed"));
    }
  }, [videoId, sceneIndex]);

  useEffect(() => {
    // Deferred by 0ms — the codebase's settled pattern for async loads in
    // effects (no synchronous setState cascades; the S118 lint law).
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(
    () => () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    },
    []
  );

  /** Poll the feeds while a job runs (recheck / preview / boundary). */
  const pollWhile = useCallback(
    (ms: number) => {
      let tries = 0;
      const tick = () => {
        tries += 1;
        void load();
        if (tries < 40) pollRef.current = setTimeout(tick, ms);
      };
      pollRef.current = setTimeout(tick, ms);
    },
    [load]
  );

  const post = async (url: string, body: unknown, busyKey: string): Promise<boolean> => {
    setBusy(busyKey);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      const d = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      if (!res.ok) {
        toast.error(d.error ?? "Request failed");
        return false;
      }
      if (d.message) toast.success(d.message);
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Request failed");
      return false;
    } finally {
      setBusy(null);
    }
  };

  const runRecheck = async () => {
    if (await post(`/api/videos/${videoId}/scenes/${sceneIndex}/recheck`, {}, "recheck")) {
      toast.success(`Re-checking scene ${sceneIndex}…`, {
        description: "The battery runs on the standing preview and its seams — the verdict lands on the head revision.",
      });
      pollWhile(3000);
    }
  };

  const approve = async () => {
    if (
      await post(
        `/api/videos/${videoId}/scenes/${sceneIndex}/recheck`,
        { approve: true },
        "approve"
      )
    ) {
      await load();
      onUpdated();
    }
  };

  const rollback = async (toVersion: number) => {
    if (
      await post(
        `/api/videos/${videoId}/scenes/${sceneIndex}/rollback`,
        { toVersion },
        `rollback-${toVersion}`
      )
    ) {
      toast.success(`Rolled back to v${toVersion}'s content`, {
        description: "The restoration landed as a NEW revision — history is never erased.",
      });
      await load();
      onUpdated();
    }
  };

  const renderPreview = async () => {
    if (await post(`/api/videos/${videoId}/render`, { sceneIndex }, "preview")) {
      toast.success(`Rendering scene ${sceneIndex}'s preview…`, {
        description: "Nothing else moves — the full render is untouched.",
      });
      pollWhile(4000);
    }
  };

  const renderBoundary = async (afterScene: number) => {
    if (await post(`/api/videos/${videoId}/render`, { boundaryAfter: afterScene }, `boundary-${afterScene}`)) {
      toast.success(`Rendering the ${afterScene}|${afterScene + 1} seam pair…`, {
        description: "The boundary media for the recheck — the full render is untouched.",
      });
      pollWhile(4000);
    }
  };

  const approveRepair = async (repairId: string) => {
    if (
      await post(
        `/api/videos/${videoId}/scenes/${sceneIndex}/repair`,
        { repairId, approve: true },
        `repair-${repairId}`
      )
    ) {
      toast.success("Repair approved and queued", {
        description: "The estimate was charged against the ceiling before the job ran.",
      });
      pollWhile(4000);
    }
  };

  const rejectRepair = async (repairId: string) => {
    if (
      await post(
        `/api/videos/${videoId}/scenes/${sceneIndex}/repair`,
        { repairId, reject: true },
        `repair-${repairId}`
      )
    ) {
      await load();
    }
  };

  if (!feed) {
    return (
      <div className="flex items-center gap-2 text-xs text-zinc-400">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading the trust layer…
      </div>
    );
  }

  const verdict = feed.verdict;
  const visibleRevisions = showAllRevisions ? revisions : revisions.slice(0, 4);

  return (
    <div className="space-y-4">
      {/* --- head + approve --- */}
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={clsx(
            "rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
            STATUS_CHIP[feed.head?.status ?? "draft"] ?? STATUS_CHIP.draft
          )}
        >
          {feed.head ? `head v${feed.head.version} · ${feed.head.status}` : "no history yet"}
        </span>
        {feed.head?.status === "approved" && (
          <span className="inline-flex items-center gap-1 text-[11px] text-emerald-300">
            <BadgeCheck className="h-3.5 w-3.5" /> approved — the render source is pinned to it
          </span>
        )}
        <span className="ml-auto inline-flex gap-1.5">
          <Button
            size="sm"
            variant="secondary"
            className="h-7 text-[11px]"
            onClick={renderPreview}
            disabled={busy !== null}
          >
            {busy === "preview" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Preview scene
          </Button>
          <Button
            size="sm"
            variant="secondary"
            className="h-7 text-[11px]"
            onClick={runRecheck}
            disabled={busy !== null}
          >
            {busy === "recheck" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
            Re-check
          </Button>
          <Button
            size="sm"
            className="h-7 text-[11px]"
            onClick={approve}
            disabled={busy !== null || !feed.approval.ok || feed.approval.ok === true && "already" in feed.approval && feed.approval.already}
            title={feed.approval.ok ? undefined : feed.approval.message}
          >
            {busy === "approve" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <BadgeCheck className="h-3.5 w-3.5" />}
            Approve
          </Button>
        </span>
      </div>
      {!feed.approval.ok && (
        <p className="text-[11px] leading-relaxed text-amber-300/90">
          {feed.approval.message}
        </p>
      )}

      {/* --- the verdict --- */}
      {verdict && (
        <div className="rounded-lg border border-white/10 bg-black/20 p-3 space-y-2">
          <div className="flex items-center gap-2 text-xs font-medium text-zinc-200">
            <ShieldCheck className="h-3.5 w-3.5 text-primary" />
            Recheck verdict — v{verdict.revisionVersion ?? "?"}
            <span
              className={clsx(
                "ml-auto text-[10px] uppercase tracking-wide",
                verdict.passed ? "text-emerald-300" : "text-amber-300"
              )}
            >
              {verdict.passed ? "passed" : "not clean"}
            </span>
          </div>
          <div className="grid gap-1">
            {verdict.checks.map((c) => (
              <div key={c.id} className="flex items-start gap-1.5 text-[11px] leading-tight">
                {c.status === "pass" ? (
                  <CheckCircle2 className={clsx("mt-0.5 h-3 w-3 shrink-0", CHECK_DOT.pass)} />
                ) : c.status === "fail" ? (
                  <XCircle className={clsx("mt-0.5 h-3 w-3 shrink-0", CHECK_DOT.fail)} />
                ) : (
                  <CircleDashed className={clsx("mt-0.5 h-3 w-3 shrink-0", CHECK_DOT.unmeasured)} />
                )}
                <span className="text-zinc-300">{c.label}</span>
                <span className="ml-auto shrink-0 text-zinc-500">{c.value}</span>
              </div>
            ))}
          </div>
          {verdict.seams.length > 0 && (
            <div className="space-y-1 border-t border-white/5 pt-2">
              {verdict.seams.map((s) => (
                <div key={s.afterScene} className="flex items-center gap-1.5 text-[11px]">
                  <span className="text-zinc-400">
                    seam {s.afterScene}|{s.afterScene + 1}
                  </span>
                  <span
                    className={clsx(
                      "shrink-0",
                      s.status === "pass" ? "text-emerald-300" : s.status === "fail" ? "text-red-300" : "text-amber-300"
                    )}
                  >
                    {s.value}
                  </span>
                  {s.media === "none" && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="ml-auto h-6 px-2 text-[10px]"
                      onClick={() => renderBoundary(s.afterScene)}
                      disabled={busy !== null}
                    >
                      {busy === `boundary-${s.afterScene}` ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : null}
                      Render the pair
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* --- the repair inbox --- */}
      {repairs.length > 0 && (
        <div className="rounded-lg border border-white/10 bg-black/20 p-3 space-y-2">
          <div className="flex items-center gap-2 text-xs font-medium text-zinc-200">
            <Wrench className="h-3.5 w-3.5 text-primary" />
            Repair proposals ({repairs.length})
          </div>
          {repairs.map((r) => (
            <div key={r.id} className="space-y-1 rounded border border-white/5 bg-white/[0.03] p-2">
              <p className="text-[11px] leading-snug text-zinc-200">{r.instruction}</p>
              <p className="text-[10px] text-zinc-500">
                {r.origin} · based on v{r.sourceVersion} · estimate {microToUsd(r.estimateMicroUsd)} ·
                regenerates {r.affectedAssets.sceneKeys.length} asset{r.affectedAssets.sceneKeys.length === 1 ? "" : "s"}
                {r.affectedAssets.videoRenders ? " + the video renders" : ""}
              </p>
              <div className="flex gap-1.5">
                <Button
                  size="sm"
                  className="h-6 px-2 text-[10px]"
                  onClick={() => approveRepair(r.id)}
                  disabled={busy !== null}
                >
                  {busy === `repair-${r.id}` ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                  Approve {microToUsd(r.estimateMicroUsd)}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[10px] text-zinc-400"
                  onClick={() => rejectRepair(r.id)}
                  disabled={busy !== null}
                >
                  Reject
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* --- the revision history --- */}
      {revisions.length > 0 && (
        <div className="rounded-lg border border-white/10 bg-black/20 p-3 space-y-1.5">
          <button
            className="flex w-full items-center gap-2 text-xs font-medium text-zinc-200"
            onClick={() => setShowAllRevisions((v) => !v)}
          >
            <History className="h-3.5 w-3.5 text-primary" />
            History ({revisions.length} revision{revisions.length === 1 ? "" : "s"})
            <ChevronRight
              className={clsx("ml-auto h-3.5 w-3.5 transition-transform", showAllRevisions && "rotate-90")}
            />
          </button>
          {visibleRevisions.map((r) => (
            <div key={r.version} className="flex items-center gap-2 text-[11px]">
              <span className="w-8 shrink-0 font-mono text-zinc-400">v{r.version}</span>
              <span
                className={clsx(
                  "shrink-0 rounded border px-1 py-px text-[9px] uppercase tracking-wide",
                  STATUS_CHIP[r.status] ?? STATUS_CHIP.draft
                )}
              >
                {r.status}
              </span>
              <span className="truncate text-zinc-400">
                {r.changeKind}
                {r.note ? ` · ${r.note}` : ""}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto h-6 shrink-0 px-2 text-[10px] text-zinc-400"
                onClick={() => rollback(r.version)}
                disabled={busy !== null || r.version === feed.head?.version}
                title={
                  r.version === feed.head?.version
                    ? "This is the current head"
                    : "Restore this content as a NEW revision"
                }
              >
                {busy === `rollback-${r.version}` ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : null}
                Restore
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
