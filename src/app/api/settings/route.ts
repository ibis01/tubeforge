import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  DEFAULT_SETTINGS,
  publicSettingsMap,
} from "@/lib/tubeforge/settings-public";

// SECURITY: the Setting table also stores secrets (OAuth client secret +
// refresh token, provider API keys, the studio password hash). Responses are
// filtered through the settings-public allow-list — unknown keys are dropped
// server-side, so a future key added to the table can never leak by default.
// Credential state is exposed ONLY masked, via /api/settings/ai and
// /api/youtube/status.

export async function GET() {
  const rows = await db.setting.findMany();
  return NextResponse.json({ settings: publicSettingsMap(rows) });
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const allowed = new Set(Object.keys(DEFAULT_SETTINGS));
    const updates: { key: string; value: string }[] = [];

    for (const [key, raw] of Object.entries(body)) {
      if (!allowed.has(key)) continue;
      // music.trackId accepts explicit null → clears the manual default.
      if (key === "music.trackId" && (raw === null || raw === "")) {
        await db.setting.deleteMany({ where: { key } });
        continue;
      }
      const value =
        typeof raw === "boolean" ? String(raw) : String(raw ?? "").trim();
      if (!value) continue;
      updates.push({ key, value });
    }

    for (const u of updates) {
      await db.setting.upsert({
        where: { key: u.key },
        update: { value: u.value },
        create: { key: u.key, value: u.value },
      });
    }

    const rows = await db.setting.findMany();
    return NextResponse.json({ settings: publicSettingsMap(rows) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
