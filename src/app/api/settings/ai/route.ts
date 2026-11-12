// Settings → AI Providers: per-capability provider configuration.
//
//   GET  → current config (keys masked) + the provider registry
//   PUT  → save the acting user's shared credentials OR one capability's provider
//   POST → test a capability end-to-end with optional unsaved overrides

import { NextRequest, NextResponse } from "next/server";
import { resetZAIClient } from "@/lib/tubeforge/ai";
import { invalidateZaiClients } from "@/lib/tubeforge/zai-client";
import { createZaiForTest } from "@/lib/tubeforge/zai-config";
import {
  syncZaiConfigFile,
  ZAI_SETTING_KEYS,
} from "@/lib/tubeforge/providers/config";
import { setUserSettings } from "@/lib/tubeforge/settings";
import { requireUser } from "@/lib/tubeforge/tenant";
import {
  getCapability,
  saveCapability,
  publicCapability,
  maskKey,
  readLegacyZai,
  type CapabilityConfig,
} from "@/lib/tubeforge/providers/settings";
import {
  PROVIDERS_BY_CAPABILITY,
  CAPABILITY_META,
  type CapabilityId,
} from "@/lib/tubeforge/providers/registry";
import {
  DEFAULT_CHAT_MODEL,
  DEFAULT_ZAI_BASE_URL,
} from "@/lib/tubeforge/types";
import { chatComplete } from "@/lib/tubeforge/providers/chat";
import { visionComplete } from "@/lib/tubeforge/providers/vision";
import {
  probeSelfhostHealth,
  ttsSynthesize,
} from "@/lib/tubeforge/providers/tts";
import { imageEdit, imageGenerate } from "@/lib/tubeforge/providers/image";
import { imageTestFreeLane } from "@/lib/tubeforge/providers/registry";
import { errorText } from "@/lib/tubeforge/redact";
import { imageToVideo } from "@/lib/tubeforge/providers/video";

const CAPABILITIES: CapabilityId[] = ["chat", "tts", "image", "video"];

/** 1x1 transparent PNG — enough bytes to exercise a vision/edit wire call. */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export async function GET(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth.ok)
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const caps: Record<string, ReturnType<typeof publicCapability>> = {};
  for (const cap of CAPABILITIES) {
    caps[cap] = publicCapability(await getCapability(cap));
  }

  // READ FROM DATABASE (readLegacyZai), NOT THE FILE SYSTEM (readZaiCredentials)
  const legacy = await readLegacyZai();

  return NextResponse.json({
    zai: {
      provider: legacy.provider || "zai",
      baseUrl: legacy.baseUrl || DEFAULT_ZAI_BASE_URL,
      baseUrlSaved: Boolean(legacy.baseUrl),
      hasKey: Boolean(legacy.apiKey),
      maskedKey: maskKey(legacy.apiKey),
    },
    capabilities: caps,
    meta: CAPABILITY_META,
    providers: PROVIDERS_BY_CAPABILITY,
    defaults: {
      chatModel: DEFAULT_CHAT_MODEL,
      zaiBaseUrl: DEFAULT_ZAI_BASE_URL,
    },
  });
}

