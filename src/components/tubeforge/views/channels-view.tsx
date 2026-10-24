"use client";

import { useCallback, useEffect, useState } from "react";
import { useAppStore } from "@/lib/store";
import { useToast } from "@/hooks/use-toast";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/tubeforge/shared";
import { NICHES, type ChannelDTO } from "@/lib/tubeforge/types";
import { Plus, Radio, Film, Loader2, Trash2, CheckCircle2 } from "lucide-react";

export function ChannelsView() {
  const { toast } = useToast();
  const bumpRefresh = useAppStore((s) => s.bumpRefresh);
  const refreshKey = useAppStore((s) => s.refreshKey);

  const [channels, setChannels] = useState<ChannelDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: "", niche: "Motivation", description: "" });

  const load = useCallback(() => {
    setLoading(true);
    fetch("/api/channels")
      .then((r) => r.json())
      .then((d) => setChannels(d.channels ?? []))
      .catch(() => setChannels([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const handleCreate = async () => {
    if (!form.name.trim() || saving) return;
    setSaving(true);
    try {
      const res = await fetch("/api/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to create channel");
      toast({ title: "Channel created", description: `${data.channel.name} joined the lineup.` });
      setDialogOpen(false);
      setForm({ name: "", niche: "Motivation", description: "" });
      load();
      bumpRefresh();
    } catch (e) {
      toast({
        title: "Could not create channel",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (c: ChannelDTO) => {
    const res = await fetch(`/api/channels/${c.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !c.isActive }),
    });
    if (res.ok) load();
  };

  const handleDelete = async (id: string) => {
    const res = await fetch(`/api/channels/${id}`, { method: "DELETE" });
    if (res.ok) {
      toast({ title: "Channel removed", description: "Its videos stay in the library, unassigned." });
      load();
      bumpRefresh();
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Run one channel or a whole faceless empire — each keeps its own niche.
        </p>
        <Button
          onClick={() => setDialogOpen(true)}
          className="bg-brand-gradient hover:opacity-90 font-semibold shrink-0"
        >
          <Plus className="h-4 w-4" />
          Add Channel
        </Button>
      </div>

      {loading ? (
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-44 rounded-2xl bg-white/5" />
          ))}
        </div>
      ) : channels.length === 0 ? (
        <EmptyState
          icon={Radio}
          title="No channels yet"
          hint="Create your first faceless channel — videos can then be assigned to it in the Create studio."
          action={
            <Button
              onClick={() => setDialogOpen(true)}
              className="bg-brand-gradient hover:opacity-90 font-medium"
            >
              <Plus className="h-4 w-4" />
              Add your first channel
            </Button>
          }
        />
      ) : (
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
          {channels.map((c) => (
            <Card key={c.id} className="glass rounded-2xl p-5 flex flex-col">
              <div className="flex items-start justify-between gap-3">
                <div className="h-11 w-11 rounded-xl bg-brand-gradient/90 flex items-center justify-center shrink-0 glow-red-soft">
                  <Radio className="h-5 w-5 text-white" />
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={c.isActive}
                    onCheckedChange={() => toggleActive(c)}
                    aria-label={`Toggle ${c.name} active state`}
                  />
                </div>
              </div>
              <p className="font-semibold mt-3.5 leading-snug">{c.name}</p>
              <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                <Badge variant="outline" className="border-primary/25 bg-primary/10 text-red-300 text-[11px]">
                  {c.niche}
                </Badge>
                <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                  <Film className="h-3 w-3" />
                  {c.videoCount ?? 0} video{(c.videoCount ?? 0) === 1 ? "" : "s"}
                </span>
              </div>
              {c.description && (
                <p className="text-xs text-muted-foreground mt-2.5 leading-relaxed line-clamp-3">
                  {c.description}
                </p>
              )}
              <div className="mt-4 pt-3.5 border-t border-white/6 flex items-center justify-between">
                <span
                  className={`text-[11px] inline-flex items-center gap-1 ${
                    c.isActive ? "text-emerald-300" : "text-muted-foreground"
                  }`}
                >
                  <CheckCircle2 className="h-3 w-3" />
                  {c.isActive ? "Active" : "Paused"}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-red-300 hover:bg-red-500/10"
                  onClick={() => handleDelete(c.id)}
                  aria-label={`Delete ${c.name}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Create dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md bg-card border-white/10">
          <DialogHeader>
            <DialogTitle>New faceless channel</DialogTitle>
            <DialogDescription>
              Give it a name and niche — assign videos to it from the Create studio.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-1">
            <div className="space-y-1.5">
              <Label htmlFor="channel-name">Channel name</Label>
              <Input
                id="channel-name"
                placeholder="e.g. MindFuel Daily"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                maxLength={80}
                className="bg-white/5"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Niche</Label>
              <Select
                value={form.niche}
                onValueChange={(v) => setForm((f) => ({ ...f, niche: v }))}
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
              <Label htmlFor="channel-desc">Description (optional)</Label>
              <Textarea
                id="channel-desc"
                placeholder="Daily motivation and mindset fuel for future millionaires."
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                rows={3}
                maxLength={500}
                className="bg-white/5 resize-none"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} className="border-white/15 bg-white/4">
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={!form.name.trim() || saving}
              className="bg-brand-gradient hover:opacity-90 font-medium"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              Create Channel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
