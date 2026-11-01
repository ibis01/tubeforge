"use client";

// Stage 5 — the AI Director panel (video detail dialog → Storyboard tab).
// "AI suggests, human approves": the LLM pass proposes a shot plan, the
// human approves / dismisses / re-runs it, and the VLM continuity check
// flags scenes that drifted from the character's identity with one-click
// regeneration (delegated to the existing Scene Studio re-roll path).

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Clapperboard, ShieldCheck, RefreshCw, Check, X, RotateCcw, WandSparkles } from "lucide-react";
import type { DirectorPlan } from "@/lib/tubeforge/director-plan";

interface ContinuityScene {
  sceneIndex: number;
  score: number;
  verdict: "consistent" | "drift" | "off";
  issues: string[];
}
interface ContinuityReport {
  checkedAt: string;
  overall: number;
  scenes: ContinuityScene[];
}
interface DirectorResponse {
  plan: DirectorPlan | null;
  state: "proposed" | "approved" | "dismissed" | null;
  consistency: ContinuityReport | null;
  generating: { plan: boolean; check: boolean };
  error: { plan: string | null; check: string | null };
  videoError: string | null;
}

const POLL_MS = 3000;

function scoreColor(score: number): string {
  if (score >= 80) return "bg-emerald-500";
  if (score >= 55) return "bg-amber-500";
  return "bg-red-500";
}
function verdictBadge(v: ContinuityScene["verdict"]) {
  if (v === "consistent")
    return <Badge className="border-emerald-500/30 bg-emerald-500/15 text-emerald-200" variant="outline">consistent</Badge>;
  if (v === "drift")
    return <Badge className="border-amber-500/30 bg-amber-500/15 text-amber-200" variant="outline">drift</Badge>;
  return <Badge className="border-red-500/30 bg-red-500/15 text-red-200" variant="outline">off</Badge>;
}

