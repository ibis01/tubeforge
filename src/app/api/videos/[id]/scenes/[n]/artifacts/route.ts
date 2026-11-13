// GET /api/videos/[id]/scenes/[n]/artifacts — S114 (Scene-Level Editing,
// Stage 3): one scene's artifact feed — the provenance rows (image / audio /
// video / preview) with their generation prompts, costs, and the STALE
// LABELS the proposal's risk table demands ("stale preview → display the
// producing version"): every artifact is labeled current / stale / unknown
// against the scene's current head revision, so a client can never mistake
// a pre-edit preview for the scene's present look.
//
// Read-only. Includes the scene-preview file URL (the mp4 route's
// scene-preview variant) for ready previews.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { parseScenes } from "@/lib/tubeforge/story";
import { headRevision } from "@/lib/tubeforge/scene-revisions";
import { sceneArtifactsOf, artifactStaleness } from "@/lib/tubeforge/scene-artifacts";

type Ctx = { params: Promise<{ id: string; n: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const { id, n } = await ctx.params;
  const index = Number(n);
  if (!Number.isInteger(index) || index < 1)
    return NextResponse.json({ error: "A valid scene index is required" }, { status: 400 });

  const video = await db.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (video.format !== "story")
    return NextResponse.json(
      { error: "Not a scene-based video — scene editing applies to scene-format videos" },
      { status: 400 }
    );

  const scene = parseScenes(video.scenes).find((s) => s.index === index);
  if (!scene)
    return NextResponse.json({ error: `Scene ${index} does not exist` }, { status: 404 });

  const [rows, head] = await Promise.all([
    sceneArtifactsOf(id, index),
    scene.id ? headRevision(id, scene.id) : Promise.resolve(null),
  ]);
  const headVersion = head?.version ?? null;

  return NextResponse.json({
    sceneId: scene.id ?? null,
    headVersion,
    artifacts: rows.map((a) => ({
      id: a.id,
      type: a.type,
      status: a.status,
      staleness: artifactStaleness(a, headVersion),
      builtFromRevision: a.revisionVersion,
      storageKey: a.storageKey,
      prompt: a.prompt,
      provider: a.provider,
      model: a.model,
      costMicroUsd: a.costMicroUsd,
      bytes: a.bytes,
      createdAt: a.createdAt.toISOString(),
      // Ready previews stream through the authed mp4 route.
      url:
        a.type === "preview" && a.status === "ready"
          ? `/api/videos/${id}/mp4?variant=scene-preview&n=${index}`
          : null,
    })),
  });
}
