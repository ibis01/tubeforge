"use client";

// Shared "add a licensed track" upload dialog (S44).
//
// Born in settings-music.tsx (Settings → Background Music); S44 lifts it into
// a shared module so the PER-VIDEO MusicPickerCard can offer the same door —
// "use my own background sound" where the user actually is, not three
// screens away in Settings. The backend (POST /api/music multipart) was
// already complete: sniff + loudness-normalize + license metadata + org
// quota. onUploaded receives the new track's id so the picker can pin it.

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
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
import { Upload, FileAudio } from "lucide-react";
import { toast } from "sonner";
import type { MusicTrackDTO } from "@/components/tubeforge/music-controls";

export function MusicUploadDialog({
  onUploaded,
  trigger,
  triggerClassName = "h-8 text-xs",
}: {
  /** Called with the new track's id after a successful ingest. */
  onUploaded: (trackId: string) => void;
  /** Optional custom trigger (defaults to the "Add licensed track" button). */
  trigger?: React.ReactNode;
  triggerClassName?: string;
}) {
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
      const d = (await res.json()) as { track?: MusicTrackDTO; error?: string };
      if (!res.ok || !d.track) throw new Error(d.error ?? "Upload failed");
      toast.success("Track added to the library");
      setOpen(false);
      setFile(null);
      setForm({ ...form, name: "", moods: "", licenseType: "", sourceUrl: "", attributionText: "", licenseEvidence: "", contentIdNotes: "" });
      onUploaded(d.track.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button size="sm" variant="outline" className={triggerClassName}>
            <Upload className="h-3.5 w-3.5" /> Add licensed track
          </Button>
        )}
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
                  placeholder="“Song Title” by Artist — https://…"
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
