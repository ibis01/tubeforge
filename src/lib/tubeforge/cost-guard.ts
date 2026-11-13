// cost-guard.ts — S115 / Stage 4 of Scene-Level Editing & Repair: the
// per-project spend ceiling (the operator's requirement D, last piece:
// "enforce remaining budget").
//
// The credit balance gates per-USER spend (billing.ts); this gates per-
// PROJECT spend: Video.spendCeilingMicro (micro-USD, OPT-IN per video — the
// operator decision point resolved to opt-in so existing behavior never
// changes silently). The admission: video-scoped UsageRecord spend (the S113
// bridge columns) + the incoming estimate ≤ ceiling, else 402 — checked in
// the SAME window as the credit hold (before the job is enqueued, so an
// over-ceiling project gets a readable refusal instead of a failed job row).

import type { Video } from "@prisma/client";
import { rawDatabase } from "./tenant-db";

export class CostCeilingExceededError extends Error {
  readonly spentMicroUsd: number;
  readonly ceilingMicroUsd: number;
  readonly estimateMicroUsd: number;
  constructor(spentMicroUsd: number, ceilingMicroUsd: number, estimateMicroUsd: number) {
    super(
      `This project's spend ceiling would be exceeded — spent $${(spentMicroUsd / 1e6).toFixed(2)} of the $${(ceilingMicroUsd / 1e6).toFixed(2)} ceiling, and this action estimates $${(estimateMicroUsd / 1e6).toFixed(2)} more. Raise or remove the ceiling to continue.`
    );
    this.name = "CostCeilingExceededError";
    this.spentMicroUsd = spentMicroUsd;
    this.ceilingMicroUsd = ceilingMicroUsd;
    this.estimateMicroUsd = estimateMicroUsd;
  }
}

/** The video-scoped spend to date (micro-USD): the UsageRecord bridge's
 *  per-video sum. Plain columns — survives video deletion, answers "what
 *  did THIS project cost" (the board's "no per-video attribution" tail
 *  closes here too). */
export async function videoSpendMicroUsd(videoId: string): Promise<number> {
  const rows = await rawDatabase.usageRecord.aggregate({
    where: { videoId },
    _sum: { costMicroUsd: true },
  });
  return rows._sum.costMicroUsd ?? 0;
}

/** The admission. Throws CostCeilingExceededError when the ceiling would be
 *  exceeded; a null ceiling passes (opt-in law). */
export async function assertWithinVideoCeiling(
  video: Pick<Video, "id" | "spendCeilingMicro">,
  estimateMicroUsd: number
): Promise<void> {
  if (video.spendCeilingMicro == null || video.spendCeilingMicro <= 0) return;
  const spent = await videoSpendMicroUsd(video.id);
  if (spent + estimateMicroUsd > video.spendCeilingMicro)
    throw new CostCeilingExceededError(spent, video.spendCeilingMicro, estimateMicroUsd);
}
