"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAppStore } from "@/lib/store";
import { useToast } from "@/hooks/use-toast";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  EmptyState,
  timeAgo,
} from "@/components/tubeforge/shared";
import {
  NICHES,
  type ResearchSessionDTO,
  type ResearchIdea,
  type ResearchSource,
} from "@/lib/tubeforge/types";
import {
  Radar,
  Wand2,
  Loader2,
  Trash2,
  Flame,
  TrendingUp,
  Search,
  Clock,
  Gauge,
  ChevronRight,
  KeyRound,
  Lightbulb,
  Clapperboard,
  Zap,
  BarChart3,
} from "lucide-react";
import { clsx } from "clsx";

const EXAMPLE_QUERIES = [
  "morning routines",
  "money psychology",
  "ancient mysteries",
  "space discoveries",
];

function scoreColor(score: number): string {
  if (score >= 80) return "text-emerald-300";
  if (score >= 60) return "text-amber-300";
  return "text-zinc-300";
}

function scoreBg(score: number): string {
  if (score >= 80) return "bg-emerald-500/15 border-emerald-500/30";
  if (score >= 60) return "bg-amber-500/15 border-amber-500/30";
  return "bg-white/5 border-white/15";
}

function competitionStyle(level: string): string {
  const l = level.toLowerCase();
  if (l.includes("low")) return "text-emerald-300 bg-emerald-500/10 border-emerald-500/25";
  if (l.includes("high")) return "text-red-300 bg-red-500/10 border-red-500/25";
  return "text-amber-300 bg-amber-500/10 border-amber-500/25";
}

function volumeStyle(level: string): string {
  const l = level.toLowerCase();
  if (l.includes("very high")) return "text-emerald-300 bg-emerald-500/10 border-emerald-500/25";
  if (l.includes("high")) return "text-sky-300 bg-sky-500/10 border-sky-500/25";
  if (l.includes("low")) return "text-zinc-400 bg-zinc-500/10 border-zinc-500/25";
  return "text-amber-300 bg-amber-500/10 border-amber-500/25";
}

/** Competition bucket — the same substring logic the badge styles use. */
function compClass(level: string): "low" | "medium" | "high" {
  const l = level.toLowerCase();
  if (l.includes("low")) return "low";
  if (l.includes("high")) return "high";
  return "medium";
}

/** Search-volume rank for sorting (very high > high > medium > low). */
function volumeRank(level: string): number {
  const l = level.toLowerCase();
  if (l.includes("very high")) return 4;
  if (l.includes("high")) return 3;
  if (l.includes("low")) return 1;
  return 2;
}

/** Production-length rank: short → medium → long. */
function lengthRank(id: string): number {
  if (id === "short") return 0;
  if (id === "long") return 2;
  return 1;
}

