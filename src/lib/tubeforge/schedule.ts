// Shared helpers for schedule-slot serialization (used by multiple API routes).

import type { Prisma } from "@prisma/client";
import type { SlotDTO, VideoStatus } from "./types";

export type SlotWithRelations = Prisma.ScheduleSlotGetPayload<{
  include: {
    video: {
      select: {
        id: true;
        title: true;
        topic: true;
        status: true;
        hasThumbnail: true;
      };
    };
  };
}>;

export function serializeSlot(
  slot: SlotWithRelations,
  channelName?: string | null
): SlotDTO {
  return {
    id: slot.id,
    videoId: slot.video?.id ?? null,
    videoTitle: slot.video?.title ?? slot.video?.topic ?? null,
    videoStatus: (slot.video?.status as VideoStatus | undefined) ?? null,
    hasThumbnail: slot.video?.hasThumbnail ?? false,
    channelId: slot.channelId,
    channelName: channelName ?? null,
    title: slot.title,
    slotDate: slot.slotDate.toISOString(),
    timeOfDay: slot.timeOfDay,
    note: slot.note,
    done: slot.done,
    createdAt: slot.createdAt.toISOString(),
  };
}

/** Parse a YYYY-MM-DD day string into an ISO date; returns null if invalid. */
export function parseDay(day: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const d = new Date(`${day}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}
