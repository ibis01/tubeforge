"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore } from "@/lib/store";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusBadge, formatDuration, timeAgo, useVoices, VoiceSelectWithPreview, VOICES_CHANGED_EVENT, Kbd } from "@/components/tubeforge/shared";
import { MusicPickerCard, type MusicPickerValue } from "@/components/tubeforge/music-controls";
import { MotionControlsCard, type MotionPickerValue } from "@/components/tubeforge/motion-controls";
import { TransitionControlsCard, type TransitionPickerValue } from "@/components/tubeforge/transition-controls";
import { InlineCloneSetup } from "@/components/tubeforge/inline-clone-setup";
import { BrandKitCard } from "@/components/tubeforge/brand-kit";
import { SceneEditorDialog } from "@/components/tubeforge/scene-editor";
import { DirectorCard } from "@/components/tubeforge/director-card";
import { TimelineStudio } from "@/components/tubeforge/timeline-studio";
import { CircleCheck, CircleX, CircleHelp, Ban, Brush } from "lucide-react";
import {
  pollVoiceover,
  pollThumbnail,
  pollVariants,
  pollStoryboard,
  pollRender,
  pollScene,
  pollSlide,
  pollVerify,
  pollComments,
  pollShort,
  pollConvert,
  pollScript,
} from "@/lib/tubeforge/poll";
import {
  VOICES,
  LENGTHS,
  RENDER_MODES,
  type VideoDTO,
  type VariantDTO,
  type SceneDTO,
  type SlideDTO,
  type VerifyReportDTO,
  type CommentsKitDTO,
  type YouTubeStatusDTO,
  type AssembledTimelineDTO,
} from "@/lib/tubeforge/types";
import { EXPORT_PRESETS, type ExportPreset } from "@/lib/tubeforge/studio-doc";
import {
  Mic,
  ImageIcon,
  Rocket,
  Loader2,
  Trash2,
  FileText,
  Tag,
  Download,
  CalendarPlus,
  FlaskConical,
  Check,
  UserRound,
  LayoutGrid,
  Clapperboard,
  Presentation,
  RefreshCw,
  Zap,
  Eye,
  ScanText,
  MessageCircle,
  Copy,
  Youtube,
  ExternalLink,
  Captions,
  Smartphone,
  Upload,
  Link2,
  AudioLines,
  Bot,
  ChevronDown,
  Wand2,
  Play,
  Square,
  Package,
} from "lucide-react";
import { clsx } from "clsx";

/** T-4.12 — QC checks grouped for the scorecard (ids from qc.ts runQcReport).
 *  Anything not listed lands in an "Other" group so future checks still show. */
const QC_GROUPS: { title: string; ids: string[] }[] = [
  {
    title: "Video",
    ids: ["playable", "aspect", "black-frames", "frozen-frames", "static-shots", "tail-fade"],
  },
  { title: "Audio", ids: ["loudness", "true-peak", "loudness-range", "dead-air"] },
  { title: "Sync", ids: ["duration", "captions"] },
];

/** QC checks store a three-state status (qc.ts); older reports predate it.
 * Fall back to the legacy boolean so pre-upgrade reports still render. */
function qcCheckStatus(c: { status?: "pass" | "fail" | "unmeasured"; pass: boolean }) {
  return c.status ?? (c.pass ? "pass" : "fail");
}

interface StoryboardResponse {
  scenes: SceneDTO[];
  complete: boolean;
  generating: boolean;
  error: string | null;
}

