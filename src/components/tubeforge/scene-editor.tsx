"use client";

// Scene Studio — per-scene image editing dialog ("edit each storyboard image
// to suit my taste"). Four ways to shape a scene's art, all in one place:
//   • Art style   — 11-style taste palette (SCENE_ART_STYLES) woven into the
//                   scene's image prompt at generation time
//   • Prompt      — edit the visual prompt / mood text, save, regenerate
//   • AI edit     — instruction-based edit of the CURRENT image ("make it
//                   night, remove the crowd") that keeps the composition
//   • Upload      — replace with your own artwork (cover-cropped to the
//                   pipeline canvas server-side)
//
// Text edits (PATCH) never invalidate the render; image actions do (the
// server deletes stale MP4s), which the copy below makes explicit.

import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { clsx } from "clsx";
import {
  Brush,
  ImageUp,
  Loader2,
  RefreshCw,
  Save,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { SCENE_ART_STYLES, type SceneDTO } from "@/lib/tubeforge/types";

type Busy = "save" | "regen" | "edit" | "upload" | null;

export function SceneEditorDialog({
  videoId,
  scene,
  open,
  onOpenChange,
  onUpdated,
}: {
  videoId: string;
  scene: SceneDTO | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Called after ANY successful change so the parent refreshes storyboard + video. */
  onUpdated: () => void;
}) {
  const [visual, setVisual] = useState("");
  const [mood, setMood] = useState("");
  const [style, setStyle] = useState("default");
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  // Re-seed local state whenever a different scene opens.
  useEffect(() => {
    if (scene) {
      setVisual(scene.visual);
      setMood(scene.mood);
      setStyle(scene.style || "default");
      setInstruction("");
      setPendingFile(null);
    }
  }, [scene?.index, scene?.imageUrl, open]);

  if (!scene) return null;

  const dirty =
    visual !== scene.visual || mood !== scene.mood || style !== (scene.style || "default");

  const fail = (e: unknown, fallback: string) =>
    toast.error(e instanceof Error ? e.message : fallback, {
      description: e instanceof Error ? undefined : fallback,
    });

  /** PATCH the scene text; returns true on success. */
  const saveText = async (silent = false): Promise<boolean> => {
    if (!dirty) return true;
    try {
      const res = await fetch(`/api/videos/${videoId}/scenes`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index: scene.index, visual, mood, style }),
      });
      const d = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(d.error ?? "Could not save scene changes");
      if (!silent) toast.success(`Scene ${scene.index} updated`);
      onUpdated();
      return true;
    } catch (e) {
      fail(e, "Could not save scene changes");
      return false;
    }
  };

  const onSave = async () => {
    setBusy("save");
    await saveText();
    setBusy(null);
  };

  /** Save text edits first, then repaint from the saved prompt. */
  const onRegenerate = async () => {
    setBusy("regen");
    if (!(await saveText(true))) {
      setBusy(null);
      return;
    }
    try {
      const res = await fetch(`/api/videos/${videoId}/storyboard`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scene: scene.index }),
      });
      const d = (await res.json()) as { accepted?: boolean; error?: string };
      if (!res.ok) throw new Error(d.error ?? "Scene re-roll failed");
      toast.success(`Repainting scene ${scene.index}…`, {
        description: "The image regenerates in the background — pollination takes a moment.",
      });
      onOpenChange(false);
      onUpdated();
    } catch (e) {
      fail(e, "Scene re-roll failed");
    } finally {
      setBusy(null);
    }
  };

  const onAiEdit = async () => {
    if (instruction.trim().length < 3) {
      toast.error("Describe the change first — e.g. “make it night with warm window light”");
      return;
    }
    setBusy("edit");
    try {
      const res = await fetch(`/api/videos/${videoId}/storyboard`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scene: scene.index, instruction: instruction.trim() }),
      });
      const d = (await res.json()) as { accepted?: boolean; error?: string };
      if (!res.ok) throw new Error(d.error ?? "AI edit failed");
      toast.success(`Editing scene ${scene.index}…`, {
        description: "The composition is kept — only your requested change is applied.",
      });
      onOpenChange(false);
      onUpdated();
    } catch (e) {
      fail(e, "AI edit failed");
    } finally {
      setBusy(null);
    }
  };

  const onUpload = async () => {
    if (!pendingFile) {
      toast.error("Choose an image first");
      return;
    }
    setBusy("upload");
    try {
      const form = new FormData();
      form.set("scene", String(scene.index));
      form.set("file", pendingFile);
      const res = await fetch(`/api/videos/${videoId}/storyboard/upload`, {
        method: "POST",
        body: form,
      });
      const d = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(d.error ?? "Upload failed");
      toast.success(`Scene ${scene.index} now uses your artwork`, {
        description: "Existing renders were removed — render again to rebuild the video.",
      });
      setPendingFile(null);
      onOpenChange(false);
      onUpdated();
    } catch (e) {
      fail(e, "Upload failed");
    } finally {
      setBusy(null);
    }
  };

  const anyBusy = busy !== null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto glass border-white/12">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Brush className="h-4 w-4 text-primary" />
            Scene {scene.index} Studio — {scene.title}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Shape this scene&apos;s art to your taste — style, prompt, AI edits or
            your own image. Narration is never touched.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {/* Current art */}
          <div className="relative rounded-xl overflow-hidden border border-white/10">
            {scene.hasImage ? (
              <img
                src={scene.imageUrl ?? ""}
                alt={`Scene ${scene.index}: ${scene.title}`}
                className="w-full aspect-video object-cover"
              />
            ) : (
              <div className="w-full aspect-video bg-white/4 flex items-center justify-center text-[11px] text-muted-foreground">
                No art yet — set the look below and regenerate
              </div>
            )}
            {scene.hasStock && (
              <span className="absolute bottom-2 right-2 rounded-md bg-black/70 px-1.5 py-0.5 text-[9px] text-white">
                stock clip plays in this scene
              </span>
            )}
          </div>

          {/* Art style palette */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Art style</Label>
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-1.5">
              {SCENE_ART_STYLES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  disabled={anyBusy}
                  onClick={() => setStyle(s.id)}
                  aria-pressed={style === s.id}
                  className={clsx(
                    "rounded-lg border px-2 py-1.5 text-[11px] transition-all",
                    style === s.id
                      ? "border-primary/50 bg-primary/8 text-foreground"
                      : "border-white/10 bg-white/3 hover:border-white/25 text-muted-foreground"
                  )}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-muted-foreground/80">
              {SCENE_ART_STYLES.find((s) => s.id === style)?.prompt ||
                "The standard TubeForge cinematic look"}
            </p>
          </div>

          {/* Prompt + mood */}
          <div className="space-y-2.5">
            <div className="space-y-1.5">
              <Label htmlFor={`visual-${scene.index}`} className="text-xs text-muted-foreground">
                Visual prompt — what the image paints
              </Label>
              <Textarea
                id={`visual-${scene.index}`}
                value={visual}
                onChange={(e) => setVisual(e.target.value)}
                rows={3}
                maxLength={1200}
                disabled={anyBusy}
                className="text-xs"
                placeholder="Concrete subject doing something, in a specific place, at a specific time of day…"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`mood-${scene.index}`} className="text-xs text-muted-foreground">
                Mood — palette &amp; lighting keywords
              </Label>
              <Input
                id={`mood-${scene.index}`}
                value={mood}
                onChange={(e) => setMood(e.target.value)}
                maxLength={200}
                disabled={anyBusy}
                className="h-8 text-xs"
                placeholder="teal shadows, cold moonlight, volumetric haze"
              />
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={anyBusy || !dirty}
                onClick={onSave}
                className="h-8 text-xs"
              >
                {busy === "save" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                Save changes
              </Button>
              <Button
                size="sm"
                disabled={anyBusy}
                onClick={onRegenerate}
                className="h-8 text-xs bg-brand-gradient hover:opacity-90 font-medium"
              >
                {busy === "regen" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                {dirty ? "Save & regenerate" : "Regenerate image"}
              </Button>
            </div>
          </div>

          {/* AI edit */}
          <div className="space-y-1.5 rounded-xl border border-white/10 bg-white/3 p-3">
            <div className="flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              <Label className="text-xs">AI edit — keep the shot, change the details</Label>
            </div>
            <p className="text-[10px] text-muted-foreground">
              Describe a change and the model repaints THIS image in place —
              same composition, your tweak. Perfect for “make it night”,
              “warmer light”, “remove the crowd”.
            </p>
            <div className="flex items-center gap-2">
              <Input
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                maxLength={500}
                disabled={anyBusy || !scene.hasImage}
                className="h-8 flex-1 text-xs"
                placeholder="e.g. make it night with warm window light"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !anyBusy) void onAiEdit();
                }}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={anyBusy || !scene.hasImage}
                onClick={onAiEdit}
                className="h-8 text-xs"
              >
                {busy === "edit" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                Apply
              </Button>
            </div>
            {!scene.hasImage && (
              <p className="text-[10px] text-amber-300/90">
                Generate this scene&apos;s image first — edits need art to work from.
              </p>
            )}
          </div>

          {/* Upload replacement */}
          <div className="space-y-1.5 rounded-xl border border-white/10 bg-white/3 p-3">
            <div className="flex items-center gap-1.5">
              <ImageUp className="h-3.5 w-3.5 text-primary" />
              <Label className="text-xs">Use your own image</Label>
            </div>
            <p className="text-[10px] text-muted-foreground">
              PNG / JPEG / WebP up to 15 MB. It&apos;s center-cropped to the
              video canvas (16:9) automatically. Replacing art removes existing
              renders — render again afterwards.
            </p>
            <div className="flex items-center gap-2">
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => setPendingFile(e.target.files?.[0] ?? null)}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={anyBusy}
                onClick={() => fileRef.current?.click()}
                className="h-8 text-xs"
              >
                {pendingFile ? pendingFile.name.slice(0, 32) : "Choose image…"}
              </Button>
              <Button
                size="sm"
                disabled={anyBusy || !pendingFile}
                onClick={onUpload}
                className="h-8 text-xs bg-brand-gradient hover:opacity-90 font-medium"
              >
                {busy === "upload" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImageUp className="h-3.5 w-3.5" />}
                Replace scene art
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
