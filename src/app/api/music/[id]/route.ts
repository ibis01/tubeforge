import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { db } from "@/lib/db";
import { serializeTrack, trackAbsolutePath } from "@/lib/tubeforge/music";

const UPLOAD_ROOT = path.join(process.cwd(), "uploads");

type Ctx = { params: Promise<{ id: string }> };

/** PATCH — rename, retag, toggle active, or edit the license record. */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const track = await db.musicTrack.findUnique({ where: { id } });
  if (!track) return NextResponse.json({ error: "Track not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const data: Record<string, string | boolean | null> = {};

  if (typeof body.name === "string" && body.name.trim()) data.name = body.name.trim().slice(0, 80);
  if (typeof body.moods === "string") data.moods = body.moods.slice(0, 200);
  if (typeof body.genre === "string") data.genre = body.genre.slice(0, 60);
  if (typeof body.isActive === "boolean") data.isActive = body.isActive;
  if (typeof body.licenseType === "string" && body.licenseType.trim())
    data.licenseType = body.licenseType.trim().slice(0, 80);
  if (typeof body.sourceUrl === "string") data.sourceUrl = body.sourceUrl.slice(0, 300) || null;
  if (typeof body.commercialUse === "boolean") data.commercialUse = body.commercialUse;
  if (typeof body.attributionRequired === "boolean") data.attributionRequired = body.attributionRequired;
  if (typeof body.attributionText === "string") data.attributionText = body.attributionText.slice(0, 300) || null;
  if (typeof body.licenseEvidence === "string") data.licenseEvidence = body.licenseEvidence.slice(0, 300) || null;
  if (typeof body.contentIdNotes === "string") data.contentIdNotes = body.contentIdNotes.slice(0, 300) || null;

  const updated = await db.musicTrack.update({ where: { id }, data });
  return NextResponse.json({ track: serializeTrack(updated) });
}

/** DELETE — remove a track: DB row + file (originals can be re-synthesized). */
export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const track = await db.musicTrack.findUnique({ where: { id } });
  if (!track) return NextResponse.json({ error: "Track not found" }, { status: 404 });

  await db.musicTrack.delete({ where: { id } });
  const abs = trackAbsolutePath(track);
  if (fs.existsSync(abs)) fs.rmSync(abs, { force: true });

  return NextResponse.json({ ok: true });
}