function IdeaCard({
  idea,
  sessionId,
  busyId,
  onCreate,
  onGreenlight,
}: {
  idea: ResearchIdea;
  sessionId: string;
  busyId: string | null;
  onCreate: (title: string, sources?: ResearchSource[]) => void;
  onGreenlight: (idea: ResearchIdea) => void;
}) {
  const lengthLabel =
    idea.suggestedLength === "short"
      ? "Short"
      : idea.suggestedLength === "long"
        ? "Long-form"
        : "Medium";

  return (
    <Card className="glass border-white/8 rounded-2xl p-4 sm:p-5 flex flex-col gap-3 transition-transform duration-200 hover:scale-[1.01]">
      <div className="flex items-start justify-between gap-3">
        <h3 className="font-semibold leading-snug text-[15px] flex-1 min-w-0">
          {idea.title}
        </h3>
        <div
          className={clsx(
            "shrink-0 rounded-xl border px-2.5 py-1.5 text-center",
            scoreBg(idea.viralScore)
          )}
          title="Viral potential score"
        >
          <p className={clsx("text-base font-bold leading-none tabular-nums", scoreColor(idea.viralScore))}>
            {idea.viralScore}
          </p>
          <p className="text-[9px] uppercase tracking-wider text-muted-foreground mt-0.5">
            viral
          </p>
        </div>
      </div>

      <p className="text-sm text-muted-foreground leading-relaxed">{idea.angle}</p>

      <div className="flex flex-wrap gap-1.5">
        <Badge variant="outline" className={clsx("text-[11px] border font-normal", competitionStyle(idea.competition))}>
          <Gauge className="h-3 w-3 mr-1" />
          {idea.competition} competition
        </Badge>
        <Badge variant="outline" className={clsx("text-[11px] border font-normal", volumeStyle(idea.searchVolume))}>
          <TrendingUp className="h-3 w-3 mr-1" />
          {idea.searchVolume} volume
        </Badge>
        <Badge variant="outline" className="text-[11px] border font-normal text-zinc-300 bg-white/5 border-white/15">
          <Clock className="h-3 w-3 mr-1" />
          {lengthLabel}
        </Badge>
        {idea.perfBoost != null && idea.perfBoost !== 0 && (
          <Badge
            variant="outline"
            className={clsx(
              "text-[11px] border font-normal",
              idea.perfBoost > 0
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                : "border-amber-500/30 bg-amber-500/10 text-amber-200"
            )}
            title={idea.boostReason}
          >
            <Zap className="h-3 w-3 mr-1" />
            {idea.perfBoost > 0 ? "+" : ""}
            {idea.perfBoost} performance
          </Badge>
        )}
      </div>

      {idea.keywords.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {idea.keywords.slice(0, 6).map((k) => (
            <Badge key={k} variant="secondary" className="text-[11px] bg-white/6 text-muted-foreground border border-white/8 font-normal">
              <KeyRound className="h-2.5 w-2.5 mr-1" />
              {k}
            </Badge>
          ))}
        </div>
      )}

      <p className="text-xs text-foreground/70 italic leading-relaxed border-l-2 border-primary/40 pl-2.5">
        <Lightbulb className="inline h-3 w-3 mr-1 text-primary/80 -mt-0.5" />
        {idea.why}
      </p>

      <div className="mt-auto pt-1 space-y-2">
        <Button
          size="sm"
          disabled={Boolean(busyId)}
          onClick={() => onGreenlight(idea)}
          className="w-full bg-brand-gradient hover:opacity-90 text-white font-medium"
          title="One-click: weave this idea's angle + keywords into a scene-based story script"
        >
          {busyId === idea.id ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Writing scene story…
            </>
          ) : (
            <>
              <Clapperboard className="h-3.5 w-3.5" />
              Greenlight as scene story
            </>
          )}
        </Button>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={Boolean(busyId)}
            onClick={() => onCreate(idea.title, idea.sources)}
            className="flex-1 border-white/15 bg-white/4 hover:bg-white/8 text-muted-foreground font-normal"
            title="Send the topic to Create and configure it yourself"
          >
            <Wand2 className="h-3.5 w-3.5" />
            Classic script
            <ChevronRight className="h-3.5 w-3.5 ml-0.5" />
          </Button>
        </div>
        <p className="text-[10px] text-muted-foreground/70 text-center leading-snug">
          Greenlight weaves this idea's angle &amp; SEO keywords straight into a
          {idea.suggestedLength === "long" ? " long-form" : idea.suggestedLength === "short" ? " short" : ""} scene outline — then Auto-Pilot takes over.
        </p>
      </div>
    </Card>
  );
}

function IdeaSkeleton() {
  return (
    <Card className="glass border-white/8 rounded-2xl p-5 space-y-3">
      <div className="flex justify-between gap-3">
        <Skeleton className="h-5 w-3/4" />
        <Skeleton className="h-12 w-12 rounded-xl" />
      </div>
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-2/3" />
      <div className="flex gap-2">
        <Skeleton className="h-5 w-20 rounded-full" />
        <Skeleton className="h-5 w-24 rounded-full" />
      </div>
      <Skeleton className="h-8 w-full rounded-lg" />
    </Card>
  );
}

/** Cross-scan aggregates for the left rail (T-4.8): ideas per niche, average
 *  viral score and recurring keywords. Counts EVERY loaded session — the
 *  recent-scans list is capped at 8 for legibility, the pulse is not. */
