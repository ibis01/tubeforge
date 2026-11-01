import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/tubeforge/tenant";
import { getPublishDefaults, savePublishDefaults } from "@/lib/tubeforge/youtube";
import { setUserSetting } from "@/lib/tubeforge/settings";
import { errorText } from "@/lib/tubeforge/redact";

/**
 * PUT — save the OAuth client credentials + upload defaults.
 * Body: { clientId?, clientSecret?, privacyStatus?, categoryId? }
 * Empty clientSecret keeps the existing secret (edit forms send blanks).
 */
export async function PUT(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  try {
    const body = await req.json();

    const clientId = String(body.clientId ?? "").trim();
    const clientSecret = String(body.clientSecret ?? "").trim();
    const privacyStatus = String(body.privacyStatus ?? "unlisted").trim();
    const categoryId = String(body.categoryId ?? "").trim();

    // Stage 2: the OAuth client is server-wide (env) with the user's stored
    // credentials as the legacy fallback — save them per-user. The youtube
    // lib reads exactly these keys when the env vars are absent.
    if (clientId) await setUserSetting("yt.clientId", clientId);
    if (clientSecret) await setUserSetting("yt.clientSecret", clientSecret);

    // Upload defaults are per-user too (privacy + category ride together in
    // savePublishDefaults, so only override the provided half).
    const validPrivacy = ["public", "unlisted", "private"].includes(privacyStatus);
    if (validPrivacy || categoryId) {
      const current = await getPublishDefaults();
      await savePublishDefaults(
        validPrivacy ? privacyStatus : current.privacyStatus,
        categoryId || current.categoryId
      );
    }

    // Changing the OAuth app invalidates any existing channel connection.
    if ((clientId || clientSecret) && !clientSecret) {
      // client id change with a kept secret can still invalidate the session;
      // the UI tells the user to reconnect after saving credentials.
    }

    return NextResponse.json({ saved: true });
  } catch (err) {
    const message = errorText(err, "Invalid request");
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
