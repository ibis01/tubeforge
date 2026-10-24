"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore } from "@/lib/store";
import { useToast } from "@/hooks/use-toast";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Slider } from "@/components/ui/slider";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  VOICES,
  NICHES,
  TONES,
  LENGTHS,
  THUMB_STYLES,
  type VideoDTO,
} from "@/lib/tubeforge/types";
import { formatDuration } from "@/components/tubeforge/shared";
import { pollVoiceover, pollThumbnail } from "@/lib/tubeforge/poll";
import {
  Wand2,
  FileText,
  Mic,
  ImageIcon,
  Rocket,
  Check,
  Loader2,
  X,
  RefreshCw,
  Zap,
  Library,
  Play,
} from "lucide-react";
import { clsx } from "clsx";

type Stage = "script" | "voiceover" | "thumbnail";
type StageState = "idle" | "running" | "done" | "error";

const EXAMPLE_TOPICS = [
  "5 morning habits that rewired my brain in 30 days",
  "The forgotten empire that ruled the ancient seas",
  "Why compound interest is the closest thing to magic",
  "What Jupiter's moons whisper about alien life",
];

const STAGES: { id: Stage; label: string; desc: string; icon: typeof FileText }[] = [
  { id: "script", label: "AI Script + Metadata", desc: "GLM writes title, script, description, tags", icon: FileText },
  { id: "voiceover", label: "Voiceover", desc: "TTS narration rendered to studio audio", icon: Mic },
  { id: "thumbnail", label: "Thumbnail", desc: "CogView paints a click-worthy 16:9 cover", icon: ImageIcon },
];

