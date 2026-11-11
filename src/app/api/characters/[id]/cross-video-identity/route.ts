import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import {
  parseCrossVideoReport,
  crossVideoReportKey,
  runCrossVideoIdentityCheck,
} from "@/lib/tubeforge/character-identity";
import { normalizeConsistencyCheckMode } from "@/lib/tubeforge/visual-consistency";
import { getUserSetting } from "@/lib/tubeforge/settings";
import { startJob, isJobRunning, lastJobError } from "@/lib/tubeforge/jobs";
import * as storage from "@/lib/tubeforge/storage";

type Ctx = { params: Promise<{ id: string }> };

/**
 * S82 — the cross-video character identity surface (design
 * `docs/design/s77-visual-consistency.md` §8, Phase B slice 5).
 *
 * GET — the persisted report (stored beside the portrait in the
 * character's storage namespace) + the job flags.
 * POST — run the check (202): one batched VLM call judging the
 * character's latest painted host-scene frame from each video that
 * casts them (≤6, newest first) against the character's reference set.
 * Manual-only by design — no auto-chain ever fires it; the
 * consistencyCheck setting's "off" refuses it (the user disabled the
 * quality system, S80's law). Propose, never auto-edit: the report
 * names the drifting videos; fixing them is each video's existing
 * storyboard affordance.
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const { id } = await ctx.params;
  const character = await db.character.findUnique({ where: { id } });
  if (!character)
    return NextResponse.json({ error: "Character not found" }, { status: 404 });

  const stored = await storage.get(crossVideoReportKey(id)).catch(() => null);
  return NextResponse.json({
    report: stored ? parseCrossVideoReport(stored.toString("utf8")) : null,
    generating: isJobRunning(id, "identity"),
    error: lastJobError(id, "identity"),
  });
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const { id } = await ctx.params;
  const character = await db.character.findUnique({ where: { id } });
  if (!character)
    return NextResponse.json({ error: "Character not found" }, { status: 404 });

  // S80's law, inherited: "off" = the user disabled the consistency
  // system — refuse even this manual run. "manual"/"auto" allow it.
  const mode = normalizeConsistencyCheckMode(
    await getUserSetting("consistencyCheck").catch(() => null)
  );
  if (mode === "off")
    return NextResponse.json(
      { error: "Consistency checks are disabled in Settings" },
      { status: 403 }
    );

  const accepted = await startJob(id, "identity", async () => {
    await runCrossVideoIdentityCheck(id);
  });
  return NextResponse.json(
    { accepted, generating: true },
    { status: accepted ? 202 : 200 }
  );
}
