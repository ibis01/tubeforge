import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

const DEFAULTS: Record<string, string> = {
  defaultVoice: "jam",
  defaultSpeed: "1",
  defaultTone: "informative",
  defaultLength: "medium",
  defaultNiche: "Motivation",
  defaultThumbStyle: "cinematic",
  autoVoiceover: "true",
  autoThumbnail: "true",
  // Phase 3 — VLM quality gate
  qualityGate: "thumbnails", // off | thumbnails | all (thumbnails + storyboard scenes)
  qualityThreshold: "6", // 1-9 — below this the image is re-rolled once
  // Phase 3 — global AI rate budget
  aiBudgetEnabled: "true",
  aiLlmPerMin: "30",
  aiTtsPerMin: "12",
  aiImagePerMin: "8",
  aiVideoPerMin: "4",
  // Background music (music.ts reads these at render time)
  "music.enabled": "true",
  "music.mode": "auto", // auto | manual
  "music.trackId": "", // used when mode=manual
  "music.volume": "0.5",
  "music.fadeInSec": "1.5",
  "music.fadeOutSec": "2.5",
};

export async function GET() {
  const rows = await db.setting.findMany();
  const map: Record<string, string> = { ...DEFAULTS };
  for (const row of rows) map[row.key] = row.value;
  return NextResponse.json({ settings: map });
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const allowed = new Set(Object.keys(DEFAULTS));
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
    const map: Record<string, string> = { ...DEFAULTS };
    for (const row of rows) map[row.key] = row.value;

    return NextResponse.json({ settings: map });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
