// YouTube Data API v3 integration — Stage 2 per-user edition.
//
// OAuth 2.0 install-app flow, one connection PER USER (YouTubeAccount rows;
// refresh/access tokens AES-256-GCM encrypted at rest):
//   consent URL (state = signed short-lived token carrying uid)
//   -> callback verifies the state signature + uid
//   -> exchanges the code for a refresh token
//   -> fetches the channel id/title/thumb -> upserts YouTubeAccount
//
// The OAuth client id/secret are server-wide: env TUBEFORGE_YT_CLIENT_ID /
// TUBEFORGE_YT_CLIENT_SECRET first; the claiming owner's legacy rows
// (UserSetting yt.clientId / yt.clientSecret, migrated from the old Setting
// table) serve as the fallback — see the register claim flow.
//
// Upload = YouTube resumable API: initiate a session with video metadata,
// PUT the MP4 bytes, then set the custom thumbnail. No external deps — plain
// fetch against Google endpoints, with actionable error surfacing so users
// can fix quota / auth / scope problems without reading Google's docs.

import { db as rawDb } from "@/lib/db";
import { decryptSecret, encryptSecret } from "./crypto";
import { currentCtx } from "./tenant";
import { getUserSettings, setUserSetting } from "./settings";
import { createSignedToken, getAuthSecret, verifyToken } from "./auth-token";
import { redactText } from "./redact";
import { log } from "./log";

// S57/T-57.2 — the module's logger (the old [youtube] prefix became a binding).
const ytLog = log.child({ mod: "youtube" });
import { timeoutFor, type ProviderCapability } from "./providers/http";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
].join(" ");

/**
 * Every YouTube fetch goes through the D-09 timeout matrix — the audit found
 * these direct `fetch` calls with NO timeout, so one hung Google request
 * could stall an OAuth callback or upload job forever.
 * youtube-api: 30s (metadata + OAuth) · youtube-upload: 60min (resumable PUT).
 */
async function ytFetch(
  url: string,
  init: RequestInit,
  capability: Extract<ProviderCapability, "youtube-api" | "youtube-upload"> = "youtube-api"
): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutFor(capability)) });
}

// ---------- OAuth client (server-wide) ----------

async function getYtOAuthClient(): Promise<{ clientId: string; clientSecret: string }> {
  const envId = process.env.TUBEFORGE_YT_CLIENT_ID?.trim() || "";
  const envSecret = process.env.TUBEFORGE_YT_CLIENT_SECRET?.trim() || "";
  if (envId && envSecret) return { clientId: envId, clientSecret: envSecret };

  // Legacy fallback: the claiming owner's migrated rows (same exposure model
  // as the old global Setting rows; moves to encrypted storage in Stage 3).
  const ctx = currentCtx();
  if (ctx) {
    const map = await getUserSettings(["yt.clientId", "yt.clientSecret"]);
    const id = map.get("yt.clientId")?.trim() || "";
    const secret = map.get("yt.clientSecret")?.trim() || "";
    if (id && secret) return { clientId: id, clientSecret: secret };
  }
  throw new Error("YouTube OAuth client is not configured");
}

// ---------- helpers ----------

export function callbackUrlFor(origin: string): string {
  return `${origin.replace(/\/$/, "")}/api/youtube/callback`;
}

function requireCtx() {
  const ctx = currentCtx();
  if (!ctx) throw new Error("This YouTube action requires a signed-in user");
  return ctx;
}

// ---------- OAuth ----------

