"use client";

import { useCallback, useEffect, useState } from "react";
import { useAppStore } from "@/lib/store";
import { useToast } from "@/hooks/use-toast";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { VOICES, NICHES, TONES, LENGTHS, THUMB_STYLES, CHAT_MODELS, DEFAULT_CHAT_MODEL, DEFAULT_ZAI_BASE_URL, type JobDTO, type YouTubeStatusDTO } from "@/lib/tubeforge/types";
import { MusicLibrarySection } from "@/components/tubeforge/settings-music";
import { SecurityAccessCard } from "@/components/tubeforge/security-card";
import {
  Save,
  Loader2,
  Zap,
  Mic,
  ImageIcon,
  ShieldCheck,
  Gauge,
  History,
  RefreshCw,
  Users,
  Film,
  LayoutGrid,
  ScanText,
  Youtube,
  Clapperboard,
  ExternalLink,
  Copy,
  Check,
  Bot,
  KeyRound,
  FlaskConical,
  PenLine,
} from "lucide-react";
import { useVoices, VoiceSelectWithPreview } from "@/components/tubeforge/shared";
import {
  PROVIDERS_BY_CAPABILITY,
  CAPABILITY_META,
  type CapabilityId,
} from "@/lib/tubeforge/providers/registry";

const KIND_META: Record<string, { label: string; icon: typeof Mic }> = {
  voiceover: { label: "Voiceover", icon: Mic },
  thumbnail: { label: "Thumbnail", icon: ImageIcon },
  variants: { label: "A/B set", icon: LayoutGrid },
  portrait: { label: "Portrait", icon: Users },
  poses: { label: "Poses", icon: Users },
  storyboard: { label: "Storyboard", icon: LayoutGrid },
  render: { label: "Render", icon: Film },
  scene: { label: "Scene art", icon: ImageIcon },
  verify: { label: "Narration check", icon: ScanText },
  comments: { label: "Engagement kit", icon: History },
  upload: { label: "YT upload", icon: Youtube },
  convert: { label: "Scene conversion", icon: Clapperboard },
};

