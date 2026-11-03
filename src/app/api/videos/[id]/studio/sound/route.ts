import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
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
import { parseTimeline } from "@/lib/tubeforge/timeline";
import { docMusicPick } from "@/lib/tubeforge/studio-doc";
import { getApprovedAudioMap } from "@/lib/tubeforge/director-plan";
import {
  resolveMusicForVideo,
  trackAbsolutePath,
} from "@/lib/tubeforge/music";
import { droneSource, musicProfileForNiche } from "@/lib/tubeforge/render";
import { videoDir } from "@/lib/tubeforge/ai";

const execFileAsync = promisify(execFile);

/** The music audition's length in seconds — a listen check, not the bed. */
const MUSIC_AUDITION_SEC = 30;

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET — the Timeline Studio's sound-stage audition (S5; S7 adds the music
 * bank). Streams the EXACT wav the render will mix: the cached file
 * ensureSfx / ensureAmbience materialize for the picked kind, synthesized on
 * miss; for `bank=music`, the RESOLVED bed — the library track the render
 * will lay (30 s excerpt, transcoded) or the synthesized niche drone it
 * falls back to, resolved through the SAME chain the render runs
 * (doc pick > plan mood > row pin > settings > auto-match).
 *
 * `?bank=sfx|ambience&kind=whoosh` — BOTH params are validated against the
 * studio-sound catalog BEFORE any ffmpeg/disk work: a hostile param can only
 * ever select a catalog sound, never a path. `?bank=music` takes no kind —
 * it always plays this video's resolved bed (X-Music-Why explains the pick).
 * Auth + tenant + story-format gated like the mix preview; the sfx/ambience
 * wav is deterministic per kind, so the browser may cache it for the session
 * (the music wav is not — the pick rides the doc).
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

  // ---- S7: the music bank — audition the resolved bed ----
  if (params.get("bank") === "music") {
    const docPick = docMusicPick(parseTimeline(video.timeline)?.renderPrefs ?? null);
    if (docPick?.mode === "off")
      return NextResponse.json(
        { error: "The studio pick mutes the music bed for this video" },
        { status: 400 }
      );
    try {
      const planAudio = await getApprovedAudioMap(video.id);
      const resolved = await resolveMusicForVideo(video, planAudio.musicMood, docPick);
      const src = resolved ? trackAbsolutePath(resolved.track) : null;
      const useTrack = src && fs.existsSync(src) ? src : null;
      // Same fallback contract as the render's finalizer: a library track
      // whose file is missing degrades to the synthesized niche drone.
      let why: string;
      if (useTrack && resolved) why = resolved.why;
      else if (resolved) why = "library track file missing — synthesized niche bed";
      else why = "synthesized niche bed (no library match)";

      const tmpDir = path.join(videoDir(video.id), "studio-audition-tmp");
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.mkdirSync(tmpDir, { recursive: true });
      const out = path.join(tmpDir, "music.wav");
      try {
        const args = useTrack
          ? ["-y", "-t", String(MUSIC_AUDITION_SEC), "-i", useTrack, "-vn", "-ac", "2", "-ar", "44100", out]
          : [
              "-y", "-f", "lavfi", "-t", String(MUSIC_AUDITION_SEC),
              "-i", droneSource(musicProfileForNiche(video.niche)),
              "-ac", "2", "-ar", "44100", out,
            ];
        await execFileAsync("ffmpeg", args, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
        if (!fs.existsSync(out)) throw new Error("audition synthesis produced no file");
        const buffer = await fs.promises.readFile(out);
        return new NextResponse(new Uint8Array(buffer), {
          status: 200,
          headers: {
            "Content-Type": "audio/wav",
            "Content-Length": String(buffer.length),
            "Content-Disposition": 'inline; filename="music-audition.wav"',
            // The pick rides the doc — the wav (and its why) change with it.
            "Cache-Control": "no-store",
            "X-Music-Why": encodeURIComponent(why),
          },
        });
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch (err) {
      return NextResponse.json({ error: errorText(err, "Music audition failed") }, { status: 500 });
    }
  }

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
