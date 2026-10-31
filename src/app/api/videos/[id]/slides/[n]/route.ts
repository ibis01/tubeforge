import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { readSlideImage } from "@/lib/tubeforge/slides";

type Ctx = { params: Promise<{ id: string; n: string }> };

// Stage 1 (task T-1.12): `n` must be a positive integer.
const ParamsSchema = z.object({
  id: z.string().min(1),
  n: z.coerce.number().int().positive(),
});

/** GET — stream one rendered keynote slide PNG (what viewers see). */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const parsed = ParamsSchema.safeParse(await ctx.params);
  if (!parsed.success)
    return NextResponse.json({ error: "Invalid slide index" }, { status: 400 });
  const { id, n } = parsed.data;

  const image = readSlideImage(id, n);
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
