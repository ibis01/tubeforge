import { NextRequest, NextResponse } from "next/server";
import { rawDatabase as rawDb } from "@/lib/tubeforge/tenant-db";
import { withCtx, type TenantCtx } from "@/lib/tubeforge/tenant";
import { exchangeCode, fetchChannelInfo, verifyOAuthState } from "@/lib/tubeforge/youtube";
import { errorText } from "@/lib/tubeforge/redact";
import { requestLog } from "@/lib/tubeforge/log";

/**
 * GET — OAuth consent callback. Google redirects here with ?code & state.
 * Exchanges the code, fetches the channel identity, then bounces the user
 * back into the app (a plain redirect page — no auth JS needed).
 *
 * Stage 2: this endpoint is hit BY GOOGLE (no session cookie), so it does
 * NOT run requireUser — the signed state token carries the uid that started
 * the flow, and the exchange runs inside a withCtx scope built from that
 * user's first membership. The middleware allow-lists the path (PUBLIC_API).
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const origin = url.origin;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const googleError = url.searchParams.get("error");

  const done = (ok: boolean, message: string) =>
    new NextResponse(
      `<!doctype html>
<html><head><meta charset="utf-8"><title>TubeForge — YouTube connect</title>
<style>
  body{background:#0a0a0b;color:#e4e4e7;font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
  .card{max-width:420px;padding:32px;border-radius:16px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.03);text-align:center}
  h1{font-size:18px;margin:0 0 8px}
  p{font-size:13px;color:#a1a1aa;line-height:1.6;margin:0 0 20px}
  a{display:inline-block;padding:10px 20px;border-radius:10px;background:linear-gradient(135deg,#ef2b46,#c1121f);color:#fff;text-decoration:none;font-size:13px;font-weight:600}
</style></head>
<body><div class="card">
<h1>${ok ? "Channel connected" : "Connection failed"}</h1>
<p>${message}</p>
<a href="/?view=settings">Back to TubeForge</a>
</div></body></html>`,
      { status: ok ? 200 : 400, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );

  if (googleError)
    return done(false, `Google returned "${googleError}" — consent was not granted. Close this tab and try again.`);
  if (!code) return done(false, "Google did not send an authorization code back.");

  // Verify state (CSRF guard) — a signed short-lived token carrying the uid
  // of the user who started the flow (no session cookie on this request).
  const verified = await verifyOAuthState(state);
  if (!verified)
    return done(false, "Security check failed (stale state) — start the connection again from Settings.");

  // Rebuild the acting user's tenant context: the youtube lib resolves the
  // acting user via currentCtx() (exchangeCode / fetchChannelInfo), so the
  // whole exchange runs inside an explicit withCtx scope.
  const membership = await rawDb.membership.findFirst({
    where: { userId: verified.uid },
    orderBy: { createdAt: "asc" },
  });
  if (!membership)
    return done(false, "Your account has no workspace — sign in and start the connection again from Settings.");
  const ctx: TenantCtx = {
    userId: verified.uid,
    organizationId: membership.organizationId,
    role: membership.role,
  };

  try {
    let title = "Connected channel";
    await withCtx(ctx, async () => {
      await exchangeCode(code, origin);

      // Prove the token + remember who we are (title/avatar live on the
      // per-user YouTubeAccount row that exchangeCode just persisted).
      try {
        const info = await fetchChannelInfo();
        title = info.title;
      } catch (err) {
        requestLog(req, { mod: "youtube:callback" }).warn("channel lookup after connect failed (non-fatal)", { err });
      }
    });

    return done(true, `${title} is now connected — uploads go straight to this channel.`);
  } catch (err) {
    const message = errorText(err, "Unknown error");
    return done(false, message);
  }
}
