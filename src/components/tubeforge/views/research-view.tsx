"use client";

import { useCallback, useEffect, useState } from "react";
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
  onCreate: (title: string) => void;
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
            onClick={() => onCreate(idea.title)}
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

export function ResearchView() {
  const { toast } = useToast();
  const setView = useAppStore((s) => s.setView);
  const setPrefillTopic = useAppStore((s) => s.setPrefillTopic);
  const setFocusVideoId = useAppStore((s) => s.setFocusVideoId);
  const bumpRefresh = useAppStore((s) => s.bumpRefresh);

  const [niche, setNiche] = useState<string>("Motivation");
  const [query, setQuery] = useState("");
  const [scanning, setScanning] = useState(false);
  const [sessions, setSessions] = useState<ResearchSessionDTO[]>([]);
  const [active, setActive] = useState<ResearchSessionDTO | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [greenlightId, setGreenlightId] = useState<string | null>(null);

  const loadSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/research?limit=10");
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
      setActive(data.session);
      setSessions((prev) => [data.session, ...prev].slice(0, 10));
      toast({
        title: "Topic Radar finished",
        description: `${data.session.ideas.length} video ideas found for ${niche}.`,
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

  const sendToCreate = (topic: string) => {
    setPrefillTopic(topic);
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
      toast({
        title: "Scene story greenlit",
        description: `"${data.video.title ?? idea.title}" — ${data.video.sceneCount ?? 0} scenes written from the radar's angle & keywords.`,
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
              {sessions.map((s) => (
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
          </div>
        )}
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
                <div>
                  <p className="text-sm font-semibold">
                    Niche analysis · {active.niche}
                    {active.query !== "—" ? ` · “${active.query}”` : ""}
                  </p>
                  <p className="text-sm text-muted-foreground leading-relaxed mt-1">
                    {active.nicheSummary}
                  </p>
                  <p className="text-[11px] text-muted-foreground mt-2">
                    {active.ideas.length} ideas · scanned {timeAgo(active.createdAt)} · pick one and send it straight to the Auto-Pilot
                  </p>
                </div>
              </div>
            </Card>

            <div className="grid gap-4 sm:grid-cols-2">
              {active.ideas.map((idea) => (
                <IdeaCard
                  key={idea.id}
                  idea={idea}
                  sessionId={active.id}
                  busyId={greenlightId}
                  onCreate={sendToCreate}
                  onGreenlight={greenlightIdea}
                />
              ))}
            </div>
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
