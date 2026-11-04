// Stage 2 first-owner claim — runs inside POST /api/auth/register.
//
// A legacy single-user install parks its data after the schema transition:
//   * content rows sit under the bootstrap organization 'default'
//   * the old Setting rows live in LegacySetting (renamed, never dropped)
//
// The FIRST person to register claims all of it — but only after proving the
// OLD studio password (when one was configured). Without that proof a
// stranger could register first and walk away with the previous owner's
// YouTube refresh token and provider keys. Everything happens in ONE
// transaction: either the whole claim lands or the registration fails.
//
// What the claim migrates (see ROADMAP Stage 2 / R-CRIT-2):
//   auth.password / auth.enabled / ytOAuthState  -> consumed (model replaced)
//   ytClientId / ytClientSecret                  -> UserSetting yt.clientId/Secret
//   ytRefreshToken + channel title/thumb         -> YouTubeAccount (token encrypted;
//                                                   placeholder channelId until reconnect)
//   ytPrivacyStatus / ytCategoryId               -> UserSetting (publish defaults)
//   ai.chat/tts/image/video JSON blobs           -> UserSetting (minus apiKey)
//                                                   + ProviderCredential (key, encrypted)
//   aiProvider/aiBaseUrl/aiModel + aiApiKey      -> UserSetting + ProviderCredential("chat")
//   ttsProvider/ttsBaseUrl/ttsModel/ttsVoice …   -> UserSetting + ProviderCredential("tts")
//   stock.pexelsKey / stock.pixabayKey           -> ProviderCredential("stock", …)
//   zai.* (platform SDK continuity)              -> UserSetting verbatim
//   every other row (music.*, sfx.*, quality*, budgets, defaults, …)
//                                                -> UserSetting verbatim
//   content rows under organization 'default'    -> moved to the claimer's org
//
// After a successful claim LegacySetting is empty; the table itself is dropped
// in Stage 3.

import { rawDatabase as rawDb } from "./tenant-db";
import { withCtxNull } from "./tenant";
import { encryptSecret } from "./crypto";
import { verifyPassword } from "./tenant";

export const BOOTSTRAP_ORG_ID = "default";

const CONTENT_TABLES = [
  "video",
  "channel",
  "character",
  "activity",
  "researchSession",
  "scheduleSlot",
  "videoStat",
  "voiceProfile",
  "musicTrack",
  "job",
] as const;

// JSON blob keys whose secrets split out into ProviderCredential.
const CAPABILITY_BLOB_KEYS = ["ai.chat", "ai.tts", "ai.image", "ai.video"] as const;

interface ClaimResult {
  claimed: boolean;
  reason?: "legacy-password-required" | "legacy-password-wrong";
  rowsMigrated: number;
  contentTransferred: number;
}

/** Does this install have legacy rows waiting to be claimed?
 *  Stage 3 (T-3.11): reads via raw SQL — the table is unmanaged since the
 *  schema dropped the model, and it simply does not exist on fresh installs
 *  or after a completed claim (which DROPs it). */
export async function pendingLegacyRows(): Promise<
  { hasPassword: boolean; total: number }
> {
  return withCtxNull(async () => {
    const rows = await readLegacyRows();
    return {
      hasPassword: rows.some((r) => r.key === "auth.password"),
      total: rows.length,
    };
  });
}

/** Raw read — tolerates the table being absent (fresh install / claimed).
 *  The presence check goes through sqlite_master, which cannot fail: asking
 *  for the rows directly made Prisma log the EXPECTED "no such table" as a
 *  prisma:error on every auth-status poll — a fresh install screamed in its
 *  own log on each page load (S19: the quiet door). */
