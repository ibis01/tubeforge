import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serializeSession } from "@/lib/tubeforge/research";
import { isJobRunning, lastJobError } from "@/lib/tubeforge/jobs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET — one research session + its live job state.
 *
 * Companion to the jobbed POST /api/research (Stage 1, task T-1.10): the
 * client polls this endpoint while `generating` is true, then reads the
 * session's ideas (or the persisted `session.error` when the scan failed —
 * the job registry's in-memory error is lost on restart, the row is not).
 */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const row = await db.researchSession.findUnique({ where: { id } });
  if (!row)
    return NextResponse.json({ error: "Research scan not found" }, { status: 404 });

  return NextResponse.json({
    session: serializeSession(row),
    generating: isJobRunning(id, "research"),
    error: lastJobError(id, "research"),
  });
}

/** DELETE — remove a research session. */
export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const existing = await db.researchSession.findUnique({ where: { id } });
  if (!existing)
    return NextResponse.json({ error: "Research scan not found" }, { status: 404 });

  await db.researchSession.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
