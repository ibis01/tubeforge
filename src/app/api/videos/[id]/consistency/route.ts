import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { parseConsistencyReport } from "@/lib/tubeforge/visual-consistency";
import { startJob, isJobRunning, lastJobError } from "@/lib/tubeforge/jobs";
import { runConsistencyJob } from "@/lib/tubeforge/video-jobs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * S77 — the Visual Consistency Engine's surface (design
 * `docs/design/s77-visual-consistency.md` §7).
 *
 * GET — the persisted report (V2; a legacy identity-only V1 row parses into
 * the additive shape with EMPTY new fields) + the job flags.
 * POST — start the engine (202): identity (the existing continuity pass,
 * reused) + batched style cohesion + the deterministic style contract +
 * repair proposals. Propose, never auto-edit: the report suggests repairs,
 * firing one is the existing storyboard AI-edit flow.
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const { id } = await ctx.params;
  const video = await db.video.findUnique({
    where: { id },
    select: { id: true, format: true, consistency: true },
  });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (video.format !== "story")
    return NextResponse.json({ error: "Not a scene-based video" }, { status: 400 });

  return NextResponse.json({
    consistency: parseConsistencyReport(video.consistency),
    generating: isJobRunning(id, "consistency"),
    error: lastJobError(id, "consistency"),
  });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (video.format !== "story")
    return NextResponse.json(
      { error: "Not a scene-based video — consistency applies to scene-format videos" },
      { status: 400 }
    );

  const sceneCount = video.scenes
    ? (JSON.parse(video.scenes) as unknown[]).length
    : 0;
  if (sceneCount === 0)
    return NextResponse.json(
      { error: "Video has no scenes — generate the scene script first" },
      { status: 400 }
    );

  // Clear any stale error before the job starts (the storyboard route's law).
  await db.video.update({ where: { id }, data: { error: null } });
  const accepted = await startJob(id, "consistency", () => runConsistencyJob(id, "manual"));
  return NextResponse.json(
    { accepted, generating: true },
    { status: accepted ? 202 : 200 }
  );
}
