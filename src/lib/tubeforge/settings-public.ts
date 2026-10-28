// The Setting table stores BOTH shareable UI preferences AND SECRETS: OAuth
// client secrets + refresh tokens (ytClientSecret, ytRefreshToken, …),
// provider API keys (zai.apiKey, chat.apiKey, …), the studio password hash
// (auth.password), and OAuth handshake state (ytOAuthState). Those must never
// be handed back to the browser by /api/settings — credentials are surfaced
// ONLY in masked form by their dedicated endpoints:
//   /api/settings/ai    → masked provider keys (hasKey / maskedKey)
//   /api/youtube/status → connection state + channel title (no tokens)
// This module is the single allow-list of preference keys the settings UI
// actually consumes (Create form defaults, Settings form, music controls).
// It is intentionally DB-free so the offline unit suite can regression-test
// it (see scripts/test-unit.ts — "settings allow-list").

export const DEFAULT_SETTINGS: Record<string, string> = {
  defaultVoice: "jam",
  defaultSpeed: "1",
  defaultTone: "informative",
  defaultLength: "medium",
  defaultNiche: "Motivation",
  defaultThumbStyle: "cinematic",
  autoVoiceover: "true",
  autoThumbnail: "true",
  // Phase 3 — VLM quality gate
  qualityGate: "thumbnails", // off | thumbnails | all (thumbnails + storyboard scenes)
  qualityThreshold: "6", // 1-9 — below this the image is re-rolled once
  // Phase 3 — global AI rate budget
  aiBudgetEnabled: "true",
  aiLlmPerMin: "30",
  aiTtsPerMin: "12",
  aiImagePerMin: "8",
  aiVideoPerMin: "4",
  // Background music (music.ts reads these at render time)
  "music.enabled": "true",
  "music.mode": "auto", // auto | manual
  "music.trackId": "", // used when mode=manual
  "music.volume": "0.5",
  "music.fadeInSec": "1.5",
  "music.fadeOutSec": "2.5",
};

const PUBLIC_SETTING_KEYS = new Set(Object.keys(DEFAULT_SETTINGS));

/** True when a key is a shareable UI preference — never a credential. */
export function isPublicSettingKey(key: string): boolean {
  return PUBLIC_SETTING_KEYS.has(key);
}

/**
 * Default-merged settings map restricted to public preference keys.
 * Every other row in the Setting table (credentials, password hash, OAuth
 * state) is silently dropped instead of serialized to the client.
 */
export function publicSettingsMap(
  rows: { key: string; value: string }[]
): Record<string, string> {
  const map: Record<string, string> = { ...DEFAULT_SETTINGS };
  for (const row of rows) {
    if (PUBLIC_SETTING_KEYS.has(row.key)) map[row.key] = row.value;
  }
  return map;
}
