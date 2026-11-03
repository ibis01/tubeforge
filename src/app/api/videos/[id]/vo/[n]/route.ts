import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { readSceneWav } from "@/lib/tubeforge/story";

type Ctx = { params: Promise<{ id: string; n: string }> };

// Same contract as the storyboard/[n] image route — a positive integer.
const ParamsSchema = z.object({
  id: z.string().min(1),
  n: z.coerce.number().int().positive(),
});

/**
 * GET — stream one per-scene voiceover WAV (scene-NN.wav).
 *
 * The Timeline Studio's preview player syncs narration to the playhead with
 * these files: the render's audio graph measures the exact same WAVs, so
 * what the preview plays is what the final mix will say.
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const parsed = ParamsSchema.safeParse(await ctx.params);
  if (!parsed.success)
    return NextResponse.json({ error: "Invalid scene index" }, { status: 400 });
  const { id, n } = parsed.data;

  // Scoped lookup FIRST — the file only streams after the row is proven to
  // belong to the caller's organization (same gate as the scene images).
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });

  const wav = await readSceneWav(id, n);
  if (!wav)
    return NextResponse.json({ error: "Scene voiceover not found" }, { status: 404 });

  return new NextResponse(new Uint8Array(wav), {
    status: 200,
    headers: {
      "Content-Type": "audio/wav",
      "Content-Length": String(wav.length),
      // Immutable per (video, scene) — voiceover regeneration rewrites the
      // file, and the studio's audio pool re-fetches on replay anyway.
      "Cache-Control": "private, max-age=3600",
    },
  });
}
