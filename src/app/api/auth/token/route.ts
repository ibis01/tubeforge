import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  currentCtx,
  createApiToken,
  listApiTokens,
  requireUser,
  revokeApiToken,
  sessionIdFromRequest,
} from "@/lib/tubeforge/tenant";
import { API_TOKEN_MAX_AGE_SEC } from "@/lib/tubeforge/auth-token";

/**
 * The API token registry's surface (S20). POST has existed since Stage 2 as
 * a fossil — it minted a 90-day bearer that NOTHING could list or revoke
 * (the token was a pure HMAC payload; a leaked one stayed live until the
 * global secret was rotated, killing every session with it). Now every mint
 * persists a registry row and this route is the management console:
 *
 *   GET    — list the caller's tokens (metadata only; the secret is never
 *            stored, so it can never be shown again)
 *   POST   — mint a token with a label; the response shows it exactly once
 *   DELETE — revoke one token by id; its bearer dies on the next request
 *
 * Session-only, like change-password (S16): a bearer token may call ordinary
 * APIs but never mint/revoke/list tokens — a leaked 90-day bearer must not
 * be able to clone itself or cut its siblings. sessionIdFromRequest() is
 * the gate: null (bearer / state / garbage) → 403.
 */

const mintSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
});

const revokeSchema = z.object({ id: z.string().min(1).max(64) });

async function sessionOnlyGate(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth.ok) return { error: NextResponse.json({ error: auth.error }, { status: auth.status }) };
  auth.enter(); // tenant scope for this handler
  // Only a browser session manages tokens — bearers are deliberately blind here.
  const sid = await sessionIdFromRequest(req);
  if (!sid)
    return {
      error: NextResponse.json(
        { error: "API tokens are managed from a signed-in browser session only" },
        { status: 403 }
      ),
    };
  return { auth };
}

export async function GET(req: NextRequest) {
  const gate = await sessionOnlyGate(req);
  if (gate.error) return gate.error;
  const tokens = await listApiTokens(gate.auth.ctx.userId);
  return NextResponse.json({ tokens });
}

export async function POST(req: NextRequest) {
  const gate = await sessionOnlyGate(req);
  if (gate.error) return gate.error;

  const parsed = mintSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success)
    return NextResponse.json(
      { error: "Token label must be 1-80 characters (or omitted)" },
      { status: 400 }
    );

  const token = await createApiToken(gate.auth.ctx.userId, parsed.data.name);
  if (!token)
    return NextResponse.json(
      { error: "Auth is disabled: set TUBEFORGE_AUTH_SECRET in .env first" },
      { status: 500 }
    );

  const ctx = currentCtx();
  return NextResponse.json(
    {
      token,
      name: parsed.data.name?.trim() || null,
      note: "Store it safely — it will not be shown again.",
      expiresInSeconds: API_TOKEN_MAX_AGE_SEC,
      usage: 'curl -H "Authorization: Bearer <token>" .../api/...',
      scope: ctx ? { userId: ctx.userId, organizationId: ctx.organizationId } : null,
    },
    { status: 201 }
  );
}

export async function DELETE(req: NextRequest) {
  const gate = await sessionOnlyGate(req);
  if (gate.error) return gate.error;

  const parsed = revokeSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success)
    return NextResponse.json({ error: "A token id is required" }, { status: 400 });

  const revoked = await revokeApiToken(gate.auth.ctx.userId, parsed.data.id);
  if (!revoked)
    return NextResponse.json(
      { error: "No such live token — it may already be revoked" },
      { status: 404 }
    );
  return NextResponse.json({ ok: true });
}
