import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { isJobRunning, startJob } from "@/lib/tubeforge/jobs";
import * as storage from "@/lib/tubeforge/storage";
import {
  REFERENCE_MAX_BYTES,
  parseReferenceAnalysis,
  referenceNamespaceKeys,
  referenceSourceKey,
  runReferenceAnalysisJob,
} from "@/lib/tubeforge/reference-video";

type Ctx = { params: Promise<{ id: string }> };

/** The upload allowlist — the containers ffmpeg + the browser both speak
 *  natively. The probe at job time is the real gate (an MP4-named text
 *  file dies there with a readable error). */
const ALLOWED_EXT = new Set(["mp4", "mov", "webm", "mkv", "m4v"]);

/**
 * POST — upload a reference video and enqueue its structural analysis.
 * Multipart/form-data, field "file".
 *
 * The rights law (S88 design §2): UPLOAD ONLY, v1 — by uploading, the user
 * attests they hold the rights to learn from this file's structure; a URL
 * fetcher is deliberately deferred (platform terms + the SSRF surface).
 * The analysis extracts STRUCTURE (scene map, pacing, transcript for
 * labeling, treatment adjectives); the Director consumes only the
 * ABSTRACT characteristics — never words, footage or distinctive
 * expression (referenceBlockForPrompt is pinned to never emit the
 * transcript).
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });

  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data"))
    return NextResponse.json(
      { error: "Send the reference video as multipart/form-data with a 'file' field" },
      { status: 400 }
    );
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || file.size === 0)
    return NextResponse.json({ error: "Attach a video file in the 'file' field" }, { status: 400 });
  if (file.size > REFERENCE_MAX_BYTES)
    return NextResponse.json(
      {
        error: `The reference is ${Math.round(file.size / (1024 * 1024))} MB — the upload cap is ${REFERENCE_MAX_BYTES / (1024 * 1024)} MB`,
      },
      { status: 413 }
    );

  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  if (!ALLOWED_EXT.has(ext))
    return NextResponse.json(
      { error: `Unsupported reference format ".${ext}" — upload MP4, MOV, WEBM, MKV or M4V` },
      { status: 400 }
    );

  // One reference per video: the previous analysis + namespace die on the
  // re-upload (the newest reference is the only one that matters). The
  // sweep is best-effort — a straggler key is storage noise, never truth.
  for (const key of referenceNamespaceKeys(id)) {
    await storage.remove(key).catch(() => {});
  }
  const buf = Buffer.from(await file.arrayBuffer());
  await storage.put(referenceSourceKey(id, ext), buf);

  await db.video.update({ where: { id }, data: { referenceAnalysis: null, error: null } });

  const accepted = await startJob(id, "reference", () => runReferenceAnalysisJob(id));
  return NextResponse.json(
    {
      accepted,
      generating: true,
      bytes: buf.length,
      note: "The analysis extracts structure only — the Director will mirror the patterns, never the words or footage",
    },
    { status: accepted ? 202 : 200 }
  );
}

/** GET — the standing analysis (404 until one lands). `?keyframe=N`
 * streams scene window N's keyframe JPEG (auth-gated, same ownership). */
export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });

  const analysis = parseReferenceAnalysis(video.referenceAnalysis);
  if (!analysis)
    return NextResponse.json(
      { error: "No reference analysis on this video — upload one first" },
      { status: 404 }
    );

  const keyframeParam = new URL(req.url).searchParams.get("keyframe");
  if (keyframeParam !== null) {
    const idx = Number(keyframeParam);
    const win = analysis.sceneMap[Number.isInteger(idx) ? idx : -1];
    if (!win?.keyframeKey)
      return NextResponse.json({ error: "No keyframe for that window" }, { status: 404 });
    try {
      const buf = await storage.get(win.keyframeKey);
      return new NextResponse(new Uint8Array(buf), {
        headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=3600" },
      });
    } catch {
      return NextResponse.json({ error: "The keyframe is missing from storage" }, { status: 404 });
    }
  }

  return NextResponse.json({
    analysis,
    analyzing: isJobRunning(id, "reference"),
  });
}

/** DELETE — the escape hatch: clear the analysis + the whole reference
 *  namespace (the source upload dies with it). */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });

  for (const key of referenceNamespaceKeys(id)) {
    await storage.remove(key).catch(() => {});
  }
  await db.video.update({ where: { id }, data: { referenceAnalysis: null, error: null } });
  await db.activity.create({
    data: {
      organizationId: video.organizationId,
      userId: auth.ctx.userId,
      videoId: id,
      stage: "reference",
      message: "Reference video removed — the Director runs without it from the next pass",
    },
  });
  return NextResponse.json({ removed: true });
}
