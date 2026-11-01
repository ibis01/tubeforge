import { NextRequest, NextResponse } from "next/server";
import {
  DEFAULT_SETTINGS,
  publicSettingsMap,
} from "@/lib/tubeforge/settings-public";
import {
  deleteUserSetting,
  getUserSettings,
  setUserSettings,
} from "@/lib/tubeforge/settings";
import { requireUser } from "@/lib/tubeforge/tenant";
import { errorText } from "@/lib/tubeforge/redact";

// SECURITY: preferences are per-user UserSetting rows scoped to the acting
// user (requireUser). Responses are still filtered through the settings-public
// allow-list — unknown keys are dropped server-side, so a future preference
// key can never leak by default. Secrets never live here: OAuth client
// secrets/tokens and provider API keys are stored in ProviderCredential
// (encrypted at rest) and exposed ONLY masked, via /api/settings/ai,
// /api/settings/tts and /api/youtube/status.

/** Stored preference rows restricted to the public allow-list (defaults merged). */
async function readPublicSettings(): Promise<Record<string, string>> {
  const stored = await getUserSettings(Object.keys(DEFAULT_SETTINGS));
  const rows = [...stored.entries()].map(([key, value]) => ({ key, value }));
  return publicSettingsMap(rows);
}

export async function GET(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures
  return NextResponse.json({ settings: await readPublicSettings() });
}

export async function PUT(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  try {
    const body = await req.json();
    const allowed = new Set(Object.keys(DEFAULT_SETTINGS));
    const updates: Record<string, string> = {};

    for (const [key, raw] of Object.entries(body)) {
      if (!allowed.has(key)) continue;
      // music.trackId accepts explicit null → clears the manual default.
      if (key === "music.trackId" && (raw === null || raw === "")) {
        await deleteUserSetting(key);
        continue;
      }
      const value =
        typeof raw === "boolean" ? String(raw) : String(raw ?? "").trim();
      if (!value) continue;
      updates[key] = value;
    }

    await setUserSettings(updates);

    return NextResponse.json({ settings: await readPublicSettings() });
  } catch (err) {
    const message = errorText(err, "Invalid request");
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
