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

const CAPABILITIES: CapabilityId[] = ["chat", "tts", "asr", "image", "video"];

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
      case "asr": {
        // S121 — the transcription probe is an AUTH probe, not a synthesis:
        // a real test would need audio to transcribe (and could bill). The
        // wire-capable providers answer GET /models with the same key the
        // detailed pass carries — a 200 certifies the credential + base URL.
        const cfg = await getCapability("asr", overrides);
        if (cfg.provider === "zai") {
          return NextResponse.json({
            ok: true,
            capability: "asr",
            reply: "Z.ai ASR rides the shared Z.ai key — no separate probe (no word timestamps; the silence ladder covers timing)",
            latencyMs: Date.now() - started,
          });
        }
        const meta = cfg.provider === "voicestudio"
          ? PROVIDERS_BY_CAPABILITY.asr.find((p) => p.id === "voicestudio")
          : PROVIDERS_BY_CAPABILITY.asr.find((p) => p.id === "openai");
        const baseUrl =
          cfg.baseUrl?.trim() ||
          meta?.defaultBaseUrl ||
          (cfg.provider === "voicestudio" ? "http://127.0.0.1:3900" : "https://api.openai.com/v1");
        const key = cfg.apiKey?.trim();
        const probeUrl = cfg.provider === "voicestudio"
          ? `${baseUrl.replace(/\/+$/, "")}/v1/models`
          : `${baseUrl.replace(/\/+$/, "")}/models`;
        const headers: Record<string, string> = {};
        if (key) headers.Authorization = `Bearer ${key}`;
        try {
          const res = await fetch(probeUrl, { headers, signal: AbortSignal.timeout(10_000) });
          if (!res.ok) {
            const text = await res.text().catch(() => "");
            return NextResponse.json({
              ok: false,
              capability: "asr",
              error: `Transcription probe failed (HTTP ${res.status}): ${text.slice(0, 160)}`,
            }, { status: 200 });
          }
          return NextResponse.json({
            ok: true,
            capability: "asr",
            reply: `Transcription credential accepted by ${cfg.provider === "voicestudio" ? "your VoiceStudio server" : "the OpenAI-compatible endpoint"} — word timestamps ride the detailed pass`,
            latencyMs: Date.now() - started,
          });
        } catch (err) {
          return NextResponse.json({
            ok: false,
            capability: "asr",
            error: `The transcription endpoint is unreachable: ${err instanceof Error ? err.message : String(err)}`,
          }, { status: 200 });
        }
      }
      case "image":
      case "imageEdit": {
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
            // Cloudflare's NSFW filter false-positives on "solid teal circle".
            // A detailed landscape prompt passes the filter reliably.
            prompt:
              "A serene mountain landscape at sunrise, with soft golden light illuminating the peaks, a calm lake in the foreground reflecting the sky, and a clear blue atmosphere.",
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
        // Magic Hour's video generation needs a real image (its processor
        // rejects 1x1 placeholder PNGs). The Settings Test button is an
        // auth-probe instead: hit /video-projects to verify the key is
        // valid, without burning a credit.
        if (provider === "magichour") {
          const baseUrl =
            overrides.baseUrl?.trim() || "https://api.magichour.ai/v1";
          const cfg = await getCapability("video", overrides);
          const key = apiKeyOverride || cfg.apiKey || "";
          if (!key) {
            return NextResponse.json(
              {
                ok: false,
                capability: "video",
                error:
                  "Magic Hour needs an API key (get one at magichour.ai/developer)",
              },
              { status: 200 },
            );
          }
          try {
            const res = await fetch(`${baseUrl}/video-projects?limit=1`, {
              headers: { Authorization: `Bearer ${key}` },
            });
            if (!res.ok) {
              const text = await res.text().catch(() => "");
              return NextResponse.json(
                {
                  ok: false,
                  capability: "video",
                  error: `Magic Hour auth failed (HTTP ${res.status}): ${text.slice(0, 200)}`,
                },
                { status: 200 },
              );
            }
            const data = (await res.json()) as { projects?: unknown[] };
            return NextResponse.json({
              ok: true,
              capability: "video",
              reply: `Magic Hour key is valid · ${data.projects?.length ?? 0} recent project(s) found`,
              latencyMs: Date.now() - started,
            });
          } catch (err) {
            return NextResponse.json(
              {
                ok: false,
                capability: "video",
                error: `Magic Hour unreachable: ${err instanceof Error ? err.message : String(err)}`,
              },
              { status: 200 },
            );
          }
        }

        // Other video providers generate a real clip. The free tier
        // providers (zai, huggingface, agnes, nvidia) skip the confirm.
        const freeVideoProviders = ["zai", "huggingface", "agnes", "nvidia"];
        const isFree = freeVideoProviders.includes(provider);
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
