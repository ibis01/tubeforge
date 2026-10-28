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
import { useVoices, VoiceSelectWithPreview } from "@/components/tubeforge/shared";
import { MusicPickerCard, type MusicPickerValue } from "@/components/tubeforge/music-controls";
import { MotionControlsCard, type MotionPickerValue } from "@/components/tubeforge/motion-controls";
import {
  VOICES,
  NICHES,
  TONES,
  LENGTHS,
  THUMB_STYLES,
  FORMATS,
  RENDER_MODES,
  SCENE_COUNTS,
  type VideoDTO,
} from "@/lib/tubeforge/types";
import { formatDuration } from "@/components/tubeforge/shared";
import {
  pollVoiceover,
  pollThumbnail,
  pollStoryboard,
  pollRender,
  pollStock,
} from "@/lib/tubeforge/poll";
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
  LayoutGrid,
  Clapperboard,
  Film,
  ListVideo,
} from "lucide-react";
import { clsx } from "clsx";

type Stage = "script" | "storyboard" | "stock" | "voiceover" | "thumbnail" | "render";
type StageState = "idle" | "running" | "done" | "error";

const EXAMPLE_TOPICS = [
  "5 morning habits that rewired my brain in 30 days",
  "The forgotten empire that ruled the ancient seas",
  "Why compound interest is the closest thing to magic",
  "What Jupiter's moons whisper about alien life",
];

const STAGE_DEFS: Record<
  Stage,
  { label: string; desc: string; icon: typeof FileText; storyDesc: string }
