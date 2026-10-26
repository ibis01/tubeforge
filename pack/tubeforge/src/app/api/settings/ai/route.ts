// Settings → AI Provider: read/save the Z.ai credentials + model selection and
// test the connection. The API key is never returned in full — only masked.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { resetZAIClient } from "@/lib/tubeforge/ai";
import {
  AI_SETTING_KEYS,
  createZaiForTest,
  maskKey,
  readAiSettings,
  syncZaiConfigFile,
} from "@/lib/tubeforge/zai-config";
import { CHAT_MODELS, DEFAULT_CHAT_MODEL, DEFAULT_ZAI_BASE_URL } from "@/lib/tubeforge/types";

export async function GET() {
  const s = await readAiSettings();
  return NextResponse.json({
    baseUrl: s.baseUrl || DEFAULT_ZAI_BASE_URL,
    baseUrlSaved: Boolean(s.baseUrl),
    hasKey: Boolean(s.apiKey),
    maskedKey: maskKey(s.apiKey),
    chatModel: s.chatModel,
    visionModel: s.visionModel,
    defaults: { baseUrl: DEFAULT_ZAI_BASE_URL, chatModel: DEFAULT_CHAT_MODEL },
    models: CHAT_MODELS,
  });
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const updates: { key: string; value: string }[] = [];

    const baseUrl = String(body.baseUrl ?? "").trim();
    if (baseUrl) updates.push({ key: AI_SETTING_KEYS.baseUrl, value: baseUrl });

    // Empty key = "keep the saved one" so the masked field can stay blank.
    const apiKey = String(body.apiKey ?? "").trim();
    if (apiKey) updates.push({ key: AI_SETTING_KEYS.apiKey, value: apiKey });

    const chatModel = String(body.chatModel ?? "").trim();
    if (chatModel) updates.push({ key: AI_SETTING_KEYS.chatModel, value: chatModel });

    const visionModel = String(body.visionModel ?? "").trim();
    if (visionModel) updates.push({ key: AI_SETTING_KEYS.visionModel, value: visionModel });

    if (updates.length === 0) {
      return NextResponse.json({ error: "Nothing to save" }, { status: 400 });
    }

    for (const u of updates) {
      await db.setting.upsert({
        where: { key: u.key },
        update: { value: u.value },
        create: { key: u.key, value: u.value },
      });
    }

    // Apply immediately: rewrite .z-ai-config and drop the cached SDK client.
    await syncZaiConfigFile();
    resetZAIClient();

    const s = await readAiSettings();
    return NextResponse.json({
      baseUrl: s.baseUrl || DEFAULT_ZAI_BASE_URL,
      hasKey: Boolean(s.apiKey),
      maskedKey: maskKey(s.apiKey),
      chatModel: s.chatModel,
      visionModel: s.visionModel,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/** Test the connection with saved settings (plus optional unsaved overrides). */
export async function POST(req: NextRequest) {
  let body: { baseUrl?: string; apiKey?: string; chatModel?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* empty body = test saved settings */
  }
  try {
    const zai = await createZaiForTest({
      baseUrl: body.baseUrl,
      apiKey: body.apiKey,
    });
    const model = String(body.chatModel ?? "").trim() || (await readAiSettings()).chatModel;
    const started = Date.now();
    const completion = await zai.chat.completions.create({
      model,
      messages: [{ role: "user", content: "Reply with exactly: ok" }],
      thinking: { type: "disabled" },
    });
    const reply =
      (completion as { choices?: { message?: { content?: string } }[] })?.choices?.[0]?.message
        ?.content ?? "(empty response)";
    return NextResponse.json({
      ok: true,
      model,
      reply: reply.slice(0, 120),
      latencyMs: Date.now() - started,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Connection failed";
    return NextResponse.json({ ok: false, error: message.slice(0, 300) }, { status: 200 });
  } finally {
    // A test must never poison the live client: reset so the next real call
    // re-syncs the config file from SAVED settings.
    resetZAIClient();
    await syncZaiConfigFile();
  }
}
