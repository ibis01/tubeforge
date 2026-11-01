// DELETE /api/voices/[id] — remove a cloned voice.
// Deletes the local profile row (always) and the platform copy (best-effort —
// a 4xx from the platform must not strand the profile in the UI).

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { deleteVoiceProfile } from "@/lib/tubeforge/voice-clone";
import { errorText } from "@/lib/tubeforge/redact";

type Ctx = { params: Promise<{ id: string }> };

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const { id } = await ctx.params;
  try {
    // Scoped lookup FIRST — the profile row (and its platform-side copy) is
    // only deleted after it is proven to belong to the caller's organization.
    const profile = await db.voiceProfile.findUnique({ where: { id } });
    if (!profile)
      return NextResponse.json({ error: "Voice profile not found" }, { status: 404 });
    const deleted = await deleteVoiceProfile(id);
    if (!deleted)
      return NextResponse.json({ error: "Voice profile not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: errorText(err, "Could not delete the voice profile") },
      { status: 500 }
    );
  }
}
