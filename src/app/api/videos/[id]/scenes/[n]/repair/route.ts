// POST /api/videos/[id]/scenes/[n]/repair — S115 (Scene-Level Editing,
// Stage 4): the propose→approve→reject ladder for scene repairs.
//
// THE OPERATOR'S REQUIREMENT D, made executable: estimate → show the
// affected scene → show what regenerates → EXPLICIT approval → enforce the
// budget. No code path in this file generates anything before the approval
// stamps approvedBy — "no silent paid API calls" is the ladder's shape, not
// a policy statement.
//
// Body shapes:
//   { instruction }                        — PROPOSE: estimate + affected
//                                            assets computed and stored; a
//                                            repair row in "proposed"; no
//                                            job, no cost, nothing generated.
//   { repairId, approve: true }            — APPROVE: the ceiling admission
//                                            (402 when the per-project
//                                            ceiling would break), the stamp,
//                                            the IDEMPOTENT enqueue (retrying
//                                            the approval resolves to the
//                                            standing job — approving twice
//                                            cannot spend twice).
//   { repairId, reject: true }             — REJECT: nothing was generated,
//                                            nothing was spent; the estimate
//                                            stays as a record.
//
// GET — the scene's repair feed (newest first): the approval inbox.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { parseScenes } from "@/lib/tubeforge/story";
import {
  proposeSceneRepair,
  approveSceneRepair,
  rejectSceneRepair,
  listSceneRepairs,
} from "@/lib/tubeforge/scene-repairs";
import { CostCeilingExceededError } from "@/lib/tubeforge/cost-guard";

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

  const repairs = await listSceneRepairs(id, index);
  return NextResponse.json({
    repairs: repairs.map((r) => ({
      id: r.id,
      status: r.status,
      origin: r.origin,
      instruction: r.instruction,
      estimateMicroUsd: r.estimateMicroUsd,
      affectedAssets: JSON.parse(r.affectedAssets) as { sceneKeys: string[]; videoRenders: boolean },
      sourceVersion: r.sourceVersion,
      targetVersion: r.targetVersion,
      approvedBy: r.approvedBy,
      approvedAt: r.approvedAt?.toISOString() ?? null,
      jobId: r.jobId,
      note: r.note,
      createdAt: r.createdAt.toISOString(),
    })),
  });
}

export async function POST(req: NextRequest, ctx: Ctx) {
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
  if (!parseScenes(video.scenes).some((s) => s.index === index))
    return NextResponse.json({ error: `Scene ${index} does not exist` }, { status: 404 });

  const body = await req.json().catch(() => null);

  // APPROVE / REJECT arms.
  if (typeof body?.repairId === "string" && body.repairId) {
    if (body.approve === true) {
      let result;
      try {
        result = await approveSceneRepair({
          video,
          repairId: body.repairId,
          userId: auth.ctx.userId,
        });
      } catch (err) {
        if (err instanceof CostCeilingExceededError)
          return NextResponse.json({ error: err.message }, { status: 402 });
        throw err;
      }
      if (!result.ok) return NextResponse.json({ error: result.message }, { status: result.status });
      return NextResponse.json(
        {
          repairId: body.repairId,
          status: "running",
          jobId: result.jobId,
          idempotencyKey: result.idempotencyKey,
          duplicate: result.duplicate,
          target: result.targetHint,
        },
        { status: result.duplicate ? 200 : 202 }
      );
    }
    if (body.reject === true) {
      const result = await rejectSceneRepair({ video, repairId: body.repairId, userId: auth.ctx.userId });
      if (!result.ok) return NextResponse.json({ error: result.message }, { status: 409 });
      return NextResponse.json({ repairId: body.repairId, status: "rejected", message: result.message });
    }
    return NextResponse.json(
      { error: "Send { instruction } to propose, or { repairId, approve: true } / { repairId, reject: true }" },
      { status: 400 }
    );
  }

  // PROPOSE arm.
  const instruction = typeof body?.instruction === "string" ? body.instruction.trim() : "";
  if (instruction.length < 3)
    return NextResponse.json(
      { error: "Describe the repair (at least 3 characters)" },
      { status: 400 }
    );
  if (instruction.length > 500)
    return NextResponse.json(
      { error: "Instruction too long — keep it under 500 characters" },
      { status: 400 }
    );
  const origin =
    body?.origin === "critic" || body?.origin === "vce" ? body.origin : "manual";

  const result = await proposeSceneRepair({
    video,
    sceneIndex: index,
    instruction,
    origin,
    userId: auth.ctx.userId,
  });
  if (!result.ok) return NextResponse.json({ error: result.message }, { status: 404 });

  return NextResponse.json(
    {
      repairId: result.repairId,
      status: "proposed",
      estimateMicroUsd: result.estimateMicroUsd,
      // Requirement D's middle pieces: the affected scene + WHAT REGENERATES,
      // shown BEFORE approval.
      affectedScene: index,
      regenerates: result.affectedAssets,
      sourceVersion: result.sourceVersion,
      approve: { repairId: result.repairId, approve: true },
    },
    { status: 201 }
  );
}
