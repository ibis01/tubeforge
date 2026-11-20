import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";

import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { StorageQuotaError } from "@/lib/tubeforge/storage";
import { parseGraphicsDoc } from "@/lib/tubeforge/graphics/types";
import {
  IMPORT_WALLS,
  importIdShape,
  sanitizeProvenance,
  snapFps,
  sniffImportKind,
  validateSequenceFrame,
  validateSheetImport,
} from "@/lib/tubeforge/graphics/import-validate";
import {
  ImportCountRefusal,
  deleteVideoImport,
  graphicsImportKey,
  importCountWalls,
  importObjectNames,
  listVideoImports,
  saveImport,
} from "@/lib/tubeforge/graphics/import-store";
import { get } from "@/lib/tubeforge/storage";

type Ctx = { params: Promise<{ id: string }> };

const execFileP = promisify(execFile);

/**
 * S126 — the external import lane's route (docs/design/s126-import-lane.md),
 * the E11 seven gates mirrored for raster assets:
 *
 *   1. Transport  — multipart POST, per-kind byte caps (413 over).
 *   2. Sniff      — magic bytes (PNG / WebP / WebM), never extension trust.
 *   3. Alpha      — PNG header color-type law / WebP VP8X flag; WebM via
 *                   ffmpeg alphaextract+signalstats. Opaque rasters refuse.
 *   4. Budget     — dims (1..4096), frames (1..48), strip decode wall,
 *                   sequence uniformity.
 *   5. Rasterize-before-trust — the WebM decode IS the raster probe
 *                   (ffmpeg → alpha PNG frames, wall-clocked); the fps snaps
 *                   to the shared 24|30 timebase (the D3 normalization law).
 *   6. Quota      — per-video/per-org COUNT walls here; per-org BYTES
 *                   through storage.put's assertQuota (import-store.ts).
 *   7. Storage    — {videoId}/graphics/imports/{importId}/… + the
 *                   GraphicsImport manifest row with user-declared
 *                   provenance (source/license — the reception record's
 *                   binding rule).
 *
 * THREE import formats, ONE runtime representation: a sprite sheet stays a
 * sheet; a PNG sequence stays a sequence; a WebM is DECODED to a PNG
 * sequence at admission — the graphics runtime never sees a video clock
 * (the ONE applier law). GET lists the manifest; DELETE reference-guards
 * against the doc before removing (the whiteboard upload route's law).
 */

export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });

  const rows = await listVideoImports(id);
  const imports = rows.map((r) => ({
    importId: r.importId,
    layout: r.layout,
    mime: r.mime,
    frames: r.frames,
    fps: r.fps,
    frameW: r.frameW,
    frameH: r.frameH,
    bytes: r.bytes,
    source: r.source,
    license: r.license,
    createdAt: r.createdAt.toISOString(),
    files: importObjectNames(r),
  }));

  // ?resolve=1 — the editor's preview seam: the SAME store resolution the
  // render job runs, returned as data URIs (assetKey → per-frame list).
  // Org-scoped by the video row; spriteless studios pay nothing (the
  // resolution runs only when asked).
  if (req.nextUrl.searchParams.get("resolve") === "1") {
    const { resolveSpriteAssets } = await import("@/lib/tubeforge/graphics/import-store");
    const { assets, missing } = await resolveSpriteAssets(
      id,
      rows.map((r) => r.importId)
    );
    return NextResponse.json({
      imports,
      assets: Object.fromEntries(assets),
      missing,
    });
  }

  return NextResponse.json({ imports });
}

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
      { error: "Send the import as multipart/form-data ('kind', 'file' or 'frames', optional 'fps', 'source', 'license')" },
      { status: 400 }
    );
  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "Unreadable multipart body" }, { status: 400 });

  const kind = String(form.get("kind") ?? "");
  if (kind !== "sheet" && kind !== "sequence" && kind !== "webm")
    return NextResponse.json({ error: "kind must be sheet, sequence, or webm" }, { status: 400 });
  const provenance = sanitizeProvenance({
    source: form.get("source") ?? undefined,
    license: form.get("license") ?? undefined,
  });

  const importId = `imp-${crypto.randomBytes(6).toString("hex")}`;
  if (!importIdShape(importId)) {
    return NextResponse.json({ error: "the minted import id failed the shape law" }, { status: 500 });
  }

  try {
    if (kind === "sheet") return await importSheet(id, video.organizationId, form, importId, provenance, auth.ctx.userId);
    if (kind === "sequence") return await importSequence(id, video.organizationId, form, importId, provenance, auth.ctx.userId);
    return await importWebm(id, video.organizationId, form, importId, provenance, auth.ctx.userId);
  } catch (err) {
    if (err instanceof ImportRefusal) {
      return NextResponse.json({ error: err.message, errors: err.errors }, { status: err.status });
    }
    // S140 — the authoritative count wall lives inside saveImport's
    // admission transaction; its refusal surfaces here as the same 409 the
    // fast pre-check produces (F2: no concurrent import can slip past it).
    if (err instanceof ImportCountRefusal) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof StorageQuotaError)
      return NextResponse.json({ error: err.message }, { status: 413 });
    throw err;
  }
}

