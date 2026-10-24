"use client";

import { useEffect, useState } from "react";
import { useAppStore } from "@/lib/store";
import { useToast } from "@/hooks/use-toast";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
import { VOICES, NICHES, TONES, LENGTHS, THUMB_STYLES } from "@/lib/tubeforge/types";
import { Save, Loader2, Zap, Mic, ImageIcon } from "lucide-react";

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
  });

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
        }));
      })
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, []);

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
        description: "Auto-Pilot will use these defaults on the next run.",
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
      </div>
    );
  }

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
    </div>
  );
}
