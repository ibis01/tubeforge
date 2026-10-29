import { NextRequest, NextResponse } from "next/server";
import { readSlideImage } from "@/lib/tubeforge/slides";

type Ctx = { params: Promise<{ id: string; n: string }> };

/** GET — stream one rendered keynote slide PNG (what viewers see). */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id, n } = await ctx.params;
  const image = readSlideImage(id, Number(n));
  if (!image)
    return NextResponse.json({ error: "Slide image not found — render the deck first" }, { status: 404 });

  return new NextResponse(new Uint8Array(image), {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(image.length),
      "Cache-Control": "private, no-cache",
    },
  });
}
