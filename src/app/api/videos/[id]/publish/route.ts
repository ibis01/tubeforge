// POST /api/videos/[id]/publish — Stage 6 T-6.3: enqueue the YouTube upload job.
//
// Wires the dead `uploadToYouTube` scaffolding (D-06, D-07). The route:
//   1. requires a connected YouTube channel (per-user YouTubeAccount from
//      Stage 2 — one per user; the OAuth flow lives in /api/youtube/connect);
//   2. requires a final.mp4 (video.hasVideo — render first);
//   3. validates the user's title/description/tags/privacy/publishAt against
//      publishSchema (Zod — validation.ts);
//   4. enqueues a "upload" job (the durable queue's handler runs runUploadJob
//      with the SAME options persisted on the Job row — a crash resumes with
//      the user's choices instead of factory defaults);
//   5. returns 202 + the Job row id so the client can poll jobSnapshot/upload.
//
// Every external publishing action requires clear user authorization — the
// route is a SINGLE POST the user clicks after reviewing the chosen channel,
// title, description, thumbnail, privacy status, and (optional) scheduled
// time. No implicit publishing on render completion.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { isJobRunning, lastJobError, jobProgress, startJob } from "@/lib/tubeforge/jobs";
import { runUploadJob, type PublishJobOptions } from "@/lib/tubeforge/video-jobs";
import { isConnected, getPublishDefaults } from "@/lib/tubeforge/youtube";
import { parseJson, publishSchema, ApiValidationError } from "@/lib/tubeforge/validation";
import { applyQcPolicy, parseQcReport, qcEnforcementMode, qcOverrideValid } from "@/lib/tubeforge/qc-policy";

type Ctx = { params: Promise<{ id: string }> };

/** GET — publish job status (drives the client progress bar). */
export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });

  return NextResponse.json({
    publishing: isJobRunning(id, "upload"),
    progress: jobProgress(id, "upload"),
    youtubeUrl: video.youtubeUrl,
    publishedAt: video.publishedAt ? video.publishedAt.toISOString() : null,
    status: video.status,
    connected: await isConnected().catch(() => false),
    defaults: await getPublishDefaults().catch(() => ({ privacyStatus: "unlisted", categoryId: "27" })),
    error: lastJobError(id, "upload") ?? video.error,
  });
}

/** POST — enqueue the YouTube upload job (202). Body validated by publishSchema. */
export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });

  if (!video.hasVideo)
    return NextResponse.json(
      { error: "Cannot publish — render the video first" },
      { status: 400 }
    );

  if (!(await isConnected().catch(() => false)))
    return NextResponse.json(
      { error: "YouTube channel is not connected — connect it in Settings → Channel first" },
      { status: 400 }
    );

  let body;
  try {
    body = await parseJson(req, publishSchema);
  } catch (err) {
    if (err instanceof ApiValidationError)
      return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }

  // Reject a re-publish when already published (idempotent — the user must
  // explicitly DELETE the youtubeUrl via PATCH if they want to re-upload).
  // The job body is also idempotent (returns quietly if youtubeUrl is set),
  // but blocking at the route saves a queue round-trip and a confusing
  // "already published" activity entry.
  if (video.youtubeUrl && !isJobRunning(id, "upload"))
    return NextResponse.json(
      { error: "This video is already published — clear the existing YouTube URL before re-publishing" },
      { status: 409 }
    );

  // S40 — the ship gate, same policy as the export bundle: a blocking QC
  // finding (or no standing report) holds the upload until fixed or
  // explicitly accepted (POST /api/videos/[id]/export with a note — the
  // override is shared, not per-surface: one acceptance unlocks both ships
  // for exactly this report). TUBEFORGE_QC_ENFORCEMENT=report turns this
  // advisory for operators who want the pre-S40 behavior.
  const qcReport = parseQcReport(video.qcReport);
  const gate = applyQcPolicy(qcReport, { mode: qcEnforcementMode() });
  if (gate.blocked && !qcOverrideValid(video, qcReport))
    return NextResponse.json(
      {
        error: gate.missingReport
          ? "Publish on hold — no QC report stands behind this render. Re-run QC first."
          : `Publish on hold — ${gate.blockers.length} blocking QC finding${gate.blockers.length === 1 ? "" : "s"}. Fix and re-run QC, or accept the findings (Export → Ship anyway) to publish.`,
        blocked: true,
        gate,
      },
      { status: 409 }
    );

  // Default title from the video row when the user didn't supply one
  // (the schema requires non-empty, but the UI may pre-fill blank).
  const title = body.title || video.title || video.topic;
  const description = body.description || video.description || "";
  const tags = body.tags.length > 0 ? body.tags : (video.tags ? video.tags.split(",").map((t) => t.trim()).filter(Boolean) : []);

  const publishOpts: PublishJobOptions = {
    title,
    description,
    tags,
    thumbnailStorageKey: body.thumbnailStorageKey ?? null,
    privacyStatus: body.privacyStatus,
    publishAt: body.publishAt ?? null,
  };

  // Flip status to "publishing" immediately so the UI shows the pending state
  // before the queue claims the job (~1s typical). The job flips it to
  // "published" on success or "publish-failed" on error.
  await db.video.update({
    where: { id },
    data: { status: "publishing", error: null },
  });

  const accepted = await startJob(
    id,
    "upload",
    () => runUploadJob(id, publishOpts),
    { payload: publishOpts }
  );

  return NextResponse.json(
    {
      accepted,
      generating: accepted,
      kind: "upload",
      title,
      privacyStatus: publishOpts.privacyStatus ?? "unlisted",
      publishAt: publishOpts.publishAt,
    },
    { status: accepted ? 202 : 200 }
  );
}
