import { NextRequest, NextResponse } from "next/server";
import { readSceneImage } from "@/lib/tubeforge/story";

type Ctx = { params: Promise<{ id: string; n: string }> };

/** GET — stream one storyboard scene image PNG. */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id, n } = await ctx.params;
  const image = readSceneImage(id, Number(n));
  if (!image)
    return NextResponse.json({ error: "Scene image not found" }, { status: 404 });

  return new NextResponse(new Uint8Array(image), {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(image.length),
      "Cache-Control": "private, max-age=3600",
    },
  });
}
