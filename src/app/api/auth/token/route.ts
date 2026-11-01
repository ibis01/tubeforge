import { NextRequest, NextResponse } from "next/server";
import { currentCtx, createApiToken, requireUser } from "@/lib/tubeforge/tenant";
import { API_TOKEN_MAX_AGE_SEC } from "@/lib/tubeforge/auth-token";

/**
 * POST — mint a personal API token (Bearer) for CLI/script access.
 * Requires a signed-in session (this path is NOT in the middleware public
 * list). The token is signed with TUBEFORGE_AUTH_SECRET and carries the
 * caller's uid; rotating the secret revokes every token at once.
 */
export async function POST(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth.ok)
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope for this handler

  const ctx = currentCtx();
  const token = await createApiToken(auth.ctx.userId);
  if (!token)
    return NextResponse.json(
      { error: "Auth is disabled: set TUBEFORGE_AUTH_SECRET in .env first" },
      { status: 500 }
    );

  return NextResponse.json({
    token,
    note: "Store it safely — it will not be shown again.",
    expiresInSeconds: API_TOKEN_MAX_AGE_SEC,
    usage: 'curl -H "Authorization: Bearer <token>" .../api/...',
    scope: ctx ? { userId: ctx.userId, organizationId: ctx.organizationId } : null,
  });
}
