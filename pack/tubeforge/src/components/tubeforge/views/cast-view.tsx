"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "@/lib/store";
import { useToast } from "@/hooks/use-toast";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
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
import { EmptyState, useVoices, VoiceSelectWithPreview } from "@/components/tubeforge/shared";
import {
  VOICES,
  ART_STYLES,
  POSES,
  type CharacterDTO,
} from "@/lib/tubeforge/types";
import { pollPortrait, pollPoses } from "@/lib/tubeforge/poll";
import {
  Plus,
  Users,
  Loader2,
  Trash2,
  Sparkles,
  ImageIcon,
  RefreshCw,
  Film,
  Mic,
  Palette,
  ShieldCheck,
  UserRound,
  Wand2,
} from "lucide-react";
import { clsx } from "clsx";

const artStyleLabel = (id: string) =>
  ART_STYLES.find((s) => s.id === id)?.label ?? id;
const voiceLabel = (id: string) =>
  VOICES.find((v) => v.id === id)?.label ?? id;

/** Cache-busting image URL — re-rolls must not show a stale browser-cached PNG. */
const mediaUrl = (c: CharacterDTO, path: string) =>
  `${path}?v=${new Date(c.updatedAt).getTime()}`;

interface CharacterForm {
  name: string;
  concept: string;
  role: string;
  personality: string;
  appearance: string;
  voice: string;
  artStyle: string;
}

const EMPTY_FORM: CharacterForm = {
  name: "",
  concept: "",
  role: "",
  personality: "",
  appearance: "",
  voice: "jam",
  artStyle: "cinematic",
};

