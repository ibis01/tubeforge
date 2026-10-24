import { NextRequest, NextResponse } from "next/server";
import { readVideoFile } from "@/lib/tubeforge/render";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET — stream the rendered MP4 with HTTP Range support so the browser
 * <video> player can seek instantly. ?variant=preview streams preview.mp4.
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const variant =
    new URL(req.url).searchParams.get("variant") === "preview"
      ? ("preview" as const)
      : ("final" as const);

  const media = readVideoFile(id, variant);
  if (!media)
    return NextResponse.json(
      { error: variant === "preview" ? "No preview rendered yet" : "No video rendered yet" },
      { status: 404 }
    );

  const { buffer, fileName } = media;
  const total = buffer.length;
  const baseHeaders: Record<string, string> = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
  };

  // Range request → 206 Partial Content (lets the player seek smoothly)
  const range = req.headers.get("range");
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1;

      if (start <= end && start < total) {
        const chunk = buffer.subarray(start, end + 1);
        return new NextResponse(new Uint8Array(chunk), {
          status: 206,
          headers: {
            ...baseHeaders,
            "Content-Range": `bytes ${start}-${end}/${total}`,
            "Content-Length": String(chunk.length),
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
  return new NextResponse(new Uint8Array(buffer), {
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
