import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { parseScenes, serializeScenes } from "@/lib/tubeforge/story";
import { CAMERAS, sanitizeSceneStyle } from "@/lib/tubeforge/types";
import * as storage from "@/lib/tubeforge/storage";

type Ctx = { params: Promise<{ id: string }> };

/** Artifacts keyed off the OLD narration (Stage 4a, T-4.4 — same semantics as
 *  the script-edit PATCH): the spoken audio no longer matches the text, so
 *  the voiceover, renders, short and the EDITED scene's voice clip die.
 *  Scene art PNGs, stock clips, thumbnails — and every OTHER scene's WAV
 *  (its text did not change, its read is still current) — survive. */
const NARRATION_STALE =
  /\/(voiceover\.wav|voice-source\.\w+|final\.mp4|preview\.mp4|subtitles\.srt|short\.mp4|short-thumb\.png)$/;

/** The edited scene's own artifacts: its read (scene-XX.wav) and its render
 *  intermediate (scene-XX.mp4). Other scenes' files are NOT stale — wiping
 *  them forced the voiceover stage to re-read the whole script (12× the TTS
 *  cost for a one-scene text edit). */
function editedSceneStaleKeys(sceneIndex: number): string[] {
  const nn = String(sceneIndex).padStart(2, "0");
  return [`scene-${nn}.wav`, `scene-${nn}.mp4`];
}

async function invalidateNarrationArtifacts(
  videoId: string,
  sceneIndex: number
): Promise<boolean> {
  const perScene = new Set(editedSceneStaleKeys(sceneIndex));
  try {
    const keys = await storage.list(videoId);
    const stale = keys.filter(
      (k) => NARRATION_STALE.test(k) || perScene.has(k.split("/").pop() ?? "")
    );
    await Promise.all(stale.map((k) => storage.remove(k).catch(() => {})));
    return stale.length > 0;
  } catch {
    return false; // prefix absent — nothing to invalidate
  }
}

/**
 * PATCH — Scene Studio text edits for ONE scene (index-keyed).
 * Body: { index, visual?, mood?, caption?, camera?, style?, narration? }
 *
 * Text-only edits keep the storyboard image and any rendered MP4 valid —
 * EXCEPT narration: the spoken audio is keyed off the old narration text, so
 * a narration edit drops the voiceover + renders (Stage 4a, T-4.4), exactly
 * like a classic script edit does. The response reports `invalidated` so the
 * client can refresh the video DTO's stage flags.
 */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (video.format !== "story")
    return NextResponse.json(
      { error: "Not a scene-based video — scene editing applies to scene-format videos" },
      { status: 400 }
    );

  const body = await req.json().catch(() => null);
  const index = Number(body?.index);
  if (!Number.isInteger(index) || index < 1)
    return NextResponse.json({ error: "A valid scene index is required" }, { status: 400 });

  const scenes = parseScenes(video.scenes);
  const scene = scenes.find((s) => s.index === index);
  if (!scene)
    return NextResponse.json({ error: `Scene ${index} does not exist` }, { status: 404 });

  // Field-by-field validation — every present field must earn its way in.
  let changed = false;
  let narrationChanged = false;

  if (body?.narration !== undefined) {
    const narration = String(body.narration).trim();
    if (narration.length < 3)
      return NextResponse.json({ error: "The narration needs at least 3 characters" }, { status: 400 });
    if (narration.length > 3000)
      return NextResponse.json({ error: "Narration too long — keep it under 3000 characters" }, { status: 400 });
    if (narration !== scene.narration) {
      scene.narration = narration;
      changed = true;
      narrationChanged = true;
    }
  }
  if (body?.visual !== undefined) {
    const visual = String(body.visual).trim();
    if (visual.length < 3)
      return NextResponse.json({ error: "The visual prompt needs at least 3 characters" }, { status: 400 });
    if (visual.length > 1200)
      return NextResponse.json({ error: "Visual prompt too long — keep it under 1200 characters" }, { status: 400 });
    scene.visual = visual;
    changed = true;
  }
  if (body?.mood !== undefined) {
    const mood = String(body.mood).trim().slice(0, 200);
    scene.mood = mood;
    changed = true;
  }
  if (body?.caption !== undefined) {
    scene.caption = String(body.caption).trim().slice(0, 60);
    changed = true;
  }
  if (body?.camera !== undefined) {
    const camera = String(body.camera);
    if (!CAMERAS.some((c) => c.id === camera))
      return NextResponse.json({ error: `Unknown camera move "${camera}"` }, { status: 400 });
    scene.camera = camera;
    changed = true;
  }
  if (body?.style !== undefined) {
    scene.style = sanitizeSceneStyle(body.style);
    changed = true;
  }

  if (!changed)
    return NextResponse.json({ error: "Nothing to update — send at least one scene field" }, { status: 400 });

  const updated = scenes.map((s) => (s.index === index ? scene : s));

  // A narration change makes the spoken audio stale — drop voiceover +
  // renders the same way the classic script edit does (T-4.4).
  let invalidated = false;
  if (narrationChanged && video.hasVoiceover) {
    invalidated = await invalidateNarrationArtifacts(id, index);
    await db.video.update({
      where: { id },
      data: {
        hasVoiceover: false,
        audioDuration: null,
        voiceSource: "tts",
        voiceLabel: null,
        hasVideo: false,
        hasShort: false,
        shortDuration: null,
        shortScene: null,
      },
    });
  }

  await db.video.update({ where: { id }, data: { scenes: JSON.stringify(updated) } });

  return NextResponse.json({
    scene: (await serializeScenes(id, updated)).find((s) => s.index === index) ?? null,
    invalidated,
  });
}