export function CastView() {
  const { toast } = useToast();
  const bumpRefresh = useAppStore((s) => s.bumpRefresh);
  const refreshKey = useAppStore((s) => s.refreshKey);

  const [characters, setCharacters] = useState<CharacterDTO[]>([]);
  const [loading, setLoading] = useState(true);

  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<CharacterForm>(EMPTY_FORM);
  const { voices } = useVoices();
  const [creating, setCreating] = useState(false);
  const [bibleRunning, setBibleRunning] = useState(false);

  const [studioId, setStudioId] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/characters")
      .then((r) => r.json())
      .then((d) => setCharacters(d.characters ?? []))
      .catch(() => setCharacters([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const studioCharacter = useMemo(
    () => characters.find((c) => c.id === studioId) ?? null,
    [characters, studioId]
  );

  const runAiBible = async () => {
    if (!form.name.trim()) {
      toast({
        title: "Name needed first",
        description: "Give your character a name, then let GLM design the rest.",
        variant: "destructive",
      });
      return;
    }
    setBibleRunning(true);
    try {
      const res = await fetch("/api/characters/bible", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: form.name, concept: form.concept }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "AI design failed");
      const bible = data.bible as Record<string, string>;
      setForm((f) => ({
        ...f,
        role: bible.role || f.role,
        personality: bible.personality || f.personality,
        appearance: bible.appearance || f.appearance,
        voice: bible.voice || f.voice,
        artStyle: bible.artStyle || f.artStyle,
      }));
      toast({
        title: "Character bible ready",
        description: "GLM designed the persona — tweak anything before saving.",
      });
    } catch (e) {
      toast({
        title: "AI design failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setBibleRunning(false);
    }
  };

  const handleCreate = async () => {
    if (!form.name.trim() || creating) return;
    setCreating(true);
    try {
      const res = await fetch("/api/characters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          role: form.role || null,
          personality: form.personality || null,
          appearance: form.appearance || null,
          voice: form.voice,
          artStyle: form.artStyle,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to create character");
      toast({
        title: "Character created",
        description: `${data.character.name} joined the cast. Generate a portrait next.`,
      });
      setCreateOpen(false);
      setForm(EMPTY_FORM);
      load();
      bumpRefresh();
    } catch (e) {
      toast({
        title: "Could not create character",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Recurring hosts with a locked visual identity — GLM designs the persona,
          CogView paints the reference, image-editing keeps every scene on-model.
        </p>
        <Button
          onClick={() => {
            setForm(EMPTY_FORM);
            setCreateOpen(true);
          }}
          className="bg-brand-gradient hover:opacity-90 font-semibold shrink-0"
        >
          <Plus className="h-4 w-4" />
          New Character
        </Button>
      </div>

      {loading ? (
        <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-64 rounded-2xl bg-white/5" />
          ))}
        </div>
      ) : characters.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No characters yet"
          hint="Create a recurring host — videos assigned to them keep the same face, outfit and voice everywhere."
          action={
            <Button
              onClick={() => {
                setForm(EMPTY_FORM);
                setCreateOpen(true);
              }}
              className="bg-brand-gradient hover:opacity-90 font-medium"
            >
              <Plus className="h-4 w-4" />
              Create your first character
            </Button>
          }
        />
      ) : (
        <div className="grid sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {characters.map((c) => (
            <CharacterCard key={c.id} character={c} onOpen={() => setStudioId(c.id)} />
          ))}
        </div>
      )}

      {/* Create / design dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-lg bg-card border-white/10">
          <DialogHeader>
            <DialogTitle>New cast character</DialogTitle>
            <DialogDescription>
              Name your host, add an optional concept, then let GLM write the full
              character bible — or fill everything by hand.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-1 max-h-[60vh] overflow-y-auto pr-1 scroll-area-bar">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="char-name">Name</Label>
                <Input
                  id="char-name"
                  placeholder="e.g. Professor Vex"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  maxLength={60}
                  className="bg-white/5"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="char-concept">Concept (optional)</Label>
                <Input
                  id="char-concept"
                  placeholder="grumpy genius who loves history"
                  value={form.concept}
                  onChange={(e) => setForm((f) => ({ ...f, concept: e.target.value }))}
                  maxLength={200}
                  className="bg-white/5"
                />
              </div>
            </div>

            <Button
              type="button"
              variant="outline"
              onClick={runAiBible}
              disabled={bibleRunning || !form.name.trim()}
              className="w-full border-primary/30 bg-primary/10 hover:bg-primary/15 text-red-200"
            >
              {bibleRunning ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="h-4 w-4" />
              )}
              {bibleRunning ? "GLM is designing…" : "Auto-fill with AI bible"}
            </Button>

            <div className="space-y-1.5">
              <Label htmlFor="char-role">Role</Label>
              <Input
                id="char-role"
                placeholder="Host — skeptical science storyteller"
                value={form.role}
                onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
                maxLength={200}
                className="bg-white/5"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="char-personality">Personality</Label>
              <Textarea
                id="char-personality"
                placeholder="How they speak, energy, catchphrases, how they open videos…"
                value={form.personality}
                onChange={(e) => setForm((f) => ({ ...f, personality: e.target.value }))}
                rows={3}
                maxLength={2000}
                className="bg-white/5 resize-none"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="char-appearance">Appearance</Label>
              <Textarea
                id="char-appearance"
                placeholder="Fixed visual identity: age, hair, glasses, signature outfit colors…"
                value={form.appearance}
                onChange={(e) => setForm((f) => ({ ...f, appearance: e.target.value }))}
                rows={3}
                maxLength={2000}
                className="bg-white/5 resize-none"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Voice</Label>
                <VoiceSelectWithPreview
                  value={form.voice}
                  onValueChange={(v) => setForm((f) => ({ ...f, voice: v }))}
                  voices={voices}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Art style</Label>
                <Select
                  value={form.artStyle}
                  onValueChange={(v) => setForm((f) => ({ ...f, artStyle: v }))}
                >
                  <SelectTrigger className="bg-white/5">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ART_STYLES.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreateOpen(false)}
              className="border-white/15 bg-white/4"
            >
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={!form.name.trim() || creating}
              className="bg-brand-gradient hover:opacity-90 font-medium"
            >
              {creating && <Loader2 className="h-4 w-4 animate-spin" />}
              Create Character
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Character studio (detail) dialog */}
      {studioCharacter && (
        <CharacterStudio
          character={studioCharacter}
          onChanged={(c) =>
            setCharacters((list) => list.map((x) => (x.id === c.id ? c : x)))
          }
          onDeleted={() => {
            setStudioId(null);
            load();
            bumpRefresh();
          }}
          onClose={() => setStudioId(null)}
          toast={toast}
        />
      )}
    </div>
  );
}

function CharacterCard({ character: c, onOpen }: { character: CharacterDTO; onOpen: () => void }) {
  const busy = c.generating.portrait || c.generating.poses;
  return (
    <Card
      className="glass rounded-2xl p-4 flex flex-col cursor-pointer hover:border-white/20 transition-colors group"
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === "Enter" && onOpen()}
      aria-label={`Open ${c.name} in character studio`}
    >
      <div className="relative aspect-square rounded-xl overflow-hidden bg-white/5 mb-3">
        {c.hasPortrait ? (
          <img
            src={mediaUrl(c, `/api/characters/${c.id}/portrait`)}
            alt={`${c.name} reference portrait`}
            className="h-full w-full object-cover group-hover:scale-[1.03] transition-transform duration-300"
          />
        ) : (
          <div className="h-full w-full flex flex-col items-center justify-center text-muted-foreground gap-2">
            {busy ? (
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            ) : (
              <UserRound className="h-10 w-10" />
            )}
            <span className="text-[11px]">
              {busy ? "Painting portrait…" : "No portrait yet"}
            </span>
          </div>
        )}
        {busy && c.hasPortrait && (
          <div className="absolute inset-0 bg-background/60 backdrop-blur-[2px] flex items-center justify-center">
            <Loader2 className="h-7 w-7 animate-spin text-primary" />
          </div>
        )}
      </div>

      <p className="font-semibold leading-snug truncate">{c.name}</p>
      {c.role && (
        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{c.role}</p>
      )}
      <div className="flex items-center gap-1.5 mt-2 flex-wrap min-h-6">
        <Badge variant="outline" className="border-primary/25 bg-primary/10 text-red-300 text-[10px]">
          <Palette className="h-2.5 w-2.5 mr-1" />
          {artStyleLabel(c.artStyle)}
        </Badge>
        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
          <Film className="h-3 w-3" />
          {c.videoCount}
        </span>
        {c.poseCount > 0 && (
          <span className="inline-flex items-center gap-1 text-[11px] text-emerald-300">
            <ShieldCheck className="h-3 w-3" />
            {c.poseCount} poses
          </span>
        )}
      </div>
    </Card>
  );
}

