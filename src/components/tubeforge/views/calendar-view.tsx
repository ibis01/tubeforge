"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAppStore } from "@/lib/store";
import { useToast } from "@/hooks/use-toast";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
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
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isBefore,
  isSameMonth,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from "date-fns";
import { EmptyState, StatusBadge } from "@/components/tubeforge/shared";
import {
  SLOT_TIMES,
  type SlotDTO,
  type VideoStatus,
} from "@/lib/tubeforge/types";
import {
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  Plus,
  Trash2,
  Check,
  CheckCircle2,
  Video as VideoIcon,
  Clock,
  StickyNote,
  Loader2,
  CalendarPlus,
} from "lucide-react";
import { clsx } from "clsx";

interface SchedulableVideo {
  id: string;
  title: string;
  status: VideoStatus;
  hasThumbnail: boolean;
  channelId: string | null;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_FMT = "MMMM yyyy";

function toDayString(d: Date): string {
  return format(d, "yyyy-MM-dd");
}

function slotSlotClass(slot: SlotDTO): string {
  if (slot.done) return "bg-emerald-500/15 border-emerald-500/30 text-emerald-200";
  if (slot.videoStatus === "published")
    return "bg-red-500/15 border-red-500/30 text-red-200";
  if (slot.videoId)
    return "bg-sky-500/15 border-sky-500/30 text-sky-200 hover:bg-sky-500/25";
  return "bg-white/8 border-white/15 text-zinc-300 hover:bg-white/12";
}

export function CalendarView() {
  const { toast } = useToast();
  const bumpRefresh = useAppStore((s) => s.bumpRefresh);
  const setView = useAppStore((s) => s.setView);
  const setFocusVideoId = useAppStore((s) => s.setFocusVideoId);
  const scheduleVideoId = useAppStore((s) => s.scheduleVideoId);
  const setScheduleVideoId = useAppStore((s) => s.setScheduleVideoId);

  const [cursor, setCursor] = useState(() => startOfMonth(new Date()));
  const [slots, setSlots] = useState<SlotDTO[]>([]);
  const [schedulable, setSchedulable] = useState<SchedulableVideo[]>([]);
  const [loading, setLoading] = useState(true);
  const [slotBusy, setSlotBusy] = useState<string | null>(null);

  // Create-slot dialog state
  const [createOpen, setCreateOpen] = useState(false);
  const [pickVideo, setPickVideo] = useState<string>("placeholder");
  const [customTitle, setCustomTitle] = useState("");
  const [slotDate, setSlotDate] = useState(toDayString(new Date()));
  const [slotTime, setSlotTime] = useState<string>("18:00");
  const [note, setNote] = useState("");
  const [creating, setCreating] = useState(false);

  // Slot detail dialog state
  const [detail, setDetail] = useState<SlotDTO | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const from = format(startOfWeek(startOfMonth(cursor), { weekStartsOn: 1 }), "yyyy-MM-dd");
      const to = format(endOfWeek(endOfMonth(cursor), { weekStartsOn: 1 }), "yyyy-MM-dd");
      const res = await fetch(`/api/schedule?from=${from}&to=${to}`);
      const data = await res.json();
      if (res.ok) {
        setSlots(data.slots ?? []);
        setSchedulable(data.schedulable ?? []);
      }
    } catch {
      toast({
        title: "Could not load calendar",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [cursor]);

  useEffect(() => {
    load();
  }, [load]);

  // Open create dialog when arriving from another view with a video preselected
  useEffect(() => {
    if (scheduleVideoId) {
      setPickVideo(scheduleVideoId);
      setSlotDate(toDayString(new Date()));
      setCreateOpen(true);
      setScheduleVideoId(null);
    }
  }, [scheduleVideoId, setScheduleVideoId]);

  const days = useMemo(() => {
    const start = startOfWeek(startOfMonth(cursor), { weekStartsOn: 1 });
    const end = endOfWeek(endOfMonth(cursor), { weekStartsOn: 1 });
    return eachDayOfInterval({ start, end });
  }, [cursor]);

  const slotsByDay = useMemo(() => {
    const map = new Map<string, SlotDTO[]>();
    for (const slot of slots) {
      const key = slot.slotDate.slice(0, 10);
      const list = map.get(key) ?? [];
      list.push(slot);
      map.set(key, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.timeOfDay.localeCompare(b.timeOfDay));
    return map;
  }, [slots]);

  const monthSlots = slots.filter((s) =>
    isSameMonth(new Date(s.slotDate), cursor)
  );
  const readyVideos = schedulable.filter((v) => v.status === "ready");

  const openCreate = (day: Date) => {
    setPickVideo("placeholder");
    setCustomTitle("");
    setSlotDate(toDayString(day));
    setSlotTime("18:00");
    setNote("");
    setCreateOpen(true);
  };

  const openCreateForVideo = (video: SchedulableVideo) => {
    setPickVideo(video.id);
    setSlotDate(toDayString(new Date()));
    setSlotTime("18:00");
    setNote("");
    setCreateOpen(true);
  };

  const createSlot = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const body: Record<string, unknown> = {
        slotDate,
        timeOfDay: slotTime,
        note: note.trim() || undefined,
      };
      if (pickVideo === "placeholder") body.title = customTitle.trim();
      else body.videoId = pickVideo;

      const res = await fetch("/api/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not schedule");
      toast({
        title: "Scheduled",
        description: `${data.slot.title} → ${slotDate} at ${slotTime}.`,
      });
      setCreateOpen(false);
      bumpRefresh();
      await load();
    } catch (e) {
      toast({
        title: "Scheduling failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setCreating(false);
    }
  };

  const patchSlot = async (
    slot: SlotDTO,
    body: Record<string, unknown>,
    successMsg: string
  ) => {
    if (slotBusy) return;
    setSlotBusy(slot.id);
    try {
      const res = await fetch(`/api/schedule/${slot.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Update failed");
      toast({ title: successMsg });
      setDetail((d) => (d && d.id === slot.id ? data.slot : d));
      bumpRefresh();
      await load();
    } catch (e) {
      toast({
        title: "Update failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setSlotBusy(null);
    }
  };

  const removeSlot = async (slot: SlotDTO) => {
    if (slotBusy) return;
    setSlotBusy(slot.id);
    try {
      const res = await fetch(`/api/schedule/${slot.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      toast({ title: "Slot removed" });
      setDetail(null);
      bumpRefresh();
      await load();
    } catch (e) {
      toast({
        title: "Delete failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setSlotBusy(null);
    }
  };

  const selectedVideo = schedulable.find((v) => v.id === pickVideo);
  const canCreate =
    pickVideo === "placeholder" ? customTitle.trim().length > 0 : Boolean(selectedVideo);

  return (
    <div className="flex flex-col lg:flex-row gap-6">
      {/* Calendar */}
      <div className="flex-1 min-w-0">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              onClick={() => setCursor((c) => addMonths(c, -1))}
              className="h-9 w-9 border-white/12 bg-white/4"
              aria-label="Previous month"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <h2 className="text-lg font-semibold tracking-tight min-w-40 text-center">
              {format(cursor, MONTH_FMT)}
            </h2>
            <Button
              variant="outline"
              size="icon"
              onClick={() => setCursor((c) => addMonths(c, 1))}
              className="h-9 w-9 border-white/12 bg-white/4"
              aria-label="Next month"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setCursor(startOfMonth(new Date()))}
              className="text-muted-foreground ml-1"
            >
              Today
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="border-white/20 bg-white/6 text-foreground/80 tabular-nums">
              {monthSlots.length} upload{monthSlots.length === 1 ? "" : "s"} this month
            </Badge>
          </div>
        </div>

        {/* Mobile: agenda list */}
        <div className="lg:hidden space-y-2">
          {loading ? (
            [0, 1, 2].map((i) => <Skeleton key={i} className="h-16 rounded-2xl" />)
          ) : slots.length === 0 ? (
            <EmptyState
              icon={CalendarDays}
              title="Nothing scheduled"
              hint="Pick a ready video on the right and give it an upload date."
            />
          ) : (
            slots.map((slot) => (
              <button
                key={slot.id}
                onClick={() => setDetail(slot)}
                className="w-full text-left"
              >
                <Card className="glass border-white/8 rounded-2xl p-3.5 flex flex-row items-center gap-3 hover:bg-white/4">
                  <div className="text-center shrink-0 bg-white/5 border border-white/10 rounded-lg px-2.5 py-1.5">
                    <p className="text-[10px] uppercase text-muted-foreground">
                      {format(new Date(slot.slotDate), "EEE")}
                    </p>
                    <p className="text-sm font-bold leading-none">
                      {format(new Date(slot.slotDate), "d MMM")}
                    </p>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{slot.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {slot.timeOfDay}
                      {slot.channelName ? ` · ${slot.channelName}` : ""}
                      {slot.done ? " · done" : ""}
                    </p>
                  </div>
                  {slot.videoId && (
                    <VideoIcon className="h-4 w-4 text-primary shrink-0" />
                  )}
                </Card>
              </button>
            ))
          )}
        </div>

        {/* Desktop: month grid */}
        <Card className="hidden lg:block glass border-white/8 rounded-2xl overflow-hidden">
          <div className="grid grid-cols-7 border-b border-white/8 bg-white/2">
            {WEEKDAYS.map((d) => (
              <div
                key={d}
                className="py-2.5 text-center text-[11px] font-medium uppercase tracking-wider text-foreground/75"
              >
                {d}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {days.map((day) => {
              const inMonth = isSameMonth(day, cursor);
              const dayKey = toDayString(day);
              const daySlots = slotsByDay.get(dayKey) ?? [];
              const isPast = isBefore(day, startOfDay(new Date()));
              const isToday = dayKey === toDayString(new Date());

              return (
                <div
                  key={dayKey}
                  className={clsx(
                    "group relative min-h-28 border-b border-r border-white/5 p-1.5 transition-colors",
                    !inMonth && "opacity-35",
                    "hover:bg-white/3"
                  )}
                >
                  <div className="flex items-center justify-between">
                    <span
                      className={clsx(
                        "text-xs font-medium tabular-nums rounded-full px-1.5 py-0.5",
                        isToday
                          ? "bg-primary text-white font-bold"
                          : isPast
                            ? "text-muted-foreground/60"
                            : "text-foreground"
                      )}
                    >
                      {format(day, "d")}
                    </span>
                    <button
                      onClick={() => openCreate(day)}
                      className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-primary transition-all p-1"
                      aria-label={`Schedule on ${dayKey}`}
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  <div className="mt-1 space-y-1">
                    {daySlots.slice(0, 3).map((slot) => (
                      <button
                        key={slot.id}
                        onClick={() => setDetail(slot)}
                        className={clsx(
                          "w-full text-left rounded-md border px-1.5 py-1 text-[11px] leading-tight transition-colors",
                          slotSlotClass(slot)
                        )}
                      >
                        <span className="font-medium tabular-nums">{slot.timeOfDay}</span>{" "}
                        <span className="truncate inline-block max-w-[85%] align-bottom">
                          {slot.title}
                        </span>
                      </button>
                    ))}
                    {daySlots.length > 3 && (
                      <p className="text-[10px] text-muted-foreground px-1.5">
                        +{daySlots.length - 3} more
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      </div>

      {/* Sidebar: ready to schedule */}
      <div className="lg:w-80 shrink-0">
        <Card className="glass border-white/8 rounded-2xl p-5">
          <div className="flex items-center justify-between mb-3">
            <p className="font-semibold text-sm">Ready to schedule</p>
            <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-300">
              {readyVideos.length}
            </Badge>
          </div>
          {loading ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-14 rounded-xl" />
              ))}
            </div>
          ) : schedulable.length === 0 ? (
            <div className="text-center py-6">
              <p className="text-sm text-muted-foreground">
                No videos are ready yet.
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3 border-white/15 bg-white/4"
                onClick={() => setView("create")}
              >
                Open Auto-Pilot
              </Button>
            </div>
          ) : (
            <div className="space-y-2 max-h-[26rem] overflow-y-auto scroll-area-bar pr-1">
              {schedulable.map((v) => (
                <div
                  key={v.id}
                  className="rounded-xl border border-white/8 bg-white/3 p-3 flex items-center gap-3"
                >
                  {v.hasThumbnail ? (
                    <img
                      src={`/api/videos/${v.id}/thumbnail`}
                      alt=""
                      className="h-10 w-[70px] rounded-md object-cover border border-white/10 shrink-0"
                    />
                  ) : (
                    <div className="h-10 w-[70px] rounded-md bg-white/5 border border-white/10 flex items-center justify-center shrink-0">
                      <VideoIcon className="h-4 w-4 text-muted-foreground" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{v.title}</p>
                    <StatusBadge status={v.status} />
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => openCreateForVideo(v)}
                    className="h-8 w-8 text-primary hover:bg-primary/15 shrink-0"
                    aria-label={`Schedule ${v.title}`}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Create slot dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md bg-card border-white/10">
          <DialogHeader className="text-left">
            <DialogTitle>Schedule an upload</DialogTitle>
            <DialogDescription>
              Drop a finished video (or a placeholder idea) onto a publish day.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <Label className="text-xs text-muted-foreground">Video</Label>
              <Select
                value={pickVideo}
                onValueChange={(v) => {
                  setPickVideo(v);
                }}
              >
                <SelectTrigger className="mt-1.5 bg-white/4 border-white/12">
                  <SelectValue placeholder="Pick a video" />
                </SelectTrigger>
                <SelectContent className="bg-popover border-white/10 max-h-64">
                  <SelectItem value="placeholder">
                    ✦ Custom idea (no video yet)
                  </SelectItem>
                  {schedulable.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {pickVideo === "placeholder" && (
              <div>
                <Label className="text-xs text-muted-foreground">Title</Label>
                <Input
                  value={customTitle}
                  onChange={(e) => setCustomTitle(e.target.value)}
                  placeholder="e.g. Why the Bronze Age collapse happened"
                  className="mt-1.5 bg-white/4 border-white/12"
                />
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs text-muted-foreground">Day</Label>
                <Input
                  type="date"
                  value={slotDate}
                  onChange={(e) => setSlotDate(e.target.value)}
                  className="mt-1.5 bg-white/4 border-white/12 [color-scheme:dark]"
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Time</Label>
                <Select value={slotTime} onValueChange={setSlotTime}>
                  <SelectTrigger className="mt-1.5 bg-white/4 border-white/12">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-popover border-white/10">
                    {SLOT_TIMES.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div>
              <Label className="text-xs text-muted-foreground">
                Note (optional)
              </Label>
              <Input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. pair with community post"
                className="mt-1.5 bg-white/4 border-white/12"
              />
            </div>
          </div>

          <DialogFooter className="mt-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setCreateOpen(false)}
              className="text-muted-foreground"
            >
              Cancel
            </Button>
            <Button
              onClick={createSlot}
              disabled={creating || !canCreate}
              size="sm"
              className="bg-brand-gradient hover:opacity-90 text-white font-semibold"
            >
              {creating ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <CalendarPlus className="h-3.5 w-3.5" />
              )}
              Schedule
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Slot detail dialog */}
      <Dialog open={Boolean(detail)} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-sm bg-card border-white/10">
          {detail && (
            <>
              <DialogHeader className="text-left">
                <DialogTitle className="text-base leading-snug">
                  {detail.title}
                </DialogTitle>
                <DialogDescription>
                  {format(new Date(detail.slotDate), "EEEE, d MMMM yyyy")} at {detail.timeOfDay}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-2 text-sm">
                <p className="flex items-center gap-2 text-muted-foreground">
                  <Clock className="h-3.5 w-3.5" />
                  {detail.done
                    ? "Already uploaded"
                    : detail.videoStatus === "published"
                      ? "Video marked as published"
                      : detail.videoId
                        ? "Video linked — ready to go"
                        : "Placeholder — no video attached yet"}
                </p>
                {detail.channelName && (
                  <p className="flex items-center gap-2 text-muted-foreground">
                    <VideoIcon className="h-3.5 w-3.5" />
                    {detail.channelName}
                  </p>
                )}
                {detail.note && (
                  <p className="flex items-center gap-2 text-muted-foreground">
                    <StickyNote className="h-3.5 w-3.5" />
                    {detail.note}
                  </p>
                )}
              </div>

              <Separator className="my-4 bg-white/8" />

              <DialogFooter className="flex-row flex-wrap gap-2">
                <div className="flex flex-wrap gap-2 flex-1">
                  {detail.videoId && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="border-white/15 bg-white/4"
                      onClick={() => {
                        setFocusVideoId(detail.videoId);
                        setDetail(null);
                        setView("library");
                      }}
                    >
                      <VideoIcon className="h-3.5 w-3.5" />
                      Open in library
                    </Button>
                  )}
                  {!detail.done && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={slotBusy === detail.id}
                      className="border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20"
                      onClick={() =>
                        patchSlot(
                          detail,
                          { done: true, markVideoPublished: true },
                          "Marked as uploaded"
                        )
                      }
                    >
                      {slotBusy === detail.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <CheckCircle2 className="h-3.5 w-3.5" />
                      )}
                      Mark uploaded
                    </Button>
                  )}
                  {detail.done && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={slotBusy === detail.id}
                      className="border-white/15 bg-white/4"
                      onClick={() => patchSlot(detail, { done: false }, "Reopened")}
                    >
                      <Check className="h-3.5 w-3.5" />
                      Reopen
                    </Button>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={slotBusy === detail.id}
                  onClick={() => removeSlot(detail)}
                  className="text-red-300 hover:text-red-200 hover:bg-red-500/10"
                >
                  {slotBusy === detail.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" />
                  )}
                  Remove
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
