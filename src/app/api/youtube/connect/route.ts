import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/tubeforge/tenant";
import { buildAuthUrl } from "@/lib/tubeforge/youtube";
import { errorText } from "@/lib/tubeforge/redact";

/** POST — build + return the Google consent URL (opened in a new tab by the UI). */
export async function POST(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  try {
    const origin = new URL(req.url).origin;
    const authUrl = await buildAuthUrl(origin);
    return NextResponse.json({ authUrl });
  } catch (err) {
    const message = errorText(err, "Could not start the connection");
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
