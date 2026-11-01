// Settings → Voice engine (custom TTS) — status (masked) + save.
//
// GET  → { provider, baseUrl, model, voice, keyPreview, zai }   (raw key never returned)
// PUT  → save { provider, baseUrl, model, voice, apiKey?, clearApiKey? }
//
// Stage 2: provider/baseUrl/model/voice are per-user preference rows
// (UserSetting); the API key is a per-user secret stored encrypted in
// ProviderCredential (capability "tts") — never a preference row.

import { NextRequest, NextResponse } from "next/server";
import { invalidateTtsSettings, zaiConfigured, type TtsProvider } from "@/lib/tubeforge/tts";
import {
  deleteProviderCredential,
  getProviderCredential,
  getUserSettings,
  setUserSettings,
  upsertProviderCredential,
} from "@/lib/tubeforge/settings";
import { requireUser } from "@/lib/tubeforge/tenant";
import { errorText } from "@/lib/tubeforge/redact";

const maskKey = (k: string) =>
  k ? (k.length <= 8 ? "••••" : `${k.slice(0, 4)}…${k.slice(-4)}`) : null;

const PREF_KEYS = ["ttsProvider", "ttsBaseUrl", "ttsModel", "ttsVoice"];

async function readPrefs() {
  const map = await getUserSettings(PREF_KEYS);
  const p = map.get("ttsProvider");
  return {
    provider: (p === "openai" || p === "elevenlabs" ? p : "zai") as TtsProvider,
    baseUrl: map.get("ttsBaseUrl") ?? "",
    model: map.get("ttsModel") ?? "",
    voice: map.get("ttsVoice") ?? "",
  };
}

async function status() {
  const s = await readPrefs();
  // API key — encrypted per-user credential; Z.ai rides the platform gateway.
  const cred =
    s.provider === "zai" ? null : await getProviderCredential("tts", s.provider);
  const apiKey = cred?.apiKey ?? "";
  return {
    provider: s.provider,
    baseUrl: s.baseUrl,
    model: s.model,
    voice: s.voice,
    keyPreview: maskKey(apiKey),
    zai: await zaiConfigured(),
  };
}

export async function GET(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  try {
    return NextResponse.json(await status());
  } catch (err) {
    const message = errorText(err, "Unknown error");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  try {
    const body = await req.json();
    const provider: TtsProvider =
      body.provider === "openai" || body.provider === "elevenlabs" ? body.provider : "zai";
    const baseUrl = String(body.baseUrl ?? "").trim().replace(/\/+$/, "");
    const model = String(body.model ?? "").trim();
    const voice = String(body.voice ?? "").trim();
    const apiKey = String(body.apiKey ?? "").trim();
    const clearApiKey = body.clearApiKey === true;

    if (provider === "openai" && baseUrl && !/^https?:\/\//i.test(baseUrl))
      return NextResponse.json(
        { error: "Base URL must start with http:// or https://" },
        { status: 400 }
      );
    if (provider === "elevenlabs" && voice && !/^[A-Za-z0-9]{10,}$/.test(voice))
      return NextResponse.json(
        { error: "ElevenLabs Voice ID looks wrong — copy it from your ElevenLabs dashboard (it's a long alphanumeric ID)" },
        { status: 400 }
      );

    // 1) Non-secret preferences — per-user rows.
    const prefs: Record<string, string> = { ttsProvider: provider };
    if (provider === "openai") {
      if (baseUrl) prefs.ttsBaseUrl = baseUrl;
      if (model) prefs.ttsModel = model;
      if (voice) prefs.ttsVoice = voice;
    } else if (provider === "elevenlabs") {
      if (model) prefs.ttsModel = model;
      if (voice) prefs.ttsVoice = voice;
    }
    await setUserSettings(prefs);

    // 2) The API key — encrypted ProviderCredential, never a preference row.
    //    Empty key = keep the saved one (the masked field stays blank in the UI);
    //    clearApiKey wipes it.
    if (provider !== "zai") {
      if (apiKey) {
        await upsertProviderCredential(auth.ctx.userId, "tts", provider, {
          baseUrl,
          apiKey,
        });
      } else if (clearApiKey) {
        await deleteProviderCredential(auth.ctx.userId, "tts", provider);
      }
    }

    invalidateTtsSettings();
    return NextResponse.json(await status());
  } catch (err) {
    const message = errorText(err, "Invalid request");
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