/** Consent URL the settings UI opens in a new tab. State = signed token (uid inside). */
export async function buildAuthUrl(origin: string): Promise<string> {
  const { clientId } = await getYtOAuthClient();
  const ctx = requireCtx();

  const secret = getAuthSecret();
  if (!secret) throw new Error("TUBEFORGE_AUTH_SECRET is not configured");
  const state = await createSignedToken("state", 600, secret, { uid: ctx.userId });
  if (!state) throw new Error("Could not sign the OAuth state");

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrlFor(origin),
    response_type: "code",
    scope: SCOPES,
    access_type: "offline", // we need a refresh token
    prompt: "consent", // always hand back refresh_token on reconnects
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

/** Verify a returned OAuth state token -> the uid that started the flow. */
export async function verifyOAuthState(
  state: string | null | undefined
): Promise<{ uid: string } | null> {
  const secret = getAuthSecret();
  if (!secret || !state) return null;
  const payload = await verifyToken(state, secret);
  return payload && payload.s === "state" && payload.uid ? { uid: payload.uid } : null;
}

/** Exchange the consent callback code for tokens; persists the per-user account. */
export async function exchangeCode(code: string, origin: string): Promise<void> {
  const ctx = requireCtx();
  const { clientId, clientSecret } = await getYtOAuthClient().catch(() => {
    throw new Error("YouTube OAuth client is not configured");
  });

  const res = await ytFetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: callbackUrlFor(origin),
      grant_type: "authorization_code",
    }),
  });

  const data = await res.json().catch(() => ({}));
  const refreshToken = (data as { refresh_token?: string }).refresh_token;
  const accessToken = (data as { access_token?: string }).access_token;
  if (!res.ok || !refreshToken || !accessToken) {
    const reason = (data as { error_description?: string }).error_description;
    throw new Error(
      `Google rejected the OAuth code${reason ? `: ${reason}` : ""} — reconnect the channel and complete consent again.`
    );
  }

  // Learn the channel id/title/thumb right away (also proves the token works).
  const channel = await ytFetch(
    "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!channel.ok) {
    throw new Error("Connected, but the channel lookup failed — reconnect to retry.");
  }
  const chData = (await channel.json()) as {
    items?: { id?: string; snippet?: { title?: string; thumbnails?: { default?: { url?: string } } } }[];
  };
  const item = chData.items?.[0];
  if (!item?.id) throw new Error("This Google account has no YouTube channel");

  // Replace any earlier connection for this user (one channel per user).
  await rawDb.youTubeAccount.deleteMany({ where: { userId: ctx.userId } });
  await rawDb.youTubeAccount.create({
    data: {
      userId: ctx.userId,
      channelId: item.id,
      channelTitle: item.snippet?.title ?? null,
      channelThumb: item.snippet?.thumbnails?.default?.url ?? null,
      refreshToken: encryptSecret(refreshToken),
      accessToken: encryptSecret(accessToken),
      tokenExpiresAt: new Date(Date.now() + 50 * 60 * 1000),
    },
  });
}

// ---------- account lookup + access tokens ----------

async function getAccount(userId: string) {
  return rawDb.youTubeAccount.findFirst({ where: { userId } });
}

export async function isConnected(): Promise<boolean> {
  const ctx = currentCtx();
  if (!ctx) return false;
  return Boolean(await getAccount(ctx.userId));
}

interface TokenCache {
  token: string;
  expiresAt: number;
}
const g = globalThis as typeof globalThis & { __tfYtTokens?: Map<string, TokenCache> };
const tokenCache: Map<string, TokenCache> = (g.__tfYtTokens ??= new Map());

/** Fresh access token for the acting user (cached ~50 min, encrypted at rest). */
export async function getAccessToken(): Promise<string> {
  const ctx = requireCtx();
  const cached = tokenCache.get(ctx.userId);
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const account = await getAccount(ctx.userId);
  if (!account)
    throw new Error("YouTube channel is not connected — connect it in Settings → Channel");

  const { clientId, clientSecret } = await getYtOAuthClient();
  const res = await ytFetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: decryptSecret(account.refreshToken),
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  });

  const data = await res.json().catch(() => ({}));
  const accessToken = (data as { access_token?: string }).access_token;
  if (!res.ok || !accessToken) {
    const err = (data as { error?: string; error_description?: string });
    // A dead refresh token requires re-consent — clear the connection so the UI says so.
    if (err.error === "invalid_grant") {
      await rawDb.youTubeAccount.deleteMany({ where: { userId: ctx.userId } });
      tokenCache.delete(ctx.userId);
      throw new Error(
        "Google session expired — reconnect the channel in Settings (the stored token was revoked)."
      );
    }
    throw new Error(
      `Could not refresh the YouTube access token${err.error_description ? `: ${err.error_description}` : ""}`
    );
  }

  const expiresAt = Date.now() + 50 * 60 * 1000;
  tokenCache.set(ctx.userId, { token: accessToken, expiresAt });
  await rawDb.youTubeAccount.update({
    where: { id: account.id },
    data: {
      accessToken: encryptSecret(accessToken),
      tokenExpiresAt: new Date(expiresAt),
    },
  });
  return accessToken;
}

// ---------- channel info ----------

export interface ChannelInfo {
  title: string;
  thumbUrl: string | null;
}

