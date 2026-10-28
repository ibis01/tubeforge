import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  serializeTrack,
  seedMusicLibrary,
  ingestUploadedTrack,
  getMusicSettings,
  MAX_TRACK_BYTES,
} from "@/lib/tubeforge/music";
import { errorText } from "@/lib/tubeforge/redact";

/**
 * GET — the music library + settings. Auto-seeds the TubeForge-original beds
 * on first open (synthesis is local ffmpeg — no network, no cost).
 */
export async function GET() {
  const seeded = await seedMusicLibrary().catch((err) => {
    console.error("[music] seed failed:", err);
    return { created: 0, skipped: 0 };
  });
  const [rows, settings] = await Promise.all([
    db.musicTrack.findMany({ orderBy: [{ isOriginal: "desc" }, { name: "asc" }] }),
    getMusicSettings(),
  ]);
  return NextResponse.json({
    tracks: rows.map(serializeTrack),
    settings,
    seeded,
  });
}

/**
 * POST — two actions:
 *   multipart (file + fields) → upload a licensed track with its metadata
 *   JSON {action:"seed"}       → re-synthesize the original library
 */
export async function POST(req: NextRequest) {
  const contentType = req.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File) || file.size === 0)
      return NextResponse.json({ error: "Attach an audio file in the 'file' field" }, { status: 400 });
    if (file.size > MAX_TRACK_BYTES)
      return NextResponse.json(
        { error: `Track exceeds the ${MAX_TRACK_BYTES / 1024 / 1024} MB limit` },
        { status: 413 }
      );

    const f = (k: string) => (form?.get(k) as string | null)?.trim() ?? "";
    const name = f("name") || file.name?.replace(/\.[^.]+$/, "") || "New track";
    const licenseType = f("licenseType");
    if (!licenseType)
      return NextResponse.json(
        { error: "License type is required — every track needs a license record" },
        { status: 400 }
      );
    const attributionRequired = f("attributionRequired") === "true";
    if (attributionRequired && !f("attributionText"))
      return NextResponse.json(
        { error: "Attribution-required licenses need the exact credit line to paste into your video description" },
        { status: 400 }
      );

    try {
      const track = await ingestUploadedTrack(Buffer.from(await file.arrayBuffer()), {
        name,
        moods: f("moods"),
        genre: f("genre") || undefined,
        licenseType,
        sourceUrl: f("sourceUrl") || undefined,
        commercialUse: f("commercialUse") !== "false",
        attributionRequired,
        attributionText: f("attributionText") || undefined,
        licenseEvidence: f("licenseEvidence") || undefined,
        contentIdNotes: f("contentIdNotes") || undefined,
      });
      return NextResponse.json({ track: serializeTrack(track) }, { status: 201 });
    } catch (err) {
      const message = errorText(err, "Upload failed");
      return NextResponse.json({ error: message }, { status: 400 });
    }
  }

  const body = (await req.json().catch(() => ({}))) as { action?: string; force?: boolean };
  if (body.action === "seed") {
    const result = await seedMusicLibrary(Boolean(body.force));
    return NextResponse.json({ ok: true, ...result });
  }
  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
