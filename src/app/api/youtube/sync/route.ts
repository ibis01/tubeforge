import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/tubeforge/tenant";
import { syncYouTubeStats } from "@/lib/tubeforge/analytics";
import { isConnected } from "@/lib/tubeforge/youtube";
import { errorText } from "@/lib/tubeforge/redact";

/**
 * POST — pull fresh performance stats for every published video (one batched
 * YouTube Data API call) and store VideoStat snapshots. Fast enough to run
 * synchronously (unlike uploads) — returns the sync summary directly.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  if (!(await isConnected()))
    return NextResponse.json(
      { error: "YouTube channel is not connected — add OAuth credentials and connect in Settings first" },
      { status: 400 }
    );

  try {
    const result = await syncYouTubeStats();
    return NextResponse.json(result);
  } catch (err) {
    const message = errorText(err, "Stats sync failed");
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
