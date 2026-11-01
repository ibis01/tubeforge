import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/tubeforge/tenant";
import { getAnalyticsOverview } from "@/lib/tubeforge/analytics";
import { errorText } from "@/lib/tubeforge/redact";

/** GET — aggregated channel performance + feedback-loop state (Phase 5). */
export async function GET(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  try {
    const overview = await getAnalyticsOverview();
    return NextResponse.json(overview);
  } catch (err) {
    const message = errorText(err, "Analytics failed");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
