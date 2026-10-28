import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const body = await req.json();

  const channel = await db.channel.findUnique({ where: { id } });
  if (!channel)
    return NextResponse.json({ error: "Channel not found" }, { status: 404 });

  const data: Record<string, unknown> = {};
  if (typeof body.name === "string" && body.name.trim())
    data.name = body.name.trim().slice(0, 80);
  if (typeof body.niche === "string") data.niche = body.niche;
  if (typeof body.description === "string") data.description = body.description;
  if (typeof body.isActive === "boolean") data.isActive = body.isActive;

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

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const channel = await db.channel.findUnique({ where: { id } });
  if (!channel)
    return NextResponse.json({ error: "Channel not found" }, { status: 404 });

  await db.channel.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
