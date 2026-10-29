import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { db } from "@/lib/db";
import { invalidateRenderedArtifacts } from "@/lib/tubeforge/render";
import { brandLogoFile, sanitizeBrandAccent } from "@/lib/tubeforge/slides";

type Ctx = { params: Promise<{ id: string }> };

const LOGO_MIME: Record<string, string> = {
  png: "image/png",
  webp: "image/webp",
  svg: "image/svg+xml",
};
const MAX_LOGO_BYTES = 5 * 1024 * 1024;

/** GET — serve the uploaded brand logo (UI preview on the brand kit card). */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const file = brandLogoFile(id);
  if (!file)
    return NextResponse.json({ error: "No brand logo uploaded" }, { status: 404 });

  const ext = path.extname(file).slice(1).toLowerCase();
  const body = fs.readFileSync(file);
  return new NextResponse(new Uint8Array(body), {
    status: 200,
    headers: {
      "Content-Type": LOGO_MIME[ext] ?? "application/octet-stream",
      "Content-Length": String(body.length),
      "Cache-Control": "private, no-cache",
    },
  });
}

/**
 * POST — upload the brand logo (multipart: file). PNG / WebP / SVG up to
 * 5 MB; transparency-friendly formats so it sits clean on any slide.
 * The badge shows on every keynote slide (until switched off), and the
 * rendered video becomes stale.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected a multipart form with a logo file" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File))
    return NextResponse.json({ error: "Attach the logo as the 'file' field" }, { status: 400 });

  const ext =
    file.type === "image/png" ? "png"
    : file.type === "image/webp" ? "webp"
    : file.type === "image/svg+xml" ? "svg"
    : null;
  if (!ext)
    return NextResponse.json(
      { error: "Logos must be PNG, WebP, or SVG (transparency-friendly formats)" },
      { status: 400 }
    );
  if (file.size > MAX_LOGO_BYTES)
    return NextResponse.json({ error: "Logo exceeds the 5 MB limit" }, { status: 413 });

  const dir = path.join(process.cwd(), "uploads", id);
  fs.mkdirSync(dir, { recursive: true });
  // One logo per video — remove other variants first (ext may change).
  for (const e of Object.keys(LOGO_MIME)) {
    if (e !== ext) fs.rmSync(path.join(dir, `brand-logo.${e}`), { force: true });
  }
  fs.writeFileSync(path.join(dir, `brand-logo.${ext}`), Buffer.from(await file.arrayBuffer()));

  // The badge is baked into slide PNGs at screenshot time — stale now.
  invalidateRenderedArtifacts(id, { slidePngs: true });
  await db.video.update({
    where: { id },
    data: { brandLogoOn: true, hasVideo: false, videoDuration: null, error: null },
  });
  await db.activity.create({
    data: {
      videoId: id,
      stage: "storyboard",
      message: `Brand logo uploaded (${ext.toUpperCase()}) — badge shows on every slide`,
    },
  });

  return NextResponse.json({ ok: true, hasLogo: true, logoUrl: `/api/videos/${id}/brand` });
}

/**
 * PATCH — brand kit settings. Body: { accent?: "#rrggbb"|null,
 * showLogo?: boolean }. Accent null = back to the built-in per-slide
 * catalog accents. Both are baked into the slide PNGs, so both invalidate.
 */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  const data: Record<string, unknown> = {};
  let changed = false;

  if (body?.accent !== undefined) {
    if (body.accent === null) {
      data.brandAccent = null;
      changed = true;
    } else {
      const hex = sanitizeBrandAccent(body.accent);
      if (!hex)
        return NextResponse.json(
          { error: "Accent must be a hex color like #0A7CFF" },
          { status: 400 }
        );
      data.brandAccent = hex;
      changed = true;
    }
  }
  if (typeof body?.showLogo === "boolean") {
    data.brandLogoOn = body.showLogo;
    changed = true;
  }

  if (!changed)
    return NextResponse.json({ error: "Nothing to update — send accent or showLogo" }, { status: 400 });

  invalidateRenderedArtifacts(id, { slidePngs: true });
  const updated = await db.video.update({
    where: { id },
    data: { ...data, hasVideo: false, videoDuration: null, error: null },
  });

  return NextResponse.json({
    ok: true,
    brandAccent: updated.brandAccent,
    brandLogoOn: updated.brandLogoOn ?? true,
  });
}

/** DELETE — remove the brand logo (badge disappears from every slide). */
export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });

  const dir = path.join(process.cwd(), "uploads", id);
  for (const e of Object.keys(LOGO_MIME)) {
    fs.rmSync(path.join(dir, `brand-logo.${e}`), { force: true });
  }

  invalidateRenderedArtifacts(id, { slidePngs: true });
  await db.video.update({ where: { id }, data: { brandLogoOn: null } });
  await db.activity.create({
    data: { videoId: id, stage: "storyboard", message: "Brand logo removed" },
  });

  return NextResponse.json({ ok: true, hasLogo: false });
}
