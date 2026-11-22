// Per-user settings — replaces the global Setting table (R-CRIT-2).
//
// Non-secret preferences live in UserSetting (one row per user+key). Secrets
// (provider API keys) live in ProviderCredential, AES-256-GCM encrypted at
// rest (crypto.ts) — never in a preference row, never sent to the browser.
//
// All accessors require a tenant context (assertCtx) — they are called from
// request handlers and job bodies, both of which carry the acting user via
// tenant-db/ALS. Auth bootstrap paths (register claim) use the raw client
// directly and never come through here.

import { decryptSecret, encryptSecret } from "./crypto";
import { assertCtx } from "./tenant";
import { rawDatabase as rawDb } from "./tenant-db";

// ---------------------------------------------------------------------------
// UserSetting (preferences — music, sfx, quality gates, budgets, defaults, …)

export async function getUserSetting(key: string): Promise<string | null> {
  const ctx = assertCtx("settings.getUserSetting");
  const row = await rawDb.userSetting.findUnique({
    where: { userId_key: { userId: ctx.userId, key } },
  });
  return row?.value ?? null;
}

export async function getUserSettings(keys: string[]): Promise<Map<string, string>> {
  const ctx = assertCtx("settings.getUserSettings");
  if (!keys.length) return new Map();
  const rows = await rawDb.userSetting.findMany({
    where: { userId: ctx.userId, key: { in: keys } },
  });
  return new Map(rows.map((r) => [r.key, r.value]));
}

export async function setUserSetting(key: string, value: string): Promise<void> {
  const ctx = assertCtx("settings.setUserSetting");
  await rawDb.userSetting.upsert({
    where: { userId_key: { userId: ctx.userId, key } },
    update: { value },
    create: { userId: ctx.userId, key, value },
  });
}

export async function deleteUserSetting(key: string): Promise<void> {
  const ctx = assertCtx("settings.deleteUserSetting");
  await rawDb.userSetting.deleteMany({ where: { userId: ctx.userId, key } });
}

/** Upsert several preference rows in one call (settings forms save in bulk). */
export async function setUserSettings(entries: Record<string, string>): Promise<void> {
  const ctx = assertCtx("settings.setUserSettings");
  const keys = Object.keys(entries);
  if (!keys.length) return;
  for (const key of keys) {
    await rawDb.userSetting.upsert({
      where: { userId_key: { userId: ctx.userId, key } },
      update: { value: entries[key] },
      create: { userId: ctx.userId, key, value: entries[key] },
    });
  }
}

// ---------------------------------------------------------------------------
// ProviderCredential (secrets, encrypted at rest)

export interface ProviderKey {
  baseUrl: string;
  apiKey: string; // decrypted plaintext — server-side only
}

export async function getProviderCredential(
  capability: string,
  provider: string
): Promise<ProviderKey | null> {
  const ctx = assertCtx("settings.getProviderCredential");
  const row = await rawDb.providerCredential.findUnique({
    where: {
      userId_capability_provider: {
        userId: ctx.userId,
        capability,
        provider,
      },
    },
  });
  if (!row || !row.isActive) return null;
  return { baseUrl: row.baseUrl ?? "", apiKey: decryptSecret(row.apiKey) };
}

export async function upsertProviderCredential(
  userId: string,
  capability: string,
  provider: string,
  value: { baseUrl?: string; apiKey: string }
): Promise<void> {
  await rawDb.providerCredential.upsert({
    where: {
      userId_capability_provider: { userId, capability, provider },
    },
    update: {
      baseUrl: value.baseUrl ?? null,
      apiKey: encryptSecret(value.apiKey),
      isActive: true,
    },
    create: {
      userId,
      capability,
      provider,
      baseUrl: value.baseUrl ?? null,
      apiKey: encryptSecret(value.apiKey),
    },
  });
}

export async function deleteProviderCredential(
  userId: string,
  capability: string,
  provider: string
): Promise<void> {
  await rawDb.providerCredential.deleteMany({
    where: { userId, capability, provider },
  });
}

/** S186 — the credentials map plus the providers whose rows could not be
 *  decrypted (rotated/missing TUBEFORGE_ENCRYPTION_KEY). Callers degrade per
 *  provider instead of failing the whole read. */
export interface ProviderCredentialMap
  extends Map<string, { baseUrl: string; apiKey: string }> {
  unreadable: string[];
}

/** S159 — EVERY saved credential for one capability, keyed by provider id.
 *  The settings GET serves this map so the UI can show each provider's own
 *  saved key state (masked) — switching providers never reads as "the key
 *  disappeared" when the row for the other provider still exists.
 *
 *  S186 — decrypt-failure isolation: a row whose ciphertext no longer
 *  matches TUBEFORGE_ENCRYPTION_KEY (rotated key is the historical trigger)
 *  is SKIPPED and reported in `unreadable` instead of throwing through the
 *  whole GET. One unreadable key degrades to "that provider shows no key" —
 *  it never 500s the settings page or erases the saved provider selection. */
export async function listProviderCredentials(
  capability: string
): Promise<ProviderCredentialMap> {
  const ctx = assertCtx("settings.listProviderCredentials");
  const rows = await rawDb.providerCredential.findMany({
    where: { userId: ctx.userId, capability, isActive: true },
  });
  const map = new Map<
    string,
    { baseUrl: string; apiKey: string }
  >() as ProviderCredentialMap;
  map.unreadable = [];
  for (const row of rows) {
    try {
      map.set(row.provider, {
        baseUrl: row.baseUrl ?? "",
        apiKey: decryptSecret(row.apiKey),
      });
    } catch {
      map.unreadable.push(row.provider);
    }
  }
  return map;
}