export async function PUT(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth.ok)
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  try {
    const body = await req.json();

    // ---- Scope 1: shared credentials (per-user zai.* preference rows) ----
    if (body.scope === "zai" || (!body.scope && !body.capability)) {
      const updates: Record<string, string> = {};

      const provider = String(body.provider ?? "zai").trim();
      if (provider) updates["zai.provider"] = provider;

      const baseUrl = String(body.baseUrl ?? "").trim();
      if (baseUrl) updates[ZAI_SETTING_KEYS.baseUrl] = baseUrl;

      const apiKey = String(body.apiKey ?? "").trim();
      if (apiKey) updates[ZAI_SETTING_KEYS.apiKey] = apiKey;

      if (Object.keys(updates).length === 0) {
        return NextResponse.json({ error: "Nothing to save" }, { status: 400 });
      }

      await setUserSettings(updates);
      await syncZaiConfigFile();
      resetZAIClient();
      invalidateZaiClients();

      const legacy = await readLegacyZai();
      return NextResponse.json({
        zai: {
          provider: legacy.provider || "zai",
          baseUrl: legacy.baseUrl || DEFAULT_ZAI_BASE_URL,
          hasKey: Boolean(legacy.apiKey),
          maskedKey: maskKey(legacy.apiKey),
        },
      });
    }

    // ---- Scope 2: one capability's provider ----
    const capability = String(body.capability ?? "") as CapabilityId;
    if (!CAPABILITIES.includes(capability)) {
      return NextResponse.json(
        { error: "Unknown capability" },
        { status: 400 },
      );
    }
    const patch: Partial<CapabilityConfig> = {};
    if (body.provider !== undefined) {
      const provider = String(body.provider).trim();
      const allowed: string[] = PROVIDERS_BY_CAPABILITY[capability].map(
        (p) => p.id,
      );
      if (!allowed.includes(provider)) {
        return NextResponse.json(
          { error: `Provider "${provider}" can't handle ${capability}` },
          { status: 400 },
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
      const source = await getCapability(
        String(body.copyCredsFrom) as CapabilityId,
      );
      if (!source.apiKey) {
        return NextResponse.json(
          { error: "The script provider has no saved key yet — save it first" },
          { status: 400 },
        );
      }
      patch.provider = source.provider;
      patch.baseUrl = source.baseUrl ?? "";
      patch.apiKey = source.apiKey;
    }

    const saved = await saveCapability(capability, patch);
    await syncZaiConfigFile();
    resetZAIClient();
    invalidateZaiClients();
    return NextResponse.json({ capability, config: publicCapability(saved) });
  } catch (err) {
    const message = errorText(err, "Invalid request");
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/** Test a capability end-to-end. Overrides are never saved. */
export async function POST(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth.ok)
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

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
  if (body.baseUrl !== undefined)
    overrides.baseUrl = String(body.baseUrl).trim();
  if (body.model !== undefined) overrides.model = String(body.model).trim();
  if (body.visionModel !== undefined)
    overrides.visionModel = String(body.visionModel).trim();
  const apiKeyOverride = String(body.apiKey ?? "").trim();
  if (apiKeyOverride) overrides.apiKey = apiKeyOverride;

  const started = Date.now();
  try {
    // Z.ai with an UNSAVED key needs the throwaway-client flow (the shared
    // SDK only reads the saved config).
    if (
      (provider === "zai" ||
        (!provider &&
          capability !== "tts" &&
          capability !== "image" &&
          capability !== "video")) &&
      apiKeyOverride
    ) {
      const zai = await createZaiForTest({
        baseUrl: overrides.baseUrl,
        apiKey: apiKeyOverride,
      });
      const savedChat = await getCapability("chat");
      const model =
        overrides.model?.trim() ||
        savedChat.model?.trim() ||
        DEFAULT_CHAT_MODEL;
      const completion = await zai.chat.completions.create({
        model,
        messages: [{ role: "user", content: "Reply with exactly: ok" }],
        thinking: { type: "disabled" },
      });
      const reply =
        (completion as { choices?: { message?: { content?: string } }[] })
          ?.choices?.[0]?.message?.content ?? "(empty response)";
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
          overrides,
        );
        return NextResponse.json({
          ok: true,
          capability,
          reply: (raw || "(empty response)").slice(0, 120),
          latencyMs: Date.now() - started,
        });
      }
      case "tts": {
        if (body.health === true) {
          const cfg = await getCapability("tts", overrides);
          if (cfg.provider === "selfhost") {
            const probe = await probeSelfhostHealth(overrides);
            return NextResponse.json({
              ok: probe.up,
              capability,
              reply: probe.up
                ? `${probe.detail} · ${probe.latencyMs} ms`
                : probe.detail,
              ...(probe.up ? { health: probe.health } : {}),
              latencyMs: probe.latencyMs,
            });
          }
        }
        const voice = String(body.voice ?? "").trim();
        const buffer = await ttsSynthesize(
          { input: "Connection test.", voice, speed: 1 },
          overrides,
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
        // S98 — the free lanes skip the paid-test confirm: pollinations
        // (keyless) and together's -Free model (blank model resolves to the
        // registry default, which IS the Free one). The predicate lives in
        // the adapter module so the UI hint and this gate can never drift.
        const imageTestModel = String(body.model ?? "").trim();
        if (!imageTestFreeLane(provider, imageTestModel) && !body.confirmCost) {
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
            overrides,
          );
          if (!buffer) {
            return NextResponse.json({
              ok: true,
              capability,
              reply:
                "Connected — but this model can't edit images (falls back to fresh generation)",
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
          {
            prompt:
              "A solid teal circle centered on a white background, minimal.",
            size: "1344x768",
          },
          overrides,
        );
        return NextResponse.json({
          ok: true,
          capability,
          reply: `Generated ${(buffer.length / 1024).toFixed(0)} KB PNG`,
          latencyMs: Date.now() - started,
        });
      }
      case "video": {
        const isFree = provider === "zai" || provider === "huggingface";
        if (!isFree && !body.confirmCost) {
          return NextResponse.json({
            ok: false,
            needsConfirm: true,
            error:
              "Video tests generate real clips and may cost money — confirm to run it",
          });
        }
        const buffer = await imageToVideo(
          {
            prompt: "A slow cinematic camera pan",
            imagePngBase64: TINY_PNG_BASE64,
          },
          overrides,
        );
        return NextResponse.json({
          ok: true,
          capability,
          bytes: buffer.length,
          reply: `Generated video clip (${(buffer.length / 1024).toFixed(0)} KB)`,
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
          overrides,
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
    const message = errorText(err, "Connection failed");
    return NextResponse.json(
      { ok: false, error: message.slice(0, 400) },
      { status: 200 },
    );
  } finally {
    resetZAIClient();
    invalidateZaiClients();
    await syncZaiConfigFile();
  }
}