/** The named refusal — the gates speak in reasons, never bare statuses. */
class ImportRefusal extends Error {
  constructor(message: string, readonly errors: string[] = [], readonly status: number = 400) {
    super(message);
  }
}

/** The FAST pre-check (UX only — bounce an over-cap video before the heavy
 *  decode/upload work). S140: the AUTHORITATIVE wall lives inside
 *  saveImport's admission transaction; this read can lose a race with a
 *  concurrent import and the store's wall will still refuse honestly. */
async function countWallsOrFail(organizationId: string, videoId: string): Promise<void> {
  const walls = await importCountWalls(organizationId, videoId);
  if (walls.videoCount >= walls.videoCap)
    throw new ImportRefusal(
      `This video already carries ${walls.videoCount} graphics imports (cap ${walls.videoCap}) — delete one first`,
      [],
      409
    );
  if (walls.orgCount >= walls.orgCap)
    throw new ImportRefusal(
      `This organization already carries ${walls.orgCount} graphics imports (cap ${walls.orgCap})`,
      [],
      409
    );
}

async function importSheet(
  videoId: string,
  organizationId: string,
  form: FormData,
  importId: string,
  provenance: { source: string | null; license: string | null; warnings: string[] },
  userId: string
): Promise<NextResponse> {
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0)
    throw new ImportRefusal("Attach the sheet in the 'file' field");
  if (file.size > IMPORT_WALLS.sheetBytesMax)
    throw new ImportRefusal(`The sheet is ${Math.round(file.size / 1024 / 1024)} MB — the cap is ${IMPORT_WALLS.sheetBytesMax / 1024 / 1024} MB`, [], 413);
  const frames = Number(form.get("frames"));
  const bytes = Buffer.from(await file.arrayBuffer());
  const v = validateSheetImport(bytes, frames);
  if (!v.ok) throw new ImportRefusal("The sheet failed the import gates", v.errors);
  await countWallsOrFail(organizationId, videoId);
  const row = await saveImport(
    { id: videoId, organizationId },
    {
      importId,
      layout: "sheet",
      mime: v.mime,
      frames,
      fps: 30, // the doc's sprite payload declares the playback rate; a sheet is a spatial grid — the row records the shared default
      frameW: v.frameW,
      frameH: v.frameH,
      source: provenance.source,
      license: provenance.license,
    },
    [{ name: "sheet.png", bytes }],
    userId
  );
  return NextResponse.json(
    { importId: row.importId, layout: "sheet", frames, fps: row.fps, frameW: v.frameW, frameH: v.frameH, bytes: row.bytes, warnings: provenance.warnings },
    { status: 201 }
  );
}

