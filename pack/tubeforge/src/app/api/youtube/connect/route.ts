import { NextRequest, NextResponse } from "next/server";
import { buildAuthUrl } from "@/lib/tubeforge/youtube";

/** POST — build + return the Google consent URL (opened in a new tab by the UI). */
export async function POST(req: NextRequest) {
  try {
    const origin = new URL(req.url).origin;
    const authUrl = await buildAuthUrl(origin);
    return NextResponse.json({ authUrl });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not start the connection";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
