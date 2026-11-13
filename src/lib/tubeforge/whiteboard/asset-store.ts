// S69 — the Whiteboard Engine: the uploaded-asset STORE (E9 Phase C /
// E11 §7 gates 6–7 — the server half of the upload path).
//
// One manifest row + one storage object per upload:
//   manifest: WhiteboardAssetUpload (videoId × assetId unique, org-scoped,
//             carrying the sniffed viewBox + bytes + provenance)
//   object:   <videoId>/whiteboard/assets/<assetId>.svg (the SANITIZED
//             fragment — gates 1–4 already ran before anything is stored)
//
// `loadVideoLibrary` is the ONE seam every consumer uses — the GET/PUT/
// scaffold/render routes and the render job — so the editor, the validator
// and the renderer agree on the asset universe by construction (the same
// one-merge law the frame plan rides).
//
// Quota (gate 6): bytes ride storage.put's per-org assertQuota (every
// non-system put passes it); asset COUNT walls are checked by the route
// through the manifest queries below.
import { db } from "@/lib/tubeforge/tenant-db";
import { get, put, remove } from "@/lib/tubeforge/storage";
import { loadLibrary, type WhiteboardAsset } from "./assets";
import {
  WB_UPLOADS_PER_ORG,
  WB_UPLOADS_PER_VIDEO,
} from "./upload";

/** The storage key of a video's uploaded asset (§7 gate 7 layout). */
export function whiteboardAssetKey(videoId: string, assetId: string): string {
  return `${videoId}/whiteboard/assets/${assetId}.svg`;
}

export interface WhiteboardUploadRow {
  id: string;
  videoId: string;
  assetId: string;
  viewBoxW: number;
  viewBoxH: number;
  bytes: number;
  uploadedBy: string;
  createdAt: Date;
}

/** The manifest rows for one video (oldest first — palette order). */
export async function listVideoUploads(videoId: string): Promise<WhiteboardUploadRow[]> {
  return db.whiteboardAssetUpload.findMany({
    where: { videoId },
    orderBy: { createdAt: "asc" },
  });
}

/** Gate 6 count walls: per-video + per-org asset counts (bytes ride put). */
export async function uploadCountWalls(
  organizationId: string,
  videoId: string
): Promise<{ videoCount: number; orgCount: number; videoCap: number; orgCap: number }> {
  const [videoCount, orgCount] = await Promise.all([
    db.whiteboardAssetUpload.count({ where: { videoId } }),
    db.whiteboardAssetUpload.count({ where: { organizationId } }),
  ]);
  return { videoCount, orgCount, videoCap: WB_UPLOADS_PER_VIDEO, orgCap: WB_UPLOADS_PER_ORG };
}

/** Store the sanitized fragment + write the manifest row (gates 6–7; the
 *  caller has already run gates 1–5). storage.put enforces the per-org BYTE
 *  quota; the route checked the COUNT walls before calling this. */
export async function saveVideoUpload(
  video: { id: string; organizationId: string },
  asset: WhiteboardAsset,
  uploadedBy: string
): Promise<WhiteboardUploadRow> {
  const bytes = Buffer.byteLength(asset.svg, "utf8");
  await put(whiteboardAssetKey(video.id, asset.id), Buffer.from(asset.svg, "utf8"));
  return db.whiteboardAssetUpload.create({
    data: {
      organizationId: video.organizationId,
      videoId: video.id,
      assetId: asset.id,
      viewBoxW: asset.viewBox.w,
      viewBoxH: asset.viewBox.h,
      bytes,
      uploadedBy,
    },
  });
}

/** Delete one upload (manifest row + object). Returns false when the assetId
 *  has no row on this video. The route guards project references BEFORE
 *  calling this — deleting a referenced asset would silently invalidate the
 *  doc on the next save. */
export async function deleteVideoUpload(videoId: string, assetId: string): Promise<boolean> {
  const row = await db.whiteboardAssetUpload.findUnique({
    where: { videoId_assetId: { videoId, assetId } },
  });
  if (!row) return false;
  await db.whiteboardAssetUpload.delete({ where: { id: row.id } });
  await remove(whiteboardAssetKey(videoId, assetId)).catch(() => {});
  return true;
}

export interface VideoLibrary {
  /** The merged library — built-ins + this video's uploads. */
  lib: ReturnType<typeof loadLibrary>;
  /** The manifest rows (palette provenance + ordering). */
  uploads: WhiteboardUploadRow[];
  /** The loaded upload assets, keyed by assetId — the wire payload's
   *  viewBox + sanitized svg (what the editor needs and the built-ins
   *  already ship in the bundle). */
  uploadedAssets: Map<string, WhiteboardAsset>;
  /** W3: uploads the stroke-authored validator excluded at load
   *  (warn-and-exclude — additive; consumers that never read it are
   *  untouched, the studio may surface the reasons). */
  warnings: { assetId: string; reasons: string[] }[];
}

/** Load a video's library: built-ins + its uploads, through the ONE merge
 *  (§7 gate 7). A storage object that has vanished (an operator-side sweep,
 *  a driver hiccup) is skipped honestly — its manifest row stays, the asset
 *  just stops validating until re-uploaded; a load that THREW would take
 *  the whole studio down with it. */
export async function loadVideoLibrary(videoId: string): Promise<VideoLibrary> {
  const uploads = await listVideoUploads(videoId);
  const list: WhiteboardAsset[] = [];
  for (const row of uploads) {
    try {
      const buf = await get(whiteboardAssetKey(videoId, row.assetId));
      list.push({
        id: row.assetId,
        viewBox: { w: row.viewBoxW, h: row.viewBoxH },
        tags: ["upload"],
        svg: buf.toString("utf8"),
      });
    } catch {
      /* object gone — the row stays, the asset stops validating */
    }
  }
  const lib = loadLibrary(list);
  return {
    lib,
    uploads,
    uploadedAssets: new Map(list.map((a) => [a.id, a])),
    warnings: lib.warnings,
  };
}
