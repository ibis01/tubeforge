import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import { Readable } from "stream";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { statVideoFile } from "@/lib/tubeforge/render";
import { statShortFile } from "@/lib/tubeforge/shorts";
import { materialize, presign } from "@/lib/tubeforge/storage";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET — stream the rendered MP4 with HTTP Range support so the browser
 * <video> player can seek instantly. ?variant=preview streams preview.mp4,
 * ?variant=short streams the 9:16 vertical Short (Phase 5).
 *
 * Stage 3 (T-3.6, closes D-23): the file streams from disk in bounded
 * chunks — memory is constant per request instead of one full copy per
 * concurrent viewer.
 *
 * Stage 3 (T-3.7, closes D-24): under the s3 driver the route 302-redirects
 * to a presigned object URL so media bytes never transit the app at all —
 * the client downloads straight from the CDN/edge. The tenant check still
 * happens HERE, before the redirect; the signature is unguessable and
 * short-lived (5 min).
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const { id } = await ctx.params;
  // Scoped lookup FIRST — media is only delivered after the row is proven to
  // belong to the caller's organization.
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });

  const variantParam = new URL(req.url).searchParams.get("variant");
  const variant =
    variantParam === "preview"
      ? ("preview" as const)
      : variantParam === "short"
        ? ("short" as const)
        : ("final" as const);

  const media =
    variant === "short"
      ? await statShortFile(id)
      : await statVideoFile(id, variant);
  if (!media)
    return NextResponse.json(
      {
        error:
          variant === "preview"
            ? "No preview rendered yet"
            : variant === "short"
              ? "No Short rendered yet"
              : "No video rendered yet",
      },
      { status: 404 }
    );

  const { key, size: total, fileName } = media;
  const baseHeaders: Record<string, string> = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
  };

  // s3 driver — hand the client a presigned URL; bytes flow CDN→client.
  const signed = await presign(key, 300);
  if (signed) {
    const download = new URL(req.url).searchParams.get("download") === "1";
    return NextResponse.redirect(
      download
        ? `${signed}${signed.includes("?") ? "&" : "?"}response-content-disposition=attachment%3B%20filename%3D%22${encodeURIComponent(fileName)}%22`
        : signed,
      302
    );
  }

  // local driver — bounded-memory Range streaming from the uploads layout.
  const filePath = await materialize(key); // == path under UPLOAD_ROOT locally

  /** Stream [start, end] from disk — the only allocation is the read buffer. */
  const streamRange = (start: number, end: number) =>
    Readable.toWeb(fs.createReadStream(filePath, { start, end })) as unknown as ReadableStream<Uint8Array>;

  // Range request → 206 Partial Content (lets the player seek smoothly)
  const range = req.headers.get("range");
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;

      if (start <= end && start < total) {
        return new NextResponse(streamRange(start, end), {
          status: 206,
          headers: {
            ...baseHeaders,
            "Content-Range": `bytes ${start}-${end}/${total}`,
            "Content-Length": String(end - start + 1),
          },
        });
      }

      return new NextResponse(null, {
        status: 416,
        headers: { ...baseHeaders, "Content-Range": `bytes */${total}` },
      });
    }
  }

  const download = new URL(req.url).searchParams.get("download") === "1";
  return new NextResponse(streamRange(0, total - 1), {
    status: 200,
    headers: {
      ...baseHeaders,
      "Content-Length": String(total),
      ...(download
        ? {
            "Content-Disposition": `attachment; filename="${fileName}"`,
          }
        : {}),
    },
  });
}
