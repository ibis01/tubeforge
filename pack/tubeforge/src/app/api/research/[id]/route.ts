import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

/** DELETE — remove a saved research session. */
export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const existing = await db.researchSession.findUnique({ where: { id } });
  if (!existing)
    return NextResponse.json({ error: "Session not found" }, { status: 404 });

  await db.researchSession.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
