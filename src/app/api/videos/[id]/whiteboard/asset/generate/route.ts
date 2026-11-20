import { NextRequest, NextResponse } from "next/server";
import sharp from "sharp";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { StorageQuotaError } from "@/lib/tubeforge/storage";
import { loadLibrary } from "@/lib/tubeforge/whiteboard/assets";
import { probeAssetRasterization } from "@/lib/tubeforge/whiteboard/render";
import {
  validateUploadedRaster,
  type TracedUploadMeta,
} from "@/lib/tubeforge/whiteboard/upload";
import {
  guardWhiteboardGeneration,
  generateWhiteboardIllustration,
} from "@/lib/tubeforge/whiteboard/policy";
import { resolveContentPolicy } from "@/lib/tubeforge/restricted-subjects";
import {
  listVideoUploads,
  saveVideoUpload,
  uploadCountWalls,
} from "@/lib/tubeforge/whiteboard/asset-store";

type Ctx = { params: Promise<{ id: string }> };

/**
 * P0-7 — the AI illustration bridge: the story lane's imageGenerate
 * provider machinery, THIN, feeding the SAME raster-to-stroke gates.
 *
 * POST { prompt, size? } →
 *   1. the policy guard composes the prompt (whiteboard style suffix +
 *      the video's content-policy clause; restricted-subject mentions
 *      that SURVIVE sanitization are refused — P0-7b);
 *   2. the provider dispatch (imageGenerate, no whiteboard-owned model);
 *   3. the bytes normalize to PNG (provider-agnostic — the tracer's
 *      magic-byte law requires PNG/JPEG);
 *   4. validateUploadedRaster — the SAME gates as an upload (trace →
 *      sanitize → budgets → W3 validator);
 *   5. storage + manifest with uploadedBy:"ai" and the prompt + policy id
 *      recorded on the row (P0-7c provenance).
 *
 * The route mirrors the /asset route's gate order deliberately: an
 * AI-generated raster is an uploaded raster with a different provenance —
 * there is no second validation vocabulary.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (video.format !== "story")
    return NextResponse.json({ error: "Not a scene-based video" }, { status: 400 });

  const body = (await req.json().catch(() => null)) as { prompt?: string; size?: string } | null;
  const rawPrompt = body?.prompt?.trim() ?? "";
  if (!rawPrompt)
    return NextResponse.json(
      { error: "Pass a { prompt } — what should the illustration show?" },
      { status: 400 }
    );
  if (rawPrompt.length > 600)
    return NextResponse.json(
      { error: `the prompt is ${rawPrompt.length} chars — 600 is the bridge's cap (illustrations are one subject, not a scene list)` },
      { status: 400 }
    );
  const size = /^\d{3,4}x\d{3,4}$/.exec(body?.size ?? "")?.[0] ?? "1024x1024";

  // 1 — the policy guard (compose + refuse). The video's contentPolicy
  // column is the enforcement source (the profile never is — the schema's
  // own law).
  const policyId = resolveContentPolicy(video.contentPolicy);
  const guard = guardWhiteboardGeneration(rawPrompt, video.contentPolicy);
  if (!guard.ok || !guard.prompt)
    return NextResponse.json({ error: guard.error ?? "the prompt failed the policy guard" }, { status: 400 });

  // 2 — the provider dispatch (the story lane's machinery, reused exactly).
  let png: Buffer;
  try {
    const bytes = await generateWhiteboardIllustration(guard.prompt, guard.negativePrompt, size);
    // 3 — normalize to PNG (the tracer's magic-byte law requires PNG/JPEG;
    // a provider that returned WebP/JPEG is honest input — re-encode).
    png = await sharp(bytes).png().toBuffer();
  } catch (err) {
    const message = err instanceof Error ? err.message : "the image provider failed";
    return NextResponse.json(
      { error: `the image provider failed — ${message}` },
      { status: 502 }
    );
  }

  // 4 — the SAME gates as an upload (the bridge never bypasses one).
  const reserved = new Set(loadLibrary().assets.keys());
  for (const row of await listVideoUploads(id)) reserved.add(row.assetId);
  const slug =
    rawPrompt
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "illustration";
  const v = await validateUploadedRaster(png, `ai-${slug}.png`, reserved);
  if (!v.ok)
    return NextResponse.json(
      { error: "the generated image failed the trace gates", errors: v.errors },
      { status: 422 }
    );

  // 5 — storage + manifest, uploadedBy:"ai", prompt + policy on the row.
  try {
    const probe = await probeAssetRasterization(v.asset);
    if (!probe.ok)
      return NextResponse.json({ error: probe.error ?? "the traced asset failed the raster probe" }, { status: 400 });
    const walls = await uploadCountWalls(video.organizationId, id);
    if (walls.videoCount >= walls.videoCap)
      return NextResponse.json(
        { error: `this video already carries ${walls.videoCount} uploaded whiteboard assets (cap ${walls.videoCap}) — delete one first` },
        { status: 409 }
      );
    if (walls.orgCount >= walls.orgCap)
      return NextResponse.json(
        { error: `this organization already carries ${walls.orgCount} uploaded whiteboard assets (cap ${walls.orgCap})` },
        { status: 409 }
      );
    const trace = v.trace as NonNullable<typeof v.trace>;
    const tracedMeta: TracedUploadMeta = {
      strokes: trace.strokesKept,
      commands: trace.commands,
      sourceBytes: trace.sourceBytes,
      sourceFormat: trace.sourceFormat,
      ms:
        trace.ms.decode +
        trace.ms.normalize +
        trace.ms.threshold +
        trace.ms.skeleton +
        trace.ms.trace +
        trace.ms.simplify +
        trace.ms.emit,
      quality: trace.quality,
      prompt: guard.prompt,
      policyId,
    };
    const row = await saveVideoUpload(video, v.asset, "ai", tracedMeta);
    await db.activity.create({
      data: {
        organizationId: video.organizationId,
        userId: auth.ctx.userId,
        videoId: id,
        stage: "whiteboard",
        message: `Whiteboard AI illustration traced — "${v.asset.id}" (${tracedMeta.strokes} strokes, quality ${tracedMeta.quality}, policy ${policyId}, ${row.bytes} B stored)`,
      },
    });
    return NextResponse.json(
      {
        assetId: v.asset.id,
        w: v.asset.viewBox.w,
        h: v.asset.viewBox.h,
        paths: v.paths,
        commands: v.commands,
        bytes: row.bytes,
        traced: { strokes: tracedMeta.strokes, quality: tracedMeta.quality, sourceFormat: tracedMeta.sourceFormat },
      },
      { status: 201 }
    );
  } catch (err) {
    if (err instanceof StorageQuotaError)
      return NextResponse.json({ error: err.message }, { status: 413 });
    throw err;
  }
}
