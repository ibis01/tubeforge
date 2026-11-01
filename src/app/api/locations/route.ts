import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";

/**
 * Stage 5 (module C) — the World library, LOCATIONS half.
 *
 * GET  — the org's active locations (name + description), oldest first.
 * POST — create one. The AI Director sees this list in its pass and may
 *        reference names per scene; under an approved plan the descriptions
 *        weave into scene image prompts (set continuity).
 */

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(600).optional().or(z.literal("")),
});

export async function GET(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const rows = await db.location.findMany({
    where: { isActive: true },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, description: true, createdAt: true },
  });
  return NextResponse.json({ locations: rows });
}

export async function POST(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success)
    return NextResponse.json(
      { error: "Name is required (1-80 characters); description ≤ 600" },
      { status: 400 }
    );

  const created = await db.location.create({
    data: {
      organizationId: auth.ctx.organizationId,
      name: parsed.data.name,
      description: parsed.data.description || null,
    },
    select: { id: true, name: true, description: true, createdAt: true },
  });
  return NextResponse.json({ location: created }, { status: 201 });
}
