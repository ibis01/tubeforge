"use client";

import { useCallback, useEffect, useState } from "react";
import { useAppStore } from "@/lib/store";
import { useToast } from "@/hooks/use-toast";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
import { VOICES, NICHES, TONES, LENGTHS, THUMB_STYLES, type JobDTO } from "@/lib/tubeforge/types";
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
} from "lucide-react";

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
  }, [loadJobs]);

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
            <Select
              value={form.defaultVoice}
              onValueChange={(v) => setForm((f) => ({ ...f, defaultVoice: v }))}
            >
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
