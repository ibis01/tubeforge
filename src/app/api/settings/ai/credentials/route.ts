// PUT /api/settings/ai/credentials — save credentials for a provider WITHOUT
// making it the active TTS/image/etc provider. Used by the inline clone-setup
// form so users can paste their self-hosted voice server URL+key without
// flipping their active Z.ai voiceover away.
//
// Body:
//   { capability: "tts"|"image"|..., provider: "selfhost"|"zhipu"|...,
//     baseUrl?: string, apiKey?: string }
//
// Empty apiKey = keep existing key (caller is masked).

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/tubeforge/tenant";
import { upsertProviderCredential } from "@/lib/tubeforge/settings";
import { getProviderCredential } from "@/lib/tubeforge/providers/settings";
import { PROVIDERS_BY_CAPABILITY, type CapabilityId } from "@/lib/tubeforge/providers/registry";
import { errorText } from "@/lib/tubeforge/redact";

export async function PUT(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();
  const userId = auth.ctx.userId;
  if (!userId) return NextResponse.json({ error: "No user" }, { status: 401 });

  try {
    const body = (await req.json()) as {
      capability?: string;
      provider?: string;
      baseUrl?: string;
      apiKey?: string;
    };
    const capability = String(body.capability ?? "") as CapabilityId;
    if (!PROVIDERS_BY_CAPABILITY[capability]) {
      return NextResponse.json({ error: "Unknown capability" }, { status: 400 });
    }
    const provider = String(body.provider ?? "").trim();
    const allowed = PROVIDERS_BY_CAPABILITY[capability].map((p) => p.id);
    if (!allowed.includes(provider)) {
      return NextResponse.json(
        { error: `Provider "${provider}" can't handle ${capability}` },
        { status: 400 },
      );
    }
    const baseUrl = String(body.baseUrl ?? "").trim();
    // Empty apiKey = keep the saved one (the inline form's key field is blank).
    const incomingKey = body.apiKey === undefined ? undefined : String(body.apiKey).trim();
    const existing = await getProviderCredential(capability, provider);
    const apiKey = incomingKey === "" || incomingKey === undefined
      ? existing?.apiKey ?? ""
      : incomingKey;
    if (!baseUrl && !apiKey && !existing?.baseUrl) {
      return NextResponse.json(
        { error: "Provide at least a base URL or an API key" },
        { status: 400 },
      );
    }
    await upsertProviderCredential(userId, capability, provider, {
      baseUrl,
      apiKey,
    });
    return NextResponse.json({
      capability,
      provider,
      saved: { hasBaseUrl: Boolean(baseUrl), hasKey: Boolean(apiKey) },
    });
  } catch (err) {
    return NextResponse.json({ error: errorText(err, "Couldn't save") }, { status: 400 });
  }
}
