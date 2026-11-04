"use client";

// The World library (Stage 5 module C) — recurring LOCATIONS and PROPS the
// AI Director weaves into scene image prompts for set continuity. Since S22
// this is the module's front door: the routes existed, the director read
// them, and nothing on the surface could create, pause or remove an entry.

import { useCallback, useEffect, useState } from "react";
import { useAppStore } from "@/lib/store";
import { useToast } from "@/hooks/use-toast";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { EmptyState } from "@/components/tubeforge/shared";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  MapPin,
  Package,
  Globe,
  Loader2,
  Trash2,
  CheckCircle2,
  Plus,
} from "lucide-react";

interface WorldItem {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  createdAt: string;
}

type WorldKind = "location" | "prop";

const KIND_META: Record<
  WorldKind,
  { label: string; plural: string; icon: typeof MapPin; listKey: "locations" | "props"; itemKey: "location" | "prop"; hint: string }
> = {
  location: {
    label: "Location",
    plural: "Locations",
    icon: MapPin,
    listKey: "locations",
    itemKey: "location",
    hint: "Places the stories return to — the corner office, the midnight diner, the rain-slick rooftop.",
  },
  prop: {
    label: "Prop",
    plural: "Props",
    icon: Package,
    listKey: "props",
    itemKey: "prop",
    hint: "Recurring objects — the worn leather notebook, the red umbrella, the cracked watch.",
  },
};

