import { NextRequest, NextResponse } from "next/server";
import { setSetting } from "@/lib/tubeforge/youtube";

/**
 * PUT — save the OAuth client credentials + upload defaults.
 * Body: { clientId?, clientSecret?, privacyStatus?, categoryId? }
 * Empty clientSecret keeps the existing secret (edit forms send blanks).
 */
export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();

    const clientId = String(body.clientId ?? "").trim();
    const clientSecret = String(body.clientSecret ?? "").trim();
    const privacyStatus = String(body.privacyStatus ?? "unlisted").trim();
    const categoryId = String(body.categoryId ?? "").trim();

    if (clientId) await setSetting("ytClientId", clientId);
    if (clientSecret) await setSetting("ytClientSecret", clientSecret);
    if (["public", "unlisted", "private"].includes(privacyStatus))
      await setSetting("ytPrivacyStatus", privacyStatus);
    if (categoryId) await setSetting("ytCategoryId", categoryId);

    // Changing the OAuth app invalidates any existing channel connection.
    if ((clientId || clientSecret) && !clientSecret) {
      // client id change with a kept secret can still invalidate the session;
      // the UI tells the user to reconnect after saving credentials.
    }

    return NextResponse.json({ saved: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid request";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
