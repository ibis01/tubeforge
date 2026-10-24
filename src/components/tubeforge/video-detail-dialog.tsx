"use client";

import { useEffect, useState } from "react";
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
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { StatusBadge, formatDuration, timeAgo } from "@/components/tubeforge/shared";
import { pollVoiceover, pollThumbnail, pollVariants } from "@/lib/tubeforge/poll";
import {
  VOICES,
  LENGTHS,
  type VideoDTO,
  type VariantDTO,
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
} from "lucide-react";
import { clsx } from "clsx";

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

  // Load A/B variants whenever the open video changes
  useEffect(() => {
    if (!video?.id) {
      setVariants([]);
      return;
    }
    let cancelled = false;
    fetch(`/api/videos/${video.id}/variants`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d?.variants) setVariants(d.variants);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [video?.id]);

  if (!video) return null;

  const generateVariants = async () => {
    if (busy) return;
    setBusy("variants");
    try {
      // POST returns 202 + starts a server background job; poll the variants
      // list until the job reports done (avoids gateway 502 on long requests).
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
      // Force <img> re-render with a fresh URL
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
        // POST returns 202 + starts a server background job; poll until the
        // artifact exists (keeps the request short so gateways never 502).
        await fetch(`/api/videos/${video.id}/${stage}`, { method: "POST" });
        const done =
          stage === "voiceover"
            ? await pollVoiceover(video.id)
            : await pollThumbnail(video.id);
        onChanged(done);
        toast({
          title: stage === "voiceover" ? "Voiceover regenerated" : "Thumbnail regenerated",
          description: stage === "voiceover" ? `${formatDuration(done.audioDuration)} of audio.` : "New artwork is ready.",
        });
      }
      bumpRefresh();
    } catch (e) {
      toast({
        title: "Stage failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
      // Re-sync in case server updated status to failed
      const res = await fetch(`/api/videos/${video.id}`);
      if (res.ok) {
        const data = await res.json();
        if (data.video) onChanged(data.video);
      }
    } finally {
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
              <span className="text-xs text-muted-foreground">{timeAgo(video.createdAt)}</span>
            </div>
            <DialogTitle className="text-lg leading-snug">
              {video.title ?? video.topic}
            </DialogTitle>
            <DialogDescription>
              {video.wordCount ?? 0} words ·{" "}
              {LENGTHS.find((l) => l.id === video.length)?.label ?? video.length} ·{" "}
              {VOICES.find((v) => v.id === video.voice)?.label ?? video.voice}
              {video.channelName ? ` · ${video.channelName}` : ""}
            </DialogDescription>
          </DialogHeader>

          {video.error && (
            <p className="mt-3 text-xs text-red-300 bg-red-500/8 border border-red-500/20 rounded-lg px-3 py-2">
              {video.error}
            </p>
          )}

          {/* Audio */}
          <div className="mt-5">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium mb-2">
              Voiceover {video.hasVoiceover ? `· ${formatDuration(video.audioDuration)}` : "· not generated"}
            </p>
            {video.hasVoiceover ? (
               
              <audio controls preload="metadata" src={`/api/videos/${video.id}/voiceover`} className="w-full" />
            ) : (
              <p className="text-sm text-muted-foreground">No narration yet.</p>
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

          {/* Script */}
          <div>
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium mb-2 flex items-center gap-1.5">
              <FileText className="h-3 w-3" /> Script
            </p>
            <div className="max-h-56 overflow-y-auto scroll-area-bar pr-3 text-sm leading-relaxed whitespace-pre-wrap text-foreground/85">
              {video.script ?? "No script yet."}
            </div>
          </div>

          <DialogFooter className="mt-6 flex-row flex-wrap gap-2 sm:justify-between">
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={Boolean(busy) || !video.script}
                onClick={() => runStage("voiceover")}
                className="border-white/15 bg-white/4"
              >
                {busy === "voiceover" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Mic className="h-3.5 w-3.5" />
                )}
                {video.hasVoiceover ? "Re-render voice" : "Generate voice"}
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
                    ? "Download script, metadata, voiceover and thumbnails as a ZIP"
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
        </div>
      </DialogContent>
    </Dialog>
  );
}