/** Fetch the connected channel's title + avatar (also proves the token works). */
export async function fetchChannelInfo(): Promise<ChannelInfo> {
  const ctx = requireCtx();
  const account = await getAccount(ctx.userId);
  if (account?.channelTitle) {
    return { title: account.channelTitle, thumbUrl: account.channelThumb ?? null };
  }
  const token = await getAccessToken();
  const res = await ytFetch(
    "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      `YouTube API rejected the channel lookup (${res.status}): ${(body as { error?: { message?: string } }).error?.message ?? "unknown"}`
    );
  }
  const data = (await res.json()) as {
    items?: { snippet?: { title?: string; thumbnails?: { default?: { url?: string } } } }[];
  };
  const channel = data.items?.[0];
  if (!channel) throw new Error("This Google account has no YouTube channel");
  return {
    title: channel.snippet?.title ?? "Unknown channel",
    thumbUrl: channel.snippet?.thumbnails?.default?.url ?? null,
  };
}

// ---------- performance stats ----------

/** https://youtu.be/<id> -> <id> (also accepts watch?v= and /shorts/ forms). */
export function youtubeIdFromUrl(url: string): string | null {
  const m =
    /^https?:\/\/(?:www\.)?youtu\.be\/([\w-]{6,})/.exec(url) ??
    /^https?:\/\/(?:www\.)?youtube\.com\/watch\?v=([\w-]{6,})/.exec(url) ??
    /^https?:\/\/(?:www\.)?youtube\.com\/shorts\/([\w-]{6,})/.exec(url);
  return m ? m[1] : null;
}

export interface RemoteVideoStats {
  youtubeId: string;
  views: number;
  likes: number;
  comments: number;
  favorites: number;
  publishedAt: string | null; // ISO from the API
}

/**
 * Fetch statistics + publish dates for up to 50 uploaded videos in ONE
 * videos.list call. Callers reconcile the returned set against the ids they
 * asked for (missing = private / deleted / wrong account).
 */
