import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
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

// Stage 1 (task T-1.11, audit gap R-HIGH-28): title/note previously had no
// length cap on PATCH — zod now bounds them. slotDate/timeOfDay keep their
// existing parseDay/regex validation (applied after the shape check).
const PatchSlotSchema = z
  .object({
    slotDate: z.string().max(10).optional(),
    timeOfDay: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    done: z.boolean().optional(),
    title: z.string().trim().min(1).max(120).optional(),
    note: z.string().max(1000).nullable().optional(),
    markVideoPublished: z.boolean().optional(),
  })
  .strict();

/** PATCH — move/reschedule a slot, toggle done, or rename it. */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const { id } = await ctx.params;
  const parsed = PatchSlotSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json(
      { error: "Invalid slot fields", details: parsed.error.flatten().fieldErrors },
      { status: 400 }
    );
  const body = parsed.data;

  const existing = await db.scheduleSlot.findUnique({ where: { id } });
  if (!existing)
    return NextResponse.json({ error: "Slot not found" }, { status: 404 });

  const data: Record<string, unknown> = {};
  if (body.slotDate !== undefined) {
    const day = parseDay(body.slotDate);
    if (!day)
      return NextResponse.json({ error: "Invalid slotDate" }, { status: 400 });
    data.slotDate = day;
  }
  if (body.timeOfDay !== undefined) data.timeOfDay = body.timeOfDay;
  if (body.done !== undefined) data.done = body.done;
  if (body.title !== undefined) data.title = body.title;
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
          organizationId: auth.ctx.organizationId,
          userId: auth.ctx.userId,
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
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const { id } = await ctx.params;
  const existing = await db.scheduleSlot.findUnique({ where: { id } });
  if (!existing)
    return NextResponse.json({ error: "Slot not found" }, { status: 404 });

  await db.scheduleSlot.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
