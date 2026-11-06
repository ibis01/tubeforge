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
  Presentation,
  RefreshCw,
  Save,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { SCENE_ART_STYLES, type SceneDTO, type SlideDTO } from "@/lib/tubeforge/types";

type Busy = "save" | "regen" | "edit" | "upload" | null;

/** Friendly labels for the slide layout catalog (slides.ts SLIDE_LAYOUTS). */
const SLIDE_LAYOUT_LABELS: Record<string, string> = {
  statement: "Statement",
  icon: "Icon",
  photo: "Photo card",
  counter: "Counter",
  bars: "Comparison bars",
  card: "Spec card",
  steps: "Steps",
  price: "Price chip",
};

/** Dot colors for the slide accent catalog (mirrors slides.ts ACCENT_HEX). */
const SLIDE_ACCENT_HEX: Record<string, string> = {
  yellow: "#FFC918",
  green: "#00A64F",
  red: "#FF3B30",
  blue: "#0A7CFF",
  mono: "#0D0D0F",
};

/** Two-tone gradient swatch per art style — a quick visual signature for
 *  the palette grid (UI-only; the prompt text stays the source of truth). */
const STYLE_SWATCHES: Record<string, [string, string]> = {
  default: ["#6366f1", "#a855f7"],
  photoreal: ["#38bdf8", "#34d399"],
  anime: ["#f472b6", "#60a5fa"],
  watercolor: ["#fbcfe8", "#bfdbfe"],
  comic: ["#ef4444", "#facc15"],
  render3d: ["#22d3ee", "#818cf8"],
  noir: ["#e5e5e5", "#525252"],
  vintage: ["#dcb579", "#8a5a2b"],
  neon: ["#e879f9", "#22d3ee"],
  pastel: ["#fde68a", "#c4b5fd"],
  epic: ["#f59e0b", "#4338ca"],
};
const styleSwatch = (id: string): [string, string] =>
  STYLE_SWATCHES[id] ?? STYLE_SWATCHES.default;

