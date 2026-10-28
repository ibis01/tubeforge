import { NextRequest, NextResponse } from "next/server";
import { requestJobCancel, type JobKind } from "@/lib/tubeforge/jobs";

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

const KINDS: JobKind[] = [
  "script",
  "voiceover",
  "thumbnail",
  "variants",
  "portrait",
  "poses",
  "storyboard",
  "render",
  "scene",
  "verify",
  "comments",
  "upload",
  "short",
  "convert",
];

export async function POST(req: NextRequest) {
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
