import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { videoDir } from "@/lib/tubeforge/ai";
import { sceneWavFile } from "@/lib/tubeforge/story";
import { wavDurationSec } from "@/lib/tubeforge/wav";
import { validateWhiteboardProject, WB_BUDGETS } from "@/lib/tubeforge/whiteboard/storyboard";
import { WB_PATH_COMMAND_BUDGET } from "@/lib/tubeforge/whiteboard/assets";
import { WB_RENDER_FRAME_BUDGET } from "@/lib/tubeforge/whiteboard/timing";
import {
  parseWhiteboardDoc,
  serializeWhiteboardDoc,
} from "@/lib/tubeforge/whiteboard/whiteboard-planner";
import { invalidateRenderedArtifacts } from "@/lib/tubeforge/render";
import { loadVideoLibrary } from "@/lib/tubeforge/whiteboard/asset-store";

type Ctx = { params: Promise<{ id: string }> };

/**
 * S67 — the Whiteboard Engine's document routes (E9 Phase A, E1 design §4).
 *
 * GET  — the doc (validated server-side before return), the editor palette
 *        (asset ids, viewBoxes, tags, drawable summaries — NOT raw SVG for
 *        the built-ins, which ride the client bundle) and the resource
 *        budgets for client-side enforcement. S68: the MEASURED narration
 *        durations (`voMs`, WAV header math on the standing scene-NN.wav
 *        files — the same files the render's voFilesFor picks up) so the
 *        editor's playback timing agrees with the render instead of riding
 *        the narration estimate whenever a real VO exists. S69 (Phase C):
 *        the palette merges this video's UPLOADED assets — uploads carry
 *        their sanitized `svg` over the wire (they cannot ride the bundle)
 *        plus provenance; the doc validates against the SAME merged
 *        library (one merge law, editor and renderer).
 * PUT  — save the whole doc. Validation is the engine validator against
 *        the merged library; its error strings are returned verbatim (no
 *        second error vocabulary). 409 on a rev mismatch with the current
 *        doc in the response. A save invalidates the stale renders exactly
 *        the way slide edits do.
 */

export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (video.format !== "story")
    return NextResponse.json({ error: "Not a scene-based video" }, { status: 400 });

  const doc = parseWhiteboardDoc(video.whiteboardProject);
  let project = doc?.project ?? null;
  // S69 — the ONE merged library: built-ins + this video's uploads.
  const { lib, uploads, uploadedAssets } = await loadVideoLibrary(id);
  if (project) {
    // Server-side validation before return: a doc the live library can no
    // longer satisfy (an asset renamed, a path gone) reads as "no project"
    // rather than poisoning the editor with an unrenderable one.
    const validated = validateWhiteboardProject(project, lib.libraryIndex);
    project = validated.project;
  }

  // The editor palette: ids + geometry + drawables. Built-ins never ship
  // raw markup (the client bundle carries the library); UPLOADED assets
  // ride the wire — sanitized fragment + viewBox + provenance — because
  // the bundle cannot know them (E9 Phase C).
  const library = [...lib.assets.values()].map((a) => {
    const ex = lib.extracted.get(a.id);
    const upload = uploadedAssets.get(a.id);
    const row = uploads.find((r) => r.assetId === a.id);
    return {
      id: a.id,
      w: a.viewBox.w,
      h: a.viewBox.h,
      tags: a.tags,
      paths: ex ? ex.paths.map((p) => p.id) : [],
      texts: ex ? ex.texts.map((t) => t.id) : [],
      ...(upload
        ? {
            uploaded: true as const,
            svg: upload.svg,
            bytes: row?.bytes ?? 0,
            uploadedBy: row?.uploadedBy ?? "",
          }
        : {}),
    };
  });

  // S68 — measured narration per scene (WAV header math; the render's
  // ffprobe reports the same duration for the PCM WAVs the TTS lane writes).
  // Only `scene-<n>` ids map to the WAV layout — hand-authored scene ids
  // ride the narration estimate, exactly like the render (one mapping law).
  const voMs: Record<string, number> = {};
  if (project) {
    const dir = videoDir(id);
    for (const scene of project.scenes) {
      const m = /^scene-(\d+)$/.exec(scene.id);
      if (!m) continue;
      const index = Number(m[1]);
      if (!Number.isInteger(index) || index < 1 || index > 999) continue;
      const wav = path.join(dir, sceneWavFile(index));
      if (!fs.existsSync(wav)) continue;
      try {
        const sec = wavDurationSec(fs.readFileSync(wav));
        if (sec > 0) voMs[scene.id] = Math.round(sec * 1000);
      } catch {
        /* unreadable/odd header → the scene rides the estimate */
      }
    }
  }

  return NextResponse.json({
    project,
    rev: doc?.rev ?? 0,
    library,
    voMs,
    budgets: {
      ...WB_BUDGETS,
      pathCommandsPerPath: WB_PATH_COMMAND_BUDGET,
      renderFrames: WB_RENDER_FRAME_BUDGET,
    },
  });
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (video.format !== "story")
    return NextResponse.json({ error: "Not a scene-based video" }, { status: 400 });

  const body = await req.json().catch(() => null);
  const rawProject = (body as Record<string, unknown> | null)?.project;
  if (!rawProject)
    return NextResponse.json({ error: "A whiteboard project is required" }, { status: 400 });

  // The engine validator — against the merged library (built-ins + this
  // video's uploads); its error strings go back verbatim (design §4).
  const { lib } = await loadVideoLibrary(id);
  const { project, errors } = validateWhiteboardProject(rawProject, lib.libraryIndex);
  if (!project)
    return NextResponse.json({ errors }, { status: 400 });

  // Advisory concurrency: the editor echoes the rev it read; a mismatch
  // returns 409 WITH the server's current doc so the editor can offer a
  // diff. LWW stays the final law — rev is UX, not a guarantee (design §2.1).
  const current = parseWhiteboardDoc(video.whiteboardProject);
  const bodyRev = (body as Record<string, unknown> | null)?.rev;
  if (
    current &&
    typeof bodyRev === "number" &&
    Number.isInteger(bodyRev) &&
    bodyRev !== current.rev
  ) {
    return NextResponse.json(
      {
        error: `This whiteboard changed under you — server rev ${current.rev}, you saved against ${bodyRev}`,
        current: { rev: current.rev, project: current.project },
      },
      { status: 409 }
    );
  }

  const rev = (current?.rev ?? 0) + 1;
  await db.video.update({
    where: { id },
    data: { whiteboardProject: serializeWhiteboardDoc({ rev, project }) },
  });

  // A project edit stales the rendered artifacts (design §2.3) — same
  // invalidation discipline as every other visual mutation.
  await invalidateRenderedArtifacts(id);
  await db.video.update({
    where: { id },
    data: { hasVideo: false, videoDuration: null },
  });

  return NextResponse.json({ rev, project });
}