async function importSequence(
  videoId: string,
  organizationId: string,
  form: FormData,
  importId: string,
  provenance: { source: string | null; license: string | null; warnings: string[] },
  userId: string
): Promise<NextResponse> {
  const files = form.getAll("frames").filter((f): f is File => f instanceof File);
  if (files.length === 0)
    throw new ImportRefusal("Attach the frames in the 'frames' field (multiple)");
  if (files.length > IMPORT_WALLS.framesMax)
    throw new ImportRefusal(`${files.length} frames — the wall is ${IMPORT_WALLS.framesMax}`);
  const declaredFps = Number(form.get("fps"));
  if (declaredFps !== 24 && declaredFps !== 30)
    throw new ImportRefusal("Declare the sequence's playback rate as fps=24 or fps=30 (the shared timebase)");
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const buffers: { name: string; bytes: Buffer }[] = [];
  let first: { width: number; height: number } | null = null;
  for (const f of sorted) {
    if (f.size > IMPORT_WALLS.frameBytesMax)
      throw new ImportRefusal(`Frame "${f.name}" is ${Math.round(f.size / 1024)} KB — the per-frame cap is ${IMPORT_WALLS.frameBytesMax / 1024} KB`, [], 413);
    const bytes = Buffer.from(await f.arrayBuffer());
    const v = validateSequenceFrame(bytes);
    if (!v.ok) throw new ImportRefusal(`Frame "${f.name}" failed the gates`, v.errors);
    if (first === null) {
      first = { width: v.width, height: v.height };
    } else if (v.width !== first.width || v.height !== first.height) {
      throw new ImportRefusal("The sequence is not size-uniform", [
        `frame "${f.name}" is ${v.width}x${v.height}, the first frame is ${first.width}x${first.height}`,
      ]);
    }
    buffers.push({ name: `f${String(buffers.length).padStart(4, "0")}.png`, bytes });
  }
  await countWallsOrFail(organizationId, videoId);
  const row = await saveImport(
    { id: videoId, organizationId },
    {
      importId,
      layout: "sequence",
      mime: "image/png",
      frames: buffers.length,
      fps: declaredFps,
      frameW: first?.width ?? 0,
      frameH: first?.height ?? 0,
      source: provenance.source,
      license: provenance.license,
    },
    buffers,
    userId
  );
  return NextResponse.json(
    { importId: row.importId, layout: "sequence", frames: buffers.length, fps: declaredFps, frameW: first?.width, frameH: first?.height, bytes: row.bytes, warnings: provenance.warnings },
    { status: 201 }
  );
}

