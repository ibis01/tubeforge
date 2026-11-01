import { NextRequest, NextResponse } from "next/server";
import { rawDatabase as rawDb } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";

/** POST — revoke the stored channel connection (credentials are kept). */
export async function POST(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  // Stage 2: the connection is a per-user YouTubeAccount row — drop it and
  // the next getAccessToken() fails with "not connected" (the in-memory
  // token cache only ever holds entries while a row exists to refresh).
  await rawDb.youTubeAccount.deleteMany({ where: { userId: auth.ctx.userId } });
  return NextResponse.json({ connected: false });
}
