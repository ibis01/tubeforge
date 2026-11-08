"use client";
// Voice Studio (Stage 4b, T-4.10) — the tenth surface.
//
// One catalog for every narration voice: the active provider's studio voices
// plus the user's cloned profiles — each with an audition, a "where it's
// used" line (default narrator + characters cast on it) and a one-click
// "set as default narrator". The clone form (upload or direct link) moved
// here from the per-video dialog; the dialog keeps a deep-link.
//
// Id spaces: pickers and video.voice store the PROVIDER voice id — for
// clones that's providerVoiceId (voice_clone_…). The management list calls
// (audition/delete) use the VoiceProfile ROW id. /api/voices returns both
// (voices + profiles) so this view never has to guess.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { clsx } from "clsx";
import {
  AudioLines,
  Check,
  Link2,
  Loader2,
  Play,
  Plus,
  Square,
  Star,
  Trash2,
  Upload,
  Users,
  Volume2,
  Wand2,
  X,
} from "lucide-react";
import {
  useVoicePreview,
  useVoices,
  VOICES_CHANGED_EVENT,
} from "@/components/tubeforge/shared";
import { InlineCloneSetup } from "@/components/tubeforge/inline-clone-setup";
import type { CharacterDTO } from "@/lib/tubeforge/types";

/** Mirrors VoiceProfileDTO (voice-clone.ts) without importing server code. */
interface CloneProfile {
  id: string; // VoiceProfile ROW id (audition/delete calls)
  name: string;
  provider: string;
  providerVoiceId: string; // the value pickers store
  sourceLabel: string | null;
  durationSec: number | null;
  hasAudition: boolean;
  createdAt: string;
}

const PROVIDER_LABELS: Record<string, string> = {
  zai: "Z.ai",
  zhipu: "Zhipu GLM-TTS",
  selfhost: "Self-hosted",
  openai: "OpenAI-compatible",
};