async function api<T>(url: string, opts?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5 * 60 * 1000);
  try {
    const res = await fetch(url, {
      ...opts,
      signal: controller.signal,
      headers: { "Content-Type": "application/json", ...(opts?.headers ?? {}) },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
    return data as T;
  } finally {
    clearTimeout(timer);
  }
}

export function CreateView() {
  const { toast } = useToast();
  const bumpRefresh = useAppStore((s) => s.bumpRefresh);
  const setView = useAppStore((s) => s.setView);
  const prefillTopic = useAppStore((s) => s.prefillTopic);
  const setPrefillTopic = useAppStore((s) => s.setPrefillTopic);

  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [topic, setTopic] = useState("");
  const [niche, setNiche] = useState<string>("Motivation");
  const [tone, setTone] = useState<string>("informative");
  const [length, setLength] = useState<string>("medium");
  const [voice, setVoice] = useState<string>("jam");
  const [speed, setSpeed] = useState(1.0);
  const [thumbStyle, setThumbStyle] = useState<string>("cinematic");
  const [channelId, setChannelId] = useState<string>("none");
  const [channels, setChannels] = useState<{ id: string; name: string }[]>([]);
  const [autoVoice, setAutoVoice] = useState(true);
  const [autoThumb, setAutoThumb] = useState(true);

  const [video, setVideo] = useState<VideoDTO | null>(null);
  const [stageState, setStageState] = useState<Record<Stage, StageState>>({
    script: "idle",
    voiceover: "idle",
    thumbnail: "idle",
  });
  const [error, setError] = useState<string | null>(null);
  const [anyRunning, setAnyRunning] = useState(false);
  const runningRef = useRef(false);

  // Load defaults from settings + channel list
  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        const s = d.settings ?? {};
        if (s.defaultNiche) setNiche(s.defaultNiche);
        if (s.defaultTone) setTone(s.defaultTone);
        if (s.defaultLength) setLength(s.defaultLength);
        if (s.defaultVoice) setVoice(s.defaultVoice);
        if (s.defaultSpeed) setSpeed(Number(s.defaultSpeed));
        if (s.defaultThumbStyle) setThumbStyle(s.defaultThumbStyle);
        setAutoVoice(s.autoVoiceover !== "false");
        setAutoThumb(s.autoThumbnail !== "false");
      })
      .catch(() => undefined)
      .finally(() => setSettingsLoaded(true));
    fetch("/api/channels")
      .then((r) => r.json())
      .then((d) => setChannels((d.channels ?? []).map((c: { id: string; name: string }) => ({ id: c.id, name: c.name }))))
      .catch(() => undefined);
  }, []);

  // Prefill topic from other views
  useEffect(() => {
    if (prefillTopic) {
      setTopic(prefillTopic);
      setPrefillTopic(null);
    }
  }, [prefillTopic, setPrefillTopic]);

  const busy = anyRunning || runningRef.current;

  const runStage = useCallback(
    async (stage: Stage, fn: () => Promise<VideoDTO>) => {
      setStageState((s) => ({ ...s, [stage]: "running" }));
      setError(null);
      try {
        const v = await fn();
        setVideo(v);
        setStageState((s) => ({ ...s, [stage]: "done" }));
        return v;
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Stage failed";
        setStageState((s) => ({ ...s, [stage]: "error" }));
        setError(msg);
        toast({
          title: `${STAGES.find((x) => x.id === stage)?.label ?? "Stage"} failed`,
          description: msg,
          variant: "destructive",
        });
        return null;
      }
    },
    [toast]
  );

  const createVideo = useCallback(
    () =>
      api<{ video: VideoDTO }>("/api/videos", {
        method: "POST",
        body: JSON.stringify({
          topic,
          niche,
          tone,
          length,
          voice,
          ttsSpeed: speed,
          thumbStyle,
          channelId: channelId !== "none" ? channelId : null,
        }),
      }).then((d) => d.video),
    [topic, niche, tone, length, voice, speed, thumbStyle, channelId]
  );

  const startVoiceover = useCallback(
    (id: string) =>
      // POST returns 202 + starts a server background job; poll for the artifact.
      api<{ video: VideoDTO }>(`/api/videos/${id}/voiceover`, { method: "POST" }).then(
        () => pollVoiceover(id)
      ),
    []
  );

  const startThumbnail = useCallback(
    (id: string) =>
      api<{ video: VideoDTO }>(`/api/videos/${id}/thumbnail`, { method: "POST" }).then(
        () => pollThumbnail(id)
      ),
    []
  );

  const handleGenerate = useCallback(
    async (autopilot: boolean) => {
      if (!topic.trim() || busy) return;
      runningRef.current = true;
      setAnyRunning(true);
      setVideo(null);
      setError(null);
      setStageState({ script: "idle", voiceover: "idle", thumbnail: "idle" });

      try {
        const v = await runStage("script", createVideo);
        if (!v) return;
        bumpRefresh();

        if (autopilot && autoVoice) {
          const voiced = await runStage("voiceover", () => startVoiceover(v.id));
          if (!voiced) return;
          if (autopilot && autoThumb) {
            await runStage("thumbnail", () => startThumbnail(voiced.id));
          }
        }
        if (autopilot) {
          toast({
            title: "Auto-Pilot complete",
            description: "Your video package is ready to review and publish.",
          });
        }
      } finally {
        runningRef.current = false;
        setAnyRunning(false);
        bumpRefresh();
      }
    },
    [topic, busy, runStage, createVideo, startVoiceover, startThumbnail, autoVoice, autoThumb, bumpRefresh, toast]
  );

  const resumeStage = useCallback(
    async (stage: Stage) => {
      if (!video || busy) return;
      runningRef.current = true;
      setAnyRunning(true);
      try {
        if (stage === "voiceover") {
          const voiced = await runStage("voiceover", () => startVoiceover(video.id));
          if (voiced) bumpRefresh();
        } else if (stage === "thumbnail") {
          const thumbed = await runStage("thumbnail", () => startThumbnail(video.id));
          if (thumbed) bumpRefresh();
        }
      } finally {
        runningRef.current = false;
        setAnyRunning(false);
      }
    },
    [video, busy, runStage, startVoiceover, startThumbnail, bumpRefresh]
  );

  const tags = video?.tags ? video.tags.split(",").map((t) => t.trim()).filter(Boolean) : [];
  const allDone =
    stageState.script === "done" &&
    (stageState.voiceover === "done" || !autoVoice || video?.hasVoiceover) &&
    (stageState.thumbnail === "done" || !autoThumb || video?.hasThumbnail);

  return (
    <div className="grid lg:grid-cols-12 gap-5">
      {/* Left — configuration */}
      <Card className="glass rounded-2xl p-5 lg:col-span-5 h-fit lg:sticky lg:top-24">
        <div className="flex items-center gap-2 mb-5">
          <div className="h-9 w-9 rounded-xl bg-brand-gradient flex items-center justify-center glow-red-soft shrink-0">
            <Wand2 className="h-4.5 w-4.5 text-white" />
          </div>
          <div>
            <h2 className="font-semibold leading-tight">Video Blueprint</h2>
            <p className="text-xs text-muted-foreground">One topic is all Auto-Pilot needs</p>
          </div>
        </div>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="topic">Video topic</Label>
            <Textarea
              id="topic"
              placeholder="e.g. The psychology trick that makes people trust you instantly"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              rows={3}
              maxLength={300}
              disabled={busy}
              className="bg-white/5 resize-none"
            />
            <div className="flex flex-wrap gap-1.5 pt-1">
              {EXAMPLE_TOPICS.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTopic(t)}
                  disabled={busy}
                  className="text-[11px] rounded-full border border-white/10 bg-white/4 px-2.5 py-1 text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors truncate"
                >
                  {t.length > 38 ? t.slice(0, 36) + "…" : t}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Niche</Label>
              <Select value={niche} onValueChange={setNiche} disabled={busy}>
                <SelectTrigger className="bg-white/5">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {NICHES.map((n) => (
                    <SelectItem key={n} value={n}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Tone</Label>
              <Select value={tone} onValueChange={setTone} disabled={busy}>
                <SelectTrigger className="bg-white/5">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TONES.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Script length</Label>
              <Select value={length} onValueChange={setLength} disabled={busy}>
                <SelectTrigger className="bg-white/5">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LENGTHS.map((l) => (
                    <SelectItem key={l.id} value={l.id}>
                      {l.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Channel (optional)</Label>
              <Select value={channelId} onValueChange={setChannelId} disabled={busy}>
                <SelectTrigger className="bg-white/5">
                  <SelectValue placeholder="Unassigned" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Unassigned</SelectItem>
                  {channels.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Narrator voice</Label>
            <Select value={voice} onValueChange={setVoice} disabled={busy}>
              <SelectTrigger className="bg-white/5">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VOICES.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    {v.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Speech speed</Label>
              <span className="text-xs font-medium tabular-nums text-primary">{speed.toFixed(1)}x</span>
            </div>
            <Slider
              value={[speed]}
              min={0.5}
              max={2}
              step={0.1}
              onValueChange={([v]) => setSpeed(v)}
              disabled={busy}
              aria-label="Speech speed"
            />
          </div>

          <div className="space-y-1.5">
            <Label>Thumbnail style</Label>
            <Select value={thumbStyle} onValueChange={setThumbStyle} disabled={busy}>
              <SelectTrigger className="bg-white/5">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {THUMB_STYLES.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="pt-1.5 flex flex-col gap-2">
            <Button
              onClick={() => handleGenerate(true)}
              disabled={!topic.trim() || busy}
              className="bg-brand-gradient hover:opacity-90 font-semibold h-11 glow-red-soft"
              size="lg"
            >
              {busy ? (
                <Loader2 className="h-4.5 w-4.5 animate-spin" />
              ) : (
                <Zap className="h-4.5 w-4.5" />
              )}
              {busy ? "Auto-Pilot running…" : "Run Full Auto-Pilot"}
            </Button>
            <Button
              onClick={() => handleGenerate(false)}
              disabled={!topic.trim() || busy}
              variant="outline"
              className="border-white/15 bg-white/4 hover:bg-white/10 h-10"
            >
              <FileText className="h-4 w-4" />
              Script Only
            </Button>
            <p className="text-[11px] text-muted-foreground text-center leading-relaxed">
              Auto-Pilot runs: script → {autoVoice ? "voiceover → " : ""}
              {autoThumb ? "thumbnail → " : ""}ready (configure in Settings)
            </p>
          </div>
        </div>
      </Card>

      {/* Right — pipeline & results */}
      <div className="lg:col-span-7 space-y-5">
        {/* Stepper */}
        <Card className="glass rounded-2xl p-5">
          <div className="flex items-center justify-between mb-5">
            <div>
              <h3 className="font-semibold">Production Line</h3>
              <p className="text-xs text-muted-foreground">
                {video
                  ? allDone
                    ? "Package complete — ready to upload"
                    : "Auto-Pilot is assembling your video"
                  : "Waiting for a topic…"}
              </p>
            </div>
            {video && (
              <Button
                variant="outline"
                size="sm"
                className="border-white/15 bg-white/4"
                onClick={() => {
                  setView("library");
                  useAppStore.getState().setFocusVideoId(video.id);
                }}
              >
                <Library className="h-3.5 w-3.5" />
                Open in Library
              </Button>
            )}
          </div>

          <ol className="grid sm:grid-cols-3 gap-3">
            {STAGES.map((stage, i) => {
              const state = stageState[stage.id];
              return (
                <li
                  key={stage.id}
                  className={clsx(
                    "rounded-xl border p-3.5 transition-all duration-300",
                    state === "done" && "border-emerald-500/25 bg-emerald-500/6",
                    state === "running" && "border-primary/40 bg-primary/8 glow-red-soft",
                    state === "error" && "border-red-500/30 bg-red-500/6",
                    state === "idle" && "border-white/8 bg-white/3"
                  )}
                >
                  <div className="flex items-center justify-between">
                    <div
                      className={clsx(
                        "h-8 w-8 rounded-lg flex items-center justify-center shrink-0",
                        state === "done" && "bg-emerald-500/15 text-emerald-300",
                        state === "running" && "bg-primary/15 text-primary",
                        state === "error" && "bg-red-500/15 text-red-300",
                        state === "idle" && "bg-white/6 text-muted-foreground"
                      )}
                    >
                      {state === "running" ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : state === "done" ? (
                        <Check className="h-4 w-4" />
                      ) : state === "error" ? (
                        <X className="h-4 w-4" />
                      ) : (
                        <stage.icon className="h-4 w-4" />
                      )}
                    </div>
                    <span className="text-[10px] text-muted-foreground tabular-nums">
                      STEP {i + 1}
                    </span>
                  </div>
                  <p className="text-sm font-medium mt-2.5">{stage.label}</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug">
                    {stage.desc}
                  </p>
                  {state === "error" && video && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="mt-2 h-7 text-xs text-red-300 hover:text-red-200 hover:bg-red-500/10 px-2"
                      onClick={() => resumeStage(stage.id)}
                    >
                      <RefreshCw className="h-3 w-3" />
                      Retry
                    </Button>
                  )}
                </li>
              );
            })}
          </ol>
          {error && (
            <p className="mt-3 text-xs text-red-300 bg-red-500/8 border border-red-500/20 rounded-lg px-3 py-2">
              {error}
            </p>
          )}
        </Card>

        {/* Results */}
        {!video && !anyRunning && (
          <Card className="glass rounded-2xl p-8 flex flex-col items-center text-center">
            <div className="h-16 w-16 rounded-2xl bg-white/4 border border-white/10 flex items-center justify-center">
              <Play className="h-7 w-7 text-muted-foreground" />
            </div>
            <p className="mt-4 font-medium">No production run yet</p>
            <p className="text-sm text-muted-foreground mt-1.5 max-w-sm leading-relaxed">
              Configure the blueprint on the left and launch Auto-Pilot. Results will
              stream in here stage by stage.
            </p>
          </Card>
        )}

        {anyRunning && !video && (
          <Card className="glass rounded-2xl p-5 space-y-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              GLM is writing your script…
            </div>
            <Skeleton className="h-6 w-3/4 bg-white/5" />
            <Skeleton className="h-4 w-full bg-white/5" />
            <Skeleton className="h-4 w-5/6 bg-white/5" />
            <Skeleton className="h-4 w-2/3 bg-white/5" />
          </Card>
        )}

        {video && (
          <>
            <Card className="glass rounded-2xl overflow-hidden">
              <div className="p-5 border-b border-white/6">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">
                      Generated Title
                    </p>
                    <h3 className="text-lg font-bold leading-snug mt-1">
                      {video.title ?? video.topic}
                    </h3>
                    <p className="text-xs text-muted-foreground mt-1.5">
                      {video.niche} · {video.wordCount ?? 0} words ·{" "}
                      {LENGTHS.find((l) => l.id === video.length)?.label ?? video.length}
                    </p>
                  </div>
                  {video.channelName && (
                    <Badge variant="outline" className="border-white/15 bg-white/5 text-muted-foreground">
                      {video.channelName}
                    </Badge>
                  )}
                </div>
              </div>

              {video.hasThumbnail && (
                <div className="px-5 pt-5">
                  <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium mb-2">
                    Thumbnail
                  </p>
                  <img
                    src={`/api/videos/${video.id}/thumbnail`}
                    alt={`Generated thumbnail for ${video.title ?? video.topic}`}
                    className="w-full rounded-xl border border-white/10 aspect-video object-cover"
                  />
                </div>
              )}

              {video.hasVoiceover && (
                <div className="p-5">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">
                      Voiceover · {formatDuration(video.audioDuration)}
                    </p>
                    <span className="text-[11px] text-muted-foreground">
                      {VOICES.find((v) => v.id === video.voice)?.label ?? video.voice}
                    </span>
                  </div>
                  { }
                  <audio
                    controls
                    preload="metadata"
                    src={`/api/videos/${video.id}/voiceover`}
                    className="w-full"
                  >
                    Your browser does not support the audio element.
                  </audio>
                </div>
              )}
            </Card>

            <Card className="glass rounded-2xl p-5">
              <div className="flex items-center justify-between mb-3">
                <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">
                  Full Script
                </p>
                {video.description && (
                  <Badge variant="outline" className="border-white/15 bg-white/5 text-muted-foreground">
                    SEO description included
                  </Badge>
                )}
              </div>
              <div className="max-h-72 overflow-y-auto scroll-area-bar pr-3 text-sm leading-relaxed whitespace-pre-wrap text-foreground/90">
                {video.script}
              </div>
              {tags.length > 0 && (
                <div className="mt-4 pt-4 border-t border-white/6">
                  <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium mb-2">
                    SEO Tags
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {tags.map((t) => (
                      <Badge
                        key={t}
                        variant="secondary"
                        className="bg-white/6 text-muted-foreground border border-white/8 font-normal"
                      >
                        #{t}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </Card>

            {(stageState.voiceover === "idle" || stageState.thumbnail === "idle") &&
              video.status !== "published" && (
                <Card className="glass rounded-2xl p-5">
                  <p className="text-sm font-medium mb-1">Continue the pipeline</p>
                  <p className="text-xs text-muted-foreground mb-3">
                    Finish the remaining stages to mark this package ready for upload.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {!video.hasVoiceover && (
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() => resumeStage("voiceover")}
                        className="bg-brand-gradient hover:opacity-90 font-medium"
                      >
                        <Mic className="h-3.5 w-3.5" />
                        Generate Voiceover
                      </Button>
                    )}
                    {!video.hasThumbnail && (
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() => resumeStage("thumbnail")}
                        variant="outline"
                        className="border-white/15 bg-white/4"
                      >
                        <ImageIcon className="h-3.5 w-3.5" />
                        Generate Thumbnail
                      </Button>
                    )}
                  </div>
                </Card>
              )}
          </>
        )}
      </div>
    </div>
  );
}
