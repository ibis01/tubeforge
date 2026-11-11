"use client";

// S85 — the Video Critic card (video detail dialog → Video tab, after the
// QC scorecard). S84 shipped the API surface (GET/POST /api/videos/[id]/
// critic, job kind "critic"); this is the human surface for it.
//
// What it shows: the persisted critic report — the verdict
// (ship | hold | insufficient-evidence), one row per dimension (technical /
// motion / audio / visual / consistency / narrative, each with its source
// and issues), the repair proposals, and the engine's honesty notes
// (§0.3: unavailable layers are listed, never silently green).
//
// S86 — the one-click repair lane: each hold's proposal fires the
// affordance it names (open the Storyboard / re-run the voiceover /
// re-render) through callbacks into the dialog's EXISTING handlers — the
// card never owns regeneration logic. The human's click is the approval
// (§0.2 propose-never-auto-edit holds: nothing regenerates without it).
//
// What it does NOT do: gate anything. The ship gate stays qc-policy's; the
// critic is a report for the human, not a new automated gate (S84 §0.4).

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  CircleCheck,
  CircleHelp,
  CircleX,
  Ban,
  Drama,
  LayoutGrid,
  Loader2,
  Mic,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { clsx } from "clsx";

/** Mirrors the server's CriticReport (video-critic.ts) — client-safe,
 *  defined locally like DirectorCard's ContinuityReport (never imported
 *  from the server module: that would drag db/storage into the bundle). */
interface CriticDimension {
  id: "technical" | "motion" | "audio" | "visual" | "consistency" | "narrative";
  status: "pass" | "hold" | "unmeasured" | "unavailable";
  source: "qc-battery" | "consistency-report" | "critic-vlm";
  evidence: string[];
  issues: string[];
}
interface CriticProposal {
  dimension: CriticDimension["id"];
  action: string;
}
interface CriticReport {
  schema: 1;
  videoId: string;
  checkedAt: string;
  verdict: "ship" | "hold" | "insufficient-evidence";
  dimensions: CriticDimension[];
  proposals: CriticProposal[];
  engine: { ran: boolean; unavailable: string[] };
}
interface CriticResponse {
  critic: CriticReport | null;
  generating: boolean;
  error: string | null;
}

const DIMENSION_LABELS: Record<CriticDimension["id"], string> = {
  technical: "Technical file health",
  motion: "Motion & pacing",
  audio: "Audio",
  visual: "Visual quality",
  consistency: "Character consistency",
  narrative: "Narrative",
};
const DIMENSION_ORDER: CriticDimension["id"][] = [
  "technical",
  "motion",
  "audio",
  "visual",
  "consistency",
  "narrative",
];
const SOURCE_LABELS: Record<CriticDimension["source"], string> = {
  "qc-battery": "QC battery",
  "consistency-report": "consistency report",
  "critic-vlm": "critic VLM",
};

/** S86 — the one-click repair lane: each hold's proposal gains the button
 *  that fires the EXISTING affordance it names. The card never owns
 *  regeneration — the callbacks come from the dialog's standing handlers
 *  (§0.2: the human's click is the approval; nothing regenerates on its
 *  own). A proposal for an unmeasured dimension asks for evidence, not
 *  repair — no button. */
const REPAIR_ACTIONS: Partial<
  Record<
    CriticDimension["id"],
    {
      label: string;
      icon: typeof Mic;
      kind: "storyboard" | "voiceover" | "render";
      title: string;
    }
  >
> = {
  technical: {
    label: "Re-render",
    icon: RefreshCw,
    kind: "render",
    title:
      "Re-render the final cut with the standing render settings — a fresh QC report lands on completion",
  },
  motion: {
    label: "Open Storyboard",
    icon: LayoutGrid,
    kind: "storyboard",
    title: "The Director card lives there — adjust the shot plan's rhythm, then re-render",
  },
  audio: {
    label: "Re-run voiceover",
    icon: Mic,
    kind: "voiceover",
    title: "Regenerate the voice track (a paid AI call); re-render to match the new timing",
  },
  visual: {
    label: "Open Storyboard",
    icon: LayoutGrid,
    kind: "storyboard",
    title: "Scene re-rolls live there — repaint the offending art",
  },
  consistency: {
    label: "Open Storyboard",
    icon: LayoutGrid,
    kind: "storyboard",
    title: "The Director card's one-click consistency fixes live there",
  },
  narrative: {
    label: "Open Storyboard",
    icon: LayoutGrid,
    kind: "storyboard",
    title: "Regenerate the scenes that miss their beats (scene re-roll)",
  },
};