function WorldSection({
  kind,
  items,
  busyId,
  onCreate,
  onToggle,
  onDelete,
}: {
  kind: WorldKind;
  items: WorldItem[];
  busyId: string | null;
  onCreate: (kind: WorldKind) => void;
  onToggle: (kind: WorldKind, item: WorldItem) => void;
  onDelete: (kind: WorldKind, item: WorldItem) => void;
}) {
  const meta = KIND_META[kind];
  return (
    <section aria-label={meta.plural} className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold tracking-wide text-muted-foreground flex items-center gap-2">
          <meta.icon className="h-4 w-4 text-primary" />
          {meta.plural}
          <span className="text-[11px] font-normal">{items.length}</span>
        </h2>
        <Button
          size="sm"
          variant="outline"
          className="h-8 text-xs border-primary/25 bg-primary/10 text-red-300 hover:bg-primary/15"
          onClick={() => onCreate(kind)}
        >
          <Plus className="h-3.5 w-3.5" />
          Add {meta.label.toLowerCase()}
        </Button>
      </div>

      {items.length === 0 ? (
        <div className="glass rounded-2xl px-5 py-6 text-xs text-muted-foreground leading-relaxed">
          Nothing here yet. {meta.hint}
        </div>
      ) : (
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
          {items.map((it) => (
            <Card key={it.id} className="glass rounded-2xl p-5 flex flex-col">
              <div className="flex items-start justify-between gap-3">
                <div className="h-11 w-11 rounded-xl bg-brand-gradient/90 flex items-center justify-center shrink-0 glow-red-soft">
                  <meta.icon className="h-5 w-5 text-white" />
                </div>
                <Switch
                  checked={it.isActive}
                  disabled={busyId === it.id}
                  onCheckedChange={() => onToggle(kind, it)}
                  aria-label={`Toggle ${it.name} active state`}
                />
              </div>
              <p className="font-semibold mt-3.5 leading-snug">{it.name}</p>
              {it.description && (
                <p className="text-xs text-muted-foreground mt-2 leading-relaxed line-clamp-3">
                  {it.description}
                </p>
              )}
              <div className="mt-auto pt-3.5 border-t border-white/6 flex items-center justify-between">
                <span
                  className={`text-[11px] inline-flex items-center gap-1 ${
                    it.isActive ? "text-emerald-300" : "text-muted-foreground"
                  }`}
                >
                  <CheckCircle2 className="h-3 w-3" />
                  {it.isActive ? "Active" : "Paused"}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-red-300 hover:bg-red-500/10"
                  disabled={busyId === it.id}
                  onClick={() => onDelete(kind, it)}
                  aria-label={`Delete ${it.name}`}
                >
                  {busyId === it.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}

export function WorldView() {
  const { toast } = useToast();
  const refreshKey = useAppStore((s) => s.refreshKey);

  const [locations, setLocations] = useState<WorldItem[]>([]);
  const [props, setProps] = useState<WorldItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogKind, setDialogKind] = useState<WorldKind>("location");
  const [form, setForm] = useState({ name: "", description: "" });
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    Promise.all([
      fetch("/api/locations").then((r) => r.json()),
      fetch("/api/props").then((r) => r.json()),
    ])
      .then(([l, p]) => {
        setLocations(l.locations ?? []);
        setProps(p.props ?? []);
      })
      .catch(() => {
        setLocations([]);
        setProps([]);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const openCreate = (kind: WorldKind) => {
    setDialogKind(kind);
    setForm({ name: "", description: "" });
    setDialogOpen(true);
  };

  const create = async () => {
    const meta = KIND_META[dialogKind];
    if (!form.name.trim()) {
      toast({ title: `${meta.label} name is required`, variant: "destructive" });
      return;
    }
    setCreating(true);
    try {
      const res = await fetch(`/api/${dialogKind}s`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          description: form.description.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        toast({ title: d.error ?? "Could not create the entry", variant: "destructive" });
        return;
      }
      toast({ title: `${meta.label} added to the world` });
      setDialogOpen(false);
      load();
    } finally {
      setCreating(false);
    }
  };

  const toggleActive = async (kind: WorldKind, item: WorldItem) => {
    const meta = KIND_META[kind];
    setBusyId(item.id);
    try {
      const res = await fetch(`/api/${kind}s/${item.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isActive: !item.isActive }),
      });
      if (!res.ok) {
        toast({ title: `Could not update ${item.name}`, variant: "destructive" });
        return;
      }
      // Paused entries stay listed but drop out of the director's reads —
      // the GET filters on isActive.
      load();
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (kind: WorldKind, item: WorldItem) => {
    setBusyId(item.id);
    try {
      const res = await fetch(`/api/${kind}s/${item.id}`, { method: "DELETE" });
      if (!res.ok) {
        toast({ title: `Could not delete ${item.name}`, variant: "destructive" });
        return;
      }
      toast({ title: `${item.name} removed from the world` });
      load();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2.5">
            <Globe className="h-6 w-6 text-primary" />
            World
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl leading-relaxed">
            The recurring places and things your stories share. The AI Director
            sees these while planning scenes and weaves them into the art for
            set continuity.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-36 rounded-2xl" />
          ))}
        </div>
      ) : (
        <div className="space-y-8">
          <WorldSection
            kind="location"
            items={locations}
            busyId={busyId}
            onCreate={openCreate}
            onToggle={toggleActive}
            onDelete={remove}
          />
          <WorldSection
            kind="prop"
            items={props}
            busyId={busyId}
            onCreate={openCreate}
            onToggle={toggleActive}
            onDelete={remove}
          />
        </div>
      )}

      {/* Create dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md bg-card border-white/10">
          <DialogHeader>
            <DialogTitle>New {KIND_META[dialogKind].label.toLowerCase()}</DialogTitle>
            <DialogDescription>
              {KIND_META[dialogKind].hint} The director references it by name.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-1">
            <div className="space-y-1.5">
              <Label htmlFor="world-name">Name</Label>
              <Input
                id="world-name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder={
                  dialogKind === "location"
                    ? "e.g. The midnight diner"
                    : "e.g. The worn leather notebook"
                }
                maxLength={80}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="world-desc">Description (optional)</Label>
              <Textarea
                id="world-desc"
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="What it looks like, the mood it carries — this lands in the scene prompts."
                rows={3}
                maxLength={600}
              />
              <p className="text-[11px] text-muted-foreground">
                {form.description.trim().length}/600
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={create}
              disabled={creating || !form.name.trim()}
              className="bg-brand-gradient hover:opacity-90 font-medium"
            >
              {creating && <Loader2 className="h-4 w-4 animate-spin" />}
              Add to the world
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
