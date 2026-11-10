import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/tubeforge/tenant";
import { requestJobCancel, type JobKind } from "@/lib/tubeforge/jobs";
import { resumableKinds } from "@/lib/tubeforge/queue-handlers";

/**
 * POST — stop a running background job (user-facing Stop button).
 * Body: { entityId: string, kind: JobKind }
 *
 * Cancellation is cooperative: the flag lands instantly and the job body
 * unwinds at its next checkpoint (≤500ms inside the AI retry machinery,
 * mid-cool-down included). The job row is recorded as "cancelled" once the
 * body finishes unwinding; entity state (video status/error) is handled by
 * the job body itself.
 */

// The cancellable kinds ARE the resumable kinds — both mean "every kind a
// route can start", so both must derive from the LIVE handler registry.
// This used to be a hand-maintained literal and it drifted exactly the way
// resumableKinds() itself had (see its own history note): "whiteboard"
// (S67) and six other registered kinds (research, stock, director,
// continuity, slide, qc) were never added, so pressing Stop on a running
// whiteboard render 400'd with "Unknown job kind" — an uncancellable
// render. The S75 E12 queue drill pinned the fix.
const KINDS: JobKind[] = resumableKinds();

export async function POST(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  let body: { entityId?: string; kind?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { entityId, kind } = body ?? {};
  if (!entityId || !kind)
    return NextResponse.json(
      { error: "entityId and kind are required" },
      { status: 400 }
    );
  if (!KINDS.includes(kind as JobKind))
    return NextResponse.json(
      { error: `Unknown job kind "${kind}"` },
      { status: 400 }
    );

  // Cooperative cancel: sets the flag instantly; returns the job kinds that
  // were actually running (empty → nothing to stop).
  const stopped = requestJobCancel(entityId, kind as JobKind);
  if (stopped.length === 0)
    return NextResponse.json(
      { error: "That job is not running right now" },
      { status: 409 }
    );

  return NextResponse.json({ cancelled: true });
}
