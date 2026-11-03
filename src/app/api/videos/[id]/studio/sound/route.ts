import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { errorText } from "@/lib/tubeforge/redact";
import { ensureSfx } from "@/lib/tubeforge/sfx";
import { ensureAmbience } from "@/lib/tubeforge/ambience";
import {
  resolveSoundBank,
  sanitizeSfxKind,
  sanitizeAmbienceKind,
} from "@/lib/tubeforge/studio-sound";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET — the Timeline Studio's sound-stage audition (S5). Streams the EXACT
 * synthesized wav the render will mix: the cached file ensureSfx /
 * ensureAmbience materialize for the picked kind, synthesized on miss.
 *
 * `?bank=sfx|ambience&kind=whoosh` — BOTH params are validated against the
 * studio-sound catalog BEFORE any ffmpeg/disk work: a hostile param can only
 * ever select a catalog sound, never a path. Auth + tenant + story-format
 * gated like the mix preview; the wav itself is deterministic per kind, so
 * the browser may cache it for the session.
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler closures

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (video.format !== "story")
    return NextResponse.json(
      { error: "Sound auditions apply to scene-based videos" },
      { status: 400 }
    );

  const params = new URL(req.url).searchParams;
  const bank = resolveSoundBank(params.get("bank"));
  if (!bank) return NextResponse.json({ error: "Unknown sound bank" }, { status: 400 });
  const kind =
    bank === "sfx"
      ? sanitizeSfxKind(params.get("kind"))
      : sanitizeAmbienceKind(params.get("kind"));
  if (!kind) return NextResponse.json({ error: "Unknown sound" }, { status: 400 });

  try {
    const path = bank === "sfx" ? await ensureSfx(kind) : await ensureAmbience(kind);
    if (!path || !fs.existsSync(path))
      return NextResponse.json({ error: "Sound synthesis failed" }, { status: 503 });
    const buffer = await fs.promises.readFile(path);
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type": "audio/wav",
        "Content-Length": String(buffer.length),
        "Content-Disposition": `inline; filename="${bank}-${kind}.wav"`,
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (err) {
    return NextResponse.json({ error: errorText(err, "Sound audition failed") }, { status: 500 });
  }
}

export const dynamic = "force-dynamic";
