// scene-repairs.ts — S115 / Stage 4: the durable repair record + the
// propose→approve→run ladder (the operator's requirement D: "estimate → show
// affected scene → show what regenerates → explicit approval → enforce
// budget; no silent paid API calls").
//
// The S84 critic and the S77 Visual Consistency Engine already emit per-scene
// repair PROPOSALS with ready instruction strings — as ephemeral report JSON
// the one-click lane (S86) fires immediately. This module persists those
// proposals (or freeform instructions) with the ESTIMATE (the live
// per-capability estimators), the AFFECTED-ASSET LIST (Stage 2's dependency
// map — exactly what regenerates), and the approval stamp — and enqueues the
// scene job IDEMPOTENTLY (retrying an approval can never double-bill).
//
// THE LADDER:
//   propose  — estimate + affected assets computed and STORED; no job, no
//              cost, nothing generated. The human sees the numbers.
//   approve  — the ceiling admission (cost-guard), the approvedBy stamp, the
//              idempotent enqueue. Only this step can spend.
//   reject   — the human said no; the estimate stays as a record.
//
// Origin vocabulary: "critic" | "vce" (the two proposal engines) | "manual".

import crypto from "node:crypto";
import type { Video } from "@prisma/client";
import { db } from "./tenant-db";
import { parseScenes } from "./story";
import { headRevision } from "./scene-revisions";
import { planSceneInvalidation, type InvalidationPlan } from "./scene-deps";
import { ESTIMATED_COST_MICRO } from "./billing";
import { assertWithinVideoCeiling, CostCeilingExceededError } from "./cost-guard";
import { startJob } from "./jobs";
import { runSceneJob } from "./video-jobs";
import { log } from "./log";

const repairLog = log.child({ mod: "scene-repairs" });

/** A repair regenerates the art take (seedVariant bump) — and in an animated
 *  render the clip follows. The estimate uses the SAME per-capability table
 *  the credit gate uses (billing.ESTIMATED_COST_MICRO), so the number the
 *  human approves is the number the admission enforces. */
export function repairEstimateMicroUsd(mode: string): number {
  return ESTIMATED_COST_MICRO.image + (mode === "animated" ? ESTIMATED_COST_MICRO.video : 0);
}

/** What a repair regenerates + what it invalidates (Stage 2's map, folded
 *  for the seedVariant field — the repair's own blast radius, shown to the
 *  human BEFORE approval). */
export function repairPlan(videoId: string, sceneIndex: number): InvalidationPlan {
  return planSceneInvalidation(videoId, sceneIndex, ["seedVariant"]);
}

/** The idempotency key for a repair's job: deterministic per (repair, video
 *  row state) — approving twice or retrying the approval resolves to the
 *  same key; ANY content change (updatedAt moves) mints a fresh one. */
export function repairIdempotencyKey(
  videoId: string,
  sceneIndex: number,
  repairId: string,
  videoUpdatedAt: Date
): string {
  return `repair:${videoId}:s${sceneIndex}:${repairId}:${videoUpdatedAt.getTime()}`;
}

export type ProposeResult =
  | { ok: false; message: string }
  | {
      ok: true;
      repairId: string;
      estimateMicroUsd: number;
      affectedAssets: { sceneKeys: string[]; videoRenders: boolean };
      sourceVersion: number | null;
    };

/** PROPOSE — the estimate-and-show step. Persists the proposal; generates
 *  nothing; costs nothing. */
export async function proposeSceneRepair(input: {
  video: Video;
  sceneIndex: number;
  instruction: string;
  origin?: "critic" | "vce" | "manual";
  note?: string | null;
  userId?: string | null;
}): Promise<ProposeResult> {
  const scene = parseScenes(input.video.scenes).find((s) => s.index === input.sceneIndex);
  if (!scene)
    return { ok: false, message: `Scene ${input.sceneIndex} does not exist` };
  const head = scene.id ? await headRevision(input.video.id, scene.id) : null;
  const plan = repairPlan(input.video.id, input.sceneIndex);
  const estimate = repairEstimateMicroUsd(input.video.renderMode);
  const row = await db.sceneRepair.create({
    data: {
      organizationId: input.video.organizationId,
      videoId: input.video.id,
      sceneId: scene.id ?? null,
      sceneIndex: input.sceneIndex,
      sourceVersion: head?.version ?? 0,
      instruction: input.instruction,
      origin: input.origin ?? "manual",
      estimateMicroUsd: estimate,
      affectedAssets: JSON.stringify({
        sceneKeys: plan.sceneKeys,
        videoRenders: plan.videoRenders,
      }),
      status: "proposed",
      note: input.note ?? null,
    },
  });
  return {
    ok: true,
    repairId: row.id,
    estimateMicroUsd: estimate,
    affectedAssets: { sceneKeys: plan.sceneKeys, videoRenders: plan.videoRenders },
    sourceVersion: head?.version ?? null,
  };
}

export type ApproveResult =
  | { ok: false; status: number; message: string }
  | {
      ok: true;
      jobId: string | null;
      idempotencyKey: string;
      duplicate: boolean;
      targetHint: string;
    };

