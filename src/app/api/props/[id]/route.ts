import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";

/**
 * Stage 5 (module C) — the World library, PROPS half, the [id] half.
 * Since S22 the library is a two-way door: a prop can be renamed,
 * rewritten or archived, and a mistake can be deleted outright (nothing
 * references the table by FK — the director reads it, plans-in-flight
 * already carry their snapshot).
 */

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(600).nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const { id } = await ctx.params;
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json(
      {
        error: "Invalid prop fields — name 1-80, description ≤ 600",
        details: parsed.error.flatten().fieldErrors,
      },
      { status: 400 }
    );
  if (Object.keys(parsed.data).length === 0)
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });

  // tenant-db injects organizationId — a foreign tenant's id resolves to
  // null here, exactly the 404 cross-tenant access must produce.
  const existing = await db.prop.findUnique({ where: { id } });
  if (!existing)
    return NextResponse.json({ error: "Prop not found" }, { status: 404 });

  const data: Record<string, unknown> = {};
  if (parsed.data.name !== undefined) data.name = parsed.data.name;
  if (parsed.data.description !== undefined)
    data.description = parsed.data.description || null;
  if (parsed.data.isActive !== undefined) data.isActive = parsed.data.isActive;

  const updated = await db.prop.update({
    where: { id },
    data,
    select: { id: true, name: true, description: true, isActive: true, createdAt: true },
  });
  return NextResponse.json({ prop: updated });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const { id } = await ctx.params;
  const existing = await db.prop.findUnique({ where: { id } });
  if (!existing)
    return NextResponse.json({ error: "Prop not found" }, { status: 404 });

  await db.prop.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