function statusIcon(status: CriticDimension["status"], className = "h-3.5 w-3.5") {
  switch (status) {
    case "pass":
      return <CircleCheck className={clsx(className, "text-emerald-400")} />;
    case "hold":
      return <CircleX className={clsx(className, "text-amber-400")} />;
    case "unmeasured":
      return <CircleHelp className={clsx(className, "text-zinc-400")} />;
    case "unavailable":
      return <Ban className={clsx(className, "text-zinc-500")} />;
  }
}

const VERDICT_META: Record<
  CriticReport["verdict"],
  { label: string; badge: string; icon: typeof CircleCheck }
> = {
  ship: {
    label: "Worth shipping",
    badge: "border-emerald-500/25 bg-emerald-500/10 text-emerald-200",
    icon: CircleCheck,
  },
  hold: {
    label: "Hold — fix before shipping",
    badge: "border-amber-500/30 bg-amber-500/10 text-amber-200",
    icon: CircleX,
  },
  "insufficient-evidence": {
    label: "Insufficient evidence — nothing measured",
    badge: "border-white/15 bg-white/5 text-zinc-300",
    icon: CircleHelp,
  },
};

export function CriticCard({
  videoId,
  hasVideo,
  disabled,
  onOpenStoryboard,
  onRerunVoiceover,
  onRerender,
}: {
  videoId: string;
  /** The critic judges final.mp4 — no render, nothing to judge. */
  hasVideo: boolean;
  /** Parent busy state (stages that would race the critic's reads); also
   *  gates the repair lane's ACTION buttons (navigation stays free). */
  disabled?: boolean;
  /** S86 repair lane — the dialog's EXISTING affordances, passed down as
   *  callbacks so the card never duplicates regeneration logic. */
  onOpenStoryboard?: () => void;
  onRerunVoiceover?: () => void;
  onRerender?: () => void;
}) {
  const { toast } = useToast();
  const [report, setReport] = useState<CriticReport | null>(null);
  const [loaded, setLoaded] = useState(false); // first GET landed (empty ≠ still-loading)
  const [judging, setJudging] = useState(false); // our POST's poll loop is live
  const [jobError, setJobError] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchCritic = useCallback(async (): Promise<CriticResponse | null> => {
    try {
      const res = await fetch(`/api/videos/${videoId}/critic`, { cache: "no-store" });
      if (!res.ok) return null; // the card stays honest-empty; no invented state
      return (await res.json()) as CriticResponse;
    } catch {
      return null;
    }
  }, [videoId]);

  // On mount (and when the dialog re-targets another video): the stored
  // report + job flags. If a critic job is ALREADY running (e.g. resumed
  // from Mission Control), pick up its trail and poll to the end.
  // Await-first IIFE: the loader's setStates all sit behind their own
  // awaits, and the wrapper makes that async boundary visible to the
  // effect lint (DirectorCard's pattern).
  useEffect(() => {
    let alive = true;
    void (async () => {
      const d = await fetchCritic();
      if (!alive) return;
      setReport(d?.critic ?? null);
      setJobError(d?.error ?? null);
      setLoaded(true);
      if (d?.generating) void pollUntilDone();
    })();
    return () => {
      alive = false;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);

  // Poll the route's own surface until the job stops running (the rerunQc
  // pattern): 2.5s cadence, 6-minute deadline, the server-recorded error
  // surfaces honestly when the job failed.
  const pollUntilDone = useCallback(async () => {
    setJudging(true);
    const deadline = Date.now() + 6 * 60 * 1000;
    try {
      for (;;) {
        await new Promise((r) => {
          pollTimer.current = setTimeout(r, 2500);
        });
        const d = await fetchCritic();
        if (!d) throw new Error("The critic surface stopped responding");
        if (!d.generating) {
          if (d.error) throw new Error(d.error);
          setReport(d.critic);
          setJobError(null);
          toast({
            title: d.critic ? "Critic report ready" : "Critic finished",
            description: d.critic
              ? `Verdict: ${VERDICT_META[d.critic.verdict].label}.`
              : "No report was stored — re-run the critic.",
          });
          break;
        }
        if (Date.now() > deadline)
          throw new Error("The critic is taking unusually long — check back shortly.");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      setJobError(msg);
      toast({ title: "Critic failed", description: msg, variant: "destructive" });
    } finally {
      setJudging(false);
    }
  }, [fetchCritic, toast]);

  const runCritic = async () => {
    if (judging || !hasVideo) return;
    setJudging(true);
    try {
      const res = await fetch(`/api/videos/${videoId}/critic`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as {
        accepted?: boolean;
        error?: string;
      };
      if (!res.ok && res.status !== 202 && res.status !== 200)
        throw new Error(data.error ?? `HTTP ${res.status}`);
      // 202 accepted → poll to the stored report (the loop owns setJudging).
      setJudging(false);
      await pollUntilDone();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      setJobError(msg);
      setJudging(false);
      toast({ title: "Could not run the critic", description: msg, variant: "destructive" });
    }
  };

  if (!loaded && !judging) return null; // first fetch in flight — no flash of empty state

  const busy = judging;
  const v = report ? VERDICT_META[report.verdict] : null;
  const holds = report?.dimensions.filter((d) => d.status === "hold").length ?? 0;

  return (
    <div className="rounded-xl border border-white/10 bg-white/3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground font-medium">
          <Drama className="h-3.5 w-3.5 text-primary shrink-0" />
          Video critic
          {report && (
            <span className="normal-case tracking-normal text-muted-foreground/70">
              {" "}
              · {new Date(report.checkedAt).toLocaleString()}
            </span>
          )}
        </p>
        <div className="flex items-center gap-2">
          {v && (
            <Badge variant="outline" className={clsx("text-[10px]", v.badge)}>
              <v.icon className="h-2.5 w-2.5 mr-1" />
              {report?.verdict === "hold" && holds > 0
                ? `Hold · ${holds} dimension${holds > 1 ? "s" : ""} flagged`
                : v.label}
            </Badge>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-6 text-[10px] px-2 border-white/15 bg-white/4"
            disabled={busy || disabled || !hasVideo || !report}
            onClick={() => void runCritic()}
            title={
              !hasVideo
                ? "Render the video first — the critic judges final.mp4"
                : report
                  ? "Re-run the critic against the standing render and reports"
                  : "Run the critic"
            }
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
            {busy ? "Judging…" : report ? "Re-run critic" : "Run critic"}
          </Button>
        </div>
      </div>

      {/* The report — a verdict for the human, never a new gate (S84 §0.4). */}
      {report ? (
        <>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            Judges the rendered cut as a story: the QC battery (technical / motion /
            audio), the consistency report, and one fail-open VLM pass over sampled
            frames (narrative / visual). Advisory — the ship gate stays the QC policy&apos;s.
          </p>

          {/* Dimension rows — worst news first is NOT reordered: the fixed
              order reads technical → narrative, the pipeline's own order. */}
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {DIMENSION_ORDER.map((id) => {
              const d = report.dimensions.find((x) => x.id === id);
              if (!d) return null; // a dimension the stored report never measured
              return (
                <div
                  key={id}
                  className={clsx(
                    "rounded-lg border p-2.5",
                    d.status === "hold"
                      ? "border-amber-500/25 bg-amber-500/[0.05]"
                      : "border-white/8 bg-white/3"
                  )}
                >
                  <div className="flex items-center gap-2">
                    {statusIcon(d.status)}
                    <p className="text-xs font-semibold flex-1 min-w-0 truncate">
                      {DIMENSION_LABELS[d.id]}
                    </p>
                    <span className="text-[9px] uppercase tracking-wide text-muted-foreground/70 shrink-0">
                      {SOURCE_LABELS[d.source]}
                    </span>
                  </div>
                  {d.issues.length > 0 && (
                    <ul className="mt-1.5 space-y-0.5">
                      {d.issues.slice(0, 3).map((issue, i) => (
                        <li key={i} className="text-[10px] text-foreground/75 leading-snug">
                          {issue}
                        </li>
                      ))}
                      {d.issues.length > 3 && (
                        <li className="text-[10px] text-muted-foreground">
                          +{d.issues.length - 3} more
                        </li>
                      )}
                    </ul>
                  )}
                  {d.evidence.length > 0 && (
                    <p className="mt-1 text-[9px] text-muted-foreground/60 truncate" title={d.evidence.join(" · ")}>
                      {d.evidence.slice(0, 3).join(" · ")}
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          {/* Repair proposals — the one-click lane (S86): each hold's
              proposal fires the affordance it names through the dialog's
              existing handlers. The human's click is the approval (§0.2);
              unmeasured dimensions ask for evidence, not repair. */}
          {report.proposals.length > 0 && (
            <div className="mt-3">
              <p className="text-[11px] font-semibold mb-1.5">
                Proposed repairs{" "}
                <span className="text-muted-foreground font-normal">
                  — one click through the existing tools; nothing regenerates without you
                </span>
              </p>
              <ul className="space-y-1">
                {report.proposals.map((p, i) => {
                  const dim = report.dimensions.find((d) => d.id === p.dimension);
                  const action = dim?.status === "hold" ? REPAIR_ACTIONS[p.dimension] : undefined;
                  const fire =
                    action?.kind === "storyboard"
                      ? onOpenStoryboard
                      : action?.kind === "voiceover"
                        ? onRerunVoiceover
                        : action?.kind === "render"
                          ? onRerender
                          : undefined;
                  return (
                    <li key={i} className="flex items-start gap-2 text-[11px]">
                      <Badge
                        variant="outline"
                        className="text-[9px] h-4 px-1.5 shrink-0 mt-0.5 border-white/15 bg-white/5 text-muted-foreground"
                      >
                        {p.dimension}
                      </Badge>
                      <span className="text-foreground/85 leading-snug flex-1 min-w-0">{p.action}</span>
                      {action && fire && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-5 px-2 text-[10px] shrink-0 border-white/15 bg-white/4"
                          disabled={disabled && action.kind !== "storyboard"}
                          onClick={fire}
                          title={action.title}
                        >
                          <action.icon className="h-2.5 w-2.5" />
                          {action.label}
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {/* Honesty notes (§0.3): layers that could not run, listed —
              never a silent pass, never a silent block. */}
          {report.engine.unavailable.length > 0 && (
            <div className="mt-3">
              <p className="text-[10px] text-muted-foreground/80 font-medium mb-1">
                Not measured (honest gaps — the verdict above accounts for them):
              </p>
              <ul className="space-y-0.5">
                {report.engine.unavailable.slice(0, 4).map((u, i) => (
                  <li key={i} className="text-[10px] text-muted-foreground/70 leading-snug">
                    {u}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      ) : (
        <div className="mt-2">
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            {hasVideo ? (
              <>
                The critic hasn&apos;t judged this cut yet. It reads the standing QC
                battery report and consistency report, samples frames across
                final.mp4, and reports whether the story lands — technical health,
                pacing, audio, visual quality, character consistency, narrative —
                with concrete repair proposals. A report for you, never a new gate.
              </>
            ) : (
              <>Render the video first — the critic judges the rendered final cut.</>
            )}
          </p>
          {hasVideo && (
            <Button
              size="sm"
              className="mt-2.5 bg-brand-gradient hover:opacity-90 text-white font-semibold h-7 text-[11px]"
              disabled={busy || disabled}
              onClick={() => void runCritic()}
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Drama className="h-3 w-3" />}
              {busy ? "Judging…" : "Run the critic"}
            </Button>
          )}
        </div>
      )}

      {/* The job's last recorded error — surfaced, never swallowed. */}
      {jobError && (
        <p className="mt-2 text-[11px] text-red-300 bg-red-500/8 border border-red-500/20 rounded-lg px-3 py-1.5">
          {jobError}
        </p>
      )}
    </div>
  );
}