export function SceneEditorDialog({
  videoId,
  scene,
  open,
  onOpenChange,
  onUpdated,
  renderMode = "kenburns",
  slide = null,
  slideBusy = false,
  onRerollSlide,
}: {
  videoId: string;
  scene: SceneDTO | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Called after ANY successful change so the parent refreshes storyboard + video. */
  onUpdated: () => void;
  /** Video render mode — "slides" unlocks the slide design section. */
  renderMode?: string;
  /** This scene's designed slide (null = deck not designed yet). */
  slide?: SlideDTO | null;
  /** True while the slide design re-roll job is in flight. */
  slideBusy?: boolean;
  /** Re-design just this slide (fresh AI take) — parent owns the job + polling. */
  onRerollSlide?: () => void;
}) {
  const [visual, setVisual] = useState("");
  const [mood, setMood] = useState("");
  const [style, setStyle] = useState("default");
  const [narration, setNarration] = useState("");
  const [caption, setCaption] = useState("");
  const [instruction, setInstruction] = useState("");
  // Stage 5 (module C) — the cast's logged look for THIS scene. The director
  // pass proposes it; the human adjusts it here; an approved plan weaves it
  // into the image prompt on the next re-roll.
  const [outfit, setOutfit] = useState("");
  const [accessory, setAccessory] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  // Stage 4a (T-4.6) — in-dialog regeneration: stay open, poll until the
  // repaint lands, then offer a Before/After compare of the image.
  const [repainting, setRepainting] = useState(false);
  const [prevImage, setPrevImage] = useState<string | null>(null);
  const [compare, setCompare] = useState<"after" | "before">("after");
  const lastImageRef = useRef<string | null>(null);

  // Re-seed local state whenever a different scene opens.
  useEffect(() => {
    if (scene) {
      setVisual(scene.visual);
      setMood(scene.mood);
      setStyle(scene.style || "default");
      setNarration(scene.narration);
      setCaption(scene.caption);
      setInstruction("");
      setPendingFile(null);
      setOutfit(scene.appearance?.outfit ?? "");
      setAccessory(scene.appearance?.accessory ?? "");
    }
  }, [scene?.index, scene?.imageUrl, open]);

  // Track image transitions while open — any repaint (re-roll, AI edit,
  // upload) records the previous take for the Before/After compare.
  useEffect(() => {
    if (!open || !scene) return;
    const current = scene.imageUrl;
    if (lastImageRef.current && current && current !== lastImageRef.current) {
      setPrevImage(lastImageRef.current);
      setCompare("after");
    }
    lastImageRef.current = current;
  }, [scene?.imageUrl, open, scene]);

  if (!scene) return null;

  const dirty =
    visual !== scene.visual ||
    mood !== scene.mood ||
    style !== (scene.style || "default") ||
    narration !== scene.narration ||
    caption !== scene.caption;

  /** Stage 5 (module C) — save the cast's look for this scene. Separate from
   *  saveText: it targets the appearance log (PUT /appearance), not the
   *  scene row, and never invalidates anything — the look applies at the
   *  next re-roll under an approved plan. */
  const appearanceDirty =
    scene.hostInScene &&
    (outfit !== (scene.appearance?.outfit ?? "") ||
      accessory !== (scene.appearance?.accessory ?? ""));

  const saveAppearance = async (): Promise<boolean> => {
    if (!appearanceDirty) return true;
    try {
      const res = await fetch(`/api/videos/${videoId}/appearance`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sceneIndex: scene.index, outfit, accessory }),
      });
      const d = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(d.error ?? "Could not save the look");
      toast.success(`Look saved for scene ${scene.index}`, {
        description: "Re-roll the scene to repaint it in this outfit (active under an approved director plan).",
      });
      onUpdated();
      return true;
    } catch (e) {
      fail(e, "Could not save the look");
      return false;
    }
  };

  const fail = (e: unknown, fallback: string) =>
    toast.error(e instanceof Error ? e.message : fallback, {
      description: e instanceof Error ? undefined : fallback,
    });

  /** PATCH the scene text; returns true on success. (Stage 4a, T-4.6:
   *  narration + caption ride the same save; a narration change reports
   *  `invalidated` when it cleared a stale voiceover.) */
  const saveText = async (silent = false): Promise<boolean> => {
    if (!dirty) return true;
    try {
      const body: Record<string, unknown> = { index: scene.index };
      if (visual !== scene.visual) body.visual = visual;
      if (mood !== scene.mood) body.mood = mood;
      if (style !== (scene.style || "default")) body.style = style;
      if (narration !== scene.narration) body.narration = narration;
      if (caption !== scene.caption) body.caption = caption;
      const res = await fetch(`/api/videos/${videoId}/scenes`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = (await res.json()) as { error?: string; invalidated?: boolean; captionsEdited?: boolean };
      if (!res.ok) throw new Error(d.error ?? "Could not save scene changes");
      if (!silent) toast.success(`Scene ${scene.index} updated`);
      if (d.invalidated) {
        toast.warning("Voiceover cleared", {
          description:
            "The narration changed — re-render the voiceover so the audio matches.",
        });
      } else if (d.captionsEdited) {
        // S43 — captions ride the next render; the voice is NEVER touched.
        toast.info("Caption saved", {
          description:
            "It becomes this scene's on-screen subtitle on the next render — the voice is untouched.",
        });
      }
      onUpdated();
      return true;
    } catch (e) {
      fail(e, "Could not save scene changes");
      return false;
    }
  };

  /** Poll until this scene's repaint lands (T-4.6 — the dialog stays open
   *  and the image swaps in place; before/after becomes available). */
  const pollRepaint = async () => {
    setRepainting(true);
    try {
      for (let i = 0; i < 50; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const res = await fetch(`/api/videos/${videoId}/storyboard`, { cache: "no-store" });
        if (!res.ok) continue;
        const d = await res.json();
        const s = (d.scenes ?? []).find((x: { index: number; generating: boolean }) => x.index === scene.index);
        if (s && !s.generating) break;
      }
    } finally {
      setRepainting(false);
      onUpdated();
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
        description: "The image regenerates right here — compare before/after when it lands.",
      });
      onUpdated();
      void pollRepaint();
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
    // S42: persist text edits BEFORE the art rotates — the repaint lands a
    // new version-stamped URL, which re-seeds this dialog from server truth;
    // saving first means that truth already carries the user's keystrokes.
    if (!(await saveText(true))) {
      setBusy(null);
      return;
    }
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
      onUpdated();
      void pollRepaint();
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
    // S42: same contract as re-roll — save text edits first, so the re-seed
    // that follows the new art URL never reverts unsaved keystrokes.
    if (!(await saveText(true))) {
      setBusy(null);
      return;
    }
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
            {renderMode === "slides"
              ? "Shape this scene's slide and its art — re-roll the design, restyle, edit the prompt, or upload your own image."
              : "Shape this scene's art to your taste — style, prompt, AI edits or your own image. Narration is never touched."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {/* Slide design (keynote slides mode) — what viewers actually see */}
          {renderMode === "slides" && (
            <div className="space-y-2 rounded-xl border border-violet-500/20 bg-violet-500/5 p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <Presentation className="h-3.5 w-3.5 text-violet-300 shrink-0" />
                  <Label className="text-xs">Slide design</Label>
                  {slide && (
                    <span className="text-[10px] text-muted-foreground truncate">
                      · {SLIDE_LAYOUT_LABELS[slide.layout] ?? slide.layout}
                    </span>
                  )}
                </div>
                {slide && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={anyBusy || slideBusy || !onRerollSlide}
                    onClick={onRerollSlide}
                    className="h-7 text-[11px] border-white/15 bg-white/4"
                    title="Ask the art director for a fresh take on this one slide — the rest of the deck keeps its design"
                  >
                    {slideBusy ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3 w-3" />
                    )}
                    Re-roll design
                  </Button>
                )}
              </div>
              {slide ? (
                <>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/4 px-1.5 py-0.5 text-[9px] text-muted-foreground">
                      <span
                        aria-hidden
                        className="h-2 w-2 rounded-full"
                        style={{ background: SLIDE_ACCENT_HEX[slide.accent] ?? "#FFC918" }}
                      />
                      {slide.accent}
                    </span>
                    {slide.badge && (
                      <span className="rounded-md border border-white/10 bg-white/4 px-1.5 py-0.5 text-[9px] text-muted-foreground uppercase">
                        badge: {slide.badge}
                      </span>
                    )}
                    {slide.useImage && (
                      <span className="rounded-md border border-white/10 bg-white/4 px-1.5 py-0.5 text-[9px] text-muted-foreground">
                        uses this scene&apos;s art
                      </span>
                    )}
                  </div>
                  <div className="relative rounded-xl overflow-hidden border border-white/10">
                    {slide.hasPng ? (
                      <img
                        src={slide.pngUrl ?? ""}
                        alt={`Slide ${slide.index}: ${slide.headline}`}
                        className="w-full aspect-video object-cover object-top"
                      />
                    ) : (
                      <div className="w-full aspect-video bg-white/4 flex flex-col items-center justify-center gap-2">
                        {slideBusy ? (
                          <Loader2 className="h-5 w-5 animate-spin text-primary" />
                        ) : (
                          <Presentation className="h-5 w-5 text-muted-foreground" />
                        )}
                        <span className="text-[10px] text-muted-foreground">
                          Preview appears after the next render
                        </span>
                      </div>
                    )}
                  </div>
                  <p className="text-[10px] text-muted-foreground/80">
                    Headline: “{slide.headline}” — re-rolling keeps the narration, changes only this slide&apos;s design.
                  </p>
                </>
              ) : (
                <p className="text-[10px] text-muted-foreground">
                  The deck is designed when the video renders (or on your first
                  re-roll) — one designed slide per scene, timed to the narration.
                </p>
              )}
            </div>
          )}

          {/* Current art — with in-dialog repaint progress + Before/After (T-4.6) */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              {renderMode === "slides" && (
                <Label className="text-xs text-muted-foreground">
                  Scene art{slide?.useImage ? " — used by this slide's photo card" : " — feeds the storyboard"}
                </Label>
              )}
              {prevImage && (
                <div className="flex rounded-lg border border-white/10 bg-white/4 p-0.5 ml-auto" role="group" aria-label="Compare takes">
                  {(["before", "after"] as const).map((side) => (
                    <button
                      key={side}
                      type="button"
                      onClick={() => setCompare(side)}
                      aria-pressed={compare === side}
                      className={`tf-focusable h-6 px-2 rounded-md text-[10px] font-medium capitalize transition-colors ${
                        compare === side ? "bg-white/10 text-foreground" : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {side}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="relative rounded-xl overflow-hidden border border-white/10">
            {(compare === "before" && prevImage) || (compare === "after" && scene.hasImage) ? (
              <img
                src={(compare === "before" ? prevImage : scene.imageUrl) ?? ""}
                alt={`Scene ${scene.index}: ${scene.title}${compare === "before" ? " (previous take)" : ""}`}
                className="w-full aspect-video object-cover"
              />
            ) : (
              <div className="w-full aspect-video bg-white/4 flex items-center justify-center text-[11px] text-muted-foreground">
                No art yet — set the look below and regenerate
              </div>
            )}
            {repainting && (
              <div className="absolute inset-0 bg-black/55 backdrop-blur-[2px] flex flex-col items-center justify-center gap-2">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
                <p className="text-xs text-white/85">Repainting scene {scene.index}…</p>
                <p className="text-[10px] text-white/55">The new take appears here — compare it with the old one after.</p>
              </div>
            )}
            {scene.hasStock && !repainting && (
              <span className="absolute bottom-2 right-2 rounded-md bg-black/70 px-1.5 py-0.5 text-[9px] text-white">
                stock clip plays in this scene
              </span>
            )}
            </div>
          </div>

          {/* Art style palette */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Art style</Label>
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-1.5">
              {SCENE_ART_STYLES.map((s) => {
                const [c1, c2] = styleSwatch(s.id);
                return (
                  <button
                    key={s.id}
                    type="button"
                    disabled={anyBusy}
                    onClick={() => setStyle(s.id)}
                    aria-pressed={style === s.id}
                    className={clsx(
                      "flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-[11px] transition-all",
                      style === s.id
                        ? "border-primary/50 bg-primary/8 text-foreground"
                        : "border-white/10 bg-white/3 hover:border-white/25 text-muted-foreground"
                    )}
                  >
                    <span
                      aria-hidden
                      className="h-3.5 w-3.5 shrink-0 rounded-[4px] ring-1 ring-white/15"
                      style={{
                        background: `linear-gradient(135deg, ${c1} 0%, ${c2} 100%)`,
                      }}
                    />
                    <span className="truncate">{s.label}</span>
                  </button>
                );
              })}
            </div>
            <p className="text-[10px] text-muted-foreground/80">
              {SCENE_ART_STYLES.find((s) => s.id === style)?.prompt ||
                "The standard TubeForge cinematic look"}
            </p>
          </div>

          {/* Narration & caption (T-4.6) — the scene's spoken text. A
              narration change clears the stale voiceover (same contract as the
              Script tab); captions re-render with the next render. */}
          <div className="space-y-2.5 rounded-xl border border-white/10 bg-white/3 p-3">
            <p className="tf-kicker">Narration &amp; caption</p>
            <div className="space-y-1.5">
              <Label htmlFor={`narration-${scene.index}`} className="text-xs text-muted-foreground">
                Narration — what the voice reads in this scene
              </Label>
              <Textarea
                id={`narration-${scene.index}`}
                value={narration}
                onChange={(e) => setNarration(e.target.value)}
                rows={3}
                maxLength={3000}
                disabled={anyBusy}
                className="text-xs"
              />
              {narration !== scene.narration && (
                <p className="text-[10px] text-amber-300/90 leading-snug">
                  Saving this clears the stale voiceover — re-render it from the Package tab.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`caption-${scene.index}`} className="text-xs text-muted-foreground">
                Caption — this scene&apos;s on-screen subtitle (next render)
              </Label>
              <Input
                id={`caption-${scene.index}`}
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                maxLength={60}
                disabled={anyBusy}
                className="h-8 text-xs"
              />
              <p className="text-[10px] text-muted-foreground/80 leading-snug">
                One line shown across this scene — the voice never reads it. Empty
                falls back to the word-synced narration captions.
              </p>
            </div>
          </div>

          {/* Cast look (Stage 5, module C) — host scenes only. The director
              pass proposes the outfit; the human approves by keeping it or
              adjusts it here; an approved plan weaves it into this scene's
              image prompt so the cast dresses consistently across scenes. */}
          {scene.hostInScene && (
            <div className="space-y-2.5 rounded-xl border border-white/10 bg-white/3 p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="tf-kicker">Cast look in this scene</p>
                {appearanceDirty && (
                  <Button
                    size="sm"
                    className="h-7 px-2.5 text-[11px]"
                    disabled={anyBusy}
                    onClick={() => void saveAppearance()}
                  >
                    Save look
                  </Button>
                )}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                <div className="space-y-1">
                  <Label htmlFor={`outfit-${scene.index}`} className="text-[10px] text-muted-foreground">
                    Outfit
                  </Label>
                  <Input
                    id={`outfit-${scene.index}`}
                    value={outfit}
                    onChange={(e) => setOutfit(e.target.value)}
                    maxLength={160}
                    disabled={anyBusy}
                    className="h-8 text-xs"
                    placeholder="e.g. charcoal blazer, white tee"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`accessory-${scene.index}`} className="text-[10px] text-muted-foreground">
                    Accessory
                  </Label>
                  <Input
                    id={`accessory-${scene.index}`}
                    value={accessory}
                    onChange={(e) => setAccessory(e.target.value)}
                    maxLength={160}
                    disabled={anyBusy}
                    className="h-8 text-xs"
                    placeholder="e.g. round glasses, silver watch"
                  />
                </div>
              </div>
              <p className="text-[10px] text-muted-foreground leading-snug">
                Applies at the next re-roll, under an approved director plan. Clear both to stop
                directing the outfit.
              </p>
            </div>
          )}

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
              PNG / JPEG / WebP / HEIC (iPhone photos) up to 15 MB. It&apos;s
              center-cropped to the video canvas (16:9) automatically.
              Replacing art removes existing renders — render again afterwards.
            </p>
            <div className="flex items-center gap-2">
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/heic,image/heif"
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
