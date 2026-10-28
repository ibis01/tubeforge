import { NextRequest, NextResponse } from "next/server";
import {
  readStockKeys,
  saveStockKey,
  maskStockKey,
  searchAll,
  KEY_URLS,
} from "@/lib/tubeforge/stock";
import { errorText } from "@/lib/tubeforge/redact";

/** GET — masked key state (the raw keys never leave the server). */
export async function GET() {
  const keys = await readStockKeys();
  return NextResponse.json({
    pexels: { hasKey: Boolean(keys.pexels), maskedKey: maskStockKey(keys.pexels) },
    pixabay: { hasKey: Boolean(keys.pixabay), maskedKey: maskStockKey(keys.pixabay) },
    keyUrls: KEY_URLS,
  });
}

/** PUT — save one or both keys. Empty string clears. */
export async function PUT(req: NextRequest) {
  try {
    const body = (await req.json()) as { pexels?: string; pixabay?: string };
    if (typeof body.pexels === "string") await saveStockKey("stock.pexelsKey", body.pexels);
    if (typeof body.pixabay === "string") await saveStockKey("stock.pixabayKey", body.pixabay);

    const keys = await readStockKeys();
    return NextResponse.json({
      pexels: { hasKey: Boolean(keys.pexels), maskedKey: maskStockKey(keys.pexels) },
      pixabay: { hasKey: Boolean(keys.pixabay), maskedKey: maskStockKey(keys.pixabay) },
    });
  } catch (err) {
    const message = errorText(err, "Invalid request");
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/**
 * POST — live test one provider: a real search for "ocean waves aerial".
 * Free API call — no cost, no confirmation gate needed.
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { provider?: string };
    const keys = await readStockKeys();

    if (body.provider === "pexels") {
      if (!keys.pexels)
        return NextResponse.json({ error: "No Pexels key saved yet" }, { status: 400 });
      const clips = await searchAll("ocean waves aerial", { pexels: keys.pexels, pixabay: "" });
      const best = clips.sort((a, b) => b.width - a.width)[0];
      return NextResponse.json({
        ok: true,
        provider: "pexels",
        results: clips.length,
        sample: best ? `${best.width}×${best.height} · ${best.durationSec}s · by ${best.author}` : null,
      });
    }

    if (body.provider === "pixabay") {
      if (!keys.pixabay)
        return NextResponse.json({ error: "No Pixabay key saved yet" }, { status: 400 });
      const clips = await searchAll("ocean waves aerial", { pexels: "", pixabay: keys.pixabay });
      const best = clips.sort((a, b) => b.width - a.width)[0];
      return NextResponse.json({
        ok: true,
        provider: "pixabay",
        results: clips.length,
        sample: best ? `${best.width}×${best.height} · ${best.durationSec}s · by ${best.author}` : null,
      });
    }

    return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
  } catch (err) {
    const message = errorText(err, "Test failed");
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