export function VoiceView() {
  const { toast } = useToast();
  const { voices, provider, cloneStatus, cloneHint } = useVoices();
  const { loading, playing, error: previewError, togglePreview } = useVoicePreview();

  // Management list (all clones regardless of the active provider) + usage data.
  const [profiles, setProfiles] = useState<CloneProfile[]>([]);
  const [characters, setCharacters] = useState<CharacterDTO[]>([]);
  const [defaultVoice, setDefaultVoice] = useState<string | null>(null);
  const [settingDefault, setSettingDefault] = useState<string | null>(null);

  // Clone form state (moved from the video detail dialog's clone tab).
  const [cloneMode, setCloneMode] = useState<"upload" | "link">("upload");
  const [cloneFile, setCloneFile] = useState<File | null>(null);
  const [cloneUrl, setCloneUrl] = useState("");
  const [cloneName, setCloneName] = useState("");
  const [cloneSampleText, setCloneSampleText] = useState("");
  const [cloning, setCloning] = useState(false);

  // Clone-time previews still synthesizing on the (CPU-bound) voice server.
  // The clone itself returns instantly; the preview lands in the background
  // and each id is polled until GET /api/voices/{id}/audition answers 200.
  const [pendingAuditions, setPendingAuditions] = useState<string[]>([]);

  // Cached clone-time auditions (instant — no provider call).
  const [auditionId, setAuditionId] = useState<string | null>(null);
  const auditionRef = useRef<HTMLAudioElement | null>(null);

  // Pronunciation overrides (T-4.11) — the map is applied SERVER-side at the
  // synthesis choke point; this UI only edits the list and tests the result.
  const [pronEntries, setPronEntries] = useState<{ from: string; to: string }[]>([]);
  const [pronFrom, setPronFrom] = useState("");
  const [pronTo, setPronTo] = useState("");
  const [pronSaving, setPronSaving] = useState(false);
  const [testText, setTestText] = useState("");
  const [testing, setTesting] = useState(false);
  const [testPlaying, setTestPlaying] = useState(false);
  const testRef = useRef<HTMLAudioElement | null>(null);

  const loadProfiles = useCallback(async () => {
    try {
      const res = await fetch("/api/voices", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setProfiles(data.profiles ?? []);
    } catch {
      /* the list shows a retry on next visit */
    }
  }, []);

  useEffect(() => {
    loadProfiles();
    fetch("/api/characters", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setCharacters(d?.characters ?? []))
      .catch(() => {});
    fetch("/api/settings", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setDefaultVoice(d?.settings?.defaultVoice ?? null))
      .catch(() => {});
    fetch("/api/voices/pronunciations", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setPronEntries(d?.entries ?? []))
      .catch(() => {});
  }, [loadProfiles]);

  // Fresh clone (or delete) → every open picker re-fetches.
  useEffect(() => {
    const onChange = () => loadProfiles();
    window.addEventListener(VOICES_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(VOICES_CHANGED_EVENT, onChange);
  }, [loadProfiles]);

  const stopAudition = useCallback(() => {
    auditionRef.current?.pause();
    auditionRef.current = null;
    setAuditionId(null);
  }, []);

  const playAudition = useCallback(
    async (p: CloneProfile) => {
      if (auditionId === p.id) {
        stopAudition();
        return;
      }
      stopAudition();
      try {
        const res = await fetch(`/api/voices/${p.id}/audition`, { cache: "no-store" });
        if (!res.ok) throw new Error("No cached audition for this clone");
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.onended = () => {
          URL.revokeObjectURL(url);
          setAuditionId(null);
        };
        auditionRef.current = audio;
        setAuditionId(p.id);
        await audio.play();
      } catch (e) {
        setAuditionId(null);
        toast({
          title: "Could not play the audition",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        });
      }
    },
    [auditionId, stopAudition, toast]
  );

  /** Poll a fresh clone's background audition until it lands (or ~10 min pass). */
  function pollAudition(profileId: string, attempt = 0) {
    if (attempt > 150) {
      setPendingAuditions((a) => a.filter((x) => x !== profileId));
      return;
    }
    setTimeout(async () => {
      try {
        const res = await fetch(`/api/voices/${profileId}/audition`, { cache: "no-store" });
        if (res.ok) {
          setPendingAuditions((a) => a.filter((x) => x !== profileId));
          await loadProfiles();
          toast({
            title: "Voice preview ready",
            description: "Hit ▶ on the cloned voice to hear it.",
          });
          return;
        }
      } catch {
        /* transient — keep polling */
      }
      pollAudition(profileId, attempt + 1);
    }, 4000);
  }

  const doClone = async () => {
    if (cloning) return;
    if (cloneMode === "upload" && !cloneFile) {
      toast({ title: "Pick a voice sample first", variant: "destructive" });
      return;
    }
    if (cloneMode === "link" && !cloneUrl.trim()) {
      toast({ title: "Paste a direct audio link first", variant: "destructive" });
      return;
    }
    setCloning(true);
    try {
      const fd = new FormData();
      if (cloneMode === "upload" && cloneFile) fd.append("file", cloneFile);
      else fd.append("url", cloneUrl.trim());
      if (cloneName.trim()) fd.append("name", cloneName.trim());
      if (cloneSampleText.trim()) fd.append("sampleText", cloneSampleText.trim());
      const res = await fetch("/api/voices/clone", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Voice cloning failed");
      window.dispatchEvent(new Event(VOICES_CHANGED_EVENT));
      await loadProfiles();
      setCloneFile(null);
      setCloneUrl("");
      setCloneName("");
      setCloneSampleText("");
      if (data.audition?.pending && data.profile?.id) {
        setPendingAuditions((a) => [...a, data.profile.id]);
        pollAudition(data.profile.id);
      }
      toast({
        title: `Voice “${data.profile?.name ?? "clone"}” ready`,
        description: data.audition?.available
          ? "Audition it below — every voice picker already offers it."
          : data.audition?.pending
            ? "Preview is generating in the background — it will light up on the card in a moment."
            : "Every voice picker already offers it — hit ▶ on the card to hear it.",
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

  const deleteClone = async (p: CloneProfile) => {
    if (cloning) return;
    if (!confirm(`Delete the cloned voice “${p.name}”? Videos already rendered keep their audio.`)) return;
    try {
      const res = await fetch(`/api/voices/${p.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not delete the voice");
      window.dispatchEvent(new Event(VOICES_CHANGED_EVENT));
      await loadProfiles();
      if (auditionId === p.id) stopAudition();
      if (defaultVoice === p.providerVoiceId) setDefaultVoice(null);
      toast({ title: `Voice “${p.name}” deleted` });
    } catch (e) {
      toast({
        title: "Delete failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    }
  };

  const makeDefault = async (voiceId: string, label: string) => {
    if (settingDefault) return;
    setSettingDefault(voiceId);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultVoice: voiceId }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? "Could not save the default narrator");
      }
      setDefaultVoice(voiceId);
      toast({
        title: `${label} is now the default narrator`,
        description: "New videos in Create start with this voice.",
      });
    } catch (e) {
      toast({
        title: "Could not set the default",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setSettingDefault(null);
    }
  };

  // ---------- Pronunciation overrides (T-4.11) ----------

  const savePron = async (next: { from: string; to: string }[], okTitle: string) => {
    if (pronSaving) return;
    setPronSaving(true);
    try {
      const res = await fetch("/api/voices/pronunciations", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not save");
      setPronEntries(data.entries ?? next);
      toast({ title: okTitle });
    } catch (e) {
      toast({
        title: "Pronunciation save failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setPronSaving(false);
    }
  };

  const addPron = () => {
    const from = pronFrom.trim();
    const to = pronTo.trim();
    if (!from || !to) {
      toast({ title: "Type both fields", description: "The word or phrase, and how to say it.", variant: "destructive" });
      return;
    }
    const next = [
      ...pronEntries.filter((e) => e.from.toLowerCase() !== from.toLowerCase()),
      { from, to },
    ].sort((a, b) => a.from.localeCompare(b.from));
    savePron(next, `“${from}” now reads as “${to}”`);
    setPronFrom("");
    setPronTo("");
  };

  const stopTest = useCallback(() => {
    testRef.current?.pause();
    testRef.current = null;
    setTestPlaying(false);
  }, []);

  const runTest = async () => {
    if (testPlaying) {
      stopTest();
      return;
    }
    const line = testText.trim();
    const voiceId = defaultVoice ?? voices[0]?.id;
    if (!line) {
      toast({ title: "Type a line to test first", variant: "destructive" });
      return;
    }
    if (!voiceId) return;
    setTesting(true);
    try {
      const res = await fetch("/api/settings/voices/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voice: voiceId, text: line.slice(0, 200) }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? "Test failed");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => {
        URL.revokeObjectURL(url);
        setTestPlaying(false);
      };
      testRef.current = audio;
      setTestPlaying(true);
      await audio.play();
    } catch (e) {
      setTestPlaying(false);
      toast({
        title: "Test failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setTesting(false);
    }
  };

  // Split the merged picker catalog into studio voices and clones. The
  // catalog only carries { id, label } — the profile map supplies the rest.
  const byProviderVoiceId = useMemo(
    () => new Map(profiles.map((p) => [p.providerVoiceId, p])),
    [profiles]
  );
  const charactersByVoice = useMemo(() => {
    const map = new Map<string, CharacterDTO[]>();
    for (const c of characters) {
      const list = map.get(c.voice) ?? [];
      list.push(c);
      map.set(c.voice, list);
    }
    return map;
  }, [characters]);

  // The picker catalog (`voices`) only carries clones the ACTIVE provider can
  // speak; the header badge and the management list below count ALL of the
  // user's clones — they synthesize through their owning provider regardless
  // of which voiceover provider is currently active.
  const clonesInCatalog = voices.filter((v) => byProviderVoiceId.has(v.id)).length;
  const studioCount = voices.length - clonesInCatalog;
  const cloneCount = profiles.length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <div className="h-10 w-10 rounded-xl bg-brand-gradient glow-red-soft flex items-center justify-center shrink-0">
            <AudioLines className="h-5 w-5 text-white" />
          </div>
          <div className="min-w-0">
            <p className="font-semibold text-lg leading-tight">Voice Studio</p>
            <p className="text-xs text-muted-foreground leading-relaxed max-w-xl">
              Every narration voice in one place — audition the studio catalog, clone your
              own from a 3–30s sample, and set the default narrator. Voices follow the
              active voiceover provider (Settings → AI Providers).
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5 shrink-0">
          <Badge variant="outline" className="border-white/15 bg-white/5 text-zinc-300 text-[11px]">
            {PROVIDER_LABELS[provider] ?? provider}
          </Badge>
          <Badge variant="outline" className="border-white/15 bg-white/5 text-zinc-300 text-[11px]">
            {studioCount} studio · {cloneCount} cloned
          </Badge>
        </div>
      </div>

      {/* Catalog grid */}
      <div>
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium mb-3 px-1">
          Narration voices
        </p>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {voices.map((v) => {
            const profile = byProviderVoiceId.get(v.id);
            // `!= null` (not Boolean()) so the isClone alias narrows profile
            // in the branches below — no assertions needed (S58/T-58.1).
            const isClone = profile != null;
            const displayName = isClone ? profile.name : v.label;
            const usedBy = charactersByVoice.get(v.id) ?? [];
            const isDefault = defaultVoice === v.id;
            const isPlaying = playing === v.id;
            const isLoading = loading === v.id;
            return (
              <Card
                key={v.id}
                className="glass border-white/8 rounded-2xl p-4 flex flex-col gap-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-sm truncate">{displayName}</p>
                    <p className="text-[11px] text-muted-foreground truncate">
                      {isClone
                        ? `Clone · ${profile.sourceLabel ?? "sample"}${
                            profile.durationSec ? ` · ${profile.durationSec.toFixed(0)}s` : ""
                          }`
                        : `Provider voice · ${PROVIDER_LABELS[provider] ?? provider}`}
                    </p>
                  </div>
                  {isDefault && (
                    <Badge
                      variant="outline"
                      className="border-amber-500/30 bg-amber-500/10 text-amber-200 text-[10px] shrink-0"
                      title="This voice pre-fills every new video in Create"
                    >
                      <Star className="h-2.5 w-2.5 mr-1 fill-current" />
                      Default narrator
                    </Badge>
                  )}
                </div>

                {usedBy.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {usedBy.map((c) => (
                      <Badge
                        key={c.id}
                        variant="outline"
                        className="border-white/10 bg-white/4 text-muted-foreground text-[10px]"
                        title={`${c.name} narrates with this voice`}
                      >
                        <Users className="h-2.5 w-2.5 mr-1" />
                        {c.name}
                      </Badge>
                    ))}
                  </div>
                )}

                <div className="mt-auto flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    onClick={() => togglePreview(v.id)}
                    disabled={isLoading}
                    className={clsx(
                      "flex-1 min-w-[120px] font-medium",
                      isPlaying
                        ? "border-primary/50 bg-primary/15 text-primary hover:bg-primary/20"
                        : "bg-brand-gradient hover:opacity-90"
                    )}
                    title={isPlaying ? "Stop the audition" : "Hear this voice"}
                  >
                    {isLoading ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : isPlaying ? (
                      <Square className="h-3 w-3 fill-current" />
                    ) : (
                      <Play className="h-3.5 w-3.5 fill-current" />
                    )}
                    {isLoading ? "Synthesizing…" : isPlaying ? "Playing" : "Audition"}
                  </Button>
                  {isDefault ? (
                    <span className="inline-flex items-center gap-1 text-[11px] text-amber-200/90 px-1.5">
                      <Check className="h-3 w-3" />
                      Default
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={settingDefault === v.id}
                      onClick={() => makeDefault(v.id, displayName)}
                      className="border-white/15 bg-white/4"
                      title="Pre-fill this voice for every new video in Create"
                    >
                      {settingDefault === v.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Star className="h-3.5 w-3.5" />
                      )}
                      Set default
                    </Button>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
        {previewError && (
          <p className="text-[11px] leading-relaxed text-red-400/90 mt-3 px-1" role="alert">
            {previewError}
          </p>
        )}
      </div>

      {/* Pronunciation overrides (T-4.11) */}
      <Card className="glass border-white/8 rounded-2xl p-5">
        <div className="flex items-start gap-2.5">
          <div className="h-8 w-8 rounded-lg bg-white/6 border border-white/10 flex items-center justify-center shrink-0">
            <Volume2 className="h-4 w-4 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-sm">Pronunciation</p>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              Teach the narrator tricky words — applied server-side to every narration,
              preview and clone, in every video.
            </p>
          </div>
          {pronEntries.length > 0 && (
            <Badge
              variant="outline"
              className="border-white/15 bg-white/5 text-zinc-300 text-[10px] shrink-0"
            >
              {pronEntries.length} override{pronEntries.length === 1 ? "" : "s"}
            </Badge>
          )}
        </div>

        {pronEntries.length > 0 ? (
          <div className="flex flex-wrap gap-1.5 mt-4">
            {pronEntries.map((e) => (
              <span
                key={e.from}
                className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/4 pl-2.5 pr-1.5 py-1 text-[11px]"
              >
                <span className="text-foreground/90">{e.from}</span>
                <span className="text-muted-foreground/70">→</span>
                <span className="text-primary">{e.to}</span>
                <button
                  type="button"
                  disabled={pronSaving}
                  onClick={() =>
                    savePron(
                      pronEntries.filter((x) => x !== e),
                      `Removed “${e.from}”`
                    )
                  }
                  aria-label={`Remove ${e.from}`}
                  className="grid h-4 w-4 place-items-center rounded-full text-muted-foreground/70 hover:text-red-300 hover:bg-red-500/15 transition-colors"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </span>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground/80 mt-4 leading-relaxed">
            No overrides yet — add words the narrator keeps getting wrong (names, jargon,
            foreign terms) and how they should sound.
          </p>
        )}

        <div className="grid gap-2 mt-4 sm:grid-cols-[1fr_1fr_auto]">
          <Input
            value={pronFrom}
            onChange={(e) => setPronFrom(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addPron()}
            placeholder="Word or phrase (e.g. colonel)"
            maxLength={60}
            disabled={pronSaving}
            className="bg-white/5 h-9 text-xs"
          />
          <Input
            value={pronTo}
            onChange={(e) => setPronTo(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addPron()}
            placeholder="Say it as (e.g. kernel)"
            maxLength={200}
            disabled={pronSaving}
            className="bg-white/5 h-9 text-xs"
          />
          <Button
            size="sm"
            onClick={addPron}
            disabled={pronSaving || !pronFrom.trim() || !pronTo.trim()}
            className="bg-brand-gradient hover:opacity-90 font-medium h-9"
          >
            {pronSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            Add
          </Button>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Input
            value={testText}
            onChange={(e) => setTestText(e.target.value)}
            placeholder={`Type a line to hear it${
              defaultVoice ? " in the default narrator\u2019s voice" : ""
            } — overrides apply`}
            maxLength={200}
            disabled={testing}
            className="bg-white/5 h-9 text-xs flex-1 min-w-[220px]"
          />
          <Button
            size="sm"
            variant="outline"
            onClick={runTest}
            disabled={testing || voices.length === 0 || !testText.trim()}
            className="border-white/15 bg-white/4 h-9"
            title="Synthesizes this exact line with your overrides applied"
          >
            {testing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : testPlaying ? (
              <Square className="h-3 w-3 fill-current" />
            ) : (
              <Play className="h-3 w-3 fill-current" />
            )}
            {testing ? "Synthesizing…" : testPlaying ? "Stop" : "Test it"}
          </Button>
        </div>
      </Card>

      {/* Clone studio */}
      <Card className="glass border-white/8 rounded-2xl p-5">
        <div className="flex items-center gap-2.5 mb-1">
          <div className="h-8 w-8 rounded-lg bg-brand-gradient flex items-center justify-center shrink-0 glow-red-soft">
            <Wand2 className="h-4 w-4 text-white" />
          </div>
          <div>
            <p className="font-semibold text-sm">Clone a voice</p>
            <p className="text-[11px] text-muted-foreground">
              3–30s of clean speech becomes a reusable narration voice
            </p>
          </div>
        </div>

        {/* Inline clone form — always available. The clone itself needs no
            provider setup (sample stored locally); when no clone-capable
            provider is fully configured, the inline setup form below lets the
            user paste their self-hosted server URL+key without leaving this
            page. Existing clones below stay safe across the switch. */}
        {cloneStatus === "needs-setup" && (
          <div className="mt-3">
            <InlineCloneSetup hint={cloneHint} />
          </div>
        )}
        {cloneStatus !== "unknown" && cloneHint && (
          <p className="text-[10px] leading-relaxed text-sky-300/80 mt-2">{cloneHint}</p>
        )}
        <div className="mt-4 space-y-3">
          <div className="inline-flex rounded-lg border border-white/10 bg-white/3 p-0.5" role="group" aria-label="Sample source">
            {(
              [
                { id: "upload", label: "Upload a file", icon: Upload },
                { id: "link", label: "Direct link", icon: Link2 },
              ] as const
            ).map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setCloneMode(m.id)}
                aria-pressed={cloneMode === m.id}
                  className={clsx(
                    "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition-all",
                    cloneMode === m.id
                      ? "bg-primary/15 text-red-200"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <m.icon className="h-3.5 w-3.5" />
                  {m.label}
                </button>
              ))}
            </div>

            {cloneMode === "upload" ? (
              <label className="flex items-center gap-2 rounded-lg border border-dashed border-white/15 bg-white/3 px-3 py-2.5 cursor-pointer hover:bg-white/6 transition-colors">
                <Upload className="h-3.5 w-3.5 text-primary shrink-0" />
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
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="clone-url" className="text-xs text-muted-foreground">
                  Direct audio link (public http(s))
                </Label>
                <Input
                  id="clone-url"
                  value={cloneUrl}
                  onChange={(e) => setCloneUrl(e.target.value)}
                  placeholder="https://example.com/voice-sample.mp3"
                  className="bg-white/5 h-9 text-xs"
                  disabled={cloning}
                />
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="clone-name" className="text-xs text-muted-foreground">
                  Voice name
                </Label>
                <Input
                  id="clone-name"
                  value={cloneName}
                  onChange={(e) => setCloneName(e.target.value)}
                  placeholder='e.g. "My voice"'
                  className="bg-white/5 h-9 text-xs"
                  disabled={cloning}
                  maxLength={60}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="clone-text" className="text-xs text-muted-foreground">
                  What the sample says (optional)
                </Label>
                <Input
                  id="clone-text"
                  value={cloneSampleText}
                  onChange={(e) => setCloneSampleText(e.target.value)}
                  placeholder="Improves clone fidelity"
                  className="bg-white/5 h-9 text-xs"
                  disabled={cloning}
                  maxLength={600}
                />
              </div>
            </div>

            <Button
              onClick={doClone}
              disabled={cloning || (cloneMode === "upload" ? !cloneFile : !cloneUrl.trim())}
              className="bg-brand-gradient hover:opacity-90 font-medium"
            >
              {cloning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
              {cloning ? "Cloning the voice…" : "Clone this voice"}
            </Button>
            <p className="text-[10px] text-muted-foreground leading-relaxed">
              The sample becomes a reusable narration voice in every picker. Only clone voices you
              own or have permission to use.
            </p>
        </div>
      </Card>

      {/* Clone library */}
      {profiles.length > 0 && (
        <Card className="glass border-white/8 rounded-2xl p-5">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-semibold">Your cloned voices</p>
            <span className="text-[11px] text-muted-foreground">
              {profiles.length} total · audition plays the clone-time preview
            </span>
          </div>
          <div className="space-y-1.5">
            {profiles.map((p) => {
              const previewPending = pendingAuditions.includes(p.id);
              return (
              <div
                key={p.id}
                className="flex items-center gap-2.5 rounded-lg border border-white/8 bg-white/3 px-3 py-2"
              >
                <button
                  type="button"
                  disabled={!p.hasAudition}
                  onClick={() => playAudition(p)}
                  title={
                    previewPending
                      ? "Generating the preview — the ▶ unlocks the moment it lands"
                      : p.hasAudition
                        ? "Hear the clone-time preview"
                        : "No cached preview — use ▶ on the catalog card"
                  }
                  className={clsx(
                    "grid h-7 w-7 shrink-0 place-items-center rounded-full border transition-colors",
                    p.hasAudition
                      ? auditionId === p.id
                        ? "border-primary/60 bg-primary/20 text-primary"
                        : "border-white/10 bg-white/8 text-muted-foreground hover:bg-white/15 hover:text-foreground"
                      : "opacity-40"
                  )}
                >
                  {previewPending ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : auditionId === p.id ? (
                    <Square className="h-2.5 w-2.5 fill-current" />
                  ) : (
                    <Play className="h-3 w-3 fill-current" />
                  )}
                </button>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium truncate" title={p.providerVoiceId}>
                    {p.name}
                    {defaultVoice === p.providerVoiceId && (
                      <span className="text-amber-200/90"> · default narrator</span>
                    )}
                  </p>
                  <p className="text-[10px] text-muted-foreground truncate">
                    {p.sourceLabel ?? "sample"}
                    {p.durationSec ? ` · ${p.durationSec.toFixed(0)}s` : ""} ·{" "}
                    {PROVIDER_LABELS[p.provider] ?? p.provider}
                    {previewPending && (
                      <span className="text-amber-200/80"> · generating preview…</span>
                    )}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={cloning}
                  onClick={() => deleteClone(p)}
                  title="Delete this cloned voice"
                  className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-white/10 bg-white/8 text-muted-foreground hover:bg-red-500/15 hover:text-red-300 transition-colors"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}
