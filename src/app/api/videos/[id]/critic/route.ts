import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import {
  parseCriticReport,
  criticReportKey,
  runVideoCritic,
} from "@/lib/tubeforge/video-critic";
import { normalizeConsistencyCheckMode } from "@/lib/tubeforge/visual-consistency";
import { getUserSetting } from "@/lib/tubeforge/settings";
import { startJob, isJobRunning, lastJobError } from "@/lib/tubeforge/jobs";
import * as storage from "@/lib/tubeforge/storage";

type Ctx = { params: Promise<{ id: string }> };

/**
 * S84 — the Video Critic's surface (docs/audits/
 * s76-openmontage-adoption-decision.md §4.B).
 *
 * GET — the persisted report (the video's storage namespace) + the job
 * flags.
 * POST — run the critic (202): the deterministic rows from the stored
 * QC battery report (technical / motion / audio / text-artifacts), the
 * consistency row from the stored VCE report, and ONE fail-open VLM
 * call judging narrative + visual quality over frames sampled evenly
 * from final.mp4. Repair proposals map every hold to an action through
 * the EXISTING affordances — propose, never auto-edit. The ship gate
 * stays qc-policy's; the critic's verdict is a report for the human.
 * Manual-only by design; the consistencyCheck setting's "off" refuses
 * it (S80's law — the user disabled the quality system).
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const { id } = await ctx.params;
  const video = await db.video.findUnique({
    where: { id },
    select: { id: true, format: true },
  });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });

  const stored = await storage.get(criticReportKey(id)).catch(() => null);
  return NextResponse.json({
    critic: stored ? parseCriticReport(stored.toString("utf8")) : null,
    generating: isJobRunning(id, "critic"),
    error: lastJobError(id, "critic"),
  });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (video.format !== "story")
    return NextResponse.json(
      { error: "Not a scene-based video — the critic judges rendered scene-format cuts" },
      { status: 400 }
    );

  // S80's law, inherited: "off" = the quality system is disabled.
  const mode = normalizeConsistencyCheckMode(
    await getUserSetting("consistencyCheck").catch(() => null)
  );
  if (mode === "off")
    return NextResponse.json(
      { error: "Quality checks are disabled in Settings" },
      { status: 403 }
    );

  const accepted = await startJob(id, "critic", async () => {
    await runVideoCritic(id);
  });
  return NextResponse.json(
    { accepted, generating: true },
    { status: accepted ? 202 : 200 }
  );
}
