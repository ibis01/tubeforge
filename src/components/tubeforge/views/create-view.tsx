"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore } from "@/lib/store";
import { useToast } from "@/hooks/use-toast";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useVoices, VoiceSelectWithPreview } from "@/components/tubeforge/shared";
import { MusicPickerCard, type MusicPickerValue } from "@/components/tubeforge/music-controls";
import { MotionControlsCard, type MotionPickerValue } from "@/components/tubeforge/motion-controls";
import { TransitionControlsCard, type TransitionPickerValue } from "@/components/tubeforge/transition-controls";
import {
  VOICES,
  NICHES,
  TONES,
  LENGTHS,
  THUMB_STYLES,
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
  pollScript,
} from "@/lib/tubeforge/poll";
import {
  Wand2,
  FileText,
  Mic,
  ImageIcon,
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
  PenTool,
  Presentation,
  ListVideo,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  Sparkles,
  ClipboardCopy,
  Pencil,
  Save,
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

/** Stage 4a (T-4.3) — the guided brief's four steps. */
const STEPS = [
  { label: "Video type", hint: "What are you making?" },
  { label: "Concept", hint: "Topic & script source" },
  { label: "Shape & tone", hint: "Length, tone & render style" },
  { label: "Voice & art", hint: "Narration & look" },
  { label: "Launch", hint: "Destination & run" },
] as const;

/** S76 — the FIRST thing a creator chooses: the type of video. Each preset
 *  pins format + renderMode together so the whole downstream brief (script
 *  source, storyboard, render pipeline, ETA copy) adapts from minute zero
 *  instead of burying the choice mid-wizard. */
const VIDEO_TYPES = [
  {
    id: "classic",
    title: "Classic narration",
    format: "script",
    renderMode: "kenburns",
    desc: "AI writes a flowing narration + metadata — classic render with a thumbnail package.",
    icon: FileText,
    accent: "text-primary",
  },
  {
    id: "story",
    title: "Scene story",
    format: "story",
    renderMode: "kenburns",
    desc: "Scene-by-scene script and storyboard art — Smart Motion pans & zooms per scene.",
    icon: Clapperboard,
    accent: "text-amber-300",
  },
  {
    id: "whiteboard",
    title: "Whiteboard explainer",
    format: "story",
    renderMode: "whiteboard",
    desc: "A hand draws every scene in real time — narrated whiteboard animation.",
    icon: PenTool,
    accent: "text-sky-300",
  },
  {
    id: "slides",
    title: "Keynote slides",
    format: "story",
    renderMode: "slides",
    desc: "A kinetic-typography slide deck, one designed slide per beat — no image generation.",
    icon: Presentation,
    accent: "text-violet-300",
  },
] as const;

/** localStorage key for the persisted brief draft (T-4.3). */
const DRAFT_KEY = "tubeforge:create-draft";

const STAGE_DEFS: Record<
  Stage,
  { label: string; desc: string; icon: typeof FileText; storyDesc: string }
> = {
  script: {
    label: "AI Script + Metadata",
    desc: "AI writes title, script, description, tags",
    storyDesc: "AI writes a scene-by-scene script with camera moves",
    icon: FileText,
  },
  storyboard: {
    label: "Storyboard",
    desc: "",
    storyDesc: "AI paints every scene (host identity locked)",
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
    desc: "AI paints a click-worthy 16:9 cover",
    storyDesc: "AI paints a click-worthy 16:9 cover",
    icon: ImageIcon,
  },
  render: {
    label: "Render Video",
    desc: "",
    storyDesc: "ffmpeg composes art + narration + captions + music",
    icon: Clapperboard,
  },
};

/** Thin section divider + uppercase micro-label used to chunk the long
 *  blueprint form into scannable groups (format / narration / art / destination). */
function SectionLabel({
  title,
  hint,
}: {
  title: string;
  hint?: string;
}) {
  return (
    <div className="pt-3 mt-1 border-t border-white/8">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </p>
      {hint && (
        <p className="text-[10px] text-muted-foreground/80 mt-0.5 leading-snug">
          {hint}
        </p>
      )}
    </div>
  );
}

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
    if (!res.ok)
      throw new Error(
        (data as { error?: string }).error ?? `HTTP ${res.status}`,
      );
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
  const prefillSources = useAppStore((s) => s.prefillSources);
  const setPrefillSources = useAppStore((s) => s.setPrefillSources);
  // Stage 5 (module A) — research sources captured from the prefill, held for
  // the create call (cleared once consumed).
  const heldSourcesRef = useRef<import("@/lib/tubeforge/types").ResearchSource[] | null>(null);

  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [aiConfig, setAiConfig] = useState<any>(null);

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
    ducking: null,
    duckingIntensity: null,
    mood: null,
  });
  const [motion, setMotion] = useState<MotionPickerValue>({
    mode: null,
    intensity: null,
    curve: null,
    vary: null,
  });
  const [transition, setTransition] = useState<TransitionPickerValue>({
    style: null,
    durationSec: null,
  });
  const [channelId, setChannelId] = useState<string>("none");
  const [channels, setChannels] = useState<{ id: string; name: string }[]>([]);
  const [characterId, setCharacterId] = useState<string>("none");
  const [characters, setCharacters] = useState<
    { id: string; name: string; voice: string; hasPortrait: boolean }[]
  >([]);
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
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Stage 4a (T-4.3) — guided brief: the wizard step + draft restore flag.
  const [step, setStep] = useState(0);
  const [draftRestored, setDraftRestored] = useState(false);
  const draftCheckedRef = useRef(false);

  // ✅ Derived from state only — never read runningRef during render.
  const busy = anyRunning;

  // Manual-script flow — paste your own narration instead of generating with AI
  const [useOwnScript, setUseOwnScript] = useState(false);
  const [customScript, setCustomScript] = useState("");

  // Analysis state — the engine must review the pasted script before the
  // user can create a video from it. Approved = engine verdict accepted.
  type AnalysisState = "idle" | "analyzing" | "done" | "error";
  const [analysisState, setAnalysisState] = useState<AnalysisState>("idle");
  const [analysisReport, setAnalysisReport] = useState<any>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [scriptApproved, setScriptApproved] = useState(false);

  // Inline script editing in the result card — toggle to a textarea, Save/Cancel
  const [editingScript, setEditingScript] = useState(false);
  const [draftScript, setDraftScript] = useState("");
  const [scriptSaving, setScriptSaving] = useState(false);
  const [justCopied, setJustCopied] = useState(false);

  const isStory = format === "story";
  const sceneCount = SCENE_COUNTS[length] ?? 6;

  // The Concept step (1) needs a topic (or a pasted script) before the brief
  // can advance. The type picker (0) is always valid — that IS the first
  // decision, made before anything else is asked.
  const stepValid =
    step === 1
      ? Boolean(topic.trim() || (useOwnScript && customScript.trim()))
      : true;

  // Reset approval whenever the script or its options change — the analysis
  // verdict is tied to the exact text we analyzed. Render-time adjust
  // (guarded seed compare) instead of the reset effect: same trigger, same
  // final state, one fewer paint.
  const [analysisSeed, setAnalysisSeed] = useState({ customScript, niche, tone, length, useOwnScript });
  if (
    analysisSeed.customScript !== customScript ||
    analysisSeed.niche !== niche ||
    analysisSeed.tone !== tone ||
    analysisSeed.length !== length ||
    analysisSeed.useOwnScript !== useOwnScript
  ) {
    setAnalysisSeed({ customScript, niche, tone, length, useOwnScript });
    setScriptApproved(false);
    setAnalysisState("idle");
    setAnalysisReport(null);
    setAnalysisError(null);
  }

  // Load defaults from settings + channel list
  useEffect(() => {
    // ---- Brief draft restore (T-4.3), folded onto the settings chain ----
    // Applied exactly once, AFTER the server defaults land (so the draft
    // wins); a prefill topic from another view wins over any saved draft —
    // read from the store at apply time, matching the old effect's
    // latest-render check. Effect-local + promise-callback = no synchronous
    // setState in the effect body.
    const applyDraft = () => {
      if (draftCheckedRef.current) return;
      draftCheckedRef.current = true;
      if (useAppStore.getState().prefillTopic) return;
      try {
        const raw = localStorage.getItem(DRAFT_KEY);
        if (!raw) return;
        const d = JSON.parse(raw);
        if (!d || typeof d !== "object") return;
        if (typeof d.topic === "string" && d.topic) setTopic(d.topic);
        if (typeof d.niche === "string" && d.niche) setNiche(d.niche);
        if (typeof d.tone === "string" && d.tone) setTone(d.tone);
        if (typeof d.length === "string" && d.length) setLength(d.length);
        if (typeof d.voice === "string" && d.voice) setVoice(d.voice);
        if (typeof d.speed === "number") setSpeed(d.speed);
        if (typeof d.thumbStyle === "string" && d.thumbStyle) setThumbStyle(d.thumbStyle);
        if (d.music && typeof d.music === "object") setMusic(d.music);
        if (d.motion && typeof d.motion === "object") setMotion(d.motion);
        if (d.transition && typeof d.transition === "object") setTransition(d.transition);
        if (typeof d.channelId === "string") setChannelId(d.channelId);
        if (typeof d.characterId === "string") setCharacterId(d.characterId);
        if (d.format === "story" || d.format === "script") setFormat(d.format);
        if (typeof d.renderMode === "string" && d.renderMode) setRenderMode(d.renderMode);
        if (typeof d.useOwnScript === "boolean") setUseOwnScript(d.useOwnScript);
        if (typeof d.customScript === "string" && d.customScript) setCustomScript(d.customScript);
        if (typeof d.batchCount === "number") setBatchCount(d.batchCount);
        // A discarded/empty draft must not resurrect a pointless banner.
        if (d.topic || d.customScript) setDraftRestored(true);
      } catch {
        /* corrupt draft — start fresh */
      }
    };

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
      .finally(() => {
        setSettingsLoaded(true);
        applyDraft();
      });

    // Load AI Provider config to fix the red warning text
    fetch("/api/settings/ai")
      .then((r) => r.json())
      .then((d) => setAiConfig(d))
      .catch(() => undefined);

    fetch("/api/channels")
      .then((r) => r.json())
      .then((d) =>
        setChannels(
          (d.channels ?? []).map((c: { id: string; name: string }) => ({
            id: c.id,
            name: c.name,
          })),
        ),
      )
      .catch(() => undefined);
    fetch("/api/characters")
      .then((r) => r.json())
      .then((d) =>
        setCharacters(
          (d.characters ?? []).map(
            (c: {
              id: string;
              name: string;
              voice: string;
              hasPortrait: boolean;
            }) => ({
              id: c.id,
              name: c.name,
              voice: c.voice,
              hasPortrait: c.hasPortrait,
            }),
          ),
        ),
      )
      .catch(() => undefined);
  }, []);

  // Prefill topic from other views. Stage 5 (module A): the radar idea's web
  // sources ride the topic prefill — captured here into a ref for the create
  // call (both cleared from the store so nothing stale survives; a bare
  // topic prefill naturally resets the ref to null).
  useEffect(() => {
    if (prefillTopic) {
      // Defer state updates to avoid "setState synchronously within an effect" warning
      const timer = setTimeout(() => {
        setTopic(prefillTopic);
        heldSourcesRef.current = prefillSources?.length ? prefillSources : null;
        setPrefillTopic(null);
        setPrefillSources(null);
        setStep(0);
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [prefillTopic, prefillSources, setPrefillTopic, setPrefillSources]);

  // ---- Brief draft persistence (T-4.3) -----------------------------------
  // (The restore now rides the settings chain above — applyDraft, folded
  // into its .finally so the draft lands after the server defaults.)

  // Debounced save — never while a production run is live (the brief is
  // committed at that point; freezing it keeps the draft honest).
  useEffect(() => {
    if (!settingsLoaded || !draftCheckedRef.current || busy || video) return;
    const t = setTimeout(() => {
      try {
        localStorage.setItem(
          DRAFT_KEY,
          JSON.stringify({
            topic,
            niche,
            tone,
            length,
            voice,
            speed,
            thumbStyle,
            music,
            motion,
            transition,
            channelId,
            characterId,
            format,
            renderMode,
            useOwnScript,
            customScript,
            batchCount,
            savedAt: Date.now(),
          }),
        );
      } catch {
        /* storage blocked — non-fatal */
      }
    }, 700);
    return () => clearTimeout(t);
  }, [
    settingsLoaded,
    busy,
    video,
    topic,
    niche,
    tone,
    length,
    voice,
    speed,
    thumbStyle,
    music,
    motion,
    transition,
    channelId,
    characterId,
    format,
    renderMode,
    useOwnScript,
    customScript,
    batchCount,
  ]);

  // A created video = the brief was used. Clear the draft so the next visit
  // starts clean instead of resurrecting a produced topic. The storage
  // delete stays an effect (a real side effect); the banner retirement is
  // a render-time adjust on the same video reference.
  const [draftSeedVideo, setDraftSeedVideo] = useState<VideoDTO | null>(video);
  if (draftSeedVideo !== video) {
    setDraftSeedVideo(video);
    if (video) setDraftRestored(false);
  }

  useEffect(() => {
    if (!video) return;
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch {
      /* ignore */
    }
  }, [video]);

  const discardDraft = () => {
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch {
      /* ignore */
    }
    setTopic("");
    setUseOwnScript(false);
    setCustomScript("");
    setFormat("story");
    setRenderMode("kenburns");
    setNiche("Motivation");
    setTone("informative");
    setLength("medium");
    setVoice("jam");
    setSpeed(1.0);
    setThumbStyle("cinematic");
    setChannelId("none");
    setCharacterId("none");
    setMusic({
      enabled: null,
      trackId: null,
      volume: null,
      fadeIn: null,
      fadeOut: null,
      ducking: null,
      duckingIntensity: null,
      mood: null,
    });
    setMotion({ mode: null, intensity: null, curve: null, vary: null });
    setTransition({ style: null, durationSec: null });
    setDraftRestored(false);
    setStep(0);
  };

  // ✅ FIX: Do not read runningRef.current during render (busy declared above)

  // Casting a character adopts their voice so narration matches the persona.
  const castCharacter = characters.find((c) => c.id === characterId) ?? null;
  const applyCastVoice = (id: string) => {
    setCharacterId(id);
    const character = characters.find((c) => c.id === id);
    if (character) setVoice(character.voice);
  };

  const runStage = useCallback(
    async (
      stage: Stage,
      fn: () => Promise<VideoDTO>,
    ): Promise<VideoDTO | null> => {
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
    [toast],
  );

  const createVideo = useCallback(
    () =>
      api<{ video: VideoDTO; queued?: boolean }>("/api/videos", {
        method: "POST",
        body: JSON.stringify({
          topic,
          // Only send `script` when the user explicitly opted into manual mode
          // AND typed something. Backend uses this to skip AI generation.
          // `approved: true` is the user's signal the analysis verdict was
          // accepted — backend rejects creation without it.
          ...(useOwnScript && customScript.trim()
            ? { script: customScript, approved: true }
            : {}),
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
          // Stage 5 (module A) — the radar idea's web sources riding the prefill
          ...(heldSourcesRef.current?.length
            ? { researchSources: heldSourcesRef.current }
            : {}),
          musicEnabled: music.enabled,
          musicTrackId: music.trackId,
          musicVolume: music.volume,
          musicFadeIn: music.fadeIn,
          musicFadeOut: music.fadeOut,
          musicDucking: music.ducking,
          musicDuckingIntensity: music.duckingIntensity,
          musicMood: music.mood,
          motionMode: motion.mode,
          motionIntensity: motion.intensity,
          motionCurve: motion.curve,
          motionVary: motion.vary,
          transitionStyle: transition.style,
          transitionDuration: transition.durationSec,
        }),
      }).then(async (d) => {
        const v = d.video;
        // Stage 1 (T-1.9): the script now generates as a background job —
        // the create response is 202 with the draft. Wait for the script
        // here so the Auto-Pilot chain can keep treating this stage as
        // "done when scripted" (same contract as the re-roll path).
        if (v.status !== "scripted") {
          return pollScript(v.id, { timeoutMs: 15 * 60 * 1000 });
        }
        return v;
      }).then((v) => {
        // Stage 5 (module A) — the riding sources were consumed by this
        // create; never leak them into the next one.
        heldSourcesRef.current = null;
        return v;
      }),
    [topic, useOwnScript, customScript, niche, tone, length, voice, speed, thumbStyle, channelId, characterId, format, renderMode, music, motion, transition]
  );

  const startVoiceover = useCallback(
    (id: string) =>
      api(`/api/videos/${id}/voiceover`, { method: "POST" }).then(() =>
        pollVoiceover(id, {
          timeoutMs: isStory ? 15 * 60 * 1000 : 6 * 60 * 1000,
        }),
      ),
    [isStory],
  );

  // Run the pasted script through the analysis engine. The verdict drives
  // the UI: approved → green Create button; needs_revision → amber with
  // Approve Anyway; rejected → red, no create.
  const analyzeCustomScript = useCallback(async () => {
    if (!customScript.trim()) {
      toast({
        title: "Paste a script first",
        description: "Nothing to analyze yet.",
        variant: "destructive",
      });
      return;
    }
    if (isStory) {
      toast({
        title: "Custom scripts need the Classic format",
        description: "Story mode uses AI to split the script into scenes — analysis isn't meaningful there.",
        variant: "destructive",
      });
      return;
    }
    setAnalysisState("analyzing");
    setAnalysisError(null);
    setScriptApproved(false);
    try {
      const d = await api<{ analysis: any }>("/api/videos/analyze-script", {
        method: "POST",
        body: JSON.stringify({
          script: customScript,
          topic,
          niche,
          tone,
          length,
        }),
      });
      setAnalysisReport(d.analysis);
      setAnalysisState("done");
      if (d.analysis?.verdict === "approved") {
        setScriptApproved(true); // auto-approve if engine is happy
      }
      const verdictLabel =
        d.analysis?.verdict === "approved"
          ? "Approved"
          : d.analysis?.verdict === "needs_revision"
          ? "Needs revision"
          : "Rejected";
      toast({
        title: `Engine verdict: ${verdictLabel}`,
        description: `Score ${d.analysis?.score ?? 0}/100 — ${d.analysis?.summary ?? ""}`,
      });
    } catch (e) {
      setAnalysisState("error");
      setAnalysisError(e instanceof Error ? e.message : "Analysis failed");
      toast({
        title: "Analysis failed",
        description: e instanceof Error ? e.message : "Engine unavailable",
        variant: "destructive",
      });
    }
  }, [customScript, topic, niche, tone, length, isStory, toast]);

  // Copy the generated script to the clipboard
  const copyScript = useCallback(async () => {
    if (!video?.script) return;
    try {
      await navigator.clipboard.writeText(video.script);
      setJustCopied(true);
      setTimeout(() => setJustCopied(false), 1800);
      toast({ title: "Script copied", description: `${video.wordCount} words on the clipboard.` });
    } catch {
      // Older browsers / insecure context — fall back to a textarea hack
      const ta = document.createElement("textarea");
      ta.value = video.script;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        setJustCopied(true);
        setTimeout(() => setJustCopied(false), 1800);
        toast({ title: "Script copied", description: `${video.wordCount} words on the clipboard.` });
      } catch {
        toast({ title: "Copy failed", description: "Select the text and Cmd/Ctrl-C instead.", variant: "destructive" });
      } finally {
        document.body.removeChild(ta);
      }
    }
  }, [video, toast]);

  // Enter inline-edit mode for the displayed script
  const startEditScript = useCallback(() => {
    if (!video?.script) return;
    setDraftScript(video.script);
    setEditingScript(true);
  }, [video]);

  // PATCH the new script to the server and refresh local state
  const saveScript = useCallback(async () => {
    if (!video || !draftScript.trim()) return;
    setScriptSaving(true);
    try {
      const d = await api<{ video: VideoDTO }>(`/api/videos/${video.id}`, {
        method: "PATCH",
        body: JSON.stringify({ script: draftScript }),
      });
      setVideo(d.video);
      setEditingScript(false);
      bumpRefresh();
      toast({
        title: "Script saved",
        description: d.video.hasVoiceover
          ? "Voiceover kept (only minor changes detected)."
          : "Previous voiceover & render were reset — regenerate them from the pipeline.",
      });
    } catch (e) {
      toast({
        title: "Save failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setScriptSaving(false);
    }
  }, [video, draftScript, bumpRefresh, toast]);

  const startThumbnail = useCallback(
    (id: string) =>
      api(`/api/videos/${id}/thumbnail`, { method: "POST" }).then(() =>
        pollThumbnail(id),
      ),
    [],
  );

  const startStoryboard = useCallback((id: string) => {
    setRenderLabel("Painting the storyboard…");
    return api(`/api/videos/${id}/storyboard`, {
      method: "POST",
      body: JSON.stringify({}),
    })
      // pollStoryboard watches the JOB flag (survives re-generation on an
      // already-painted video — the old hasStoryboard watch resolved on its
      // first tick and left the grid stale until a manual refresh); the
      // final fetch hands runStage a fresh VideoDTO to setVideo.
      .then(() => pollStoryboard(id, { timeoutMs: 20 * 60 * 1000 }))
      .then(async () => (await api<{ video: VideoDTO }>(`/api/videos/${id}`)).video);
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
        (s) =>
          s.progress &&
          setRenderLabel(
            `${s.progress.label} (${s.progress.current}/${s.progress.total})`,
          ),
        {
          timeoutMs: mode === "animated" ? 60 * 60 * 1000 : 15 * 60 * 1000,
        },
      ).then(async () => {
        const d = await api<{ video: VideoDTO }>(`/api/videos/${id}`);
        return d.video;
      }),
    );
  }, []);

  const handleGenerate = useCallback(
    async (autopilot: boolean) => {
      if (!topic.trim() || busy) return;
      // When "use my own script" is on, the script itself is the source of
      // truth — block generation until they've pasted something.
      if (useOwnScript && !customScript.trim()) {
        toast({
          title: "Paste your script first",
          description: "Toggle off 'Use my own script' to let AI write it instead.",
          variant: "destructive",
        });
        return;
      }
      // Custom scripts only work on classic format. If the user has the
      // story format selected + custom script, the backend will reject —
      // fail fast with a clearer client-side message instead.
      if (useOwnScript && customScript.trim() && isStory) {
        toast({
          title: "Custom script needs the Classic format",
          description: "Switch to Story to let AI generate the scene-by-scene script.",
          variant: "destructive",
        });
        return;
      }
      // Approve-gate — the engine must have analyzed AND the user must have
      // accepted the verdict. If not yet analyzed, prompt them to analyze.
      if (useOwnScript && customScript.trim() && !isStory) {
        if (analysisState !== "done" || !analysisReport) {
          toast({
            title: "Analyze the script first",
            description: "Click 'Analyze script' to run the engine before creating the video.",
            variant: "destructive",
          });
          return;
        }
        if (!scriptApproved) {
          toast({
            title: "Approve the analysis first",
            description:
              analysisReport?.verdict === "rejected"
                ? "The engine rejected this script — edit it and re-analyze."
                : "Review the analysis report and click 'Approve & Create'.",
            variant: "destructive",
          });
          return;
        }
      }
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
          // Story pipeline: storyboard (skipped for slides) → (stock b-roll) →
          // voiceover → thumbnail → render. Keynote slides design their own
          // deck at render time — no image generation pass needed.
          if (renderMode !== "slides") {
            const boarded = await runStage("storyboard", () => startStoryboard(v.id));
            if (!boarded) return;
          }

          if (renderMode === "stock") {
            const stocked = await runStage("stock", () => startStock(v.id));
            if (!stocked) return;
          }

          if (autopilot && autoVoice) {
            const voiced = await runStage("voiceover", () =>
              startVoiceover(v.id),
            );
            if (!voiced) return;

            if (autopilot && autoThumb) {
              const thumbed = await runStage("thumbnail", () =>
                startThumbnail(v.id),
              );
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
          if (autopilot && autoVoice) {
            const voiced = await runStage("voiceover", () =>
              startVoiceover(v.id),
            );
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
              isStory &&
              (renderMode === "kenburns" || renderMode === "animated")
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
      startStock,
      startVoiceover,
      startThumbnail,
      startRender,
      autoVoice,
      autoThumb,
      bumpRefresh,
      toast,
      useOwnScript,
      customScript,
      analysisState,
      analysisReport,
      scriptApproved,
    ],
  );

  const resumeStage = useCallback(
    async (stage: Stage) => {
      if (!video || busy) return;
      runningRef.current = true;
      setAnyRunning(true);
      try {
        if (stage === "storyboard") {
          const boarded = await runStage("storyboard", () =>
            startStoryboard(video.id),
          );
          if (boarded) bumpRefresh();
        } else if (stage === "stock") {
          const stocked = await runStage("stock", () => startStock(video.id));
          if (stocked) bumpRefresh();
        } else if (stage === "voiceover") {
          const voiced = await runStage("voiceover", () =>
            startVoiceover(video.id),
          );
          if (voiced) bumpRefresh();
        } else if (stage === "thumbnail") {
          const thumbed = await runStage("thumbnail", () =>
            startThumbnail(video.id),
          );
          if (thumbed) bumpRefresh();
        } else if (stage === "render") {
          const rendered = await runStage("render", () =>
            startRender(video.id, renderMode),
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

  const tags = video?.tags
    ? video.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    : [];
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
          (s === "render" && (renderMode === "animated" || video?.hasVideo)),
      );

  // Check if the TTS provider is missing an API key (ignoring localhost)
  const ttsConfig = aiConfig?.capabilities?.tts;
  const isLocalTts =
    ttsConfig?.baseUrl?.includes("localhost") ||
    ttsConfig?.baseUrl?.includes("127.0.0.1");
  const missingTtsKey =
    ttsConfig?.provider === "openai" && !ttsConfig?.hasKey && !isLocalTts;

  const motionSummary =
    motion.mode === "off"
      ? "Static frames"
      : motion.mode === "zoom"
        ? "Zoom moves"
        : motion.mode === "pan"
          ? "Pan moves"
          : "Smart motion";
  const transitionSummary = `${
    transition.style ? transition.style.replace(/-/g, " ") : "fade"
  } transitions`;

  return (
    <div className="grid lg:grid-cols-12 gap-5">
      {/* Left — configuration (guided brief, T-4.3) */}
      <Card className="glass rounded-2xl p-5 lg:col-span-5 h-fit lg:sticky lg:top-24">
        <div className="flex items-center gap-2 mb-4">
          <div className="h-9 w-9 rounded-xl bg-brand-gradient flex items-center justify-center glow-red-soft shrink-0">
            <Wand2 className="h-4.5 w-4.5 text-white" />
          </div>
          <div>
            <h2 className="font-semibold leading-tight">Video Blueprint</h2>
            <p className="text-xs text-muted-foreground">
              A guided brief · step {step + 1} of {STEPS.length}
            </p>
          </div>
        </div>

        {/* Step rail — click a completed step to revisit it */}
        <nav aria-label="Brief steps" className="mb-4">
          <ol className="grid grid-cols-4 gap-1.5">
            {STEPS.map((s, i) => {
              const state = i === step ? "current" : i < step ? "done" : "todo";
              return (
                <li key={s.label}>
                  <button
                    type="button"
                    disabled={busy || i > step}
                    onClick={() => setStep(i)}
                    aria-current={state === "current" ? "step" : undefined}
                    className={clsx(
                      "tf-focusable w-full rounded-xl border px-2 py-2 text-left transition-colors",
                      state === "current" && "border-primary/50 bg-primary/10",
                      state === "done" && "border-white/12 bg-white/4 hover:bg-white/8",
                      state === "todo" && "border-white/8 bg-transparent opacity-50",
                    )}
                  >
                    <span
                      className={clsx(
                        "flex items-center gap-1.5 text-[11px] font-semibold leading-none",
                        state === "current" ? "text-primary" : "text-white/70",
                      )}
                    >
                      <span
                        className={clsx(
                          "h-4.5 w-4.5 rounded-full flex items-center justify-center text-[10px] shrink-0",
                          state === "current" && "bg-primary text-white",
                          state === "done" && "bg-emerald-400/20 text-emerald-300 border border-emerald-400/40",
                          state === "todo" && "bg-white/8 text-white/50 border border-white/12",
                        )}
                      >
                        {state === "done" ? <Check className="h-3 w-3" /> : i + 1}
                      </span>
                      {s.label}
                    </span>
                    <span className="block text-[9.5px] text-muted-foreground mt-1 truncate">
                      {s.hint}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        {/* Draft-restored banner (T-4.3) */}
        {draftRestored && !video && (
          <div className="mb-4 flex items-center gap-2.5 rounded-xl border border-amber-400/25 bg-amber-400/8 px-3.5 py-2.5">
            <RotateCcw className="h-3.5 w-3.5 text-amber-300 shrink-0" />
            <p className="flex-1 min-w-0 text-xs text-amber-200/90 leading-snug">
              Brief draft restored from your last visit.
            </p>
            <button
              type="button"
              onClick={discardDraft}
              className="tf-focusable text-xs font-medium text-amber-200 hover:text-white underline underline-offset-2 shrink-0"
            >
              Discard
            </button>
          </div>
        )}

          {step === 0 && (
            <>
          <SectionLabel
            title="What are you making?"
            hint="Choose the type of video first — every later step adapts to it"
          />
          <div className="grid grid-cols-2 gap-2.5">
            {VIDEO_TYPES.map((t) => {
              const active =
                t.id === "classic"
                  ? format === "script"
                  : format === "story" &&
                    (t.renderMode === renderMode ||
                      (t.id === "story" && (renderMode === "kenburns" || renderMode === "stock")));
              const Icon = t.icon;
              return (
                <button
                  key={t.id}
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setFormat(t.format);
                    setRenderMode(t.renderMode);
                  }}
                  className={clsx(
                    "rounded-xl border p-4 text-left transition-all",
                    active
                      ? "border-primary/50 bg-primary/8 glow-red-soft"
                      : "border-white/10 bg-white/3 hover:border-white/25",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Icon className={clsx("h-4 w-4", t.accent)} />
                    <span className="text-sm font-medium">{t.title}</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-1.5 leading-snug">
                    {t.desc}
                  </p>
                </button>
              );
            })}
          </div>
          <p className="text-[11px] text-muted-foreground leading-relaxed pt-1">
            Nothing is generated yet — this only sets what the brief builds.
            You can still fine-tune the render style on the next steps.
          </p>
            </>
          )}

        <div className="space-y-4">
          {step === 1 && (
            <>
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

          {/* Paste-your-own-script block — toggled on shows a textarea that
              replaces AI generation. Used to bypass GLM and ship your own
              copy verbatim into the pipeline. */}
          <div className="rounded-xl border border-white/10 bg-white/3 overflow-hidden">
            <button
              type="button"
              disabled={busy}
              onClick={() => setUseOwnScript((v) => !v)}
              className={clsx(
                "w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left transition-colors",
                useOwnScript
                  ? "bg-primary/8 hover:bg-primary/10"
                  : "hover:bg-white/4",
              )}
              aria-expanded={useOwnScript}
            >
              <div className="flex items-center gap-2">
                <FileText
                  className={clsx(
                    "h-3.5 w-3.5",
                    useOwnScript ? "text-primary" : "text-muted-foreground",
                  )}
                />
                <span className="text-sm font-medium">Use my own script</span>
                {useOwnScript && (
                  <Badge
                    variant="outline"
                    className="border-primary/40 bg-primary/10 text-primary text-[10px] font-normal"
                  >
                    skips AI
                  </Badge>
                )}
              </div>
              <ChevronDown
                className={clsx(
                  "h-4 w-4 text-muted-foreground transition-transform",
                  useOwnScript && "rotate-180",
                )}
              />
            </button>

            {useOwnScript && (
              <div className="p-3 pt-0 space-y-2.5">
                <Textarea
                  placeholder="Paste your narration here — Auto-Pilot will skip AI generation and use this text verbatim. Title still comes from the topic above. Edit anytime after creation."
                  value={customScript}
                  onChange={(e) => setCustomScript(e.target.value)}
                  rows={8}
                  maxLength={50000}
                  disabled={busy}
                  className="bg-white/5 resize-y font-mono text-[13px] leading-relaxed min-h-[180px]"
                />
                <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>
                    {customScript.trim() ? (
                      <>
                        {customScript.trim().split(/\s+/).filter(Boolean).length} words · {customScript.length.toLocaleString()} chars
                      </>
                    ) : (
                      <>Empty — paste something to enable generation</>
                    )}
                  </span>
                  {customScript && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setCustomScript("")}
                      className="text-muted-foreground hover:text-foreground transition-colors"
                    >
                      Clear
                    </button>
                  )}
                </div>
                {isStory && (
                  <Alert className="border-amber-500/30 bg-amber-500/5 py-2">
                    <AlertDescription className="text-[11px] text-amber-200/90 leading-relaxed">
                      Custom scripts work with the <strong>Classic</strong> format only — Story mode needs AI to split your text into scenes. Switch the format below or toggle this off.
                    </AlertDescription>
                  </Alert>
                )}

                {/* Analyze button — visible only for Classic format (custom
                    script + story is blocked earlier). The engine must review
                    the script before the user can create a video from it. */}
                {!isStory && customScript.trim() && (
                  <div className="space-y-2.5 pt-1">
                    <Button
                      type="button"
                      size="sm"
                      onClick={analyzeCustomScript}
                      disabled={busy || analysisState === "analyzing"}
                      className="w-full bg-brand-gradient hover:opacity-90 font-medium gap-2"
                    >
                      {analysisState === "analyzing" ? (
                        <>
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          Analyzing script…
                        </>
                      ) : (
                        <>
                          <Sparkles className="h-3.5 w-3.5" />
                          {analysisState === "done" ? "Re-analyze script" : "Analyze script"}
                        </>
                      )}
                    </Button>

                    {/* Analysis report — appears after the engine returns. */}
                    {analysisState === "done" && analysisReport && (
                      <AnalysisReportCard
                        report={analysisReport}
                        approved={scriptApproved}
                        onApprove={() => setScriptApproved(true)}
                        onRevoke={() => setScriptApproved(false)}
                      />
                    )}

                    {analysisState === "error" && analysisError && (
                      <Alert className="border-rose-500/30 bg-rose-500/5 py-2">
                        <AlertDescription className="text-[11px] text-rose-200/90 leading-relaxed">
                          Analysis failed: {analysisError}
                        </AlertDescription>
                      </Alert>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          </>
          )}

          {step === 2 && (
            <>
          <SectionLabel
            title="Shape, tone & rendering"
            hint="Length and tone — the render style for scene stories"
          />
          {isStory && (
            <div className="space-y-1.5 rounded-xl border border-white/10 bg-white/3 p-3">
              <div className="flex items-center justify-between">
                <Label>Rendering style</Label>
                <Badge
                  variant="outline"
                  className="border-white/15 bg-white/5 text-muted-foreground text-[10px]"
                >
                  {sceneCount} scenes ·{" "}
                  {LENGTHS.find((l) => l.id === length)?.label ?? length}
                </Badge>
              </div>
              <div className="grid grid-cols-2 gap-2">
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
                        : "border-white/10 bg-white/3 hover:border-white/25",
                    )}
                  >
                    <div className="flex items-center gap-1.5">
                      {m.id === "kenburns" ? (
                        <Zap className="h-3.5 w-3.5 text-amber-300" />
                      ) : m.id === "stock" ? (
                        <Film className="h-3.5 w-3.5 text-emerald-300" />
                      ) : m.id === "slides" ? (
                        <Presentation className="h-3.5 w-3.5 text-violet-300" />
                      ) : (
                        <Clapperboard className="h-3.5 w-3.5 text-sky-300" />
                      )}
                      <span className="text-[13px] font-medium">{m.label}</span>
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-1 leading-snug">
                      {m.desc}
                    </p>
                  </button>
                ))}
              </div>
              {renderMode === "animated" && (
                <p className="text-[11px] text-sky-300/90 leading-relaxed">
                  Auto-Pilot renders the full animated video — every scene is
                  animated via image-to-video (~4 min per scene, tracked live).
                </p>
              )}
              {renderMode === "slides" && (
                <p className="text-[11px] text-violet-300/90 leading-relaxed">
                  Auto-Pilot designs a keynote slide deck from your script — one
                  huge-typography beat per scene, rendered vertical 9:16 with no
                  image generation. Pairs best with hard-cut transitions.
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
          </>
          )}

          {step === 3 && (
            <>
          <SectionLabel
            title="Script & narration"
            hint="What gets written and who reads it"
          />

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
          </div>

          <div className="space-y-1.5">
            <Label>Narrator voice</Label>
            <VoiceSelectWithPreview
              value={voice}
              onValueChange={setVoice}
              voices={voices}
              disabled={busy}
            />
            {missingTtsKey ? (
              <Alert variant="destructive" className="py-2.5 px-3">
                <AlertDescription className="text-xs leading-relaxed">
                  No API key set for the openai voiceover provider — add it in
                  Settings → AI Providers.
                </AlertDescription>
              </Alert>
            ) : (
              <p className="text-[10px] text-muted-foreground leading-relaxed">
                Tap the <span className="text-primary">▶</span> next to a voice
                to hear how it sounds before picking. Not feeling these voices?
                After creating, open the video&apos;s Package tab →{" "}
                <span className="text-foreground/80">Change the voice</span> to
                upload your own audio or paste a voice link from the internet.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Speech speed</Label>
              <span className="text-xs font-medium tabular-nums text-primary">
                {speed.toFixed(1)}x
              </span>
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

          {isStory && (
            <>
              <SectionLabel
                title="Art direction"
                hint="Camera movement, transitions, thumbnail look & music"
              />

              <Collapsible open={showAdvanced} onOpenChange={setShowAdvanced}>
                <div
                  className={clsx(
                    "rounded-xl border transition-colors",
                    showAdvanced
                      ? "border-primary/30 bg-primary/[0.06]"
                      : "border-white/10 bg-white/[0.03] hover:border-white/25",
                  )}
                >
                  <CollapsibleTrigger asChild>
                    <button
                      type="button"
                      className="w-full flex items-center gap-2.5 px-3.5 py-3 text-left"
                      aria-expanded={showAdvanced}
                    >
                      <Sparkles className="h-4 w-4 text-primary shrink-0" />
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm font-medium leading-tight">
                          Camera moves & transitions
                        </span>
                        <span className="block text-[11px] text-muted-foreground truncate">
                          {motionSummary} · {transitionSummary} — tap to adjust
                        </span>
                      </span>
                      <ChevronDown
                        className={clsx(
                          "h-4 w-4 text-muted-foreground transition-transform shrink-0",
                          showAdvanced && "rotate-180",
                        )}
                      />
                    </button>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="p-3.5 pt-1 space-y-4">
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
                    <TransitionControlsCard value={transition} onChange={setTransition} compact disabled={busy} />
                  </CollapsibleContent>
                </div>
              </Collapsible>
            </>
          )}

          <div className="space-y-1.5">
            <Label>Thumbnail style</Label>
            <Select
              value={thumbStyle}
              onValueChange={setThumbStyle}
              disabled={busy}
            >
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

          <MusicPickerCard
            value={music}
            onChange={setMusic}
            compact={isStory}
          />
          </>
          )}

          {step === 3 && (
            <>
          {/* Review summary — the whole brief at a glance before launch */}
          <div className="rounded-xl border border-white/10 bg-white/3 p-3.5">
            <p className="tf-kicker mb-2.5">Your brief</p>
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="outline" className="border-white/15 bg-white/5 text-white/80 text-[11px]">
                {isStory ? "Scene story" : "Classic narration"}
              </Badge>
              {isStory && (
                <Badge variant="outline" className="border-white/15 bg-white/5 text-white/80 text-[11px]">
                  {RENDER_MODES.find((m) => m.id === renderMode)?.label ?? renderMode}
                </Badge>
              )}
              <Badge variant="outline" className="border-white/15 bg-white/5 text-white/80 text-[11px]">
                {niche} · {TONES.find((t) => t.id === tone)?.label ?? tone}
              </Badge>
              <Badge variant="outline" className="border-white/15 bg-white/5 text-white/80 text-[11px]">
                {LENGTHS.find((l) => l.id === length)?.label ?? length}
                {isStory ? ` · ${sceneCount} scenes` : ""}
              </Badge>
              <Badge variant="outline" className="border-white/15 bg-white/5 text-white/80 text-[11px]">
                {voice} · {speed.toFixed(1)}x
              </Badge>
              {isStory && (
                <Badge variant="outline" className="border-white/15 bg-white/5 text-white/80 text-[11px]">
                  {motionSummary} · {transitionSummary}
                </Badge>
              )}
              {music.enabled !== false && (
                <Badge variant="outline" className="border-white/15 bg-white/5 text-white/80 text-[11px]">
                  {music.trackId ? "Pinned track" : "Mood-matched music"}
                </Badge>
              )}
              {castCharacter && (
                <Badge variant="outline" className="border-emerald-400/30 bg-emerald-400/10 text-emerald-300 text-[11px]">
                  Host: {castCharacter.name}
                </Badge>
              )}
              {channelId !== "none" && (
                <Badge variant="outline" className="border-white/15 bg-white/5 text-white/80 text-[11px]">
                  {channels.find((c) => c.id === channelId)?.name ?? "Channel"}
                </Badge>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground mt-2.5 leading-snug">
              {useOwnScript
                ? "Your pasted script ships verbatim (AI analysis approved)."
                : "AI writes the script from your topic, then the pipeline runs."}
            </p>
          </div>

          <SectionLabel
            title="Destination"
            hint="Where the video lands, and who hosts it"
          />

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Channel (optional)</Label>
              <Select
                value={channelId}
                onValueChange={setChannelId}
                disabled={busy}
              >
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
              <Select
                value={characterId}
                onValueChange={applyCastVoice}
                disabled={busy}
              >
                <SelectTrigger className="bg-white/5">
                  <SelectValue placeholder="No recurring host" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No recurring host</SelectItem>
                  {characters.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                      {c.hasPortrait ? " ●" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {castCharacter && (
                <p className="text-[11px] text-emerald-300/90 leading-relaxed">
                  {castCharacter.name} hosts this video — identity is stamped
                  into the storyboard and thumbnail, and the voice defaults to
                  their persona.
                </p>
              )}
            </div>
          </div>

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
          </>
          )}
        </div>

        {/* Step navigation (T-4.3) — Back / Next; step 4 launches above */}
        <div className="mt-5 pt-4 border-t border-white/8 flex items-center gap-2.5">
          {step > 0 ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => setStep((s) => Math.max(0, s - 1))}
              disabled={busy}
              className="border-white/15 bg-white/4 hover:bg-white/10"
            >
              <ChevronLeft className="h-4 w-4" />
              Back
            </Button>
          ) : (
            <p className="text-[11px] text-muted-foreground leading-snug">
              The blueprint saves itself — leave and pick up where you left off.
            </p>
          )}
          <div className="flex-1" />
          {step < STEPS.length - 1 ? (
            <Button
              type="button"
              onClick={() => setStep((s) => s + 1)}
              disabled={!stepValid || busy}
              className="bg-brand-gradient hover:opacity-90 font-semibold"
            >
              Next: {STEPS[step + 1].label}
              <ChevronRight className="h-4 w-4" />
            </Button>
          ) : (
            <p className="text-[11px] text-muted-foreground text-right leading-snug">
              Review the brief, then launch above.
            </p>
          )}
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

          <ol
            className={clsx(
              "grid gap-3",
              stages.length > 3
                ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-5"
                : "sm:grid-cols-3",
            )}
          >
            {stages.map((stage, i) => {
              const state = stageState[stage];
              const def = STAGE_DEFS[stage];
              return (
                <li
                  key={stage}
                  className={clsx(
                    "rounded-xl border p-3.5 transition-all duration-300",
                    state === "done" &&
                      "border-emerald-500/25 bg-emerald-500/6",
                    state === "running" &&
                      "border-primary/40 bg-primary/8 glow-red-soft",
                    state === "error" && "border-red-500/30 bg-red-500/6",
                    state === "idle" && "border-white/8 bg-white/3",
                  )}
                >
                  <div className="flex items-center justify-between">
                    <div
                      className={clsx(
                        "h-8 w-8 rounded-lg flex items-center justify-center shrink-0",
                        state === "done" &&
                          "bg-emerald-500/15 text-emerald-300",
                        state === "running" && "bg-primary/15 text-primary",
                        state === "error" && "bg-red-500/15 text-red-300",
                        state === "idle" && "bg-white/6 text-muted-foreground",
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
              Configure the blueprint on the left and launch Auto-Pilot. Results
              will stream in here stage by stage.
            </p>
          </Card>
        )}

        {anyRunning && !video && (
          <Card className="glass rounded-2xl p-5 space-y-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              AI is writing your script…
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
                    <Badge
                      variant="outline"
                      className="border-white/15 bg-white/5 text-muted-foreground"
                    >
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
                        {s.imageUrl ? (
                          <img
                            src={s.imageUrl}
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
                      {voices.find((v) => v.id === video.voice)?.label ??
                        VOICES.find((v) => v.id === video.voice)?.label ??
                        video.voice}
                    </span>
                  </div>
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
              <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
                <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">
                  {isStory ? "Scene Narration" : "Full Script"}
                </p>
                <div className="flex items-center gap-2">
                  {video.description && !editingScript && (
                    <Badge
                      variant="outline"
                      className="border-white/15 bg-white/5 text-muted-foreground"
                    >
                      SEO description included
                    </Badge>
                  )}
                  {!editingScript && video.script && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={copyScript}
                        disabled={busy}
                        className="h-7 gap-1.5 border-white/15 bg-white/5 text-xs"
                      >
                        {justCopied ? (
                          <Check className="h-3.5 w-3.5 text-emerald-400" />
                        ) : (
                          <ClipboardCopy className="h-3.5 w-3.5" />
                        )}
                        {justCopied ? "Copied" : "Copy"}
                      </Button>
                      {!isStory && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={startEditScript}
                          disabled={busy || scriptSaving}
                          className="h-7 gap-1.5 border-white/15 bg-white/5 text-xs"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                          Edit
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </div>

              {editingScript ? (
                <div className="space-y-3">
                  <Textarea
                    value={draftScript}
                    onChange={(e) => setDraftScript(e.target.value)}
                    rows={12}
                    maxLength={50000}
                    disabled={scriptSaving}
                    autoFocus
                    className="bg-white/5 resize-y font-mono text-[13px] leading-relaxed min-h-[280px]"
                  />
                  <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>
                      {draftScript.trim().split(/\s+/).filter(Boolean).length} words · {draftScript.length.toLocaleString()} chars
                    </span>
                    {video.hasVoiceover && (
                      <span className="text-amber-300/80">
                        ⚠ Existing voiceover &amp; render will be reset if you change the script
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      onClick={saveScript}
                      disabled={scriptSaving || !draftScript.trim()}
                      className="bg-brand-gradient hover:opacity-90 font-medium gap-1.5"
                    >
                      {scriptSaving ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Save className="h-3.5 w-3.5" />
                      )}
                      {scriptSaving ? "Saving…" : "Save script"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setEditingScript(false);
                        setDraftScript("");
                      }}
                      disabled={scriptSaving}
                      className="border-white/15 bg-white/5 text-xs"
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="max-h-72 overflow-y-auto scroll-area-bar pr-3 text-sm leading-relaxed whitespace-pre-wrap text-foreground/90">
                  {video.script}
                </div>
              )}

              {isStory && !editingScript && (
                <p className="mt-3 text-[11px] text-muted-foreground/80 leading-relaxed">
                  Scene-by-scene narration lives in the Storyboard — open the Scene Editor to tweak individual scene lines.
                </p>
              )}

              {tags.length > 0 && !editingScript && (
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
                  <p className="text-sm font-medium mb-1">
                    Continue the pipeline
                  </p>
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
                        className={clsx(
                          isStory && video.hasStoryboard
                            ? "bg-brand-gradient hover:opacity-90 font-medium"
                            : "border-white/15 bg-white/4",
                        )}
                        variant={
                          isStory && video.hasStoryboard ? "default" : "outline"
                        }
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
                    {isStory &&
                      !video.hasVideo &&
                      video.hasStoryboard &&
                      video.hasVoiceover && (
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

// --------------------------------------------------------------------------- //
// AnalysisReportCard — shows the engine's verdict on a pasted script.
// Verdict colors: approved → emerald, needs_revision → amber, rejected → rose.
// Each issue shows severity icon + category + message + optional suggestion.
// The Approve/Revoke toggle is the user's manual accept/reject of the verdict.
// --------------------------------------------------------------------------- //

function AnalysisReportCard({
  report,
  approved,
  onApprove,
  onRevoke,
}: {
  report: any;
  approved: boolean;
  onApprove: () => void;
  onRevoke: () => void;
}) {
  if (!report) return null;
  const verdict = report.verdict as "approved" | "needs_revision" | "rejected";
  const score = Math.max(0, Math.min(100, Number(report.score) || 0));
  const summary = String(report.summary ?? "");
  const strengths: string[] = Array.isArray(report.strengths) ? report.strengths : [];
  const issues: any[] = Array.isArray(report.issues) ? report.issues : [];
  const recommendations: string[] = Array.isArray(report.recommendations)
    ? report.recommendations
    : [];
  const wordCount = Number(report.wordCount) || 0;
  const estimatedDurationSec = Number(report.estimatedDurationSec) || 0;
  const durationMs = Number(report.durationMs) || 0;

  const verdictColor =
    verdict === "approved"
      ? "border-emerald-500/40 bg-emerald-500/8"
      : verdict === "needs_revision"
      ? "border-amber-500/40 bg-amber-500/8"
      : "border-rose-500/40 bg-rose-500/8";
  const verdictText =
    verdict === "approved"
      ? "text-emerald-300"
      : verdict === "needs_revision"
      ? "text-amber-300"
      : "text-rose-300";
  const verdictLabel =
    verdict === "approved" ? "Approved" : verdict === "needs_revision" ? "Needs revision" : "Rejected";

  // Format duration for display (e.g. "1m 30s" or "30s")
  const fmtDur = (sec: number) => {
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return s ? `${m}m ${s}s` : `${m}m`;
  };

  return (
    <div className={`rounded-xl border ${verdictColor} p-3 space-y-3`}>
      {/* Header — verdict, score, summary */}
      <div className="flex items-start gap-3">
        <div className="shrink-0 mt-0.5">
          {verdict === "approved" ? (
            <Check className="h-5 w-5 text-emerald-400" />
          ) : verdict === "needs_revision" ? (
            <Sparkles className="h-5 w-5 text-amber-400" />
          ) : (
            <X className="h-5 w-5 text-rose-400" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <p className={`text-sm font-semibold ${verdictText}`}>{verdictLabel}</p>
            <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
              <span>{wordCount} words</span>
              <span>·</span>
              <span>~{fmtDur(estimatedDurationSec)} narration</span>
              {durationMs > 0 && (
                <>
                  <span>·</span>
                  <span>{(durationMs / 1000).toFixed(1)}s engine</span>
                </>
              )}
            </div>
          </div>
          {summary && (
            <p className="text-[12px] text-foreground/85 leading-relaxed mt-1">
              {summary}
            </p>
          )}
          {/* Score bar */}
          <div className="mt-2 h-1.5 rounded-full bg-white/5 overflow-hidden">
            <div
              className={`h-full rounded-full ${
                verdict === "approved"
                  ? "bg-emerald-500"
                  : verdict === "needs_revision"
                  ? "bg-amber-500"
                  : "bg-rose-500"
              }`}
              style={{ width: `${score}%` }}
            />
          </div>
          <p className="text-[10px] text-muted-foreground mt-1">
            Engine score: <span className={verdictText}>{score}/100</span>
          </p>
        </div>
      </div>

      {/* Strengths */}
      {strengths.length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1.5">
            Strengths
          </p>
          <ul className="space-y-1">
            {strengths.map((s, i) => (
              <li key={i} className="flex items-start gap-1.5 text-[12px] text-emerald-200/90 leading-relaxed">
                <Check className="h-3 w-3 mt-0.5 shrink-0 text-emerald-400/80" />
                <span>{s}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Issues */}
      {issues.length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1.5">
            Issues ({issues.length})
          </p>
          <ul className="space-y-1.5">
            {issues.map((issue, i) => {
              const sev = issue.severity as "blocker" | "warning" | "note";
              const sevColor =
                sev === "blocker"
                  ? "text-rose-300"
                  : sev === "warning"
                  ? "text-amber-300"
                  : "text-sky-300";
              const sevLabel =
                sev === "blocker" ? "Blocker" : sev === "warning" ? "Warning" : "Note";
              return (
                <li
                  key={i}
                  className="rounded-lg border border-white/8 bg-white/3 p-2 text-[12px] leading-relaxed"
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge
                      variant="outline"
                      className={`border-current/30 bg-transparent ${sevColor} text-[10px] font-normal py-0`}
                    >
                      {sevLabel}
                    </Badge>
                    <span className="text-muted-foreground text-[10px] uppercase tracking-wider">
                      {String(issue.category).replace(/_/g, " ")}
                    </span>
                  </div>
                  <p className="mt-1 text-foreground/90">{String(issue.message)}</p>
                  {issue.suggestion && (
                    <p className="mt-1 text-muted-foreground text-[11px] italic">
                      → {String(issue.suggestion)}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Recommendations */}
      {recommendations.length > 0 && (
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1.5">
            Recommendations
          </p>
          <ul className="space-y-1">
            {recommendations.map((r, i) => (
              <li key={i} className="flex items-start gap-1.5 text-[12px] text-foreground/85 leading-relaxed">
                <Sparkles className="h-3 w-3 mt-0.5 shrink-0 text-amber-400/80" />
                <span>{r}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Approve / Revoke toggle */}
      <div className="pt-2 border-t border-white/8 flex items-center justify-between gap-3 flex-wrap">
        <p className="text-[11px] text-muted-foreground leading-relaxed">
          {approved ? (
            <span className="text-emerald-300">✓ Approved — you can generate the video.</span>
          ) : verdict === "rejected" ? (
            <span className="text-rose-300">✗ Engine rejected — edit the script and re-analyze.</span>
          ) : verdict === "needs_revision" ? (
            <span className="text-amber-300">Engine flagged issues. Approve anyway or edit and re-analyze.</span>
          ) : (
            <span className="text-emerald-300">Engine approved automatically.</span>
          )}
        </p>
        {verdict !== "approved" && (
          <Button
            type="button"
            size="sm"
            onClick={approved ? onRevoke : onApprove}
            disabled={verdict === "rejected"}
            className={
              approved
                ? "border border-white/15 bg-white/5 text-xs"
                : "bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-200 text-xs"
            }
            variant={approved ? "outline" : "default"}
          >
            {approved ? "Revoke approval" : "Approve anyway"}
          </Button>
        )}
      </div>
    </div>
  );
}
