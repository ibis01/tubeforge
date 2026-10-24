"use client";

import { useState } from "react";
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
import { VOICES, LENGTHS, type VideoDTO } from "@/lib/tubeforge/types";
import {
  Mic,
  ImageIcon,
  Rocket,
  Loader2,
  Trash2,
  FileText,
  Tag,
} from "lucide-react";

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
  const [busy, setBusy] = useState<string | null>(null);

  if (!video) return null;

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
        const res = await fetch(`/api/videos/${video.id}/${stage}`, { method: "POST" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `${stage} failed`);
        onChanged(data.video);
        toast({
          title: stage === "voiceover" ? "Voiceover regenerated" : "Thumbnail regenerated",
          description: stage === "voiceover" ? `${formatDuration(data.video.audioDuration)} of audio.` : "New artwork is ready.",
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
