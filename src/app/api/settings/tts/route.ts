// Settings → Voice engine (custom TTS) — status (masked) + save.
//
// GET  → { provider, baseUrl, model, voice, keyPreview, zai }   (raw key never returned)
// PUT  → save { provider, baseUrl, model, voice, apiKey?, clearApiKey? }

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { invalidateTtsSettings, zaiConfigured, type TtsProvider } from "@/lib/tubeforge/tts";

const maskKey = (k: string) =>
  k ? (k.length <= 8 ? "••••" : `${k.slice(0, 4)}…${k.slice(-4)}`) : null;

const KEYS = ["ttsProvider", "ttsBaseUrl", "ttsApiKey", "ttsModel", "ttsVoice"];

async function readSettings() {
  const rows = await db.setting.findMany({ where: { key: { in: KEYS } } });
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const p = map.get("ttsProvider");
  return {
    provider: (p === "openai" || p === "elevenlabs" ? p : "zai") as TtsProvider,
    baseUrl: map.get("ttsBaseUrl") ?? "",
    model: map.get("ttsModel") ?? "",
    voice: map.get("ttsVoice") ?? "",
    apiKey: map.get("ttsApiKey") ?? "",
  };
}

async function status() {
  const s = await readSettings();
  return {
    provider: s.provider,
    baseUrl: s.baseUrl,
    model: s.model,
    voice: s.voice,
    keyPreview: maskKey(s.apiKey),
    zai: await zaiConfigured(),
  };
}

export async function GET() {
  try {
    return NextResponse.json(await status());
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
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

    const updates: { key: string; value: string }[] = [{ key: "ttsProvider", value: provider }];
    if (provider === "openai") {
      if (baseUrl) updates.push({ key: "ttsBaseUrl", value: baseUrl });
      if (model) updates.push({ key: "ttsModel", value: model });
      if (voice) updates.push({ key: "ttsVoice", value: voice });
      if (apiKey) updates.push({ key: "ttsApiKey", value: apiKey });
    } else if (provider === "elevenlabs") {
      if (model) updates.push({ key: "ttsModel", value: model });
      if (voice) updates.push({ key: "ttsVoice", value: voice });
      if (apiKey) updates.push({ key: "ttsApiKey", value: apiKey });
    } else if (clearApiKey) {
      updates.push({ key: "ttsApiKey", value: "" });
    }

    for (const u of updates) {
      if (!u.value && u.key !== "ttsApiKey") continue;
      if (!u.value && u.key === "ttsApiKey" && !clearApiKey) continue;
      await db.setting.upsert({
        where: { key: u.key },
        update: { value: u.value },
        create: { key: u.key, value: u.value },
      });
    }

    invalidateTtsSettings();
    return NextResponse.json(await status());
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
