import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";


/** GET — stream a single A/B variant PNG. */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; style: string }> }
) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const { id, style } = await ctx.params;
  // Scoped lookup FIRST — uploads/<id>/variant-*.png is only streamed after
  // the row is proven to belong to the caller's organization.
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });

  if (!/^[\w-]+$/.test(style))
    return NextResponse.json({ error: "Bad style name" }, { status: 400 });

  const filePath = `variant-${style}.png`; // storage key fragment (T-3.7)
  if (!fs.existsSync(filePath))
    return NextResponse.json({ error: "Variant not found" }, { status: 404 });

  const media = fs.readFileSync(filePath);
  return new NextResponse(new Uint8Array(media), {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(media.length),
      "Cache-Control": "private, max-age=3600",
    },
  });
}
