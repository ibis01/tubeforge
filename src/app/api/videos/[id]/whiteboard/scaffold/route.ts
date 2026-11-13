import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { parseScenes } from "@/lib/tubeforge/story";
import { validateWhiteboardProject, WB_BUDGETS } from "@/lib/tubeforge/whiteboard/storyboard";
import { scaffoldWhiteboardProject } from "@/lib/tubeforge/whiteboard/whiteboard-planner";
import { parseWhiteboardDoc, serializeWhiteboardDoc } from "@/lib/tubeforge/whiteboard/whiteboard-planner";
import {
  buildPlannerCatalog,
  scaffoldWhiteboardProjectLlm,
  type WhiteboardLlmPlannerReport,
} from "@/lib/tubeforge/whiteboard/llm-planner";
import { invalidateRenderedArtifacts } from "@/lib/tubeforge/render";
import { loadVideoLibrary } from "@/lib/tubeforge/whiteboard/asset-store";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST — the scaffold planner (E9 Phase A / E5):
 *   planner "native" (default) — the ZERO-AI rule-table planner (phase 1):
 *     builds a starter whiteboard project from the video's story scenes —
 *     narration copied per scene, placements from the keyword→library rule
 *     table, default camera, EMPTY event lists (the engine's fill law
 *     schedules the draws at render/playback). $0, deterministic.
 *   planner "llm" — E5 phase 2 (S73): the LLM reads the same scenes and
 *     proposes the concept assets + placements (metered through budget.ts's
 *     choke point; structural cards/camera/fill law stay the engine's). A
 *     gateway failure degrades to the native planner — honestly labeled in
 *     `plannerReport`, never a 500, never an invented board.
 * 409 when a project already exists (`force: true` regenerates — the
 * existing doc is discarded).
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (video.format !== "story")
    return NextResponse.json(
      { error: "Not a scene-based video — whiteboard applies to scene-format videos" },
      { status: 400 }
    );

  const scenes = parseScenes(video.scenes);
  if (scenes.length === 0)
    return NextResponse.json(
      { error: "Video has no scenes — generate the scene script first" },
      { status: 400 }
    );
  if (scenes.length > WB_BUDGETS.scenesPerProject)
    return NextResponse.json(
      { error: `${scenes.length} scenes exceed the ${WB_BUDGETS.scenesPerProject}-scene whiteboard project budget — trim the story first` },
      { status: 400 }
    );

  const body = await req.json().catch(() => ({}));
  const b = (body ?? {}) as Record<string, unknown>;
  const force = b.force === true;
  const planner = b.planner === "llm" ? "llm" : "native";
  const existing = parseWhiteboardDoc(video.whiteboardProject);
  if (existing && !force)
    return NextResponse.json(
      { error: "This video already has a whiteboard project — pass force: true to regenerate from the story" },
      { status: 409 }
    );

  // The merged library loads ONCE, before either planner runs: the LLM
  // planner reads its catalog from the same merge the validator will
  // judge the output against (the S69 one-merge law — model, validator
  // and renderer agree on the asset universe by construction).
  const { lib } = await loadVideoLibrary(id);

  // S68 — optional board geometry (16:9 / 9:16 / 1:1 exports): absent or
  // out-of-band numbers fall back to the house 1920×1080@24 inside the
  // planner (the same clamp grammar the validator applies).
  const sceneInputs = scenes.map((s) => ({
    index: s.index,
    title: s.title,
    narration: s.narration,
  }));

  let project: ReturnType<typeof scaffoldWhiteboardProject>;
  let plannerReport: WhiteboardLlmPlannerReport | undefined = undefined;
  if (planner === "llm") {
    const llm = await scaffoldWhiteboardProjectLlm({
      scenes: sceneInputs,
      topic: video.topic,
      width: typeof b.width === "number" ? b.width : undefined,
      height: typeof b.height === "number" ? b.height : undefined,
      fps: typeof b.fps === "number" ? b.fps : undefined,
      catalog: buildPlannerCatalog(lib.assets.values()),
    });
    project = llm.project;
    plannerReport = llm.report;
  } else {
    project = scaffoldWhiteboardProject({
      scenes: sceneInputs,
      topic: video.topic,
      width: typeof b.width === "number" ? b.width : undefined,
      height: typeof b.height === "number" ? b.height : undefined,
      fps: typeof b.fps === "number" ? b.fps : undefined,
    });
  }

  // Defense in depth: the planner's output passes the same validator any
  // client PUT would — one gate for every doc that lands in the column
  // (S69: against the merged library, uploads included).
  const validated = validateWhiteboardProject(project, lib.libraryIndex);
  if (!validated.project)
    return NextResponse.json(
      { error: "The scaffold produced an invalid project (engine bug — report it)", errors: validated.errors },
      { status: 500 }
    );
  project = validated.project;

  await db.video.update({
    where: { id },
    data: {
      whiteboardProject: serializeWhiteboardDoc({ rev: 1, project }),
      // S119 — scaffolding IS whiteboard intent: pin the lane so the main
      // render button (and every bare caller — replays, auto-pilot) routes
      // to the engine. The row, the doc and the Studio the scaffold came
      // from now agree; a later explicit story mode in the render body
      // flips it back (render-lane.ts, the mode-drift law's admission twin).
      renderMode: "whiteboard",
    },
  });
  // A fresh doc stales whatever the previous doc rendered.
  await invalidateRenderedArtifacts(id);
  await db.video.update({
    where: { id },
    data: { hasVideo: false, videoDuration: null },
  });

  return NextResponse.json({
    rev: 1,
    project,
    planner: plannerReport ? plannerReport.planner : "native",
    ...(plannerReport ? { plannerReport } : {}),
  });
}
