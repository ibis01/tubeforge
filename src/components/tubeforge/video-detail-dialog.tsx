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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusBadge, formatDuration, timeAgo, useVoices, VoiceSelectWithPreview } from "@/components/tubeforge/shared";
import { MusicPickerCard, type MusicPickerValue } from "@/components/tubeforge/music-controls";
import { MotionControlsCard, type MotionPickerValue } from "@/components/tubeforge/motion-controls";
import { TransitionControlsCard, type TransitionPickerValue } from "@/components/tubeforge/transition-controls";
import { BrandKitCard } from "@/components/tubeforge/brand-kit";
import { SceneEditorDialog } from "@/components/tubeforge/scene-editor";
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
  pollUpload,
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
} from "@/lib/tubeforge/types";
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
} from "lucide-react";
import { clsx } from "clsx";

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
  const [renderLabel, setRenderLabel] = useState<string | null>(null);

  // Narration check state (Phase 3 — ASR proofreading)
  const [verifyReport, setVerifyReport] = useState<VerifyReportDTO | null>(null);
  const [verifyRunning, setVerifyRunning] = useState(false);

  // Engagement kit state (Phase 4 — retention comments)
  const [commentsKit, setCommentsKit] = useState<CommentsKitDTO | null>(null);
  const [kitRunning, setKitRunning] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // YouTube upload state (Phase 4 — OAuth upload)
  const [ytStatus, setYtStatus] = useState<YouTubeStatusDTO | null>(null);
  const [uploading, setUploading] = useState(false);

  // Bring-your-own-voice state — swap TTS voices for uploaded / internet audio
  const [voicePanelOpen, setVoicePanelOpen] = useState(false);
  const [voiceMode, setVoiceMode] = useState<"tts" | "upload" | "url">("tts");
  const [voiceUrl, setVoiceUrl] = useState("");
  const [voiceFile, setVoiceFile] = useState<File | null>(null);
  const [pickedVoice, setPickedVoice] = useState<string>(video?.voice ?? "jam");
  const { voices } = useVoices();

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
    setUploading(false);
    setCopiedKey(null);
    setShortScenePick("auto");
    setShortRunning(false);
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

  // ---------- Phase 4: YouTube upload ----------
  const uploadVideo = async () => {
    if (uploading || !video?.hasVideo) return;
    setUploading(true);
    try {
      const res = await fetch(`/api/videos/${video.id}/upload`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not start the upload");
      const done = await pollUpload(video.id);
      onChanged(done);
      toast({
        title: "Live on YouTube",
        description: done.youtubeUrl ?? "Uploaded successfully.",
      });
      bumpRefresh();
    } catch (e) {
      toast({
        title: "Upload failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
      await refreshVideo(video.id);
    } finally {
      setUploading(false);
    }
  };

  const runStage = async (stage: "voiceover" | "thumbnail" | "publish") => {
    if (busy) return;
    setBusy(stage);
    try {
      if (stage === "publish") {
        const res = await fetch(`/api/videos/${video.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "published" }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Publish failed");
        onChanged(data.video);
        toast({ title: "Marked as published", description: `${data.video.title} added to the upload queue.` });
      } else {
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
      }
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

  // ---------- Storyboard tab ----------
  const storyboardTab = (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {scenes.length} scenes · {video.characterName ? `host: ${video.characterName}` : "no host"}
        </p>
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
        <div className="grid sm:grid-cols-2 gap-3">
          {scenes.map((s) => {
            const slide = slides?.find((sl) => sl.index === s.index) ?? null;
            // Keynote slides: the composed slide is what viewers see — show it
            // when it exists, fall back to the raw scene art otherwise.
            const showSlideTile = renderMode === "slides" && slide?.hasPng;
            return (
            <div
              key={s.index}
              className="rounded-xl border border-white/10 bg-white/3 overflow-hidden flex flex-col"
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
              </div>
              <div className="p-3 flex-1 flex flex-col gap-2">
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

        {/* Per-video soundtrack — track pin, volume, fades (debounced PATCH) */}
        <MusicPickerCard
          value={musicDraft}
          onChange={onMusicChange}
          videoId={video.id}
          canPreview={video.hasVoiceover}
        />

        {/* Per-video Smart Motion — mode, intensity, easing, variation */}
        <MotionControlsCard
          value={motionDraft}
          onChange={onMotionChange}
          disabled={Boolean(busy)}
          note={
            renderMode === "animated"
              ? "Image Motion applies to Ken Burns renders — the animated mode generates real video per scene instead."
              : null
          }
        />

        {/* Per-video scene transitions — style + blend length (debounced PATCH) */}
        <TransitionControlsCard value={transitionDraft} onChange={onTransitionChange} disabled={Boolean(busy)} />

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

      {/* Quality-check report — measured on every full render (qc.ts) */}
      {video.qc && (
        <div className="rounded-xl border border-white/10 bg-white/3 p-4">
          <div className="flex items-center justify-between gap-2 mb-2.5">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">
              Quality check · {new Date(video.qc.checkedAt).toLocaleString()}
            </p>
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
          <ul className="space-y-1.5">
            {video.qc.checks.map((c) => (
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
      )}

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
              <div className="grid grid-cols-3 gap-1.5">
                {([
                  { id: "tts", label: "AI voices", icon: Bot },
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

      {/* Narration check (Phase 3 — ASR proofreading) */}
      <div className="mt-5">
        <div className="flex items-center justify-between gap-2 mb-2">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium flex items-center gap-1.5">
            <ScanText className="h-3 w-3" /> Narration check
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={!video.hasVoiceover || verifyRunning || Boolean(busy)}
            onClick={runVerify}
            className="border-white/15 bg-white/4 h-7 text-xs px-2.5"
            title={
              !video.hasVoiceover
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

        {!video.hasVoiceover ? (
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

      {/* Script — (re)generation lives here so a failed create is recoverable
          without re-entering the topic in the Create view */}
      <div>
        <div className="flex items-center justify-between gap-2 mb-2">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium flex items-center gap-1.5">
            <FileText className="h-3 w-3" /> {isStory ? "Scene narration" : "Script"}
          </p>
          <Button
            variant={video.script ? "outline" : "default"}
            size="sm"
            disabled={Boolean(busy)}
            onClick={regenScript}
            className={
              video.script
                ? "border-white/15 bg-white/4 h-7 text-xs px-2.5"
                : "bg-brand-gradient hover:opacity-90 font-medium h-7 text-xs px-2.5"
            }
            title={
              video.script
                ? "Discard this script and write a fresh take from the same topic"
                : `Write the ${isStory ? "scene script" : "script"} from the topic “${video.topic}”`
            }
          >
            {busy === "script" ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Wand2 className="h-3 w-3" />
            )}
            {busy === "script"
              ? "Writing…"
              : video.script
                ? "Re-generate script"
                : "Generate script"}
          </Button>
        </div>
        {video.error && !video.script && (
          <p className="mb-2 text-xs text-red-300 bg-red-500/8 border border-red-500/20 rounded-lg px-3 py-2 leading-relaxed">
            {video.error}
          </p>
        )}
        {video.script ? (
          <div className="max-h-56 overflow-y-auto scroll-area-bar pr-3 text-sm leading-relaxed whitespace-pre-wrap text-foreground/85">
            {video.script}
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-white/12 bg-white/3 px-4 py-5 text-center">
            <p className="text-sm text-muted-foreground">No script yet.</p>
            <p className="text-[11px] text-muted-foreground/70 mt-1 mb-3">
              One click writes a fresh {isStory ? "scene script" : "script"} from
              your topic: “{video.topic}”.
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
      <div className="flex flex-wrap gap-2">
        {isStory && video.hasVideo && video.youtubeUrl ? (
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
        ) : isStory && video.hasVideo && ytStatus?.connected && video.status !== "published" ? (
          <Button
            size="sm"
            disabled={Boolean(busy) || uploading}
            onClick={uploadVideo}
            className="bg-brand-gradient hover:opacity-90 font-medium"
            title={`Upload final.mp4 to "${ytStatus.channelTitle ?? "your channel"}" (${ytStatus.privacyStatus}) with title, description, tags and thumbnail`}
          >
            {uploading ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Uploading…
              </>
            ) : (
              <>
                <Youtube className="h-3.5 w-3.5" />
                Upload to YouTube
              </>
            )}
          </Button>
        ) : null}
        {video.status !== "published" ? (
          <Button
            size="sm"
            disabled={Boolean(busy) || !video.hasVoiceover}
            onClick={() => runStage("publish")}
            className="bg-brand-gradient hover:opacity-90 font-medium"
            title={video.hasVoiceover ? "" : "Generate a voiceover first"}
          >
            {busy === "publish" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Rocket className="h-3.5 w-3.5" />
            )}
            Publish
          </Button>
        ) : (
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
            <Tabs defaultValue="video" className="mt-4">
              <TabsList className="grid grid-cols-3 bg-white/5">
                <TabsTrigger value="package" className="data-[state=active]:bg-white/10 text-xs">
                  Package
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
              <TabsContent value="storyboard" className="mt-4">
                {storyboardTab}
              </TabsContent>
              <TabsContent value="video" className="mt-4">
                {videoTab}
              </TabsContent>
            </Tabs>
          ) : (
            <div className="mt-2">{packageTab}</div>
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