const STATUS_META: Record<string, { label: string; cls: string }> = {
  running: { label: "Running", cls: "bg-amber-500/15 text-amber-400 border-amber-500/30" },
  done: { label: "Done", cls: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" },
  failed: { label: "Failed", cls: "bg-red-500/15 text-red-400 border-red-500/30" },
  interrupted: { label: "Interrupted", cls: "bg-orange-500/15 text-orange-400 border-orange-500/30" },
};

function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

export function SettingsView() {
  const { toast } = useToast();
  const bumpRefresh = useAppStore((s) => s.bumpRefresh);

  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const { voices } = useVoices();
  const [form, setForm] = useState({
    defaultNiche: "Motivation",
    defaultTone: "informative",
    defaultLength: "medium",
    defaultVoice: "jam",
    defaultSpeed: 1,
    defaultThumbStyle: "cinematic",
    autoVoiceover: true,
    autoThumbnail: true,
    qualityGate: "thumbnails",
    qualityThreshold: 6,
    aiBudgetEnabled: true,
    aiLlmPerMin: 30,
    aiTtsPerMin: 12,
    aiImagePerMin: 8,
    aiVideoPerMin: 4,
  });

  const [jobs, setJobs] = useState<JobDTO[]>([]);
  const [jobsLoading, setJobsLoading] = useState(false);

  // YouTube connection (Phase 4 — OAuth upload)
  const [yt, setYt] = useState<YouTubeStatusDTO | null>(null);
  const [ytClientId, setYtClientId] = useState("");
  const [ytClientSecret, setYtClientSecret] = useState("");
  const [ytSaving, setYtSaving] = useState(false);
  const [ytConnecting, setYtConnecting] = useState(false);
  const [ytCopied, setYtCopied] = useState(false);

  // AI providers — shared AI credentials + one provider per task capability
  const [zaiCreds, setZaiCreds] = useState({
    baseUrl: DEFAULT_ZAI_BASE_URL,
    apiKey: "",
    hasKey: false,
    maskedKey: "",
  });
  const [prov, setProv] = useState<Record<CapabilityId, {
    provider: string;
    baseUrl: string;
    apiKey: string;
    model: string;
    visionModel: string;
    hasKey: boolean;
    maskedKey: string;
  }>>({
    chat: { provider: "zai", baseUrl: "", apiKey: "", model: DEFAULT_CHAT_MODEL, visionModel: "", hasKey: false, maskedKey: "" },
    tts: { provider: "zai", baseUrl: "", apiKey: "", model: "", visionModel: "", hasKey: false, maskedKey: "" },
    image: { provider: "zai", baseUrl: "", apiKey: "", model: "", visionModel: "", hasKey: false, maskedKey: "" },
    video: { provider: "zai", baseUrl: "", apiKey: "", model: "cogvideox-3", visionModel: "", hasKey: false, maskedKey: "" },
  });
  const [provSaving, setProvSaving] = useState(false);
  const [provTesting, setProvTesting] = useState<string | null>(null);
  const [provTests, setProvTests] = useState<Record<string, { ok: boolean; text: string; needsConfirm?: boolean } | undefined>>({});

  const loadYouTube = useCallback(async () => {
    try {
      const res = await fetch("/api/youtube/status", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setYt(data.status ?? null);
      setYtClientId(data.status?.clientId ?? "");
    } catch {
      /* non-critical */
    }
  }, []);

  const loadAi = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/ai", { cache: "no-store" });
      if (!res.ok) return;
      const d = await res.json();
      setZaiCreds({
        baseUrl: d.zai?.baseUrl ?? DEFAULT_ZAI_BASE_URL,
        apiKey: "",
        hasKey: Boolean(d.zai?.hasKey),
        maskedKey: d.zai?.maskedKey ?? "",
      });
      setProv((f) => ({
        chat: { ...f.chat, ...(d.capabilities?.chat ?? {}), apiKey: "" },
        tts: { ...f.tts, ...(d.capabilities?.tts ?? {}), apiKey: "" },
        image: { ...f.image, ...(d.capabilities?.image ?? {}), apiKey: "" },
        video: { ...f.video, ...(d.capabilities?.video ?? {}), apiKey: "" },
      }));
    } catch {
      /* non-critical */
    }
  }, []);

  const loadJobs = useCallback(async () => {
    setJobsLoading(true);
    try {
      const res = await fetch("/api/jobs?limit=15", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setJobs(data.jobs ?? []);
    } catch {
      /* history is non-critical — leave stale rows */
    } finally {
      setJobsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        const s = d.settings ?? {};
        setForm((f) => ({
          ...f,
          defaultNiche: s.defaultNiche ?? f.defaultNiche,
          defaultTone: s.defaultTone ?? f.defaultTone,
          defaultLength: s.defaultLength ?? f.defaultLength,
          defaultVoice: s.defaultVoice ?? f.defaultVoice,
          defaultSpeed: Number(s.defaultSpeed ?? f.defaultSpeed),
          defaultThumbStyle: s.defaultThumbStyle ?? f.defaultThumbStyle,
          autoVoiceover: s.autoVoiceover !== "false",
          autoThumbnail: s.autoThumbnail !== "false",
          qualityGate: s.qualityGate ?? "thumbnails",
          qualityThreshold: Number(s.qualityThreshold ?? 6),
          aiBudgetEnabled: s.aiBudgetEnabled !== "false",
          aiLlmPerMin: Number(s.aiLlmPerMin ?? 30),
          aiTtsPerMin: Number(s.aiTtsPerMin ?? 12),
          aiImagePerMin: Number(s.aiImagePerMin ?? 8),
          aiVideoPerMin: Number(s.aiVideoPerMin ?? 4),
        }));
      })
      .catch(() => undefined)
      .finally(() => setLoaded(true));
    void loadJobs();
    void loadYouTube();
    void loadAi();
  }, [loadJobs, loadYouTube, loadAi]);

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Save failed");
      toast({
        title: "Settings saved",
        description: "Robustness rules apply to the very next AI call.",
      });
      bumpRefresh();
    } catch (e) {
      toast({
        title: "Could not save settings",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  // ---------- YouTube connection handlers (Phase 4) ----------
  const saveYtCredentials = async () => {
    if (ytSaving) return;
    setYtSaving(true);
    try {
      const res = await fetch("/api/youtube/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: ytClientId.trim(),
          clientSecret: ytClientSecret.trim(),
          privacyStatus: yt?.privacyStatus ?? "unlisted",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Save failed");
      setYtClientSecret("");
      await loadYouTube();
      toast({
        title: "Credentials saved",
        description: "Register the callback URL below in Google Cloud Console, then connect the channel.",
      });
    } catch (e) {
      toast({
        title: "Could not save YouTube credentials",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setYtSaving(false);
    }
  };

  const startConnect = async () => {
    if (ytConnecting) return;
    setYtConnecting(true);
    try {
      // Server builds the consent URL + CSRF state; opens in a new tab.
      const res = await fetch("/api/youtube/connect", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not start the connection");
      window.open(data.authUrl, "_blank", "noopener,noreferrer");
      toast({
        title: "Consent page opened",
        description: "Complete the Google consent in the new tab — the channel shows up here when you return.",
      });
      // Refresh state when the user likely returns from consent.
      setTimeout(() => void loadYouTube(), 15_000);
      setTimeout(() => void loadYouTube(), 45_000);
    } catch (e) {
      toast({
        title: "Connection could not start",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setYtConnecting(false);
    }
  };

  const disconnectYt = async () => {
    try {
      const res = await fetch("/api/youtube/disconnect", { method: "POST" });
      if (!res.ok) throw new Error("Disconnect failed");
      await loadYouTube();
      toast({ title: "Channel disconnected", description: "Uploads are disabled until you reconnect." });
    } catch (e) {
      toast({
        title: "Disconnect failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    }
  };

  const copyCallbackUrl = async () => {
    if (!yt?.callbackUrl) return;
    try {
      await navigator.clipboard.writeText(yt.callbackUrl);
      setYtCopied(true);
      setTimeout(() => setYtCopied(false), 1600);
    } catch {
      /* clipboard blocked — user can select manually */
    }
  };

  // ---------- AI provider handlers ----------
  const saveProviders = async () => {
    if (provSaving) return;
    setProvSaving(true);
    try {
      // 1) Shared AI credentials (only when the user typed something).
      if (zaiCreds.apiKey.trim() || zaiCreds.baseUrl.trim()) {
        const res = await fetch("/api/settings/ai", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            scope: "zai",
            baseUrl: zaiCreds.baseUrl.trim(),
            apiKey: zaiCreds.apiKey.trim(),
          }),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          throw new Error(d.error ?? `Shared credentials: HTTP ${res.status}`);
        }
      }

      // 2) Every capability's provider / model / endpoint.
      for (const cap of ["chat", "tts", "image", "video"] as CapabilityId[]) {
        const row = prov[cap];
        const res = await fetch("/api/settings/ai", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            scope: "capability",
            capability: cap,
            provider: row.provider,
            model: row.model,
            visionModel: cap === "chat" ? row.visionModel : undefined,
            baseUrl: row.baseUrl.trim(),
            apiKey: row.apiKey.trim(),
          }),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          throw new Error(d.error ?? `${CAPABILITY_META[cap].label}: HTTP ${res.status}`);
        }
      }

      await loadAi();
      toast({
        title: "AI providers updated",
        description: "The very next run uses the new providers.",
      });
    } catch (e) {
      toast({
        title: "Could not save AI settings",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setProvSaving(false);
    }
  };

  const testCapability = async (cap: CapabilityId, kind: string, confirmCost = false) => {
    if (provTesting) return;
    const row = prov[cap];
    setProvTesting(cap);
    setProvTests((t) => ({ ...t, [cap]: undefined }));
    try {
      const res = await fetch("/api/settings/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          capability: kind,
          provider: row.provider,
          baseUrl: row.baseUrl.trim() || undefined,
          apiKey: row.apiKey.trim() || undefined,
          model: row.model.trim() || undefined,
          visionModel: row.visionModel?.trim() || undefined,
          confirmCost,
        }),
      });
      const d = await res.json();
      if (d.ok) {
        setProvTests((t) => ({
          ...t,
          [cap]: { ok: true, text: `${d.reply ?? "Connected"}${d.latencyMs ? ` · ${d.latencyMs} ms` : ""}` },
        }));
      } else if (d.needsConfirm) {
        setProvTests((t) => ({ ...t, [cap]: { ok: false, needsConfirm: true, text: d.error ?? "Confirm to run the paid test" } }));
      } else {
        setProvTests((t) => ({ ...t, [cap]: { ok: false, text: d.error ?? "Connection failed" } }));
      }
    } catch {
      setProvTests((t) => ({ ...t, [cap]: { ok: false, text: "Could not reach the server" } }));
    } finally {
      setProvTesting(null);
    }
  };

  /** Server-side: adopt the chat provider's saved account for this task. */
  const copyChatAccount = async (cap: CapabilityId) => {
    try {
      const res = await fetch("/api/settings/ai", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope: "capability",
          capability: cap,
          copyCredsFrom: "chat",
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await loadAi();
      toast({
        title: `${CAPABILITY_META[cap].label} now shares the script provider's account`,
        description: "Save & apply to make it permanent — or tweak it first.",
      });
    } catch {
      toast({
        title: "Could not copy the account",
        description: "Save the script provider first, then try again.",
        variant: "destructive",
      });
    }
  };

  if (!loaded) {
    return (
      <div className="max-w-2xl space-y-4">
        <Skeleton className="h-64 rounded-2xl bg-white/5" />
        <Skeleton className="h-44 rounded-2xl bg-white/5" />
        <Skeleton className="h-56 rounded-2xl bg-white/5" />
      </div>
    );
  }

  const rateFields: { key: "aiLlmPerMin" | "aiTtsPerMin" | "aiImagePerMin" | "aiVideoPerMin"; label: string; hint: string }[] = [
    { key: "aiLlmPerMin", label: "Text / LLM", hint: "scripts, bibles, research, VLM checks" },
    { key: "aiTtsPerMin", label: "TTS", hint: "voiceover chunks" },
    { key: "aiImagePerMin", label: "Images", hint: "thumbnails, portraits, scenes" },
    { key: "aiVideoPerMin", label: "Video (i2v)", hint: "CogVideoX clips" },
  ];

  return (
    <div className="max-w-2xl space-y-5">
      <Card className="glass rounded-2xl p-5 sm:p-6">
        <div className="flex items-center gap-2.5 mb-5">
          <div className="h-9 w-9 rounded-xl bg-brand-gradient flex items-center justify-center glow-red-soft shrink-0">
            <Zap className="h-4.5 w-4.5 text-white" />
          </div>
          <div>
            <h3 className="font-semibold leading-tight">Auto-Pilot Behavior</h3>
            <p className="text-xs text-muted-foreground">
              What the one-click pipeline does when you launch it
            </p>
          </div>
        </div>

        <div className="space-y-5">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <Mic className="h-4.5 w-4.5 text-primary mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-medium">Auto voiceover</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Render TTS narration automatically after the script
                </p>
              </div>
            </div>
            <Switch
              checked={form.autoVoiceover}
              onCheckedChange={(v) => setForm((f) => ({ ...f, autoVoiceover: v }))}
              aria-label="Toggle automatic voiceover"
            />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <ImageIcon className="h-4.5 w-4.5 text-primary mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-medium">Auto thumbnail</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Generate CogView cover art automatically after the voiceover
                </p>
              </div>
            </div>
            <Switch
              checked={form.autoThumbnail}
              onCheckedChange={(v) => setForm((f) => ({ ...f, autoThumbnail: v }))}
              aria-label="Toggle automatic thumbnail"
            />
          </div>
        </div>
      </Card>

      {/* Studio access — opt-in password lock for the whole app */}
      <SecurityAccessCard />

      {/* AI providers — mix and match: one provider per task, Z.ai creds shared */}
      <Card className="glass rounded-2xl p-5 sm:p-6">
        <div className="flex items-center gap-2.5 mb-1">
          <div className="h-9 w-9 rounded-xl bg-indigo-500/90 flex items-center justify-center shrink-0 shadow-[0_0_18px_rgba(99,102,241,0.25)]">
            <Bot className="h-4.5 w-4.5 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold leading-tight">AI Providers</h3>
            <p className="text-xs text-muted-foreground">
              Mix and match — point each task at the AI of your choice
            </p>
          </div>
        </div>

        {/* Shared AI credentials (built-in gateway) */}
        <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-3">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <p className="text-sm font-medium flex items-center gap-1.5">
                <KeyRound className="h-3.5 w-3.5 text-primary" />
                Shared AI credentials
                <Badge className="bg-indigo-500/15 text-indigo-300 border border-indigo-500/30 text-[10px]">
                  shared
                </Badge>
              </p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                One account for the built-in gateway — used by every task you leave on its default provider
              </p>
            </div>
            {zaiCreds.hasKey && (
              <Badge className="bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 text-[11px] shrink-0">
                {zaiCreds.maskedKey}
              </Badge>
            )}
          </div>
          <div className="grid sm:grid-cols-2 gap-3 [&>*]:min-w-0">
            <div className="space-y-1.5">
              <Label>API base URL</Label>
              <Input
                value={zaiCreds.baseUrl}
                onChange={(e) => setZaiCreds((f) => ({ ...f, baseUrl: e.target.value }))}
                placeholder={DEFAULT_ZAI_BASE_URL}
                className="bg-white/5 border-white/10 text-xs font-mono h-9"
              />
            </div>
            <div className="space-y-1.5">
              <Label>API key</Label>
              <Input
                value={zaiCreds.apiKey}
                onChange={(e) => setZaiCreds((f) => ({ ...f, apiKey: e.target.value }))}
                placeholder={zaiCreds.hasKey ? `saved (${zaiCreds.maskedKey}) — type to replace` : "Paste your API key"}
                type="password"
                className="bg-white/5 border-white/10 text-xs font-mono h-9"
              />
            </div>
          </div>
          <a
            href="https://z.ai/model-api"
            target="_blank"
            rel="noreferrer"
            className="text-[11px] text-muted-foreground hover:text-foreground underline underline-offset-2 inline-flex items-center gap-0.5"
          >
            Get a free API key <ExternalLink className="h-2.5 w-2.5" />
          </a>
        </div>

        {/* Per-task provider rows */}
        <div className="mt-4 space-y-3">
          {(["chat", "tts", "image", "video"] as CapabilityId[]).map((cap) => {
            const row = prov[cap];
            const meta = CAPABILITY_META[cap];
            const providers = PROVIDERS_BY_CAPABILITY[cap];
            const active = providers.find((p) => p.id === row.provider) ?? providers[0];
            const shortLabel = active.label.split(" (")[0];
            const CapIcon = cap === "chat" ? PenLine : cap === "tts" ? Mic : cap === "image" ? ImageIcon : Clapperboard;
            const test = provTests[cap];
            const chatRow = prov.chat;
            const canCopyChat =
              cap !== "chat" &&
              row.provider !== "zai" &&
              chatRow.provider === row.provider &&
              chatRow.hasKey;

            return (
              <div key={cap} className="rounded-xl border border-white/10 bg-white/[0.02] p-4 space-y-3">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="h-7 w-7 rounded-lg bg-white/6 flex items-center justify-center shrink-0">
                      <CapIcon className="h-3.5 w-3.5 text-primary" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{meta.label}</p>
                      <p className="text-[11px] text-muted-foreground truncate">{meta.desc}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    {row.provider !== "zai" && row.hasKey && (
                      <Badge className="bg-white/6 text-zinc-300 border border-white/10 text-[10px] shrink-0">
                        {shortLabel} · {row.maskedKey}
                      </Badge>
                    )}
                    <Select
                      value={row.provider}
                      onValueChange={(v) =>
                        setProv((f) => {
                          const p = providers.find((x) => x.id === v);
                          const fallbackModel =
                            v === "zai"
                              ? cap === "chat"
                                ? DEFAULT_CHAT_MODEL
                                : cap === "video"
                                  ? "cogvideox-3"
                                  : ""
                              : (p?.models[0]?.id ?? "");
                          return {
                            ...f,
                            [cap]: {
                              ...f[cap],
                              provider: v,
                              model: f[cap].provider === v ? f[cap].model : fallbackModel,
                              baseUrl: "",
                              apiKey: "",
                              hasKey: false,
                              maskedKey: "",
                            },
                          };
                        })
                      }
                    >
                      <SelectTrigger className="bg-white/5 border-white/10 text-xs h-9 w-[230px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {providers.map((p) => (
                          <SelectItem key={p.id} value={p.id} className="text-xs">
                            {p.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {row.provider === "zai" ? (
                  cap === "chat" ? (
                    <div className="grid sm:grid-cols-2 gap-3 [&>*]:min-w-0">
                      <div className="space-y-1.5">
                        <Label>Model</Label>
                        <Select
                          value={row.model}
                          onValueChange={(v) => setProv((f) => ({ ...f, chat: { ...f.chat, model: v } }))}
                        >
                          <SelectTrigger className="bg-white/5 border-white/10 text-xs h-9">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {CHAT_MODELS.map((m) => (
                              <SelectItem key={m.id} value={m.id} className="text-xs">
                                <span className="font-medium">{m.label}</span>
                                <span className="text-muted-foreground ml-1.5">{m.hint}</span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1.5">
                        <Label>Vision model (optional)</Label>
                        <Input
                          value={row.visionModel}
                          onChange={(e) =>
                            setProv((f) => ({ ...f, chat: { ...f.chat, visionModel: e.target.value } }))
                          }
                          placeholder="gateway default (e.g. glm-4.6v-flash)"
                          className="bg-white/5 border-white/10 text-xs font-mono h-9"
                        />
                      </div>
                    </div>
                  ) : cap === "video" ? (
                    <div className="space-y-1.5">
                      <Label>Video model</Label>
                      <Input
                        value={row.model}
                        onChange={(e) => setProv((f) => ({ ...f, video: { ...f.video, model: e.target.value } }))}
                        placeholder="cogvideox-3"
                        className="bg-white/5 border-white/10 text-xs font-mono h-9 max-w-xs"
                      />
                    </div>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">
                      Uses the shared Z.ai key above
                      {cap === "tts" ? " · 7 studio voices" : " · CogView art with identity-locked edits"}
                    </p>
                  )
                ) : (
                  <div className="space-y-3">
                    <div className="grid sm:grid-cols-2 gap-3 [&>*]:min-w-0">
                      <div className="space-y-1.5">
                        <Label>API base URL</Label>
                        <Input
                          value={row.baseUrl}
                          onChange={(e) =>
                            setProv((f) => ({ ...f, [cap]: { ...f[cap], baseUrl: e.target.value } }))
                          }
                          placeholder={active.defaultBaseUrl}
                          className="bg-white/5 border-white/10 text-xs font-mono h-9"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label>API key</Label>
                        <Input
                          value={row.apiKey}
                          onChange={(e) =>
                            setProv((f) => ({ ...f, [cap]: { ...f[cap], apiKey: e.target.value } }))
                          }
                          placeholder={row.hasKey ? `saved (${row.maskedKey}) — type to replace` : `Paste your ${shortLabel} key`}
                          type="password"
                          className="bg-white/5 border-white/10 text-xs font-mono h-9"
                        />
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <Label>Model</Label>
                      <Input
                        value={row.model}
                        onChange={(e) =>
                          setProv((f) => ({ ...f, [cap]: { ...f[cap], model: e.target.value } }))
                        }
                        placeholder={active.models[0]?.id ?? "model id"}
                        className="bg-white/5 border-white/10 text-xs font-mono h-9 max-w-xs"
                      />
                      {active.models.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          {active.models.slice(0, 5).map((m) => (
                            <button
                              key={m.id}
                              type="button"
                              onClick={() =>
                                setProv((f) => ({ ...f, [cap]: { ...f[cap], model: m.id } }))
                              }
                              className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
                                row.model === m.id
                                  ? "border-primary/50 bg-primary/15 text-primary"
                                  : "border-white/10 bg-white/4 text-muted-foreground hover:text-foreground"
                              }`}
                              title={m.hint ?? m.id}
                            >
                              {m.id}
                            </button>
                          ))}
                        </div>
                      )}
                      {cap === "chat" && (
                        <div className="space-y-1.5 pt-1">
                          <Label className="text-[11px]">Vision model (optional — quality gate)</Label>
                          <Input
                            value={row.visionModel}
                            onChange={(e) =>
                              setProv((f) => ({ ...f, chat: { ...f.chat, visionModel: e.target.value } }))
                            }
                            placeholder={row.model || "defaults to the script model"}
                            className="bg-white/5 border-white/10 text-xs font-mono h-9 max-w-xs"
                          />
                        </div>
                      )}
                      <p className="text-[10px] text-muted-foreground leading-relaxed">
                        {active.note}{" "}
                        <a
                          href={active.keyUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="underline underline-offset-2 hover:text-foreground inline-flex items-center gap-0.5"
                        >
                          Get a key <ExternalLink className="h-2.5 w-2.5" />
                        </a>
                      </p>
                    </div>
                    {canCopyChat && (
                      <button
                        type="button"
                        onClick={() => copyChatAccount(cap)}
                        className="text-[11px] text-muted-foreground hover:text-foreground underline underline-offset-2 inline-flex items-center gap-1"
                      >
                        <Copy className="h-3 w-3" />
                        Use the same account as Script writing
                      </button>
                    )}
                  </div>
                )}

                {cap !== "video" && (
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={provTesting === cap}
                      onClick={() => {
                        if (test?.needsConfirm) testCapability(cap, cap, true);
                        else testCapability(cap, cap);
                      }}
                      className="border-white/15 bg-white/6 hover:bg-white/10 h-7 text-[11px]"
                      title={cap === "image" ? "Generates a small real image — may cost a few cents" : "Send a tiny test request"}
                    >
                      {provTesting === cap ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <FlaskConical className="h-3 w-3" />
                      )}
                      {test?.needsConfirm ? "Confirm — runs a paid test" : "Test"}
                    </Button>
                    <span className="text-[10px] text-muted-foreground">
                      {cap === "chat"
                        ? "pings the model with a tiny prompt"
                        : cap === "tts"
                          ? "speaks one short sentence"
                          : "generates one small image (real cost)"}
                    </span>
                  </div>
                )}

                {test && (
                  <div
                    className={`rounded-lg border px-3 py-2 text-xs leading-relaxed ${
                      test.ok
                        ? "border-emerald-500/25 bg-emerald-500/8 text-emerald-200"
                        : "border-red-500/25 bg-red-500/8 text-red-200"
                    }`}
                  >
                    {test.ok ? "✓ " : "✗ "}
                    {test.text}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={saveProviders}
            disabled={provSaving}
            className="border-white/15 bg-white/6 hover:bg-white/10 font-medium h-8"
            variant="outline"
          >
            {provSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save &amp; apply
          </Button>
          <span className="text-[11px] text-muted-foreground">
            Applies to the very next AI call — no restart needed
          </span>
        </div>
      </Card>

      {/* Background music — licensed library, mood matching, mix defaults */}
      <MusicLibrarySection />

      {/* YouTube connection (Phase 4 — OAuth upload) */}
      <Card className="glass rounded-2xl p-5 sm:p-6">
        <div className="flex items-center gap-2.5 mb-1">
          <div className="h-9 w-9 rounded-xl bg-red-600/90 flex items-center justify-center shrink-0 shadow-[0_0_18px_rgba(239,43,70,0.25)]">
            <Youtube className="h-4.5 w-4.5 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold leading-tight">YouTube Connection</h3>
            <p className="text-xs text-muted-foreground">
              One-click uploads — render, title, tags, thumbnail and all
            </p>
          </div>
          {yt?.connected && yt.channelTitle && (
            <Badge className="bg-red-500/15 text-red-200 border border-red-500/30 text-[11px] shrink-0">
              <Check className="h-3 w-3 mr-1" />
              {yt.channelTitle}
            </Badge>
          )}
        </div>

        {yt?.connected ? (
          <div className="mt-4 rounded-xl border border-red-500/20 bg-red-500/6 p-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              {yt.channelThumb ? (
                <img src={yt.channelThumb} alt="Channel avatar" className="h-10 w-10 rounded-full border border-white/15" />
              ) : (
                <div className="h-10 w-10 rounded-full bg-white/8 flex items-center justify-center">
                  <Youtube className="h-4 w-4 text-red-200" />
                </div>
              )}
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{yt.channelTitle ?? "Connected channel"}</p>
                <p className="text-[11px] text-muted-foreground">
                  Uploads publish as {yt.privacyStatus} · uploads from the video dialog
                </p>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={disconnectYt}
              className="border-red-500/30 bg-red-500/8 text-red-200 hover:bg-red-500/15 h-7 text-xs"
            >
              Disconnect
            </Button>
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>OAuth client ID</Label>
                <Input
                  value={ytClientId}
                  onChange={(e) => setYtClientId(e.target.value)}
                  placeholder="1234-abc.apps.googleusercontent.com"
                  className="bg-white/5 border-white/10 text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Client secret</Label>
                <Input
                  value={ytClientSecret}
                  onChange={(e) => setYtClientSecret(e.target.value)}
                  placeholder={yt?.configured ? "saved — type to replace" : "GOCSPX-…"}
                  type="password"
                  className="bg-white/5 border-white/10 text-xs"
                />
              </div>
            </div>

            <div className="rounded-xl border border-white/10 bg-white/3 p-3">
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                In <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer" className="text-foreground/80 hover:text-foreground underline underline-offset-2 inline-flex items-center gap-0.5">Google Cloud Console <ExternalLink className="h-2.5 w-2.5" /></a> create an OAuth client (Web application) and add this exact authorized redirect URI:
              </p>
              <div className="flex items-center gap-2 mt-2">
                <code className="flex-1 min-w-0 truncate rounded-lg bg-black/40 border border-white/10 px-2.5 py-1.5 text-[11px] text-foreground/80">
                  {yt?.callbackUrl ?? "…"}
                </code>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={copyCallbackUrl}
                  className="h-7 px-2.5 border-white/15 bg-white/4 shrink-0"
                  title="Copy the redirect URI"
                >
                  {ytCopied ? <Check className="h-3 w-3 text-emerald-300" /> : <Copy className="h-3 w-3" />}
                </Button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                onClick={saveYtCredentials}
                disabled={ytSaving || (!ytClientId.trim() && !ytClientSecret.trim())}
                className="border-white/15 bg-white/6 hover:bg-white/10 font-medium h-8"
                variant="outline"
              >
                {ytSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                Save credentials
              </Button>
              <Button
                size="sm"
                onClick={startConnect}
                disabled={ytConnecting || !yt?.configured}
                className="bg-brand-gradient hover:opacity-90 text-white font-medium h-8"
                title={yt?.configured ? "Opens the Google consent page in a new tab" : "Save your client ID and secret first"}
              >
                {ytConnecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Youtube className="h-3.5 w-3.5" />}
                Connect channel
              </Button>
              <Select
                value={yt?.privacyStatus ?? "unlisted"}
                onValueChange={async (v) => {
                  await fetch("/api/youtube/config", {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ privacyStatus: v }),
                  });
                  void loadYouTube();
                }}
              >
                <SelectTrigger className="h-8 w-[130px] bg-white/5 border-white/10 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-popover border-white/10">
                  <SelectItem value="unlisted">Upload as unlisted</SelectItem>
                  <SelectItem value="public">Upload as public</SelectItem>
                  <SelectItem value="private">Upload as private</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        )}
      </Card>

      <Card className="glass rounded-2xl p-5 sm:p-6">
        <h3 className="font-semibold">Content Defaults</h3>
        <p className="text-xs text-muted-foreground mb-5">
          Pre-fills the Create studio every time
        </p>

        <div className="grid sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label>Default niche</Label>
            <Select
              value={form.defaultNiche}
              onValueChange={(v) => setForm((f) => ({ ...f, defaultNiche: v }))}
            >
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
            <Label>Default tone</Label>
            <Select
              value={form.defaultTone}
              onValueChange={(v) => setForm((f) => ({ ...f, defaultTone: v }))}
            >
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
            <Label>Default length</Label>
            <Select
              value={form.defaultLength}
              onValueChange={(v) => setForm((f) => ({ ...f, defaultLength: v }))}
            >
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
            <Label>Default narrator</Label>
            <VoiceSelectWithPreview
              value={form.defaultVoice}
              onValueChange={(v) => setForm((f) => ({ ...f, defaultVoice: v }))}
              voices={voices}
            />
            <p className="text-[10px] text-muted-foreground leading-relaxed">
              Tap the <span className="text-primary">▶</span> next to a voice in the picker to hear
              how it sounds.
            </p>
          </div>
          <div className="space-y-2 sm:col-span-2">
            <div className="flex items-center justify-between">
              <Label>Default speech speed</Label>
              <span className="text-xs font-medium tabular-nums text-primary">
                {Number(form.defaultSpeed).toFixed(1)}x
              </span>
            </div>
            <Slider
              value={[Number(form.defaultSpeed)]}
              min={0.5}
              max={2}
              step={0.1}
              onValueChange={([v]) => setForm((f) => ({ ...f, defaultSpeed: v }))}
              aria-label="Default speech speed"
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label>Default thumbnail style</Label>
            <Select
              value={form.defaultThumbStyle}
              onValueChange={(v) => setForm((f) => ({ ...f, defaultThumbStyle: v }))}
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
        </div>
      </Card>

      <Card className="glass rounded-2xl p-5 sm:p-6">
        <div className="flex items-center gap-2.5 mb-5">
          <div className="h-9 w-9 rounded-xl bg-brand-gradient flex items-center justify-center glow-red-soft shrink-0">
            <ShieldCheck className="h-4.5 w-4.5 text-white" />
          </div>
          <div>
            <h3 className="font-semibold leading-tight">Pipeline Robustness</h3>
            <p className="text-xs text-muted-foreground">
              Quality gates and rate budgets that keep generations clean
            </p>
          </div>
        </div>

        <div className="space-y-5">
          <div className="grid sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>VLM quality gate</Label>
              <Select
                value={form.qualityGate}
                onValueChange={(v) => setForm((f) => ({ ...f, qualityGate: v }))}
              >
                <SelectTrigger className="bg-white/5">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="off">Off — generate blind</SelectItem>
                  <SelectItem value="thumbnails">Thumbnails only</SelectItem>
                  <SelectItem value="all">Thumbnails + storyboard scenes</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                A vision model inspects generated art and re-rolls it once when
                it scores below the threshold.
              </p>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Re-roll threshold</Label>
                <span className="text-xs font-medium tabular-nums text-primary">
                  {form.qualityThreshold}/10
                </span>
              </div>
              <Slider
                value={[Number(form.qualityThreshold)]}
                min={1}
                max={9}
                step={1}
                onValueChange={([v]) => setForm((f) => ({ ...f, qualityThreshold: v }))}
                aria-label="Quality re-roll threshold"
              />
              <p className="text-[11px] text-muted-foreground">
                Images scoring under this get one automatic re-roll (best attempt is kept).
              </p>
            </div>
          </div>

          <Separator className="bg-white/8" />

          <div className="flex items-center justify-between gap-4">
            <div className="flex items-start gap-3">
              <Gauge className="h-4.5 w-4.5 text-primary mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-medium">Global AI rate budget</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Paces concurrent jobs so they never trip upstream 429s —
                  shared cool-downs when one call still does
                </p>
              </div>
            </div>
            <Switch
              checked={form.aiBudgetEnabled}
              onCheckedChange={(v) => setForm((f) => ({ ...f, aiBudgetEnabled: v }))}
              aria-label="Toggle global AI rate budget"
            />
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {rateFields.map((r) => (
              <div key={r.key} className="space-y-1.5">
                <Label className="text-xs">{r.label} / min</Label>
                <Input
                  type="number"
                  min={1}
                  max={600}
                  value={form[r.key]}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, [r.key]: Math.max(1, Number(e.target.value) || 1) }))
                  }
                  className="bg-white/5 tabular-nums"
                  aria-label={`${r.label} calls per minute`}
                />
                <p className="text-[10px] leading-tight text-muted-foreground">{r.hint}</p>
              </div>
            ))}
          </div>
        </div>

        <Separator className="my-6 bg-white/8" />

        <div className="flex justify-end">
          <Button
            onClick={handleSave}
            disabled={saving}
            className="bg-brand-gradient hover:opacity-90 font-semibold min-w-36"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Save Settings
          </Button>
        </div>
      </Card>

      <Card className="glass rounded-2xl p-5 sm:p-6">
        <div className="flex items-center justify-between gap-3 mb-1">
          <div className="flex items-center gap-2.5">
            <div className="h-9 w-9 rounded-xl bg-white/10 flex items-center justify-center shrink-0">
              <History className="h-4.5 w-4.5 text-primary" />
            </div>
            <div>
              <h3 className="font-semibold leading-tight">Background Jobs</h3>
              <p className="text-xs text-muted-foreground">
                Persistent queue — survives restarts, flags interrupted stages
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void loadJobs()}
            disabled={jobsLoading}
            className="gap-1.5 shrink-0"
            aria-label="Refresh job history"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${jobsLoading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        <div className="mt-4 space-y-2 max-h-96 overflow-y-auto scroll-area-bar pr-1">
          {jobs.length === 0 && (
            <p className="text-sm text-muted-foreground py-6 text-center">
              No jobs yet — generate something and it will show up here with its
              full lifecycle.
            </p>
          )}
          {jobs.map((job) => {
            const meta = KIND_META[job.kind] ?? { label: job.kind, icon: LayoutGrid };
            const status = STATUS_META[job.status] ?? STATUS_META.done;
            const Icon = meta.icon;
            return (
              <div
                key={job.id}
                className="flex items-center gap-3 rounded-xl border border-white/8 bg-white/3 px-3 py-2.5"
              >
                <div className="h-8 w-8 rounded-lg bg-white/8 flex items-center justify-center shrink-0">
                  <Icon className="h-4 w-4 text-primary" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-medium truncate">{meta.label}</p>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-md border font-semibold ${status.cls} ${job.status === "running" ? "animate-pulse" : ""}`}>
                      {status.label}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground truncate">
                    {job.entityTitle ?? job.entityId}
                    {job.error ? ` — ${job.error}` : ""}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-xs font-medium tabular-nums">
                    {formatDuration(job.durationMs)}
                  </p>
                  <p className="text-[10px] text-muted-foreground">
                    {new Date(job.startedAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
