import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { StorageQuotaError } from "@/lib/tubeforge/storage";
import { loadLibrary } from "@/lib/tubeforge/whiteboard/assets";
import { parseWhiteboardDoc } from "@/lib/tubeforge/whiteboard/whiteboard-planner";
import { probeAssetRasterization } from "@/lib/tubeforge/whiteboard/render";
import { WB_UPLOAD_MAX_BYTES, validateUploadedSvg } from "@/lib/tubeforge/whiteboard/upload";
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
 *   1. Transport  — multipart POST, 256 KB raw byte cap (413 over).
 *   2. Sniff      — UTF-8 + single root <svg> + usable viewBox (upload.ts).
 *   3. Sanitize   — sanitizeSvg, the S64 attack battery (upload.ts).
 *   4. Budget     — 512/path, 2,048/asset commands, zero extractAsset
 *                  rejections — with the reasons (upload.ts).
 *   5. Rasterize-before-trust — the SAME network-aborted chromium the
 *                  renderer uses, ~5 s wall clock (render.ts).
 *   6. Quota      — per-org asset counts here; per-org BYTES through
 *                  storage.put's assertQuota (asset-store.ts).
 *   7. Storage    — <videoId>/whiteboard/assets/<assetId>.svg (the
 *                  SANITIZED fragment) + the manifest row with provenance.
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
      { error: "Send the SVG as multipart/form-data with a 'file' field" },
      { status: 400 }
    );
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || file.size === 0)
    return NextResponse.json({ error: "Attach an SVG file in the 'file' field" }, { status: 400 });
  // Gate 1 — the transport wall (headers can lie about size; the parsed
  // File is the truth the music-upload precedent checks too).
  if (file.size > WB_UPLOAD_MAX_BYTES)
    return NextResponse.json(
      { error: `The SVG is ${Math.round(file.size / 1024)} KB — the upload cap is ${WB_UPLOAD_MAX_BYTES / 1024} KB` },
      { status: 413 }
    );

  // Gates 2–4 — the pure battery (sniff, sanitize, budgets), with the id
  // collision wall the route owns: built-ins + this video's existing rows.
  const reserved = new Set(loadLibrary().assets.keys());
  for (const row of await listVideoUploads(id)) reserved.add(row.assetId);
  const raw = Buffer.from(await file.arrayBuffer());
  const v = validateUploadedSvg(raw, file.name || "upload.svg", reserved);
  if (!v.ok)
    return NextResponse.json({ error: "The SVG failed the upload gates", errors: v.errors }, { status: 400 });

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
    const row = await saveVideoUpload(video, v.asset, auth.ctx.userId);
    await db.activity.create({
      data: {
        organizationId: video.organizationId,
        userId: auth.ctx.userId,
        videoId: id,
        stage: "whiteboard",
        message: `Whiteboard asset uploaded — "${v.asset.id}" (${v.paths} paths, ${v.texts} texts, ${v.commands} commands, ${row.bytes} B stored, raster probe ${probe.ms} ms)`,
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

  const assetId = new URL(req.url).searchParams.get("assetId")?.trim() ?? "";
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
