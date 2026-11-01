// GET/PUT /api/voices/pronunciations — the per-user word→say-as map
// (Stage 4b, T-4.11).
//
// GET  → { entries: [{ from, to }] }  (alphabetical by `from`)
// PUT  body { entries: [{ from, to }] } → validated, deduped (case-insensitive
//      `from`, last wins), saved as one UserSetting row (voice.pronunciations)
//      and the in-process map cache invalidated. Applied server-side at the
//      single TTS choke point (providers/tts.ts) — never client-side.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/tubeforge/tenant";
import { errorText } from "@/lib/tubeforge/redact";
import {
  MAX_PRONUNCIATIONS,
  PRONUNCIATION_KEY,
  parseStoredPronunciations,
  savePronunciations,
  type PronunciationEntry,
} from "@/lib/tubeforge/pronounce";
import { getUserSetting } from "@/lib/tubeforge/settings";

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export async function GET(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const raw = await getUserSetting(PRONUNCIATION_KEY).catch(() => null);
  const entries = parseStoredPronunciations(raw ?? null);
  return NextResponse.json({
    entries: entries.sort((a, b) => a.from.localeCompare(b.from)),
  });
}

export async function PUT(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  try {
    const body = await req.json();
    const raw = Array.isArray(body?.entries) ? body.entries : null;
    if (!raw) {
      return NextResponse.json(
        { error: "Body must be JSON: { entries: [{ from, to }] }" },
        { status: 400 }
      );
    }
    if (raw.length > MAX_PRONUNCIATIONS) {
      return NextResponse.json(
        { error: `At most ${MAX_PRONUNCIATIONS} pronunciation overrides` },
        { status: 400 }
      );
    }

    // Validate + dedupe (case-insensitive `from`, LAST occurrence wins).
    const byFrom = new Map<string, PronunciationEntry>();
    for (const item of raw) {
      const from = String(item?.from ?? "").trim();
      const to = String(item?.to ?? "").trim();
      if (!from) return NextResponse.json({ error: "Every entry needs a word or phrase" }, { status: 400 });
      if (from.length > 60) return NextResponse.json({ error: `"${from.slice(0, 30)}…" is too long (60 chars max)` }, { status: 400 });
      if (!to) return NextResponse.json({ error: `Give a say-as for "${from}" (or remove the row)` }, { status: 400 });
      if (to.length > 200) return NextResponse.json({ error: "The say-as is too long (200 chars max)" }, { status: 400 });
      if (CONTROL_CHARS.test(from) || CONTROL_CHARS.test(to)) {
        return NextResponse.json({ error: "Control characters are not allowed" }, { status: 400 });
      }
      byFrom.set(from.toLowerCase(), { from, to });
    }

    const entries = [...byFrom.values()].sort((a, b) => a.from.localeCompare(b.from));
    await savePronunciations(entries);
    return NextResponse.json({ entries });
  } catch (err) {
    const message = errorText(err, "Could not save pronunciations");
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
