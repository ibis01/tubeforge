import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import type { ChannelDTO } from "@/lib/tubeforge/types";
import { errorText } from "@/lib/tubeforge/redact";

export async function GET() {
  const channels = await db.channel.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { videos: true } } },
  });

  const dtos: ChannelDTO[] = channels.map((c) => ({
    id: c.id,
    name: c.name,
    niche: c.niche,
    description: c.description,
    isActive: c.isActive,
    videoCount: c._count.videos,
    createdAt: c.createdAt.toISOString(),
  }));

  return NextResponse.json({ channels: dtos });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const name = String(body.name ?? "").trim();
    if (!name)
      return NextResponse.json({ error: "Channel name is required" }, { status: 400 });
    if (name.length > 80)
      return NextResponse.json({ error: "Channel name too long" }, { status: 400 });

    const niche = String(body.niche ?? "Motivation");
    const description = body.description ? String(body.description).slice(0, 500) : null;

    const channel = await db.channel.create({
      data: { name, niche, description },
      include: { _count: { select: { videos: true } } },
    });

    await db.activity.create({
      data: {
        stage: "channel",
        message: `Channel created — "${name}" (${niche})`,
      },
    });

    const dto: ChannelDTO = {
      id: channel.id,
      name: channel.name,
      niche: channel.niche,
      description: channel.description,
      isActive: channel.isActive,
      videoCount: channel._count.videos,
      createdAt: channel.createdAt.toISOString(),
    };

    return NextResponse.json({ channel: dto });
  } catch (err) {
    const message = errorText(err, "Invalid request");
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
