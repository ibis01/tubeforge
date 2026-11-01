// GET /api/voices/clone-providers — the clone-capable provider state for the
// inline "Clone" tab in the video detail dialog and the Voice Studio.
//
// Returns:
//   { pick: { provider, status, hint },  // best provider to use right now
//     selfhost: { hasBaseUrl, hasKey },  // saved selfhost creds presence
//     zhipu:   { hasKey } }              // saved zhipu key presence
//
// The frontend uses `pick.status` to decide whether to show a one-line inline
// setup form (URL+key for selfhost) before the clone button, vs. just the
// clone form when the chosen provider is ready.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/tubeforge/tenant";
import { getCapability, getProviderCredential } from "@/lib/tubeforge/providers/settings";
import { isCloneProvider, pickCloneProvider } from "@/lib/tubeforge/voice-clone";

export async function GET(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const pick = await pickCloneProvider();
  const active = await getCapability("tts");

  // If the active TTS provider is itself clone-capable and fully configured,
  // honor it (the user explicitly chose it in Settings).
  let chosen = pick;
  if (isCloneProvider(active.provider)) {
    if (active.provider === "selfhost" && (active.baseUrl?.trim() || active.apiKey?.trim())) {
      chosen = {
        provider: "selfhost",
        status: "ready",
        hint: "Clones use your self-hosted Chatterbox server.",
      };
    } else if (active.provider === "zhipu" && active.apiKey?.trim()) {
      chosen = {
        provider: "zhipu",
        status: "zhipu-ready",
        hint: "Clones use your Zhipu GLM-TTS account.",
      };
    }
  }

  const selfhostCred = await getProviderCredential("tts", "selfhost");
  const zhipuCred = await getProviderCredential("tts", "zhipu");

  return NextResponse.json({
    pick: chosen,
    selfhost: {
      hasBaseUrl: Boolean(selfhostCred?.baseUrl?.trim()),
      hasKey: Boolean(selfhostCred?.apiKey?.trim()),
    },
    zhipu: {
      hasKey: Boolean(zhipuCred?.apiKey?.trim()),
    },
  });
}
