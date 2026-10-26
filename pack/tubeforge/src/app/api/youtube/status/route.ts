import { NextRequest, NextResponse } from "next/server";
import { callbackUrlFor } from "@/lib/tubeforge/youtube";
import type { YouTubeStatusDTO } from "@/lib/tubeforge/types";

/** GET — connection state for the Settings card (callbackUrl built from origin). */
export async function GET(req: NextRequest) {
  const { db } = await import("@/lib/db");
  const rows = await db.setting.findMany({
    where: {
      key: {
        in: [
          "ytClientId",
          "ytClientSecret",
          "ytRefreshToken",
          "ytChannelTitle",
          "ytChannelThumb",
          "ytPrivacyStatus",
        ],
      },
    },
  });
  const map = new Map(rows.map((r) => [r.key, r.value]));

  const status: YouTubeStatusDTO = {
    configured: Boolean(map.get("ytClientId") && map.get("ytClientSecret")),
    connected: Boolean(map.get("ytRefreshToken")),
    channelTitle: map.get("ytChannelTitle") ?? null,
    channelThumb: map.get("ytChannelThumb") ?? null,
    privacyStatus: map.get("ytPrivacyStatus") ?? "unlisted",
    callbackUrl: callbackUrlFor(new URL(req.url).origin),
    clientId: map.get("ytClientId") ?? null,
  };
  return NextResponse.json({ status });
}