function NichePulse({ sessions }: { sessions: ResearchSessionDTO[] }) {
  const stats = useMemo(() => {
    const byNiche = new Map<string, { ideas: number; scoreSum: number }>();
    const keywordCount = new Map<string, number>();
    for (const s of sessions) {
      const cur = byNiche.get(s.niche) ?? { ideas: 0, scoreSum: 0 };
      cur.ideas += s.ideas.length;
      cur.scoreSum += s.ideas.reduce((acc, i) => acc + i.viralScore, 0);
      byNiche.set(s.niche, cur);
      // Count a keyword once per SCAN (not once per idea) so one keyword-stuffed
      // session can't dominate the panel.
      const seen = new Set<string>();
      for (const i of s.ideas) {
        for (const k of i.keywords) {
          const key = k.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          keywordCount.set(key, (keywordCount.get(key) ?? 0) + 1);
        }
      }
    }
    const niches = [...byNiche.entries()]
      .map(([niche, v]) => ({
        niche,
        ideas: v.ideas,
        avg: v.ideas ? Math.round(v.scoreSum / v.ideas) : 0,
      }))
      .sort((a, b) => b.avg - a.avg || b.ideas - a.ideas);
    const topKeywords = [...keywordCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([k, n]) => ({ k, n }));
    const totalIdeas = niches.reduce((sum, n) => sum + n.ideas, 0);
    return { niches: niches.slice(0, 5), topKeywords, totalIdeas, nicheCount: niches.length };
  }, [sessions]);

  if (sessions.length === 0) return null;
  const maxAvg = Math.max(1, ...stats.niches.map((n) => n.avg));

  return (
    <Card className="glass border-white/8 rounded-2xl p-5">
      <div className="flex items-center gap-2 mb-1">
        <BarChart3 className="h-4 w-4 text-primary" />
        <p className="font-semibold text-sm">Niche pulse</p>
      </div>
      <p className="text-[11px] text-muted-foreground mb-3">
        {stats.nicheCount} {stats.nicheCount === 1 ? "niche" : "niches"} ·{" "}
        {stats.totalIdeas} ideas across your last {sessions.length}{" "}
        {sessions.length === 1 ? "scan" : "scans"}
      </p>
      <div className="space-y-2">
        {stats.niches.map((n) => (
          <div key={n.niche}>
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-xs font-medium truncate">{n.niche}</p>
              <p className="text-[10px] text-muted-foreground tabular-nums shrink-0">
                {n.ideas} {n.ideas === 1 ? "idea" : "ideas"} · avg {n.avg}
              </p>
            </div>
            <div
              className="h-1.5 rounded-full bg-white/6 mt-1 overflow-hidden"
              role="meter"
              aria-valuenow={n.avg}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`${n.niche}: average viral score ${n.avg} of 100`}
        >
              <div
                className="h-full rounded-full bg-brand-gradient"
                style={{ width: `${Math.max(6, (n.avg / maxAvg) * 100)}%` }}
              />
            </div>
          </div>
        ))}
      </div>
      {stats.topKeywords.length > 0 && (
        <div className="mt-4">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-2">
            Recurring keywords
          </p>
          <div className="flex flex-wrap gap-1.5">
            {stats.topKeywords.map(({ k, n }) => (
              <Badge
                key={k}
                variant="outline"
                className="border-primary/25 bg-primary/10 text-red-200 text-[10px]"
                title={`Appears in ${n} of ${sessions.length} scans`}
              >
                <KeyRound className="h-2.5 w-2.5 mr-1" />
                {k}
                <span className="text-muted-foreground ml-1">×{n}</span>
              </Badge>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

export function ResearchView() {
  const { toast } = useToast();
  const setView = useAppStore((s) => s.setView);
  const setPrefillTopic = useAppStore((s) => s.setPrefillTopic);
  const setPrefillSources = useAppStore((s) => s.setPrefillSources);
  const setFocusVideoId = useAppStore((s) => s.setFocusVideoId);
  const bumpRefresh = useAppStore((s) => s.bumpRefresh);

  const [niche, setNiche] = useState<string>("Motivation");
  const [query, setQuery] = useState("");
  const [scanning, setScanning] = useState(false);
  const [sessions, setSessions] = useState<ResearchSessionDTO[]>([]);
  const [active, setActive] = useState<ResearchSessionDTO | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [greenlightId, setGreenlightId] = useState<string | null>(null);
  const [ideaSort, setIdeaSort] = useState<"viral" | "volume" | "length">("viral");
  const [compFilter, setCompFilter] = useState<"all" | "low" | "medium" | "high">("all");

  const loadSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/research?limit=25");
      const data = await res.json();
      if (res.ok) {
        setSessions(data.sessions ?? []);
        if (!active && data.sessions?.length > 0) {
          setActive(data.sessions[0]);
        }
      }
    } catch {
      // silent — first paint shows empty state
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const runScan = async () => {
    if (scanning) return;
    setScanning(true);
    try {
      const res = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ niche, query: query.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Scan failed");

      // Stage 1 (T-1.10): the scan now runs as a background job — 202 with
      // the empty shell session. Poll GET /api/research/[id] until the
      // job clears, then adopt the finished session (or its error).
      let session = data.session;
      if (data.generating) {
        setActive(session);
        const deadline = Date.now() + 5 * 60 * 1000;
        for (;;) {
          await new Promise((r) => setTimeout(r, 2500));
          if (Date.now() > deadline)
            throw new Error("Scan is taking unusually long — check back shortly.");
          const poll = await fetch(`/api/research/${session.id}`, { cache: "no-store" });
          const pd = await poll.json();
          if (!poll.ok) throw new Error(pd.error ?? "Scan failed");
          if (!pd.generating) {
            session = pd.session;
            if (session.error) throw new Error(session.error);
            if (!session.ideas?.length)
              throw new Error("Scan finished without ideas — try again.");
            break;
          }
        }
      }

      setActive(session);
      setSessions((prev) => [session, ...prev.filter((s) => s.id !== session.id)].slice(0, 25));
      toast({
        title: "Topic Radar finished",
        description: `${session.ideas.length} video ideas found for ${niche}.`,
      });
      bumpRefresh();
    } catch (e) {
      toast({
        title: "Scan failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setScanning(false);
    }
  };

  const deleteSession = async (id: string) => {
    try {
      const res = await fetch(`/api/research/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      setSessions((prev) => prev.filter((s) => s.id !== id));
      if (active?.id === id) setActive(null);
      toast({ title: "Scan deleted" });
    } catch (e) {
      toast({
        title: "Delete failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    }
  };

  const sendToCreate = (topic: string, sources?: ResearchSource[]) => {
    setPrefillTopic(topic);
    setPrefillSources(sources?.length ? sources : null);
    setView("create");
  };

  // Phase 4 — one click from radar idea to a scripted scene story.
  const greenlightIdea = async (idea: ResearchIdea) => {
    if (!active || greenlightId) return;
    setGreenlightId(idea.id);
    try {
      const res = await fetch(`/api/research/${active.id}/greenlight`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ideaId: idea.id, format: "story" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Greenlight failed");
      bumpRefresh();
      // Stage 1 (T-1.10): greenlight returns 202 — the script writes in a
      // background job and the library's detail dialog adopts the in-flight
      // generation (same UX as a script re-roll).
      toast({
        title: "Scene story greenlit",
        description: `"${data.video.title ?? idea.title}" is writing its script in the background — open it to follow progress.`,
      });
      setFocusVideoId(data.video.id); // library opens the detail dialog
      setView("library");
    } catch (e) {
      toast({
        title: "Greenlight failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setGreenlightId(null);
    }
  };

  // Sorted + competition-filtered view of the active session's ideas (T-4.8).
  const ideas = useMemo(() => {
    if (!active) return [];
    const filtered = active.ideas.filter(
      (i) => compFilter === "all" || compClass(i.competition) === compFilter
    );
    return [...filtered].sort((a, b) => {
      if (ideaSort === "volume")
        return volumeRank(b.searchVolume) - volumeRank(a.searchVolume) || b.viralScore - a.viralScore;
      if (ideaSort === "length")
        return lengthRank(a.suggestedLength) - lengthRank(b.suggestedLength) || b.viralScore - a.viralScore;
      return b.viralScore - a.viralScore;
    });
  }, [active, ideaSort, compFilter]);

  // Session-level insights for the header chips.
  const insights = useMemo(() => {
    if (!active?.ideas.length) return null;
    const all = active.ideas;
    const best = all.reduce((m, i) => (i.viralScore > m.viralScore ? i : m), all[0]);
    const avg = Math.round(all.reduce((s, i) => s + i.viralScore, 0) / all.length);
    const split = { low: 0, medium: 0, high: 0 };
    for (const i of all) split[compClass(i.competition)]++;
    return { best, avg, split };
  }, [active]);

  return (
    <div className="flex flex-col lg:flex-row gap-6">
      {/* Scan panel */}
      <div className="lg:w-80 shrink-0 space-y-6">
        <Card className="glass border-white/8 rounded-2xl p-5">
          <div className="flex items-center gap-2 mb-4">
            <div className="h-8 w-8 rounded-lg bg-brand-gradient flex items-center justify-center shrink-0 glow-red-soft">
              <Radar className="h-4 w-4 text-white" />
            </div>
            <div>
              <p className="font-semibold text-sm">Scan a niche</p>
              <p className="text-[11px] text-muted-foreground">
                GLM mines trending, low-competition topics
              </p>
            </div>
          </div>

          <Label className="text-xs text-muted-foreground">Niche</Label>
          <Select value={niche} onValueChange={setNiche}>
            <SelectTrigger className="mt-1.5 mb-4 bg-white/4 border-white/12">
              <SelectValue placeholder="Pick a niche" />
            </SelectTrigger>
            <SelectContent className="bg-popover border-white/10">
              {NICHES.map((n) => (
                <SelectItem key={n} value={n}>
                  {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Label className="text-xs text-muted-foreground">
            Focus (optional)
          </Label>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. morning routines"
            className="mt-1.5 bg-white/4 border-white/12"
            onKeyDown={(e) => e.key === "Enter" && runScan()}
          />

          <div className="flex flex-wrap gap-1.5 mt-2.5">
            {EXAMPLE_QUERIES.map((q) => (
              <button
                key={q}
                onClick={() => setQuery(q)}
                className="text-[11px] text-muted-foreground hover:text-foreground bg-white/4 hover:bg-white/8 border border-white/10 rounded-full px-2.5 py-1 transition-colors"
              >
                {q}
              </button>
            ))}
          </div>

          <Button
            onClick={runScan}
            disabled={scanning}
            className="mt-5 w-full bg-brand-gradient hover:opacity-90 text-white font-semibold"
          >
            {scanning ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Scanning {niche}…
              </>
            ) : (
              <>
                <Radar className="h-4 w-4" />
                Run Topic Radar
              </>
            )}
          </Button>
        </Card>

        {/* Recent scans */}
        {sessions.length > 0 && (
          <div>
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium mb-2.5 px-1">
              Recent scans
            </p>
            <div className="space-y-2">
              {sessions.slice(0, 8).map((s) => (
                <div
                  key={s.id}
                  className={clsx(
                    "group rounded-xl border px-3.5 py-3 transition-colors cursor-pointer",
                    active?.id === s.id
                      ? "bg-primary/10 border-primary/30"
                      : "bg-white/3 border-white/8 hover:bg-white/6"
                  )}
                  onClick={() => setActive(s)}
                >
                  <div className="flex items-center gap-2">
                    <Search className="h-3.5 w-3.5 text-primary shrink-0" />
                    <p className="text-sm font-medium truncate flex-1 min-w-0">
                      {s.query !== "—" ? s.query : s.niche}
                    </p>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteSession(s.id);
                      }}
                      className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-300 transition-all shrink-0"
                      aria-label="Delete scan"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    {s.niche} · {s.ideas.length} ideas · {timeAgo(s.createdAt)}
                  </p>
                </div>
              ))}
            </div>
            {sessions.length > 8 && (
              <p className="text-[11px] text-muted-foreground/70 px-1 mt-2">
                +{sessions.length - 8} older {sessions.length - 8 === 1 ? "scan" : "scans"} —
                the pulse below counts all of them
              </p>
            )}
          </div>
        )}

        {/* Cross-scan niche pulse (T-4.8) */}
        <NichePulse sessions={sessions} />
      </div>

      {/* Results */}
      <div className="flex-1 min-w-0">
        {scanning ? (
          <div>
            <div className="glass rounded-2xl p-5 mb-5 flex items-center gap-3">
              <Radar className="h-5 w-5 text-primary animate-spin" />
              <div>
                <p className="text-sm font-medium">
                  Scanning the {niche} niche…
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Analyzing search demand, competition and viral hooks — this takes
                  10–20 seconds.
                </p>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {[0, 1, 2, 3].map((i) => (
                <IdeaSkeleton key={i} />
              ))}
            </div>
          </div>
        ) : active && active.ideas.length > 0 ? (
          <div>
            <Card className="glass border-white/8 rounded-2xl p-5 mb-5">
              <div className="flex items-start gap-3">
                <Flame className="h-5 w-5 text-primary shrink-0 mt-0.5" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold">
                    Niche analysis · {active.niche}
                    {active.query !== "—" ? ` · “${active.query}”` : ""}
                  </p>
                  <p className="text-sm text-muted-foreground leading-relaxed mt-1">
                    {active.nicheSummary}
                  </p>
                  {insights && (
                    <div className="flex flex-wrap gap-1.5 mt-2.5">
                      <Badge
                        variant="outline"
                        className="border-emerald-500/30 bg-emerald-500/10 text-emerald-200 text-[11px] max-w-[260px]"
                        title={`Top idea: ${insights.best.title}`}
                      >
                        <Zap className="h-3 w-3 mr-1 shrink-0" />
                        Best {insights.best.viralScore} ·“{" "}
                        {insights.best.title.length > 26
                          ? `${insights.best.title.slice(0, 26)}…`
                          : insights.best.title}
                        ”
                      </Badge>
                      <Badge variant="outline" className="border-white/15 bg-white/5 text-zinc-300 text-[11px]">
                        Avg {insights.avg}
                      </Badge>
                      <Badge
                        variant="outline"
                        className="border-white/15 bg-white/5 text-zinc-300 text-[11px]"
                        title="Ideas by competition level"
                      >
                        {insights.split.low} low · {insights.split.medium} med · {insights.split.high} high
                      </Badge>
                    </div>
                  )}
                  <p className="text-[11px] text-muted-foreground mt-2">
                    {active.ideas.length} ideas · scanned {timeAgo(active.createdAt)} · pick one and send it straight to the Auto-Pilot
                  </p>
                  {/* Idea toolbar (T-4.8) — sort + competition filter */}
                  <div className="flex flex-wrap items-center gap-2 mt-3.5">
                    <Select value={ideaSort} onValueChange={(v) => setIdeaSort(v as typeof ideaSort)}>
                      <SelectTrigger
                        className="h-8 w-[150px] bg-white/4 border-white/12 text-xs"
                        aria-label="Sort ideas"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="bg-popover border-white/10">
                        <SelectItem value="viral">Viral score</SelectItem>
                        <SelectItem value="volume">Search volume</SelectItem>
                        <SelectItem value="length">Length</SelectItem>
                      </SelectContent>
                    </Select>
                    <div className="flex gap-1.5" role="group" aria-label="Filter by competition">
                      {(["all", "low", "medium", "high"] as const).map((c) => {
                        const count = c === "all" ? active.ideas.length : insights?.split[c] ?? 0;
                        return (
                          <button
                            key={c}
                            type="button"
                            onClick={() => setCompFilter(c)}
                            aria-pressed={compFilter === c}
                            className={clsx(
                              "rounded-full border px-2.5 py-1 text-[11px] transition-all",
                              compFilter === c
                                ? "border-primary/50 bg-primary/15 text-red-200"
                                : "border-white/10 bg-white/4 text-muted-foreground hover:border-white/25"
                            )}
                          >
                            {c === "all" ? "All" : c === "medium" ? "Med" : c === "low" ? "Low" : "High"}
                            <span className="tabular-nums opacity-70 ml-1">{count}</span>
                          </button>
                        );
                      })}
                    </div>
                    <span className="ml-auto text-[11px] text-muted-foreground/80 tabular-nums">
                      {ideas.length}/{active.ideas.length} shown
                    </span>
                  </div>
                </div>
              </div>
            </Card>

            {ideas.length === 0 ? (
              <p className="glass rounded-2xl border border-white/8 p-6 text-center text-sm text-muted-foreground">
                No ideas at this competition level — switch the filter to All to see every{" "}
                {active.ideas.length}.
              </p>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                {ideas.map((idea) => (
                  <IdeaCard
                    key={idea.id}
                    idea={idea}
                    sessionId={active.id}
                    busyId={greenlightId}
                    onCreate={(title, sources) => sendToCreate(title, sources)}
                    onGreenlight={greenlightIdea}
                  />
                ))}
              </div>
            )}
          </div>
        ) : loaded ? (
          <EmptyState
            icon={Radar}
            title="No scans yet"
            hint="Point the radar at a niche and let GLM surface high-potential topics with search volume, competition and viral scores — then send any idea straight to the Auto-Pilot."
            action={
              <Button
                onClick={runScan}
                disabled={scanning}
                className="bg-brand-gradient hover:opacity-90 text-white font-semibold"
              >
                <Radar className="h-4 w-4" />
                Run your first scan
              </Button>
            }
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {[0, 1, 2, 3].map((i) => (
              <IdeaSkeleton key={i} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