> = {
  script: {
    label: "AI Script + Metadata",
    desc: "GLM writes title, script, description, tags",
    storyDesc: "GLM writes a scene-by-scene script with camera moves",
    icon: FileText,
  },
  storyboard: {
    label: "Storyboard",
    desc: "",
    storyDesc: "CogView paints every scene (host identity locked)",
    icon: LayoutGrid,
  },
  stock: {
    label: "Stock B-Roll",
    desc: "",
    storyDesc: "Pexels + Pixabay matched to every scene",
    icon: Film,
  },
  voiceover: {
    label: "Voiceover",
    desc: "TTS narration rendered to studio audio",
    storyDesc: "Scene-by-scene narration — timing maps 1:1 to scenes",
    icon: Mic,
  },
  thumbnail: {
    label: "Thumbnail",
    desc: "CogView paints a click-worthy 16:9 cover",
    storyDesc: "CogView paints a click-worthy 16:9 cover",
    icon: ImageIcon,
  },
  render: {
    label: "Render Video",
    desc: "",
    storyDesc: "ffmpeg composes art + narration + captions + music",
    icon: Clapperboard,
  },
};

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
  const { voices } = useVoices();
  const [speed, setSpeed] = useState(1.0);
  const [thumbStyle, setThumbStyle] = useState<string>("cinematic");
  const [music, setMusic] = useState<MusicPickerValue>({
    enabled: null,
    trackId: null,
    volume: null,
    fadeIn: null,
    fadeOut: null,
  });
  const [motion, setMotion] = useState<MotionPickerValue>({
    mode: null,
    intensity: null,
    curve: null,
    vary: null,
  });
  const [channelId, setChannelId] = useState<string>("none");
  const [channels, setChannels] = useState<{ id: string; name: string }[]>([]);
  const [characterId, setCharacterId] = useState<string>("none");
  const [characters, setCharacters] = useState<{ id: string; name: string; voice: string; hasPortrait: boolean }[]>([]);
  const [autoVoice, setAutoVoice] = useState(true);
  const [autoThumb, setAutoThumb] = useState(true);
  const [format, setFormat] = useState<string>("story");
  const [renderMode, setRenderMode] = useState<string>("kenburns");

  const [video, setVideo] = useState<VideoDTO | null>(null);
  const [stageState, setStageState] = useState<Record<Stage, StageState>>({
    script: "idle",
    storyboard: "idle",
    stock: "idle",
    voiceover: "idle",
    thumbnail: "idle",
    render: "idle",
  });
  const [error, setError] = useState<string | null>(null);
  const [renderLabel, setRenderLabel] = useState<string | null>(null);
  const [anyRunning, setAnyRunning] = useState(false);
  const runningRef = useRef(false);
  const [batchCount, setBatchCount] = useState(3);
  const [batchRunning, setBatchRunning] = useState(false);

  const isStory = format === "story";
  const sceneCount = SCENE_COUNTS[length] ?? 6;

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
    fetch("/api/characters")
      .then((r) => r.json())
      .then((d) =>
        setCharacters(
          (d.characters ?? []).map((c: { id: string; name: string; voice: string; hasPortrait: boolean }) => ({
            id: c.id,
            name: c.name,
            voice: c.voice,
            hasPortrait: c.hasPortrait,
          }))
        )
      )
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

  // Casting a character adopts their voice so narration matches the persona.
  const castCharacter = characters.find((c) => c.id === characterId) ?? null;
  const applyCastVoice = (id: string) => {
    setCharacterId(id);
    const character = characters.find((c) => c.id === id);
    if (character) setVoice(character.voice);
  };

  const runStage = useCallback(
    async (stage: Stage, fn: () => Promise<VideoDTO>): Promise<VideoDTO | null> => {
      setStageState((s) => ({ ...s, [stage]: "running" }));
      setError(null);
      try {
        const v = await fn();
        if (v) setVideo(v);
        setStageState((s) => ({ ...s, [stage]: "done" }));
        return v;
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Stage failed";
        setStageState((s) => ({ ...s, [stage]: "error" }));
        setError(msg);
        toast({
          title: `${STAGE_DEFS[stage].label} failed`,
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
          characterId: characterId !== "none" ? characterId : null,
          format,
          renderMode,
          musicEnabled: music.enabled,
          musicTrackId: music.trackId,
          musicVolume: music.volume,
          musicFadeIn: music.fadeIn,
          musicFadeOut: music.fadeOut,
          motionMode: motion.mode,
          motionIntensity: motion.intensity,
          motionCurve: motion.curve,
          motionVary: motion.vary,
        }),
      }).then((d) => d.video),
    [topic, niche, tone, length, voice, speed, thumbStyle, channelId, characterId, format, renderMode, music, motion]
  );

  const startVoiceover = useCallback(
    (id: string) =>
      api(`/api/videos/${id}/voiceover`, { method: "POST" }).then(() =>
        pollVoiceover(id, { timeoutMs: isStory ? 15 * 60 * 1000 : 6 * 60 * 1000 })
      ),
    [isStory]
  );

  const startThumbnail = useCallback(
    (id: string) =>
      api(`/api/videos/${id}/thumbnail`, { method: "POST" }).then(() =>
        pollThumbnail(id)
      ),
    []
  );

  const startStoryboard = useCallback((id: string) => {
    setRenderLabel("Painting the storyboard…");
    return api(`/api/videos/${id}/storyboard`, {
      method: "POST",
      body: JSON.stringify({}),
    }).then(() => pollStoryboard(id, { timeoutMs: 20 * 60 * 1000 }));
  }, []);

  const startStock = useCallback((id: string) => {
    setRenderLabel("Matching stock footage…");
    return api(`/api/videos/${id}/stock`, {
      method: "POST",
      body: JSON.stringify({}),
    }).then(() =>
      pollStock(
        id,
        (s) => {
          if (s.progress) setRenderLabel(s.progress.label);
          else if (s.matched) setRenderLabel(`Stock b-roll · ${s.matched}/${s.total} scenes matched`);
        },
        { timeoutMs: 15 * 60 * 1000 }
      )
    ).then(async () => {
      const d = await api<{ video: VideoDTO }>(`/api/videos/${id}`);
      return d.video;
    });
  }, []);

  const startRender = useCallback((id: string, mode: string) => {
    setRenderLabel("Composing the video…");
    return api(`/api/videos/${id}/render`, {
      method: "POST",
      body: JSON.stringify({ mode, subtitles: true, music: true }),
    }).then(() =>
      pollRender(
        id,
        (s) => s.progress && setRenderLabel(`${s.progress.label} (${s.progress.current}/${s.progress.total})`),
        {
          timeoutMs: mode === "animated" ? 60 * 60 * 1000 : 15 * 60 * 1000,
        }
      ).then(async () => {
        // Refresh the video DTO to pick up videoUrl + videoDuration.
        const d = await api<{ video: VideoDTO }>(`/api/videos/${id}`);
        return d.video;
      })
    );
  }, []);

  const handleGenerate = useCallback(
    async (autopilot: boolean) => {
      if (!topic.trim() || busy) return;
      runningRef.current = true;
      setAnyRunning(true);
      setVideo(null);
      setError(null);
      setRenderLabel(null);
      setStageState({
        script: "idle",
        storyboard: "idle",
        stock: "idle",
        voiceover: "idle",
        thumbnail: "idle",
        render: "idle",
      });

      try {
        const v = await runStage("script", createVideo);
        if (!v) return;
        bumpRefresh();

        if (autopilot && isStory) {
          // Story pipeline: storyboard → (stock b-roll) → voiceover → thumbnail → render
          const boarded = await runStage("storyboard", () => startStoryboard(v.id));
          if (!boarded) return;

          if (renderMode === "stock") {
            const stocked = await runStage("stock", () => startStock(v.id));
            if (!stocked) return;
          }

          if (autopilot && autoVoice) {
            const voiced = await runStage("voiceover", () => startVoiceover(v.id));
            if (!voiced) return;

            if (autopilot && autoThumb) {
              const thumbed = await runStage("thumbnail", () => startThumbnail(v.id));
              if (!thumbed) return;

              if (renderMode === "animated") {
                // Full AI animation — runs end-to-end now (background render
                // job, ~4 min per scene). The stepper tracks live progress.
                await runStage("render", () => startRender(v.id, "animated"));
              } else {
                // Ken Burns + Stock b-roll hybrid — Smart Motion compositor.
                await runStage("render", () => startRender(v.id, renderMode));
              }
            }
          }
        } else {
          // Classic pipeline: voiceover → thumbnail
          if (autopilot && autoVoice) {
            const voiced = await runStage("voiceover", () => startVoiceover(v.id));
            if (!voiced) return;
            if (autopilot && autoThumb) {
              await runStage("thumbnail", () => startThumbnail(voiced.id));
            }
          }
        }

        if (autopilot) {
          toast({
            title: "Auto-Pilot complete",
            description:
              isStory && (renderMode === "kenburns" || renderMode === "animated")
                ? "Your rendered video is ready to review and upload."
                : "Your video package is ready to review and publish.",
          });
        }
      } finally {
        runningRef.current = false;
        setAnyRunning(false);
        setRenderLabel(null);
        bumpRefresh();
      }
    },
    [
      topic,
      busy,
      isStory,
      renderMode,
      runStage,
      createVideo,
      startStoryboard,
      startVoiceover,
      startThumbnail,
      startRender,
      autoVoice,
      autoThumb,
      bumpRefresh,
      toast,
    ]
  );

  const resumeStage = useCallback(
    async (stage: Stage) => {
      if (!video || busy) return;
      runningRef.current = true;
      setAnyRunning(true);
      try {
        if (stage === "storyboard") {
          const boarded = await runStage("storyboard", () => startStoryboard(video.id));
          if (boarded) bumpRefresh();
        } else if (stage === "stock") {
          const stocked = await runStage("stock", () => startStock(video.id));
          if (stocked) bumpRefresh();
        } else if (stage === "voiceover") {
          const voiced = await runStage("voiceover", () => startVoiceover(video.id));
          if (voiced) bumpRefresh();
        } else if (stage === "thumbnail") {
          const thumbed = await runStage("thumbnail", () => startThumbnail(video.id));
          if (thumbed) bumpRefresh();
        } else if (stage === "render") {
          const rendered = await runStage("render", () =>
            startRender(video.id, renderMode)
          );
          if (rendered) bumpRefresh();
        }
      } finally {
        runningRef.current = false;
        setAnyRunning(false);
      }
    },
    [video, busy, renderMode, runStage, startStoryboard, startStock, startVoiceover, startThumbnail, startRender, bumpRefresh]
  );

  const handleBatch = useCallback(
    async () => {
      if (!topic.trim() || batchRunning) return;
      setBatchRunning(true);
      setError(null);
      try {
        const d = await api<{ queued: number; angles: string[] }>("/api/videos/batch", {
          method: "POST",
          body: JSON.stringify({
            topic,
            count: batchCount,
            niche,
            tone,
            length,
            voice,
            ttsSpeed: speed,
            thumbStyle,
            channelId: channelId !== "none" ? channelId : null,
            characterId: characterId !== "none" ? characterId : null,
            format,
            renderMode,
          }),
        });
        toast({
          title: `Series queued — ${d.queued} videos`,
          description: d.angles.slice(0, 3).join(" · ") + (d.angles.length > 3 ? " …" : ""),
        });
        bumpRefresh();
        setView("library");
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Series batch failed";
        setError(msg);
        toast({ title: "Series batch failed", description: msg, variant: "destructive" });
      } finally {
        setBatchRunning(false);
      }
    },
    [topic, batchRunning, batchCount, niche, tone, length, voice, speed, thumbStyle, channelId, characterId, format, renderMode, toast, bumpRefresh, setView]
  );

  const tags = video?.tags ? video.tags.split(",").map((t) => t.trim()).filter(Boolean) : [];
  const stages: Stage[] = isStory
    ? renderMode === "stock"
      ? ["script", "storyboard", "stock", "voiceover", "thumbnail", "render"]
      : ["script", "storyboard", "voiceover", "thumbnail", "render"]
    : ["script", "voiceover", "thumbnail"];
  const allDone =
    stageState.script === "done" &&
    stages
      .filter((s) => s !== "script")
      .every(
        (s) =>
          stageState[s] === "done" ||
          (s === "voiceover" && (!autoVoice || video?.hasVoiceover)) ||
          (s === "thumbnail" && (!autoThumb || video?.hasThumbnail)) ||
          (s === "render" && (renderMode === "animated" || video?.hasVideo))
      );

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

          {/* Format — classic narration vs scene-based story */}
          <div className="space-y-1.5">
            <Label>Production format</Label>
            <div className="grid grid-cols-2 gap-2">
              {FORMATS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  disabled={busy}
                  onClick={() => setFormat(f.id)}
                  className={clsx(
                    "rounded-xl border p-3 text-left transition-all",
                    format === f.id
                      ? "border-primary/50 bg-primary/8 glow-red-soft"
                      : "border-white/10 bg-white/3 hover:border-white/25"
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    {f.id === "story" ? (
                      <Clapperboard className="h-3.5 w-3.5 text-primary" />
                    ) : (
                      <FileText className="h-3.5 w-3.5 text-primary" />
                    )}
                    <span className="text-sm font-medium">{f.label}</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-1 leading-snug">{f.desc}</p>
                </button>
              ))}
            </div>
          </div>

          {isStory && (
            <div className="space-y-1.5 rounded-xl border border-white/10 bg-white/3 p-3">
              <div className="flex items-center justify-between">
                <Label>Render mode</Label>
                <Badge variant="outline" className="border-white/15 bg-white/5 text-muted-foreground text-[10px]">
                  {sceneCount} scenes · {LENGTHS.find((l) => l.id === length)?.label ?? length}
                </Badge>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {RENDER_MODES.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    disabled={busy}
                    onClick={() => setRenderMode(m.id)}
                    className={clsx(
                      "rounded-lg border p-2.5 text-left transition-all",
                      renderMode === m.id
                        ? "border-primary/50 bg-primary/8"
                        : "border-white/10 bg-white/3 hover:border-white/25"
                    )}
                  >
                    <div className="flex items-center gap-1.5">
                      {m.id === "kenburns" ? (
                        <Zap className="h-3.5 w-3.5 text-amber-300" />
                      ) : m.id === "stock" ? (
                        <Film className="h-3.5 w-3.5 text-emerald-300" />
                      ) : (
                        <Clapperboard className="h-3.5 w-3.5 text-sky-300" />
                      )}
                      <span className="text-[13px] font-medium">{m.label}</span>
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-1 leading-snug">{m.desc}</p>
                  </button>
                ))}
              </div>
              {renderMode === "animated" && (
                <p className="text-[11px] text-sky-300/90 leading-relaxed">
                  Auto-Pilot renders the full animated video — every scene is
                  animated via image-to-video (~4 min per scene, tracked live).
                </p>
              )}
              {renderMode === "stock" && (
                <p className="text-[11px] text-emerald-300/90 leading-relaxed">
                  Auto-Pilot matches free stock footage (Pexels + Pixabay) to every
                  scene and renders real b-roll — scenes without a match keep their
                  Smart Motion art. Add your free keys in Settings → Stock footage.
                </p>
              )}
            </div>
          )}

          {isStory && (
            <MotionControlsCard
              value={motion}
              onChange={setMotion}
              compact
              disabled={busy}
              note={
                renderMode === "animated"
                  ? "Image Motion applies to Ken Burns renders — the animated mode generates real video per scene instead."
                  : null
              }
            />
          )}

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
            <div className="space-y-1.5">
              <Label>Cast (optional)</Label>
              <Select value={characterId} onValueChange={applyCastVoice} disabled={busy}>
                <SelectTrigger className="bg-white/5">
                  <SelectValue placeholder="No recurring host" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No recurring host</SelectItem>
                  {characters.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}{c.hasPortrait ? " ●" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {castCharacter && (
                <p className="text-[11px] text-emerald-300/90 leading-relaxed">
                  {castCharacter.name} hosts this video — identity is stamped into the
                  storyboard and thumbnail, and the voice defaults to their persona.
                </p>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Narrator voice</Label>
            <VoiceSelectWithPreview
              value={voice}
              onValueChange={setVoice}
              voices={voices}
              disabled={busy}
            />
            <p className="text-[10px] text-muted-foreground leading-relaxed">
              Tap the <span className="text-primary">▶</span> next to a voice to hear how it
              sounds before picking. Not feeling these voices? After creating, open the video&apos;s
              Package tab → <span className="text-foreground/80">Change the voice</span> to
              upload your own audio or paste a voice link from the internet.
            </p>
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

          <MusicPickerCard value={music} onChange={setMusic} compact={isStory} />

          <div className="pt-1.5 flex flex-col gap-2">
            <Button
              onClick={() => handleGenerate(true)}
              disabled={!topic.trim() || busy || !settingsLoaded}
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
              {isStory
                ? `Auto-Pilot runs: scene script → storyboard → ${renderMode === "stock" ? "stock b-roll → " : ""}${autoVoice ? "voiceover → " : ""}${autoThumb ? "thumbnail → " : ""}render ${renderMode === "animated" ? "full AI animation" : "MP4"}`
                : `Auto-Pilot runs: script → ${autoVoice ? "voiceover → " : ""}${autoThumb ? "thumbnail → " : ""}ready (configure in Settings)`}
            </p>
          </div>

          {/* Series batch — one topic, a whole series of distinct videos */}
          <div className="rounded-xl border border-white/10 bg-white/3 p-3 space-y-2.5">
            <div className="flex items-center gap-2">
              <div className="h-7 w-7 rounded-lg bg-white/6 border border-white/10 flex items-center justify-center shrink-0">
                <ListVideo className="h-3.5 w-3.5 text-primary" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium leading-tight">Series batch</p>
                <p className="text-[10px] text-muted-foreground leading-snug">
                  One topic → {batchCount} distinct videos, scripts auto-written
                </p>
              </div>
              <div className="ml-auto shrink-0">
                <Select value={String(batchCount)} onValueChange={(v) => setBatchCount(Number(v))} disabled={batchRunning}>
                  <SelectTrigger className="h-8 w-[72px] bg-white/5">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[2, 3, 4, 5, 6].map((n) => (
                      <SelectItem key={n} value={String(n)}>
                        {n} videos
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <Button
              onClick={handleBatch}
              disabled={!topic.trim() || batchRunning || busy}
              variant="outline"
              className="w-full border-white/15 bg-white/4 hover:bg-white/10 h-10"
            >
              {batchRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <ListVideo className="h-4 w-4" />}
              {batchRunning ? "Queuing series…" : `Generate ${batchCount}-Video Series`}
            </Button>
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
                    ? isStory && renderMode !== "animated"
                      ? "Video rendered — ready to upload"
                      : "Package complete — ready to upload"
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

          <ol className={clsx("grid gap-3", stages.length > 3 ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-5" : "sm:grid-cols-3")}>
            {stages.map((stage, i) => {
              const state = stageState[stage];
              const def = STAGE_DEFS[stage];
              return (
                <li
                  key={stage}
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
                        <def.icon className="h-4 w-4" />
                      )}
                    </div>
                    <span className="text-[10px] text-muted-foreground tabular-nums">
                      STEP {i + 1}
                    </span>
                  </div>
                  <p className="text-sm font-medium mt-2.5">{def.label}</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug">
                    {isStory ? def.storyDesc : def.desc}
                  </p>
                  {state === "error" && video && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="mt-2 h-7 text-xs text-red-300 hover:text-red-200 hover:bg-red-500/10 px-2"
                      onClick={() => resumeStage(stage)}
                    >
                      <RefreshCw className="h-3 w-3" />
                      Retry
                    </Button>
                  )}
                </li>
              );
            })}
          </ol>
          {renderLabel && (
            <p className="mt-3 text-xs text-primary/90 flex items-center gap-1.5">
              <Loader2 className="h-3 w-3 animate-spin" />
              {renderLabel}
            </p>
          )}
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
                      {isStory
                        ? `${video.sceneCount ?? 0} scenes · ${video.renderMode === "animated" ? "AI animation" : video.renderMode === "stock" ? "Stock b-roll" : "Ken Burns"}`
                        : LENGTHS.find((l) => l.id === video.length)?.label ?? video.length}
                    </p>
                  </div>
                  {video.channelName && (
                    <Badge variant="outline" className="border-white/15 bg-white/5 text-muted-foreground">
                      {video.channelName}
                    </Badge>
                  )}
                </div>
              </div>

              {video.hasVideo && video.videoUrl && (
                <div className="p-5 border-b border-white/6">
                  <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium mb-2">
                    Rendered video · {formatDuration(video.videoDuration)}
                  </p>
                  <video
                    controls
                    preload="metadata"
                    src={video.videoUrl}
                    className="w-full rounded-xl border border-white/10 aspect-video bg-black"
                  >
                    Your browser does not support the video element.
                  </video>
                </div>
              )}

              {isStory && (video.scenes ?? []).length > 0 && (
                <div className="p-5 border-b border-white/6">
                  <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium mb-2">
                    Storyboard · {video.sceneCount} scenes
                  </p>
                  <div className="flex gap-2 overflow-x-auto scroll-area-bar pb-2">
                    {(video.scenes ?? []).map((s) => (
                      <div
                        key={s.index}
                        className="shrink-0 w-40 rounded-xl overflow-hidden border border-white/10 bg-white/3 relative"
                      >
                        {video.hasStoryboard ? (
                          <img
                            src={`/api/videos/${video.id}/storyboard/${s.index}`}
                            alt={`Scene ${s.index}: ${s.title}`}
                            className="w-full aspect-video object-cover"
                          />
                        ) : (
                          <div className="w-full aspect-video bg-white/4 flex items-center justify-center">
                            {stageState.storyboard === "running" ? (
                              <Loader2 className="h-5 w-5 animate-spin text-primary" />
                            ) : (
                              <LayoutGrid className="h-5 w-5 text-muted-foreground" />
                            )}
                          </div>
                        )}
                        {s.hasStock && (
                          <div className="absolute top-1.5 left-1.5 flex items-center gap-1 rounded-md bg-black/70 backdrop-blur px-1.5 py-0.5 border border-emerald-500/30">
                            <Film className="h-2.5 w-2.5 text-emerald-300" />
                            <span className="text-[9px] font-semibold uppercase tracking-wide text-emerald-300">
                              {s.stockSource === "pixabay" ? "Pixabay" : "Pexels"}
                            </span>
                          </div>
                        )}
                        <div className="p-2">
                          <p className="text-[11px] font-medium truncate">{s.title}</p>
                          <p className="text-[10px] text-muted-foreground truncate">
                            {s.hasStock && s.stockQuery ? `stock: ${s.stockQuery}` : s.caption || s.mood}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

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
                      {voices.find((v) => v.id === video.voice)?.label ?? VOICES.find((v) => v.id === video.voice)?.label ?? video.voice}
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
                  {isStory ? "Scene Narration" : "Full Script"}
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

            {stages.some(
              (s) =>
                stageState[s] === "idle" &&
                ((s === "storyboard" && !video.hasStoryboard) ||
                  (s === "stock" && video.hasStoryboard && renderMode === "stock") ||
                  (s === "voiceover" && !video.hasVoiceover) ||
                  (s === "thumbnail" && !video.hasThumbnail) ||
                  (s === "render" && !video.hasVideo && renderMode !== "animated"))
            ) &&
              video.status !== "published" && (
                <Card className="glass rounded-2xl p-5">
                  <p className="text-sm font-medium mb-1">Continue the pipeline</p>
                  <p className="text-xs text-muted-foreground mb-3">
                    Finish the remaining stages to complete this video.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {isStory && !video.hasStoryboard && (
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() => resumeStage("storyboard")}
                        className="bg-brand-gradient hover:opacity-90 font-medium"
                      >
                        <LayoutGrid className="h-3.5 w-3.5" />
                        Generate Storyboard
                      </Button>
                    )}
                    {isStory && renderMode === "stock" && video.hasStoryboard && (
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() => resumeStage("stock")}
                        variant="outline"
                        className="border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/15 text-emerald-200"
                      >
                        <Film className="h-3.5 w-3.5" />
                        Find Stock Footage
                      </Button>
                    )}
                    {!video.hasVoiceover && (
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() => resumeStage("voiceover")}
                        className={clsx(isStory && video.hasStoryboard ? "bg-brand-gradient hover:opacity-90 font-medium" : "border-white/15 bg-white/4")}
                        variant={isStory && video.hasStoryboard ? "default" : "outline"}
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
                    {isStory && !video.hasVideo && video.hasStoryboard && video.hasVoiceover && (
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() => resumeStage("render")}
                        variant="outline"
                        className="border-white/15 bg-white/4"
                      >
                        <Clapperboard className="h-3.5 w-3.5" />
                        Render Video
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