/** APPROVE — the only step that can spend. Ceiling admission → stamp →
 *  idempotent enqueue. A repair that is not in the proposed state refuses
 *  (double-approve cannot double-spend); the enqueue key makes the retry of
 *  an APPROVED repair resolve to the standing job. */
export async function approveSceneRepair(input: {
  video: Video;
  repairId: string;
  userId?: string | null;
}): Promise<ApproveResult> {
  const repair = await db.sceneRepair.findUnique({ where: { id: input.repairId } });
  if (!repair || repair.videoId !== input.video.id)
    return { ok: false, status: 404, message: "Repair proposal not found" };
  if (repair.status === "running" || repair.status === "completed")
    return {
      ok: false,
      status: 409,
      message: `This repair is already ${repair.status} — approving twice cannot spend twice`,
    };
  if (repair.status === "rejected")
    return { ok: false, status: 409, message: "This repair was rejected — propose a new one" };

  // The ceiling admission — the same window as the credit hold, before the
  // job exists, so an over-ceiling project gets a 402 not a failed row.
  try {
    await assertWithinVideoCeiling(input.video, repair.estimateMicroUsd);
  } catch (err) {
    if (err instanceof CostCeilingExceededError)
      return { ok: false, status: 402, message: err.message };
    throw err;
  }

  const key = repairIdempotencyKey(
    input.video.id,
    repair.sceneIndex,
    repair.id,
    input.video.updatedAt
  );
  const entity = `${input.video.id}#scene${repair.sceneIndex}`;

  const accepted = await startJob(
    entity,
    "scene",
    () =>
      runSceneJob(entity, { sceneIndex: repair.sceneIndex, instruction: repair.instruction }).then(
        async () => {
          // The repair's record settles with its job (best-effort).
          await settleSceneRepair(input.video.id, repair.sceneIndex, key, { status: "completed" });
        },
        async (err: unknown) => {
          await settleSceneRepair(input.video.id, repair.sceneIndex, key, {
            status: "failed",
            note: err instanceof Error ? err.message.slice(0, 200) : "repair job failed",
          });
          throw err;
        }
      ),
    { payload: { sceneIndex: repair.sceneIndex, instruction: repair.instruction }, idempotencyKey: key }
  );

  const job = await db.job.findUnique({ where: { idempotencyKey: key } });
  await db.sceneRepair.update({
    where: { id: repair.id },
    data: {
      status: "running",
      approvedBy: input.userId ?? null,
      approvedAt: new Date(),
      jobId: job?.id ?? null,
      idempotencyKey: key,
    },
  });

  return {
    ok: true,
    jobId: job?.id ?? null,
    idempotencyKey: key,
    duplicate: !accepted,
    targetHint: `Repairing scene ${repair.sceneIndex} (v${repair.sourceVersion}) — ${repair.instruction.slice(0, 120)}`,
  };
}

/** REJECT — the human said no; the estimate stays as a record. */
export async function rejectSceneRepair(input: {
  video: Video;
  repairId: string;
  userId?: string | null;
}): Promise<{ ok: boolean; message: string }> {
  const repair = await db.sceneRepair.findUnique({ where: { id: input.repairId } });
  if (!repair || repair.videoId !== input.video.id)
    return { ok: false, message: "Repair proposal not found" };
  if (repair.status !== "proposed")
    return { ok: false, message: `Only a proposed repair can be rejected (this one is ${repair.status})` };
  await db.sceneRepair.update({
    where: { id: repair.id },
    data: { status: "rejected", approvedBy: input.userId ?? null, approvedAt: new Date() },
  });
  return { ok: true, message: "Repair rejected — nothing was generated, nothing was spent" };
}

/** The repair feed for one scene (newest first) — the approval UI's inbox. */
export async function listSceneRepairs(videoId: string, sceneIndex: number) {
  return db.sceneRepair.findMany({
    where: { videoId, sceneIndex },
    orderBy: { createdAt: "desc" },
  });
}

/** Mark a running repair completed/failed from the job lane (approve's
 * closure calls this when runSceneJob settles). The completed row records
 * targetVersion = the scene's head after the repair — the revision the
 * repair produced. Best-effort — the repair row is a record, never a
 * pipeline dependency. */
export async function settleSceneRepair(
  videoId: string,
  sceneIndex: number,
  idempotencyKey: string,
  outcome: { status: "completed" | "failed"; note?: string }
): Promise<void> {
  try {
    const repair = await db.sceneRepair.findFirst({
      where: { videoId, sceneIndex, idempotencyKey },
    });
    if (!repair || repair.status !== "running") return;
    let targetVersion: number | null = null;
    if (outcome.status === "completed" && repair.sceneId) {
      const head = await headRevision(videoId, repair.sceneId);
      targetVersion = head?.version ?? null;
    }
    await db.sceneRepair.update({
      where: { id: repair.id },
      data: {
        status: outcome.status,
        targetVersion,
        ...(outcome.note ? { note: outcome.note } : {}),
      },
    });
  } catch (err) {
    repairLog.warn("repair settle failed (record-keeping only)", {
      videoId,
      sceneIndex,
      err: err instanceof Error ? err.message : err,
    });
  }
}

/** Stable input digest for idempotency keys that carry content identity. */
export function digestOf(input: string): string {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex").slice(0, 16);
}
