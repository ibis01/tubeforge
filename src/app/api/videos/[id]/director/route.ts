import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { startJob, isJobRunning, lastJobError } from "@/lib/tubeforge/jobs";
import { runDirectorJob, runConsistencyJob } from "@/lib/tubeforge/video-jobs";
import {
  parsePlan,
  parseConsistency,
  setDirectorState,
  type DirectorState,
} from "@/lib/tubeforge/director";
import {
  profilePickerList,
  planProfileNotes,
} from "@/lib/tubeforge/production-profiles";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET — the AI Director panel state for one video:
 *   plan        (parsed DirectorPlan | null), state (proposed|approved|dismissed|null),
 *   consistency (VLM ContinuityReport | null), generating flags + last errors.
 *   S52 — the themed-profiles surface: `profiles` (the picker catalog, in
 *   catalog order — the same keys `resolveProfile` snaps against),
 *   `contentPolicy` (the video's policy column — the one truth the islamic-
 *   history picker advisory reads), and `profileNotes` (the authoring
 *   profile's validation findings for THIS plan, evaluated live — the
 *   approval card's "no silent creative decisions" surface).
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });

  const plan = parsePlan(video.shotList);
  return NextResponse.json({
    plan,
    state: (video.directorState as DirectorState | null) ?? null,
    consistency: parseConsistency(video.consistency),
    profiles: profilePickerList(),
    contentPolicy: video.contentPolicy ?? null,
    profileNotes: plan ? planProfileNotes(plan) : [],
    generating: {
      plan: isJobRunning(id, "director"),
      check: isJobRunning(id, "continuity"),
    },
    error: {
      plan: lastJobError(id, "director"),
      check: lastJobError(id, "continuity"),
    },
    videoError: video.error,
  });
}

/**
 * POST — start a director job (202). Body: { action: "plan" } (LLM shot-list
 * pass) or { action: "check" } (VLM continuity check). The job bodies are the
 * SAME functions the durable queue's crash-recovery handler runs.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });
  // M1 — the format !== "story" 400 is GONE. The director pass errors on
  // empty scenes (a non-scene video has nothing to direct); the route
  // surfaces that identical error from runDirectorPass. A `profile`
  // request param selects a production profile (default narrative).

  const body = await req.json().catch(() => ({}));
  const action = body?.action === "check" ? "check" : "plan";
  const profile = typeof body?.profile === "string" ? body.profile : undefined;

  if (action === "check") {
    // S77 — the check action now starts the UNIFIED consistency engine
    // (identity reused + style cohesion + the style contract), not the
    // identity-only continuity pass. Style needs NO cast, so the gate is
    // "scenes exist" — a no-cast video still gets its style judged, and the
    // engine reports the identity dimension honestly unavailable.
    const scenes = video.scenes ? (JSON.parse(video.scenes) as unknown[]) : [];
    if (scenes.length === 0)
      return NextResponse.json(
        { error: "No scenes to check — the consistency engine runs on scene-format videos with a scene script" },
        { status: 400 }
      );
    await db.video.update({ where: { id }, data: { error: null } });
    const accepted = await startJob(id, "consistency", () => runConsistencyJob(id, "manual"));
    return NextResponse.json({ accepted, generating: { check: true } }, { status: accepted ? 202 : 200 });
  }

  if (!video.scenes)
    return NextResponse.json(
      { error: "Video has no scenes — generate the scene script first" },
      { status: 400 }
    );

  await db.video.update({ where: { id }, data: { error: null } });
  const accepted = await startJob(id, "director", () => runDirectorJob(id, profile ? { profile } : undefined));
  return NextResponse.json({ accepted, generating: { plan: true } }, { status: accepted ? 202 : 200 });
}

/**
 * PATCH — the human approval gate. Body: { action: "approve" | "dismiss" |
 * "reset" }. "approved" makes the plan steer image prompts, motion hints and
 * audio cues; "dismissed" keeps the plan visible but inert; "reset" clears it.
 */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const action = typeof body?.action === "string" ? body.action : "";
  if (action !== "approve" && action !== "dismiss" && action !== "reset")
    return NextResponse.json({ error: "action must be approve | dismiss | reset" }, { status: 400 });
  if (!video.shotList && action !== "reset")
    return NextResponse.json({ error: "No director plan to act on — run the pass first" }, { status: 400 });

  if (action === "reset") {
    await db.video.update({
      where: { id },
      data: { directorState: null, shotList: null, consistency: null },
    });
    return NextResponse.json({ ok: true, state: null });
  }
  const state: DirectorState = action === "approve" ? "approved" : "dismissed";
  await setDirectorState(id, state);
  return NextResponse.json({ ok: true, state });
}