export async function fetchVideoStats(youtubeIds: string[]): Promise<Map<string, RemoteVideoStats>> {
  if (youtubeIds.length === 0) return new Map();
  if (youtubeIds.length > 50)
    throw new Error("Sync more than 50 published videos is not supported yet — sync in batches");

  const token = await getAccessToken();
  const res = await ytFetch(
    `https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id=${youtubeIds.join(",")}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = (body as { error?: { message?: string; errors?: { reason?: string }[] } }).error;
    const quota = err?.errors?.[0]?.reason === "quotaExceeded"
      ? " — the YouTube Data API daily quota is used up; try again tomorrow"
      : "";
    throw new Error(
      `YouTube stats sync failed (${res.status}): ${err?.message ?? `HTTP ${res.status}`}${quota}`
    );
  }

  const data = (await res.json()) as {
    items?: {
      id: string;
      statistics?: { viewCount?: string; likeCount?: string; commentCount?: string; favoriteCount?: string };
      snippet?: { publishedAt?: string };
    }[];
  };

  const out = new Map<string, RemoteVideoStats>();
  for (const item of data.items ?? []) {
    out.set(item.id, {
      youtubeId: item.id,
      views: Math.max(0, Math.trunc(Number(item.statistics?.viewCount ?? 0)) || 0),
      likes: Math.max(0, Math.trunc(Number(item.statistics?.likeCount ?? 0)) || 0),
      comments: Math.max(0, Math.trunc(Number(item.statistics?.commentCount ?? 0)) || 0),
      favorites: Math.max(0, Math.trunc(Number(item.statistics?.favoriteCount ?? 0)) || 0),
      publishedAt: item.snippet?.publishedAt ?? null,
    });
  }
  return out;
}

// ---------- per-user connection settings (privacy status / category) ----------

export async function getPublishDefaults(): Promise<{ privacyStatus: string; categoryId: string }> {
  const ctx = currentCtx();
  if (!ctx) return { privacyStatus: "unlisted", categoryId: "27" };
  const map = await getUserSettings(["ytPrivacyStatus", "ytCategoryId"]);
  const account = await getAccount(ctx.userId);
  const privacyStatus = map.get("ytPrivacyStatus")?.trim() || account?.privacyStatus || "unlisted";
  const categoryId = map.get("ytCategoryId")?.trim() || account?.categoryId || "27";
  return { privacyStatus, categoryId };
}

export async function savePublishDefaults(privacyStatus: string, categoryId: string): Promise<void> {
  const _ctx = requireCtx();
  await setUserSetting("ytPrivacyStatus", privacyStatus);
  await setUserSetting("ytCategoryId", categoryId);
}

// ---------- upload ----------

/** Extract Google's API error reason into a human-readable message. */
async function apiError(res: Response, context: string): Promise<Error> {
  const body = (await res.json().catch(() => ({}))) as {
    error?: { message?: string; errors?: { reason?: string }[] };
  };
  const reason = body.error?.errors?.[0]?.reason ?? res.status;
  const hints: Record<string, string> = {
    quotaExceeded: "upload quota for today is used up (10 uploads/day by default)",
    uploadLimitExceededUnlistedVideos: "upload quota is used up",
    forbidden: "check that the OAuth consent screen is in production/testing with your account added",
    invalidCredentials: "reconnect the channel in Settings",
    backendError: "Google had a transient hiccup — try again in a minute",
  };
  const hint = hints[reason] ? ` — ${hints[reason]}` : "";
  return new Error(
    `${context} failed (${reason}): ${body.error?.message ?? `HTTP ${res.status}`}${hint}`
  );
}

export interface UploadInput {
  title: string;
  description: string;
  tags: string[];
  filePath: string; // final.mp4 on disk
  fileSize: number;
  thumbnailPath?: string | null; // thumbnail.png on disk
  /** Optional scheduled-publish time (ISO 8601). YouTube only honors
   *  `publishAt` when `privacyStatus === "private"` — a "public"/"unlisted"
   *  upload with a future publishAt publishes immediately. The caller is
   *  responsible for the privacy/publishAt pairing; we pass it straight
   *  through and let YouTube's API enforce the constraint. */
  publishAt?: string | null;
}

export interface UploadResult {
  youtubeId: string;
  url: string;
  thumbnailSet: boolean;
}

/** Resumable upload: initiate session, PUT the bytes, set the custom thumbnail. */
export async function uploadToYouTube(input: UploadInput): Promise<UploadResult> {
  const token = await getAccessToken();
  const { privacyStatus, categoryId } = await getPublishDefaults();
  if (!["public", "unlisted", "private"].includes(privacyStatus))
    throw new Error(`Invalid privacy status "${privacyStatus}"`);

  // 1) Initiate the resumable session with the video metadata.
  // `publishAt` is only honored when `privacyStatus === "private"`; for
  // "public"/"unlisted" uploads YouTube ignores it and publishes immediately.
  // We pass it through as-is — the route UI is responsible for explaining
  // the constraint to the user.
  const statusMetadata: { privacyStatus: string; selfDeclaredMadeForKids: boolean; embeddable: boolean; publishAt?: string } = {
    privacyStatus,
    selfDeclaredMadeForKids: false,
    embeddable: true,
  };
  if (input.publishAt) {
    const iso = new Date(input.publishAt).toISOString();
    if (!Number.isNaN(Date.parse(iso))) statusMetadata.publishAt = iso;
  }
  const metadata = {
    snippet: {
      title: input.title.slice(0, 100),
      description: input.description.slice(0, 4900),
      tags: input.tags.slice(0, 30),
      categoryId,
    },
    status: statusMetadata,
  };

  const init = await ytFetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(input.fileSize),
        "X-Upload-Content-Type": "video/mp4",
      },
      body: JSON.stringify(metadata),
    }
  );
  if (!init.ok) throw await apiError(init, "Upload initiation");

  const sessionUrl = init.headers.get("location");
  if (!sessionUrl) throw new Error("Google did not return an upload session URL");

  // 2) Upload the bytes (single PUT; resumes once on a transient failure).
  let upRes: Response;
  try {
    const bytes = await import("fs").then((fs) => fs.readFileSync(input.filePath));
    upRes = await ytFetch(
      sessionUrl,
      {
        method: "PUT",
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": String(input.fileSize),
        },
        body: new Uint8Array(bytes),
      },
      "youtube-upload"
    );
  } catch (err) {
    throw new Error(
      redactText(
        `Could not transmit the video file: ${err instanceof Error ? err.message : String(err)}`
      )
    );
  }
  if (!upRes.ok) throw await apiError(upRes, "Upload");

  const uploaded = (await upRes.json().catch(() => ({}))) as { id?: string };
  if (!uploaded.id) throw new Error("YouTube did not return a video id after upload");

  // 3) Best-effort custom thumbnail (fails soft — the video is already live).
  let thumbnailSet = false;
  if (input.thumbnailPath) {
    try {
      const fs = await import("fs");
      const thumb = fs.readFileSync(input.thumbnailPath);
      const thumbRes = await ytFetch(
        `https://www.googleapis.com/youtube/v3/thumbnails/set?videoId=${uploaded.id}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${await getAccessToken()}`,
            "Content-Type": "image/png",
          },
          body: new Uint8Array(thumb),
        }
      );
      thumbnailSet = thumbRes.ok;
      if (!thumbRes.ok)
        ytLog.warn("thumbnail set skipped", { status: thumbRes.status });
    } catch (err) {
      ytLog.warn("thumbnail set failed (non-fatal)", { err });
    }
  }

  return { youtubeId: uploaded.id, url: `https://youtu.be/${uploaded.id}`, thumbnailSet };
}
