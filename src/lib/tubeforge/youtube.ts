// YouTube Data API v3 integration (Phase 4 — one-click OAuth upload).
//
// Full OAuth 2.0 install-app flow:
//   consent URL -> callback exchanges the code for a refresh token (stored in
//   the Setting table) -> uploads use the stored refresh token.
//
// Upload = YouTube resumable API: initiate a session with video metadata,
// PUT the MP4 bytes, then set the custom thumbnail. No external deps — plain
// fetch against Google endpoints, with actionable error surfacing so users
// can fix quota / auth / scope problems without reading Google's docs.

import { db } from "@/lib/db";
import { redactText } from "@/lib/tubeforge/redact";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
].join(" ");

// ---------- settings helpers ----------

async function getSetting(key: string): Promise<string | null> {
  const row = await db.setting.findUnique({ where: { key } });
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string | null) {
  if (value === null) {
    await db.setting.deleteMany({ where: { key } });
    return;
  }
  await db.setting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
}

// ---------- OAuth ----------

export function callbackUrlFor(origin: string): string {
  return `${origin.replace(/\/$/, "")}/api/youtube/callback`;
}

/** Consent URL the settings UI opens in a new tab. */
export async function buildAuthUrl(origin: string): Promise<string> {
  const clientId = await getSetting("ytClientId");
  if (!clientId) throw new Error("Add your Google OAuth client ID first");

  const state = crypto.randomUUID();
  await setSetting("ytOAuthState", state);

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

/** Exchange the consent callback code for tokens; persists the refresh token. */
export async function exchangeCode(code: string, origin: string): Promise<void> {
  const clientId = await getSetting("ytClientId");
  const clientSecret = await getSetting("ytClientSecret");
  if (!clientId || !clientSecret)
    throw new Error("YouTube OAuth client is not configured");

  const res = await fetch(TOKEN_URL, {
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
  if (!res.ok || !refreshToken) {
    const reason = (data as { error_description?: string }).error_description;
    throw new Error(
      `Google rejected the OAuth code${reason ? `: ${reason}` : ""} — reconnect the channel and complete consent again.`
    );
  }

  await setSetting("ytRefreshToken", refreshToken);
}

// ---------- access tokens (refresh on demand, cached in memory) ----------

interface TokenState {
  token: string | null;
  expiresAt: number;
}

const g = globalThis as typeof globalThis & { __tfYtToken?: TokenState };
const tokenState: TokenState = (g.__tfYtToken ??= { token: null, expiresAt: 0 });

export async function isConnected(): Promise<boolean> {
  return Boolean(await getSetting("ytRefreshToken"));
}

/** Fresh access token via the stored refresh token (cached ~50 min). */
export async function getAccessToken(): Promise<string> {
  if (tokenState.token && Date.now() < tokenState.expiresAt)
    return tokenState.token;

  const refreshToken = await getSetting("ytRefreshToken");
  const clientId = await getSetting("ytClientId");
  const clientSecret = await getSetting("ytClientSecret");
  if (!refreshToken || !clientId || !clientSecret)
    throw new Error("YouTube channel is not connected — add OAuth credentials and connect");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
    }),
  });

  const data = await res.json().catch(() => ({}));
  const accessToken = (data as { access_token?: string }).access_token;
  if (!res.ok || !accessToken) {
    const err = (data as { error?: string; error_description?: string });
    // A dead refresh token requires re-consent — clear it so the UI says so.
    if (err.error === "invalid_grant") {
      await setSetting("ytRefreshToken", null);
      await setSetting("ytChannelTitle", null);
      throw new Error(
        "Google session expired — reconnect the channel in Settings (the stored token was revoked)."
      );
    }
    throw new Error(
      `Could not refresh the YouTube access token${err.error_description ? `: ${err.error_description}` : ""}`
    );
  }

  tokenState.token = accessToken;
  tokenState.expiresAt = Date.now() + 50 * 60 * 1000;
  return accessToken;
}

// ---------- channel info ----------

export interface ChannelInfo {
  title: string;
  thumbUrl: string | null;
}

/** Fetch the connected channel's title + avatar (also proves the token works). */
export async function fetchChannelInfo(): Promise<ChannelInfo> {
  const token = await getAccessToken();
  const res = await fetch(
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

// ---------- performance stats (Phase 5) ----------

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
  const res = await fetch(
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
}

export interface UploadResult {
  youtubeId: string;
  url: string;
  thumbnailSet: boolean;
}

/** Resumable upload: initiate session, PUT the bytes, set the custom thumbnail. */
export async function uploadToYouTube(input: UploadInput): Promise<UploadResult> {
  const token = await getAccessToken();
  const privacyStatus = (await getSetting("ytPrivacyStatus")) ?? "unlisted";
  const categoryId = (await getSetting("ytCategoryId")) ?? "27"; // Education
  if (!["public", "unlisted", "private"].includes(privacyStatus))
    throw new Error(`Invalid privacy status "${privacyStatus}"`);

  // 1) Initiate the resumable session with the video metadata.
  const metadata = {
    snippet: {
      title: input.title.slice(0, 100),
      description: input.description.slice(0, 4900),
      tags: input.tags.slice(0, 30),
      categoryId,
    },
    status: {
      privacyStatus,
      selfDeclaredMadeForKids: false,
      embeddable: true,
    },
  };

  const init = await fetch(
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
    upRes = await fetch(sessionUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(input.fileSize),
      },
      body: new Uint8Array(bytes),
    });
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
      const thumbRes = await fetch(
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
        console.warn("[youtube] thumbnail set skipped:", thumbRes.status);
    } catch (err) {
      console.warn("[youtube] thumbnail set failed (non-fatal):", err);
    }
  }

  return { youtubeId: uploaded.id, url: `https://youtu.be/${uploaded.id}`, thumbnailSet };
}
