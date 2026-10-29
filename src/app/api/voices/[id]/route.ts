// DELETE /api/voices/[id] — remove a cloned voice.
// Deletes the local profile row (always) and the platform copy (best-effort —
// a 4xx from the platform must not strand the profile in the UI).

import { NextRequest, NextResponse } from "next/server";
import { deleteVoiceProfile } from "@/lib/tubeforge/voice-clone";
import { errorText } from "@/lib/tubeforge/redact";

type Ctx = { params: Promise<{ id: string }> };

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  try {
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
