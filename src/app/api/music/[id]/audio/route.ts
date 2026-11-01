import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { trackAbsolutePath } from "@/lib/tubeforge/music";

type Ctx = { params: Promise<{ id: string }> };

/** GET — stream the track for preview (private, auth-gated by middleware). */
export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const { id } = await ctx.params;
  // Scoped lookup FIRST — the uploads/_music file is only streamed after the
  // row is proven to belong to the caller's organization.
  const track = await db.musicTrack.findUnique({ where: { id } });
  if (!track) return NextResponse.json({ error: "Track not found" }, { status: 404 });

  const abs = trackAbsolutePath(track);
  if (!fs.existsSync(abs))
    return NextResponse.json({ error: "Audio file missing — re-seed the library" }, { status: 410 });

  const stat = fs.statSync(abs);
  const stream = fs.createReadStream(abs) as unknown as ReadableStream;
  return new NextResponse(stream, {
    status: 200,
    headers: {
      "Content-Type": path.extname(abs) === ".flac" ? "audio/flac" : "audio/wav",
      "Content-Length": String(stat.size),
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=86400",
    },
  });
}
