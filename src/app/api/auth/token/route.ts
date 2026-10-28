import { NextResponse } from "next/server";
import { createApiToken } from "@/lib/tubeforge/auth";
import { API_TOKEN_MAX_AGE_SEC } from "@/lib/tubeforge/auth-token";

/**
 * POST — mint a personal API token (Bearer) for CLI/script access.
 * Requires a signed-in session (this path is NOT in the middleware public
 * list). The token is signed with TUBEFORGE_AUTH_SECRET and shown exactly
 * once — rotating the secret revokes every token at once.
 */
export async function POST() {
  const token = await createApiToken();
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
  });
}