async function importWebm(
  videoId: string,
  organizationId: string,
  form: FormData,
  importId: string,
  provenance: { source: string | null; license: string | null; warnings: string[] },
  userId: string
): Promise<NextResponse> {
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0)
    throw new ImportRefusal("Attach the WebM in the 'file' field");
  if (file.size > IMPORT_WALLS.webmBytesMax)
    throw new ImportRefusal(`The WebM is ${Math.round(file.size / 1024 / 1024)} MB — the cap is ${IMPORT_WALLS.webmBytesMax / 1024 / 1024} MB`, [], 413);
  const bytes = Buffer.from(await file.arrayBuffer());
  if (sniffImportKind(bytes) !== "webm")
    throw new ImportRefusal("The source is not a WebM (magic bytes)", ["a WebM starts with the EBML 0x1A45DFA3 signature"]);

  // Gate 5 — the decode IS the raster probe: alpha PNG frames at a tmp dir
  // (wall-clocked; a hung/dead ffmpeg fails the gate, never hangs the
  // route). Gate 3 rides the decode's output: the frames carry alpha iff
  // the source does — verified by the alphaextract probe below.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tubeforge-import-"));
  const src = path.join(tmp, "source.webm");
  const outPattern = path.join(tmp, "f%04d.png");
  try {
    fs.writeFileSync(src, bytes);
    await execFileP(
      "ffmpeg",
      ["-y", "-i", src, "-c:v", "png", "-pix_fmt", "rgba", outPattern],
      { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }
    ).catch((e) => {
      throw new ImportRefusal("The WebM failed to decode", [String(e.stderr ?? e.message).slice(-300)]);
    });
    const names = fs.readdirSync(tmp).filter((n) => /^f\d{4}\.png$/.test(n)).sort();
    if (names.length === 0)
      throw new ImportRefusal("The WebM decoded to zero frames", ["no video stream, or a stream the PNG encoder could not rasterize"]);
    if (names.length > IMPORT_WALLS.framesMax)
      throw new ImportRefusal(
        `The WebM carries ${names.length} frames — the wall is ${IMPORT_WALLS.framesMax}; trim or slow the source`,
        [],
        413
      );
    // Gate 3 — alpha presence through ffmpeg (alphaextract + signalstats:
    // YMIN < 255 means at least one pixel is transparent). A fully opaque
    // source refuses (the lane composites transparency).
    const probe = await execFileP(
      "ffmpeg",
      ["-v", "info", "-i", path.join(tmp, names[0]), "-vf", "alphaextract,signalstats", "-frames:v", "1", "-f", "null", "-"],
      { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 }
    ).catch(() => null);
    const ymin = probe ? /YMIN[:\s]+(\d+)/.exec(probe.stderr)?.[1] : null;
    if (probe && ymin !== null && Number(ymin) >= 255)
      throw new ImportRefusal("The WebM carries no alpha — the import lane composites transparency; an opaque raster is refused");
    // Gate 4 — frame uniformity + dims (the decode's own PNG headers).
    let first: { width: number; height: number } | null = null;
    const buffers: { name: string; bytes: Buffer }[] = [];
    for (let i = 0; i < names.length; i++) {
      const fb = fs.readFileSync(path.join(tmp, names[i]));
      const v = validateSequenceFrame(fb);
      if (!v.ok) throw new ImportRefusal(`Decoded frame ${i} failed the gates`, v.errors);
      if (first === null) first = { width: v.width, height: v.height };
      else if (v.width !== first.width || v.height !== first.height)
        throw new ImportRefusal("The decode produced non-uniform frames — an ffmpeg bug, refused");
      buffers.push({ name: `f${String(i).padStart(4, "0")}.png`, bytes: fb });
    }
    // The fps snap — the shared-timebase normalization law (D3).
    const probe2 = await execFileP(
      "ffprobe",
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate", "-of", "default=noprint_wrappers=1:nokey=1", src],
      { timeout: 30_000, maxBuffer: 64 * 1024 }
    ).catch(() => null);
    const rate = probe2?.stdout?.trim() ?? "";
    const [num, den] = rate.split("/").map(Number);
    const measured = Number.isFinite(num) && Number.isFinite(den) && den > 0 ? num / den : 24;
    const fps = snapFps(measured);
    await countWallsOrFail(organizationId, videoId);
    const row = await saveImport(
      { id: videoId, organizationId },
      {
        importId,
        layout: "sequence",
        mime: "image/png",
        frames: buffers.length,
        fps,
        frameW: first?.width ?? 0,
        frameH: first?.height ?? 0,
        source: provenance.source,
        license: provenance.license,
      },
      buffers,
      userId
    );
    return NextResponse.json(
      { importId: row.importId, layout: "sequence", frames: buffers.length, fps, frameW: first?.width, frameH: first?.height, bytes: row.bytes, warnings: provenance.warnings },
      { status: 201 }
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });

  const importId = req.nextUrl.searchParams.get("importId")?.trim() ?? "";
  if (!importId)
    return NextResponse.json({ error: "Pass ?importId= of the import to delete" }, { status: 400 });

  const rows = await listVideoImports(id);
  if (!rows.some((r) => r.importId === importId))
    return NextResponse.json({ error: `No import "${importId}" on this video` }, { status: 404 });

  // The reference guard — the current project's sprites must not address
  // this import, or the next render would fail-closed on the missing key.
  const doc = parseGraphicsDoc(video.graphicsDoc);
  const referencingScenes = (doc?.scenes ?? [])
    .filter((s) => s.elements.some((el) => el.sprite?.assetKey === importId))
    .map((s) => s.id);
  if (referencingScenes.length > 0)
    return NextResponse.json(
      { error: `Scenes ${referencingScenes.join(", ")} still reference "${importId}" — remove those sprites before deleting the import` },
      { status: 409 }
    );

  const bytes = rows.find((r) => r.importId === importId)?.bytes ?? 0;
  const deleted = await deleteVideoImport(id, importId);
  if (!deleted)
    return NextResponse.json({ error: `No import "${importId}" on this video` }, { status: 404 });

  // The verification probe names the import's OWN first object — the old
  // probe hardcoded "sheet.png", which is ALWAYS absent for a sequence, so
  // its `verified` flag read true even with every frame still on disk.
  const probeName = importObjectNames(rows.find((r) => r.importId === importId) ?? { layout: "sheet", frames: 1 })[0];
  let verified = false;
  try {
    await get(graphicsImportKey(id, importId, probeName));
  } catch {
    verified = true;
  }
  return NextResponse.json({ ok: true, importId, bytes, verified });
}
