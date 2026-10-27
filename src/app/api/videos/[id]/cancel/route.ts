import { NextRequest, NextResponse } from "next/server";
import { requestJobCancel } from "@/lib/tubeforge/jobs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST — request cancellation of every running job for this video.
 * Long loops (render scene-by-scene, storyboard, voiceover chunks) check the
 * flag between units and stop with "cancelled" (recorded on the Job row);
 * a job already inside a single ffmpeg call finishes that step first.
 */
export async function POST(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const cancelled = requestJobCancel(id);
  if (cancelled.length === 0)
    return NextResponse.json(
      { error: "Nothing is running for this video right now" },
      { status: 409 }
    );
  return NextResponse.json({ ok: true, cancelled });
}