function CharacterStudio({
  character: initial,
  onChanged,
  onDeleted,
  onClose,
  toast,
}: {
  character: CharacterDTO;
  onChanged: (c: CharacterDTO) => void;
  onDeleted: () => void;
  onClose: () => void;
  toast: ReturnType<typeof useToast>["toast"];
}) {
  const [c, setC] = useState<CharacterDTO>(initial);
  const { voices } = useVoices();
  const [form, setForm] = useState({
    name: initial.name,
    role: initial.role ?? "",
    personality: initial.personality ?? "",
    appearance: initial.appearance ?? "",
    identityAnchor: initial.identityAnchor ?? "",
    voice: initial.voice,
    artStyle: initial.artStyle,
  });
  const [saving, setSaving] = useState(false);
  const [portraitBusy, setPortraitBusy] = useState(initial.generating.portrait);
  const [posesBusy, setPosesBusy] = useState(initial.generating.poses);
  const pollRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setC(initial);
  }, [initial]);

  const applyUpdate = (next: CharacterDTO) => {
    setC(next);
    onChanged(next);
  };

  const generatePortrait = async () => {
    if (portraitBusy) return;
    setPortraitBusy(true);
    try {
      const res = await fetch(`/api/characters/${c.id}/portrait`, { method: "POST" });
      if (res.status === 409) {
        // already running elsewhere — just poll
      } else {
        const data = await res.json();
        if (!res.ok && res.status !== 202)
          throw new Error(data.error ?? "Portrait job failed to start");
      }
      pollRef.current?.abort();
      const controller = new AbortController();
      pollRef.current = controller;
      const final = await pollPortrait(c.id);
      if (!controller.signal.aborted) {
        applyUpdate(final);
        toast({
          title: "Reference portrait ready",
          description: `${final.name} now has a canonical look. Generate the consistency sheet next.`,
        });
      }
    } catch (e) {
      toast({
        title: "Portrait generation failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setPortraitBusy(false);
    }
  };

  const generatePoses = async () => {
    if (posesBusy) return;
    if (!c.hasPortrait) {
      toast({
        title: "Portrait required",
        description: "Poses are derived from the reference portrait — generate it first.",
        variant: "destructive",
      });
      return;
    }
    setPosesBusy(true);
    try {
      const res = await fetch(`/api/characters/${c.id}/poses`, { method: "POST" });
      if (res.status !== 409) {
        const data = await res.json();
        if (!res.ok && res.status !== 202)
          throw new Error(data.error ?? "Pose job failed to start");
      }
      const final = await pollPoses(c.id);
      applyUpdate(final);
      toast({
        title: "Consistency sheet complete",
        description: "Three identity-locked poses — the storyboard building blocks.",
      });
    } catch (e) {
      toast({
        title: "Consistency sheet failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setPosesBusy(false);
    }
  };

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/characters/${c.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          role: form.role || null,
          personality: form.personality || null,
          appearance: form.appearance || null,
          identityAnchor: form.identityAnchor || null,
          voice: form.voice,
          artStyle: form.artStyle,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Save failed");
      applyUpdate(data.character);
      toast({
        title: "Character saved",
        description: "Identity updates flow into every future generation.",
      });
    } catch (e) {
      toast({
        title: "Could not save character",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm(`Delete ${c.name}? Assigned videos stay in the library.`)) return;
    try {
      const res = await fetch(`/api/characters/${c.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      toast({ title: "Character removed", description: "Their videos stay unassigned." });
      onDeleted();
    } catch (e) {
      toast({
        title: "Could not delete character",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    }
  };

  const dirty =
    form.name !== c.name ||
    form.role !== (c.role ?? "") ||
    form.personality !== (c.personality ?? "") ||
    form.appearance !== (c.appearance ?? "") ||
    form.identityAnchor !== (c.identityAnchor ?? "") ||
    form.voice !== c.voice ||
    form.artStyle !== c.artStyle;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl bg-card border-white/10">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserRound className="h-5 w-5 text-primary" />
            {form.name || c.name} — Character Studio
          </DialogTitle>
          <DialogDescription>
            The identity anchor is stamped into every scene generation so this
            character stays perfectly on-model.
          </DialogDescription>
        </DialogHeader>

        <div className="grid md:grid-cols-[260px_1fr] gap-5 max-h-[62vh] overflow-y-auto pr-1 scroll-area-bar">
          {/* Portrait studio column */}
          <div className="space-y-3">
            <div className="relative aspect-square rounded-xl overflow-hidden bg-white/5 border border-white/10">
              {c.hasPortrait ? (
                <img
                  src={mediaUrl(c, `/api/characters/${c.id}/portrait`)}
                  alt={`${c.name} reference portrait`}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="h-full w-full flex flex-col items-center justify-center text-muted-foreground gap-2">
                  {portraitBusy ? (
                    <Loader2 className="h-8 w-8 animate-spin text-primary" />
                  ) : (
                    <ImageIcon className="h-10 w-10" />
                  )}
                  <span className="text-[11px] px-4 text-center">
                    {portraitBusy
                      ? "CogView is painting the reference portrait…"
                      : "No reference portrait yet"}
                  </span>
                </div>
              )}
              {portraitBusy && c.hasPortrait && (
                <div className="absolute inset-0 bg-background/60 backdrop-blur-[2px] flex items-center justify-center">
                  <Loader2 className="h-7 w-7 animate-spin text-primary" />
                </div>
              )}
            </div>

            <Button
              onClick={generatePortrait}
              disabled={portraitBusy}
              className="w-full bg-brand-gradient hover:opacity-90 font-medium"
            >
              {portraitBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : c.hasPortrait ? (
                <RefreshCw className="h-4 w-4" />
              ) : (
                <Wand2 className="h-4 w-4" />
              )}
              {portraitBusy
                ? "Painting… (~60s)"
                : c.hasPortrait
                  ? "Re-roll portrait"
                  : "Generate portrait"}
            </Button>

            {/* Consistency sheet */}
            <div className="rounded-xl border border-white/10 p-3 space-y-2.5">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium flex items-center gap-1.5">
                  <ShieldCheck className="h-3.5 w-3.5 text-emerald-300" />
                  Consistency sheet
                </p>
                {c.poseCount > 0 && (
                  <span className="text-[10px] text-emerald-300">
                    {c.poseCount}/{POSES.length} locked
                  </span>
                )}
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                {POSES.map((p) => {
                  const url = c.poseUrls.find((u) => u.pose === p.id)?.url;
                  return (
                    <div
                      key={p.id}
                      className="aspect-square rounded-lg overflow-hidden bg-white/5 border border-white/10"
                      title={p.label}
                    >
                      {url ? (
                        <img
                          src={mediaUrl(c, url)}
                          alt={`${c.name} — ${p.label} pose`}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="h-full w-full flex items-center justify-center text-[9px] text-muted-foreground text-center px-1">
                          {posesBusy ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                          ) : (
                            p.label
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              <Button
                onClick={generatePoses}
                disabled={posesBusy || !c.hasPortrait}
                variant="outline"
                size="sm"
                className="w-full border-white/15 bg-white/4"
              >
                {posesBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {posesBusy
                  ? "Locking identity…"
                  : c.poseCount > 0
                    ? "Re-generate poses"
                    : "Generate consistency sheet"}
              </Button>
              <p className="text-[10px] text-muted-foreground leading-relaxed">
                Image-editing re-renders the exact same face in 3 canonical poses —
                the storyboard bricks for scene generation.
              </p>
            </div>
          </div>

          {/* Editable profile column */}
          <div className="space-y-3.5">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="studio-name">Name</Label>
                <Input
                  id="studio-name"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  maxLength={60}
                  className="bg-white/5"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="studio-role">Role</Label>
                <Input
                  id="studio-role"
                  value={form.role}
                  onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
                  maxLength={200}
                  className="bg-white/5"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="studio-personality">Personality</Label>
              <Textarea
                id="studio-personality"
                value={form.personality}
                onChange={(e) => setForm((f) => ({ ...f, personality: e.target.value }))}
                rows={3}
                maxLength={2000}
                className="bg-white/5 resize-none"
                placeholder="Speech style, energy, catchphrases…"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="studio-appearance">Appearance</Label>
              <Textarea
                id="studio-appearance"
                value={form.appearance}
                onChange={(e) => setForm((f) => ({ ...f, appearance: e.target.value }))}
                rows={3}
                maxLength={2000}
                className="bg-white/5 resize-none"
                placeholder="Fixed visual identity description…"
              />
            </div>

            <div className="space-y-1.5">
              <Label
                htmlFor="studio-anchor"
                className="flex items-center gap-1.5"
              >
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-300" />
                Identity anchor
                <span className="text-[10px] font-normal text-muted-foreground">
                  (stamped into every scene)
                </span>
              </Label>
              <Textarea
                id="studio-anchor"
                value={form.identityAnchor}
                onChange={(e) => setForm((f) => ({ ...f, identityAnchor: e.target.value }))}
                rows={2}
                maxLength={1000}
                className="bg-white/5 resize-none text-xs"
                placeholder="Dense comma-separated invariant traits: 35yo male, short dark hair, round glasses…"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="flex items-center gap-1.5">
                  <Mic className="h-3.5 w-3.5" />
                  Voice
                </Label>
                <VoiceSelectWithPreview
                  value={form.voice}
                  onValueChange={(v) => setForm((f) => ({ ...f, voice: v }))}
                  voices={voices}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="flex items-center gap-1.5">
                  <Palette className="h-3.5 w-3.5" />
                  Art style
                </Label>
                <Select
                  value={form.artStyle}
                  onValueChange={(v) => setForm((f) => ({ ...f, artStyle: v }))}
                >
                  <SelectTrigger className="bg-white/5">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ART_STYLES.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex items-center gap-2 pt-1">
              <Button
                onClick={handleSave}
                disabled={saving || !dirty}
                className="bg-brand-gradient hover:opacity-90 font-medium"
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                {dirty ? "Save changes" : "Saved"}
              </Button>
              <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1">
                <Film className="h-3 w-3" />
                {c.videoCount} video{c.videoCount === 1 ? "" : "s"} cast this character
              </span>
            </div>
          </div>
        </div>

        <DialogFooter className="sm:justify-between border-t border-white/6 pt-3">
          <Button
            variant="ghost"
            onClick={handleDelete}
            className="text-muted-foreground hover:text-red-300 hover:bg-red-500/10"
          >
            <Trash2 className="h-4 w-4" />
            Delete character
          </Button>
          <Button variant="outline" onClick={onClose} className="border-white/15 bg-white/4">
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
