import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";

type Ctx = { params: Promise<{ id: string }> };

/** Stage 5 (module C) — one World-library location.
 *
 * PATCH  — rename / re-describe (the director pass sees the new text on its
 *          next run; already-approved plans weave whatever is current).
 * DELETE — soft-delete (isActive false) so historical plans that reference
 *          the name simply stop matching — no render ever breaks.
 */

const patchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(600).nullable().optional(),
});

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const { id } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success || Object.keys(parsed.data).length === 0)
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });

  const existing = await db.location.findFirst({ where: { id, isActive: true } });
  if (!existing) return NextResponse.json({ error: "Location not found" }, { status: 404 });

  const updated = await db.location.update({
    where: { id },
    data: {
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.description !== undefined
        ? { description: parsed.data.description || null }
        : {}),
    },
    select: { id: true, name: true, description: true, createdAt: true },
  });
  return NextResponse.json({ location: updated });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const { id } = await ctx.params;
  const existing = await db.location.findFirst({ where: { id, isActive: true } });
  if (!existing) return NextResponse.json({ error: "Location not found" }, { status: 404 });

  await db.location.update({ where: { id }, data: { isActive: false } });
  return NextResponse.json({ ok: true });
}
