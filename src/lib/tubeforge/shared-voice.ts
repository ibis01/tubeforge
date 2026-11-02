// Platform-shared voice server (operator feature).
//
// A self-hosted Chatterbox voice server (voice-server/voice_server.py) is
// normally each USER's own machine — they paste its URL+key under Settings →
// AI Providers → Voiceover. On a self-hosted TubeForge deployment the
// OPERATOR can additionally run ONE voice server next to the app and expose
// it to every user via two env vars:
//
//   TUBEFORGE_SHARED_VOICE_URL=http://127.0.0.1:8931
//   TUBEFORGE_SHARED_VOICE_KEY=<the --key the server was started with>
//
// Precedence everywhere: the user's OWN saved self-hosted credentials always
// win; the shared server is only a fallback for users who haven't configured
// their own. On Vercel/serverless these env vars stay unset and nothing
// changes.
//
// This module is deliberately dependency-free (env only) so both
// providers/tts.ts and voice-clone.ts can use it without import cycles.

export interface VoiceEndpoint {
  baseUrl: string;
  apiKey: string;
  /** true = the platform-shared server (env), false = the user's own. */
  shared: boolean;
}

/** The operator-configured shared voice server, or null when unset. */
export function sharedVoiceServer(): { baseUrl: string; apiKey: string } | null {
  const baseUrl = process.env.TUBEFORGE_SHARED_VOICE_URL?.trim();
  if (!baseUrl) return null;
  return {
    baseUrl,
    apiKey: process.env.TUBEFORGE_SHARED_VOICE_KEY?.trim() || "",
  };
}

/**
 * The effective self-hosted endpoint for a user: their saved baseUrl/key if
 * present, otherwise the platform-shared server, otherwise the conventional
 * local default. Returns null only when NOTHING is configured (no user
 * credential, no shared env, no default) — callers then surface their own
 * "configure the voice server" guidance.
 */
export function selfhostEndpoint(
  userBaseUrl?: string,
  userApiKey?: string,
): VoiceEndpoint | null {
  const baseUrl = userBaseUrl?.trim();
  if (baseUrl) {
    return { baseUrl, apiKey: userApiKey?.trim() || "", shared: false };
  }
  const shared = sharedVoiceServer();
  if (shared) return { ...shared, shared: true };
  // No user server, no shared server: the conventional local default only
  // when the user explicitly chose the selfhost provider (empty key/baseUrl
  // in Settings) — signalled by apiKey being undefined-but-called. We can't
  // distinguish that here, so callers pass the provider default explicitly.
  return null;
}
