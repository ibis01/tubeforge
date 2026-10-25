import { NextResponse } from "next/server";
import { getAnalyticsOverview } from "@/lib/tubeforge/analytics";

/** GET — aggregated channel performance + feedback-loop state (Phase 5). */
export async function GET() {
  try {
    const overview = await getAnalyticsOverview();
    return NextResponse.json(overview);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Analytics failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
