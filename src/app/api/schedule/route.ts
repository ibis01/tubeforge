import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import type { VideoStatus } from "@/lib/tubeforge/types";
import {
  serializeSlot,
  parseDay,
  type SlotWithRelations,
} from "@/lib/tubeforge/schedule";
import type { Prisma } from "@prisma/client";

const VIDEO_INCLUDE = {
  video: {
    select: {
      id: true,
      title: true,
      topic: true,
      status: true,
      hasThumbnail: true,
    },
  },
} as const;

type SlotRow = Prisma.ScheduleSlotGetPayload<{ include: typeof VIDEO_INCLUDE }>;

const asSlot = (s: unknown) => s as SlotWithRelations;

/** GET — slots in a range (from/to = YYYY-MM-DD), or upcoming compact mode (?limit=N). */
export async function GET(req: NextRequest) {
  const fromRaw = req.nextUrl.searchParams.get("from");
  const toRaw = req.nextUrl.searchParams.get("to");
  const limitRaw = req.nextUrl.searchParams.get("limit");

  const channels = await db.channel.findMany({ select: { id: true, name: true } });
  const channelMap = new Map(channels.map((c) => [c.id, c.name]));
  const decorate = (s: SlotRow) =>
    serializeSlot(
      asSlot(s),
      s.channelId ? channelMap.get(s.channelId) ?? null : null
    );

  // Upcoming-only compact mode (dashboard card)
  if (limitRaw) {
    const slots = await db.scheduleSlot.findMany({
      where: { slotDate: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } },
      orderBy: [{ slotDate: "asc" }, { timeOfDay: "asc" }],
      take: Math.min(10, Math.max(1, Number(limitRaw) || 3)),
      include: VIDEO_INCLUDE,
    });
    return NextResponse.json({ slots: slots.map(decorate) });
  }

  const from = fromRaw ? parseDay(fromRaw) : null;
  const to = toRaw ? parseDay(toRaw) : null;

  const where: Prisma.ScheduleSlotWhereInput = {};
  if (from || to) {
    where.slotDate = {};
    if (from) where.slotDate.gte = from;
    if (to) where.slotDate.lte = new Date(to.getTime() + 24 * 3600 * 1000 - 1);
  }

  const slots = await db.scheduleSlot.findMany({
    where,
    orderBy: [{ slotDate: "asc" }, { timeOfDay: "asc" }],
    include: VIDEO_INCLUDE,
  });

  // Ready + published videos for the scheduling sidebar
  const schedulable = await db.video.findMany({
    where: { status: { in: ["ready", "published"] } },
    select: {
      id: true,
      title: true,
      topic: true,
      status: true,
      hasThumbnail: true,
      channelId: true,
    },
    orderBy: { updatedAt: "desc" },
  });

  return NextResponse.json({
    slots: slots.map(decorate),
    schedulable: schedulable.map((v) => ({
      id: v.id,
      title: v.title ?? v.topic,
      status: v.status as VideoStatus,
      hasThumbnail: v.hasThumbnail,
      channelId: v.channelId,
    })),
  });
}

/** POST — create a schedule slot (from an existing video or a free-text placeholder). */
export async function POST(req: NextRequest) {
  let body: {
    videoId?: string;
    title?: string;
    slotDate?: string;
    timeOfDay?: string;
    channelId?: string;
    note?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const day = body.slotDate ? parseDay(body.slotDate) : null;
  if (!day)
    return NextResponse.json(
      { error: "slotDate must be a valid YYYY-MM-DD day" },
      { status: 400 }
    );

  let videoId: string | null = null;
  let title = (body.title ?? "").trim();
  let channelId: string | null = body.channelId?.trim() || null;

  if (body.videoId) {
    const video = await db.video.findUnique({
      where: { id: body.videoId },
      select: { id: true, title: true, topic: true, channelId: true },
    });
    if (!video)
      return NextResponse.json({ error: "Video not found" }, { status: 404 });
    videoId = video.id;
    title = title || video.title || video.topic;
    channelId = channelId || video.channelId;
  }

  if (!title)
    return NextResponse.json(
      { error: "Provide a video or a title" },
      { status: 400 }
    );

  const timeOfDay = /^\d{2}:\d{2}$/.test(body.timeOfDay ?? "")
    ? (body.timeOfDay as string)
    : "18:00";

  const slot = await db.scheduleSlot.create({
    data: {
      videoId,
      title,
      slotDate: day,
      timeOfDay,
      channelId,
      note: body.note?.trim() || null,
    },
    include: VIDEO_INCLUDE,
  });

  const channel = channelId
    ? await db.channel.findUnique({
        where: { id: channelId },
        select: { name: true },
      })
    : null;

  await db.activity.create({
    data: {
      videoId,
      stage: "schedule",
      message: `Scheduled "${title}" for ${day.toISOString().slice(0, 10)} at ${timeOfDay}`,
    },
  });

  return NextResponse.json({
    slot: serializeSlot(asSlot(slot), channel?.name ?? null),
  });
}
