import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { startJob, isJobRunning, lastJobError } from "@/lib/tubeforge/jobs";
import { generateEngagementKit, parseCommentsKit } from "@/lib/tubeforge/comments";
import { errorText } from "@/lib/tubeforge/redact";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST — generate the launch-day engagement kit as a background job (202):
 * a pinned comment, 4 reply templates, heart targets and a playbook.
 */
export async function POST(_req: NextRequest, ctx: Ctx) {
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

  const title = video.title ?? video.topic;
  const scriptExcerpt = (video.script ?? "").slice(0, 1200);

  const accepted = await startJob(id, "comments", async () => {
    try {
      await generateEngagementKit({
        videoId: id,
        title,
        topic: video.topic,
        niche: video.niche,
        tone: video.tone,
        scriptExcerpt,
        channelName: video.channel?.name ?? null,
        characterName: video.character?.name ?? null,
      });
    } catch (err) {
      const message =
        errorText(err, "Engagement kit failed");
      await db.video.update({ where: { id }, data: { error: message } });
      await db.activity.create({
        data: {
          videoId: id,
          stage: "comments",
          level: "error",
          message: `Engagement kit failed: ${message}`,
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

/** GET — kit status + the stored kit (drives the UI panel + polling). */
export async function GET(_req: NextRequest, ctx: Ctx) {
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
