import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { startJob, isJobRunning, lastJobError } from "@/lib/tubeforge/jobs";
import { parseCommentsKit } from "@/lib/tubeforge/comments";
import { runCommentsJob } from "@/lib/tubeforge/video-jobs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST — generate the launch-day engagement kit as a background job (202):
 * a pinned comment, 4 reply templates, heart targets and a playbook.
 * The job body is runCommentsJob (video-jobs.ts) — shared with the crash-
 * recovery handler, so a restart resumes the kit.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const { id } = await ctx.params;
  const video = await db.video.findUnique({
    where: { id },
    include: {
      channel: { select: { name: true } },
      character: { select: { name: true } },
    },
  });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (!video.script)
    return NextResponse.json(
      { error: "Write the script first — the kit references the video's content" },
      { status: 400 }
    );

  // Clear any stale error from a previous failed attempt before polling starts.
  await db.video.update({ where: { id }, data: { error: null } });

  const accepted = await startJob(id, "comments", () => runCommentsJob(id));

  return NextResponse.json(
    { accepted, generating: true },
    { status: accepted ? 202 : 200 }
  );
}

/** GET — kit status + the stored kit (drives the UI panel + polling). */
export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });

  return NextResponse.json({
    generating: isJobRunning(id, "comments"),
    error:
      lastJobError(id, "comments") ??
      (video.error && !isJobRunning(id, "comments") && !video.commentsKit
        ? video.error
        : null),
    kit: parseCommentsKit(video.commentsKit),
  });
}
