// POST /api/videos/[id]/storyboard/upload — S118 (Scene-Level Editing,
// Stage 7): the per-scene art-upload route. THE §8.1 DEAD ROUTE, closed:
// both Scene Studio surfaces (scene-editor.tsx, timeline-studio.tsx) have
// POSTed here since Stage 6, and replaceSceneImage (story.ts) has existed
// beside them — but no route ever answered, so the per-scene "upload your
// own art" button 404'd in the live tree (found by the S111
// reconciliation, fixed here).
//
// Body: multipart FormData { scene: <index>, file: <image> } — the exact
// contract the components already send. The upload rides the SAME pipeline
// a re-roll does: sniff/HEIC-decode, the cover-crop geometry, the storage
// seam, S113's scene-scoped invalidation (one scene's art change kills
// only that scene's clip + the video-level renders), the S113 provenance
// registration (type image, the manual-upload row the stage deferred), the
// flags + Activity audit (the §8.2 law — every human-facing mutation
// leaves a row), and the S79 preference-gated targeted consistency
// re-check (an upload IS a repaint).

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { parseScenes, replaceSceneImage, sceneImageFile, storyboardComplete } from "@/lib/tubeforge/story";
import { invalidateRenderedArtifacts } from "@/lib/tubeforge/render";
import { registerSceneArtifact, hashArtifactInput } from "@/lib/tubeforge/scene-artifacts";
import { startJob } from "@/lib/tubeforge/jobs";
import { runConsistencyJob } from "@/lib/tubeforge/video-jobs";
import { normalizeConsistencyCheckMode } from "@/lib/tubeforge/visual-consistency";
import { getUserSetting } from "@/lib/tubeforge/settings";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (video.format !== "story")
    return NextResponse.json(
      { error: "Not a scene-based video — the storyboard applies to scene-format videos" },
      { status: 400 }
    );

  const form = await req.formData().catch(() => null);
  const sceneIndex = Number(form?.get("scene"));
  const file = form?.get("file");
  if (!Number.isInteger(sceneIndex) || sceneIndex < 1)
    return NextResponse.json({ error: "A valid scene index is required" }, { status: 400 });
  if (!(file instanceof File))
    return NextResponse.json({ error: "Attach an image file (PNG, JPEG, WebP or HEIC)" }, { status: 400 });

  const scenes = parseScenes(video.scenes);
  const scene = scenes.find((s) => s.index === sceneIndex);
  if (!scene) return NextResponse.json({ error: `Scene ${sceneIndex} does not exist` }, { status: 404 });

  const upload = Buffer.from(await file.arrayBuffer());

  let bytes: number;
  try {
    bytes = await replaceSceneImage(id, sceneIndex, upload);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Upload failed" },
      { status: 400 }
    );
  }

  // S113 — scene-scoped invalidation: the upload changes ONE scene's art;
  // only that scene's clip + the video-level renders (the union) die. The
  // other scenes' cached clips survive.
  await invalidateRenderedArtifacts(id, { slidePngs: true, sceneIndex });
  await db.video.update({
    where: { id },
    data: {
      hasStoryboard: await storyboardComplete(id, scenes),
      hasVideo: false,
      videoDuration: null,
      error: null,
    },
  });

  // S113's deferred tail, closed: uploads register their provenance too —
  // the artifact row records the manual upload with the head revision it
  // rode (best-effort by the registry's own law).
  await registerSceneArtifact({
    video,
    sceneIndex,
    type: "image",
    storageKey: `${id}/${sceneImageFile(sceneIndex)}`,
    input: `manual-upload|scene=${sceneIndex}|sha256=${await hashArtifactInput(
      upload.toString("base64")
    )}`,
    prompt: `manual upload: ${file.name || "image"}`,
    bytes,
  }).catch(() => {});

  // §8.2 — the audit law: every human-facing mutation leaves a row.
  await db.activity.create({
    data: {
      organizationId: video.organizationId,
      userId: auth.ctx.userId,
      videoId: id,
      stage: "storyboard",
      message: `Scene ${sceneIndex} "${scene.title}" art uploaded (${Math.round(bytes / 1024)} KB) — renders rebuilt for that scene`,
    },
  });

  // S79 — the preference-gated targeted re-check: an upload IS a repaint;
  // every verdict that judged the OLD art is obsolete for this scene.
  const checkMode = normalizeConsistencyCheckMode(
    await getUserSetting("consistencyCheck").catch(() => null)
  );
  if (checkMode === "auto") {
    await startJob(id, "consistency", () => runConsistencyJob(id, "repaint", sceneIndex), {
      payload: { sceneIndex },
    }).catch(() => {
      /* fail-open — the manual Check button is the fallback */
    });
  }

  return NextResponse.json({ ok: true, scene: sceneIndex, bytes });
}
