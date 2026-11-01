import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { startJob, isJobRunning, lastJobError } from "@/lib/tubeforge/jobs";
import { parseVerifyReport } from "@/lib/tubeforge/verify";
import { runVerifyJob } from "@/lib/tubeforge/video-jobs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST — kick off the ASR narration check as a background job (202).
 * Transcribes the voiceover, compares it with the script, stores the report.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (!video.script)
    return NextResponse.json(
      { error: "Video has no script to check against" },
      { status: 400 }
    );
  if (!video.hasVoiceover)
    return NextResponse.json(
      { error: "No voiceover yet — generate the voiceover first" },
      { status: 400 }
    );

  // Clear any stale error from a previous failed attempt before polling starts.
  await db.video.update({ where: { id }, data: { error: null } });

  const accepted = await startJob(id, "verify", () => runVerifyJob(id));

  return NextResponse.json(
    { accepted, generating: true },
    { status: accepted ? 202 : 200 }
  );
}

/** GET — verification status + the stored report (drives the UI panel + polling). */
export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });

  return NextResponse.json({
    generating: isJobRunning(id, "verify"),
    error: lastJobError(id, "verify") ?? (video.error && !isJobRunning(id, "verify") && !video.verifyReport ? video.error : null),
    report: parseVerifyReport(video.verifyReport),
  });
}
