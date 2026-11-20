import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { StorageQuotaError } from "@/lib/tubeforge/storage";
import { loadLibrary } from "@/lib/tubeforge/whiteboard/assets";
import { parseWhiteboardDoc } from "@/lib/tubeforge/whiteboard/whiteboard-planner";
import { probeAssetRasterization } from "@/lib/tubeforge/whiteboard/render";
import {
  WB_RASTER_MAX_BYTES,
  WB_UPLOAD_MAX_BYTES,
  sniffRasterImage,
  validateUpload,
  type TracedUploadMeta,
} from "@/lib/tubeforge/whiteboard/upload";
import { resolveContentPolicy } from "@/lib/tubeforge/restricted-subjects";
import {
  deleteVideoUpload,
  listVideoUploads,
  saveVideoUpload,
  uploadCountWalls,
  whiteboardAssetKey,
} from "@/lib/tubeforge/whiteboard/asset-store";
import { get } from "@/lib/tubeforge/storage";

type Ctx = { params: Promise<{ id: string }> };

/**
 * S69 — the Whiteboard Engine's upload path (E9 Phase C / E11 §7), the
 * seven gates IN ORDER, each naming its unit-pinned sibling:
 *
 *   1. Transport  — multipart POST, per-kind raw byte cap (413 over):
 *                  SVG text 256 KB / raster (PNG+JPEG) 8 MB — the magic
 *                  bytes pick the wall (headers lie; P0).
 *   2. Sniff      — magic bytes for PNG/JPEG (raster branch), else UTF-8
 *                  + single root <svg> + usable viewBox (upload.ts).
 *   2.5 Trace     — P0 raster branch ONLY: the raster-to-stroke pipeline
 *                  runs between sniff and sanitize; its OUTPUT (the derived
 *                  single-subpath fragment) is what every later gate sees.
 *                  Quality gate: blank/dense/noisy/photo sources are
 *                  refused with the readable reason (audit §4A).
 *   3. Sanitize   — sanitizeSvg, the S64 attack battery (upload.ts).
 *   4. Budget     — 512/path, 2,048/asset (SVG) or 4,096/asset (traced),
 *                  zero extractAsset rejections — with the reasons.
 *   5. Rasterize-before-trust — the SAME network-aborted chromium the
 *                  renderer uses, ~5 s wall clock (render.ts).
 *   6. Quota      — per-org asset counts here; per-org BYTES through
 *                  storage.put's assertQuota (asset-store.ts).
 *   7. Storage    — <videoId>/whiteboard/assets/<assetId>.svg (the
 *                  SANITIZED fragment — for traced uploads, the DERIVED
 *                  fragment; the original raster is intentionally not
 *                  persisted) + the manifest row with provenance (the
 *                  trace receipt + the video's content policy id, P0-7).
 *
 * DELETE — removes one upload, refusing (409, with the scene list) while
 * the current project still references the asset: deleting a placed asset
 * would have the next save read "unknown asset" and the GET quietly fall
 * back to "no project" — a brick the user cannot see coming.
 *
 * What is stored is the sanitized FRAGMENT, never the raw document: the
 * pipeline neutralizes rather than punishes (a file whose script subtree
 * gets stripped still uploads — the palette preview shows exactly what
 * survived), and nothing that failed a gate is ever persisted.
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

  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data"))
    return NextResponse.json(
      { error: "Send the SVG or PNG/JPEG as multipart/form-data with a 'file' field" },
      { status: 400 }
    );
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || file.size === 0)
    return NextResponse.json(
      { error: "Attach an SVG or PNG/JPEG file in the 'file' field" },
      { status: 400 }
    );

  // Gate 1 — the transport wall, per-kind: the magic bytes pick the wall
  // (raster 8 MB, SVG text 256 KB). Headers can lie about size; the parsed
  // File is the truth the music-upload precedent checks too.
  const raw = Buffer.from(await file.arrayBuffer());
  const rasterMagic = sniffRasterImage(raw);
  const byteCap = rasterMagic ? WB_RASTER_MAX_BYTES : WB_UPLOAD_MAX_BYTES;
  if (raw.length > byteCap)
    return NextResponse.json(
      {
        error: rasterMagic
          ? `The image is ${((Math.round((raw.length / (1024 * 1024)) * 10) / 10)).toFixed(1)} MB — the raster upload cap is ${WB_RASTER_MAX_BYTES / (1024 * 1024)} MB`
          : `The SVG is ${Math.round(raw.length / 1024)} KB — the upload cap is ${WB_UPLOAD_MAX_BYTES / 1024} KB`,
      },
      { status: 413 }
    );

  // Gates 2–4 — the unified pure battery (sniff → [trace] → sanitize →
  // budgets), with the id collision wall the route owns: built-ins + this
  // video's existing rows.
  const reserved = new Set(loadLibrary().assets.keys());
  for (const row of await listVideoUploads(id)) reserved.add(row.assetId);
  const v = await validateUpload(raw, file.name || (rasterMagic ? "upload.png" : "upload.svg"), reserved);
  if (!v.ok)
    return NextResponse.json({ error: "The file failed the upload gates", errors: v.errors }, { status: 400 });
  // P0 — the trace provenance (compact meta on the row; the video's
  // content policy id rides along on BOTH raster entries per P0-7c).
  const tracedMeta: TracedUploadMeta | undefined = v.trace
    ? {
        strokes: v.trace.strokesKept,
        commands: v.trace.commands,
        sourceBytes: v.trace.sourceBytes,
        sourceFormat: v.trace.sourceFormat,
        ms:
          v.trace.ms.decode +
          v.trace.ms.normalize +
          v.trace.ms.threshold +
          v.trace.ms.skeleton +
          v.trace.ms.trace +
          v.trace.ms.simplify +
          v.trace.ms.emit,
        quality: v.trace.quality,
        policyId: resolveContentPolicy(video.contentPolicy),
      }
    : undefined;

  // Gate 5 — rasterize-before-trust (the SAME renderer, network-aborted).
  const probe = await probeAssetRasterization(v.asset);
  if (!probe.ok)
    return NextResponse.json({ error: probe.error ?? "The SVG failed the raster probe" }, { status: 400 });

  // Gate 6 — the COUNT walls (bytes ride storage.put inside gate 7).
  const walls = await uploadCountWalls(video.organizationId, id);
  if (walls.videoCount >= walls.videoCap)
    return NextResponse.json(
      { error: `This video already carries ${walls.videoCount} uploaded whiteboard assets (cap ${walls.videoCap}) — delete one first` },
      { status: 409 }
    );
  if (walls.orgCount >= walls.orgCap)
    return NextResponse.json(
      { error: `This organization already carries ${walls.orgCount} uploaded whiteboard assets (cap ${walls.orgCap})` },
      { status: 409 }
    );

  // Gate 7 — storage + manifest. A byte-quota hit surfaces as 413, not 500.
  try {
    const row = await saveVideoUpload(video, v.asset, auth.ctx.userId, tracedMeta);
    await db.activity.create({
      data: {
        organizationId: video.organizationId,
        userId: auth.ctx.userId,
        videoId: id,
        stage: "whiteboard",
        message: tracedMeta
          ? `Whiteboard asset traced+uploaded — "${v.asset.id}" (${tracedMeta.strokes} strokes from ${tracedMeta.sourceBytes} B ${tracedMeta.sourceFormat}, ${v.commands} commands, quality ${tracedMeta.quality}, ${row.bytes} B stored, raster probe ${probe.ms} ms)`
          : `Whiteboard asset uploaded — "${v.asset.id}" (${v.paths} paths, ${v.texts} texts, ${v.commands} commands, ${row.bytes} B stored, raster probe ${probe.ms} ms)`,
      },
    });
    return NextResponse.json(
      {
        assetId: v.asset.id,
        w: v.asset.viewBox.w,
        h: v.asset.viewBox.h,
        paths: v.paths,
        texts: v.texts,
        commands: v.commands,
        bytes: row.bytes,
        probeMs: probe.ms,
        ...(tracedMeta ? { traced: { strokes: tracedMeta.strokes, quality: tracedMeta.quality, sourceFormat: tracedMeta.sourceFormat } } : {}),
      },
      { status: 201 }
    );
  } catch (err) {
    if (err instanceof StorageQuotaError)
      return NextResponse.json({ error: err.message }, { status: 413 });
    throw err;
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });

  const assetId = req.nextUrl.searchParams.get("assetId")?.trim() ?? "";
  if (!assetId)
    return NextResponse.json({ error: "Pass ?assetId= of the upload to delete" }, { status: 400 });

  const rows = await listVideoUploads(id);
  if (!rows.some((r) => r.assetId === assetId))
    return NextResponse.json({ error: `No uploaded asset "${assetId}" on this video` }, { status: 404 });

  // The reference guard — the current project's placements + events must not
  // address this asset, or the next save bricks the doc with "unknown asset".
  const doc = parseWhiteboardDoc(video.whiteboardProject);
  const referencingScenes = (doc?.project?.scenes ?? [])
    .filter(
      (s) =>
        s.placements.some((p) => p.assetId === assetId) ||
        s.animations.some((a) => a.assetId === assetId)
    )
    .map((s) => s.id);
  if (referencingScenes.length > 0)
    return NextResponse.json(
      {
        error: `Scenes ${referencingScenes.join(", ")} still place "${assetId}" — remove those placements before deleting the asset`,
      },
      { status: 409 }
    );

  const bytes = rows.find((r) => r.assetId === assetId)?.bytes ?? 0;
  const deleted = await deleteVideoUpload(id, assetId);
  if (!deleted)
    return NextResponse.json({ error: `No uploaded asset "${assetId}" on this video` }, { status: 404 });
  await db.activity.create({
    data: {
      organizationId: video.organizationId,
      userId: auth.ctx.userId,
      videoId: id,
      stage: "whiteboard",
      message: `Whiteboard asset deleted — "${assetId}" (${bytes} B freed)`,
    },
  });

  // Honest confirmation: the object really is gone (get() throwing is the
  // success signal — a stale object would keep burning org quota).
  let verified = false;
  try {
    await get(whiteboardAssetKey(id, assetId));
  } catch {
    verified = true;
  }
  return NextResponse.json({ ok: true, assetId, verified });
}