export function VideoDetailDialog({
  video,
  onClose,
  onChanged,
  onDeleted,
}: {
  video: VideoDTO | null;
  onClose: () => void;
  onChanged: (v: VideoDTO) => void;
  onDeleted: (id: string) => void;
}) {
  const { toast } = useToast();
  const bumpRefresh = useAppStore((s) => s.bumpRefresh);
  const setView = useAppStore((s) => s.setView);
  const setScheduleVideoId = useAppStore((s) => s.setScheduleVideoId);
  const setFocusVideoId = useAppStore((s) => s.setFocusVideoId);
  const [busy, setBusy] = useState<string | null>(null);
  const [variants, setVariants] = useState<VariantDTO[]>([]);

  // Storyboard state
  const [scenes, setScenes] = useState<SceneDTO[]>([]);
  const [boardGenerating, setBoardGenerating] = useState(false);

  // Keynote slides state — the designed deck (render mode "slides" only).
  // null = the deck hasn't been designed yet (no render / re-roll so far).
  const [slides, setSlides] = useState<SlideDTO[] | null>(null);

  // Render state
  const [renderMode, setRenderMode] = useState<string>("kenburns");
  const [subtitles, setSubtitles] = useState(true);
  const [smartCaps, setSmartCaps] = useState(true); // ASR-synced caption cues (Phase 4)
  // S3 — delivery encode tier for the next render (the export-preset picker
  // owns it; persisted on the timeline doc's renderPrefs between sessions).
  const [exportQuality, setExportQuality] = useState<"draft" | "standard" | "high">("standard");
  // Per-video music overrides (null = follow Settings defaults) — PATCHed with a
  // debounce so slider drags don't spam the API.
  const [musicDraft, setMusicDraft] = useState<MusicPickerValue>({
    enabled: null,
    trackId: null,
    volume: null,
    fadeIn: null,
    fadeOut: null,
    ducking: null,
    duckingIntensity: null,
    mood: null,
  });
  const musicPatchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Per-video Smart Motion (Ken Burns) overrides — same debounced PATCH pattern.
  const [motionDraft, setMotionDraft] = useState<MotionPickerValue>({
    mode: null,
    intensity: null,
    curve: null,
    vary: null,
  });
  const motionPatchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Per-video scene-transition overrides — same debounced PATCH pattern.
  const [transitionDraft, setTransitionDraft] = useState<TransitionPickerValue>({
    style: null,
    durationSec: null,
  });
  const transitionPatchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Scene Studio — which scene's editor dialog is open (null = closed).
  const [editingScene, setEditingScene] = useState<number | null>(null);
  // Stage 4a (T-4.5) — storyboard density: comfortable grid ↔ filmstrip.
  const [boardDensity, setBoardDensity] = useState<"grid" | "film">("grid");
  const [renderLabel, setRenderLabel] = useState<string | null>(null);

  // Narration check state (Phase 3 — ASR proofreading)
  const [verifyReport, setVerifyReport] = useState<VerifyReportDTO | null>(null);
  const [verifyRunning, setVerifyRunning] = useState(false);

  // Engagement kit state (Phase 4 — retention comments)
  const [commentsKit, setCommentsKit] = useState<CommentsKitDTO | null>(null);
  const [kitRunning, setKitRunning] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // YouTube ship state (S17 — the real publish flow). The old surface was a
  // fossil: "Upload to YouTube" fired /upload (a route that never existed —
  // a guaranteed 404) and "Publish" PATCHed status:"published" while a toast
  // claimed "added to the upload queue" — no queue, no upload. The real
  // machinery (POST /publish → runUploadJob) now gets a review-then-post
  // panel: channel, title, description, tags, privacy and schedule are
  // REVIEWED, one click ships, the job's progress drives the wait.
  const [ytStatus, setYtStatus] = useState<YouTubeStatusDTO | null>(null);
  const [pubOpen, setPubOpen] = useState(false);
  const [pubDefaults, setPubDefaults] = useState<{ privacyStatus: string } | null>(null);
  const [pubTitle, setPubTitle] = useState("");
  const [pubDesc, setPubDesc] = useState("");
  const [pubTags, setPubTags] = useState("");
  const [pubPrivacy, setPubPrivacy] = useState("unlisted");
  const [pubAt, setPubAt] = useState(""); // datetime-local string; empty = immediate
  const [pubBusy, setPubBusy] = useState(false);
  const [pubProgress, setPubProgress] = useState<string | null>(null);

  // QC re-run state (S17 — the pre-flight gate): the /qc route re-measures
  // the standing render WITHOUT paying for a re-render; the scorecard shows
  // the fresh report when the job lands.
  const [qcRerunning, setQcRerunning] = useState(false);

  // Bring-your-own-voice state — swap TTS voices for uploaded / internet audio
  const [voicePanelOpen, setVoicePanelOpen] = useState(false);
  const [voiceMode, setVoiceMode] = useState<"tts" | "upload" | "url" | "clone">("tts");
  const [voiceUrl, setVoiceUrl] = useState("");
  const [voiceFile, setVoiceFile] = useState<File | null>(null);
  const [pickedVoice, setPickedVoice] = useState<string>(video?.voice ?? "jam");
  const { voices, cloneStatus, cloneHint } = useVoices();

  // Voice cloning (Zhipu GLM-TTS-Clone) — clone a voice from a short sample,
  // then narrate with it like any studio voice.
  const [cloneFile, setCloneFile] = useState<File | null>(null);
  const [cloneName, setCloneName] = useState("");
  const [cloneSampleText, setCloneSampleText] = useState("");
  const [cloning, setCloning] = useState(false);
  // Fresh clones whose preview is still synthesizing on the (CPU-bound) voice
  // server — polled until GET /api/voices/{id}/audition answers 200, then the
  // ▶ on the clone unlocks automatically.
  const [pendingAuditions, setPendingAuditions] = useState<string[]>([]);
  const [cloneProfiles, setCloneProfiles] = useState<
    { id: string; name: string; providerVoiceId: string; durationSec: number | null; hasAudition: boolean; createdAt: string }[]
  >([]);
  const [auditionPlaying, setAuditionPlaying] = useState<string | null>(null);
  const auditionRef = useRef<HTMLAudioElement | null>(null);

  // Keep the picked voice inside the ACTIVE provider's catalog (switching the
  // voiceover provider in Settings can invalidate the stored voice).
  useEffect(() => {
    if (voices.length && !voices.some((v) => v.id === pickedVoice)) {
      setPickedVoice(voices[0].id);
    }
  }, [voices, pickedVoice]);

  useEffect(() => {
    if (video) setPickedVoice(video.voice);
  }, [video?.id, video?.voice]);

  // Auto-Short state (Phase 5 — 9:16 vertical cut)
  const [shortScenePick, setShortScenePick] = useState<number | "auto">("auto");
  const [shortRunning, setShortRunning] = useState(false);

  const isStory = video?.format === "story";

  const reloadScenes = useCallback(async (videoId: string) => {
    try {
      const res = await fetch(`/api/videos/${videoId}/storyboard`, { cache: "no-store" });
      if (!res.ok) return;
      const data: StoryboardResponse = await res.json();
      setScenes(data.scenes ?? []);
      setBoardGenerating(Boolean(data.generating));
    } catch {
      /* non-fatal */
    }
  }, []);

  // Keynote slides — deck DTOs (slide designs + PNG previews). Non-fatal:
  // the storyboard grid falls back to scene art whenever this is null.
  const reloadSlides = useCallback(async (videoId: string) => {
    try {
      const res = await fetch(`/api/videos/${videoId}/slides`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { slides?: SlideDTO[] | null };
      setSlides(data.slides ?? null);
    } catch {
      /* non-fatal */
    }
  }, []);

  const refreshVideo = useCallback(
    async (videoId: string) => {
      const res = await fetch(`/api/videos/${videoId}`, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        if (data.video) onChanged(data.video);
      }
    },
    [onChanged]
  );

  // Load A/B variants + storyboard whenever the open video changes
  useEffect(() => {
    if (!video?.id) {
      setVariants([]);
      setScenes([]);
      setSlides(null);
      return;
    }
    let cancelled = false;
    setRenderMode(video.renderMode ?? "kenburns");
    setMusicDraft({
      enabled: video.musicEnabled ?? null,
      trackId: video.musicTrackId ?? null,
      volume: video.musicVolume ?? null,
      fadeIn: video.musicFadeIn ?? null,
      fadeOut: video.musicFadeOut ?? null,
      ducking: video.musicDucking ?? null,
      duckingIntensity: video.musicDuckingIntensity ?? null,
      mood: video.musicMood && video.musicMood !== "auto" ? video.musicMood : null,
    });
    setMotionDraft({
      mode: video.motionMode ?? null,
      intensity: video.motionIntensity ?? null,
      curve: video.motionCurve ?? null,
      vary: video.motionVary ?? null,
    });
    setTransitionDraft({
      style: video.transitionStyle ?? null,
      durationSec: video.transitionDuration ?? null,
    });
    setEditingScene(null);
    setRenderLabel(null);
    setVerifyReport(null);
    setVerifyRunning(false);
    setCommentsKit(null);
    setKitRunning(false);
    setPubOpen(false); // fresh ship surface per video (S17 — replaces the dead setUploading)
    setPubBusy(false);
    setPubProgress(null);
    setPubDefaults(null);
    setQcRerunning(false);
    setCopiedKey(null);
    setShortScenePick("auto");
    setShortRunning(false);
    setExportQuality(video.timeline?.renderPrefs?.quality ?? "standard");
    fetch(`/api/videos/${video.id}/verify`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d?.report) setVerifyReport(d.report);
      })
      .catch(() => {});
    fetch(`/api/videos/${video.id}/comments`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d?.kit) setCommentsKit(d.kit);
      })
      .catch(() => {});
    fetch(`/api/youtube/status`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d?.status) setYtStatus(d.status);
      })
      .catch(() => {});
    fetch(`/api/videos/${video.id}/variants`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d?.variants) setVariants(d.variants);
      })
      .catch(() => {});
    // Adopt a script (re)generation already in flight (survives dialog re-opens).
    fetch(`/api/videos/${video.id}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then(async (d) => {
        if (cancelled || !d?.generating?.script) return;
        setBusy("script");
        try {
          const done = await pollScript(video.id, { timeoutMs: 10 * 60 * 1000 });
          if (!cancelled) {
            onChanged(done);
            if (done.format === "story") reloadScenes(done.id);
          }
        } catch {
          if (!cancelled) await refreshVideo(video.id).catch(() => {});
        } finally {
          if (!cancelled) setBusy(null);
        }
      })
      .catch(() => {});
    if (video.format === "story") {
      reloadScenes(video.id);
      if (video.renderMode === "slides") reloadSlides(video.id);
      // Adopt any render already in flight (survives dialog re-opens).
      fetch(`/api/videos/${video.id}/render`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!cancelled && d?.rendering) setRenderLabel("Rendering in progress…");
        })
        .catch(() => {});
      // Adopt any Short cut already in flight (Phase 5).
      fetch(`/api/videos/${video.id}/short`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!cancelled && d?.generating) setShortRunning(true);
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [video?.id]);

  // ---------- Voice cloning: upload a sample → narrate in that voice ----------
  // Cloning happens synchronously on the server (sample → Zhipu → voice id,
  // typically 10-30s); the button shows progress the whole time.
  // Hooks must live BEFORE the `if (!video) return null;` early return.

  const loadCloneProfiles = useCallback(async () => {
    try {
      const res = await fetch("/api/voices", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setCloneProfiles(data.profiles ?? []);
    } catch {
      /* the panel shows a retry on next open */
    }
  }, []);

  // (Re)load the cloned-voice list whenever the clone tab is opened.
  useEffect(() => {
    if (voiceMode === "clone" && voicePanelOpen) loadCloneProfiles();
  }, [voiceMode, voicePanelOpen, loadCloneProfiles]);

  /** Poll a fresh clone's background audition until it lands (or ~10 min pass). */
  function pollCloneAudition(profileId: string, attempt = 0) {
    if (attempt > 150) {
      setPendingAuditions((a) => a.filter((x) => x !== profileId));
      return;
    }
    setTimeout(async () => {
      try {
        const res = await fetch(`/api/voices/${profileId}/audition`, { cache: "no-store" });
        if (res.ok) {
          setPendingAuditions((a) => a.filter((x) => x !== profileId));
          await loadCloneProfiles();
          return;
        }
      } catch {
        /* transient — keep polling */
      }
      pollCloneAudition(profileId, attempt + 1);
    }, 4000);
  }

  const stopAudition = useCallback(() => {
    auditionRef.current?.pause();
    auditionRef.current = null;
    setAuditionPlaying(null);
  }, []);

  const playAudition = useCallback(
    async (profileId: string) => {
      if (auditionPlaying === profileId) {
        stopAudition();
        return;
      }
      stopAudition();
      try {
        const res = await fetch(`/api/voices/${profileId}/audition`, { cache: "no-store" });
        if (!res.ok) throw new Error("No cached audition — use the ▶ next to the voice instead");
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.onended = () => {
          URL.revokeObjectURL(url);
          setAuditionPlaying(null);
        };
        auditionRef.current = audio;
        setAuditionPlaying(profileId);
        await audio.play();
      } catch (e) {
        setAuditionPlaying(null);
        toast({
          title: "Could not play the audition",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        });
      }
    },
    [auditionPlaying, stopAudition]
  );

  // ---------- Script editing (Stage 4a, T-4.4) — classic format ----------
  // Autosaved (debounced) PATCH with the same invalidation contract as the
  // Create-view editor: a meaningfully-changed script drops the stale
  // voiceover/renders unless "typo fix" is checked. ⌘Z undoes autosave chunks.
  // (Hooks — must stay above the `if (!video) return null;` early return.)
  const [scriptDraft, setScriptDraft] = useState("");
  const [scriptSaveState, setScriptSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [typoFixOnly, setTypoFixOnly] = useState(false);
  const scriptSyncedRef = useRef<string | null>(null);
  const scriptHistoryRef = useRef<string[]>([]);
  const [scriptHistoryLen, setScriptHistoryLen] = useState(0);

  // Re-sync the draft when the SERVER's script changes (first load,
  // regeneration) — never while the user is mid-edit.
  useEffect(() => {
    const server = video?.script ?? null;
    if (server !== scriptSyncedRef.current) {
      scriptSyncedRef.current = server;
      setScriptDraft(server ?? "");
      scriptHistoryRef.current = [];
      setScriptHistoryLen(0);
      setScriptSaveState("idle");
    }
  }, [video?.script]);

  const saveScript = useCallback(
    async (text: string) => {
      const v = video;
      if (!v) return;
      setScriptSaveState("saving");
      try {
        const res = await fetch(`/api/videos/${v.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ script: text, preserveArtifacts: typoFixOnly }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? "Could not save the script");
        const hadVoiceover = v.hasVoiceover;
        onChanged(body.video);
        scriptSyncedRef.current = text;
        setScriptSaveState("saved");
        if (hadVoiceover && body.video?.hasVoiceover === false) {
          toast({
            title: "Voiceover cleared",
            description:
              "The script changed enough that the old narration no longer matches — re-render the voiceover when you're happy with the text.",
          });
        }
      } catch (e) {
        setScriptSaveState("error");
        toast({
          title: "Could not save the script",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        });
      }
    },
    [video, typoFixOnly, onChanged, toast],
  );

  // Debounced autosave — fires 1s after typing stops.
  useEffect(() => {
    const serverScript = video?.script ?? "";
    if (isStory || !video?.id) return;
    if (scriptDraft === serverScript) return;
    const t = setTimeout(() => {
      // Snapshot the last-saved text so ⌘Z can step back through chunks.
      scriptHistoryRef.current.push(serverScript);
      if (scriptHistoryRef.current.length > 25)
        scriptHistoryRef.current.shift();
      setScriptHistoryLen(scriptHistoryRef.current.length);
      void saveScript(scriptDraft);
    }, 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scriptDraft, isStory, video?.id]);

  const undoScript = useCallback(
    (redo = false) => {
      const hist = scriptHistoryRef.current;
      if (redo || hist.length === 0) return;
      const prev = hist.pop()!;
      setScriptHistoryLen(hist.length);
      setScriptDraft(prev);
      void saveScript(prev);
    },
    [saveScript],
  );

  // ---------- Scene text saves (Stage 4a, T-4.4) — per-scene narration +
  // caption edits from the Script tab's scene cards. (Hook — above the early
  // return.) ----------
  const saveSceneText = useCallback(
    async (index: number, patch: { narration?: string; caption?: string }) => {
      const v = video;
      if (!v) return false;
      try {
        const res = await fetch(`/api/videos/${v.id}/scenes`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ index, ...patch }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? "Could not save the scene");
        if (body.scene) {
          const updated = body.scene as SceneDTO;
          setScenes((prev) => prev.map((s) => (s.index === index ? updated : s)));
        }
        if (body.invalidated) {
          toast({
            title: "Voiceover cleared",
            description:
              "Scene narration changed — the spoken audio no longer matches. Re-render the voiceover from the Package tab when the script reads right.",
          });
          await refreshVideo(v.id);
          bumpRefresh();
        }
        return true;
      } catch (e) {
        toast({
          title: `Could not save scene ${index}`,
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        });
        return false;
      }
    },
    [video, refreshVideo, toast, bumpRefresh],
  );

  if (!video) return null;

  const generateVariants = async () => {
    if (busy) return;
    setBusy("variants");
    try {
      await fetch(`/api/videos/${video!.id}/variants`, { method: "POST" });
      const data = await pollVariants(video!.id);
      setVariants(data.variants);
      toast({
        title: "A/B thumbnail set ready",
        description: `${data.variants.length} art directions to test — pick the one with the best CTR vibe.`,
      });
      bumpRefresh();
    } catch (e) {
      toast({
        title: "A/B generation failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  const promoteVariant = async (style: string) => {
    if (busy) return;
    setBusy(`variant-${style}`);
    try {
      const res = await fetch(`/api/videos/${video!.id}/variants`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ style }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not switch thumbnail");
      setVariants(data.variants);
      toast({ title: "Thumbnail switched", description: `“${style}” is now the primary artwork.` });
      bumpRefresh();
    } catch (e) {
      toast({
        title: "Switch failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  const sendToCalendar = () => {
    setScheduleVideoId(video!.id);
    setFocusVideoId(null);
    setView("calendar");
    onClose();
  };

  const runVerify = async () => {
    if (verifyRunning || !video?.hasVoiceover) return;
    setVerifyRunning(true);
    try {
      const res = await fetch(`/api/videos/${video.id}/verify`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not start the narration check");
      const report = await pollVerify(video.id, { timeoutMs: 10 * 60 * 1000 });
      setVerifyReport(report);
      const pct = Math.round((report?.similarity ?? 0) * 100);
      toast({
        title: report?.verdict === "needs-review" ? "Narration needs review" : "Narration verified",
        description: `${pct}% word match between the script and the spoken audio.`,
        variant: report?.verdict === "needs-review" ? "destructive" : undefined,
      });
      bumpRefresh();
    } catch (e) {
      toast({
        title: "Narration check failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
      await refreshVideo(video.id);
    } finally {
      setVerifyRunning(false);
    }
  };

  // ---------- Phase 4: engagement kit ----------
  const copyText = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey((c) => (c === key ? null : c)), 1600);
    } catch {
      toast({
        title: "Copy failed",
        description: "Select the text and copy manually — the browser blocked clipboard access.",
        variant: "destructive",
      });
    }
  };

  const runComments = async () => {
    if (kitRunning || !video?.script) return;
    setKitRunning(true);
    try {
      const res = await fetch(`/api/videos/${video.id}/comments`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not start the engagement kit");
      const kit = await pollComments(video.id);
      setCommentsKit(kit);
      toast({
        title: "Engagement kit ready",
        description: "Pinned comment + reply templates — paste them in the first golden hour.",
      });
      bumpRefresh();
    } catch (e) {
      toast({
        title: "Engagement kit failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
      await refreshVideo(video.id);
    } finally {
      setKitRunning(false);
    }
  };

  // ---------- S17: the ship — the REAL publish flow ----------
  // The review panel opens pre-filled from the video row (the same defaults
  // the route re-resolves server-side); the GET /publish surface supplies
  // the account's privacy default. One click = ONE authorized POST; the
  // job's progress (GET /publish) drives the wait, the row's youtubeUrl
  // marks the landing.
  const openPublishPanel = async () => {
    setPubTitle(video.title ?? "");
    setPubDesc(video.description ?? "");
    setPubTags(video.tags ?? "");
    setPubAt("");
    setPubProgress(null);
    setPubOpen(true);
    if (!pubDefaults) {
      const res = await fetch(`/api/videos/${video.id}/publish`, { cache: "no-store" }).catch(() => null);
      if (res?.ok) {
        const d = (await res.json()) as { defaults?: { privacyStatus?: string } };
        setPubDefaults({ privacyStatus: d.defaults?.privacyStatus ?? "unlisted" });
        setPubPrivacy(d.defaults?.privacyStatus ?? "unlisted");
      }
    }
  };

  const publishVideo = async () => {
    if (pubBusy || !video?.hasVideo) return;
    const title = pubTitle.trim();
    if (!title) {
      toast({ title: "Publish", description: "A title is required — YouTube caps it at 100 characters", variant: "destructive" });
      return;
    }
    setPubBusy(true);
    setPubProgress("Handing to the upload job…");
    try {
      const tags = pubTags.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 30);
      const res = await fetch(`/api/videos/${video.id}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          description: pubDesc.trim(),
          tags,
          privacyStatus: pubPrivacy,
          publishAt: pubAt ? new Date(pubAt).toISOString() : null,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not start the upload");

      // Poll the purpose-built surface: publishing + progress until the job
      // lands (youtubeUrl set / status flips / error recorded).
      const deadline = Date.now() + 20 * 60 * 1000;
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000));
        const st = await fetch(`/api/videos/${video.id}/publish`, { cache: "no-store" });
        const s = (await st.json().catch(() => ({}))) as {
          publishing?: boolean; progress?: { percent?: number; label?: string } | null;
          youtubeUrl?: string | null; error?: string | null;
        };
        if (!st.ok) throw new Error(`Lost the upload status — HTTP ${st.status}`);
        if (s.publishing) {
          setPubProgress(
            s.progress?.percent != null
              ? `Uploading… ${Math.round(s.progress.percent)}%${s.progress.label ? ` — ${s.progress.label}` : ""}`
              : "Uploading…"
          );
        } else if (s.youtubeUrl) {
          await refreshVideo(video.id); // onChanged fires inside — the row now carries youtubeUrl
          toast({ title: "Live on YouTube", description: s.youtubeUrl });
          setPubOpen(false);
          bumpRefresh();
          return;
        } else {
          throw new Error(s.error ?? "The upload ended without a YouTube URL");
        }
        if (Date.now() > deadline)
          throw new Error("The upload is taking unusually long — it may still be running; check the video row in a few minutes.");
      }
    } catch (e) {
      toast({
        title: "Publish failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
      await refreshVideo(video.id);
    } finally {
      setPubBusy(false);
      setPubProgress(null);
    }
  };

  const runStage = async (stage: "voiceover" | "thumbnail") => {
    if (busy) return;
    setBusy(stage);
    try {
      await fetch(`/api/videos/${video.id}/${stage}`, { method: "POST" });
      const done =
        stage === "voiceover"
          ? await pollVoiceover(video.id, {
              timeoutMs: isStory ? 15 * 60 * 1000 : 6 * 60 * 1000,
            })
          : await pollThumbnail(video.id);
      onChanged(done);
      toast({
        title: stage === "voiceover" ? "Voiceover regenerated" : "Thumbnail regenerated",
        description:
          stage === "voiceover"
            ? `${formatDuration(done.audioDuration)} of audio${isStory ? " — re-render the video to match the new timing." : "."}`
            : "New artwork is ready.",
      });
      bumpRefresh();
    } catch (e) {
      toast({
        title: "Stage failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
      await refreshVideo(video.id);
    } finally {
      setBusy(null);
    }
  };

  // ---------- S17: the pre-flight gate — re-run the QC battery against the
  // STANDING render (the after-edit case: trimmed narration, edited caption,
  // replaced stock clip). The full render still QC's on completion; this is
  // the cheap re-measure for "I changed something, check it again".
  const rerunQc = async () => {
    if (qcRerunning || !video?.hasVideo) return;
    setQcRerunning(true);
    try {
      const res = await fetch(`/api/videos/${video.id}/qc`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { accepted?: boolean; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not start the QC re-run");
      // Poll the route's own surface until the job stops running, then the
      // refreshed row carries the fresh qcReport for the scorecard.
      const deadline = Date.now() + 10 * 60 * 1000;
      for (;;) {
        await new Promise((r) => setTimeout(r, 2500));
        const st = await fetch(`/api/videos/${video.id}/qc`, { cache: "no-store" });
        if (!st.ok) throw new Error(`HTTP ${st.status}`);
        const s = (await st.json()) as { running?: boolean; error?: string | null };
        if (!s.running) {
          if (s.error) throw new Error(s.error);
          break;
        }
        if (Date.now() > deadline) throw new Error("The QC re-run is taking unusually long — check back shortly.");
      }
      await refreshVideo(video.id); // the refreshed row carries the fresh qcReport
      toast({ title: "QC re-run complete", description: "The scorecard reflects the standing render." });
      bumpRefresh();
    } catch (e) {
      toast({
        title: "QC re-run failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setQcRerunning(false);
    }
  };

  // ---------- Script (re)generation — retry after a failed first attempt,
  // or re-roll an existing script with a fresh AI take ----------
  const regenScript = async () => {
    if (busy || !video) return;
    setBusy("script");
    try {
      const res = await fetch(`/api/videos/${video.id}/script`, {
        method: "POST",
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok)
        throw new Error(body.error ?? "Could not start the script generation");
      const done = await pollScript(video.id, { timeoutMs: 10 * 60 * 1000 });
      onChanged(done);
      toast({
        title: done.format === "story" ? "Scene script ready" : "Script ready",
        description: `“${done.title}” — ${done.wordCount ?? 0} words${
          done.format === "story" ? ` across ${done.sceneCount ?? 0} scenes` : ""
        }. Next: generate the voiceover.`,
      });
      if (done.format === "story") reloadScenes(done.id);
      bumpRefresh();
    } catch (e) {
      toast({
        title: "Script generation failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
      await refreshVideo(video.id);
    } finally {
      setBusy(null);
    }
  };

  // ---------- Bring-your-own-voice: apply AI voice / upload / internet URL ----------
  const applyVoice = async () => {
    if (busy || !video) return;
    setBusy("voice");
    try {
      if (voiceMode === "tts") {
        // Persist the voice choice first, then re-run the TTS stage.
        if (pickedVoice !== video.voice) {
          const patch = await fetch(`/api/videos/${video.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ voice: pickedVoice }),
          });
          if (!patch.ok) throw new Error("Could not save the voice choice");
        }
        const res = await fetch(`/api/videos/${video.id}/voiceover`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "tts" }),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          throw new Error(d.error ?? "Could not start the voiceover");
        }
        const done = await pollVoiceover(video.id, {
          timeoutMs: video.format === "story" ? 15 * 60 * 1000 : 6 * 60 * 1000,
        });
        onChanged(done);
        toast({
          title: "AI voice applied",
          description: `${voices.find((v) => v.id === pickedVoice)?.label ?? VOICES.find((v) => v.id === pickedVoice)?.label ?? pickedVoice} — ${formatDuration(done.audioDuration)} of audio.`,
        });
      } else {
        let res: Response;
        if (voiceMode === "upload") {
          if (!voiceFile) throw new Error("Choose an audio file first");
          const fd = new FormData();
          fd.append("file", voiceFile);
          res = await fetch(`/api/videos/${video.id}/voiceover`, {
            method: "POST",
            body: fd,
          });
        } else {
          if (!voiceUrl.trim()) throw new Error("Paste an audio link first");
          res = await fetch(`/api/videos/${video.id}/voiceover`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode: "url", url: voiceUrl.trim() }),
          });
        }
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          throw new Error(d.error ?? "Could not attach the custom voice");
        }
        const done = await pollVoiceover(video.id, { timeoutMs: 10 * 60 * 1000 });
        onChanged(done);
        toast({
          title: "Your voice is in",
          description: `${done.voiceLabel ?? "Custom audio"} — ${formatDuration(done.audioDuration)}${
            done.format === "story" ? ", auto-cut across scenes" : ""
          }. Re-render the video to hear it in the MP4.`,
        });
      }
      setVoicePanelOpen(false);
      setVoiceFile(null);
      setVoiceUrl("");
      bumpRefresh();
    } catch (e) {
      toast({
        title: "Voice change failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
      await refreshVideo(video.id);
    } finally {
      setBusy(null);
    }
  };

  // ---------- Voice cloning actions (hooks live above the early return) ----------

  const doClone = async () => {
    if (cloning || !cloneFile) return;
    setCloning(true);
    try {
      const fd = new FormData();
      fd.append("file", cloneFile);
      if (cloneName.trim()) fd.append("name", cloneName.trim());
      if (cloneSampleText.trim()) fd.append("sampleText", cloneSampleText.trim());
      const res = await fetch("/api/voices/clone", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Voice cloning failed");

      // Every open voice picker re-fetches and shows the new voice.
      window.dispatchEvent(new Event(VOICES_CHANGED_EVENT));
      setPickedVoice(data.profile.providerVoiceId);
      setCloneFile(null);
      setCloneName("");
      setCloneSampleText("");
      setVoiceMode("tts"); // jump straight to picking it for this video
      await loadCloneProfiles();
      if (data.audition?.pending && data.profile?.id) {
        setPendingAuditions((a) => [...a, data.profile.id]);
        pollCloneAudition(data.profile.id);
      }
      toast({
        title: `Voice "${data.profile.name}" cloned`,
        description: data.audition?.available
          ? "Pick it under AI voices and hit Generate voice — it narrates in the cloned timbre."
          : data.audition?.pending
            ? "Preview is generating in the background. Pick it under AI voices and hit Generate voice."
            : "Clone ready — pick it under AI voices and hit Generate voice.",
      });
    } catch (e) {
      toast({
        title: "Cloning failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setCloning(false);
    }
  };

  const deleteClone = async (profileId: string, name: string) => {
    if (cloning) return;
    try {
      const res = await fetch(`/api/voices/${profileId}`, { method: "DELETE" });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? "Could not delete the voice");
      }
      window.dispatchEvent(new Event(VOICES_CHANGED_EVENT));
      await loadCloneProfiles();
      if (auditionPlaying === profileId) stopAudition();
      toast({ title: `Voice "${name}" deleted`, description: "Videos already rendered keep their audio." });
    } catch (e) {
      toast({
        title: "Delete failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    }
  };

  const generateStoryboard = async () => {
    if (busy) return;
    setBusy("storyboard");
    setBoardGenerating(true);
    try {
      await fetch(`/api/videos/${video.id}/storyboard`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      await pollStoryboard(video.id, { timeoutMs: 20 * 60 * 1000 });
      await reloadScenes(video.id);
      await refreshVideo(video.id);
      toast({
        title: "Storyboard painted",
        description: `${scenes.length || "All"} scenes rendered — review the art and roll the video.`,
      });
      bumpRefresh();
    } catch (e) {
      toast({
        title: "Storyboard failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
      await refreshVideo(video.id);
    } finally {
      setBoardGenerating(false);
      setBusy(null);
    }
  };

  const regenScene = async (index: number, title: string) => {
    if (busy) return;
    setBusy(`scene-${index}`);
    setScenes((prev) =>
      prev.map((s) => (s.index === index ? { ...s, generating: true } : s))
    );
    try {
      await fetch(`/api/videos/${video.id}/storyboard`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scene: index }),
      });
      await pollScene(video.id, index);
      await reloadScenes(video.id);
      if (renderMode === "slides") await reloadSlides(video.id);
      await refreshVideo(video.id);
      toast({ title: `Scene ${index} re-rolled`, description: `“${title}” has new art.` });
      bumpRefresh();
    } catch (e) {
      toast({
        title: "Scene re-roll failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
      await reloadScenes(video.id);
    } finally {
      setBusy(null);
    }
  };

  // Stage 5 — one-click repaint of a continuity-flagged scene (AI Director
  // card): same endpoint the Scene Studio re-roll uses, fire-and-forget poll.
  // An optional `instruction` turns it into the module-D constraint loop
  // ("regenerate this scene with the character wearing a red jacket") — the
  // storyboard route's AI-edit mode in place.
  const rerollScene = async (index: number, instruction?: string) => {
    if (busy) return;
    setBusy(`scene-${index}`);
    try {
      const res = await fetch(`/api/videos/${video.id}/storyboard`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          instruction ? { scene: index, instruction } : { scene: index }
        ),
      });
      const d = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(d.error ?? "Scene re-roll failed");
      toast({
        title: `Repainting scene ${index}…`,
        description: instruction ? `Constraint: ${instruction.slice(0, 90)}` : undefined,
      });
      void pollScene(video.id, index)
        .then(async () => {
          await reloadScenes(video.id);
          await refreshVideo(video.id);
          bumpRefresh();
          toast({ title: `Scene ${index} repainted`, description: "Run Check continuity to re-score it." });
        })
        .catch(() => {
          void reloadScenes(video.id);
        });
    } catch (e) {
      toast({
        title: "Scene re-roll failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  // Per-slide design re-roll (keynote slides) — one fresh AI take on ONE
  // slide; the rest of the deck, the narration and the scene art stay put.
  const rerollSlide = async (index: number, title: string) => {
    if (busy) return;
    setBusy(`slide-${index}`);
    try {
      const res = await fetch(`/api/videos/${video.id}/slides`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scene: index }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "Slide redesign failed");
      await pollSlide(video.id, index);
      await reloadSlides(video.id);
      await refreshVideo(video.id);
      toast({
        title: `Slide ${index} re-designed`,
        description: `“${title}” has a fresh layout — render to bake it into the video.`,
      });
      bumpRefresh();
    } catch (e) {
      toast({
        title: "Slide redesign failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
      await reloadSlides(video.id);
    } finally {
      setBusy(null);
    }
  };

  const onMusicChange = (v: MusicPickerValue) => {
    setMusicDraft(v);
    if (musicPatchTimer.current) clearTimeout(musicPatchTimer.current);
    musicPatchTimer.current = setTimeout(() => {
      void fetch(`/api/videos/${video.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          musicEnabled: v.enabled,
          musicTrackId: v.trackId,
          musicVolume: v.volume,
          musicFadeIn: v.fadeIn,
          musicFadeOut: v.fadeOut,
          musicDucking: v.ducking,
          musicDuckingIntensity: v.duckingIntensity,
          musicMood: v.mood,
        }),
      });
    }, 600);
  };

  const onMotionChange = (v: MotionPickerValue) => {
    setMotionDraft(v);
    if (motionPatchTimer.current) clearTimeout(motionPatchTimer.current);
    motionPatchTimer.current = setTimeout(() => {
      void fetch(`/api/videos/${video.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          motionMode: v.mode,
          motionIntensity: v.intensity,
          motionCurve: v.curve,
          motionVary: v.vary,
        }),
      });
    }, 600);
  };

  const onTransitionChange = (v: TransitionPickerValue) => {
    setTransitionDraft(v);
    if (transitionPatchTimer.current) clearTimeout(transitionPatchTimer.current);
    transitionPatchTimer.current = setTimeout(() => {
      void fetch(`/api/videos/${video.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transitionStyle: v.style,
          transitionDuration: v.durationSec,
        }),
      });
    }, 600);
  };

  const cancelRunningJobs = async () => {
    try {
      const res = await fetch(`/api/videos/${video.id}/cancel`, { method: "POST" });
      if (res.ok) {
        const d = (await res.json()) as { cancelled: string[] };
        toast({
          title: "Cancel requested",
          description: `Stopping: ${d.cancelled.join(", ")} — it stops after the current step.`,
        });
      } else {
        toast({ title: "Nothing to cancel", variant: "destructive" });
      }
    } catch {
      toast({ title: "Cancel failed", variant: "destructive" });
    }
  };

  // S3 — one chip, one delivery target: the preset sets the row's geometry
  // (aspect/fps/burnCaptions — the render's own fallbacks), the local caption
  // switches, and persists the quality tier on the timeline doc's root so it
  // survives dialog closes and crash resumes.
  const applyExportPreset = async (p: ExportPreset) => {
    if (busy) return;
    setSubtitles(p.burnSubtitles);
    setExportQuality(p.quality);
    try {
      await fetch(`/api/videos/${video.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          aspectRatio: p.aspect,
          frameRate: p.fps,
          burnCaptions: p.burnSubtitles,
        }),
      });
      // Persist the quality tier with the saved doc (GET → PUT; the studio's
      // own working copy is untouched — it only re-syncs on its next load).
      const res = await fetch(`/api/videos/${video.id}/assemble`, { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as { timeline?: AssembledTimelineDTO | null };
        if (data.timeline && data.timeline.scenes?.length) {
          await fetch(`/api/videos/${video.id}/assemble`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              scenes: data.timeline.scenes,
              totalDurationSec: data.timeline.totalDurationSec,
              generatedAt: data.timeline.generatedAt,
              renderPrefs: { quality: p.quality },
            }),
          });
        }
      }
      await refreshVideo(video.id);
      toast({
        title: `Export preset: ${p.label}`,
        description: `${p.aspect} · ${p.fps} fps · ${p.quality} quality${p.burnSubtitles ? " · captions burned" : ""}`,
      });
    } catch (e) {
      toast({
        title: "Preset failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    }
  };

  const startRender = async (mode: string, sceneLimit?: number) => {
    if (busy) return;
    setBusy(sceneLimit ? "preview" : "render");
    setRenderLabel(sceneLimit ? "Rendering preview…" : "Composing the video…");
    try {
      await fetch(`/api/videos/${video.id}/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          subtitles,
          smartCaptions: smartCaps,
          music: musicDraft.enabled !== false, // null = follow defaults → music on
          sceneLimit,
          // S3 — the delivery encode tier (segments + blend masters + burn pass).
          quality: exportQuality,
        }),
      });
      await pollRender(
        video.id,
        (s) =>
          s.progress &&
          setRenderLabel(`${s.progress.label} (${s.progress.current}/${s.progress.total})`),
        { timeoutMs: mode === "animated" ? 60 * 60 * 1000 : 15 * 60 * 1000 }
      );
      await refreshVideo(video.id);
      toast({
        title: sceneLimit ? "Preview ready" : "Video rendered",
        description: sceneLimit
          ? "First scene rendered — check the vibe before committing the full render."
          : "Final MP4 is ready — preview it here and export for upload.",
      });
      bumpRefresh();
    } catch (e) {
      toast({
        title: "Render failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
      await refreshVideo(video.id);
    } finally {
      setRenderLabel(null);
      setBusy(null);
    }
  };

  const startShort = async () => {
    if (!video || busy || shortRunning) return;
    setShortRunning(true);
    try {
      const res = await fetch(`/api/videos/${video.id}/short`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          shortScenePick === "auto" ? {} : { sceneIndex: shortScenePick }
        ),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Short render failed");
      await pollShort(video.id);
      await refreshVideo(video.id);
      toast({
        title: "Vertical Short ready",
        description: "9:16 cut with punch-in zoom and big captions — preview and download below.",
      });
      bumpRefresh();
    } catch (e) {
      toast({
        title: "Short render failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
      await refreshVideo(video.id);
    } finally {
      setShortRunning(false);
    }
  };

  const startConvert = async () => {
    if (busy) return;
    setBusy("convert");
    setRenderLabel("Splitting the script into scenes…");
    try {
      const res = await fetch(`/api/videos/${video.id}/convert`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Conversion failed");
      await pollConvert(video.id);
      await reloadScenes(video.id);
      await refreshVideo(video.id);
      toast({
        title: "Scene video ready to paint",
        description:
          "The script is now split into scenes and your existing voiceover was preserved. Open the Storyboard tab, paint the art, then render Ken Burns or full AI animation.",
      });
      bumpRefresh();
    } catch (e) {
      toast({
        title: "Scene conversion failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
      await refreshVideo(video.id);
    } finally {
      setRenderLabel(null);
      setBusy(null);
    }
  };

  const handleDelete = async () => {
    if (busy) return;
    setBusy("delete");
    try {
      const res = await fetch(`/api/videos/${video.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      onDeleted(video.id);
      toast({ title: "Video deleted", description: "Removed from the library." });
      bumpRefresh();
    } catch (e) {
      toast({
        title: "Delete failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  const tags = video.tags ? video.tags.split(",").map((t) => t.trim()).filter(Boolean) : [];

  // ---------- Storyboard tab (Stage 4a, T-4.5 — density toggle, explicit
  // per-scene status chips, timing bars; every existing action preserved) ----------
  const wordsPerSecond = 2.6 * (video.ttsSpeed ?? 1);
  const sceneEstimate = (narration: string) =>
    narration.split(/\s+/).filter(Boolean).length / wordsPerSecond;
  const totalEstimate = scenes.reduce((acc, s) => acc + sceneEstimate(s.narration), 0);

  const sceneStatus = (s: SceneDTO, slide: SlideDTO | null): { label: string; cls: string } => {
    if (s.generating || boardGenerating)
      return { label: "Painting…", cls: "border-primary/30 bg-primary/15 text-red-200" };
    if (renderMode === "slides" && slide?.hasPng)
      return { label: "Slide", cls: "border-violet-500/30 bg-violet-500/15 text-violet-200" };
    if (s.hasStock)
      return { label: `Stock · ${s.stockSource ?? "clip"}`, cls: "border-emerald-500/30 bg-emerald-500/15 text-emerald-200" };
    if (s.hasImage)
      return { label: "Art ready", cls: "border-emerald-500/25 bg-emerald-500/10 text-emerald-300" };
    return { label: "Awaiting art", cls: "border-white/12 bg-white/5 text-white/50" };
  };

  const storyboardTab = (
    <div className="space-y-4">
      {/* Stage 5 — AI Director: proposes the shot plan, human approves; VLM
          continuity flags + one-click repaint for drifted scenes. */}
      <DirectorCard
        videoId={video.id}
        hasCast={Boolean(video.characterName)}
        storyGenerating={boardGenerating || busy === "storyboard"}
        onRepaintScene={(sceneIndex, instruction) => void rerollScene(sceneIndex, instruction)}
      />
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2.5 flex-wrap">
          <p className="text-sm text-muted-foreground">
            {scenes.length} scenes · {video.characterName ? `host: ${video.characterName}` : "no host"}
          </p>
          {scenes.length > 0 && (
            <Badge variant="outline" className="tf-num border-white/12 bg-white/4 text-muted-foreground text-[10px] font-normal">
              ≈ {formatDuration(totalEstimate)} spoken
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Density toggle (T-4.5) */}
          <div className="flex rounded-lg border border-white/10 bg-white/4 p-0.5" role="group" aria-label="Storyboard density">
            <button
              type="button"
              onClick={() => setBoardDensity("grid")}
              aria-pressed={boardDensity === "grid"}
              title="Comfortable grid"
              className={`tf-focusable h-7 w-8 rounded-md flex items-center justify-center transition-colors ${
                boardDensity === "grid" ? "bg-white/10 text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <LayoutGrid className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setBoardDensity("film")}
              aria-pressed={boardDensity === "film"}
              title="Filmstrip"
              className={`tf-focusable h-7 w-8 rounded-md flex items-center justify-center transition-colors ${
                boardDensity === "film" ? "bg-white/10 text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Clapperboard className="h-3.5 w-3.5" />
            </button>
          </div>
          <Button
            size="sm"
            disabled={Boolean(busy) || boardGenerating}
            onClick={generateStoryboard}
            className="bg-brand-gradient hover:opacity-90 font-medium"
          >
            {busy === "storyboard" || boardGenerating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <LayoutGrid className="h-3.5 w-3.5" />
            )}
            {video.hasStoryboard ? "Re-roll storyboard" : "Generate storyboard"}
          </Button>
        </div>
      </div>

      {scenes.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/12 bg-white/3 px-4 py-6 text-center space-y-3">
          <p className="text-sm text-muted-foreground">
            No scenes yet — write the scene script first, then paint the
            storyboard.
          </p>
          <Button
            size="sm"
            disabled={Boolean(busy)}
            onClick={regenScript}
            className="bg-brand-gradient hover:opacity-90 font-medium"
          >
            {busy === "script" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Wand2 className="h-3.5 w-3.5" />
            )}
            {busy === "script" ? "Writing the scene script…" : "Generate scene script"}
          </Button>
        </div>
      ) : (
        <div
          className={
            boardDensity === "film"
              ? "tf-scroll tf-fade-x flex gap-3 overflow-x-auto pb-2 -mx-1 px-1"
              : "grid sm:grid-cols-2 gap-3"
          }
        >
          {scenes.map((s) => {
            const slide = slides?.find((sl) => sl.index === s.index) ?? null;
            // Keynote slides: the composed slide is what viewers see — show it
            // when it exists, fall back to the raw scene art otherwise.
            const showSlideTile = renderMode === "slides" && slide?.hasPng;
            const status = sceneStatus(s, slide);
            const est = sceneEstimate(s.narration);
            return (
            <div
              key={s.index}
              className={clsx(
                "rounded-xl border border-white/10 bg-white/3 overflow-hidden flex flex-col",
                boardDensity === "film" && "w-64 sm:w-72 shrink-0"
              )}
            >
              <div className="relative">
                {showSlideTile ? (
                  <img
                    src={slide.pngUrl ?? ""}
                    alt={`Slide ${s.index}: ${slide.headline}`}
                    className="w-full aspect-video object-cover object-top"
                  />
                ) : s.hasImage ? (
                  <img
                    src={s.imageUrl ?? ""}
                    alt={`Scene ${s.index}: ${s.title}`}
                    className="w-full aspect-video object-cover"
                  />
                ) : (
                  <div className="w-full aspect-video bg-white/4 flex flex-col items-center justify-center gap-2">
                    {s.generating || boardGenerating ? (
                      <Loader2 className="h-5 w-5 animate-spin text-primary" />
                    ) : (
                      <LayoutGrid className="h-5 w-5 text-muted-foreground" />
                    )}
                    <span className="text-[10px] text-muted-foreground">no art yet</span>
                  </div>
                )}
                <Badge className="absolute top-2 left-2 bg-black/70 text-white border-none text-[10px] px-1.5 h-5">
                  SCENE {s.index}
                </Badge>
                {showSlideTile && (
                  <Badge className="absolute top-2 right-2 bg-violet-500/80 text-white border-none text-[9px] px-1.5 h-5 gap-0.5">
                    <Presentation className="h-2.5 w-2.5" /> SLIDE
                  </Badge>
                )}
                {s.hostInScene && !showSlideTile && (
                  <Badge className="absolute top-2 right-2 bg-primary/80 text-white border-none text-[9px] px-1.5 h-5 gap-0.5">
                    <UserRound className="h-2.5 w-2.5" /> HOST
                  </Badge>
                )}
                {s.rehook && (
                  <Badge className="absolute bottom-2 right-2 bg-amber-500/85 text-black border-none text-[9px] px-1.5 h-5 gap-0.5">
                    <Zap className="h-2.5 w-2.5" /> REHOOK
                  </Badge>
                )}
                {/* Timing bar (T-4.5) — this scene's share of the spoken track */}
                <div className="absolute inset-x-0 bottom-0 h-1 bg-black/45">
                  <div
                    className="h-full bg-primary/80"
                    style={{ width: `${totalEstimate > 0 ? Math.max(4, (est / totalEstimate) * 100) : 0}%` }}
                  />
                </div>
              </div>
              <div className="p-3 flex-1 flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <Badge variant="outline" className={clsx("text-[9px] font-normal px-1.5 h-5", status.cls)}>
                    {status.label}
                  </Badge>
                  <span className="tf-num text-[10px] text-muted-foreground">≈ {Math.round(est)}s</span>
                </div>
                <div>
                  <p className="text-sm font-medium">{showSlideTile ? slide.headline || s.title : s.title}</p>
                  <p className="text-[11px] text-muted-foreground leading-snug mt-0.5 line-clamp-3">
                    {s.narration}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1 mt-auto">
                  <Badge variant="outline" className="border-white/12 bg-white/4 text-muted-foreground text-[9px] font-normal">
                    {s.cameraLabel}
                  </Badge>
                  {s.sfx && s.sfx !== "none" && (
                    <Badge variant="outline" className="border-fuchsia-500/25 bg-fuchsia-500/10 text-fuchsia-200 text-[9px] font-normal uppercase">
                      sfx: {s.sfx}
                    </Badge>
                  )}
                  {s.caption && (
                    <Badge variant="outline" className="border-sky-500/25 bg-sky-500/10 text-sky-200 text-[9px] font-normal">
                      “{s.caption}”
                    </Badge>
                  )}
                  {s.mood && (
                    <Badge variant="outline" className="border-white/12 bg-white/4 text-muted-foreground text-[9px] font-normal truncate max-w-full">
                      {s.mood}
                    </Badge>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={Boolean(busy) || s.generating}
                    onClick={() => setEditingScene(s.index)}
                    className="h-7 text-[11px] text-muted-foreground hover:text-foreground hover:bg-white/6 w-fit px-2"
                    title="Scene Studio — style, prompt, AI edit, or upload your own art"
                  >
                    <Brush className="h-3 w-3" />
                    Edit scene
                  </Button>
                  {renderMode === "slides" && slide && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={Boolean(busy) || slide.generating}
                      onClick={() => rerollSlide(s.index, s.title)}
                      className="h-7 text-[11px] text-violet-200/90 hover:text-foreground hover:bg-white/6 w-fit px-2"
                      title="Fresh design for this one slide — layout, accent and headline treatment"
                    >
                      {busy === `slide-${s.index}` || slide.generating ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Presentation className="h-3 w-3" />
                      )}
                      Re-roll slide
                    </Button>
                  )}
                  {s.hasImage && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={Boolean(busy) || s.generating}
                      onClick={() => regenScene(s.index, s.title)}
                      className="h-7 text-[11px] text-muted-foreground hover:text-foreground hover:bg-white/6 w-fit px-2"
                    >
                      {busy === `scene-${s.index}` || s.generating ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <RefreshCw className="h-3 w-3" />
                      )}
                      Re-roll art
                    </Button>
                  )}
                </div>
              </div>
            </div>
            );
          })}
        </div>
      )}
    </div>
  );

  // ---------- Video tab ----------
  // Keynote slides design their own deck — storyboard art is optional there.
  const renderDisabledReason = !video.hasStoryboard && video.renderMode !== "slides"
    ? "Generate the storyboard first"
    : !video.hasVoiceover
      ? "Generate the voiceover first"
      : null;

  const videoTab = (
    <div className="space-y-5">
      {/* Stage 6 — the Timeline Studio: lanes + live preview + inspector.
          Mounted first so the user can trim the timeline BEFORE the render
          commits the trims to disk. Hidden when the video isn't scene-format
          or has no scenes — the same gate the /assemble endpoint enforces. */}
      {isStory && scenes.length > 0 && video && (
        <TimelineStudio
          videoId={video.id}
          video={video}
          scenes={scenes}
          canAssemble={Boolean(video.hasVoiceover)}
          renderInFlight={busy === "render" || busy === "preview"}
          onSaved={() => void refreshVideo(video.id)}
        />
      )}
      {/* Render controls */}
      <div className="rounded-xl border border-white/10 bg-white/3 p-4 space-y-4">
        <div className="grid grid-cols-2 gap-2">
          {RENDER_MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              disabled={Boolean(busy)}
              onClick={() => setRenderMode(m.id)}
              className={clsx(
                "rounded-lg border p-3 text-left transition-all",
                renderMode === m.id
                  ? "border-primary/50 bg-primary/8"
                  : "border-white/10 bg-white/3 hover:border-white/25"
              )}
            >
              <div className="flex items-center gap-1.5">
                {m.id === "kenburns" ? (
                  <Zap className="h-3.5 w-3.5 text-amber-300" />
                ) : m.id === "slides" ? (
                  <Presentation className="h-3.5 w-3.5 text-violet-300" />
                ) : (
                  <Clapperboard className="h-3.5 w-3.5 text-sky-300" />
                )}
                <span className="text-sm font-medium">{m.label}</span>
                <span className="ml-auto text-[10px] text-muted-foreground">{m.eta}</span>
              </div>
              <p className="text-[11px] text-muted-foreground mt-1 leading-snug">{m.desc}</p>
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-5">
          <div className="flex items-center gap-2">
            <Switch id="subs" checked={subtitles} onCheckedChange={setSubtitles} disabled={Boolean(busy)} />
            <label htmlFor="subs" className="text-xs text-muted-foreground cursor-pointer">
              Burn captions
            </label>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id="smartcaps"
              checked={smartCaps}
              onCheckedChange={setSmartCaps}
              disabled={Boolean(busy) || !subtitles}
            />
            <label
              htmlFor="smartcaps"
              className={clsx(
                "text-xs cursor-pointer flex items-center gap-1",
                subtitles ? "text-foreground/80" : "text-muted-foreground/50"
              )}
              title="ASR-synced cues: captions change exactly when the narration moves instead of one static line per scene"
            >
              <Captions className="h-3 w-3" />
              ASR-synced cues
            </label>
          </div>
        </div>

        {/* S3 — export presets: one chip configures the delivery target
            (aspect + fps on the row, captions + quality for this render). */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
            <Package className="h-3 w-3" /> Export preset
            <span className="rounded bg-emerald-500/15 px-1.5 py-px text-[9px] normal-case tracking-normal text-emerald-200">
              render honors
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {EXPORT_PRESETS.map((p) => {
              const active =
                (video.aspectRatio ?? "16:9") === p.aspect &&
                (video.frameRate ?? 30) === p.fps &&
                exportQuality === p.quality &&
                subtitles === p.burnSubtitles;
              return (
                <button
                  key={p.id}
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => void applyExportPreset(p)}
                  title={p.note}
                  className={clsx(
                    "rounded-lg border px-2.5 py-1.5 text-left transition-all",
                    active
                      ? "border-primary/50 bg-primary/10"
                      : "border-white/10 bg-white/[0.03] hover:border-white/25"
                  )}
                >
                  <div className="text-xs font-medium">{p.label}</div>
                  <div className="text-[10px] text-muted-foreground">{p.note}</div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Per-video soundtrack — track pin, volume, fades (debounced PATCH) */}
        <MusicPickerCard
          value={musicDraft}
          onChange={onMusicChange}
          videoId={video.id}
          canPreview={video.hasVoiceover}
        />

        {/* Per-video Smart Motion — mode, intensity, easing, variation.
            The live preview animates the video's own first storyboard frame
            when art exists, so the camera work is judged on the real image. */}
        <MotionControlsCard
          value={motionDraft}
          onChange={onMotionChange}
          disabled={Boolean(busy)}
          frame={scenes.find((s) => s.imageUrl)?.imageUrl ?? null}
          note={
            renderMode === "animated"
              ? "Image Motion applies to Ken Burns renders — the animated mode generates real video per scene instead."
              : null
          }
        />

        {/* Per-video scene transitions — style + blend length (debounced PATCH).
            Scene A/B preview the first two storyboard frames when available. */}
        <TransitionControlsCard
          value={transitionDraft}
          onChange={onTransitionChange}
          disabled={Boolean(busy)}
          frameA={scenes.filter((s) => s.imageUrl)[0]?.imageUrl ?? null}
          frameB={scenes.filter((s) => s.imageUrl)[1]?.imageUrl ?? null}
        />

        {/* Brand kit (keynote slides) — accent recolor + corner logo badge */}
        {renderMode === "slides" && (
          <BrandKitCard
            videoId={video.id}
            value={{
              accent: video.brandAccent,
              hasLogo: video.brandHasLogo,
              showLogo: video.brandLogoOn,
            }}
            onSaved={() => void refreshVideo(video.id)}
            disabled={Boolean(busy)}
          />
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            disabled={Boolean(busy) || Boolean(renderDisabledReason)}
            onClick={() => startRender(renderMode)}
            className="bg-brand-gradient hover:opacity-90 font-medium"
            title={renderDisabledReason ?? ""}
          >
            {busy === "render" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Clapperboard className="h-3.5 w-3.5" />
            )}
            {video.hasVideo ? "Re-render video" : "Render video"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={Boolean(busy) || Boolean(renderDisabledReason)}
            onClick={() => startRender(renderMode, 1)}
            className="border-white/15 bg-white/4"
            title="Render just the first scene to check the style"
          >
            {busy === "preview" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Eye className="h-3.5 w-3.5" />
            )}
            Preview first scene
          </Button>
          {(busy === "render" || busy === "preview") && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void cancelRunningJobs()}
              className="border-red-500/30 text-red-300 hover:bg-red-500/10"
              title="Stop after the current step — completed scenes are kept"
            >
              <Ban className="h-3.5 w-3.5" />
              Cancel render
            </Button>
          )}
        </div>

        {renderDisabledReason && (
          <p className="text-[11px] text-amber-300/90">{renderDisabledReason}.</p>
        )}
        {renderLabel && (
          <p className="text-xs text-primary/90 flex items-center gap-1.5">
            <Loader2 className="h-3 w-3 animate-spin" />
            {renderLabel}
          </p>
        )}
        {video.error && (
          <p className="text-xs text-red-300 bg-red-500/8 border border-red-500/20 rounded-lg px-3 py-2">
            {video.error}
          </p>
        )}
      </div>

      {/* Quality-check scorecard (T-4.12) — grouped video/audio/sync,
          measured on every full render (qc.ts) */}
      {video.qc ? (
        <div className="rounded-xl border border-white/10 bg-white/3 p-4">
          <div className="flex items-center justify-between gap-2 mb-3">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">
              Quality check · {new Date(video.qc.checkedAt).toLocaleString()}
            </p>
            {/* S17 — the pre-flight gate: the /qc route re-measures the
                STANDING render without paying for a re-render (the route ran
                Stage-6-complete but had NO caller). For the after-edit case:
                trimmed narration, edited caption, replaced stock clip. */}
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-[10px] px-2 border-white/15 bg-white/4"
              disabled={qcRerunning || Boolean(busy) || pubBusy || !video.hasVideo}
              onClick={() => void rerunQc()}
              title={
                video.hasVideo
                  ? "Re-run the QC battery against the standing render — no re-render needed"
                  : "Render the video first — QC measures final.mp4"
              }
            >
              {qcRerunning ? <Loader2 className="h-3 w-3 animate-spin" /> : <CircleCheck className="h-3 w-3" />}
              {qcRerunning ? "Re-checking…" : "Re-run QC"}
            </Button>
            <Badge
              variant="outline"
              className={
                video.qc.passed
                  ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-200 text-[10px]"
                  : "border-amber-500/30 bg-amber-500/10 text-amber-200 text-[10px]"
              }
            >
              {video.qc.passed ? (
                <>
                  <CircleCheck className="h-2.5 w-2.5 mr-1" /> Passed
                </>
              ) : (
                <>
                  <CircleX className="h-2.5 w-2.5 mr-1" />
                  {(() => {
                    const fails = video.qc.checks.filter((c) => qcCheckStatus(c) === "fail").length;
                    const unmeasured = video.qc.checks.filter((c) => qcCheckStatus(c) === "unmeasured").length;
                    return [fails && `${fails} flagged`, unmeasured && `${unmeasured} not measured`]
                      .filter(Boolean)
                      .join(" · ");
                  })()}
                </>
              )}
            </Badge>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {(() => {
              const groups = QC_GROUPS.map((g) => ({
                title: g.title,
                checks: video.qc!.checks.filter((c) => g.ids.includes(c.id)),
              })).filter((g) => g.checks.length > 0);
              const known = new Set(QC_GROUPS.flatMap((g) => g.ids));
              const others = video.qc!.checks.filter((c) => !known.has(c.id));
              if (others.length > 0) groups.push({ title: "Other", checks: others });
              return groups.map((g) => {
                const fails = g.checks.filter((c) => qcCheckStatus(c) === "fail").length;
                const unmeasured = g.checks.filter((c) => qcCheckStatus(c) === "unmeasured").length;
                return (
                  <div key={g.title} className="rounded-lg border border-white/8 bg-white/3 p-3">
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <p className="text-xs font-semibold">{g.title}</p>
                      <span
                        className={clsx(
                          "text-[10px] px-1.5 py-0.5 rounded-md border font-semibold",
                          fails === 0
                            ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
                            : "bg-amber-500/15 text-amber-400 border-amber-500/30"
                        )}
                      >
                        {fails === 0
                          ? `${g.checks.length}/${g.checks.length} clean`
                          : `${fails} flagged${unmeasured ? ` · ${unmeasured} n/m` : ""}`}
                      </span>
                    </div>
                    <ul className="space-y-1.5">
                      {g.checks.map((c) => (
                        <li key={c.id} className="flex items-start gap-2 text-[11px]">
                          {qcCheckStatus(c) === "pass" ? (
                            <CircleCheck className="h-3.5 w-3.5 text-emerald-400 shrink-0 mt-0.5" />
                          ) : qcCheckStatus(c) === "unmeasured" ? (
                            <CircleHelp className="h-3.5 w-3.5 text-zinc-400 shrink-0 mt-0.5" />
                          ) : (
                            <CircleX className="h-3.5 w-3.5 text-amber-400 shrink-0 mt-0.5" />
                          )}
                          <div className="min-w-0">
                            <span className="text-foreground/85">{c.label}</span>
                            <span className="text-muted-foreground"> — {c.value}</span>
                            {c.detail && <p className="text-muted-foreground/70 text-[10px]">{c.detail}</p>}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              });
            })()}
          </div>
        </div>
      ) : null}

      {/* Final video */}
      {video.hasVideo && video.videoUrl ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">
              Final video · {formatDuration(video.videoDuration)}
            </p>
            <Badge variant="outline" className="border-emerald-500/25 bg-emerald-500/10 text-emerald-200 text-[10px]">
              <Check className="h-2.5 w-2.5 mr-1" />
              {video.renderMode === "animated" ? "AI animated" : "Ken Burns"}
            </Badge>
          </div>
          <video
            controls
            preload="metadata"
            src={video.videoUrl}
            className="w-full rounded-xl border border-white/10 aspect-video bg-black"
          >
            Your browser does not support the video element.
          </video>
          <Button variant="outline" size="sm" asChild className="border-white/15 bg-white/4">
            <a href={`${video.videoUrl}?download=1`} download>
              <Download className="h-3.5 w-3.5" />
              Download MP4
            </a>
          </Button>
        </div>
      ) : video.previewUrl ? (
        <div className="space-y-2">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">
            Preview (scene 1)
          </p>
          <video
            controls
            preload="metadata"
            src={video.previewUrl}
            className="w-full rounded-xl border border-white/10 aspect-video bg-black"
          >
            Your browser does not support the video element.
          </video>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No video rendered yet — pick a mode above and roll it.
        </p>
      )}

      {/* Auto-Short (Phase 5) — 9:16 vertical cut */}
      {video.hasVideo && (
        <div className="rounded-xl border border-white/10 bg-white/3 p-4 space-y-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div>
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">
                Auto-Short · 9:16 vertical
              </p>
              <p className="text-[11px] text-muted-foreground/80 mt-0.5">
                Center-cropped punch-in with big Shorts-style captions · capped at 45s
              </p>
            </div>
            {video.hasShort && (
              <Badge variant="outline" className="border-sky-500/25 bg-sky-500/10 text-sky-200 text-[10px]">
                <Smartphone className="h-2.5 w-2.5 mr-1" />
                Scene {video.shortScene} · {formatDuration(video.shortDuration)}
              </Badge>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              disabled={Boolean(busy) || shortRunning}
              onClick={() => setShortScenePick("auto")}
              className={clsx(
                "rounded-full border px-3 py-1 text-[11px] transition-all",
                shortScenePick === "auto"
                  ? "border-primary/50 bg-primary/15 text-red-200"
                  : "border-white/10 bg-white/4 text-muted-foreground hover:border-white/25"
              )}
            >
              <Zap className="inline h-3 w-3 mr-1" />
              Auto-pick
            </button>
            {scenes.map((s) => (
              <button
                key={s.index}
                type="button"
                disabled={Boolean(busy) || shortRunning}
                onClick={() => setShortScenePick(s.index)}
                title={s.title}
                className={clsx(
                  "rounded-full border px-3 py-1 text-[11px] transition-all max-w-[160px] truncate",
                  shortScenePick === s.index
                    ? "border-primary/50 bg-primary/15 text-red-200"
                    : "border-white/10 bg-white/4 text-muted-foreground hover:border-white/25"
                )}
              >
                Scene {s.index}
              </button>
            ))}
          </div>

          <Button
            size="sm"
            disabled={Boolean(busy) || shortRunning}
            onClick={startShort}
            className="bg-brand-gradient hover:opacity-90 font-medium"
          >
            {shortRunning ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Smartphone className="h-3.5 w-3.5" />
            )}
            {video.hasShort ? "Re-cut Short" : "Cut Short"}
          </Button>

          {video.hasShort && video.shortUrl && (
            <div className="flex items-start gap-4 pt-1">
              <video
                controls
                preload="metadata"
                src={video.shortUrl}
                className="w-32 sm:w-36 rounded-xl border border-white/10 aspect-[9/16] bg-black shrink-0"
              >
                Your browser does not support the video element.
              </video>
              <div className="flex flex-col gap-2 items-start">
                <p className="text-[11px] text-muted-foreground leading-relaxed max-w-[280px]">
                  Vertical cut ready — upload it as a YouTube Short to squeeze extra reach out of
                  this video.
                </p>
                <Button variant="outline" size="sm" asChild className="border-white/15 bg-white/4">
                  <a href={`${video.shortUrl}&download=1`} download>
                    <Download className="h-3.5 w-3.5" />
                    Download Short
                  </a>
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Export bundle (T-4.12) — what the ZIP contains */}
      <div className="rounded-xl border border-white/10 bg-white/3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2.5">
          <div>
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">
              Export bundle
            </p>
            <p className="text-[11px] text-muted-foreground/80 mt-0.5">
              One ZIP with everything YouTube needs
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            asChild
            disabled={!(video.script || video.hasVoiceover || video.hasThumbnail)}
            className="border-white/15 bg-white/4 shrink-0"
            title="Download script, metadata, voiceover, storyboard and video as a ZIP"
          >
            <a href={`/api/videos/${video.id}/export`} download>
              <Download className="h-3.5 w-3.5" />
              Download ZIP
            </a>
          </Button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {(
            [
              { ok: Boolean(video.script), label: "Script + brief" },
              { ok: video.hasVoiceover, label: "Voiceover WAV" },
              { ok: video.hasThumbnail, label: "Thumbnail" },
              { ok: video.hasStoryboard, label: "Storyboard art" },
              { ok: video.hasVideo, label: "Subtitles SRT" },
              { ok: video.hasVideo, label: "Final MP4" },
              { ok: video.hasShort, label: "Short 9:16" },
              { ok: true, label: "Credits & license sheet" },
            ] as { ok: boolean; label: string }[]
          ).map((row) => (
            <span
              key={row.label}
              className={clsx(
                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px]",
                row.ok
                  ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-300"
                  : "border-white/10 bg-white/4 text-muted-foreground/70"
              )}
            >
              {row.ok ? (
                <Check className="h-2.5 w-2.5" />
              ) : (
                <span className="h-1.5 w-1.5 rounded-full border border-current opacity-60" />
              )}
              {row.label}
            </span>
          ))}
        </div>
        <p className="text-[10px] text-muted-foreground/70 mt-2.5 leading-relaxed">
          Absent rows mean that pipeline stage hasn’t run yet — the ZIP always reflects
          what exists today, so run the stage first if you need it inside.
        </p>
      </div>
    </div>
  );

  // ---------- Package tab (existing content) ----------
  const packageTab = (
    <>
      {/* Classic → Scene upgrade (Fix: "it doesn't generate videos") —
          narration-script videos have no render path; this unlocks one. */}
      {!isStory && (
        <div className="mt-1 rounded-xl border border-sky-400/25 bg-sky-500/6 p-4 space-y-2.5">
          <div className="flex items-center gap-2">
            <Clapperboard className="h-4 w-4 text-sky-300" />
            <p className="text-sm font-semibold">Want the animated video?</p>
            <Badge variant="outline" className="ml-auto border-sky-400/30 bg-sky-500/10 text-sky-200 text-[9px]">
              Unlocks Storyboard + Video
            </Badge>
          </div>
          <p className="text-[12px] text-muted-foreground leading-relaxed">
            This narration package has no scenes yet, so there is nothing to
            render. Convert it once: TubeForge splits your script into scenes
            (words kept verbatim) and cuts your existing voiceover to match —
            no new voice generation. Then paint the storyboard and render Ken
            Burns motion or full AI animation.
          </p>
          <Button
            size="sm"
            disabled={Boolean(busy) || !video.script}
            onClick={startConvert}
            className="bg-brand-gradient hover:opacity-90 font-medium"
            title={video.script ? "Split into scenes + cut the voiceover (about a minute)" : "Generate the script first"}
          >
            {busy === "convert" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Clapperboard className="h-3.5 w-3.5" />
            )}
            {busy === "convert" ? "Converting…" : "Make it a scene video"}
          </Button>
          {busy === "convert" && renderLabel && (
            <p className="text-xs text-primary/90">{renderLabel}</p>
          )}
          {video.error && video.script && (
            <p className="text-xs text-red-300 bg-red-500/8 border border-red-500/20 rounded-lg px-3 py-2">
              {video.error}
            </p>
          )}
        </div>
      )}

      {/* Audio + bring-your-own-voice */}
      <div className="mt-1">
        <div className="flex items-center justify-between gap-2 mb-2">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">
            Voiceover {video.hasVoiceover ? `· ${formatDuration(video.audioDuration)}` : "· not generated"}
          </p>
          {video.voiceSource === "custom" ? (
            <Badge
              variant="outline"
              className="border-fuchsia-400/30 bg-fuchsia-500/10 text-fuchsia-200 text-[9px] max-w-[55%]"
            >
              <AudioLines className="h-3 w-3 mr-1 shrink-0" />
              <span className="truncate">{video.voiceLabel ?? "Custom voice"}</span>
            </Badge>
          ) : (
            <Badge variant="outline" className="border-white/15 bg-white/5 text-zinc-300 text-[9px] shrink-0">
              <Bot className="h-3 w-3 mr-1" />
              {voices.find((v) => v.id === video.voice)?.label ?? VOICES.find((v) => v.id === video.voice)?.label ?? video.voice}
            </Badge>
          )}
        </div>
        {video.hasVoiceover ? (
          <audio controls preload="metadata" src={`/api/videos/${video.id}/voiceover`} className="w-full" />
        ) : (
          <p className="text-sm text-muted-foreground">No narration yet — pick an AI voice below, or bring your own audio.</p>
        )}

        <div className="mt-3 rounded-xl border border-white/10 bg-white/3 overflow-hidden">
          <button
            type="button"
            onClick={() => setVoicePanelOpen((o) => !o)}
            className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-white/4 transition-colors"
          >
            <Mic className="h-3.5 w-3.5 text-primary" />
            <span className="text-xs font-medium">Change the voice</span>
            <span className="text-[10px] text-muted-foreground hidden sm:inline">
              AI voices, your own file, or any audio from the internet
            </span>
            <ChevronDown
              className={clsx(
                "h-3.5 w-3.5 ml-auto text-muted-foreground transition-transform",
                voicePanelOpen && "rotate-180"
              )}
            />
          </button>

          {voicePanelOpen && (
            <div className="px-3 pb-3 space-y-2.5 border-t border-white/8 pt-3">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                {([
                  { id: "tts", label: "AI voices", icon: Bot },
                  { id: "clone", label: "Clone", icon: Wand2 },
                  { id: "upload", label: "Upload", icon: Upload },
                  { id: "url", label: "From URL", icon: Link2 },
                ] as const).map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    disabled={busy === "voice"}
                    onClick={() => setVoiceMode(m.id)}
                    className={clsx(
                      "flex items-center justify-center gap-1.5 rounded-lg border px-2 py-1.5 text-[11px] font-medium transition-colors disabled:opacity-50",
                      voiceMode === m.id
                        ? "border-primary/50 bg-primary/15 text-primary"
                        : "border-white/10 bg-white/3 text-muted-foreground hover:bg-white/6"
                    )}
                  >
                    <m.icon className="h-3.5 w-3.5" />
                    {m.label}
                  </button>
                ))}
              </div>

              {voiceMode === "tts" && (
                <div className="space-y-2">
                  <VoiceSelectWithPreview
                    value={pickedVoice}
                    onValueChange={setPickedVoice}
                    voices={voices}
                    disabled={busy === "voice"}
                    triggerClassName="h-9 text-xs"
                    itemClassName="text-xs"
                  />
                  <p className="text-[10px] text-muted-foreground leading-relaxed">
                    Tap the <span className="text-primary">▶</span> next to a voice to hear how it
                    sounds before committing.
                  </p>
                  <Button
                    size="sm"
                    className="w-full bg-brand-gradient hover:opacity-90 font-medium"
                    disabled={busy === "voice" || !video.script}
                    onClick={applyVoice}
                    title={!video.script ? "Write the script first — TTS reads the narration" : "Regenerate the voiceover with this voice"}
                  >
                    {busy === "voice" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mic className="h-3.5 w-3.5" />}
                    {busy === "voice" ? "Rendering…" : video.hasVoiceover ? "Regenerate with this voice" : "Generate voice"}
                  </Button>
                </div>
              )}

              {voiceMode === "upload" && (
                <div className="space-y-2">
                  <label className="flex items-center gap-2 rounded-lg border border-dashed border-white/15 bg-white/3 px-3 py-2.5 cursor-pointer hover:bg-white/6 transition-colors">
                    <Upload className="h-3.5 w-3.5 text-primary shrink-0" />
                    <span className="text-xs text-muted-foreground truncate">
                      {voiceFile ? voiceFile.name : "Choose an audio file (mp3, wav, m4a, ogg…)"}
                    </span>
                    <input
                      type="file"
                      accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.oga,.opus,.flac,.webm,.mp4"
                      className="sr-only"
                      disabled={busy === "voice"}
                      onChange={(e) => setVoiceFile(e.target.files?.[0] ?? null)}
                    />
                  </label>
                  <Button
                    size="sm"
                    className="w-full bg-brand-gradient hover:opacity-90 font-medium"
                    disabled={busy === "voice" || !voiceFile}
                    onClick={applyVoice}
                  >
                    {busy === "voice" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <AudioLines className="h-3.5 w-3.5" />}
                    {busy === "voice" ? "Attaching…" : "Use this recording"}
                  </Button>
                </div>
              )}

              {voiceMode === "clone" && (
                <div className="space-y-2.5">
                  <button
                    type="button"
                    onClick={() => {
                      setVoicePanelOpen(false);
                      setView("voice");
                    }}
                    className="w-full text-left text-[11px] text-primary/90 hover:text-primary transition-colors"
                  >
                    Manage &amp; clone voices in the Voice Studio →
                  </button>
                  {/* Inline clone form — always available. The clone itself
                      needs no provider setup: the sample is stored locally
                      and synthesis routes to the owning provider when the
                      user generates the voiceover. When no clone-capable
                      provider is fully configured, show a one-line inline
                      setup form (server URL+key) so the user never has to
                      leave this dialog. */}
                  {cloneStatus === "needs-setup" && (
                    <InlineCloneSetup hint={cloneHint} />
                  )}
                  {cloneStatus !== "unknown" && cloneHint && (
                    <p className="text-[10px] leading-relaxed text-sky-300/80">
                      {cloneHint}
                    </p>
                  )}
                  <label className="flex items-center gap-2 rounded-lg border border-dashed border-white/15 bg-white/3 px-3 py-2.5 cursor-pointer hover:bg-white/6 transition-colors">
                    <Wand2 className="h-3.5 w-3.5 text-primary shrink-0" />
                    <span className="text-xs text-muted-foreground truncate">
                      {cloneFile ? cloneFile.name : "Pick a 3–30s voice sample (mp3, wav, m4a…)"}
                    </span>
                    <input
                      type="file"
                      accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.oga,.opus,.flac,.webm,.mp4"
                      className="sr-only"
                      disabled={cloning}
                      onChange={(e) => setCloneFile(e.target.files?.[0] ?? null)}
                    />
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <Input
                      value={cloneName}
                      onChange={(e) => setCloneName(e.target.value)}
                      placeholder='Voice name (e.g. "My voice")'
                      className="bg-white/5 h-9 text-xs"
                      disabled={cloning}
                    />
                    <Input
                      value={cloneSampleText}
                      onChange={(e) => setCloneSampleText(e.target.value)}
                      placeholder="What the sample says (optional, improves fidelity)"
                      className="bg-white/5 h-9 text-xs"
                      disabled={cloning}
                    />
                  </div>
                  <Button
                    size="sm"
                    className="w-full bg-brand-gradient hover:opacity-90 font-medium"
                    disabled={cloning || !cloneFile}
                    onClick={doClone}
                  >
                    {cloning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
                    {cloning ? "Cloning the voice…" : "Clone this voice"}
                  </Button>
                  <p className="text-[10px] text-muted-foreground leading-relaxed">
                    The sample becomes a reusable narration voice — pick it under AI voices and hit
                    Generate voice. Only clone voices you own or have permission to use.
                  </p>

                  {cloneProfiles.length > 0 && (
                    <div className="space-y-1.5 pt-1">
                      <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                        Cloned voices
                      </p>
                      <div className="max-h-40 overflow-y-auto space-y-1 pr-0.5">
                        {cloneProfiles.map((p) => {
                          const previewPending = pendingAuditions.includes(p.id);
                          return (
                          <div
                            key={p.id}
                            className="flex items-center gap-2 rounded-lg border border-white/8 bg-white/3 px-2.5 py-1.5"
                          >
                            <button
                              type="button"
                              disabled={!p.hasAudition || cloning}
                              onClick={() => playAudition(p.id)}
                              title={
                                previewPending
                                  ? "Generating the preview — it unlocks the moment it lands"
                                  : p.hasAudition
                                    ? "Hear the clone"
                                    : "No cached audition — use ▶ in the picker"
                              }
                              className={clsx(
                                "grid h-6 w-6 shrink-0 place-items-center rounded-full border transition-colors",
                                p.hasAudition
                                  ? auditionPlaying === p.id
                                    ? "border-primary/60 bg-primary/20 text-primary"
                                    : "border-white/10 bg-white/8 text-muted-foreground hover:bg-white/15 hover:text-foreground"
                                  : "opacity-40"
                              )}
                            >
                              {previewPending ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : auditionPlaying === p.id ? (
                                <Square className="h-2.5 w-2.5 fill-current" />
                              ) : (
                                <Play className="h-3 w-3 fill-current" />
                              )}
                            </button>
                            <span className="text-xs truncate flex-1" title={p.providerVoiceId}>
                              {p.name}
                              {p.durationSec ? (
                                <span className="text-muted-foreground"> · {p.durationSec.toFixed(0)}s sample</span>
                              ) : null}
                              {previewPending && (
                                <span className="text-amber-200/80"> · generating preview…</span>
                              )}
                            </span>
                            <button
                              type="button"
                              disabled={cloning}
                              onClick={() => deleteClone(p.id, p.name)}
                              title="Delete this cloned voice"
                              className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-white/10 bg-white/8 text-muted-foreground hover:bg-red-500/15 hover:text-red-300 transition-colors"
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
                          </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {voiceMode === "url" && (
                <div className="space-y-2">
                  <Input
                    value={voiceUrl}
                    onChange={(e) => setVoiceUrl(e.target.value)}
                    placeholder="https://…/my-voice.mp3"
                    className="bg-white/5 h-9 text-xs"
                    disabled={busy === "voice"}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        applyVoice();
                      }
                    }}
                  />
                  <p className="text-[10px] text-muted-foreground leading-relaxed">
                    Paste a DIRECT link to an audio file — any mp3 / wav / m4a on the
                    internet. TubeForge downloads it, converts it to studio audio and
                    swaps it in.
                  </p>
                  <Button
                    size="sm"
                    className="w-full bg-brand-gradient hover:opacity-90 font-medium"
                    disabled={busy === "voice" || !voiceUrl.trim()}
                    onClick={applyVoice}
                  >
                    {busy === "voice" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />}
                    {busy === "voice" ? "Downloading…" : "Fetch voice from URL"}
                  </Button>
                </div>
              )}

              {video.format === "story" && (
                <p className="text-[10px] text-muted-foreground leading-relaxed">
                  Scene videos: whatever voice you attach is auto-cut across the scenes
                  so the timeline still maps 1:1 — then re-render the video.
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Narration check moved to the Script tab (Stage 4a, T-4.4) — the ASR
          accuracy report lives with the script it verifies. */}

      {/* Engagement kit (Phase 4 — retention comments) */}
      <div className="mt-5">
        <div className="flex items-center justify-between gap-2 mb-2">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium flex items-center gap-1.5">
            <MessageCircle className="h-3 w-3" /> Engagement kit
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={!video.script || kitRunning || Boolean(busy)}
            onClick={runComments}
            className="border-white/15 bg-white/4 h-7 text-xs px-2.5"
            title={video.script ? "Write the launch-day pinned comment, reply templates and engagement playbook" : "Write the script first"}
          >
            {kitRunning ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <MessageCircle className="h-3 w-3" />
            )}
            {commentsKit ? "Re-roll kit" : "Write kit"}
          </Button>
        </div>

        {!commentsKit ? (
          <p className="text-sm text-muted-foreground">
            Generate a pinned comment, ready-to-paste reply templates and a
            golden-hour playbook — the comment section is a retention engine.
          </p>
        ) : (
          <div className="rounded-xl border border-white/10 bg-white/3 p-3 space-y-3">
            {/* Pinned comment */}
            <div>
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <Badge className="bg-primary/15 text-red-200 border border-primary/25 text-[10px] gap-1">
                  <MessageCircle className="h-2.5 w-2.5" /> Pin this comment
                </Badge>
                <button
                  onClick={() => copyText("pinned", commentsKit.pinnedComment)}
                  className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
                  title="Copy the pinned comment"
                >
                  {copiedKey === "pinned" ? (
                    <Check className="h-3 w-3 text-emerald-300" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                  {copiedKey === "pinned" ? "Copied" : "Copy"}
                </button>
              </div>
              <p className="text-sm text-foreground/90 leading-relaxed bg-white/4 border border-white/8 rounded-lg p-2.5">
                {commentsKit.pinnedComment}
              </p>
            </div>

            {/* Reply templates */}
            <div className="space-y-1.5">
              <p className="text-[11px] text-muted-foreground font-medium flex items-center justify-between">
                <span>Reply templates</span>
                <button
                  onClick={() =>
                    copyText(
                      "all-replies",
                      commentsKit.replies.map((r) => `WHEN: ${r.trigger}\nREPLY: ${r.text}`).join("\n\n")
                    )
                  }
                  className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
                  title="Copy all reply templates"
                >
                  {copiedKey === "all-replies" ? (
                    <Check className="h-3 w-3 text-emerald-300" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                  {copiedKey === "all-replies" ? "Copied" : "Copy all"}
                </button>
              </p>
              {commentsKit.replies.map((reply, ri) => (
                <div
                  key={ri}
                  className="group/reply rounded-lg border border-white/8 bg-white/3 px-2.5 py-2 hover:border-white/15 transition-colors"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-[10px] text-muted-foreground/80 leading-snug">
                        When: {reply.trigger}
                      </p>
                      <p className="text-[13px] text-foreground/85 leading-relaxed mt-0.5">
                        {reply.text}
                      </p>
                    </div>
                    <button
                      onClick={() => copyText(`reply-${ri}`, reply.text)}
                      className="shrink-0 text-muted-foreground/60 hover:text-foreground opacity-0 group-hover/reply:opacity-100 transition-all"
                      title="Copy this reply"
                    >
                      {copiedKey === `reply-${ri}` ? (
                        <Check className="h-3 w-3 text-emerald-300" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {/* Heart targets */}
            {commentsKit.heartTargets.length > 0 && (
              <div>
                <p className="text-[11px] text-muted-foreground font-medium mb-1.5">
                  Heart these early comments
                </p>
                <ul className="space-y-1">
                  {commentsKit.heartTargets.map((t, i) => (
                    <li key={i} className="text-[12px] text-foreground/75 flex items-start gap-1.5">
                      <span className="text-primary mt-px">♥</span> {t}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Strategy */}
            <p className="text-[11px] text-muted-foreground leading-relaxed border-t border-white/8 pt-2.5 italic">
              <span className="text-foreground/70 not-italic font-medium">Playbook: </span>
              {commentsKit.strategy}
            </p>
          </div>
        )}
      </div>

      {/* Description */}
      {video.description && (
        <div className="mt-5">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium mb-2">
            YouTube Description
          </p>
          <p className="text-sm text-foreground/85 leading-relaxed whitespace-pre-wrap">
            {video.description}
          </p>
        </div>
      )}

      {/* Tags */}
      {tags.length > 0 && (
        <div className="mt-4">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium mb-2 flex items-center gap-1.5">
            <Tag className="h-3 w-3" /> Tags
          </p>
          <div className="flex flex-wrap gap-1.5">
            {tags.map((t) => (
              <Badge key={t} variant="secondary" className="bg-white/6 text-muted-foreground border border-white/8 font-normal">
                #{t}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {/* Thumbnail A/B lab */}
      <div className="mt-5">
        <div className="flex items-center justify-between gap-2 mb-2">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium flex items-center gap-1.5">
            <FlaskConical className="h-3 w-3" /> Thumbnail A/B lab
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={Boolean(busy) || !video.title}
            onClick={generateVariants}
            className="border-white/15 bg-white/4 h-7 text-xs px-2.5"
            title={video.title ? "Generate 3 art directions to A/B test" : "Generate the script first"}
          >
            {busy === "variants" ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <FlaskConical className="h-3 w-3" />
            )}
            {variants.length > 0 ? "Re-roll set" : "Generate A/B set"}
          </Button>
        </div>

        {variants.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Generate 3 thumbnail art directions, preview them side by side, and
            promote the strongest click-magnet.
          </p>
        ) : (
          <div className="grid grid-cols-3 gap-2.5">
            {variants.map((v) => (
              <button
                key={v.style}
                onClick={() =>
                  v.isPrimary ? undefined : promoteVariant(v.style)
                }
                disabled={Boolean(busy)}
                className={clsx(
                  "group relative rounded-xl overflow-hidden border transition-all",
                  v.isPrimary
                    ? "border-primary glow-red-soft"
                    : "border-white/12 hover:border-white/30"
                )}
                title={v.isPrimary ? "Current primary thumbnail" : `Set “${v.label}” as primary`}
              >
                <img
                  src={v.url}
                  alt={`${v.label} thumbnail variant`}
                  className="w-full aspect-video object-cover"
                />
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent px-2 py-1.5 flex items-center justify-between gap-1">
                  <span className="text-[10px] font-medium truncate">{v.label}</span>
                  {v.isPrimary ? (
                    <Badge className="bg-primary/90 text-white border-none px-1.5 h-4 text-[9px] shrink-0">
                      <Check className="h-2.5 w-2.5" /> Primary
                    </Badge>
                  ) : busy === `variant-${v.style}` ? (
                    <Loader2 className="h-3 w-3 animate-spin shrink-0" />
                  ) : (
                    <span className="text-[9px] text-muted-foreground shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                      set primary
                    </span>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      <Separator className="my-5 bg-white/8" />

      {/* Script editing moved to the Script tab (Stage 4a, T-4.4) — editable
          per-scene narration for story videos, a full editor for classic. */}
    </>
  );

  // ---------- The Script tab (Stage 4a, T-4.4) ----------
  // One editing home for both formats: story = per-scene cards with structure
  // + emotion maps and timing; classic = a full autosaving editor. The ASR
  // accuracy check lives here too — it verifies exactly this text.
  // (wordsPerSecond + sceneEstimate are defined with the storyboard helpers.)
  const scriptWords = isStory
    ? scenes.reduce((acc, s) => acc + s.narration.split(/\s+/).filter(Boolean).length, 0)
    : (scriptDraft || "").split(/\s+/).filter(Boolean).length;
  const estSeconds = scriptWords / wordsPerSecond;

  const structureOf = (i: number, total: number): { label: string; cls: string } => {
    if (i === 1) return { label: "Hook", cls: "bg-red-400" };
    if (i === total) return { label: "Payoff", cls: "bg-emerald-400" };
    return i <= Math.ceil(total / 2)
      ? { label: "Context", cls: "bg-sky-400" }
      : { label: "Escalation", cls: "bg-amber-400" };
  };
  const moodHue = (mood: string): number => {
    let h = 0;
    for (let i = 0; i < mood.length; i++) h = (h * 31 + mood.charCodeAt(i)) % 360;
    return h;
  };

  const scriptTab = (
    <>
      {/* Stage 5 (module A) — the research-source snapshot: the fact-check
          surface. Real web pages matched to the idea this video came from;
          the human reads the script against them before rendering. */}
      {video.researchSources?.length ? (
        <div className="mb-4 rounded-xl border border-white/10 bg-white/3 p-3">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium flex items-center gap-1.5 mb-2">
            <ExternalLink className="h-3 w-3" /> Research sources ({video.researchSources.length})
          </p>
          <div className="flex flex-wrap gap-1.5">
            {video.researchSources.map((s, i) => (
              <a
                key={`${s.url}-${i}`}
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-white/10 bg-white/4 px-2 py-1 text-[11px] text-white/75 hover:bg-white/8 hover:text-white transition-colors"
                title={s.url}
              >
                <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="truncate">
                  {s.name || s.url}
                  {s.host ? <span className="text-muted-foreground"> · {s.host}</span> : null}
                </span>
              </a>
            ))}
          </div>
          <p className="mt-2 text-[10px] text-muted-foreground leading-snug">
            Real pages found for this topic — verify the script&apos;s claims against them
            before rendering.
          </p>
        </div>
      ) : null}

      {/* Header: counts + regeneration */}
      <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
        <div>
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium flex items-center gap-1.5">
            <FileText className="h-3 w-3" /> {isStory ? "Scene script" : "Script"}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            <span className="tf-num">{scriptWords}</span> words ·{" "}
            <span className="tf-num">≈ {formatDuration(estSeconds)}</span> at{" "}
            {(video?.ttsSpeed ?? 1).toFixed(1)}x
            {isStory && scenes.length > 0 ? ` · ${scenes.length} scenes` : ""}
          </p>
        </div>
        <Button
          variant={video?.script ? "outline" : "default"}
          size="sm"
          disabled={Boolean(busy)}
          onClick={regenScript}
          className={
            video?.script
              ? "border-white/15 bg-white/4 h-8 text-xs px-3"
              : "bg-brand-gradient hover:opacity-90 font-medium h-8 text-xs px-3"
          }
          title={
            video?.script
              ? "Discard this script and write a fresh take from the same topic"
              : `Write the ${isStory ? "scene script" : "script"} from the topic`
          }
        >
          {busy === "script" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Wand2 className="h-3.5 w-3.5" />
          )}
          {busy === "script"
            ? "Writing…"
            : video?.script
              ? "Re-generate"
              : "Generate script"}
        </Button>
      </div>

      {video?.error && !video?.script && (
        <p className="mb-3 text-xs text-red-300 bg-red-500/8 border border-red-500/20 rounded-lg px-3 py-2 leading-relaxed">
          {video.error}
        </p>
      )}

      {/* Story: structure + emotional progression maps, then per-scene cards */}
      {isStory ? (
        scenes.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/12 bg-white/3 px-4 py-6 text-center">
            <p className="text-sm text-muted-foreground">No scene script yet.</p>
            <p className="text-[11px] text-muted-foreground/70 mt-1 mb-3">
              One click writes a scene-by-scene script from your topic.
            </p>
            <Button
              size="sm"
              disabled={Boolean(busy)}
              onClick={regenScript}
              className="bg-brand-gradient hover:opacity-90 font-medium"
            >
              {busy === "script" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Wand2 className="h-3.5 w-3.5" />
              )}
              {busy === "script" ? "Writing the script…" : "Generate script"}
            </Button>
          </div>
        ) : (
          <>
            {/* Narrative structure strip — hook → context → escalation → payoff,
                with rehook pivots marked. Click a beat to jump to its card. */}
            <div className="mb-3">
              <p className="tf-kicker mb-1.5">Narrative structure</p>
              <div className="flex gap-0.5 h-6">
                {scenes.map((s) => {
                  const st = structureOf(s.index, scenes.length);
                  return (
                    <a
                      key={s.index}
                      href={`#scene-card-${s.index}`}
                      title={`Scene ${s.index} — ${st.label}${s.rehook ? " · rehook pivot" : ""}`}
                      className={`relative flex-1 rounded-sm ${st.cls} opacity-70 hover:opacity-100 transition-opacity min-w-0`}
                    >
                      {s.rehook && (
                        <span className="absolute -top-1 left-1/2 -translate-x-1/2 h-2 w-2 rotate-45 bg-white/80" />
                      )}
                    </a>
                  );
                })}
              </div>
              <div className="flex gap-2 mt-1.5 text-[10px] text-muted-foreground">
                {["Hook", "Context", "Escalation", "Payoff"].map((l) => (
                  <span key={l} className="flex items-center gap-1">
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        l === "Hook"
                          ? "bg-red-400"
                          : l === "Context"
                            ? "bg-sky-400"
                            : l === "Escalation"
                              ? "bg-amber-400"
                              : "bg-emerald-400"
                      }`}
                    />
                    {l}
                  </span>
                ))}
                <span className="ml-auto">◆ = rehook pivot</span>
              </div>
            </div>

            {/* Emotional progression — one hued segment per scene's mood */}
            <div className="mb-4">
              <p className="tf-kicker mb-1.5">Emotional progression</p>
              <div className="flex gap-0.5 h-3">
                {scenes.map((s) => (
                  <span
                    key={s.index}
                    title={`Scene ${s.index}: ${s.mood || "unspecified mood"}`}
                    className="flex-1 rounded-full min-w-0"
                    style={{
                      background: `hsl(${moodHue(s.mood || "neutral")} 55% 55%)`,
                      opacity: 0.85,
                    }}
                  />
                ))}
              </div>
            </div>

            {/* Per-scene editor cards */}
            <div className="space-y-3">
              {scenes.map((s) => (
                <SceneScriptCard
                  key={`${s.index}-${s.narration.length}-${s.caption}`}
                  scene={s}
                  wordsPerSecond={wordsPerSecond}
                  structure={structureOf(s.index, scenes.length)}
                  moodHue={moodHue(s.mood || "neutral")}
                  disabled={Boolean(busy)}
                  onSave={saveSceneText}
                />
              ))}
            </div>
          </>
        )
      ) : (
        <>
          {/* Classic: full-script editor with autosave + undo */}
          <Textarea
            value={scriptDraft}
            onChange={(e) => setScriptDraft(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
                e.preventDefault();
                undoScript(e.shiftKey);
              }
            }}
            disabled={Boolean(busy)}
            placeholder="The script generates here — or paste your own narration."
            className="min-h-[280px] bg-white/5 text-sm leading-relaxed resize-y"
            maxLength={50000}
            aria-label="Script editor"
          />
          <div className="flex items-center justify-between gap-3 flex-wrap mt-2">
            <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
              <span
                className={
                  scriptSaveState === "saving"
                    ? "text-amber-300"
                    : scriptSaveState === "saved"
                      ? "text-emerald-300"
                      : scriptSaveState === "error"
                        ? "text-red-300"
                        : ""
                }
              >
                {scriptSaveState === "saving"
                  ? "Saving…"
                  : scriptSaveState === "saved"
                    ? "Saved ✓"
                    : scriptSaveState === "error"
                      ? "Save failed — will retry on next edit"
                      : "Autosaves as you type"}
              </span>
              {scriptHistoryLen > 0 && (
                <span className="flex items-center gap-1">
                  <Kbd>⌘</Kbd>
                  <Kbd>Z</Kbd> undo ({scriptHistoryLen})
                </span>
              )}
            </div>
            <label className="flex items-center gap-2 text-[11px] text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={typoFixOnly}
                onChange={(e) => setTypoFixOnly(e.target.checked)}
                className="h-3.5 w-3.5 accent-[rgb(255_92_60)]"
              />
              Typo fix only — keep voiceover &amp; renders
            </label>
          </div>
        </>
      )}

      {/* ASR accuracy check (moved from the Package tab, T-4.4) */}
      <div className="mt-6">
        <div className="flex items-center justify-between gap-2 mb-2">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium flex items-center gap-1.5">
            <ScanText className="h-3 w-3" /> Accuracy check
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={!video?.hasVoiceover || verifyRunning || Boolean(busy)}
            onClick={runVerify}
            className="border-white/15 bg-white/4 h-7 text-xs px-2.5"
            title={
              !video?.hasVoiceover
                ? "Generate the voiceover first"
                : "Transcribe the voiceover with ASR and match it against the script"
            }
          >
            {verifyRunning ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <ScanText className="h-3 w-3" />
            )}
            {verifyReport ? "Re-check" : "Run check"}
          </Button>
        </div>

        {!video?.hasVoiceover ? (
          <p className="text-sm text-muted-foreground">
            Generate the voiceover first — the check transcribes it back and
            compares it with the script to catch TTS glitches.
          </p>
        ) : verifyReport ? (
          <div className="rounded-xl border border-white/10 bg-white/3 p-3 space-y-2.5">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge
                className={clsx(
                  "border-none text-[10px]",
                  verifyReport.verdict === "excellent"
                    ? "bg-emerald-500/20 text-emerald-300"
                    : verifyReport.verdict === "good"
                      ? "bg-sky-500/20 text-sky-300"
                      : "bg-red-500/20 text-red-300"
                )}
              >
                {verifyReport.verdict === "excellent"
                  ? "Excellent"
                  : verifyReport.verdict === "good"
                    ? "Good"
                    : "Needs review"}
              </Badge>
              <span className="text-sm font-semibold tabular-nums">
                {Math.round(verifyReport.similarity * 100)}% word match
              </span>
              <span className="text-[11px] text-muted-foreground">
                {verifyReport.scriptWords} script words → {verifyReport.transcriptWords} spoken
              </span>
              <span className="text-[10px] text-muted-foreground ml-auto">
                ran {timeAgo(verifyReport.ranAt)}
              </span>
            </div>

            {verifyReport.scenes && verifyReport.scenes.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {verifyReport.scenes.map((s) => (
                  <Badge
                    key={s.index}
                    variant="outline"
                    className={clsx(
                      "text-[9px] font-normal",
                      s.similarity >= 0.95
                        ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-300"
                        : s.similarity >= 0.85
                          ? "border-sky-500/25 bg-sky-500/10 text-sky-300"
                          : "border-red-500/25 bg-red-500/10 text-red-300"
                    )}
                  >
                    Scene {s.index}: {Math.round(s.similarity * 100)}%
                  </Badge>
                ))}
              </div>
            )}

            {verifyReport.missingWords.length > 0 && (
              <p className="text-[11px] text-muted-foreground">
                <span className="text-foreground/70">Missing:</span>{" "}
                {verifyReport.missingWords.join(", ")}
              </p>
            )}

            <p className="text-[11px] text-muted-foreground leading-relaxed line-clamp-3 border-t border-white/8 pt-2 italic">
              “{verifyReport.transcriptPreview}…”
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Run an ASR check to prove the spoken audio matches the script —
            {isStory ? " verified scene by scene" : " verified word by word"}.
          </p>
        )}
      </div>
    </>
  );

  const footer = (
    <DialogFooter className="mt-6 flex-row flex-wrap gap-2 sm:justify-between">
      <div className="flex flex-wrap gap-2">
        {!video.script && (
          <Button
            variant="outline"
            size="sm"
            disabled={Boolean(busy)}
            onClick={regenScript}
            className="border-white/15 bg-white/4"
            title={`Write the script from “${video.topic}” — the last generation failed or never ran`}
          >
            {busy === "script" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Wand2 className="h-3.5 w-3.5" />
            )}
            {busy === "script" ? "Writing…" : "Generate script"}
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={Boolean(busy) || !video.script}
          onClick={() => runStage("voiceover")}
          className="border-white/15 bg-white/4"
          title={
            video.voiceSource === "custom"
              ? "Replace the attached custom audio with built-in TTS narration"
              : "Regenerate the TTS voiceover with the current voice + speed"
          }
        >
          {busy === "voiceover" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Mic className="h-3.5 w-3.5" />
          )}
          {video.voiceSource === "custom"
            ? "Switch to AI voice"
            : video.hasVoiceover
              ? "Re-render voice"
              : "Generate voice"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={Boolean(busy) || !video.title}
          onClick={() => runStage("thumbnail")}
          className="border-white/15 bg-white/4"
        >
          {busy === "thumbnail" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ImageIcon className="h-3.5 w-3.5" />
          )}
          {video.hasThumbnail ? "Re-paint thumbnail" : "Generate thumbnail"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={Boolean(busy)}
          onClick={sendToCalendar}
          className="border-white/15 bg-white/4"
          title="Schedule this video on the publishing calendar"
        >
          <CalendarPlus className="h-3.5 w-3.5" />
          Schedule
        </Button>
        <Button
          variant="outline"
          size="sm"
          asChild
          disabled={Boolean(busy)}
          className="border-white/15 bg-white/4"
          title={
            video.hasVoiceover || video.hasThumbnail || video.script
              ? "Download script, metadata, voiceover, storyboard and video as a ZIP"
              : "Run the pipeline first — nothing to export yet"
          }
        >
          <a href={`/api/videos/${video.id}/export`} download>
            <Download className="h-3.5 w-3.5" />
            Export
          </a>
        </Button>
      </div>
      {/* S17 — the ship. The two fossil buttons are gone: "Upload to YouTube"
          fired /upload (a route that never existed — a guaranteed 404) and
          "Publish" PATCHed status:"published" while a toast claimed "added to
          the upload queue" (no queue, no upload — the PATCH gate now refuses
          the write). The REAL machinery — POST /publish → the durable upload
          job — gets a review-then-post panel below: the house law is that
          publishing is a SINGLE POST the user clicks after reviewing channel,
          title, description, tags, privacy and schedule. Applies to BOTH
          formats (any render that produced final.mp4 can ship). */}
      <div className="flex flex-wrap gap-2">
        {video.youtubeUrl ? (
          <Button
            size="sm"
            variant="outline"
            asChild
            className="bg-red-500/15 text-red-200 border-red-500/30 hover:bg-red-500/25 font-medium"
            title={video.youtubeUrl}
          >
            <a href={video.youtubeUrl} target="_blank" rel="noreferrer">
              <Youtube className="h-3.5 w-3.5" />
              Live on YouTube
              <ExternalLink className="h-3 w-3 opacity-60" />
            </a>
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={Boolean(busy) || pubBusy || !video.hasVideo || !ytStatus?.connected}
            onClick={() => void openPublishPanel()}
            className="bg-brand-gradient hover:opacity-90 font-medium"
            title={
              !video.hasVideo
                ? "Render the video first — the upload ships final.mp4"
                : !ytStatus?.connected
                  ? "Connect a YouTube channel in Settings → Channel first"
                  : "Review title, description, tags, privacy and schedule — then ship final.mp4 to your channel"
            }
          >
            {pubBusy ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {pubProgress ?? "Uploading…"}
              </>
            ) : (
              <>
                <Youtube className="h-3.5 w-3.5" />
                Publish to YouTube
              </>
            )}
          </Button>
        )}
        {video.status === "published" && (
          <Badge className="bg-primary/15 text-red-300 border border-primary/25 hover:bg-primary/15">
            Published
          </Badge>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={Boolean(busy)}
          onClick={handleDelete}
          className="text-red-300 hover:text-red-200 hover:bg-red-500/10"
        >
          {busy === "delete" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
          Delete
        </Button>
      </div>
      {/* S17 — the review-then-post panel. Every field is REVIEWED here; the
          single POST carries exactly what this panel showed. The thumbnail
          note states what the job ships (the promoted primary, or nothing). */}
      {pubOpen && (
        <div className="mb-1 rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-3">
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Youtube className="h-3.5 w-3.5 shrink-0 text-red-400" />
            Shipping to{" "}
            <span className="text-foreground/85 font-medium">{ytStatus?.channelTitle ?? "your channel"}</span>
            {video.hasThumbnail ? " — the promoted thumbnail ships with it" : " — no thumbnail generated yet, YouTube picks a frame"}
          </p>
          <Input
            value={pubTitle}
            onChange={(e) => setPubTitle(e.target.value)}
            placeholder="Video title (required, up to 100 characters)"
            maxLength={100}
            disabled={pubBusy}
            aria-label="Video title"
          />
          <Textarea
            value={pubDesc}
            onChange={(e) => setPubDesc(e.target.value)}
            placeholder="YouTube description (up to ~5000 characters)"
            maxLength={4900}
            rows={3}
            disabled={pubBusy}
            aria-label="YouTube description"
          />
          <Input
            value={pubTags}
            onChange={(e) => setPubTags(e.target.value)}
            placeholder="Tags, comma, separated (up to 30)"
            disabled={pubBusy}
            aria-label="Tags"
          />
          <div className="flex flex-wrap items-center gap-2">
            <Select value={pubPrivacy} onValueChange={setPubPrivacy} disabled={pubBusy}>
              <SelectTrigger className="h-8 w-[150px] text-xs" aria-label="Privacy">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="public">Public</SelectItem>
                <SelectItem value="unlisted">Unlisted</SelectItem>
                <SelectItem value="private">Private</SelectItem>
              </SelectContent>
            </Select>
            <Input
              type="datetime-local"
              value={pubAt}
              onChange={(e) => setPubAt(e.target.value)}
              disabled={pubBusy}
              className="h-8 w-[230px] text-xs"
              aria-label="Schedule (optional)"
              title="Leave empty to publish immediately — pick a time to schedule the release on YouTube"
            />
          </div>
          <div className="flex items-center gap-2 pt-1">
            <Button
              size="sm"
              onClick={() => void publishVideo()}
              disabled={pubBusy || !pubTitle.trim()}
              className="bg-brand-gradient hover:opacity-90 text-white font-semibold"
            >
              {pubBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
              {pubAt ? "Schedule the upload" : "Publish now"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setPubOpen(false)} disabled={pubBusy}>
              Cancel
            </Button>
            {pubBusy && pubProgress && (
              <span className="text-[11px] text-muted-foreground">{pubProgress}</span>
            )}
          </div>
        </div>
      )}
    </DialogFooter>
  );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto bg-card border-white/10 p-0">
        {/* Header with thumbnail */}
        {video.hasThumbnail && (
          <img
            src={`/api/videos/${video.id}/thumbnail`}
            alt={`Thumbnail for ${video.title ?? video.topic}`}
            className="w-full aspect-video object-cover rounded-t-lg"
          />
        )}
        <div className="p-6 pt-5">
          <DialogHeader className="text-left space-y-1.5">
            <div className="flex items-center gap-2 flex-wrap">
              <StatusBadge status={video.status} />
              <Badge variant="outline" className="border-white/15 bg-white/5 text-muted-foreground">
                {video.niche}
              </Badge>
              {video.characterName && (
                <Badge className="bg-primary/15 text-red-200 border border-primary/25 gap-1">
                  <UserRound className="h-3 w-3" />
                  {video.characterName}
                </Badge>
              )}
              {isStory && (
                <Badge variant="outline" className="border-sky-500/25 bg-sky-500/10 text-sky-200 gap-1">
                  <Clapperboard className="h-3 w-3" />
                  Scene story · {video.sceneCount} scenes
                </Badge>
              )}
              {isStory && video.hasVideo && (
                <Badge variant="outline" className="border-emerald-500/25 bg-emerald-500/10 text-emerald-200">
                  MP4 · {formatDuration(video.videoDuration)}
                </Badge>
              )}
              {video.hasShort && (
                <Badge variant="outline" className="border-sky-500/25 bg-sky-500/10 text-sky-200 gap-1">
                  <Smartphone className="h-3 w-3" />
                  Short · {formatDuration(video.shortDuration)}
                </Badge>
              )}
              {video.youtubeUrl && (
                <Badge variant="outline" className="border-red-500/30 bg-red-500/12 text-red-200 gap-1">
                  <Youtube className="h-3 w-3" />
                  <a href={video.youtubeUrl} target="_blank" rel="noreferrer" className="hover:underline">
                    Live on YouTube
                  </a>
                </Badge>
              )}
              <span className="text-xs text-muted-foreground">{timeAgo(video.createdAt)}</span>
            </div>
            <DialogTitle className="text-lg leading-snug">
              {video.title ?? video.topic}
            </DialogTitle>
            <DialogDescription>
              {video.wordCount ?? 0} words ·{" "}
              {LENGTHS.find((l) => l.id === video.length)?.label ?? video.length} ·{" "}
              {video.voiceSource === "custom"
                ? `Custom voice — ${video.voiceLabel ?? "own audio"}`
                : VOICES.find((v) => v.id === video.voice)?.label ?? video.voice}
              {video.channelName ? ` · ${video.channelName}` : ""}
            </DialogDescription>
          </DialogHeader>

          {video.error && !renderLabel && (
            <p className="mt-3 text-xs text-red-300 bg-red-500/8 border border-red-500/20 rounded-lg px-3 py-2">
              {video.error}
            </p>
          )}

          {isStory ? (
            <Tabs
              defaultValue={video.hasVideo || video.hasVoiceover ? "video" : "script"}
              className="mt-4"
            >
              <TabsList className="grid grid-cols-4 bg-white/5">
                <TabsTrigger value="package" className="data-[state=active]:bg-white/10 text-xs">
                  Package
                </TabsTrigger>
                <TabsTrigger value="script" className="data-[state=active]:bg-white/10 text-xs">
                  Script
                </TabsTrigger>
                <TabsTrigger value="storyboard" className="data-[state=active]:bg-white/10 text-xs">
                  Storyboard
                </TabsTrigger>
                <TabsTrigger value="video" className="data-[state=active]:bg-white/10 text-xs">
                  Video
                </TabsTrigger>
              </TabsList>
              <TabsContent value="package" className="mt-4">
                {packageTab}
              </TabsContent>
              <TabsContent value="script" className="mt-4">
                {scriptTab}
              </TabsContent>
              <TabsContent value="storyboard" className="mt-4">
                {storyboardTab}
              </TabsContent>
              <TabsContent value="video" className="mt-4">
                {videoTab}
              </TabsContent>
            </Tabs>
          ) : (
            <Tabs defaultValue="package" className="mt-4">
              <TabsList className="grid grid-cols-2 bg-white/5">
                <TabsTrigger value="package" className="data-[state=active]:bg-white/10 text-xs">
                  Package
                </TabsTrigger>
                <TabsTrigger value="script" className="data-[state=active]:bg-white/10 text-xs">
                  Script
                </TabsTrigger>
              </TabsList>
              <TabsContent value="package" className="mt-4">
                {packageTab}
              </TabsContent>
              <TabsContent value="script" className="mt-4">
                {scriptTab}
              </TabsContent>
            </Tabs>
          )}

          {footer}
        </div>
      </DialogContent>

      {/* Scene Studio — per-scene art editing (style / prompt / AI edit / upload) */}
      <SceneEditorDialog
        videoId={video.id}
        scene={scenes.find((s) => s.index === editingScene) ?? null}
        open={editingScene !== null}
        onOpenChange={(o) => {
          if (!o) setEditingScene(null);
        }}
        onUpdated={() => {
          void reloadScenes(video.id);
          if (renderMode === "slides") void reloadSlides(video.id);
          bumpRefresh();
        }}
        renderMode={renderMode}
        slide={slides?.find((sl) => sl.index === editingScene) ?? null}
        slideBusy={busy === `slide-${editingScene}`}
        onRerollSlide={() => {
          const scene = scenes.find((s) => s.index === editingScene);
          if (scene) void rerollSlide(scene.index, scene.title);
        }}
      />
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// SceneScriptCard (Stage 4a, T-4.4) — one scene's editable script beat.
//
// Narration autosaves (debounced 800ms) through PATCH /scenes; a narration
// change invalidates the stale voiceover server-side and the dialog refreshes
// the video DTO when that happens. Caption edits are text-only (never
// invalidate). The card also shows the beat's structure role, mood hue and
// spoken-length estimate so the script reads as a timeline, not a wall of text.
// ---------------------------------------------------------------------------

/** Standard narration pace ≈ 156 wpm at 1.0x — the estimate the Script tab
 *  shows per scene (actual timing comes from the TTS render itself). */
function sceneEstSeconds(narration: string, wordsPerSecond: number): number {
  const words = narration.split(/\s+/).filter(Boolean).length;
  return words / wordsPerSecond;
}

function SceneScriptCard({
  scene,
  wordsPerSecond,
  structure,
  moodHue,
  disabled,
  onSave,
}: {
  scene: SceneDTO;
  wordsPerSecond: number;
  structure: { label: string; cls: string };
  moodHue: number;
  disabled: boolean;
  onSave: (index: number, patch: { narration?: string; caption?: string }) => Promise<boolean>;
}) {
  const [narration, setNarration] = useState(scene.narration);
  const [caption, setCaption] = useState(scene.caption);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  // The last SERVER-synced text — state for render-time comparisons, ref
  // mirror for effect/handler-time reads (never read refs during render).
  const [synced, setSynced] = useState({ narration: scene.narration, caption: scene.caption });
  const syncedRef = useRef(synced);

  // Re-sync when the scene changes on the server (regeneration / re-audit).
  useEffect(() => {
    if (scene.narration !== syncedRef.current.narration || scene.caption !== syncedRef.current.caption) {
      syncedRef.current = { narration: scene.narration, caption: scene.caption };
      setSynced({ narration: scene.narration, caption: scene.caption });
      setNarration(scene.narration);
      setCaption(scene.caption);
      setSaveState("idle");
    }
  }, [scene.narration, scene.caption]);

  // Debounced autosave — one PATCH per field that actually changed.
  useEffect(() => {
    const nDirty = narration !== syncedRef.current.narration;
    const cDirty = caption !== syncedRef.current.caption;
    if (!nDirty && !cDirty) return;
    setSaveState("saving");
    const t = setTimeout(async () => {
      const patch: { narration?: string; caption?: string } = {};
      if (nDirty) patch.narration = narration;
      if (cDirty) patch.caption = caption;
      const ok = await onSave(scene.index, patch);
      if (ok) {
        syncedRef.current = { narration, caption };
        setSynced({ narration, caption });
        setSaveState("saved");
      } else {
        setSaveState("error");
      }
    }, 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [narration, caption]);

  const words = narration.split(/\s+/).filter(Boolean).length;

  return (
    <div id={`scene-card-${scene.index}`} className="tf-card p-3.5 scroll-mt-4">
      <div className="flex items-center gap-2 flex-wrap mb-2">
        <span className="text-xs font-semibold text-white/85">Scene {scene.index}</span>
        <span className="text-[10px] text-white/50 truncate flex-1 min-w-0">{scene.title}</span>
        <Badge
          variant="outline"
          className={`text-[9px] font-normal border-none ${
            structure.label === "Hook"
              ? "bg-red-500/15 text-red-300"
              : structure.label === "Context"
                ? "bg-sky-500/15 text-sky-300"
                : structure.label === "Escalation"
                  ? "bg-amber-500/15 text-amber-300"
                  : "bg-emerald-500/15 text-emerald-300"
          }`}
        >
          {structure.label}
        </Badge>
        {scene.hostInScene && (
          <Badge variant="outline" className="text-[9px] font-normal border-white/15 bg-white/5 text-white/70">
            Host
          </Badge>
        )}
        {scene.rehook && (
          <Badge variant="outline" className="text-[9px] font-normal border-amber-400/30 bg-amber-400/10 text-amber-300">
            Rehook
          </Badge>
        )}
        <span
          className="h-2 w-2 rounded-full shrink-0"
          title={scene.mood || "unspecified mood"}
          style={{ background: `hsl(${moodHue} 55% 55%)` }}
        />
        <span className="tf-num text-[10px] text-muted-foreground ml-auto">
          {words}w · ≈ {Math.round(sceneEstSeconds(narration, wordsPerSecond))}s
        </span>
        <span
          className={
            saveState === "saving"
              ? "text-[10px] text-amber-300"
              : saveState === "saved"
                ? "text-[10px] text-emerald-300"
                : saveState === "error"
                  ? "text-[10px] text-red-300"
                  : "text-[10px] text-transparent"
          }
          aria-live="polite"
        >
          {saveState === "saving" ? "saving…" : saveState === "saved" ? "saved ✓" : saveState === "error" ? "save failed" : "·"}
        </span>
      </div>
      <Textarea
        value={narration}
        onChange={(e) => setNarration(e.target.value)}
        disabled={disabled}
        maxLength={3000}
        rows={Math.max(2, Math.min(6, Math.ceil(narration.length / 90)))}
        aria-label={`Narration for scene ${scene.index}`}
        className="bg-white/5 text-[13px] leading-relaxed resize-y"
      />
      <div className="flex items-center gap-2 mt-2">
        <span className="text-[10px] text-muted-foreground shrink-0">Caption</span>
        <Input
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
          disabled={disabled}
          maxLength={60}
          aria-label={`Caption for scene ${scene.index}`}
          className="h-7 bg-white/5 text-xs"
        />
      </div>
      {narration !== synced.narration && (
        <p className="text-[10px] text-amber-300/80 mt-1.5 leading-snug">
          Saving this narration clears the stale voiceover — re-render it from the Package tab.
        </p>
      )}
    </div>
  );
}
