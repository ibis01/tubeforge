// Settings → AI Providers: per-capability provider configuration.
//
//   GET  → current config (keys masked) + the provider registry
//   PUT  → save the global Z.ai credentials OR one capability's provider
//   POST → test a capability end-to-end with optional unsaved overrides
//
// The API key is never returned in full — only masked. Z.ai credentials are
// global (shared SDK); other providers carry per-capability credentials.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { resetZAIClient } from "@/lib/tubeforge/ai";
import { createZaiForTest, readZaiCredentials, syncZaiConfigFile, ZAI_SETTING_KEYS } from "@/lib/tubeforge/zai-config";
import {
  getCapability,
  saveCapability,
  publicCapability,
  maskKey,
  type CapabilityConfig,
} from "@/lib/tubeforge/providers/settings";
import {
  PROVIDERS_BY_CAPABILITY,
  CAPABILITY_META,
  type CapabilityId,
} from "@/lib/tubeforge/providers/registry";
import { DEFAULT_CHAT_MODEL, DEFAULT_ZAI_BASE_URL } from "@/lib/tubeforge/types";
import { chatComplete } from "@/lib/tubeforge/providers/chat";
import { visionComplete } from "@/lib/tubeforge/providers/vision";
import { ttsSynthesize } from "@/lib/tubeforge/providers/tts";
import { imageEdit, imageGenerate } from "@/lib/tubeforge/providers/image";

const CAPABILITIES: CapabilityId[] = ["chat", "tts", "image", "video"];

