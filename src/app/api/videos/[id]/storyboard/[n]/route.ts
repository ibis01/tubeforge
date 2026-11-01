import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { readSceneImage } from "@/lib/tubeforge/story";

type Ctx = { params: Promise<{ id: string; n: string }> };

// Stage 1 (task T-1.12): `n` must be a positive integer — Number("2.5")/NaN
// previously produced nonsense filenames like scene-NaN.png.
const ParamsSchema = z.object({
  id: z.string().min(1),
  n: z.coerce.number().int().positive(),
});

/** GET — stream one storyboard scene image PNG. */
export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const parsed = ParamsSchema.safeParse(await ctx.params);
  if (!parsed.success)
    return NextResponse.json({ error: "Invalid scene index" }, { status: 400 });
  const { id, n } = parsed.data;

  // Scoped lookup FIRST — uploads/<id>/scene-NN.png is only streamed after
  // the row is proven to belong to the caller's organization.
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });

  const image = await readSceneImage(id, n);
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
