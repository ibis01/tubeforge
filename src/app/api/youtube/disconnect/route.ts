import { NextResponse } from "next/server";
import { setSetting } from "@/lib/tubeforge/youtube";

/** POST — revoke the stored channel connection (credentials are kept). */
export async function POST() {
  await setSetting("ytRefreshToken", null);
  await setSetting("ytChannelTitle", null);
  await setSetting("ytChannelThumb", null);
  return NextResponse.json({ connected: false });
}
