import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { startJob } from "@/lib/tubeforge/jobs";
import { listPoses, portraitExists } from "@/lib/tubeforge/characters";
import { runPosesJob } from "@/lib/tubeforge/character-jobs";
import { POSES } from "@/lib/tubeforge/types";

type Ctx = { params: Promise<{ id: string }> };

/** GET — which poses exist so far. */
export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const { id } = await ctx.params;
  const character = await db.character.findUnique({ where: { id } });
  if (!character)
    return NextResponse.json({ error: "Character not found" }, { status: 404 });

  const existing = new Set(listPoses(id));
  return NextResponse.json({
    poses: POSES.filter((p) => existing.has(p.id)).map((p) => ({
      pose: p.id,
      label: p.label,
      url: `/api/characters/${id}/poses/${p.id}`,
    })),
    generating: false,
  });
}

/** POST — generate the full consistency sheet (3 poses) as a 202 background job. */
export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const { id } = await ctx.params;
  const character = await db.character.findUnique({ where: { id } });
  if (!character)
    return NextResponse.json({ error: "Character not found" }, { status: 404 });

  if (!portraitExists(id))
    return NextResponse.json(
      { error: "Generate the reference portrait first" },
      { status: 400 }
    );

  // Job body is runPosesJob (character-jobs.ts) — shared with the
  // crash-recovery handler; poses derive from the portrait + identity anchor.
  const started = await startJob(id, "poses", () => runPosesJob(id));

  if (!started)
    return NextResponse.json({ error: "Pose generation already running" }, { status: 409 });

  return NextResponse.json({ started: true }, { status: 202 });
}
