import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { generateStoryboard, generateSceneImage, editSceneImage, serializeScenes, storyboardComplete, parseScenes } from "@/lib/tubeforge/story";
import { startJob, isJobRunning, isJobCancelled, lastJobError, setJobProgress, JobCancelledError } from "@/lib/tubeforge/jobs";
import { errorText } from "@/lib/tubeforge/redact";
import { invalidateRenderedArtifacts } from "@/lib/tubeforge/render";

type Ctx = { params: Promise<{ id: string }> };

/** GET — the storyboard (scene list with image availability + per-scene job flags). */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (video.format !== "story")
    return NextResponse.json({ error: "Not a scene-based video" }, { status: 400 });

  const scenes = parseScenes(video.scenes);
  return NextResponse.json({
    scenes: serializeScenes(id, scenes),
    complete: storyboardComplete(id, scenes),
    generating: isJobRunning(id, "storyboard"),
    error: lastJobError(id, "storyboard"),
  });
}

/**
 * POST — generate the storyboard as a background job (202).
 * Body: {} for the full storyboard, { scene: n } to re-roll one scene from
 * its (Scene Studio-edited) prompt, or { scene: n, instruction: "..." } to
 * AI-edit the EXISTING scene image in place ("make it night", "warmer light").
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (video.format !== "story")
    return NextResponse.json(
      { error: "Not a scene-based video — the storyboard applies to scene-format videos" },
      { status: 400 }
    );

  const scenes = parseScenes(video.scenes);
  if (scenes.length === 0)
    return NextResponse.json(
      { error: "Video has no scenes — generate the scene script first" },
      { status: 400 }
    );

  const body = await req.json().catch(() => ({}));
  const sceneIndex = Number(body?.scene);

  const character = video.characterId
    ? await db.character.findUnique({ where: { id: video.characterId } })
    : null;

  const castOpts = character
    ? {
        id: character.id,
        name: character.name,
        identityAnchor: character.identityAnchor,
        appearance: character.appearance,
      }
    : null;

  // Clear any stale error before the job starts.
  await db.video.update({ where: { id }, data: { error: null } });

  if (Number.isInteger(sceneIndex) && sceneIndex >= 1) {
    // Single-scene re-roll OR instruction-based AI edit of the current image.
    const scene = scenes.find((s) => s.index === sceneIndex);
    if (!scene)
      return NextResponse.json({ error: `Scene ${sceneIndex} does not exist` }, { status: 400 });

    const instruction =
      typeof body?.instruction === "string" ? body.instruction.trim() : "";
    if (instruction && instruction.length > 500)
      return NextResponse.json(
        { error: "Instruction too long — keep it under 500 characters" },
        { status: 400 }
      );
    const mode = instruction ? "edit" : "reroll";

    const jobKey = `${id}#scene${sceneIndex}`;
    const accepted = await startJob(jobKey, "scene", async () => {
      try {
        if (mode === "edit") {
          await editSceneImage({ videoId: id, scene, instruction });
        } else {
          // Re-roll = a NEW take: bump the scene's generation counter BEFORE
          // painting so the pinned seed (identity locking on text-to-image
          // providers) yields a fresh image instead of the same pixels, then
          // persist the bump — a later resume must not reuse the old take.
          scene.seedVariant = Math.min((scene.seedVariant ?? 0) + 1, 999);
          await db.video.update({
            where: { id },
            data: { scenes: JSON.stringify(scenes) },
          });
          await generateSceneImage({ videoId: id, scene, character: castOpts });
        }
        invalidateRenderedArtifacts(id, { slidePngs: true });
        await db.video.update({
          where: { id },
          data: {
            hasStoryboard: storyboardComplete(id, scenes),
            hasVideo: false,
            videoDuration: null,
            error: null,
          },
        });
        await db.activity.create({
          data: {
            videoId: id,
            stage: "storyboard",
            message:
              mode === "edit"
                ? `Scene ${sceneIndex} "${scene.title}" AI-edited: ${instruction.slice(0, 80)}`
                : `Scene ${sceneIndex} "${scene.title}" re-rolled`,
          },
        });
      } catch (err) {
        const message = errorText(err, "Scene edit failed");
        await db.video.update({ where: { id }, data: { error: message } });
        await db.activity.create({
          data: {
            videoId: id,
            stage: "storyboard",
            level: "error",
            message: `Scene ${sceneIndex} ${mode === "edit" ? "edit" : "re-roll"} failed: ${message}`,
          },
        });
        // Re-thrown so startJob records the failure for GET polling + history.
        throw err;
      }
    });

    return NextResponse.json(
      { accepted, generating: true, mode },
      { status: accepted ? 202 : 200 }
    );
  }

  // Full storyboard
  const accepted = await startJob(id, "storyboard", async () => {
    try {
      await generateStoryboard({
        videoId: id,
        scenes,
        character: castOpts,
        shouldCancel: () => isJobCancelled(id, "storyboard"),
        onSceneDone: (i, total) =>
          setJobProgress(id, "storyboard", i + 1, total, `Painting scene ${i + 1} of ${total}`),
      });

      invalidateRenderedArtifacts(id, { slidePngs: true });
      await db.video.update({
        where: { id },
        data: {
          hasStoryboard: true,
          hasVideo: false,
          videoDuration: null,
          error: null,
        },
      });
      await db.activity.create({
        data: {
          videoId: id,
          stage: "storyboard",
          message: `Storyboard painted — ${scenes.length} scenes${character ? ` (host: ${character.name})` : ""}`,
        },
      });
    } catch (err) {
      if (err instanceof Error && err.message === "__CANCELLED__") {
        await db.video.update({
          where: { id },
          data: {
            hasStoryboard: storyboardComplete(id, scenes),
            error: null,
          },
        });
        await db.activity.create({
          data: {
            videoId: id,
            stage: "storyboard",
            message: `Storyboard cancelled — finished scenes were kept`,
          },
        });
        throw new JobCancelledError();
      }
      const message = errorText(err, "Storyboard failed");
      await db.video.update({
        where: { id },
        data: {
          hasStoryboard: storyboardComplete(id, scenes),
          error: message,
        },
      });
      await db.activity.create({
        data: {
          videoId: id,
          stage: "storyboard",
          level: "error",
          message: `Storyboard failed: ${message}`,
        },
      });
      // Re-thrown so startJob records the failure for GET polling + history.
      throw err;
    }
  });

  return NextResponse.json(
    { accepted, generating: true },
    { status: accepted ? 202 : 200 }
  );
}
