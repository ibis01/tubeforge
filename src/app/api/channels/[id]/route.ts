import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";

type Ctx = { params: Promise<{ id: string }> };

// Stage 1 (task T-1.11, audit gap R-HIGH-28): the PATCH path previously wrote
// niche/description with no length cap — zod now bounds every field.
const PatchChannelSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    niche: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(500).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const { id } = await ctx.params;
  const parsed = PatchChannelSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json(
      { error: "Invalid channel fields", details: parsed.error.flatten().fieldErrors },
      { status: 400 }
    );
  const body = parsed.data;

  const channel = await db.channel.findUnique({ where: { id } });
  if (!channel)
    return NextResponse.json({ error: "Channel not found" }, { status: 404 });

  const data: Record<string, unknown> = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.niche !== undefined) data.niche = body.niche;
  if (body.description !== undefined) data.description = body.description;
  if (body.isActive !== undefined) data.isActive = body.isActive;

  const updated = await db.channel.update({
    where: { id },
    data,
    include: { _count: { select: { videos: true } } },
  });

  return NextResponse.json({
    channel: {
      id: updated.id,
      name: updated.name,
      niche: updated.niche,
      description: updated.description,
      isActive: updated.isActive,
      videoCount: updated._count.videos,
      createdAt: updated.createdAt.toISOString(),
    },
  });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const { id } = await ctx.params;
  const channel = await db.channel.findUnique({ where: { id } });
  if (!channel)
    return NextResponse.json({ error: "Channel not found" }, { status: 404 });

  await db.channel.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