export function DirectorCard({
  videoId,
  hasCast,
  onRepaintScene,
  storyGenerating,
}: {
  videoId: string;
  hasCast: boolean;
  onRepaintScene: (sceneIndex: number, instruction?: string) => void;
  storyGenerating: boolean;
}) {
  const { toast } = useToast();
  const [data, setData] = useState<DirectorResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<"plan" | "check" | "approve" | "dismiss" | "reset" | null>(null);
  // Module D constraint loop: which scene's "Fix…" input is open + its text.
  const [fixScene, setFixScene] = useState<number | null>(null);
  const [fixText, setFixText] = useState("");
  const alive = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/videos/${videoId}/director`, { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as DirectorResponse;
      if (alive.current) {
        setData(json);
        setLoaded(true);
      }
    } catch {
      /* transient — next poll retries */
    }
  }, [videoId]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
    };
  }, [load]);

  // Poll while either director job is in flight (T-4.6 pattern).
  const anyGenerating = Boolean(data?.generating.plan || data?.generating.check);
  useEffect(() => {
    if (!anyGenerating || !alive.current) return;
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [anyGenerating, load]);

  const act = async (action: "plan" | "check") => {
    setBusy(action);
    try {
      const res = await fetch(`/api/videos/${videoId}/director`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) {
        toast({ title: json.error ?? "Request failed", variant: "destructive" });
        return;
      }
      toast({
        title: action === "plan" ? "AI Director is watching the dailies…" : "Continuity check started…",
        description: action === "plan" ? "A shot plan will be proposed in a moment" : undefined,
      });
      await load();
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  const gate = async (action: "approve" | "dismiss" | "reset") => {
    setBusy(action);
    try {
      const res = await fetch(`/api/videos/${videoId}/director`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) {
        toast({ title: json.error ?? "Request failed", variant: "destructive" });
        return;
      }
      toast({
        title:
          action === "approve"
            ? "Plan approved — it now steers the visuals"
            : action === "dismiss"
              ? "Plan dismissed"
              : "Director plan cleared",
      });
      await load();
    } finally {
      if (alive.current) setBusy(null);
    }
  };

  if (!loaded)
    return (
      <div className="tf-card flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading director panel…
      </div>
    );
  if (!data) return null;

  const plan = data.plan;
  const generating = data.generating.plan || busy === "plan";
  const checking = data.generating.check || busy === "check";

  return (
    <div className="tf-card p-4 space-y-3" data-testid="director-card">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Clapperboard className="h-4 w-4 text-red-300" />
          <h3 className="text-sm font-semibold">AI Director</h3>
          {data.state === "approved" && (
            <Badge className="border-emerald-500/30 bg-emerald-500/15 text-emerald-200" variant="outline">
              <Check className="mr-1 h-3 w-3" /> directing
            </Badge>
          )}
          {data.state === "proposed" && (
            <Badge className="border-amber-500/30 bg-amber-500/15 text-amber-200" variant="outline">
              awaiting your approval
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {!plan && !generating && (
            <Button size="sm" disabled={storyGenerating} onClick={() => void act("plan")} className="bg-brand-gradient hover:opacity-90 font-medium">
              <Clapperboard className="h-3.5 w-3.5" /> Suggest direction
            </Button>
          )}
          {plan && (
            <Button size="sm" variant="outline" disabled={generating || storyGenerating} onClick={() => void act("plan")}>
              <RefreshCw className={`h-3.5 w-3.5 ${generating ? "animate-spin" : ""}`} /> Re-run pass
            </Button>
          )}
          {generating && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Planning shots…
            </span>
          )}
          {hasCast && (
            <Button size="sm" variant="outline" disabled={checking || generating} onClick={() => void act("check")}>
              <ShieldCheck className={`h-3.5 w-3.5 ${checking ? "animate-pulse" : ""}`} />
              {checking ? "Checking…" : "Check continuity"}
            </Button>
          )}
        </div>
      </div>

      {data.error.plan && (
        <p className="text-xs text-red-300">{data.error.plan}</p>
      )}

      {plan && (
        <div className="space-y-2">
          {plan.concept && <p className="text-xs text-muted-foreground italic">{plan.concept}</p>}
          {(plan.musicMood || plan.ducking) && (
            <p className="text-[11px] text-muted-foreground">
              <span className="text-white/60">Audio direction:</span>{" "}
              {plan.musicMood ? <>music <span className="text-emerald-300">{plan.musicMood}</span>{" · "}</> : null}
              {plan.ducking ? <>ducking <span className="text-emerald-300">{plan.ducking}</span>{" · "}</> : null}
              applies to the next voiceover + render (manual per-video overrides still win)
            </p>
          )}
          <div className="flex flex-wrap gap-1.5">
            {plan.scenes.map((s) => {
              const secs = s.shots.reduce((a, sh) => a + sh.duration, 0);
              return (
                <span
                  key={s.sceneIndex}
                  className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/4 px-2 py-0.5 text-[11px] text-white/70"
                  title={`${s.shots.length} shot(s) · ${s.mood || "no mood"}${s.transitionIn ? ` · in: ${s.transitionIn}` : ""}${
                    s.needsI2V ? " · director suggests animating this scene (i2v)" : ""
                  }${s.useStock ? " · director suggests real-world stock footage" : ""}${
                    s.motion !== "smart" ? ` · motion: ${s.motion}` : ""
                  }${s.pacing !== "normal" ? ` · narration: ${s.pacing}` : ""}${
                    s.ambience !== "none" ? ` · ambience: ${s.ambience}` : ""
                  }${s.sfx !== "none" ? ` · cue: ${s.sfx}` : ""}`}
                >
                  <span className="tf-num text-white/90">S{s.sceneIndex}</span>
                  <span className="text-white/40">·</span>
                  <span className="tf-num">{s.shots.length} shots</span>
                  <span className="text-white/40">·</span>
                  <span className="tf-num">{secs.toFixed(1)}s</span>
                  {s.transitionIn && <span className="ml-0.5 text-white/40">({s.transitionIn})</span>}
                  {s.needsI2V && (
                    <span className="ml-0.5 rounded bg-violet-500/15 px-1 text-[10px] text-violet-200">i2v</span>
                  )}
                  {s.useStock && (
                    <span className="rounded bg-sky-500/15 px-1 text-[10px] text-sky-200">stock</span>
                  )}
                  {s.motion !== "smart" && (
                    <span className="rounded bg-white/8 px-1 text-[10px] text-white/55">{s.motion}</span>
                  )}
                  {s.pacing !== "normal" && (
                    <span className="rounded bg-amber-500/15 px-1 text-[10px] text-amber-200">↷{s.pacing}</span>
                  )}
                  {s.ambience !== "none" && (
                    <span className="rounded bg-teal-500/15 px-1 text-[10px] text-teal-200">♫{s.ambience}</span>
                  )}
                  {s.sfx !== "none" && (
                    <span className="rounded bg-fuchsia-500/15 px-1 text-[10px] text-fuchsia-200">{s.sfx}</span>
                  )}
                </span>
              );
            })}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {data.state !== "approved" && (
              <Button size="sm" disabled={busy !== null} onClick={() => void gate("approve")}>
                <Check className="h-3.5 w-3.5" /> Approve & apply
              </Button>
            )}
            {data.state === "proposed" && (
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void gate("dismiss")}>
                <X className="h-3.5 w-3.5" /> Dismiss
              </Button>
            )}
            {data.state === "approved" && (
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void gate("reset")}>
                <RotateCcw className="h-3.5 w-3.5" /> Stop directing
              </Button>
            )}
            {data.state === "dismissed" && (
              <span className="text-xs text-muted-foreground">Dismissed — the plan is inert until approved.</span>
            )}
          </div>
        </div>
      )}

      {data.consistency && (
        <div className="space-y-2 border-t border-white/8 pt-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <p className="text-xs text-muted-foreground">
              Continuity — overall{" "}
              <span className={`tf-num font-semibold ${data.consistency.overall >= 80 ? "text-emerald-300" : data.consistency.overall >= 55 ? "text-amber-300" : "text-red-300"}`}>
                {data.consistency.overall}%
              </span>{" "}
              across {data.consistency.scenes.length} scene(s)
            </p>
          </div>
          <div className="space-y-1.5">
            {data.consistency.scenes.map((c) => (
              <div key={c.sceneIndex} className="space-y-1">
                <div className="flex items-center gap-2 text-[11px]">
                  <span className="tf-num w-8 text-white/70">S{c.sceneIndex}</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/8">
                    <div className={`h-full ${scoreColor(c.score)}`} style={{ width: `${c.score}%` }} />
                  </div>
                  <span className="tf-num w-8 text-right text-white/70">{c.score}</span>
                  {verdictBadge(c.verdict)}
                  {c.verdict !== "consistent" && (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-[11px]"
                        disabled={storyGenerating}
                        onClick={() => onRepaintScene(c.sceneIndex)}
                      >
                        <RefreshCw className="mr-1 h-3 w-3" /> Repaint
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-[11px]"
                        disabled={storyGenerating}
                        onClick={() => {
                          setFixScene(fixScene === c.sceneIndex ? null : c.sceneIndex);
                          // Pre-fill with the VLM's own diagnosis — the human
                          // edits it into the constraint they want applied.
                          setFixText(c.issues[0] ?? "");
                        }}
                      >
                        <WandSparkles className="mr-1 h-3 w-3" /> Fix…
                      </Button>
                    </>
                  )}
                </div>
                {fixScene === c.sceneIndex && (
                  <div className="flex items-center gap-1.5 pl-10">
                    <Input
                      value={fixText}
                      onChange={(e) => setFixText(e.target.value)}
                      placeholder={`e.g. repaint scene ${c.sceneIndex} with the reference outfit and hair`}
                      className="h-7 text-[11px]"
                      maxLength={500}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && fixText.trim()) {
                          onRepaintScene(c.sceneIndex, fixText.trim());
                          setFixScene(null);
                        }
                        if (e.key === "Escape") setFixScene(null);
                      }}
                    />
                    <Button
                      size="sm"
                      className="h-7 px-2 text-[11px]"
                      disabled={!fixText.trim() || storyGenerating}
                      onClick={() => {
                        onRepaintScene(c.sceneIndex, fixText.trim());
                        setFixScene(null);
                      }}
                    >
                      Apply
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
          {data.consistency.scenes.some((c) => c.issues.length > 0) && (
            <ul className="space-y-0.5">
              {data.consistency.scenes
                .filter((c) => c.issues.length > 0)
                .flatMap((c) =>
                  c.issues.slice(0, 2).map((issue, i) => (
                    <li key={`${c.sceneIndex}-${i}`} className="text-[11px] text-muted-foreground">
                      <span className="tf-num text-white/60">S{c.sceneIndex}</span> — {issue}
                    </li>
                  ))
                )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
