import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { startJob, isJobRunning, lastJobError } from "@/lib/tubeforge/jobs";
import { verifyNarration, parseVerifyReport } from "@/lib/tubeforge/verify";
import { errorText } from "@/lib/tubeforge/redact";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST — kick off the ASR narration check as a background job (202).
 * Transcribes the voiceover, compares it with the script, stores the report.
 */
export async function POST(_req: NextRequest, ctx: Ctx) {
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

  const accepted = await startJob(id, "verify", async () => {
    try {
      await verifyNarration(id);
    } catch (err) {
      const message = errorText(err, "Narration check failed");
      await db.video.update({ where: { id }, data: { error: message } });
      await db.activity.create({
        data: {
          videoId: id,
          stage: "verify",
          level: "error",
          message: `Narration check failed: ${message}`,
        },
      });
      // Re-thrown so startJob records the failure for GET polling + history.
      throw err;
    }
  });

  return NextResponse.json(
    { accepted, generating: true },
    { status: accepted ? 202 : 200 }
  );
}

/** GET — verification status + the stored report (drives the UI panel + polling). */
export async function GET(_req: NextRequest, ctx: Ctx) {
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