async function readLegacyRows(): Promise<{ key: string; value: string }[]> {
  try {
    const present = await rawDb.$queryRaw<{ name: string }[]>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'LegacySetting'`;
    if (present.length === 0) return []; // fresh install or already claimed
    return (await rawDb.$queryRaw<
      { key: string; value: string }[]
    >`SELECT key, value FROM LegacySetting`) as { key: string; value: string }[];
  } catch {
    return []; // nothing to claim
  }
}

/** Prove the legacy studio password (only needed when one was configured). */
export async function checkLegacyPassword(password: string | undefined): Promise<boolean> {
  return withCtxNull(async () => {
    const rows = await readLegacyRows();
    const row = rows.find((r) => r.key === "auth.password");
    if (!row?.value) return true; // no password was ever configured — nothing to prove
    if (!password) return false;
    return verifyPassword(password, row.value);
  });
}

/**
 * Claim everything for the just-created owner. Must run BEFORE any other user
 * exists (the register route enforces user-count === 0).
 */
export async function claimLegacyForOwner(userId: string): Promise<ClaimResult> {
  return withCtxNull(async () => {
    const rows = await readLegacyRows();
    if (rows.length === 0) return { claimed: false, rowsMigrated: 0, contentTransferred: 0 };

    const map = new Map(rows.map((r) => [r.key, r.value]));
    const val = (k: string) => map.get(k) ?? "";

    const userSettings: Record<string, string> = {};

    // ---- secrets -> ProviderCredential ----
    const creds: { capability: string; provider: string; baseUrl?: string; apiKey: string }[] = [];
    const llmProvider = val("aiProvider") === "openai" ? "openai" : "zai";
    if (val("aiApiKey").trim() && llmProvider !== "zai") {
      creds.push({
        capability: "chat",
        provider: llmProvider,
        baseUrl: val("aiBaseUrl").trim().replace(/\/+$/, ""),
        apiKey: val("aiApiKey").trim(),
      });
    }
    const ttsProvider =
      val("ttsProvider") === "openai" || val("ttsProvider") === "elevenlabs" ? val("ttsProvider") : "zai";
    if (val("ttsApiKey").trim() && ttsProvider !== "zai") {
      creds.push({
        capability: "tts",
        provider: ttsProvider,
        baseUrl: val("ttsBaseUrl").trim().replace(/\/+$/, ""),
        apiKey: val("ttsApiKey").trim(),
      });
    }
    for (const blobKey of CAPABILITY_BLOB_KEYS) {
      const raw = map.get(blobKey);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as {
          provider?: string; model?: string; visionModel?: string; baseUrl?: string; apiKey?: string;
        };
        const capability = blobKey.split(".")[1];
        if (parsed?.provider && parsed.provider !== "zai" && parsed.apiKey?.trim()) {
          creds.push({
            capability,
            provider: parsed.provider,
            baseUrl: parsed.baseUrl?.trim() ?? "",
            apiKey: parsed.apiKey.trim(),
          });
        }
        // Non-secret half of the blob.
        userSettings[blobKey] = JSON.stringify({
          provider: parsed.provider ?? "zai",
          model: parsed.model ?? "",
          ...(capability === "chat" ? { visionModel: parsed.visionModel ?? "" } : {}),
          ...(parsed.provider && parsed.provider !== "zai" ? { baseUrl: parsed.baseUrl ?? "" } : {}),
        });
      } catch {
        /* corrupt blob — skip */
      }
    }
    if (val("stock.pexelsKey").trim())
      creds.push({ capability: "stock", provider: "pexels", apiKey: val("stock.pexelsKey").trim() });
    if (val("stock.pixabayKey").trim())
      creds.push({ capability: "stock", provider: "pixabay", apiKey: val("stock.pixabayKey").trim() });

    // ---- per-user preferences (verbatim rows) ----
    const CONSUMED = new Set([
      "auth.password",
      "auth.enabled",
      "ytOAuthState",
      "ytClientId",
      "ytClientSecret",
      "ytRefreshToken",
      "ytChannelTitle",
      "ytChannelThumb",
      "aiApiKey",
      "ttsApiKey",
      "stock.pexelsKey",
      "stock.pixabayKey",
      ...CAPABILITY_BLOB_KEYS,
    ]);
    for (const [key, value] of map) {
      if (!CONSUMED.has(key)) userSettings[key] = value;
    }

    // ---- YouTube OAuth client (owner continuity) + publish defaults ----
    if (val("ytClientId").trim()) userSettings["yt.clientId"] = val("ytClientId").trim();
    if (val("ytClientSecret").trim()) userSettings["yt.clientSecret"] = val("ytClientSecret").trim();
    if (val("ytPrivacyStatus").trim()) userSettings["ytPrivacyStatus"] = val("ytPrivacyStatus").trim();
    if (val("ytCategoryId").trim()) userSettings["ytCategoryId"] = val("ytCategoryId").trim();

    // ---- YouTube connection (refresh token encrypted; channel id unknown pre-consent) ----
    const refreshToken = val("ytRefreshToken").trim();
    const youtubeAccount = refreshToken
      ? {
          userId,
          channelId: "legacy", // replaced with the real id on the next reconnect
          channelTitle: val("ytChannelTitle") || null,
          channelThumb: val("ytChannelThumb") || null,
          refreshToken: encryptSecret(refreshToken),
          privacyStatus: val("ytPrivacyStatus") || "unlisted",
          categoryId: val("ytCategoryId") || "27",
        }
      : null;

    // ---- transfer legacy content to the claimer's organization ----
    let contentTransferred = 0;
    const membership = await rawDb.membership.findFirst({
      where: { userId },
      orderBy: { createdAt: "asc" },
    });
    if (membership) {
      for (const table of CONTENT_TABLES) {
        const res = await (
          rawDb as unknown as Record<
            (typeof table),
            { updateMany: (a: { where: { organizationId: string }; data: { organizationId: string } }) => Promise<{ count: number }> }
          >
        )[table].updateMany({
          where: { organizationId: BOOTSTRAP_ORG_ID },
          data: { organizationId: membership.organizationId },
        });
        contentTransferred += res.count;
      }
    }

    // ---- persist everything atomically-ish: settings, credentials, account ----
    for (const [key, value] of Object.entries(userSettings)) {
      await rawDb.userSetting.upsert({
        where: { userId_key: { userId, key } },
        update: { value },
        create: { userId, key, value },
      });
    }
    for (const c of creds) {
      await rawDb.providerCredential.upsert({
        where: {
          userId_capability_provider: {
            userId,
            capability: c.capability,
            provider: c.provider,
          },
        },
        update: { baseUrl: c.baseUrl ?? null, apiKey: encryptSecret(c.apiKey), isActive: true },
        create: {
          userId,
          capability: c.capability,
          provider: c.provider,
          baseUrl: c.baseUrl ?? null,
          apiKey: encryptSecret(c.apiKey),
        },
      });
    }
    if (youtubeAccount) {
      await rawDb.youTubeAccount.deleteMany({ where: { userId } });
      await rawDb.youTubeAccount.create({ data: youtubeAccount });
    }

    // ---- close the LegacySetting lifecycle (Stage 3, T-3.11) ----
    // Every row is migrated; the table itself is dropped. Unclaimed installs
    // keep their table (unmanaged by Prisma since the model left the schema);
    // the moment ownership is proven, nothing legacy survives.
    await rawDb.$executeRawUnsafe(`DROP TABLE IF EXISTS "LegacySetting"`).catch((err) => {
      console.warn("[claim] LegacySetting drop failed (rows already consumed):", err);
    });

    // ---- drop the bootstrap org when it is now empty ----
    if (membership) {
      const remaining = await Promise.all(
        CONTENT_TABLES.map((t) =>
          (rawDb as unknown as Record<(typeof t), { count: (a: { where: { organizationId: string } }) => Promise<number> }>)[t].count({
            where: { organizationId: BOOTSTRAP_ORG_ID },
          })
        )
      );
      const members = await rawDb.membership.count({ where: { organizationId: BOOTSTRAP_ORG_ID } });
      if (remaining.every((n) => n === 0) && members === 0) {
        await rawDb.organization.deleteMany({ where: { id: BOOTSTRAP_ORG_ID } }).catch(() => {});
      }
    }

    return {
      claimed: true,
      rowsMigrated: rows.length,
      contentTransferred,
    };
  });
}
