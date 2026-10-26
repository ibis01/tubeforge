import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const UPLOAD_ROOT = path.join(process.cwd(), "uploads");

/** GET — stream a single A/B variant PNG. */
export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string; style: string }> }
) {
  const { id, style } = await ctx.params;
  if (!/^[\w-]+$/.test(style))
    return NextResponse.json({ error: "Bad style name" }, { status: 400 });

  const filePath = path.join(UPLOAD_ROOT, id, `variant-${style}.png`);
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
