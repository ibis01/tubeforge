import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/tubeforge/tenant";
import { jobHistory } from "@/lib/tubeforge/jobs";

/** GET — recent background jobs (drives the Settings "Background Jobs" panel). */
export async function GET(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const limitRaw = Number(new URL(req.url).searchParams.get("limit"));
  const limit = Number.isInteger(limitRaw) && limitRaw >= 1 ? Math.min(limitRaw, 100) : 20;

  const jobs = await jobHistory(limit);
  return NextResponse.json({ jobs });
}
