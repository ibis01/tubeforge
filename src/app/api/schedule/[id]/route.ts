import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serializeSlot, parseDay, type SlotWithRelations } from "@/lib/tubeforge/schedule";

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

type Ctx = { params: Promise<{ id: string }> };

const asSlot = (s: unknown) => s as SlotWithRelations;

/** PATCH — move/reschedule a slot, toggle done, or rename it. */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  let body: {
    slotDate?: string;
    timeOfDay?: string;
    done?: boolean;
    title?: string;
    note?: string;
    markVideoPublished?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const existing = await db.scheduleSlot.findUnique({ where: { id } });
  if (!existing)
    return NextResponse.json({ error: "Slot not found" }, { status: 404 });

  const data: Record<string, unknown> = {};
  if (body.slotDate) {
    const day = parseDay(body.slotDate);
    if (!day)
      return NextResponse.json({ error: "Invalid slotDate" }, { status: 400 });
    data.slotDate = day;
  }
  if (body.timeOfDay && /^\d{2}:\d{2}$/.test(body.timeOfDay))
    data.timeOfDay = body.timeOfDay;
  if (typeof body.done === "boolean") data.done = body.done;
  if (body.title?.trim()) data.title = body.title.trim();
  if (body.note !== undefined) data.note = body.note?.trim() || null;

  // Mark linked video as published (slot completion)
  if (body.markVideoPublished && existing.videoId) {
    const video = await db.video.findUnique({ where: { id: existing.videoId } });
    if (video && video.status !== "published") {
      await db.video.update({
        where: { id: existing.videoId },
        data: { status: "published", error: null },
      });
      await db.activity.create({
        data: {
          videoId: existing.videoId,
          stage: "schedule",
          message: `"${video.title ?? video.topic}" marked as published via the calendar`,
        },
      });
    }
  }

  const slot = await db.scheduleSlot.update({
    where: { id },
    data,
    include: VIDEO_INCLUDE,
  });

  const channel = slot.channelId
    ? await db.channel.findUnique({ where: { id: slot.channelId }, select: { name: true } })
    : null;

  return NextResponse.json({ slot: serializeSlot(asSlot(slot), channel?.name ?? null) });
}

/** DELETE — remove a slot (keeps the video). */
export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const existing = await db.scheduleSlot.findUnique({ where: { id } });
  if (!existing)
    return NextResponse.json({ error: "Slot not found" }, { status: 404 });

  await db.scheduleSlot.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
