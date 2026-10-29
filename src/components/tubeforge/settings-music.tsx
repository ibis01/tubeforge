"use client";

// Settings → Background Music section: defaults (mode/volume/fades), the
// licensed track library with license badges + previews, upload dialog with
// full license metadata, and re-synthesis of the TubeForge originals.

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Music2,
  Upload,
  BadgeCheck,
  ShieldCheck,
  ShieldAlert,
  RefreshCw,
  Trash2,
  FileAudio,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import {
  useMusicLibrary,
  saveMusicSettings,
  TrackPreviewButton,
  DUCK_LEVELS,
  type MusicTrackDTO,
} from "@/components/tubeforge/music-controls";

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

function LicenseBadge({ track }: { track: MusicTrackDTO }) {
  const l = track.license;
  if (l.commercialUse && !l.attributionRequired)
    return (
      <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/20">
        <BadgeCheck className="h-3 w-3" /> {l.type}
      </span>
    );
  if (!l.commercialUse)
    return (
      <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-300 border border-amber-500/20">
        <ShieldAlert className="h-3 w-3" /> Non-commercial
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-sky-500/15 text-sky-300 border border-sky-500/20">
      <ShieldCheck className="h-3 w-3" /> {l.type} · credit required
    </span>
  );
}

function UploadDialog({ onUploaded }: { onUploaded: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [form, setForm] = useState({
    name: "",
    moods: "",
    genre: "",
    licenseType: "",
    sourceUrl: "",
    commercialUse: true,
    attributionRequired: false,
    attributionText: "",
    licenseEvidence: "",
    contentIdNotes: "",
  });

  const submit = async () => {
    if (!file) return toast.error("Pick an audio file first");
    if (!form.licenseType) return toast.error("License type is required");
    if (form.attributionRequired && !form.attributionText)
      return toast.error("Add the exact credit line for attribution licenses");
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      for (const [k, v] of Object.entries(form)) fd.append(k, String(v));
      const res = await fetch("/api/music", { method: "POST", body: fd });
      const d = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(d.error ?? "Upload failed");
      toast.success("Track added to the library");
      setOpen(false);
      setFile(null);
      setForm({ ...form, name: "", moods: "", licenseType: "", sourceUrl: "", attributionText: "", licenseEvidence: "", contentIdNotes: "" });
      onUploaded();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="h-8 text-xs">
          <Upload className="h-3.5 w-3.5" /> Add licensed track
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto scroll-area-bar">
        <DialogHeader>
          <DialogTitle>Add a licensed track</DialogTitle>
          <DialogDescription>
            Only upload music you have the rights to. The license record below is
            kept with the track so every upload can prove its soundtrack is safe.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3.5 text-sm">
          <div className="space-y-1.5">
            <Label className="text-xs">Audio file (mp3 / wav / m4a / flac — max 60 MB)</Label>
            <div className="flex items-center gap-2">
              <FileAudio className="h-4 w-4 text-muted-foreground shrink-0" />
              <Input
                type="file"
                accept="audio/*,.flac,.mp3,.wav,.m4a,.ogg"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="text-xs h-8"
                aria-label="Audio file"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Track name</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Neon Nights"
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Mood tags (comma separated)</Label>
              <Input
                value={form.moods}
                onChange={(e) => setForm((f) => ({ ...f, moods: e.target.value }))}
                placeholder="motivation,uplifting"
                className="h-8 text-xs"
              />
            </div>
          </div>

          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3.5 space-y-3">
            <p className="text-xs font-medium">License record</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">License type *</Label>
                <Input
                  value={form.licenseType}
                  onChange={(e) => setForm((f) => ({ ...f, licenseType: e.target.value }))}
                  placeholder="YouTube Audio Library / CC BY 4.0 / Commercial…"
                  className="h-8 text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Source URL</Label>
                <Input
                  value={form.sourceUrl}
                  onChange={(e) => setForm((f) => ({ ...f, sourceUrl: e.target.value }))}
                  placeholder="https://…"
                  className="h-8 text-xs"
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-4">
              <label className="flex items-center gap-2 text-xs">
                <Switch
                  checked={form.commercialUse}
                  onCheckedChange={(v) => setForm((f) => ({ ...f, commercialUse: v }))}
                  aria-label="Commercial use allowed"
                />
                Commercial use allowed
              </label>
              <label className="flex items-center gap-2 text-xs">
                <Switch
                  checked={form.attributionRequired}
                  onCheckedChange={(v) => setForm((f) => ({ ...f, attributionRequired: v }))}
                  aria-label="Attribution required"
                />
                Attribution required
              </label>
            </div>
            {form.attributionRequired && (
              <div className="space-y-1.5">
                <Label className="text-xs">Exact credit line (goes in your video description)</Label>
                <Input
                  value={form.attributionText}
                  onChange={(e) => setForm((f) => ({ ...f, attributionText: e.target.value }))}
                  placeholder='“Song Title” by Artist — https://…'
                  className="h-8 text-xs"
                />
              </div>
            )}
            <div className="space-y-1.5">
              <Label className="text-xs">License evidence (URL or note)</Label>
              <Input
                value={form.licenseEvidence}
                onChange={(e) => setForm((f) => ({ ...f, licenseEvidence: e.target.value }))}
                placeholder="Screenshot / license page"
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Known Content ID notes (optional)</Label>
              <Input
                value={form.contentIdNotes}
                onChange={(e) => setForm((f) => ({ ...f, contentIdNotes: e.target.value }))}
                placeholder="Third-party claims you already know about"
                className="h-8 text-xs"
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button onClick={submit} disabled={busy} className="bg-brand-gradient text-white font-semibold">
            {busy ? "Ingesting…" : "Add to library"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function MusicLibrarySection() {
  const { tracks, settings, loading, reload, setSettings } = useMusicLibrary();
  const [seeding, setSeeding] = useState(false);
  const [sfxOn, setSfxOn] = useState<boolean | null>(null);

  // SFX toggle state comes from the settings map (GET /api/settings).
  useEffect(() => {
    if (sfxOn !== null) return;
    void fetch("/api/settings", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { settings?: Record<string, string> } | null) => {
        if (d?.settings && "sfx.enabled" in d.settings)
          setSfxOn(d.settings["sfx.enabled"] === "true");
      })
      .catch(() => {});
  }, [sfxOn]);

  const patch = async (p: Parameters<typeof saveMusicSettings>[0]) => {
    setSettings((s) => (s ? { ...s, ...p } : s));
    await saveMusicSettings(p);
  };

  const reseed = async () => {
    setSeeding(true);
    try {
      const res = await fetch("/api/music", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "seed" }),
      });
      const d = (await res.json()) as { created?: number };
      toast.success(`Original library verified (${d.created ?? 0} synthesized)`);
      reload();
    } catch {
      toast.error("Re-synthesis failed");
    } finally {
      setSeeding(false);
    }
  };

  const toggleActive = async (t: MusicTrackDTO) => {
    const res = await fetch(`/api/music/${t.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !t.isActive }),
    });
    if (res.ok) reload();
    else toast.error("Could not update the track");
  };

  const remove = async (t: MusicTrackDTO) => {
    if (!window.confirm(`Delete "${t.name}" from the library?`)) return;
    const res = await fetch(`/api/music/${t.id}`, { method: "DELETE" });
    if (res.ok) {
      toast.success("Track removed");
      reload();
    } else toast.error("Could not remove the track");
  };

  return (
    <Card className="glass rounded-2xl p-5 sm:p-6">
      <div className="flex items-center gap-2.5 mb-1">
        <div className="h-9 w-9 rounded-xl bg-brand-gradient flex items-center justify-center shrink-0 glow-red-soft">
          <Music2 className="h-4.5 w-4.5 text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold leading-tight">Background Music</h3>
          <p className="text-xs text-muted-foreground">
            Licensed library, mood-matched per niche, ducked under narration
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            className="h-8 text-xs"
            onClick={reseed}
            disabled={seeding}
            aria-label="Re-synthesize the original library"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${seeding ? "animate-spin" : ""}`} /> Restore originals
          </Button>
          <UploadDialog onUploaded={reload} />
        </div>
      </div>

      {/* Defaults */}
      {settings && (
        <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs font-medium">Defaults for new videos</p>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch
                checked={settings.enabled}
                onCheckedChange={(v) => void patch({ enabled: v })}
                aria-label="Music on by default"
              />
              Music on
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xs text-muted-foreground">Track choice</span>
            <Select
              value={settings.mode === "manual" ? (settings.trackId ?? "manual-none") : "auto"}
              onValueChange={(v) =>
                v === "auto"
                  ? void patch({ mode: "auto" })
                  : void patch({ mode: "manual", trackId: v === "manual-none" ? null : v })
              }
            >
              <SelectTrigger className="w-64 h-8 text-xs" aria-label="Default track choice">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto" className="text-xs">
                  Auto mood-match (follows the video niche)
                </SelectItem>
                <SelectItem value="manual-none" className="text-xs text-muted-foreground">
                  Manual — pick below…
                </SelectItem>
                {tracks.filter((t) => t.isActive).map((t) => (
                  <SelectItem key={t.id} value={t.id} className="text-xs">
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Default volume</span>
                <span className="tabular-nums">{Math.round(settings.volume * 100)}%</span>
              </div>
              <Slider
                value={[Math.round(settings.volume * 100)]}
                min={0}
                max={100}
                step={5}
                onValueChange={([v]) => setSettings((s) => (s ? { ...s, volume: v / 100 } : s))}
                onValueCommit={([v]) => void patch({ volume: v / 100 })}
                aria-label="Default music volume"
              />
            </div>
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">Fade in / out</span>
                <span className="tabular-nums">
                  {settings.fadeInSec.toFixed(1)}s / {settings.fadeOutSec.toFixed(1)}s
                </span>
              </div>
              <Slider
                value={[settings.fadeInSec, settings.fadeOutSec]}
                min={0.5}
                max={8}
                step={0.5}
                onValueChange={([a, b]) =>
                  setSettings((s) => (s ? { ...s, fadeInSec: a, fadeOutSec: b } : s))
                }
                onValueCommit={([a, b]) => void patch({ fadeInSec: a, fadeOutSec: b })}
                aria-label="Default fade in and out"
              />
            </div>
          </div>

          {/* Auto-ducking defaults + SFX toggle */}
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-white/5 pt-3">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch
                checked={settings.ducking}
                onCheckedChange={(v) => void patch({ ducking: v })}
                aria-label="Auto-ducking on by default"
              />
              Auto-duck under narration
            </label>
            {settings.ducking && (
              <div className="flex gap-1 rounded-lg border border-white/10 p-0.5">
                {DUCK_LEVELS.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => void patch({ duckingIntensity: l.id })}
                    aria-pressed={settings.duckingIntensity === l.id}
                    className={`px-2.5 py-0.5 text-[10px] rounded-md transition-colors ${
                      settings.duckingIntensity === l.id
                        ? "bg-primary/20 text-primary"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {l.label}
                  </button>
                ))}
              </div>
            )}
            <label className="flex items-center gap-2 text-xs text-muted-foreground ml-auto">
              <Switch
                checked={sfxOn ?? true}
                onCheckedChange={(v) => {
                  setSfxOn(v);
                  void saveMusicSettings({ "sfx.enabled": v });
                }}
                aria-label="Sound-effect cues"
              />
              <Zap className="h-3 w-3" /> SFX cues
            </label>
          </div>
        </div>
      )}

      {/* Library */}
      <div className="mt-4 space-y-2">
        {loading ? (
          <p className="text-xs text-muted-foreground py-2">Loading library…</p>
        ) : (
          <div className="max-h-96 overflow-y-auto scroll-area-bar rounded-xl border border-white/10 divide-y divide-white/5">
            {tracks.map((t) => (
              <div key={t.id} className="flex items-center gap-3 px-3.5 py-2.5 hover:bg-white/[0.03]">
                <TrackPreviewButton track={t} />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium truncate">
                    {t.name}
                    {t.isOriginal && (
                      <span className="ml-1.5 text-[10px] text-muted-foreground">original</span>
                    )}
                  </p>
                  <p className="text-[10px] text-muted-foreground truncate">
                    {fmt(t.durationSec)} · {(t.fileSizeBytes / 1048576).toFixed(1)} MB ·{" "}
                    {t.moods.slice(0, 3).join(" / ")}
                    {t.license.contentIdNotes ? ` · ⚠ ${t.license.contentIdNotes.slice(0, 40)}` : ""}
                  </p>
                </div>
                <LicenseBadge track={t} />
                <Switch
                  checked={t.isActive}
                  onCheckedChange={() => void toggleActive(t)}
                  aria-label={`${t.isActive ? "Disable" : "Enable"} ${t.name}`}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 text-muted-foreground hover:text-red-400"
                  onClick={() => void remove(t)}
                  aria-label={`Delete ${t.name}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
        <p className="text-[10px] text-muted-foreground leading-relaxed">
          TubeForge originals are synthesized in-app from pure oscillators — no third-party
          audio, no Content ID risk. Uploaded tracks are loudness-normalized (−16 LUFS) and
          mixed ~20 dB under narration with automatic ducking; voiceover WAVs are never
          re-rendered when you swap soundtracks.
        </p>
      </div>
    </Card>
  );
}
