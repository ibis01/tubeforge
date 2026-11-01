import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/tubeforge/tenant";
import {
  callbackUrlFor,
  isConnected,
  fetchChannelInfo,
  getPublishDefaults,
} from "@/lib/tubeforge/youtube";
import { getUserSettings } from "@/lib/tubeforge/settings";
import type { YouTubeStatusDTO } from "@/lib/tubeforge/types";

/** GET — connection state for the Settings card (callbackUrl built from origin). */
export async function GET(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const origin = new URL(req.url).origin;

  // OAuth client resolution mirrors the youtube lib: server-wide env vars
  // first, the user's stored credentials (legacy claim) as the fallback.
  const envId = process.env.TUBEFORGE_YT_CLIENT_ID?.trim() || "";
  const envSecret = process.env.TUBEFORGE_YT_CLIENT_SECRET?.trim() || "";
  const stored = await getUserSettings(["yt.clientId", "yt.clientSecret"]);
  const storedId = stored.get("yt.clientId")?.trim() || "";
  const storedSecret = stored.get("yt.clientSecret")?.trim() || "";
  const configured = Boolean(
    (envId && envSecret) || (storedId && storedSecret)
  );
  const clientId = envId || storedId || null;

  const connected = await isConnected();

  // Channel identity comes from the per-user connection row (a live lookup
  // only happens when the row has no title yet; failures stay non-fatal —
  // the sync/upload paths surface token trouble with actionable errors).
  let channelTitle: string | null = null;
  let channelThumb: string | null = null;
  if (connected) {
    try {
      const info = await fetchChannelInfo();
      channelTitle = info.title;
      channelThumb = info.thumbUrl;
    } catch {
      /* token hiccup — report connected, let sync re-raise it */
    }
  }

  const { privacyStatus } = await getPublishDefaults();

  const status: YouTubeStatusDTO = {
    configured,
    connected,
    channelTitle,
    channelThumb,
    privacyStatus,
    callbackUrl: callbackUrlFor(origin),
    clientId,
  };
  return NextResponse.json({ status });
}