/** 1x1 transparent PNG — enough bytes to exercise a vision/edit wire call. */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export async function GET() {
  const caps: Record<string, ReturnType<typeof publicCapability>> = {};
  for (const cap of CAPABILITIES) {
    caps[cap] = publicCapability(await getCapability(cap));
  }
  const zai = await readZaiCredentials();
  return NextResponse.json({
    zai: {
      baseUrl: zai.baseUrl || DEFAULT_ZAI_BASE_URL,
      baseUrlSaved: Boolean(zai.baseUrl),
      hasKey: Boolean(zai.apiKey),
      maskedKey: maskKey(zai.apiKey),
    },
    capabilities: caps,
    meta: CAPABILITY_META,
    providers: PROVIDERS_BY_CAPABILITY,
    defaults: { chatModel: DEFAULT_CHAT_MODEL, zaiBaseUrl: DEFAULT_ZAI_BASE_URL },
  });
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();

    // ---- Scope 1: global Z.ai credentials ----
    if (body.scope === "zai" || (!body.scope && !body.capability)) {
      const updates: { key: string; value: string }[] = [];
      const baseUrl = String(body.baseUrl ?? "").trim();
      if (baseUrl) updates.push({ key: ZAI_SETTING_KEYS.baseUrl, value: baseUrl });
      const apiKey = String(body.apiKey ?? "").trim();
      if (apiKey) updates.push({ key: ZAI_SETTING_KEYS.apiKey, value: apiKey });
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
      await syncZaiConfigFile();
      resetZAIClient();
      const zai = await readZaiCredentials();
      return NextResponse.json({
        zai: {
          baseUrl: zai.baseUrl || DEFAULT_ZAI_BASE_URL,
          hasKey: Boolean(zai.apiKey),
          maskedKey: maskKey(zai.apiKey),
        },
      });
    }

    // ---- Scope 2: one capability's provider ----
    const capability = String(body.capability ?? "") as CapabilityId;
    if (!CAPABILITIES.includes(capability)) {
      return NextResponse.json({ error: "Unknown capability" }, { status: 400 });
    }
    const patch: Partial<CapabilityConfig> = {};
    if (body.provider !== undefined) {
      const provider = String(body.provider).trim();
      const allowed: string[] = PROVIDERS_BY_CAPABILITY[capability].map((p) => p.id);
      if (!allowed.includes(provider)) {
        return NextResponse.json(
          { error: `Provider "${provider}" can't handle ${capability}` },
          { status: 400 }
        );
      }
      patch.provider = provider as CapabilityConfig["provider"];
    }
    if (body.model !== undefined) patch.model = String(body.model).trim();
    if (body.visionModel !== undefined)
      patch.visionModel = String(body.visionModel).trim();
    if (body.baseUrl !== undefined) patch.baseUrl = String(body.baseUrl).trim();
    // Empty key = keep the saved one (masked field stays blank in the UI).
    if (body.apiKey !== undefined) patch.apiKey = String(body.apiKey).trim();

    // "Use the same account as Script writing" — adopt the chat provider's
    // saved credentials (provider + endpoint + key) for this capability.
    if (body.copyCredsFrom) {
      const source = await getCapability(String(body.copyCredsFrom) as CapabilityId);
      if (!source.apiKey) {
        return NextResponse.json(
          { error: "The script provider has no saved key yet — save it first" },
          { status: 400 }
        );
      }
      patch.provider = source.provider;
      patch.baseUrl = source.baseUrl ?? "";
      patch.apiKey = source.apiKey;
    }

    const saved = await saveCapability(capability, patch);
    await syncZaiConfigFile();
    resetZAIClient();
    return NextResponse.json({ capability, config: publicCapability(saved) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/** Test a capability end-to-end. Overrides are never saved. */
export async function POST(req: NextRequest) {
  let body: Record<string, string | boolean | undefined> = {};
  try {
    body = await req.json();
  } catch {
    /* empty body = test saved chat settings */
  }

  const capability = String(body.capability ?? "chat");
  const provider = String(body.provider ?? "").trim();
  const overrides: Partial<CapabilityConfig> = {};
  if (provider) overrides.provider = provider as CapabilityConfig["provider"];
  if (body.baseUrl !== undefined) overrides.baseUrl = String(body.baseUrl).trim();
  if (body.model !== undefined) overrides.model = String(body.model).trim();
  if (body.visionModel !== undefined)
    overrides.visionModel = String(body.visionModel).trim();
  const apiKeyOverride = String(body.apiKey ?? "").trim();
  if (apiKeyOverride) overrides.apiKey = apiKeyOverride;

  const started = Date.now();
  try {
    // Z.ai with an UNSAVED key needs the throwaway-client flow (the shared
    // SDK only reads the saved config).
    if ((provider === "zai" || (!provider && capability !== "tts" && capability !== "image")) && apiKeyOverride) {
      const zai = await createZaiForTest({
        baseUrl: overrides.baseUrl,
        apiKey: apiKeyOverride,
      });
      const savedChat = await getCapability("chat");
      const model =
        overrides.model?.trim() || savedChat.model?.trim() || DEFAULT_CHAT_MODEL;
      const completion = await zai.chat.completions.create({
        model,
        messages: [{ role: "user", content: "Reply with exactly: ok" }],
        thinking: { type: "disabled" },
      });
      const reply =
        (completion as { choices?: { message?: { content?: string } }[] })?.choices?.[0]
          ?.message?.content ?? "(empty response)";
      return NextResponse.json({
        ok: true,
        capability,
        model,
        reply: reply.slice(0, 120),
        latencyMs: Date.now() - started,
      });
    }

    switch (capability) {
      case "vision": {
        const raw = await visionComplete(
          {
            system: "You are a connection tester. Answer in plain text.",
            user: "Reply with exactly: ok",
            imagePngBase64: TINY_PNG_BASE64,
          },
          overrides
        );
        return NextResponse.json({
          ok: true,
          capability,
          reply: (raw || "(empty response)").slice(0, 120),
          latencyMs: Date.now() - started,
        });
      }
      case "tts": {
        const voice = String(body.voice ?? "").trim();
        const buffer = await ttsSynthesize(
          { input: "Connection test.", voice, speed: 1 },
          overrides
        );
        return NextResponse.json({
          ok: true,
          capability,
          bytes: buffer.length,
          reply: `Spoke ${(buffer.length / 1024).toFixed(0)} KB of WAV`,
          latencyMs: Date.now() - started,
        });
      }
      case "image":
      case "imageEdit": {
        // Pollinations is free — skip the cost-confirmation gate so the user
        // can test it without the "may cost money" modal.
        const isPollinations = provider === "pollinations";
        if (!isPollinations && !body.confirmCost) {
          return NextResponse.json({
            ok: false,
            needsConfirm: true,
            error:
              "Image tests generate real art and may cost money — confirm to run it",
          });
        }
        if (capability === "imageEdit") {
          const buffer = await imageEdit(
            {
              prompt: "Make the background light blue.",
              imagePngBase64: TINY_PNG_BASE64,
              size: "1024x1024",
            },
            overrides
          );
          if (!buffer) {
            return NextResponse.json({
              ok: true,
              capability,
              reply: "Connected — but this model can't edit images (falls back to fresh generation)",
              latencyMs: Date.now() - started,
            });
          }
          return NextResponse.json({
            ok: true,
            capability,
            reply: `Edited image returned (${(buffer.length / 1024).toFixed(0)} KB)`,
            latencyMs: Date.now() - started,
          });
        }
        const buffer = await imageGenerate(
          { prompt: "A solid teal circle centered on a white background, minimal.", size: "1344x768" },
          overrides
        );
        return NextResponse.json({
          ok: true,
          capability,
          reply: `Generated ${(buffer.length / 1024).toFixed(0)} KB PNG`,
          latencyMs: Date.now() - started,
        });
      }
      case "chat":
      default: {
        const raw = await chatComplete(
          {
            system: "You are a connection tester. Answer in plain text.",
            user: "Reply with exactly: ok",
          },
          overrides
        );
        const model =
          overrides.model?.trim() ||
          (await getCapability("chat")).model?.trim() ||
          DEFAULT_CHAT_MODEL;
        return NextResponse.json({
          ok: true,
          capability: "chat",
          model,
          reply: (raw || "(empty response)").slice(0, 120),
          latencyMs: Date.now() - started,
        });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Connection failed";
    return NextResponse.json({ ok: false, error: message.slice(0, 400) }, { status: 200 });
  } finally {
    // A test must never poison the live client: reset so the next real call
    // re-syncs the config file from SAVED settings.
    resetZAIClient();
    await syncZaiConfigFile();
  }
}
